/**
 * Helicopter model: hover, hover taxi / air taxi, vertical lift-off and landing at a helipad, and the descent to a helipad.
 *
 * What is modelled, with the rule it follows:
 *  - Hover taxi: "slow speed above the surface, normally below 20 knots and in ground effect"; air taxi: "normally below 100 feet AGL and at
 *    airspeeds above 20 knots" (JO 7110.65 3-11-1; AIM 4-3-17). Both are GROUND MOVEMENTS ("Taxi, hover taxi, and air taxi operations are considered
 *    to be ground movements ... same conditions, requirements, and practices as apply to other ground taxiing", AIM 4-3-17): the helicopter follows the
 *    same taxiway-graph route, hold-short points and runway authorisations as a taxiing aeroplane (groundMovement.ts) and is lifted to a hover height
 *    (`perf.rotorcraft.hoverAglFt`, 15 ft) or an air-taxi height (`AIR_TAXI_AGL_FT`, 40 ft: below the 100 ft AGL limit) while it moves.
 *  - Takeoff "from present position" (3-11-2 / AIM 4-3-17: "CLEARED FOR TAKEOFF FROM (taxiway, helipad, runway number, etc.)"): vertical rise to a hover,
 *    turn to the departure heading in the hover, then the ordinary airborne model takes over (flightDynamics.ts).
 *  - Landing at a helipad (3-11-6): a direct descent along a 6 degree path to a hover over the pad and a vertical landing. The pilot may refuse nothing:
 *    wind is not applied to hover and approach (simplification).
 * Design values (no source): the 6 degree path, the deceleration of 1.2 m/s2, the 40 ft air-taxi height, the climb-out altitude.
 */
import type { Aircraft, Airport, Vec2 } from './types';
import { bearingDeg, mToNm, clamp, dist, headingDiff, headingToVec, ktToMps, magneticToTrue, mpsToKt, normHeading, vecToHeading, vSub } from './geo';
import { advancePhase, completeClearances, emitEvent, getRuntime, perfOf, pilotSay, setPhase } from './context';
import type { AircraftRuntime, SimContext } from './context';
import { isRotorcraftType } from './performance';
import { HELI_LEVEL_AGL_FT } from './helicopterSeparation';
import type { Env, PlanResult } from './commandExecutor';
import { unable } from './commandExecutor';
import { heliAirTaxiRequestCall, heliDepartureRequestCall, heliInboundCall } from '../radio/specialCalls';
import { holdingShortCrossingCall, checkInCall } from '../radio/readback';
import type { ReadbackEnv } from '../radio/readback';

export type HeliMode = 'IDLE' | 'LIFTOFF' | 'APPROACH' | 'LAND' | 'HOLD' | 'FLY';

export interface HeliRuntime {
  mode: HeliMode;
  /** Moving on the ground graph with the rotor lifted: 'hover' = hover taxi, 'air' = air taxi. Undefined = wheeled ground taxi / on the ground. */
  taxiMode?: 'air' | 'hover';
  /** APPROACH / LAND: the helipad (parking id) or point being landed at. */
  target?: { pos: Vec2; parkingId?: string; name: string };
  /** LIFTOFF: heading to depart on (TRUE) and the turn direction. */
  liftoff?: { headingDeg: number; turn?: 'left' | 'right'; stage: 'UP' | 'TURN' };
}

/** Air-taxi height (ft AGL): "normally below 100 feet AGL" (JO 7110.65 3-11-1); design value. */
export const AIR_TAXI_AGL_FT = 40;
/** Glide path to a helipad (degrees): design value. */
export const HELI_APPROACH_ANGLE_DEG = 6;
const APPROACH_DECEL_MPS2 = 1.2;
/** Within this distance of the pad centre the helicopter stops translating and descends vertically (m). */
const PAD_CAPTURE_M = 6;
/** Climb-out level (ft above the field) after a helicopter lift-off: the helicopter's level of `helicopterSeparation.ts` (400 ft AGL, under the 500 ft AGL helicopter pattern of AIM 4-3-3, 500 ft or more below a 1,000 ft AGL pattern). Design value. */
export const HELI_CLIMBOUT_AGL_FT = HELI_LEVEL_AGL_FT;

export const isRotorcraft = (ac: Pick<Aircraft, 'type'>): boolean => isRotorcraftType(ac.type);

/** The flight-dynamics model must not move this aircraft: the rotorcraft model owns it (hover, lift-off, approach to a pad). */
export function rotorOwnsMotion(rt: AircraftRuntime | undefined): boolean {
  const m = rt?.heli?.mode;
  return m === 'LIFTOFF' || m === 'APPROACH' || m === 'LAND' || m === 'HOLD';
}

/** Hover height (ft AGL) for a ground-movement mode. */
export function liftedAglFt(ac: Aircraft, mode: 'air' | 'hover' | undefined): number {
  if (!mode) return 0;
  return mode === 'hover' ? perfOf(ac).rotorcraft!.hoverAglFt : AIR_TAXI_AGL_FT;
}

/** Ground speed (kt) of a taxi mode: hover taxi stays "below 20 knots" (half the limit), air taxi flies `airTaxiKt` ("above 20 knots"). */
export function taxiSpeedKtFor(ac: Aircraft, rt: AircraftRuntime): number | undefined {
  const r = perfOf(ac).rotorcraft;
  const mode = rt.heli?.taxiMode;
  if (!r || !mode) return undefined;
  return mode === 'hover' ? r.hoverTaxiMaxKt / 2 : r.airTaxiKt;
}

function ensure(rt: AircraftRuntime): HeliRuntime {
  if (!rt.heli) rt.heli = { mode: 'IDLE' };
  return rt.heli;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------------------------------------------

export function updateRotorcraft(ctx: SimContext, dt: number): void {
  for (const ac of Object.values(ctx.state.aircraft)) {
    if (!isRotorcraft(ac)) continue;
    const rt = getRuntime(ctx, ac);
    const h = rt.heli;
    if (!h) continue;
    switch (h.mode) {
      case 'IDLE': settleOnGround(ctx, ac, h, dt); break;
      case 'LIFTOFF': stepLiftoff(ctx, ac, rt, h, dt); break;
      case 'APPROACH': stepApproach(ctx, ac, h, dt); break;
      case 'LAND': stepLand(ctx, ac, rt, h, dt); break;
      case 'HOLD': stepHold(ac, dt); break;
      default: break;
    }
  }
}

/** On the ground graph: rise to the taxi height while moving under a hover / air taxi, settle to the surface afterwards. */
function settleOnGround(ctx: SimContext, ac: Aircraft, h: HeliRuntime, dt: number): void {
  if (!ac.onGround) return;
  const elev = ctx.state.airport.elevationFt;
  const moving = !!ac.route && ac.route.progressIndex < ac.route.nodeIds.length;
  const want = elev + (moving || (h.taxiMode && ac.groundSpeedKt > 0.5) ? liftedAglFt(ac, h.taxiMode) : 0);
  const r = perfOf(ac).rotorcraft!;
  const step = (r.verticalRateFpm / 60) * dt;
  ac.altitudeFt += clamp(want - ac.altitudeFt, -step, step);
  ac.verticalSpeedFpm = Math.abs(want - ac.altitudeFt) < 0.01 ? 0 : Math.sign(want - ac.altitudeFt) * r.verticalRateFpm;
  if (!moving && Math.abs(ac.altitudeFt - elev) < 0.01 && ac.groundSpeedKt < 0.1) h.taxiMode = undefined;
}

function stepLiftoff(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, h: HeliRuntime, dt: number): void {
  const lo = h.liftoff!;
  const r = perfOf(ac).rotorcraft!;
  const elev = ctx.state.airport.elevationFt;
  const hoverTop = elev + r.hoverAglFt;
  ac.groundSpeedKt = 0;
  ac.airspeedKt = 0;
  if (lo.stage === 'UP') {
    ac.altitudeFt = Math.min(hoverTop, ac.altitudeFt + (r.verticalRateFpm / 60) * dt);
    ac.verticalSpeedFpm = r.verticalRateFpm;
    if (ac.altitudeFt >= hoverTop - 1e-6) {
      lo.stage = 'TURN';
      ac.verticalSpeedFpm = 0;
    }
    return;
  }
  const err = headingDiff(ac.headingDeg, lo.headingDeg);
  const max = r.hoverTurnRateDegPerSec * dt;
  if (Math.abs(err) > max) {
    const dir = lo.turn === 'left' ? -1 : lo.turn === 'right' ? 1 : Math.sign(err);
    ac.headingDeg = normHeading(ac.headingDeg + dir * max);
    ac.trackDeg = ac.headingDeg;
    return;
  }
  ac.headingDeg = lo.headingDeg;
  ac.trackDeg = ac.headingDeg;
  // Hand over to the airborne model: climb out on the departure heading.
  h.mode = 'FLY';
  h.liftoff = undefined;
  rt.navMode = 'HEADING';
  rt.takeoffCleared = false;
  ac.target.headingDeg = lo.headingDeg;
  ac.target.altitudeFt = Math.ceil((elev + HELI_CLIMBOUT_AGL_FT) / 50) * 50;
  ac.target.speedKt = undefined;
  setPhase(ctx, ac, 'TAKEOFF_ROLL', 'lift-off');
  setPhase(ctx, ac, 'INITIAL_CLIMB', 'airborne');
  completeClearances(ctx, ac, ['TAKEOFF', 'AIR_TAXI', 'TAXI']);
  emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', text: `${ac.callsign} airborne from the helipad`, data: { airborne: true } });
}

function stepApproach(ctx: SimContext, ac: Aircraft, h: HeliRuntime, dt: number): void {
  const t = h.target!;
  const perf = perfOf(ac);
  const r = perf.rotorcraft!;
  const elev = ctx.state.airport.elevationFt;
  const d = dist(ac.pos, t.pos);
  // speed: down to the approach speed, then a constant-deceleration profile to the pad
  const vNow = ktToMps(ac.airspeedKt);
  const vProfile = Math.sqrt(2 * APPROACH_DECEL_MPS2 * Math.max(0, d - PAD_CAPTURE_M)) + 1.5;
  const vTarget = Math.min(ktToMps(perf.approachSpeedKt), vProfile);
  const dv = clamp(vTarget - vNow, -APPROACH_DECEL_MPS2 * 1.5 * dt, 1.0 * dt);
  const v = Math.max(0, vNow + dv);
  // heading toward the pad
  const want = d > 1 ? vecToHeading(vSub(t.pos, ac.pos)) : ac.headingDeg;
  const err = headingDiff(ac.headingDeg, want);
  const turn = (v < 5 ? r.hoverTurnRateDegPerSec : perf.turnRateDegPerSec) * dt;
  ac.headingDeg = normHeading(ac.headingDeg + clamp(err, -turn, turn));
  const mv = Math.min(v * dt, d);
  const dir = headingToVec(ac.headingDeg);
  ac.pos = { x: ac.pos.x + dir.x * mv, y: ac.pos.y + dir.y * mv };
  ac.airspeedKt = mpsToKt(v);
  ac.groundSpeedKt = ac.airspeedKt;
  ac.trackDeg = ac.headingDeg;
  // descent along the path (never climbs), at most the type's descent rate
  const pathAgl = r.hoverAglFt + (d * Math.tan((HELI_APPROACH_ANGLE_DEG * Math.PI) / 180)) / 0.3048;
  const wantAlt = Math.min(ac.altitudeFt, elev + pathAgl);
  const maxDown = (perf.descentRateFpm / 60) * dt;
  const newAlt = Math.max(wantAlt, ac.altitudeFt - maxDown);
  ac.verticalSpeedFpm = ((newAlt - ac.altitudeFt) / dt) * 60;
  ac.altitudeFt = newAlt;
  if (d <= PAD_CAPTURE_M && v < 3) {
    ac.pos = { x: t.pos.x, y: t.pos.y };
    h.mode = 'LAND';
    if (ac.phase !== 'LANDING') setPhase(ctx, ac, 'LANDING', 'over the pad');
  }
}

function stepLand(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, h: HeliRuntime, dt: number): void {
  const r = perfOf(ac).rotorcraft!;
  const elev = ctx.state.airport.elevationFt;
  ac.airspeedKt = 0;
  ac.groundSpeedKt = 0;
  ac.altitudeFt = Math.max(elev, ac.altitudeFt - (r.verticalRateFpm / 60) * dt);
  ac.verticalSpeedFpm = -r.verticalRateFpm;
  if (ac.altitudeFt <= elev + 1e-6) {
    ac.altitudeFt = elev;
    ac.verticalSpeedFpm = 0;
    ac.onGround = true;
    ac.route = undefined;
    h.mode = 'IDLE';
    h.taxiMode = undefined;
    rt.landingEnd = undefined;
    completeClearances(ctx, ac, ['LAND']);
    setPhase(ctx, ac, 'ARRIVED', 'landed on the helipad');
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', text: `${ac.callsign} landed at ${h.target?.name ?? 'the helipad'}`, data: { landed: true, parkingId: h.target?.parkingId } });
  }
}

/** "Hold position" in the air: the helicopter decelerates to a hover at its altitude. */
function stepHold(ac: Aircraft, dt: number): void {
  const decel = 3 * dt;
  ac.airspeedKt = Math.max(0, ac.airspeedKt - decel);
  const dir = headingToVec(ac.headingDeg);
  const v = ktToMps(ac.airspeedKt);
  ac.pos = { x: ac.pos.x + dir.x * v * dt, y: ac.pos.y + dir.y * v * dt };
  ac.groundSpeedKt = ac.airspeedKt;
  ac.verticalSpeedFpm = 0;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Planners (registered in commandExecutor.PLANNERS)
// ---------------------------------------------------------------------------------------------------------------------------------

/** The helipad / parking position nearest to `pos` (a parking node within 12 m), for "present position" wording and landings. */
export function parkingAt(airport: Airport, pos: Vec2, maxM = 12) {
  let best: { p: Airport['parking'][number]; d: number } | undefined;
  for (const p of airport.parking) {
    const d = dist(p.pos, pos);
    if (d <= maxM && (!best || d < best.d)) best = { p, d };
  }
  return best?.p;
}

/** Takeoff clearance for a helicopter: from its present position (pad, taxiway, hover spot), JO 7110.65 3-11-2. */
export function planHeliTakeoff(env: Env): PlanResult {
  const { ac, rt, cmd, airport, ctx } = env;
  if (ac.phase !== 'PARKED' && ac.phase !== 'READY' && ac.phase !== 'TAXIING' && ac.phase !== 'HOLDING_SHORT') {
    return unable(env, `${ac.callsign} is ${ac.phase}; a helicopter takeoff needs the aircraft on the surface or in a hover.`, "we're not on the ground");
  }
  const headingMag = cmd.headingDeg;
  const headingTrue = headingMag !== undefined ? magneticToTrue(headingMag, airport.magneticVariationDeg) : ac.headingDeg;
  return {
    plan: {
      patch: { turnDirection: cmd.turnDirection, headingDeg: cmd.headingDeg, destination: parkingAt(airport, ac.pos)?.id },
      commit: () => {
        const h = ensure(rt);
        h.mode = 'LIFTOFF';
        h.liftoff = { headingDeg: normHeading(headingTrue), turn: cmd.turnDirection, stage: 'UP' };
        h.taxiMode = undefined;
        ac.route = undefined;
        ac.flags.holdingPosition = false;
        rt.takeoffCleared = true;
        rt.stoppedAtNodeId = undefined;
        ac.onGround = false;
        advancePhase(ctx, ac, 'CLEARED_FOR_TAKEOFF');
        ac.isDeparture = true;
      },
    },
  };
}

/** Landing clearance for a helicopter at a helipad / ramp position (JO 7110.65 3-11-6): direct approach to the pad. */
export function planHeliLand(env: Env): PlanResult {
  const { ac, rt, cmd, airport } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  if (ac.phase !== 'INBOUND' && ac.phase !== 'APPROACH') return unable(env, `${ac.callsign} (${ac.phase}) cannot be cleared to land at a helipad now.`, "we're not inbound");
  const wanted = cmd.destination ?? ac.destination;
  const up = (wanted ?? '').toUpperCase();
  const pad = airport.parking.find((p) => p.id.toUpperCase() === up) ?? (rt.heli?.target?.parkingId ? airport.parking.find((p) => p.id === rt.heli!.target!.parkingId) : undefined);
  if (!pad) return unable(env, `Unknown landing area "${wanted}" for ${ac.callsign}; name a helipad.`, "we can't find that landing area", false);
  return {
    plan: {
      patch: { destination: pad.id },
      commit: () => {
        const h = ensure(rt);
        h.mode = 'APPROACH';
        h.target = { pos: { x: pad.pos.x, y: pad.pos.y }, parkingId: pad.id, name: pad.name };
        rt.landingEnd = undefined;
        rt.navMode = 'HEADING';
        ac.target.speedKt = undefined;
      },
    },
  };
}

/** "Hold position" airborne = hover; on the ground it is the ordinary hold. */
export function planHeliHold(env: Env, groundPlan: () => PlanResult): PlanResult {
  const { ac, rt } = env;
  if (ac.onGround) return groundPlan();
  return {
    plan: {
      patch: {},
      commit: () => {
        const h = ensure(rt);
        h.mode = 'HOLD';
      },
    },
  };
}

/** Does the straight segment a-b cross a runway surface? (ids of the runways, pair ids) */
export function runwaysCrossedBy(airport: Airport, a: Vec2, b: Vec2): string[] {
  const out: string[] = [];
  for (const rw of airport.runways) {
    const poly = rw.polygon;
    for (let i = 0; i < poly.length; i++) {
      if (segmentsIntersect(a, b, poly[i], poly[(i + 1) % poly.length])) {
        out.push(rw.id);
        break;
      }
    }
  }
  return out;
}

function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * Departure / arrival bearing (TRUE) from `from` that keeps the helicopter out of the flow of fixed-wing traffic (AIM 4-3-17: "helicopter operations
 * will be instructed to avoid the flow of fixed-wing aircraft"): the candidate bearing (every 15 degrees, starting from `preferredDeg`) whose
 * straight line of `lengthNm` crosses no extended runway centreline (each runway centreline extended `lengthNm` beyond both thresholds). Undefined: none.
 */
export function clearBearingFrom(airport: Airport, from: Vec2, preferredDeg: number, lengthNm = 6): number | undefined {
  const len = lengthNm * 1852;
  const lines: [Vec2, Vec2][] = airport.runways.map((rw) => {
    const a = rw.ends[0];
    const b = rw.ends[1];
    const dir = headingToVec(a.trueHeadingDeg);
    return [
      { x: a.threshold.x - dir.x * len, y: a.threshold.y - dir.y * len },
      { x: b.threshold.x + dir.x * len, y: b.threshold.y + dir.y * len },
    ];
  });
  for (let k = 0; k < 24; k++) {
    const off = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 15;
    const brg = normHeading(preferredDeg + off);
    const v = headingToVec(brg);
    const end = { x: from.x + v.x * len, y: from.y + v.y * len };
    const crosses = lines.some(([p, q]) => segmentsIntersect(from, end, p, q));
    if (!crosses) return brg;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Pilot calls
// ---------------------------------------------------------------------------------------------------------------------------------

/** Pad name as spoken in a call ("Coast Guard helipad one"). */
export function padSpokenName(name: string): string {
  return name.replace(/^USCG/i, 'Coast Guard');
}

/**
 * Helicopter radio calls (called from updatePilotRequests; returns true when the aircraft spoke or must not make a generic call):
 * the departure request from the pad, the inbound call, the hold-short call of an air taxi that reaches a runway hold line, the check-in after a
 * frequency change.
 */
export function heliPilotCalls(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, env: ReadbackEnv): boolean {
  const { state } = ctx;
  const now = state.clock.timeSec;
  const airport = state.airport;
  const h = ensure(rt);
  // Arrived at the pad it was moved to: the next call is the departure request.
  if (ac.phase === 'PARKED' && rt.special?.mission === 'REPOSITION' && rt.calls.has('heliReady')) {
    const pad = airport.parking.find((p) => p.id === ac.flags.padId);
    if (pad && dist(pad.pos, ac.pos) < 5 && ac.groundSpeedKt === 0 && !ac.route) {
      rt.special.mission = 'DEPARTURE';
      rt.calls.delete('heliReady');
      rt.firstCallAtSec = now + 15;
      ac.frequencyId = 'TWR';
      const twr = airport.frequencies.find((f) => f.position === 'TWR');
      if (twr) ac.frequencyMhz = twr.mhz;
    }
  }
  if (ac.phase === 'PARKED' && ac.isDeparture && rt.special?.mission === 'REPOSITION' && !rt.calls.has('heliReady') && now >= rt.firstCallAtSec) {
    // moving between pads: a ground-movement request ("request air taxi to <pad>")
    rt.calls.add('heliReady');
    const here = parkingAt(airport, ac.pos);
    const there = airport.parking.find((p) => p.id === ac.flags.padId);
    pilotSay(ctx, ac, heliAirTaxiRequestCall(ac, env, { from: padSpokenName(here?.name ?? 'the ramp'), to: padSpokenName(there?.name ?? 'the ramp') }), { request: 'TAXI' });
    setPhase(ctx, ac, 'READY');
    ac.pendingRequest = { kind: 'TAXI', text: `request air taxi to ${there?.name ?? 'the ramp'}`, sinceSec: now };
    return true;
  }
  if (ac.phase === 'PARKED' && ac.isDeparture && !rt.calls.has('heliReady') && now >= rt.firstCallAtSec) {
    rt.calls.add('heliReady');
    const pad = parkingAt(airport, ac.pos);
    const toward = clearBearingFrom(airport, ac.pos, 180) ?? 180;
    const dirWords = cardinalWord(toward);
    pilotSay(ctx, ac, heliDepartureRequestCall(ac, env, { padName: padSpokenName(pad?.name ?? 'the ramp'), direction: dirWords }), { request: 'DEPARTURE' });
    setPhase(ctx, ac, 'READY');
    ac.pendingRequest = { kind: 'DEPARTURE', text: `at ${pad?.name ?? 'the ramp'}, request departure to the ${dirWords}`, sinceSec: now };
    return true;
  }
  if (!ac.onGround && !ac.isDeparture && ac.phase === 'INBOUND' && !rt.calls.has('inbound') && now >= rt.firstCallAtSec) {
    rt.calls.add('inbound');
    const pad = airport.parking.find((p) => p.id === ac.destination) ?? parkingAt(airport, h.target?.pos ?? { x: 0, y: 0 });
    pilotSay(ctx, ac, heliInboundCall(ac, env, {
      distanceNm: mToNm(dist(ac.pos, { x: 0, y: 0 })), bearingFromAirportDeg: bearingDeg({ x: 0, y: 0 }, ac.pos), padName: padSpokenName(rt.special?.padName ?? pad?.name ?? 'the ramp'),
      atisLetter: state.atis.letter,
    }), { request: 'LANDING' });
    ac.pendingRequest = { kind: 'LANDING', text: `inbound for ${rt.special?.padName ?? 'the ramp'}, request landing`, sinceSec: now };
    return true;
  }
  // Air taxi stopped short of a runway: ask to cross.
  if (ac.onGround && rt.stoppedAtNodeId && ac.route && ac.groundSpeedKt < 1) {
    const node = airport.taxiwayGraph.nodes[rt.stoppedAtNodeId];
    if (node.kind === 'holding_position' && node.runwayId && ac.route.stopAtNodeIds.includes(node.id) && !rt.calls.has(`holdX:${node.id}`)) {
      rt.calls.add(`holdX:${node.id}`);
      pilotSay(ctx, ac, holdingShortCrossingCall(ac, env, node.runwayId, node.taxiways[0]), { request: 'CROSSING' });
      ac.pendingRequest = { kind: 'CROSSING', text: `holding short of runway ${node.runwayId}`, sinceSec: now };
      return true;
    }
  }
  if (rt.checkInAtSec !== undefined && now >= rt.checkInAtSec) {
    rt.checkInAtSec = undefined;
    pilotSay(ctx, ac, checkInCall(ac, env, {}), { checkIn: true });
    return true;
  }
  return false;
}

function cardinalWord(deg: number): string {
  const names = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return names[Math.round(normHeading(deg) / 45) % 8];
}

