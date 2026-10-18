/**
 * Airborne and high-speed ground motion: takeoff roll, climb/descent, bank-limited turns, wind,
 * approach guidance (extended centreline + 3 degree glidepath), flare, touchdown, rollout and runway exit.
 *
 * Units: positions in metres, speeds converted to m/s for integration, altitudes in feet.
 * `ac.target.headingDeg` is a TRUE heading (the executor converts controller magnetic headings).
 */
import type { Aircraft, AircraftPerformance, FlightPhase, Vec2 } from './types';
import {
  clamp, deg2rad, dist, headingDiff, headingToVec, ktToMps, mpsToKt, mToFt, mToNm, nmToM, normHeading, pointInPolygon, rad2deg,
  vAdd, vDot, vScale, vSub, vecToHeading, bearingDeg,
} from './geo';
import { patternAltitudeFt } from './performance';
import { activeClearance, completeClearances, emitEvent, getRuntime, perfOf, pilotSay, setPhase } from './context';
import type { AircraftRuntime, SimContext } from './context';
import { alongCross, crossingRunways, findRunwayEnd } from './runways';
import type { RunwayEndGeom } from './runways';
import { neighborIds, shortestDistances } from './pathfinding';
import { goingAroundCall } from '../radio/readback';
import { componentsOfVector, exceedsLimits, newGustState, stepGust, windVector } from './wind';
import { advanceNav, fixPosition, turnLeadM } from './navigation';
import { landedDistanceExceptionApplies, precedingArrivalBlockers } from './conflicts';
import { holdGuidance } from './holding';
import { missedGuidance, publishedMissedAltitudeFt, startPublishedMissed } from './missedApproach';
import { resolveMinima, runwayInSight } from './minima';
import { APPROACH_FINAL_NM, courseGeom, isOnCourse } from './approach';

/** Fallback glidepath (a 3 degree path crossing the threshold at 50 ft) when neither the plate nor the runway end data has one. */
export const GLIDEPATH_DEG = 3;
export const TCH_FT = 50;
export const DECISION_POINT_M = nmToM(0.5);
/** Inside this distance a cleared arrival that is still high goes around if the runway is occupied. */
const LAST_CHANCE_M = nmToM(0.25);
const ROLL_ACCEL_DEG_PER_SEC2 = 6;
const VS_ACCEL_FPM_PER_SEC = 600;
const APPROACH_RANGE_NM = 25;
/** Phases in which `ac.nav` (lateral navigation over fixes) is flown. */
const NAV_PHASES: readonly FlightPhase[] = ['INBOUND', 'APPROACH', 'INITIAL_CLIMB', 'DEPARTURE', 'GO_AROUND', 'HOLDING'];
/** IFR missed approach / go-around level-off: 2000 ft, but never lower than 1500 ft above the field. */
export const IFR_MISSED_APPROACH_FT = 2000;

export { windVector };

export interface GlidePath {
  angleDeg: number;
  tchFt: number;
  /** plate = published glidepath / VDA of the cleared procedure; vgsi = the runway end's visual glide slope (NASR); default = the fallback 3 degrees / 50 ft. */
  source: 'plate' | 'vgsi' | 'default';
}
const DEFAULT_GLIDEPATH: GlidePath = { angleDeg: GLIDEPATH_DEG, tchFt: TCH_FT, source: 'default' };

/**
 * The glidepath an arrival flies to runway end `g`: the cleared instrument procedure's published glidepath (angle and TCH from the plate)
 * when the dataset has it; a visual approach / no approach: the runway end's VGSI angle and TCH (NASR); else the labelled fallback.
 */
export function glidePathFor(airport: SimContext['state']['airport'], rt: AircraftRuntime | undefined, g: RunwayEndGeom, perf?: AircraftPerformance): GlidePath {
  const ap = rt?.approach;
  if (ap && ap.type !== 'VISUAL') {
    const proc = ap.procedureId ? airport.procedures.find((p) => p.id === ap.procedureId) : undefined;
    if (proc?.glidepath) return { angleDeg: proc.glidepath.angleDeg, tchFt: proc.glidepath.tchFt, source: 'plate' };
    return DEFAULT_GLIDEPATH;
  }
  const v = g.end.visualGlidepath;
  // DESIGN SIMPLIFICATION: light aircraft keep the fallback 50 ft path on a visual approach. The VGSI TCH (67-71 ft at KACY / KMHT) is set for
  // the most demanding aircraft using the runway; light aircraft fly lower and flare earlier (and a 71 ft path would put a C172 ~1,700 ft down).
  if (perf?.category === 'light') return DEFAULT_GLIDEPATH;
  return v ? { angleDeg: v.angleDeg, tchFt: v.tchFt, source: 'vgsi' } : DEFAULT_GLIDEPATH;
}

/** Effective (gusted) wind of this aircraft for this tick; adds the headwind change to the airspeed (ground speed is continuous through a gust). */
function sampleWind(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, dirOfTravel: Vec2, dt: number): { wind: Vec2; airspeedDeltaKt: number } {
  const w = ctx.state.weather;
  rt.gust ??= newGustState(ctx.state.seed, ac.id, w);
  const wind = stepGust(rt.gust, w, dt);
  const dv = vSub(rt.gust.dev, rt.gust.prevDev);
  // a headwind increase raises the airspeed by the same amount
  return { wind, airspeedDeltaKt: -mpsToKt(vDot(dv, dirOfTravel)) };
}

/** Lift (ft/min) per knot of gust-added airspeed in the flare: balloon with extra airspeed, sink with less. Design value. */
const GUST_LIFT_FPM_PER_KT = 25;
/** The effective crosswind / tailwind must stay over the type's limit this long on final before the pilot goes around. Design value. */
const WIND_LIMIT_GOAROUND_SEC = 2;
/** ... and over the demonstrated value by at least this much (kt). Design value. */
const WIND_GOAROUND_MARGIN_KT = 5;

/** Distance (nm) before the threshold at which the final approach starts. */
export function finalStartNm(perf: AircraftPerformance): number {
  return perf.category === 'light' ? 4 : 7;
}

/** Glidepath altitude (ft MSL) at `dM` metres before the threshold. */
export function glideAltitudeFt(elevFt: number, dM: number, gp: Pick<GlidePath, 'angleDeg' | 'tchFt'> = DEFAULT_GLIDEPATH): number {
  return elevFt + gp.tchFt + mToFt(dM) * Math.tan(deg2rad(gp.angleDeg));
}

function departureAltitudeFt(ac: Aircraft, elevFt: number): number {
  const perf = perfOf(ac);
  return Math.round((elevFt + (perf.category === 'light' ? 2000 : 3000)) / 100) * 100;
}

function goAroundAltitudeFt(ctx: SimContext, ac: Aircraft, elevFt: number, g: RunwayEndGeom | undefined, approach: AircraftRuntime['approach']): number {
  const perf = perfOf(ac);
  if (ac.flightPlan?.flightRules === 'IFR') {
    // Missed approach: the published climb altitude of the procedure (transcribed from the plate); only a procedure without one falls back
    // to the labelled 2,000 ft default. Never descend to it.
    const published = publishedMissedAltitudeFt(ctx.state.airport, approach, g);
    const floor = published ?? Math.max(IFR_MISSED_APPROACH_FT, Math.ceil((elevFt + 1500) / 100) * 100);
    return Math.max(floor, Math.floor(ac.altitudeFt / 100) * 100);
  }
  return Math.round((elevFt + (perf.category === 'light' ? 1500 : 3000)) / 100) * 100;
}

export function updateFlightDynamics(ctx: SimContext, dt: number): void {
  for (const ac of Object.values(ctx.state.aircraft)) {
    if (ac.onGround) {
      if (ac.phase === 'TAKEOFF_ROLL') stepTakeoffRoll(ctx, ac, dt);
      else if (ac.phase === 'ROLLOUT') stepRollout(ctx, ac, dt);
      continue;
    }
    stepAirborne(ctx, ac, dt);
  }
}

// ---------------------------------------------------------------------------
// Takeoff roll
// ---------------------------------------------------------------------------

function stepTakeoffRoll(ctx: SimContext, ac: Aircraft, dt: number): void {
  const perf = perfOf(ac);
  const rt = getRuntime(ctx, ac);
  const g = findRunwayEnd(ctx.state.airport, ac.assignedRunwayEnd);
  if (!g) return;
  const { wind, airspeedDeltaKt } = sampleWind(ctx, ac, rt, g.dir, dt);
  const headwindKt = -mpsToKt(vDot(wind, g.dir));
  ac.airspeedKt += perf.accelKtPerSec * dt + airspeedDeltaKt;
  const gsKt = Math.max(0, ac.airspeedKt - headwindKt);
  ac.groundSpeedKt = gsKt;
  ac.pos = vAdd(ac.pos, vScale(g.dir, ktToMps(gsKt) * dt));
  centreOnRunway(ac, g, dt);
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
  ac.verticalSpeedFpm = 0;
  if (ac.airspeedKt >= perf.rotateSpeedKt) {
    ac.onGround = false;
    ac.altitudeFt = g.elevationFt;
    ac.target.headingDeg = ac.target.headingDeg ?? g.headingDeg;
    ac.target.altitudeFt = ac.target.altitudeFt ?? ac.flightPlan?.ifrClearance?.initialAltitudeFt ?? departureAltitudeFt(ac, g.elevationFt);
    rt.navMode = 'HEADING';
    rt.takeoffCleared = false;
    rt.lineUp = undefined;
    ac.route = undefined;
    ac.flags.holdingPosition = false;
    completeClearances(ctx, ac, ['TAKEOFF', 'LINE_UP_AND_WAIT', 'TAXI']);
    setPhase(ctx, ac, 'INITIAL_CLIMB', 'airborne');
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} airborne runway ${g.end.id}`, severity: 'info', speaker: 'SYSTEM', data: { airborne: true, runwayEnd: g.end.id, runwayId: g.runway.id } });
  }
}

function centreOnRunway(ac: Aircraft, g: RunwayEndGeom, dt: number): void {
  const { cross } = alongCross(g, ac.pos);
  const fix = clamp(cross, -2 * dt, 2 * dt);
  ac.pos = vSub(ac.pos, vScale(g.right, fix));
}

// ---------------------------------------------------------------------------
// Landing rollout and runway exit
// ---------------------------------------------------------------------------

/** Hardest braking available, as a multiple of the normal landing-roll rate (autobrake / max manual braking). */
export const MAX_BRAKE_FACTOR = 1.4;
/** Margin (m) short of an intersecting runway's edge at which a stopping aircraft must be, nose included (the hold line is ~250 ft from its centreline). */
const INTERSECTION_HOLD_MARGIN_M = 60;
const RUNWAY_END_STOP_MARGIN_M = 60;

/** Where (m along `g`) an intersecting runway's surface begins, if it is ahead of `fromAlong`. */
function intersectionStartAlong(ctx: SimContext, g: RunwayEndGeom, fromAlong: number): number | undefined {
  let best: number | undefined;
  for (const other of crossingRunways(ctx.state.airport, g.runway.id)) {
    for (let s = Math.max(0, fromAlong); s <= g.lengthM; s += 10) {
      const c = vAdd(g.end.threshold, vScale(g.dir, s));
      const inside = [-20, 0, 20].some((lat) => pointInPolygon(vAdd(c, vScale(g.right, lat)), other.polygon));
      if (inside) {
        if (best === undefined || s < best) best = s;
        break;
      }
    }
  }
  return best;
}

/** Exit speed (m/s) for a connector leaving at `angleDeg` from the runway direction, limited so the aircraft can stop at the hold line `holdDistM` away. */
export function exitSpeedMps(angleDeg: number, holdDistM: number): number {
  // 90 degree exits <= 30 kt, shallow (high-speed) exits up to 60 kt
  const byAngle = clamp(60 - 0.5 * (angleDeg - 30), 20, 60);
  const byHold = 0.95 * Math.sqrt(2 * TAXI_DECEL_PLAN_FOR_EXIT * Math.max(20, holdDistM));
  return ktToMps(Math.min(byAngle, mpsToKt(byHold)));
}
const TAXI_DECEL_PLAN_FOR_EXIT = 0.9;

export interface RolloutPlan {
  exitNodeId?: string;
  holdNodeId?: string;
  exitSpeedMps: number;
  /** Braking rate (m/s^2) the plan needs (never above the maximum). */
  brakeMps2: number;
  /** No exit: the along-runway position (m) the aircraft must stop short of. */
  stopAlongM?: number;
}

/**
 * Plan the rollout: the FIRST exit the aircraft can make at a safe exit speed (`exitSpeedMps`) braking no harder than the
 * normal landing rate; failing that, the first exit it can make braking up to the maximum rate; failing that, no exit: stop
 * short of the runway end and of any intersecting runway (never stopping in or beyond its hold line) and ask for taxi instructions.
 */
function chooseExit(ctx: SimContext, ac: Aircraft, g: RunwayEndGeom, tdAlong: number, vTd: number, lahsoStopAlong?: number): RolloutPlan {
  const graph = ctx.state.airport.taxiwayGraph;
  const perf = perfOf(ac);
  const normal = ktToMps(perf.decelKtPerSec);
  const maxBrake = normal * MAX_BRAKE_FACTOR;
  const cands: { id: string; along: number; holds: string[] }[] = [];
  for (const id of Object.keys(graph.nodes)) {
    const n = graph.nodes[id];
    if (n.kind !== 'runway' || n.runwayId !== g.runway.id) continue;
    const holds = neighborIds(graph, id).filter((h) => graph.nodes[h].kind === 'holding_position' && graph.nodes[h].runwayId === g.runway.id);
    if (!holds.length) continue;
    cands.push({ id, along: alongCross(g, graph.nodes[id].pos).along, holds });
  }
  cands.sort((a, b) => a.along - b.along || (a.id < b.id ? -1 : 1));
  // Land and hold short: only exits before the hold-short point can be used, otherwise stop at it.
  if (lahsoStopAlong !== undefined) {
    for (let i = cands.length - 1; i >= 0; i--) if (cands[i].along > lahsoStopAlong) cands.splice(i, 1);
  }
  // The hold on the side from which parking is closest by taxi WITHOUT crossing any runway (`shortestDistances` never uses runway
  // surfaces): cost = Infinity when every side needs a runway crossing (re-crossing the landing or an intersecting runway).
  const pickHold = (c: { id: string; holds: string[] }): { hold: string; cost: number } => {
    let bestHold = c.holds[0];
    let bestCost = Infinity;
    for (const h of c.holds) {
      const dm = shortestDistances(graph, h);
      let cost = Infinity;
      for (const p of ctx.state.airport.parking) cost = Math.min(cost, dm.get(p.nodeId) ?? Infinity);
      if (cost < bestCost) {
        bestCost = cost;
        bestHold = h;
      }
    }
    return { hold: bestHold, cost: bestCost };
  };
  // The first reachable exit, but an exit whose taxi route to parking needs no runway crossing is preferred over earlier ones that
  // lead onto a hold beyond which the aircraft must cross a runway again (if none exists the first exit is used: the aircraft
  // stops at the hold and asks for the crossing).
  const evaluate = (limit: number): RolloutPlan | undefined => {
    let firstAny: RolloutPlan | undefined;
    for (const c of cands) {
      const d = c.along - tdAlong;
      if (d < 20) continue;
      const { hold, cost } = pickHold(c);
      const from = graph.nodes[c.id].pos;
      const to = graph.nodes[hold].pos;
      const angle = Math.abs(headingDiff(g.headingDeg, bearingDeg(from, to)));
      const vC = exitSpeedMps(angle, dist(from, to));
      const aReq = vTd > vC ? (vTd * vTd - vC * vC) / (2 * d) : 0;
      if (aReq <= limit) {
        const plan: RolloutPlan = { exitNodeId: c.id, holdNodeId: hold, exitSpeedMps: vC, brakeMps2: Math.max(aReq, 0.5 * normal) };
        if (Number.isFinite(cost)) return plan;
        firstAny ??= plan;
      }
    }
    return firstAny;
  };
  const plan = evaluate(normal) ?? evaluate(maxBrake);
  if (plan) return plan;
  // No exit within reach: stop on the remaining runway, short of an intersection and of the end.
  const natural = tdAlong + (vTd * vTd) / (2 * normal);
  const inter = intersectionStartAlong(ctx, g, tdAlong);
  const stopTarget = Math.min(
    natural, g.lengthM - RUNWAY_END_STOP_MARGIN_M, lahsoStopAlong ?? Infinity,
    inter !== undefined ? inter - INTERSECTION_HOLD_MARGIN_M - perf.lengthM / 2 : Infinity,
  );
  const room = Math.max(1, stopTarget - tdAlong);
  return { exitSpeedMps: 0, brakeMps2: clamp((vTd * vTd) / (2 * room), normal, maxBrake), stopAlongM: stopTarget };
}

/** The rollout plan for an aircraft of `type` touching down (or already rolling) at `tdAlongM` with `vTdMps`; pure, for predictions. */
export function predictRolloutPlan(state: SimContext['state'], type: string, g: RunwayEndGeom, tdAlongM: number, vTdMps: number): RolloutPlan {
  return chooseExit({ state } as SimContext, { type } as Aircraft, g, tdAlongM, vTdMps);
}

function touchdown(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, g: RunwayEndGeom): void {
  const wind = rt.gust?.wind ?? windVector(ctx.state.weather);
  const headwindKt = -mpsToKt(vDot(wind, g.dir));
  ac.onGround = true;
  rt.gustAirKt = 0;
  ac.altitudeFt = g.elevationFt;
  ac.verticalSpeedFpm = 0;
  ac.groundSpeedKt = Math.max(20, ac.airspeedKt - headwindKt);
  ac.airspeedKt = ac.groundSpeedKt; // from here on speeds are ground speeds
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
  ac.target = {};
  ac.nav = undefined;
  rt.approach = undefined;
  rt.navMode = 'AUTO';
  rt.turnRateDegPerSec = 0;
  setPhase(ctx, ac, 'ROLLOUT', 'touchdown');
  const { along } = alongCross(g, ac.pos);
  rt.rollout = chooseExit(ctx, ac, g, along, ktToMps(ac.groundSpeedKt), rt.lahso?.stopAlongM);
  // distance from the LANDING threshold (the displaced one where there is one)
  const fromThr = along - g.displacedM;
  emitEvent(ctx, {
    kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
    text: `${ac.callsign} touched down runway ${g.end.id} ${Math.round(fromThr)} m from threshold`,
    data: { runwayEnd: g.end.id, alongM: fromThr, alongPavementEndM: along, displacedM: g.displacedM, groundSpeedKt: ac.groundSpeedKt },
  });
}

function stepRollout(ctx: SimContext, ac: Aircraft, dt: number): void {
  const perf = perfOf(ac);
  const rt = getRuntime(ctx, ac);
  const g = findRunwayEnd(ctx.state.airport, ac.assignedRunwayEnd);
  const graph = ctx.state.airport.taxiwayGraph;
  if (!g || !rt.rollout) return;
  const maxBrake = ktToMps(perf.decelKtPerSec) * MAX_BRAKE_FACTOR;
  let v = ktToMps(ac.groundSpeedKt);
  const exitNode = rt.rollout.exitNodeId ? graph.nodes[rt.rollout.exitNodeId] : undefined;
  const vExit = rt.rollout.exitSpeedMps;
  const { along } = alongCross(g, ac.pos);
  if (exitNode) {
    const d = alongCross(g, exitNode.pos).along - along;
    if (v > vExit) {
      // brake to reach the exit at the exit speed: at least the planned rate, harder if it fell behind (up to the maximum)
      const aReq = d > 1 ? (v * v - vExit * vExit) / (2 * d) : maxBrake;
      v = Math.max(vExit, v - clamp(Math.max(aReq, rt.rollout.brakeMps2), 0, maxBrake) * dt);
    }
  } else {
    const room = (rt.rollout.stopAlongM ?? g.lengthM) - along;
    const aReq = room > 1 ? (v * v) / (2 * room) : maxBrake;
    v = Math.max(0, v - clamp(Math.max(aReq, rt.rollout.brakeMps2), 0, maxBrake) * dt);
  }
  let step = v * dt;
  ac.pos = vAdd(ac.pos, vScale(g.dir, step));
  centreOnRunway(ac, g, dt);
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
  if (exitNode) {
    const nowAlong = alongCross(g, ac.pos).along;
    const exitAlong = alongCross(g, exitNode.pos).along;
    if (nowAlong >= exitAlong - 1e-6) {
      ac.pos = { x: exitNode.pos.x, y: exitNode.pos.y };
      step = 0;
      const hold = rt.rollout.holdNodeId!;
      ac.route = { nodeIds: [exitNode.id, hold], taxiways: graph.nodes[hold].taxiways.slice(0, 1), stopAtNodeIds: [hold], progressIndex: 1 };
      ac.groundSpeedKt = mpsToKt(v);
      ac.airspeedKt = ac.groundSpeedKt;
      rt.rollout = undefined;
      rt.lahso = undefined;
      setPhase(ctx, ac, 'RUNWAY_EXIT', `exit via ${graph.nodes[hold].taxiways[0] ?? exitNode.id}`);
      return;
    }
  }
  ac.groundSpeedKt = mpsToKt(v);
  ac.airspeedKt = ac.groundSpeedKt;
  if (!exitNode && ac.groundSpeedKt < 0.1) {
    ac.groundSpeedKt = 0;
    ac.airspeedKt = 0;
    rt.rollout = undefined;
    setPhase(ctx, ac, 'RUNWAY_EXIT', 'stopped on runway');
    rt.lahso = undefined;
    rt.calls.add('stoppedOnRunway');
  }
}

// ---------------------------------------------------------------------------
// Go-around
// ---------------------------------------------------------------------------

export function initiateGoAround(ctx: SimContext, ac: Aircraft, o: { reason: string; announce: boolean }): void {
  const rt = getRuntime(ctx, ac);
  const g = findRunwayEnd(ctx.state.airport, ac.assignedRunwayEnd);
  const elev = g?.elevationFt ?? ctx.state.airport.elevationFt;
  setPhase(ctx, ac, 'GO_AROUND', o.reason);
  ac.lastGoAroundSec = ctx.state.clock.timeSec;
  completeClearances(ctx, ac, ['LAND']);
  if (g) {
    const idx = ac.runwayAuthorizations.indexOf(g.runway.id);
    if (idx >= 0) ac.runwayAuthorizations.splice(idx, 1);
  }
  rt.landingEnd = undefined;
  rt.lahso = undefined;
  rt.decisionDone = false;
  rt.calls.delete('gaEst');
  rt.navMode = 'HEADING';
  rt.pattern = undefined;
  // A missed approach cancels the approach clearance and any route. IFR aircraft fly the published missed approach when its
  // text can be interpreted; otherwise: runway heading, climb to a fixed altitude, ask for vectors.
  const approachBefore = rt.approach;
  rt.approach = undefined;
  rt.missed = undefined;
  rt.hold = undefined;
  ac.nav = undefined;
  completeClearances(ctx, ac, ['APPROACH']);
  ac.target = { headingDeg: g ? g.headingDeg : ac.headingDeg, altitudeFt: goAroundAltitudeFt(ctx, ac, elev, g, approachBefore), speedKt: undefined };
  const published = startPublishedMissed(ctx, ac, rt, g, approachBefore);
  rt.missedFlown = true;
  ac.pendingRequest = undefined;
  emitEvent(ctx, {
    kind: 'GO_AROUND', aircraftId: ac.id, callsign: ac.callsign, severity: 'warning', speaker: 'SYSTEM',
    text: `${ac.callsign} going around runway ${g?.end.id ?? '?'}: ${o.reason}`,
    data: { reason: o.reason, runwayEnd: g?.end.id },
  });
  if (o.announce) {
    pilotSay(ctx, ac, goingAroundCall(ac, { airport: ctx.state.airport }, g?.end.id ?? '', o.reason, { published }), { goAround: true });
    ac.pendingRequest = { kind: 'OTHER', text: `going around: ${o.reason}`, sinceSec: ctx.state.clock.timeSec };
  }
}

// ---------------------------------------------------------------------------
// Airborne guidance
// ---------------------------------------------------------------------------

interface Guidance {
  desiredHeading: number;
  forceDir?: 'left' | 'right';
  altTargetFt?: number;
  vsFpm?: number;
  speedKt: number;
}

/**
 * Default speeds. 14 CFR 91.117(b) (200 kt at or below 2,500 ft AGL within 4 nm of a Class C/D primary airport, KACY is Class C) is met
 * by the A320 defaults: DEPARTURE below 2,500 ft AGL flies the climb speed (175 kt), APPROACH the mean of climb and approach speed
 * (~155 kt), FINAL the approach speed (135 kt); the 250 kt cap (91.117(a)) only applies to INBOUND / en-route flight, far out.
 * An explicit SPEED assignment can exceed 200 kt in that area: nothing warns about it (known limitation).
 */
function defaultSpeedKt(ac: Aircraft, perf: AircraftPerformance, aglFt: number): number {
  const cap = (v: number) => (ac.altitudeFt < 10000 && perf.category !== 'light' ? Math.min(v, 250) : v);
  switch (ac.phase) {
    case 'INITIAL_CLIMB':
    case 'GO_AROUND':
      return perf.climbSpeedKt;
    case 'DEPARTURE':
      return aglFt < 2500 ? perf.climbSpeedKt : cap(perf.cruiseSpeedKt);
    case 'INBOUND':
      return cap(perf.cruiseSpeedKt);
    case 'APPROACH':
    case 'PATTERN':
      return (perf.climbSpeedKt + perf.approachSpeedKt) / 2;
    case 'FINAL':
    case 'LANDING':
      return perf.approachSpeedKt;
    default:
      return Math.max(perf.minSpeedKt, ac.airspeedKt);
  }
}

/** Heading to fly so that the ground track is `trackDeg` in the given wind. */
function headingForTrack(trackDeg: number, tasKt: number, wind: Vec2): number {
  const t = headingToVec(trackDeg);
  const rightOfTrack = { x: t.y, y: -t.x };
  const wp = vDot(wind, rightOfTrack);
  const s = clamp(wp / Math.max(1, ktToMps(tasKt)), -0.5, 0.5);
  return normHeading(trackDeg - rad2deg(Math.asin(s)));
}

/** Turn radius (m) at the aircraft's current airspeed and standard turn rate. */
function turnRadiusM(ac: Aircraft, perf: AircraftPerformance): number {
  return ktToMps(Math.max(ac.airspeedKt, 40)) / deg2rad(perf.turnRateDegPerSec);
}

/** Lateral guidance toward the extended centreline of `g` (pure pursuit with a rollout lead). */
function centrelineHeading(g: RunwayEndGeom, ac: Aircraft, perf: AircraftPerformance, wind: Vec2): number {
  const { along, cross } = alongCross(g, ac.pos);
  const d = Math.max(0, -along);
  const gs = Math.max(ktToMps(ac.groundSpeedKt), 15);
  const gain = clamp(57.3 / (gs * 15), 0.03, 0.15); // deg per metre of offset: ~15 s time constant
  let cap = Math.min(45, 8 + d / 120);
  const theta = Math.min(90, Math.abs(headingDiff(ac.headingDeg, g.headingDeg)));
  const lead = turnRadiusM(ac, perf) * (1 - Math.cos(deg2rad(theta)));
  // Inside the rollout lead the aircraft is turning onto the course: stop asking for a steep intercept.
  if (Math.abs(cross) <= lead + 80) cap = Math.min(cap, 12);
  const ang = clamp(cross * gain, -cap, cap);
  return headingForTrack(g.headingDeg - ang, ac.airspeedKt, wind);
}

function inCaptureZone(g: RunwayEndGeom, ac: Aircraft, perf: AircraftPerformance): boolean {
  const { along, cross } = alongCross(g, ac.pos);
  const d = -along;
  if (d <= 150) return false;
  const theta = Math.min(90, Math.abs(headingDiff(ac.headingDeg, g.headingDeg)));
  const lead = turnRadiusM(ac, perf) * (1 - Math.cos(deg2rad(theta)));
  const cone = Math.max(100, 0.05 * d);
  return Math.abs(cross) <= cone + lead;
}

function otherOnRunway(ctx: SimContext, ac: Aircraft, g: RunwayEndGeom): Aircraft | undefined {
  // an aircraft already far enough down the runway by day (JO 7110.65 3-10-3, 3,000 / 4,500 ft) does not block the landing
  return Object.values(ctx.state.aircraft).find((o) => o !== ac && o.occupyingRunways.includes(g.runway.id) && !landedDistanceExceptionApplies(ctx.state, ac, o, g));
}

/** At the decision point: traffic on the runway now, or a preceding arrival that will still be on it when this one crosses the threshold (3-10-3). */
function runwayBlocker(ctx: SimContext, ac: Aircraft, g: RunwayEndGeom): Aircraft | undefined {
  return otherOnRunway(ctx, ac, g) ?? precedingArrivalBlockers(ctx.state, ac, g)[0]?.other;
}

/** Distance (m) before the threshold at which FINAL (3 degree path logic) starts; cleared approaches join farther out. */
function finalStartM(rt: AircraftRuntime, perf: AircraftPerformance): number {
  return nmToM(rt.approach ? Math.max(APPROACH_FINAL_NM, finalStartNm(perf)) : finalStartNm(perf));
}

/** APPROACH / PATTERN -> FINAL when established on the extended centreline inside the final start distance. */
function maybeEstablishFinal(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, g: RunwayEndGeom, perf: AircraftPerformance): boolean {
  if (ac.phase === 'INBOUND' && rt.approach) setPhase(ctx, ac, 'APPROACH');
  if (ac.phase !== 'APPROACH' && ac.phase !== 'PATTERN') return false;
  const d = -alongCross(g, ac.pos).along;
  if (!(inCaptureZone(g, ac, perf) && d <= finalStartM(rt, perf) + 300)) return false;
  setPhase(ctx, ac, 'FINAL', `established runway ${g.end.id}`);
  rt.pattern = undefined;
  rt.decisionDone = false;
  ac.target.altitudeFt = undefined;
  if (rt.approach) {
    // Established on a cleared approach: leave the route, slow to approach speed, fly the course.
    // the remaining fixes are still reported when crossed (see `trackCrossingsOnFinal`), the route is no longer flown
    ac.target.headingDeg = undefined;
    rt.navMode = 'AUTO';
    rt.turnDirection = undefined;
    if (ac.target.speedKt !== undefined && ac.target.speedKt > perf.climbSpeedKt) ac.target.speedKt = undefined;
  }
  return true;
}

function approachGuidance(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, g: RunwayEndGeom, perf: AircraftPerformance, wind: Vec2, aglFt: number): Guidance {
  const { along, cross } = alongCross(g, ac.pos);
  const d = -along;
  const startM = finalStartM(rt, perf);
  const distThr = dist(ac.pos, g.end.threshold);
  const base = ac.target.speedKt ?? defaultSpeedKt(ac, perf, aglFt);
  const gp = glidePathFor(ctx.state.airport, rt, g, perf);
  const tanGp = Math.tan(deg2rad(gp.angleDeg));

  if (ac.phase === 'INBOUND' && distThr < nmToM(APPROACH_RANGE_NM)) setPhase(ctx, ac, 'APPROACH');
  maybeEstablishFinal(ctx, ac, rt, g, perf);

  if (ac.phase === 'FINAL' || ac.phase === 'LANDING') {
    // Decision altitude / MDA of an instrument approach: without the runway in sight the missed approach is flown, even if cleared to land.
    if (rt.approach && rt.approach.type !== 'VISUAL' && !rt.approach.daChecked) {
      const ap = rt.approach;
      if (!ap.minima) {
        const proc = ctx.state.airport.procedures.find((p) => p.id === ap.procedureId);
        ap.minima = resolveMinima(proc, ap.type, g.elevationFt);
        if (ap.minima.assumed) {
          emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'warning', speaker: 'SYSTEM', text: `${ac.callsign}: ${ap.minima.assumed}`, data: { minima: 'fallback' } });
        }
      }
      if (ac.altitudeFt <= ap.minima.altFt) {
        ap.daChecked = true;
        const sight = runwayInSight(ctx.state.weather, ap.minima);
        if (!sight.inSight) {
          initiateGoAround(ctx, ac, { reason: 'runway not in sight', announce: true });
          return { desiredHeading: g.headingDeg, altTargetFt: ac.target.altitudeFt, speedKt: perf.climbSpeedKt };
        }
      }
    }
    // Decision point: landing clearance + runway free, else go around.
    if (ac.phase === 'FINAL' && !rt.decisionDone && d <= DECISION_POINT_M) {
      rt.decisionDone = true;
      const cleared = rt.landingEnd === g.end.id && !!activeClearance(ac, 'LAND');
      const blocker = cleared ? runwayBlocker(ctx, ac, g) : undefined;
      const unstable = Math.abs(cross) > 250 || Math.abs(headingDiff(ac.headingDeg, g.headingDeg)) > 25;
      const reason = !cleared ? 'no landing clearance' : blocker ? 'traffic on the runway' : unstable ? 'unstable approach' : undefined;
      if (reason) initiateGoAround(ctx, ac, { reason, announce: true });
      else setPhase(ctx, ac, 'LANDING', 'cleared to land');
      if (reason) {
        return { desiredHeading: g.headingDeg, altTargetFt: ac.target.altitudeFt, speedKt: perf.climbSpeedKt };
      }
    }
    // Last chance: cleared and about to cross the threshold with the runway still occupied (the leader did not clear as projected).
    if (ac.phase === 'LANDING' && d > 0 && d < LAST_CHANCE_M && ac.altitudeFt - g.elevationFt > 25) {
      const blocker = otherOnRunway(ctx, ac, g);
      if (blocker) {
        initiateGoAround(ctx, ac, { reason: 'traffic on the runway', announce: true });
        return { desiredHeading: g.headingDeg, altTargetFt: ac.target.altitudeFt, speedKt: perf.climbSpeedKt };
      }
    }
    // Wind limits of the type (cited figures only). DESIGN DECISION: a demonstrated value is not a limitation, so the go-around needs the
    // instantaneous gusted component to exceed it by WIND_GOAROUND_MARGIN_KT for WIND_LIMIT_GOAROUND_SEC.
    if (rt.gust && d > 0 && d < nmToM(1) && aglFt > 50) {
      const rg = findRunwayEnd(ctx.state.airport, ac.assignedRunwayEnd);
      const why = rg ? exceedsLimits(componentsOfVector(rt.gust.wind, rg.headingDeg), perf, WIND_GOAROUND_MARGIN_KT) : undefined;
      rt.windExceedSec = why ? (rt.windExceedSec ?? 0) + ctx.state.clock.dtSec : 0;
      if (why && rt.windExceedSec >= WIND_LIMIT_GOAROUND_SEC) {
        initiateGoAround(ctx, ac, { reason: why.startsWith('crosswind') ? 'crosswind exceeds our limit' : 'tailwind exceeds our limit', announce: true });
        return { desiredHeading: g.headingDeg, altTargetFt: ac.target.altitudeFt, speedKt: perf.climbSpeedKt };
      }
    }
    // Lateral + glidepath.
    const gsMps = Math.max(ktToMps(ac.groundSpeedKt), ktToMps(perf.minSpeedKt * 0.8));
    const vsGp = -mToFt(gsMps * tanGp) * 60;
    const glide = glideAltitudeFt(g.elevationFt, d, gp);
    const err = glide - ac.altitudeFt;
    let vs = Math.min(0, vsGp + clamp(err * 5, -400, 400));
    vs = Math.max(vs, -perf.descentRateFpm * 1.3);
    // Cleared approach: intercept the glidepath from below (hold level until it arrives).
    if (rt.approach && err > 50 && d > nmToM(2)) vs = 0;
    if (aglFt < 30) vs = -(100 + (Math.abs(vsGp) - 100) * clamp(aglFt / 30, 0, 1));
    // Gusts in the flare: airspeed the gust added balloons the aircraft (longer float), a lull sinks it (shorter float, firmer touchdown).
    if (aglFt < 50 && rt.gustAirKt) vs = Math.min(-30, vs + clamp(GUST_LIFT_FPM_PER_KT * rt.gustAirKt, -150, 250));
    const rampSpeed = ac.target.speedKt ?? perf.approachSpeedKt;
    const speedKt = perf.touchdownSpeedKt + (rampSpeed - perf.touchdownSpeedKt) * clamp(aglFt / 150, 0, 1);
    return { desiredHeading: centrelineHeading(g, ac, perf, wind), vsFpm: vs, speedKt: Math.min(speedKt, rampSpeed) };
  }

  // INBOUND / APPROACH / PATTERN before the final: fly toward the intercept point, descend gradually.
  let desiredHeading: number;
  let interceptAlt = Math.ceil(glideAltitudeFt(g.elevationFt, startM, gp) / 100) * 100;
  const captured = inCaptureZone(g, ac, perf);
  if (ac.phase === 'PATTERN' && rt.pattern) {
    desiredHeading = patternHeading(g, ac, rt, wind);
    interceptAlt = Math.round(patternAltitudeFt(perf, g.elevationFt, ctx.state.airport.trafficPatternAltitudeFt) / 100) * 100;
  } else if (captured) {
    desiredHeading = centrelineHeading(g, ac, perf, wind);
  } else {
    const f = vSub(g.end.threshold, vScale(g.dir, startM + nmToM(1)));
    desiredHeading = bearingDeg(ac.pos, f);
  }
  let altTarget = ac.target.altitudeFt;
  if (altTarget === undefined) {
    if (ac.phase === 'PATTERN') altTarget = interceptAlt;
    else if (ac.phase === 'INBOUND') altTarget = undefined;
    else {
      const want = Math.max(interceptAlt, glideAltitudeFt(g.elevationFt, Math.max(distThr, startM), gp) + 100);
      altTarget = Math.min(ac.altitudeFt, want);
    }
  }
  return { desiredHeading, altTargetFt: altTarget, speedKt: base };
}

function patternHeading(g: RunwayEndGeom, ac: Aircraft, rt: AircraftRuntime, wind: Vec2): number {
  const p = rt.pattern!;
  const { along, cross } = alongCross(g, ac.pos);
  const sideSign = p.side === 'left' ? -1 : 1; // left of landing direction = negative cross
  const offset = sideSign * nmToM(0.8);
  if (p.leg === 'DOWNWIND') {
    if (along <= -nmToM(1.2) && Math.abs(cross - offset) < 600) {
      rt.pattern = { ...p, leg: 'BASE' };
    } else {
      const recip = normHeading(g.headingDeg + 180);
      const ang = clamp((cross - offset) * 0.04, -45, 45);
      return headingForTrack(recip + ang, ac.airspeedKt, wind);
    }
  }
  // BASE: fly perpendicular toward the centreline.
  const baseHdg = normHeading(g.headingDeg + (p.side === 'left' ? 90 : -90));
  return headingForTrack(baseHdg, ac.airspeedKt, wind);
}

/** Glidepath state at `dM` metres before the threshold: ideal vertical speed and altitude error (ft, + = aircraft below the path). */
function glideState(ac: Aircraft, perf: AircraftPerformance, g: RunwayEndGeom, dM: number, gp: GlidePath): { vs: number; err: number } {
  const gsMps = Math.max(ktToMps(ac.groundSpeedKt), ktToMps(perf.minSpeedKt * 0.8));
  const vsGp = -mToFt(gsMps * Math.tan(deg2rad(gp.angleDeg))) * 60;
  const err = glideAltitudeFt(g.elevationFt, dM, gp) - ac.altitudeFt;
  const vs = Math.max(Math.min(0, vsGp + clamp(err * 5, -400, 400)), -perf.descentRateFpm * 1.3);
  return { vs, err };
}

/** On-course fixes (farthest first) that are still ahead of the aircraft along the final approach course. */
function fixesAhead(ctx: SimContext, g: RunwayEndGeom, onCourse: string[], pos: Vec2): string[] {
  const dAc = -alongCross(g, pos).along;
  return onCourse.filter((id) => {
    const p = fixPosition(ctx.state.airport, id);
    return !!p && -alongCross(g, p).along < dAc - 200;
  });
}

/** On FINAL the route is not flown any more, but the fixes still ahead are sequenced so their crossings are reported. */
function trackCrossingsOnFinal(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, perf: AircraftPerformance): void {
  if (!ac.nav || ac.nav.mode !== 'approach' || (ac.phase !== 'FINAL' && ac.phase !== 'LANDING')) return;
  for (const id of advanceNav(ctx.state.airport, ac, perf)) {
    rt.passedFixes.add(id.toUpperCase());
    emitEvent(ctx, {
      kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
      text: `${ac.callsign} crossed ${id} at ${Math.round(ac.altitudeFt)} ft`, data: { crossing: { fix: id.toUpperCase(), altitudeFt: Math.round(ac.altitudeFt) } },
    });
  }
  if (ac.nav.index >= ac.nav.fixes.length) ac.nav = undefined;
}

/** Vector-intercept approach clearance: when the course is reached, stop flying the heading and capture it. */
function capturePendingApproach(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, g: RunwayEndGeom, perf: AircraftPerformance): void {
  const ap = rt.approach;
  if (!ap || !ap.pendingCapture || !inCaptureZone(g, ac, perf)) return;
  ap.pendingCapture = false;
  rt.navMode = 'AUTO';
  rt.turnDirection = undefined;
  ac.target.headingDeg = undefined;
  const ahead = fixesAhead(ctx, g, ap.onCourse, ac.pos);
  ac.nav = ahead.length ? { fixes: ahead, index: 0, mode: 'approach' } : undefined;
  emitEvent(ctx, {
    kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
    text: `${ac.callsign} established on the ${ap.type} course runway ${ap.runwayEnd}`, data: { approach: ap.type, runwayEnd: ap.runwayEnd },
  });
}

/** The route is flown out: approach -> runway guidance takes over; otherwise hold the last heading. */
function endOfRoute(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, g: RunwayEndGeom | undefined): void {
  const mode = ac.nav?.mode;
  ac.nav = undefined;
  if (mode === 'approach' && rt.approach && g) {
    rt.navMode = 'AUTO';
    ac.target.headingDeg = undefined;
  } else {
    ac.target.headingDeg = ac.headingDeg;
    rt.navMode = 'HEADING';
    rt.turnDirection = undefined;
    emitEvent(ctx, {
      kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
      text: `${ac.callsign} reached the end of its route, maintaining heading ${Math.round(ac.headingDeg)}`, data: { routeComplete: true },
    });
  }
}

/**
 * Published fix altitudes (`InstrumentProcedure.fixAltitudes`): the altitude to fly toward on the way along the remaining approach
 * fixes. Each restriction is met at the fix (mandatory = exactly, max = at or below, min = at or above - the pilot descends to the
 * minimum): the aircraft descends just in time, at 80% of the type's descent rate, to be at the fix altitude about 20 s before
 * the fix; it never climbs and never goes below the next minimum.
 */
const PROFILE_LEAD_SEC = 20;

function profileAltitude(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, perf: AircraftPerformance): number | undefined {
  const ap = rt.approach;
  const nav = ac.nav;
  if (!ap?.profile?.length || !nav) return undefined;
  const base = ac.target.altitudeFt ?? ac.altitudeFt;
  const gs = Math.max(ktToMps(ac.groundSpeedKt), ktToMps(60));
  let distM = 0;
  let prev = ac.pos;
  let ceiling = Infinity;
  let floor: number | undefined;
  for (let i = nav.index; i < nav.fixes.length; i++) {
    const p = fixPosition(ctx.state.airport, nav.fixes[i]);
    if (!p) continue;
    distM += dist(prev, p);
    // the fix is sequenced (and its crossing altitude reported) at the fly-by turn anticipation point, short of the fix itself
    const nextP = i + 1 < nav.fixes.length ? fixPosition(ctx.state.airport, nav.fixes[i + 1]) : undefined;
    const lead = turnLeadM(ac, perf, nextP ? Math.abs(headingDiff(bearingDeg(prev, p), bearingDeg(p, nextP))) : 0);
    const seqDistM = Math.max(0, distM - lead);
    prev = p;
    const entries = ap.profile.filter((f) => f.fix === nav.fixes[i].toUpperCase());
    if (!entries.length) continue;
    const lowest = entries.reduce((a, b) => (restrictionReach(b) < restrictionReach(a) ? b : a));
    const reach = restrictionReach(lowest);
    if (!Number.isFinite(reach)) continue;
    // aim to be at the fix altitude about 20 s before the fix: the vertical-speed controller (10 s time constant) lags a ramp by that much
    const tSec = Math.max(0, seqDistM / gs - PROFILE_LEAD_SEC);
    ceiling = Math.min(ceiling, reach + (perf.descentRateFpm * 0.8 * tSec) / 60);
    if (floor === undefined) floor = lowest.mandatoryAltitudeFt ?? lowest.minAltitudeFt;
  }
  if (!Number.isFinite(ceiling)) return undefined;
  // never climb back up to a later, higher restriction once a fix has been crossed
  return Math.min(ac.altitudeFt, base, Math.max(ceiling, floor ?? -Infinity));
}

/** The altitude a published restriction asks to be at over the fix: mandatory, else the maximum, else the minimum. */
function restrictionReach(f: { minAltitudeFt?: number; maxAltitudeFt?: number; mandatoryAltitudeFt?: number }): number {
  return f.mandatoryAltitudeFt ?? f.maxAltitudeFt ?? f.minAltitudeFt ?? Infinity;
}

/** Lateral guidance toward `nav.fixes[nav.index]`; undefined once the route is exhausted. */
function routeGuidance(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, g: RunwayEndGeom | undefined, perf: AircraftPerformance, wind: Vec2, aglFt: number): Guidance | undefined {
  const airport = ctx.state.airport;
  const mode = ac.nav!.mode;
  if (mode === 'missed' || mode === 'holding') {
    // Published missed approach / holding pattern: own guidance, wind-corrected here.
    const gd = mode === 'missed' && rt.missed ? missedGuidance(ctx, ac, rt, perf) : rt.hold ? holdGuidance(ctx, ac, rt, perf) : undefined;
    if (!gd) {
      ac.nav = undefined; // inconsistent state (e.g. hold cleared): fall back to holding the heading
      ac.target.headingDeg = ac.headingDeg;
      rt.navMode = 'HEADING';
      return undefined;
    }
    return { desiredHeading: headingForTrack(gd.track, ac.airspeedKt, wind), altTargetFt: ac.target.altitudeFt, speedKt: gd.speedKt, forceDir: gd.forceDir };
  }
  const sequenced = advanceNav(airport, ac, perf);
  for (const id of sequenced) {
    rt.passedFixes.add(id.toUpperCase());
    if (rt.approach && ac.nav!.mode === 'approach') {
      emitEvent(ctx, {
        kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
        text: `${ac.callsign} crossed ${id} at ${Math.round(ac.altitudeFt)} ft`, data: { crossing: { fix: id.toUpperCase(), altitudeFt: Math.round(ac.altitudeFt) } },
      });
    }
  }
  const nav = ac.nav!;
  if (g && !ac.isDeparture && ac.phase === 'INBOUND' && dist(ac.pos, g.end.threshold) < nmToM(APPROACH_RANGE_NM)) setPhase(ctx, ac, 'APPROACH');
  if (nav.index >= nav.fixes.length) {
    endOfRoute(ctx, ac, rt, g);
    return undefined;
  }
  const fixId = nav.fixes[nav.index];
  const p = fixPosition(airport, fixId)!;
  let desired = headingForTrack(bearingDeg(ac.pos, p), ac.airspeedKt, wind);
  let vsFpm: number | undefined;
  if (nav.mode === 'approach' && rt.approach && g && rt.approach.onCourse.some((f) => f.toUpperCase() === fixId.toUpperCase())) {
    // Straight-in segment: track the course once close to it, and descend on the 3 degree path once the path is reached.
    const { along, cross } = alongCross(g, ac.pos);
    const d = -along;
    if (inCaptureZone(g, ac, perf)) desired = centrelineHeading(g, ac, perf, wind);
    // Established inbound on the straight-in segment (on the course within the classification tolerance and no farther
    // out than the IF + 1 nm): hold the assigned altitude until the 3 degree path is reached, then follow it.
    // With a published profile, non-precision approaches follow the fix altitudes and intercept the 3 degree path at the FAF.
    const published = !!rt.approach.profile?.length;
    const ifM = rt.approach.ifDM ?? nmToM(12);
    const glideFrom = published && !rt.approach.precision ? (rt.approach.fafDM ?? nmToM(4.5)) + nmToM(0.3) : ifM + nmToM(1);
    if (d <= glideFrom && isOnCourse(mToNm(d), mToNm(cross))) {
      const gs = glideState(ac, perf, g, d, glidePathFor(airport, rt, g, perf));
      vsFpm = gs.err > 50 ? 0 : gs.vs;
    }
  }
  let altTarget = ac.target.altitudeFt;
  if (nav.mode === 'approach' && rt.approach?.profile?.length) altTarget = profileAltitude(ctx, ac, rt, perf) ?? altTarget;
  return { desiredHeading: desired, altTargetFt: altTarget, vsFpm, speedKt: ac.target.speedKt ?? defaultSpeedKt(ac, perf, aglFt) };
}

function stepAirborne(ctx: SimContext, ac: Aircraft, dt: number): void {
  const perf = perfOf(ac);
  const rt = getRuntime(ctx, ac);
  const g = findRunwayEnd(ctx.state.airport, ac.assignedRunwayEnd);
  const elev = g?.elevationFt ?? ctx.state.airport.elevationFt;
  const agl = ac.altitudeFt - elev;
  const wind = windVector(ctx.state.weather); // the steady wind: what the pilot / FMS corrects for (gusts are not anticipated)
  const gustSample = sampleWind(ctx, ac, rt, headingToVec(ac.headingDeg), dt);
  if (gustSample.airspeedDeltaKt !== 0) {
    ac.airspeedKt += gustSample.airspeedDeltaKt;
    rt.gustAirKt = (rt.gustAirKt ?? 0) + gustSample.airspeedDeltaKt;
  }
  if (rt.gustAirKt) {
    // the speed controller removes the added airspeed at its own accel / decel rate
    const relax = rt.gustAirKt > 0 ? Math.min(rt.gustAirKt, (perf.category === 'light' ? 1.0 : 1.5) * dt) : Math.max(rt.gustAirKt, -0.5 * perf.accelKtPerSec * dt);
    rt.gustAirKt -= relax;
    if (Math.abs(rt.gustAirKt) < 1e-6) rt.gustAirKt = 0;
  }

  // Lateral approach logic (capture, establishment, centreline) is flown against the procedure's final approach COURSE
  // (localizer course / FAF-to-threshold bearing), which can differ from the runway heading; touchdown uses the runway.
  const gc = g ? courseGeom(g, rt.approach?.courseTrue) : g;
  const navPhase = ac.phase === 'INBOUND' || ac.phase === 'APPROACH' || ac.phase === 'FINAL' || ac.phase === 'LANDING' || ac.phase === 'PATTERN';
  if (g && rt.approach && (ac.phase === 'INBOUND' || ac.phase === 'APPROACH')) {
    capturePendingApproach(ctx, ac, rt, gc!, perf);
    if (!rt.approach.pendingCapture) maybeEstablishFinal(ctx, ac, rt, gc!, perf);
  }
  trackCrossingsOnFinal(ctx, ac, rt, perf);
  let guid: Guidance | undefined;
  if (ac.nav && ac.nav.mode !== 'vectors' && NAV_PHASES.includes(ac.phase)) guid = routeGuidance(ctx, ac, rt, gc, perf, wind, agl);
  if (guid) {
    /* flying the route */
  } else if (g && navPhase && (rt.navMode === 'AUTO' || ac.phase === 'FINAL' || ac.phase === 'LANDING')) {
    guid = approachGuidance(ctx, ac, rt, gc!, perf, wind, agl);
  } else {
    const speed = ac.target.speedKt ?? defaultSpeedKt(ac, perf, agl);
    guid = { desiredHeading: ac.target.headingDeg ?? ac.headingDeg, altTargetFt: ac.target.altitudeFt, speedKt: speed, forceDir: rt.turnDirection };
  }
  if (ac.phase === 'INITIAL_CLIMB' && agl >= 400) setPhase(ctx, ac, 'DEPARTURE');

  // Heading: bank builds smoothly toward the commanded turn rate.
  let err = headingDiff(ac.headingDeg, guid.desiredHeading);
  if (guid.forceDir === 'left' && err > 1) err -= 360;
  else if (guid.forceDir === 'right' && err < -1) err += 360;
  if (guid.forceDir && Math.abs(err) < 2) rt.turnDirection = undefined;
  const maxRate = perf.turnRateDegPerSec;
  const wantRate = clamp(err * 0.6, -maxRate, maxRate);
  rt.turnRateDegPerSec += clamp(wantRate - rt.turnRateDegPerSec, -ROLL_ACCEL_DEG_PER_SEC2 * dt, ROLL_ACCEL_DEG_PER_SEC2 * dt);
  let dh = rt.turnRateDegPerSec * dt;
  if (Math.abs(dh) >= Math.abs(err) && Math.sign(dh) === Math.sign(err)) {
    dh = err;
    rt.turnRateDegPerSec = 0;
  }
  ac.headingDeg = normHeading(ac.headingDeg + dh);

  // Speed.
  const speedTarget = clamp(guid.speedKt, perf.minSpeedKt, perf.maxSpeedKt);
  const accel = 0.5 * perf.accelKtPerSec;
  const decel = perf.category === 'light' ? 1.0 : 1.5;
  ac.airspeedKt += clamp(speedTarget - ac.airspeedKt, -decel * dt, accel * dt);

  // Vertical.
  const climbMax = perf.climbRateFpm * (1 - 0.6 * clamp(ac.altitudeFt / perf.serviceCeilingFt, 0, 1));
  let vsWant: number;
  if (guid.vsFpm !== undefined) vsWant = guid.vsFpm;
  else if (guid.altTargetFt !== undefined) {
    const e = guid.altTargetFt - ac.altitudeFt;
    const mag = Math.max(60, Math.abs(e) * 6);
    vsWant = Math.abs(e) < 0.5 ? 0 : clamp(Math.sign(e) * mag, -perf.descentRateFpm, climbMax);
  }
  else vsWant = 0;
  ac.verticalSpeedFpm += clamp(vsWant - ac.verticalSpeedFpm, -VS_ACCEL_FPM_PER_SEC * dt, VS_ACCEL_FPM_PER_SEC * dt);
  let newAlt = ac.altitudeFt + (ac.verticalSpeedFpm / 60) * dt;
  if (guid.altTargetFt !== undefined && guid.vsFpm === undefined) {
    const crossed = (ac.altitudeFt - guid.altTargetFt) * (newAlt - guid.altTargetFt) <= 0;
    if (crossed || Math.abs(newAlt - guid.altTargetFt) < 0.5) {
      newAlt = guid.altTargetFt;
      ac.verticalSpeedFpm = 0;
    }
  }
  ac.altitudeFt = newAlt;

  // Kinematics with wind.
  const air = vScale(headingToVec(ac.headingDeg), ktToMps(ac.airspeedKt));
  const gv = vAdd(air, gustSample.wind);
  ac.pos = vAdd(ac.pos, vScale(gv, dt));
  ac.groundSpeedKt = mpsToKt(Math.hypot(gv.x, gv.y));
  ac.trackDeg = vecToHeading(gv);

  // Touchdown.
  if (g && ac.phase === 'LANDING' && ac.altitudeFt <= g.elevationFt + 0.5) touchdown(ctx, ac, rt, g);
  if (g && ac.phase === 'FINAL' && ac.altitudeFt <= g.elevationFt + 0.5) {
    // Never reached in normal flow (decision point precedes), but never go below the runway.
    ac.altitudeFt = g.elevationFt + 0.5;
  }
}
