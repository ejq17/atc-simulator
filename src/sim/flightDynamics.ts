/**
 * Airborne and high-speed ground motion: takeoff roll, climb/descent, bank-limited turns, wind,
 * approach guidance (extended centreline + 3 degree glidepath), flare, touchdown, rollout and runway exit.
 *
 * Units: positions in metres, speeds converted to m/s for integration, altitudes in feet.
 * `ac.target.headingDeg` is a TRUE heading (the executor converts controller magnetic headings).
 */
import type { Aircraft, AircraftPerformance, Vec2, Weather } from './types';
import {
  clamp, deg2rad, dist, headingDiff, headingToVec, ktToMps, mpsToKt, mToFt, nmToM, normHeading, rad2deg,
  vAdd, vDot, vScale, vSub, vecToHeading, bearingDeg,
} from './geo';
import { activeClearance, completeClearances, emitEvent, getRuntime, perfOf, pilotSay, setPhase } from './context';
import type { AircraftRuntime, SimContext } from './context';
import { alongCross, findRunwayEnd } from './runways';
import type { RunwayEndGeom } from './runways';
import { neighborIds, shortestDistances } from './pathfinding';
import { goingAroundCall } from '../radio/readback';

export const GLIDEPATH_DEG = 3;
export const TCH_FT = 50;
const TAN_GP = Math.tan(deg2rad(GLIDEPATH_DEG));
export const DECISION_POINT_M = nmToM(0.5);
const ROLL_ACCEL_DEG_PER_SEC2 = 6;
const VS_ACCEL_FPM_PER_SEC = 600;
const APPROACH_RANGE_NM = 25;

/** Air mass motion vector (m/s) the wind imparts; VRB is treated as calm. */
export function windVector(w: Weather): Vec2 {
  if (w.windDirDeg === 'VRB' || w.windSpeedKt <= 0) return { x: 0, y: 0 };
  const toward = headingToVec(w.windDirDeg + 180);
  return vScale(toward, ktToMps(w.windSpeedKt));
}

/** Distance (nm) before the threshold at which the final approach starts. */
export function finalStartNm(perf: AircraftPerformance): number {
  return perf.category === 'light' ? 4 : 7;
}

/** Glidepath altitude (ft MSL) at `dM` metres before the threshold. */
export function glideAltitudeFt(elevFt: number, dM: number): number {
  return elevFt + TCH_FT + mToFt(dM) * TAN_GP;
}

function departureAltitudeFt(ac: Aircraft, elevFt: number): number {
  const perf = perfOf(ac);
  return Math.round((elevFt + (perf.category === 'light' ? 2000 : 3000)) / 100) * 100;
}

function goAroundAltitudeFt(ac: Aircraft, elevFt: number): number {
  const perf = perfOf(ac);
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
  const wind = windVector(ctx.state.weather);
  const headwindKt = -mpsToKt(vDot(wind, g.dir));
  ac.airspeedKt += perf.accelKtPerSec * dt;
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
    ac.target.altitudeFt = ac.target.altitudeFt ?? departureAltitudeFt(ac, g.elevationFt);
    rt.navMode = 'HEADING';
    rt.takeoffCleared = false;
    rt.lineUp = undefined;
    ac.route = undefined;
    ac.flags.holdingPosition = false;
    completeClearances(ctx, ac, ['TAKEOFF', 'LINE_UP_AND_WAIT', 'TAXI']);
    setPhase(ctx, ac, 'INITIAL_CLIMB', 'airborne');
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} airborne runway ${g.end.id}`, severity: 'info', speaker: 'SYSTEM' });
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

function chooseExit(ctx: SimContext, ac: Aircraft, g: RunwayEndGeom, tdAlong: number, vTd: number): { exitNodeId?: string; holdNodeId?: string } {
  const graph = ctx.state.airport.taxiwayGraph;
  const perf = perfOf(ac);
  const vExit = ktToMps(perf.taxiTurnSpeedKt);
  const brake = ktToMps(perf.decelKtPerSec);
  const stopDist = Math.max(0, (vTd * vTd - vExit * vExit) / (2 * brake));
  const cands: { id: string; along: number; holds: string[] }[] = [];
  for (const id of Object.keys(graph.nodes)) {
    const n = graph.nodes[id];
    if (n.kind !== 'runway' || n.runwayId !== g.runway.id) continue;
    const holds = neighborIds(graph, id).filter((h) => graph.nodes[h].kind === 'holding_position' && graph.nodes[h].runwayId === g.runway.id);
    if (!holds.length) continue;
    cands.push({ id, along: alongCross(g, n.pos).along, holds });
  }
  cands.sort((a, b) => a.along - b.along || (a.id < b.id ? -1 : 1));
  let pick = cands.find((c) => c.along >= tdAlong + stopDist + 30);
  if (!pick) pick = [...cands].reverse().find((c) => c.along >= tdAlong + stopDist * 0.7);
  if (!pick) return {};
  // Prefer the side from which parking is closest by taxi.
  let bestHold = pick.holds[0];
  let bestCost = Infinity;
  for (const h of pick.holds) {
    const dm = shortestDistances(graph, h);
    let c = Infinity;
    for (const p of ctx.state.airport.parking) c = Math.min(c, dm.get(p.nodeId) ?? Infinity);
    if (c < bestCost) {
      bestCost = c;
      bestHold = h;
    }
  }
  return { exitNodeId: pick.id, holdNodeId: bestHold };
}

function touchdown(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, g: RunwayEndGeom): void {
  const wind = windVector(ctx.state.weather);
  const headwindKt = -mpsToKt(vDot(wind, g.dir));
  ac.onGround = true;
  ac.altitudeFt = g.elevationFt;
  ac.verticalSpeedFpm = 0;
  ac.groundSpeedKt = Math.max(20, ac.airspeedKt - headwindKt);
  ac.airspeedKt = ac.groundSpeedKt; // from here on speeds are ground speeds
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
  ac.target = {};
  rt.navMode = 'AUTO';
  rt.turnRateDegPerSec = 0;
  setPhase(ctx, ac, 'ROLLOUT', 'touchdown');
  const perf = perfOf(ac);
  const { along } = alongCross(g, ac.pos);
  const exit = chooseExit(ctx, ac, g, along, ktToMps(ac.groundSpeedKt));
  rt.rollout = { ...exit, exitSpeedMps: ktToMps(perf.taxiTurnSpeedKt) };
  emitEvent(ctx, {
    kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
    text: `${ac.callsign} touched down runway ${g.end.id} ${Math.round(along)} m from threshold`,
    data: { runwayEnd: g.end.id, alongM: along },
  });
}

function stepRollout(ctx: SimContext, ac: Aircraft, dt: number): void {
  const perf = perfOf(ac);
  const rt = getRuntime(ctx, ac);
  const g = findRunwayEnd(ctx.state.airport, ac.assignedRunwayEnd);
  const graph = ctx.state.airport.taxiwayGraph;
  if (!g || !rt.rollout) return;
  const brake = ktToMps(perf.decelKtPerSec);
  let v = ktToMps(ac.groundSpeedKt);
  const exitNode = rt.rollout.exitNodeId ? graph.nodes[rt.rollout.exitNodeId] : undefined;
  const vExit = rt.rollout.exitSpeedMps;
  const { along } = alongCross(g, ac.pos);
  if (exitNode) {
    const d = alongCross(g, exitNode.pos).along - along;
    if (v > vExit) {
      const aReq = d > 1 ? (v * v - vExit * vExit) / (2 * d) : brake;
      v = Math.max(vExit, v - clamp(aReq, 0.5 * brake, brake) * dt);
    }
  } else {
    v = Math.max(0, v - brake * dt);
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
  completeClearances(ctx, ac, ['LAND']);
  if (g) {
    const idx = ac.runwayAuthorizations.indexOf(g.runway.id);
    if (idx >= 0) ac.runwayAuthorizations.splice(idx, 1);
  }
  rt.landingEnd = undefined;
  rt.decisionDone = false;
  rt.calls.delete('gaEst');
  rt.navMode = 'HEADING';
  rt.pattern = undefined;
  ac.target = { headingDeg: g ? g.headingDeg : ac.headingDeg, altitudeFt: goAroundAltitudeFt(ac, elev), speedKt: undefined };
  ac.pendingRequest = undefined;
  emitEvent(ctx, {
    kind: 'GO_AROUND', aircraftId: ac.id, callsign: ac.callsign, severity: 'warning', speaker: 'SYSTEM',
    text: `${ac.callsign} going around runway ${g?.end.id ?? '?'}: ${o.reason}`,
    data: { reason: o.reason, runwayEnd: g?.end.id },
  });
  if (o.announce) {
    pilotSay(ctx, ac, goingAroundCall(ac, { airport: ctx.state.airport }, g?.end.id ?? '', o.reason), { goAround: true });
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
  return Object.values(ctx.state.aircraft).find((o) => o !== ac && o.occupyingRunways.includes(g.runway.id));
}

function approachGuidance(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, g: RunwayEndGeom, perf: AircraftPerformance, wind: Vec2, aglFt: number): Guidance {
  const { along, cross } = alongCross(g, ac.pos);
  const d = -along;
  const startM = nmToM(finalStartNm(perf));
  const distThr = dist(ac.pos, g.end.threshold);
  const base = ac.target.speedKt ?? defaultSpeedKt(ac, perf, aglFt);

  if (ac.phase === 'INBOUND' && distThr < nmToM(APPROACH_RANGE_NM)) setPhase(ctx, ac, 'APPROACH');
  if ((ac.phase === 'APPROACH' || ac.phase === 'PATTERN') && inCaptureZone(g, ac, perf) && d <= startM + 300) {
    setPhase(ctx, ac, 'FINAL', `established runway ${g.end.id}`);
    rt.pattern = undefined;
    rt.decisionDone = false;
    ac.target.altitudeFt = undefined;
  }

  if (ac.phase === 'FINAL' || ac.phase === 'LANDING') {
    // Decision point: landing clearance + runway free, else go around.
    if (ac.phase === 'FINAL' && !rt.decisionDone && d <= DECISION_POINT_M) {
      rt.decisionDone = true;
      const cleared = rt.landingEnd === g.end.id && !!activeClearance(ac, 'LAND');
      const blocker = cleared ? otherOnRunway(ctx, ac, g) : undefined;
      const unstable = Math.abs(cross) > 250 || Math.abs(headingDiff(ac.headingDeg, g.headingDeg)) > 25;
      const reason = !cleared ? 'no landing clearance' : blocker ? 'traffic on the runway' : unstable ? 'unstable approach' : undefined;
      if (reason) initiateGoAround(ctx, ac, { reason, announce: true });
      else setPhase(ctx, ac, 'LANDING', 'cleared to land');
      if (reason) {
        return { desiredHeading: g.headingDeg, altTargetFt: ac.target.altitudeFt, speedKt: perf.climbSpeedKt };
      }
    }
    // Lateral + glidepath.
    const gsMps = Math.max(ktToMps(ac.groundSpeedKt), ktToMps(perf.minSpeedKt * 0.8));
    const vsGp = -mToFt(gsMps * TAN_GP) * 60;
    const glide = glideAltitudeFt(g.elevationFt, d);
    const err = glide - ac.altitudeFt;
    let vs = Math.min(0, vsGp + clamp(err * 5, -400, 400));
    vs = Math.max(vs, -perf.descentRateFpm * 1.3);
    if (aglFt < 30) vs = -(100 + (Math.abs(vsGp) - 100) * clamp(aglFt / 30, 0, 1));
    const rampSpeed = ac.target.speedKt ?? perf.approachSpeedKt;
    const speedKt = perf.touchdownSpeedKt + (rampSpeed - perf.touchdownSpeedKt) * clamp(aglFt / 150, 0, 1);
    return { desiredHeading: centrelineHeading(g, ac, perf, wind), vsFpm: vs, speedKt: Math.min(speedKt, rampSpeed) };
  }

  // INBOUND / APPROACH / PATTERN before the final: fly toward the intercept point, descend gradually.
  let desiredHeading: number;
  let interceptAlt = Math.ceil(glideAltitudeFt(g.elevationFt, startM) / 100) * 100;
  const captured = inCaptureZone(g, ac, perf);
  if (ac.phase === 'PATTERN' && rt.pattern) {
    desiredHeading = patternHeading(g, ac, rt, wind);
    interceptAlt = Math.round((g.elevationFt + 1000) / 100) * 100;
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
      const want = Math.max(interceptAlt, glideAltitudeFt(g.elevationFt, Math.max(distThr, startM)) + 100);
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

function stepAirborne(ctx: SimContext, ac: Aircraft, dt: number): void {
  const perf = perfOf(ac);
  const rt = getRuntime(ctx, ac);
  const g = findRunwayEnd(ctx.state.airport, ac.assignedRunwayEnd);
  const elev = g?.elevationFt ?? ctx.state.airport.elevationFt;
  const agl = ac.altitudeFt - elev;
  const wind = windVector(ctx.state.weather);

  const navPhase = ac.phase === 'INBOUND' || ac.phase === 'APPROACH' || ac.phase === 'FINAL' || ac.phase === 'LANDING' || ac.phase === 'PATTERN';
  let guid: Guidance;
  if (g && navPhase && (rt.navMode === 'AUTO' || ac.phase === 'FINAL' || ac.phase === 'LANDING')) {
    guid = approachGuidance(ctx, ac, rt, g, perf, wind, agl);
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
  const gv = vAdd(air, wind);
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
