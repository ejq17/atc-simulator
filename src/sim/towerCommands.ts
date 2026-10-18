/**
 * Planners for the Tower vocabulary: runway exit instructions, cancel takeoff clearance, traffic information and sequencing,
 * pattern instructions, position reports, frequency change / squawk and airport information.
 *
 * Sources: JO 7110.65 3-10-9 (runway exiting), 3-9-11 (cancellation of takeoff clearance), 3-1-6 and 2-1-21 (traffic information),
 * 7-2-1 (pilot reports traffic in sight), 3-8-1 (sequence/spacing: extend downwind, short approach, number N follow, 360s),
 * 3-10-11 (closed traffic), 3-10-1 / 3-9-1 (landing / departure information), 7-6-11 (squawk VFR, frequency change approved),
 * 5-2-1 (squawk), AIM 4-3-2 / 4-3-3 (traffic pattern legs). See docs/FAA-REFERENCES.md.
 */
import type { Aircraft, Clearance, ParsedCommand, TrafficRef } from './types';
import type { Env, PlanResult } from './commandExecutor';
import { unable } from './commandExecutor';
import { alongCross, crossingRunways, findRunway, findRunwayEnd } from './runways';
import type { RunwayEndGeom } from './runways';
import { bearingDeg, dist, headingDiff, ktToMps, mToNm, nmToM } from './geo';
import { completeClearances, emitEvent, getRuntime, perfOf, setPhase } from './context';
import type { ExitInstruction, SimContext } from './context';
import { MAX_BRAKE_FACTOR, holdShortStopAlong, replanRollout, runwayExits, startClosedTrafficPattern } from './flightDynamics';
import { seeded01 } from './rng';
import { digitsSpoken, spokenRunway, spokenTaxiway } from '../radio/spoken';
import { projectArrival } from './runwayTiming';
import { stoppedExitOptions, stoppedOnRunway } from './runwayStop';
import { computeStopNodes } from './groundMovement';
import { routeSegmentTaxiways } from './pathfinding';

/** `Aircraft.frequencyMhz` of an aircraft that has left every ATC frequency ("frequency change approved", JO 7110.65 7-6-11). The dataset has no advisory frequency for these airports, so none is invented. */
export const NO_FREQUENCY_MHZ = 0;
/** Closest traffic a LUAW instruction must mention (JO 7110.65 3-9-4: "inform it of the closest traffic within 6 flying miles"). */
export const LUAW_TRAFFIC_NM = 6;
/** Seconds in LUAW after which the pilot asks for intentions (JO 7110.65 3-9-4 NOTE: not more than 90 seconds without additional instructions). */
export const LUAW_LIMIT_SEC = 90;
/** An aircraft cannot turn base closer than this to the threshold (AIM 4-3-3: complete the turn to final at least 1/4 mile out; the base leg needs more room). */
export const BASE_NOW_MIN_NM = 0.75;

// ---------------------------------------------------------------------------
// Runway exit (3-10-9)
// ---------------------------------------------------------------------------

const landingPhases = ['FINAL', 'LANDING', 'ROLLOUT'];

export function planExitRunway(env: Env): PlanResult {
  const { ac, rt, cmd, airport, ctx } = env;
  if (stoppedOnRunway(ctx, ac)) return planStoppedExit(env);
  if (!landingPhases.includes(ac.phase)) {
    return unable(env, `${ac.callsign} (${ac.phase}) is not landing; a runway exit instruction applies on final or during the landing roll.`, ac.onGround ? "we're already clear of the runway" : "we're not landing yet", false);
  }
  const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
  if (!g) return unable(env, `${ac.callsign} has no landing runway.`, "we're not landing");
  const instr: ExitInstruction = {
    taxiway: cmd.exitTaxiway, side: cmd.turnDirection, toEnd: cmd.destination === 'END', next: cmd.destination === 'NEXT', ifAble: cmd.ifAble,
  };
  const exits = runwayExits(ctx, g);
  if (instr.taxiway) {
    const onTwy = exits.filter((e) => e.taxiways.some((t) => t.toUpperCase() === instr.taxiway!.toUpperCase()) || e.holds.some((h) => h.taxiways.some((t) => t.toUpperCase() === instr.taxiway!.toUpperCase())));
    if (!onTwy.length) {
      return unable(env, `Taxiway ${instr.taxiway} does not leave runway ${g.runway.id}.`, `we don't see taxiway ${spokenTaxiway(instr.taxiway)} off this runway`);
    }
    if (instr.side && !onTwy.some((e) => e.holds.some((h) => h.side === instr.side))) {
      return unable(env, `Taxiway ${instr.taxiway} does not leave runway ${g.runway.id} to the ${instr.side}.`, `${spokenTaxiway(instr.taxiway)} isn't to the ${instr.side}`);
    }
  } else if (instr.side && !exits.some((e) => e.holds.some((h) => h.side === instr.side))) {
    return unable(env, `Runway ${g.runway.id} has no exit to the ${instr.side}.`, `no exit to the ${instr.side}`);
  }
  // On the ground the exit is checked against the aircraft's speed and position now; on final it is checked at touchdown (the pilot then says "unable").
  let plan: ReturnType<typeof replanRollout> | undefined;
  if (ac.onGround) {
    plan = replanRollout(ctx, ac, rt, g, instr);
    if (plan.honoured === false) {
      return unable(env, `${ac.callsign} cannot make the instructed exit: ${plan.unableReason}.`, `we're too fast to make ${instr.taxiway ? spokenTaxiway(instr.taxiway) : 'that exit'}`, false);
    }
  }
  return {
    plan: {
      patch: { exitTaxiway: instr.taxiway, turnDirection: instr.side, ifAble: instr.ifAble, destination: instr.toEnd ? 'END' : instr.next ? 'NEXT' : undefined },
      commit: () => {
        rt.exit = instr;
        if (ac.onGround && plan) rt.rollout = plan;
      },
    },
  };
}

/**
 * "Turn right at Alpha" / "continue to the end" / "turn left at the next taxiway" to an aircraft that is STOPPED on the runway (it found no exit it
 * could make, or rejected its takeoff): it taxis along the runway to the turnoff the instruction names (JO 7110.65 3-10-9 wording, 3-7-2 for the
 * taxi). The runway stays occupied until the aircraft is clear; an intersecting runway on the way needs its own crossing clearance (3-1-3, 3-7-2):
 * the aircraft stops short of the intersection until it has one.
 */
export function planStoppedExit(env: Env): PlanResult {
  const { ac, rt, cmd, ctx, airport } = env;
  const graph = airport.taxiwayGraph;
  const want = { taxiway: cmd.exitTaxiway ?? (cmd.segment ? cmd.route?.[0] : undefined), side: cmd.turnDirection, toEnd: cmd.destination === 'END', next: cmd.destination === 'NEXT' };
  const all = stoppedExitOptions(ctx, ac);
  if (!all.length) return unable(env, `${ac.callsign} is stopped on runway ${ac.occupyingRunways[0]} with no turnoff ahead of it; taxi it with a route.`, "we don't see an exit ahead of us");
  let pool = all;
  const twy = want.taxiway?.toUpperCase();
  if (twy) {
    pool = pool.filter((o) => o.taxiway.toUpperCase() === twy || (graph.nodes[o.exitNodeId]?.taxiways ?? []).some((t) => t.toUpperCase() === twy));
    if (!pool.length) return unable(env, `There is no taxiway ${want.taxiway} ahead of ${ac.callsign} on runway ${ac.occupyingRunways[0]}.`, `we don't see taxiway ${spokenTaxiway(want.taxiway!)} ahead of us`);
  }
  if (want.side) {
    const bySide = pool.filter((o) => o.side === want.side);
    if (!bySide.length) return unable(env, `Taxiway ${want.taxiway ?? 'exit'} is not to the ${want.side} of ${ac.callsign} ahead on runway ${ac.occupyingRunways[0]}.`, `we can't turn ${want.side} ${twy ? `on ${spokenTaxiway(want.taxiway!)} ` : ''}here`);
    pool = bySide;
  }
  const pick = want.toEnd ? pool[pool.length - 1] : pool[0];
  const nodeIds = pick.nodeIds;
  return {
    plan: {
      patch: { exitTaxiway: pick.taxiway || undefined, turnDirection: want.side, destination: want.toEnd ? 'END' : want.next ? 'NEXT' : undefined },
      commit: () => {
        const stops = new Set(computeStopNodes(graph, nodeIds, ac.runwayAuthorizations));
        stops.add(pick.holdNodeId);
        ac.route = { nodeIds, taxiways: routeSegmentTaxiways(graph, nodeIds).filter((t): t is string => !!t && !t.startsWith('RWY')).slice(-1), stopAtNodeIds: [...stops], progressIndex: 0 };
        releaseRunwayStop(ctx, ac);
        rt.stoppedAtNodeId = undefined;
      },
    },
  };
}

/** The aircraft that was stopped on the runway is under way again: forget the stopped state so it reports "clear of the runway" at the end of its route. */
export function releaseRunwayStop(ctx: SimContext, ac: Aircraft): void {
  const rt = getRuntime(ctx, ac);
  rt.calls.delete('stoppedOnRunway');
  rt.calls.delete('clear');
  rt.lineUp = undefined;
  rt.takeoffCleared = false;
  rt.luawSinceSec = undefined;
  ac.flags.holdingPosition = false;
  // The runways the aircraft stands on are its own to leave (it may be in an intersection): the safety net must not freeze it there.
  for (const rid of ac.occupyingRunways) if (!ac.runwayAuthorizations.includes(rid)) ac.runwayAuthorizations.push(rid);
  if (ac.phase === 'ROLLOUT') setPhase(ctx, ac, 'RUNWAY_EXIT', 'taxi instruction');
  else if (ac.phase === 'LINE_UP_AND_WAIT') setPhase(ctx, ac, 'TAXIING', 'taxi off the runway');
}

/** "Hold short of runway N" during the landing roll or on final: the rollout stops short of that intersecting runway (3-10-9, 3-10-4). */
export function planLandingHoldShort(env: Env): PlanResult | undefined {
  const { ac, rt, cmd, airport, ctx } = env;
  if (!landingPhases.includes(ac.phase)) return undefined;
  const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
  const refs = cmd.holdShort?.length ? cmd.holdShort : [cmd.crossRunwayId ?? cmd.runwayId ?? cmd.runwayEnd!];
  const rw = refs[0] ? findRunway(airport, refs[0]) : undefined;
  if (!g) return undefined;
  if (!rw) return unable(env, `${ac.callsign} has no taxi route yet; a hold short of a taxiway is issued after the aircraft is clear of the runway.`, 'say again after we clear the runway', false);
  if (rw.id === g.runway.id) return unable(env, `${ac.callsign} cannot hold short of its own landing runway ${rw.id}.`, "we're landing on that runway", false);
  const intersects = crossingRunways(airport, g.runway.id).some((r) => r.id === rw.id);
  const from = ac.onGround ? alongCross(g, ac.pos).along : 0;
  const stop = intersects ? holdShortStopAlong(ctx, ac, g, from, rw.id) : undefined;
  // The pilot can only accept it when the aircraft can stop short of the intersecting runway at the maximum braking rate (like the LAHSO
  // check, AIM 4-3-11: the pilot-in-command decides whether the aircraft can stop in the distance available).
  if (stop !== undefined) {
    const perf = perfOf(ac);
    const aMax = ktToMps(perf.decelKtPerSec) * MAX_BRAKE_FACTOR;
    const startAlong = ac.onGround ? from : projectArrival(ctx.state, ac, g).tdAlongM;
    const v = ac.onGround ? ktToMps(ac.groundSpeedKt) : ktToMps(perf.touchdownSpeedKt);
    const need = (v * v) / (2 * aMax);
    if (startAlong + need > stop) {
      return unable(env, `${ac.callsign} (${ac.type}) cannot stop short of runway ${rw.id}: it needs about ${Math.round(need / 0.3048)} ft after ${ac.onGround ? 'its present position' : 'touchdown'} at the maximum braking rate and ${Math.round((stop - startAlong) / 0.3048)} ft remain.`, `we can't hold short of runway ${spokenRunway(rw.id)}`, false);
    }
  }
  return {
    plan: {
      patch: { holdShort: refs },
      commit: () => {
        if (!intersects || stop === undefined) return; // not on the landing runway's path: nothing to stop for during the roll
        rt.exitHoldShort = rw.id;
        if (ac.onGround) rt.rollout = replanRollout(ctx, ac, rt, g);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Cancel takeoff clearance (3-9-11)
// ---------------------------------------------------------------------------

/**
 * Cancel takeoff clearance. Before the roll starts (CLEARED_FOR_TAKEOFF) the aircraft goes back to line-up-and-wait. During the roll the
 * pilot rejects the takeoff when he still can: below the rotation speed (14 CFR 25.107(e)(1)(i): V1 may not exceed VR, so VR, the verified
 * `rotateSpeedKt` of the type, is the latest a decision can be made; the type's V1 is not tabulated in the simulator) AND with enough
 * runway left to stop at the maximum braking rate (`MAX_BRAKE_FACTOR` x the landing deceleration, 1.5 s reaction). Past that point, or airborne,
 * the pilot says so and continues. 3-9-11 NOTE: once the roll has started the clearance is cancelled only for safety; without a reason or a
 * visible hazard the instruction is improper (flagged; refused in training).
 */
export function planCancelTakeoff(env: Env): PlanResult {
  const { ac, rt, cmd, airport, ctx } = env;
  if (!ac.onGround) return unable(env, `${ac.callsign} is airborne; the takeoff clearance can no longer be cancelled.`, "we're airborne, continuing", false);
  if (ac.phase !== 'CLEARED_FOR_TAKEOFF' && ac.phase !== 'TAKEOFF_ROLL') {
    return unable(env, `${ac.callsign} (${ac.phase}) has no takeoff clearance to cancel.`, "we don't have a takeoff clearance", false);
  }
  const rolling = ac.phase === 'TAKEOFF_ROLL';
  let flag: string | undefined;
  if (rolling) {
    const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
    if (g) {
      const perf = perfOf(ac);
      const v = ktToMps(ac.groundSpeedKt);
      const a = ktToMps(perf.decelKtPerSec) * MAX_BRAKE_FACTOR;
      const stopM = v * 1.5 + (v * v) / (2 * a);
      const room = g.lengthM - alongCross(g, ac.pos).along - 60;
      if (ac.airspeedKt >= perf.rotateSpeedKt || stopM > room) {
        return unable(env, `${ac.callsign} is at ${Math.round(ac.airspeedKt)} kt (rotation ${perf.rotateSpeedKt} kt) with ${Math.round(room)} m of runway left and needs about ${Math.round(stopM)} m to stop: the takeoff continues.`, "we're past the point where we can stop, continuing", false);
      }
    }
    const hazard = Object.values(ctx.state.aircraft).some((o) => o.id !== ac.id && o.occupyingRunways.some((r) => ac.occupyingRunways.includes(r)));
    if (!cmd.reason && !hazard) {
      flag = `cancelling the takeoff clearance of ${ac.callsign} after the takeoff roll started, with no reason given and no hazard on the runway (JO 7110.65 3-9-11 NOTE: only for safety, never for traffic management)`;
      if (ctx.state.scenario.mode === 'training') return { reject: { reason: `Not issued (training mode): ${flag}.`, commError: true } };
    }
  }
  return {
    plan: {
      patch: { kind: 'CANCEL_TAKEOFF' as Clearance['kind'] },
      flag,
      commit: () => {
        rt.takeoffCleared = false;
        rt.departureHeading = undefined;
        rt.rollAtSec = undefined;
        completeClearances(ctx, ac, ['TAKEOFF']);
        if (rolling) rt.aborting = true;
        setPhase(ctx, ac, 'LINE_UP_AND_WAIT', rolling ? 'rejected takeoff' : 'takeoff clearance cancelled');
        rt.luawSinceSec = undefined;
        emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'warning', speaker: 'SYSTEM', text: `${ac.callsign} takeoff cancelled${rolling ? ' during the roll' : ''}${cmd.reason ? `: ${cmd.reason}` : ''}`, data: { takeoffCancelled: true, rolling } });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Traffic information, visual sequencing (3-1-6, 2-1-21, 7-2-1, 3-8-1)
// ---------------------------------------------------------------------------

const TYPE_WORDS: Record<string, string> = {
  C172: 'cessna skyhawk 172 one seventy two', C208: 'cessna caravan 208', A320: 'airbus 320 three twenty', B738: 'boeing 737 seven thirty seven',
  B752: 'boeing 757 seven fifty seven', BCS3: 'airbus 220', E175: 'embraer 175 jet', CRJ9: 'bombardier canadair regional jet crj',
};

/** Words a controller might use for this aircraft: its spoken callsign, callsign, and type words. */
function describeWords(ac: Aircraft): string {
  const words = TYPE_WORDS[ac.type] ?? (ac.type.startsWith('B7') ? 'boeing 737' : ac.type.startsWith('A3') ? 'airbus' : '');
  return `${ac.spokenCallsign} ${ac.callsign} ${words}`.toLowerCase();
}

interface TrafficGeometry { position?: TrafficRef['position']; side?: 'left' | 'right'; distanceNm?: number }

/** Where an aircraft is in the pattern / on the runway, in the controller's terms. */
export function trafficGeometry(ctx: SimContext, o: Aircraft): TrafficGeometry {
  const rt = getRuntime(ctx, o);
  const g = findRunwayEnd(ctx.state.airport, o.assignedRunwayEnd);
  if (o.onGround) {
    if (o.phase === 'TAKEOFF_ROLL' || o.phase === 'CLEARED_FOR_TAKEOFF') return { position: 'departing' };
    if (o.phase === 'LINE_UP_AND_WAIT') return { position: 'in_position' };
    if (o.occupyingRunways.length) return { position: 'on_runway' };
    return {};
  }
  if (o.phase === 'INITIAL_CLIMB' || o.phase === 'DEPARTURE' || o.phase === 'GO_AROUND') return { position: 'departing' };
  if (rt.pattern && o.phase === 'PATTERN') {
    const leg = rt.pattern.leg.toLowerCase() as TrafficRef['position'];
    return { position: leg, side: rt.pattern.side };
  }
  if (g) {
    const { along, cross } = alongCross(g, o.pos);
    const d = mToNm(-(along - g.displacedM));
    if ((o.phase === 'FINAL' || o.phase === 'LANDING') || (along < 0 && Math.abs(cross) < nmToM(0.7) && Math.abs(headingDiff(o.headingDeg, g.headingDeg)) < 30)) {
      return { position: 'final', distanceNm: Math.max(0, d) };
    }
  }
  return {};
}

/** The aircraft the controller described (the closest fit among all others), or undefined. */
export function matchTraffic(ctx: SimContext, subject: Aircraft, ref: TrafficRef): Aircraft | undefined {
  const words = ref.desc.split(/\s+/).filter(Boolean);
  let best: { o: Aircraft; score: number } | undefined;
  for (const o of Object.values(ctx.state.aircraft)) {
    if (o.id === subject.id || o.phase === 'PARKED' || o.phase === 'ARRIVED') continue;
    if (words.length) {
      const hay = describeWords(o);
      if (!words.some((w) => hay.includes(w))) continue;
    }
    const geo = trafficGeometry(ctx, o);
    let score = dist(o.pos, subject.pos) / 1000; // km: nearer first
    if (ref.position && ref.position !== 'ahead') {
      if (geo.position !== ref.position) continue;
      if (ref.side && geo.side && geo.side !== ref.side) continue;
      if (ref.distanceNm !== undefined) {
        if (geo.distanceNm === undefined || Math.abs(geo.distanceNm - ref.distanceNm) > 1.6) continue;
        score = Math.abs(geo.distanceNm - ref.distanceNm);
      }
    }
    if (words.length) score -= words.filter((w) => describeWords(o).includes(w)).length * 0.01;
    if (!best || score < best.score) best = { o, score };
  }
  return best?.o;
}

/**
 * Can the pilot see `target`? Range from the visibility (visibilitySm, capped at 10 sm), the bearing from the nose (behind the aircraft
 * it is hard to see), and a seeded chance. Returns the pilot's answer: 'in_sight' now, 'looking' (acquires it a few seconds later) or 'negative'.
 */
export function lookForTraffic(ctx: SimContext, ac: Aircraft, target: Aircraft | undefined): { response: 'in_sight' | 'looking' | 'negative'; acquireInSec: number } {
  if (!target) return { response: 'negative', acquireInSec: 0 };
  const L = ctx.pilotBehaviour.look; // design values (pilotBehaviour.ts)
  const w = ctx.state.weather;
  const rangeM = Math.min(Math.max(w.visibilitySm, 0), L.maxRangeSm) * 1609.344;
  const d = dist(ac.pos, target.pos);
  if (d > rangeM) return { response: 'negative', acquireInSec: 0 };
  const rel = Math.abs(headingDiff(ac.headingDeg, bearingDeg(ac.pos, target.pos)));
  let p = rel <= L.aheadDeg ? L.pAhead : rel <= L.sideDeg ? L.pSide : L.pBehind;
  if (Math.abs(ac.altitudeFt - target.altitudeFt) > L.altDiffFt) p *= L.altFactor;
  if (d > rangeM * L.farShare) p *= L.farFactor;
  const r = seeded01(ac.seed, `look:${target.id}`);
  if (r < p * L.immediateShare) return { response: 'in_sight', acquireInSec: 0 };
  if (r < p) return { response: 'looking', acquireInSec: L.acquireMinSec + L.acquireSpreadSec * seeded01(ac.seed, `acq:${target.id}`) };
  return { response: 'negative', acquireInSec: 0 };
}

export function planTrafficAdvisory(env: Env): PlanResult {
  const { ac, rt, cmd, ctx, now } = env;
  const ref = cmd.traffic!;
  const target = matchTraffic(ctx, ac, ref);
  const look = lookForTraffic(ctx, ac, target);
  return {
    plan: {
      patch: { traffic: ref, trafficResponse: look.response },
      commit: () => {
        rt.lastTrafficAdvisorySec = now;
        if (look.response === 'in_sight' && target) rt.trafficSeen = [...new Set([...(rt.trafficSeen ?? []), target.id])];
        if (look.response === 'looking' && target) rt.trafficLook = { targetId: target.id, sinceSec: now, acquireAtSec: now + look.acquireInSec };
      },
    },
  };
}

const FOLLOW_PHASES = ['INBOUND', 'APPROACH', 'PATTERN', 'FINAL', 'GO_AROUND'];

/** "Number two, follow the Skyhawk on base": the follower must have the traffic in sight (AIM 4-1-?? visual separation, 7110.65 7-2-1); spacing is flown by flightDynamics. */
export function planFollowTraffic(env: Env): PlanResult {
  const { ac, rt, cmd, ctx, now } = env;
  if (ac.onGround || ac.isDeparture && ac.phase !== 'GO_AROUND') return unable(env, `${ac.callsign} (${ac.phase}) is not an arrival that can follow traffic.`, "we're not inbound", false);
  if (!FOLLOW_PHASES.includes(ac.phase)) return unable(env, `${ac.callsign} (${ac.phase}) cannot follow traffic now.`, 'unable to follow now', false);
  const ref = cmd.traffic!;
  const target = matchTraffic(ctx, ac, ref);
  if (!target) return { reject: { reason: `No aircraft matches "${ref.desc || 'the described traffic'}" ${ref.position ?? ''} for ${ac.callsign} to follow.`, pilot: `Negative contact, ${ac.spokenCallsign}`, commError: false } };
  if (target.onGround) return { reject: { reason: `${target.callsign} is on the ground; ${ac.callsign} cannot follow it.`, pilot: `Negative contact, ${ac.spokenCallsign}`, commError: false } };
  const already = rt.trafficSeen?.includes(target.id);
  const look = already ? { response: 'in_sight' as const, acquireInSec: 0 } : lookForTraffic(ctx, ac, target);
  if (look.response !== 'in_sight') {
    if (look.response === 'looking') rt.trafficLook = { targetId: target.id, sinceSec: now, acquireAtSec: now + look.acquireInSec };
    return { reject: { reason: `${ac.callsign} does not have ${target.callsign} in sight yet (${look.response === 'looking' ? 'looking for it' : 'negative contact'}); the instruction to follow needs the traffic in sight (7110.65 7-2-1).`, pilot: `${look.response === 'looking' ? 'Looking for traffic' : 'Negative contact'}, ${ac.spokenCallsign}`, commError: false } };
  }
  return {
    plan: {
      patch: { traffic: ref, sequenceNumber: cmd.sequenceNumber, trafficResponse: 'in_sight' },
      commit: () => {
        rt.trafficSeen = [...new Set([...(rt.trafficSeen ?? []), target.id])];
        rt.follow = { targetId: target.id, sequence: cmd.sequenceNumber };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern instructions (3-8-1, 3-10-11)
// ---------------------------------------------------------------------------

export function planPatternInstruction(env: Env): PlanResult {
  const { ac, rt, cmd, airport, ctx } = env;
  const what = cmd.destination ?? '';
  const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
  const inPattern = !ac.onGround && ac.phase === 'PATTERN' && !!rt.pattern;
  const notInPattern = () => unable(env, `${ac.callsign} (${ac.phase}) is not in the traffic pattern.`, "we're not in the pattern", false);
  const patch: Partial<Clearance> = { destination: what, turnDirection: cmd.turnDirection, turnDegrees: cmd.turnDegrees };
  switch (what) {
    case 'EXTEND_DOWNWIND': {
      if (!inPattern || rt.pattern!.leg !== 'DOWNWIND') return unable(env, `${ac.callsign} is not on the downwind leg.`, "we're not on downwind", false);
      return { plan: { patch, commit: () => { rt.pattern = { ...rt.pattern!, extend: true, short: false }; } } };
    }
    case 'TURN_BASE_NOW': {
      if (!inPattern || !g) return notInPattern();
      if (rt.pattern!.leg !== 'DOWNWIND') return unable(env, `${ac.callsign} is on the ${rt.pattern!.leg.toLowerCase()} leg, not downwind.`, `we're on ${rt.pattern!.leg.toLowerCase()}`, false);
      const along = alongCross(g, ac.pos).along - g.displacedM;
      if (-along < nmToM(BASE_NOW_MIN_NM)) {
        return unable(env, `${ac.callsign} is ${mToNm(Math.max(0, -along)).toFixed(1)} nm past the threshold; a base turn needs at least ${BASE_NOW_MIN_NM} nm so that the turn to final is complete at least 1/4 mile out (AIM 4-3-3).`, "we're too close to turn base now", false);
      }
      return { plan: { patch, commit: () => { rt.pattern = { ...rt.pattern!, extend: false, leg: 'BASE' }; } } };
    }
    case 'SHORT_APPROACH': {
      if (!inPattern) return notInPattern();
      if (rt.pattern!.leg === 'BASE') return unable(env, `${ac.callsign} is already on base.`, "we're already on base", false);
      return { plan: { patch, commit: () => { rt.pattern = { ...rt.pattern!, short: true, extend: false }; } } };
    }
    case 'CIRCLE': {
      if (!inPattern || (rt.pattern!.leg !== 'DOWNWIND' && rt.pattern!.leg !== 'BASE')) return unable(env, `${ac.callsign} is not on downwind or base; a ${cmd.turnDegrees ?? 360}-degree turn is flown in the pattern.`, "we're not on downwind or base", false);
      const dir = cmd.turnDirection ?? 'left';
      return { plan: { patch, commit: () => { rt.pattern = { ...rt.pattern!, circle: { dir, totalDeg: cmd.turnDegrees ?? 360, turnedDeg: 0, lastHeadingDeg: ac.headingDeg } }; } } };
    }
    case 'CLOSED_TRAFFIC': {
      if (ac.onGround && !ac.isDeparture) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground", false);
      const side = cmd.turnDirection ?? rt.pattern?.side ?? rt.closedTraffic?.side ?? 'left';
      return {
        plan: {
          patch,
          commit: () => {
            rt.closedTraffic = { side };
            if (rt.pattern) rt.pattern = { ...rt.pattern, side };
            // already airborne after a departure: join the upwind leg now
            if (!ac.onGround && ac.isDeparture && (ac.phase === 'INITIAL_CLIMB' || ac.phase === 'DEPARTURE') && g) startClosedTrafficPattern(ctx, ac, g, side);
          },
        },
      };
    }
    default:
      return unable(env, `Unknown pattern instruction ${what}.`, 'say again', false);
  }
}

// ---------------------------------------------------------------------------
// Position reports, frequency change approved, squawk, airport information
// ---------------------------------------------------------------------------

export function planReportPosition(env: Env): PlanResult {
  const { ac, rt, cmd } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground", false);
  const kind = cmd.destination === 'REPORT_MIDFIELD_DOWNWIND' ? 'MIDFIELD_DOWNWIND' : cmd.destination === 'REPORT_BASE' ? 'BASE' : 'FINAL';
  return {
    plan: {
      patch: { destination: cmd.destination, distanceNm: cmd.distanceNm },
      commit: () => {
        rt.reports = [...rt.reports.filter((r) => !(r.kind === kind && r.distanceNm === cmd.distanceNm)), { kind, distanceNm: cmd.distanceNm }];
      },
    },
  };
}

/** VFR departures leave the frequency without a handoff (JO 7110.65 7-6-11: "frequency change approved"); counts as handled. */
export function planFrequencyApproved(env: Env): PlanResult {
  const { ac, rt, ctx } = env;
  if (ac.flightPlan?.flightRules === 'IFR' || ac.flightRules === 'IFR') return unable(env, `${ac.callsign} is IFR; hand it to Departure (contact instruction) instead of approving a frequency change.`, 'we need a frequency for departure', false);
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground; frequency change approved applies to airborne VFR aircraft leaving the area.`, "we're still on the ground", false);
  return {
    plan: {
      patch: {},
      commit: () => {
        rt.handedOff = true;
        rt.pendingFreq = { atSec: env.now + 4, mhz: NO_FREQUENCY_MHZ, silent: true };
        completeClearances(ctx, ac, ['CONTACT_FREQUENCY']);
      },
    },
  };
}

export function planSquawk(env: Env): PlanResult {
  const { ac, cmd, ctx } = env;
  const code = cmd.squawk;
  if (!code || !/^[0-7]{4}$/.test(code)) return unable(env, `Invalid squawk code "${code ?? ''}".`, 'say again the squawk code');
  if (['7500', '7600', '7700'].includes(code)) return unable(env, `${code} is a reserved emergency code; ATC does not assign it (JO 7110.65 5-2-1).`, "that's an emergency code, say again the squawk");
  return {
    plan: {
      patch: { squawk: code, destination: cmd.destination },
      commit: () => {
        ac.squawk = code;
        if (ac.flightPlan) ac.flightPlan = { ...ac.flightPlan, squawk: code };
        emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', text: `${ac.callsign} squawking ${code}`, data: { squawk: code } });
      },
    },
  };
}

/** Observed wind (magnetic) and altimeter against what the controller read: the tolerance of a rounded observation. */
export function infoMismatch(ctx: SimContext, info: NonNullable<ParsedCommand['info']>): string | undefined {
  const w = ctx.state.weather;
  const out: string[] = [];
  if (info.altimeterInHg !== undefined && Math.abs(info.altimeterInHg - w.altimeterInHg) > 0.015) out.push(`altimeter ${info.altimeterInHg.toFixed(2)} (observed ${w.altimeterInHg.toFixed(2)})`);
  if (info.calm && w.windSpeedKt > 3) out.push(`wind calm (observed ${w.windSpeedKt} kt)`);
  if (info.windSpeedKt !== undefined && Math.abs(info.windSpeedKt - w.windSpeedKt) > 3) out.push(`wind speed ${info.windSpeedKt} kt (observed ${w.windSpeedKt} kt)`);
  if (info.windDirDeg !== undefined && w.windDirDeg !== 'VRB' && w.windSpeedKt >= 4) {
    const mag = (((w.windDirDeg - ctx.state.airport.magneticVariationDeg) % 360) + 360) % 360;
    if (Math.abs(headingDiff(info.windDirDeg, mag)) > 15) out.push(`wind direction ${info.windDirDeg} (observed ${Math.round(mag)} magnetic)`);
  }
  return out.length ? out.join('; ') : undefined;
}

/** The pilot has the numbers once the controller issued wind / altimeter (3-9-1, 3-10-1). Also records a mismatch. */
export function noteAirportInfo(env: Env): string | undefined {
  const { cmd, rt, ctx } = env;
  if (!cmd.info) return undefined;
  if (!ctx.dryRun) rt.haveNumbers = true;
  return infoMismatch(ctx, cmd.info);
}

export function planAirportInfo(env: Env): PlanResult {
  const mismatch = noteAirportInfo(env);
  return { plan: { patch: { info: env.cmd.info }, flag: mismatch ? `information does not match the current observation: ${mismatch} (JO 7110.65 3-9-1 / 3-10-1)` : undefined, commit: () => undefined } };
}


/**
 * JO 7110.65 3-9-4: "When an aircraft is authorized to LUAW, inform it of the closest traffic within 6 flying miles requesting a
 * full-stop, touch-and-go, stop-and-go, low approach, or option to the same runway." Returns that traffic (or undefined).
 */
export function luawTraffic(ctx: Pick<SimContext, 'state'>, ac: Aircraft, g: RunwayEndGeom): { other: Aircraft; nm: number } | undefined {
  let best: { other: Aircraft; nm: number } | undefined;
  for (const o of Object.values(ctx.state.aircraft)) {
    if (o.id === ac.id || o.onGround) continue;
    if (o.isDeparture && o.phase !== 'GO_AROUND' && o.phase !== 'PATTERN') continue;
    if (!['INBOUND', 'APPROACH', 'FINAL', 'LANDING', 'PATTERN', 'GO_AROUND'].includes(o.phase)) continue;
    const og = findRunwayEnd(ctx.state.airport, o.assignedRunwayEnd);
    if (!og || og.runway.id !== g.runway.id) continue;
    const nm = mToNm(dist(o.pos, og.landingThreshold));
    if (nm <= LUAW_TRAFFIC_NM && (!best || nm < best.nm)) best = { other: o, nm };
  }
  return best;
}

/** The traffic information required with a line-up-and-wait, and whether the instruction (or a traffic advisory just before it) gave it. */
export function luawTrafficIssue(env: Env, g: RunwayEndGeom): string | undefined {
  const { ac, rt, cmd, ctx, now } = env;
  const t = luawTraffic(ctx, ac, g);
  if (!t) return undefined;
  if (cmd.trafficAdvised || (rt.lastTrafficAdvisorySec !== undefined && now - rt.lastTrafficAdvisorySec <= 15)) return undefined;
  return `line up and wait on runway ${g.end.id} without traffic information: ${t.other.callsign} is ${t.nm.toFixed(1)} nm from the threshold for the same runway (JO 7110.65 3-9-4: inform the aircraft of the closest traffic within ${LUAW_TRAFFIC_NM} miles)`;
}

const TYPE_SPOKEN: Record<string, { text: string; spoken: string }> = {
  C172: { text: 'Cessna', spoken: 'Cessna' }, C208: { text: 'Cessna Caravan', spoken: 'Cessna Caravan' },
  A320: { text: 'Airbus 320', spoken: 'Airbus three twenty' }, B738: { text: 'Boeing 737', spoken: 'Boeing seven thirty seven' },
  B752: { text: 'Boeing 757', spoken: 'Boeing seven fifty seven' }, BCS3: { text: 'Airbus 220', spoken: 'Airbus two twenty' },
  E175: { text: 'Embraer 175', spoken: 'Embraer one seventy five' }, CRJ9: { text: 'Regional jet', spoken: 'Regional jet' },
};

/**
 * "Cessna, two mile final" / "Airbus 320, left downwind": how a controller describes `o` in a traffic call (JO 7110.65 3-1-6, 3-9-4), from its
 * type and its place in the pattern / on final. `text` writes digits, `spoken` words (2-4-17).
 */
export function describeTraffic(ctx: Pick<SimContext, 'state'>, o: Aircraft, nm?: number): { text: string; spoken: string } {
  const type = TYPE_SPOKEN[o.type] ?? { text: o.spokenCallsign.split(' ')[0], spoken: o.spokenCallsign.split(' ')[0] };
  const g = findRunwayEnd(ctx.state.airport, o.assignedRunwayEnd);
  const d = nm ?? (g ? mToNm(dist(o.pos, g.landingThreshold)) : 0);
  const n = Math.max(1, Math.round(d));
  const where = ((): string => {
    if (o.phase === 'GO_AROUND') return 'going around';
    if (o.phase === 'PATTERN' && g) {
      // leg from the geometry (the pattern state is engine-private): heading relative to the landing direction, side from the cross offset
      const { cross } = alongCross(g, o.pos);
      const side = cross < 0 ? 'left' : 'right';
      const rel = Math.abs(headingDiff(o.headingDeg, g.headingDeg));
      return `${side} ${rel > 135 ? 'downwind' : rel > 45 ? 'base' : 'upwind'}`;
    }
    return `${n} mile final`;
  })();
  return { text: `${type.text}, ${where}`, spoken: `${type.spoken}, ${where.replace(/^(\d+) mile/, (_m, k: string) => `${digitsSpoken(k)} mile`)}` };
}
