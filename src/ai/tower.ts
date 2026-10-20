/**
 * Tower: takeoff / line-up clearances for departures at the hold, landing clearances (or continue / go-around) for arrivals,
 * the handoff of departures to Departure and of landed arrivals to Ground, and a go-around when the runway will not be clear.
 *
 * Every candidate clearance is pre-checked with the engine's own pure `assessClearanceSafety` so the AI never issues
 * (and never logs) a clearance the engine would refuse in training mode or flag outside it. On top of that the AI applies
 * its own, more conservative arrival/departure spacing (`releaseSlackSec`).
 */
import type { Aircraft, Airport } from '../sim/types';
import { AIRBORNE_PROXIMITY_NM, assessClearanceSafety, departureTrailConflict, landedDistanceExceptionApplies, precedingArrivalBlockers, srsMinimumFt } from '../sim/conflicts';
import { projectArrival, timeToThreshold } from '../sim/runwayTiming';
import { COORDINATION_DESIGN, findOpenRequest, releaseNeeded, sameController, validApproval } from '../sim/coordination';
import { findRunwayEnd, isOnFinal } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { frequencyForPosition } from '../radio/frequencies';
import { KT_TO_MPS, ftToM, nmToM, trueToMagnetic } from '../sim/geo';
import { predictedExit } from '../sim/flightDynamics';
import { describeTraffic, luawTraffic } from '../sim/towerCommands';
import { stoppedExitOptionsFor } from '../sim/runwayStop';
import { getPerformance } from '../sim/performance';
import { holdTooShort } from '../sim/holdSelection';
import { hasActive, landingHoldShort, lastClearance, mkCmd } from './core';
import { GAP_REQUEST_WAIT_SEC, GAP_USABLE_WITHIN_SEC, usableWindowSec } from './gap';
import { arrivalWindow, isSequenceable, patternLeg, sequenceDownwind, turnsBaseSoon } from './sequence';
import type { SeqWindow } from './sequence';
import type { Agent, AgentView, Plan } from './core';
import {
  assignedEnd, distToThresholdNm, etaToThresholdSec, holdNodeAt, interactingRunways, isInboundArrival, planParking, projectedGapNm,
} from './world';
import * as say from './phrase';
import { isRotorcraftType, isVehicleType } from '../sim/performance';
import { latestBrakingReport } from '../sim/airportOps';
import { brakingAdvisoriesInEffect, runwayCondition } from '../weather/runwayCondition';
import { runwayHasRvr, rvrForVisibility, rvrPhrase } from '../weather/rvr';

/** RVR and braking action information that goes with a landing clearance (2-8-2, 2-8-3, 3-3-5); empty when neither applies. */
export function landingInfo(v: AgentView, g: RunwayEndGeom): say.Phrase[] {
  const out: say.Phrase[] = [];
  const w = v.state.weather;
  const rvr = rvrForVisibility(w.visibilitySm);
  if (rvr && runwayHasRvr(g.end)) {
    const p = rvrPhrase(g.end.id, rvr);
    out.push({ text: p.display.replace(/\.$/, ''), spoken: p.spoken.replace(/\.$/, '') });
  }
  const reports = v.state.ops?.braking ?? [];
  if (runwayCondition(w).code < 6 && brakingAdvisoriesInEffect(w, reports)) {
    const b = latestBrakingReport(v.state, g.end.id);
    out.push(b
      ? { text: `braking action ${b.term}, reported by ${b.aircraftSpoken}`, spoken: `braking action ${b.term}, reported by ${b.aircraftSpoken}` }
      : { text: `no braking action reports received for runway ${g.end.id}`, spoken: `no braking action reports received for runway ${say.rwy(g.end.id).spoken}` });
  }
  return out;
}

/** Seconds between a takeoff clearance and the pilot starting the roll when the aircraft is still at the hold line (turn onto the runway and align). */
const LINE_UP_DELAY_SEC = 20;
const RELEASE_MARGIN_SEC = 30;
/** A departure waiting longer than this at the hold for a gap makes the pattern traffic that can be delayed leave one. DESIGN VALUE. */
const DEPARTURE_PRIORITY_WAIT_SEC = 30;
/** A crossing request that has waited this long (s) makes the delayable pattern traffic leave a gap of CROSSING_WINDOW_SEC. DESIGN VALUES. */
const CROSSING_PRIORITY_WAIT_SEC = 30;
const CROSSING_WINDOW_SEC = 75;
/** Distance from the threshold beyond which a departure no longer blocks the landing runway for a following arrival (7110.65 3-10-3: 6,000 ft, category III). */
const DEPARTURE_CLEAR_M = 1829;

/** Turn (degrees) from the runway heading of the departure heading given to a follower that would overtake a slower departure. DESIGN VALUE (5-8-3 needs 15; 30 leaves a margin for the wind and the turn). */
const DIVERGE_TURN_DEG = 30;

/** The diverging departure heading (magnetic, rounded to 10) and the turn direction (right: away from the left-hand pattern). */
export function divergingDeparture(airport: Airport, g: RunwayEndGeom): { headingMag: number; turn: 'right' } {
  const rwyMag = trueToMagnetic(g.headingDeg, airport.magneticVariationDeg);
  return { headingMag: ((Math.round((rwyMag + DIVERGE_TURN_DEG) / 10) * 10) % 360 + 360) % 360 || 360, turn: 'right' };
}

/** Times (seconds after the clearance) at which a released departure lifts off and is 6,000 ft from the threshold (the engine's categorical distance). */
export function departureTimes(ac: Aircraft, lined: boolean): { liftoff: number; beyond6000: number } {
  const perf = getPerformance(ac.type);
  const accel = perf.accelKtPerSec * KT_TO_MPS; // m/s^2
  const tRoll = perf.rotateSpeedKt / perf.accelKtPerSec;
  const dRoll = 0.5 * accel * tRoll * tRoll;
  const tClimb = Math.max(0, DEPARTURE_CLEAR_M - dRoll) / (perf.climbSpeedKt * KT_TO_MPS);
  const liftoff = (lined ? 0 : LINE_UP_DELAY_SEC) + 2.5 + tRoll;
  return { liftoff, beyond6000: liftoff + tClimb };
}

/**
 * ... and to line an aircraft up and wait: it may have to sit on the runway for a while (there is no "exit the runway" command), so the
 * arrival must be far enough out that the takeoff is still possible after the line-up and the controller's reaction time.
 */
export const LINEUP_EXTRA_SEC = 90;
/** Landing clearance is given from this distance (nm) in; farther out the pilot hears "continue approach". */
export const LAND_CLEARANCE_NM = 5;
/** Without a landing clearance (or with a blocked runway) an arrival inside this range is sent around. */
export const GO_AROUND_NM = 1.0;
/** ... or within this many seconds of the threshold (the A320 covers 1 nm in 26 s). */
export const GO_AROUND_SEC = 30;
const DEP_HANDOFF_AGL_FT = 400;
/** The exit instruction is not given right after touchdown (JO 7110.65 3-10-9 NOTE): once the aircraft is below this speed on the rollout. */
const EXIT_CALL_MAX_KT = 70;
/** Aircraft in the traffic pattern closer than this to the threshold (nm) block departures. */
const PATTERN_BLOCK_NM = 3.5;

/**
 * Touchdown comes this long (s) after the threshold crossing (flare and float, about 300 m at approach speed). DESIGN VALUE. Until then the arrival is
 * airborne and the engine's near-miss alert (`AIRBORNE_PROXIMITY_NM` / 500 ft) can see it against a departure that is airborne too.
 */
const TOUCHDOWN_AFTER_THRESHOLD_SEC = 8;
/** Lateral margin (nm) added to the near-miss alert distance when the gap to an arrival is projected (the departure's speed between lift-off and climb speed is not modelled). DESIGN VALUE. */
const ALERT_PROJECTION_MARGIN_NM = 0.2;

/** Distance (m) a departure has rolled at lift-off, and its climb speed (m/s). */
function departureProfile(ac: Aircraft): { rollM: number; climbMps: number } {
  const perf = getPerformance(ac.type);
  const accel = perf.accelKtPerSec * KT_TO_MPS;
  const tRoll = perf.rotateSpeedKt / perf.accelKtPerSec;
  return { rollM: 0.5 * accel * tRoll * tRoll, climbMps: perf.climbSpeedKt * KT_TO_MPS };
}

/**
 * Seconds after the release until an arrival of `arrType` flying at `arrKt` must still be short of its threshold for the departure to be released
 * (the smaller `releaseSlackSec` is, the less room). Two conditions, the larger governs:
 *
 *  1. Same runway separation, JO 7110.65 3-9-5 (anticipating separation) with 3-10-3 / 3-9-6: the landing aircraft does not cross the threshold until the
 *     departure is airborne and the categorical distance (`srsMinimumFt`: 3,000 ft light behind light, 4,500 ft, 6,000 ft if either is category III)
 *     down the runway, plus the time the engine's landing check needs to see it (`goAroundSec`: the arrival is sent around inside the larger of 1 nm and
 *     30 s unless the departure is that far ahead by then), `RELEASE_MARGIN_SEC` being the 30 s of it.
 *  2. The engine's near-miss alert (1.5 nm / 500 ft, both aircraft airborne): the gap between the two is linear in time once the departure is airborne
 *     and the arrival has not touched down, so it is smallest at lift-off or at touchdown; both must stay at or above 1.5 nm plus
 *     `ALERT_PROJECTION_MARGIN_NM`. (Before this, a flat 2.4 nm at lift-off was demanded, which is 108 s at 80 kt and fits no gap between arrivals
 *     160 s apart. The rule has no lateral figure at all; this is the engine's alert, not the separation minimum.)
 */
export function neededEtaSec(dep: Aircraft, lined: boolean, arrType: string, arrKt: number): number {
  const t = departureTimes(dep, lined);
  const { rollM, climbMps } = departureProfile(dep);
  const vA = arrKt * KT_TO_MPS;
  const srsM = ftToM(srsMinimumFt(arrType, dep.type));
  const dClimb = Math.max(0, srsM - rollM);
  const goAroundSec = Math.max(RELEASE_MARGIN_SEC, (nmToM(GO_AROUND_NM) / vA));
  const needSrs = t.liftoff + dClimb / climbMps + goAroundSec;
  const alertM = nmToM(AIRBORNE_PROXIMITY_NM + ALERT_PROJECTION_MARGIN_NM);
  const needLiftoff = t.liftoff + Math.max(0, alertM - rollM) / vA;
  const needTouchdown = t.liftoff - TOUCHDOWN_AFTER_THRESHOLD_SEC + Math.max(0, alertM - rollM + vA * TOUCHDOWN_AFTER_THRESHOLD_SEC) / climbMps;
  return Math.max(needSrs, needLiftoff, needTouchdown);
}

/**
 * Smallest "slack" (seconds) over all arrivals that use `end`'s runway or one intersecting it: how much longer than needed the arrival
 * takes to reach its threshold if `dep` is released now (`neededEtaSec`). Negative = releasing the departure would put it too close to an arrival.
 */
export function releaseSlackSec(v: AgentView, end: RunwayEndGeom, dep: Aircraft, lined: boolean): number {
  const rws = interactingRunways(v.airport, end.runway.id);
  let best = Infinity;
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === dep.id || !isInboundArrival(o)) continue;
    const g = assignedEnd(v.airport, o);
    if (!g || !rws.includes(g.runway.id)) continue;
    const d = distToThresholdNm(o, g);
    // Pattern traffic is separated visually by the controller. Aircraft on base or final count with their ETA below. One on downwind that is not about
    // to turn base is the Tower's to delay (sequence.ts extends it when the departure's window is in the way); one about to turn base blocks.
    if (o.phase === 'PATTERN') {
      if (!isSequenceable(o)) {
        if (d < PATTERN_BLOCK_NM) return -Infinity;
      } else {
        const leg = patternLeg(o, g);
        if (leg === 'UPWIND' || leg === 'CROSSWIND') continue;
        if (leg === 'DOWNWIND' && !turnsBaseSoon(o, g)) continue;
      }
    }
    best = Math.min(best, etaToThresholdSec(o, g) - neededEtaSec(dep, lined, o.type, Math.max(o.groundSpeedKt, 60)));
  }
  return best;
}

/** Two arrivals to one runway need at least this many seconds between their threshold crossings (runway occupancy of the leader). */
export const ARRIVAL_RUNWAY_GAP_SEC = 80;

/**
 * An arrival ahead of `ac` on the same runway (or an intersecting one) that has not left the runway yet, or will not have by the
 * time `ac` arrives. The engine only judges a landing clearance against aircraft that are already on the ground.
 */
/** An aircraft that has already gone around this many times gets the next window: it is never sent around for spacing again (DESIGN VALUE). */
export const PRIORITY_GO_AROUNDS = 2;
/** A jet that has been in the approach phase this long (s) without an approach clearance is number one: the light straight-in aircraft in its way join the pattern. DESIGN VALUE. */
export const JET_WAIT_PRIORITY_SEC = 300;
/** ... those whose threshold time is within this many seconds of the jet's (wake turbulence: 4 nm behind an A320 at 65-70 kt is about 210-250 s, 5-5-4 TBL on approach F to I). */
export const JET_CLEAR_WINDOW_SEC = 240;
/** A straight-in light aircraft closer than this to the threshold (nm) is not moved to the pattern for a jet. DESIGN VALUE. */
const STRAIGHT_IN_TO_PATTERN_MIN_NM = 4;

/** The jet (IFR, not light) waiting for its approach clearance that this light straight-in aircraft stands in the way of (within `JET_CLEAR_WINDOW_SEC` of its threshold time). */
export function jetWaitingBehind(v: AgentView, ac: Aircraft, g: RunwayEndGeom): Aircraft | undefined {
  const mine = arrivalWindow(v.state, ac, g).start;
  for (const j of Object.values(v.state.aircraft)) {
    if (j.id === ac.id || j.onGround || j.isDeparture || j.flightRules !== 'IFR' || getPerformance(j.type).category === 'light') continue;
    if (j.phase !== 'APPROACH' && j.phase !== 'INBOUND') continue;
    if (j.assignedRunwayEnd !== g.end.id || j.clearances.some((c) => c.kind === 'APPROACH' && c.completedAtSec === undefined)) continue;
    if (v.now - Math.max(j.spawnedAtSec, j.lastGoAroundSec ?? 0) < JET_WAIT_PRIORITY_SEC) continue;
    if (Math.abs(arrivalWindow(v.state, j, g).start - mine) < JET_CLEAR_WINDOW_SEC) return j;
  }
  return undefined;
}
export const priorityArrival = (ac: Aircraft): boolean => (ac.goAroundCount ?? 0) >= PRIORITY_GO_AROUNDS;

/** 360s for spacing the Tower has given this aircraft since its last go-around. */
const spacingCircles = (ac: Aircraft): number =>
  ac.clearances.filter((c) => c.kind === 'PATTERN_INSTRUCTION' && c.destination === 'CIRCLE' && c.issuedAtSec > (ac.lastGoAroundSec ?? -1)).length;

export function blockedByLeader(v: AgentView, ac: Aircraft, g: RunwayEndGeom): Aircraft | undefined {
  if (priorityArrival(ac)) return undefined;
  const rws = interactingRunways(v.airport, g.runway.id);
  const myEta = etaToThresholdSec(ac, g);
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === ac.id || o.isDeparture) continue;
    const og = assignedEnd(v.airport, o);
    if (!og || !rws.includes(og.runway.id)) continue;
    if (o.onGround) {
      if (o.occupyingRunways.some((r) => rws.includes(r)) && ['LANDING', 'ROLLOUT', 'RUNWAY_EXIT'].includes(o.phase)) return o;
    } else if (isInboundArrival(o) && o.phase !== 'PATTERN' && distToThresholdNm(o, og) < distToThresholdNm(ac, g)) {
      if (myEta - etaToThresholdSec(o, og) < ARRIVAL_RUNWAY_GAP_SEC) return o;
    }
  }
  return undefined;
}

/** A follower established on final inside this range (nm) is sent around as soon as its spacing to the leader is lost (a stable 3-4 nm go-around, well before the runway is blocked). */
export const EARLY_GO_AROUND_NM = 4;
/** Radar minimum in trail on the same final (JO 7110.65 5-5-4); a leader still on the runway counts inside this range too. */
const EARLY_GAP_NM = 3;
/**
 * Two light aircraft on a visual final at a tower-controlled airport are not radar-separated (5-5-4 does not apply): the criterion is 3-10-3 (checked
 * above through `precedingArrivalBlockers`) and the engine's 1.5 nm near-miss alert. At 60-80 kt 3 nm is three minutes, which no single runway can
 * hold with a stream of training and GA arrivals. DESIGN VALUE.
 */
const EARLY_GAP_LIGHT_NM = 2;
/** An aircraft that went around is re-sequenced by Approach (vectors / direct fix, a new approach clearance) for this long before Tower clears it to land again. */
const GO_AROUND_RESEQUENCE_SEC = 600;

/** An aircraft that has gone around and has not been re-cleared for an approach (or re-established on final / in the pattern) since. */
export function awaitingResequence(v: AgentView, ac: Aircraft): boolean {
  const t = ac.lastGoAroundSec;
  if (t === undefined || v.now - t >= GO_AROUND_RESEQUENCE_SEC) return false;
  if (ac.phase === 'FINAL' || ac.phase === 'LANDING' || ac.phase === 'PATTERN') return false;
  return !ac.clearances.some((c) => c.kind === 'APPROACH' && c.issuedAtSec > t);
}

/**
 * Why a follower established on final within `EARLY_GO_AROUND_NM` should go around now, before the near-miss alert fires:
 * the in-trail gap to a leader on the same final is, or at the leader's threshold crossing will be, inside 3 nm; the engine's own
 * 3-10-3 projection says it would cross the threshold before the leader is down and clear; or it will be inside 3 nm of a leader
 * still on the runway.
 */
export function earlyGoAroundReason(v: AgentView, ac: Aircraft, g: RunwayEndGeom): string | undefined {
  if (ac.phase !== 'FINAL' || distToThresholdNm(ac, g) > EARLY_GO_AROUND_NM) return undefined;
  if (priorityArrival(ac)) return undefined; // spacing is never a reason to send it around a third time
  const blockers = precedingArrivalBlockers(v.state, ac, g);
  if (blockers.length) return `${blockers[0].other.callsign} will not be clear of the runway`;
  const mine = distToThresholdNm(ac, g);
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === ac.id || o.isDeparture || o.assignedRunwayEnd !== g.end.id) continue;
    if (!o.onGround) {
      if ((o.phase !== 'FINAL' && o.phase !== 'LANDING') || distToThresholdNm(o, g) >= mine) continue;
      const gap = projectedGapNm(ac, o, g);
      const lights = getPerformance(ac.type).category === 'light' && getPerformance(o.type).category === 'light';
      if (gap.minNm < (lights ? EARLY_GAP_LIGHT_NM : EARLY_GAP_NM)) return `${gap.minNm.toFixed(1)} nm behind ${o.callsign}`;
    } else if (mine <= EARLY_GAP_NM && o.occupyingRunways.includes(g.runway.id) && ['LANDING', 'ROLLOUT', 'RUNWAY_EXIT'].includes(o.phase)) {
      if (timeToThreshold(ac, g) < projectArrival(v.state, o, g).tClear + 3 && !landedDistanceExceptionApplies(v.state, ac, o, g)) return `${o.callsign} is still on the runway`;
    }
  }
  return undefined;
}

/** Landing clearances are held back (down to this distance, nm) while an aircraft has been waiting at a hold line to cross the runway. */
const CROSSING_WINDOW_NM = 1.3;
const CROSSING_WAIT_SEC = 15;

/** An aircraft stands at a hold line asking to cross this runway (Ground will walk it across in the next gap). */
export function crossingWaiting(v: AgentView, g: RunwayEndGeom, exceptId: string): Aircraft | undefined {
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === exceptId || !o.onGround || o.pendingRequest?.kind !== 'CROSSING' || o.groundSpeedKt >= 1) continue;
    if (v.now - o.pendingRequest.sinceSec < CROSSING_WAIT_SEC) continue;
    // (a hold line of an INTERSECTING runway counts too: an aircraft waiting to cross 13/31 needs the same gap in the landings on 4/22, soak seed 3: a crossing that
    // waited twenty minutes because the landing clearances were only held back for the landing runway's own hold lines)
    const rid = holdNodeAt(v.airport, o)?.runwayId;
    if (rid && interactingRunways(v.airport, g.runway.id).includes(rid)) return o;
  }
  return undefined;
}

const stationary = (ac: Aircraft): boolean => ac.groundSpeedKt < 1;
/** A departure that rejected its takeoff and stands on the runway asking what to do (JO 7110.65 3-9-11). */
const stoppedAfterReject = (ac: Aircraft): boolean =>
  ac.isDeparture && ac.onGround && ac.groundSpeedKt < 1 && ac.occupyingRunways.length > 0 && ac.pendingRequest?.kind === 'DEPARTURE' && /rejected takeoff/.test(ac.pendingRequest.text);
const isLinedUp = (ac: Aircraft): boolean => ac.phase === 'LINE_UP_AND_WAIT';

function atDepartureHold(v: AgentView, ac: Aircraft, g: RunwayEndGeom): boolean {
  const h = holdNodeAt(v.airport, ac);
  return !!h && h.runwayId === g.runway.id && (!h.protectsRunwayEnd || h.protectsRunwayEnd.replace(/^0/, '') === g.end.id.replace(/^0/, ''));
}

export function createTowerAgent(): Agent {
  return (v) => {
    const plans: Plan[] = [];
    const { airport, state, mem } = v;
    const safe = (c: ReturnType<typeof mkCmd>) => assessClearanceSafety(state, c).safe;

    // ---- departures on the ground: first come, first served per runway -------------------------------------------------
    const queue: { ac: Aircraft; g: RunwayEndGeom; since: number }[] = [];
    for (const ac of v.onFrequency) {
      if (!ac.isDeparture || !ac.onGround || ac.radioState === 'TRANSMITTING' || isVehicleType(ac.type) || isRotorcraftType(ac.type)) continue;
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
      if (!g) continue;
      if (stoppedAfterReject(ac)) continue; // stopped on the runway after a cancelled takeoff: taxied off below, never re-cleared from where it stands
      const waiting = ac.phase === 'HOLDING_SHORT' && atDepartureHold(v, ac, g);
      const lined = ac.phase === 'LINE_UP_AND_WAIT' && stationary(ac) && ac.occupyingRunways.includes(g.runway.id);
      if (!waiting && !lined) continue;
      // An intersection hold with too little runway for the type is never cleared (the pilot would refuse every time):
      // the aircraft goes back to Ground for a taxi to full length.
      const hold = holdNodeAt(airport, ac);
      if (waiting && hold && holdTooShort(g, hold, ac)) {
        const gnd = v.staffed.has('GND') ? frequencyForPosition(airport, 'GND') : undefined;
        if (gnd) {
          plans.push({
            key: `${ac.id}:short:${hold.id}`, aircraftId: ac.id, callsign: ac.callsign, priority: 55, once: true,
            cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: gnd.id })],
            phrase: say.contact(ac, airport, gnd.id, gnd.mhz), summary: `${ac.callsign}: runway ${g.end.id} too short from ${hold.taxiways[0] ?? 'that intersection'}, back to Ground for full length`,
          });
        }
        continue;
      }
      if (ac.pendingRequest?.request === 'NEED_MINUTE') continue; // "we need a minute": the pilot calls ready again
      const ready = ac.pendingRequest?.kind === 'DEPARTURE' || v.settled(ac) >= 8 || lined;
      if (!ready) continue;
      const k = `hold:${ac.id}`;
      if (!mem.notes.has(k)) mem.notes.set(k, v.now);
      queue.push({ ac, g, since: mem.notes.get(k)! });
    }
    queue.sort((a, b) => (isLinedUp(a.ac) === isLinedUp(b.ac) ? a.since - b.since : isLinedUp(a.ac) ? -1 : 1));
    const firstPerRunway = new Set<string>();
    for (const { ac, g, since } of queue) {
      if (firstPerRunway.has(g.runway.id)) continue;
      firstPerRunway.add(g.runway.id);
      // A follower that would overtake a slower departure on the same track (5-8-3) is given a departure heading that diverges from it (5-8-2, DIVERGE_TURN_DEG), as a
      // controller does, instead of waiting until the leader is 10 nm out (soak: 13-18 % of the time a departure stood at the hold was this).
      const heading = departureTrailConflict(state, ac, g) ? divergingDeparture(airport, g) : undefined;
      const takeoff = mkCmd('TAKEOFF', ac, { runwayEnd: g.end.id, runwayId: g.runway.id, ...(heading ? { departureHeading: heading.headingMag, turnDirection: heading.turn } : {}) });
      const slack = releaseSlackSec(v, g, ac, isLinedUp(ac));
      const ifr = ac.flightPlan?.flightRules === 'IFR';
      const relPos = releaseNeeded(state, 'TWR', ac);
      const takeoffOk = safe(takeoff) && slack >= 0 && !(ifr && !ac.flightPlan?.ifrClearance && state.scenario.mode === 'training');
      // A departure that has waited at the hold with no usable window in the arrival stream: ask Approach for a gap (see gap.ts: 3-8-1 / 3-9-5 / 2-1-14).
      if (ac.phase === 'HOLDING_SHORT' && !takeoffOk && v.now - since >= GAP_REQUEST_WAIT_SEC && v.staffed.has('APP') && !sameController(state, 'TWR', 'APP')) {
        const open = findOpenRequest(state, 'GAP', ac.id);
        const last = [...(state.coordination?.requests ?? [])].reverse().find((r) => r.topic === 'GAP' && r.aircraftId === ac.id);
        const retryOk = !last || last.status === 'pending' || last.status === 'standby' || last.status === 'approved' ? true : v.now - last.createdSec >= COORDINATION_DESIGN.gapRetrySec;
        const askNow = !open ? retryOk : open.status === 'pending' && v.now - open.lastAskSec >= COORDINATION_DESIGN.reaskIntervalSec;
        if (askNow && usableWindowSec(state, airport, g, ac, false) > GAP_USABLE_WITHIN_SEC) {
          const waiting = queue.filter((q) => q.g.runway.id === g.runway.id && q.ac.phase === 'HOLDING_SHORT').length;
          plans.push({
            key: `${ac.id}:gap-ask:${open?.id ?? 'new'}:${open?.asks ?? 0}`, aircraftId: ac.id, callsign: ac.callsign, priority: 62, cmds: [],
            phrase: { text: '', spoken: '' }, cooldownSec: 20, summary: `${ac.callsign}: asking Approach for a gap, runway ${g.end.id}`,
            coord: {
              to: 'APP',
              run: (api) => {
                const req = api.request({ topic: 'GAP', from: 'TWR', to: 'APP', aircraftId: ac.id, runwayId: g.runway.id, runwayEnd: g.end.id, departures: Math.min(3, Math.max(1, waiting)), source: 'ai' });
                const msgs = state.coordination?.messages ?? [];
                return req ? [...msgs].reverse().find((m) => m.requestId === req.id) : undefined;
              },
            },
          });
        }
      }
      // An aircraft that needs a release is not lined up before it has one: lined up, it blocks the runway for the arrivals behind it (they go around) while
      // Departure holds the release because of those go-arounds - a cycle (free-play soak, docs/PROGRESS.md). The release is asked for at the hold line as soon
      // as the line-up itself would be possible.
      // The release is asked for as soon as the departure is first at the hold line, not when a gap happens to be open (soak seed 3, moderate: the release
      // was asked for when the gap opened, lapsed 120 s later because the lander ahead was still rolling out, and the next request came 740 s later, when a gap
      // happened to open at the same moment as an empty runway). It is renewed when it has `releaseRenewBeforeSec` left and the departure still waits, so that
      // the takeoff clearance is not held up for lack of it when the gap comes. JO 7110.65 4-3-4 / the LOA: the release is Departure's, it does not depend on the
      // runway being free; 3-9-5 and 3-9-6 are applied when the takeoff clearance is given (`takeoffOk`).
      const held = validApproval(state, 'RELEASE', ac.id);
      const renewDue = !!held && ac.phase === 'HOLDING_SHORT' && !takeoffOk && held.expiresSec !== undefined && held.expiresSec - v.now <= COORDINATION_DESIGN.releaseRenewBeforeSec;
      const wantRelease = !!relPos && ((!held && (takeoffOk || ac.phase === 'HOLDING_SHORT')) || renewDue);
      if (wantRelease && relPos) {
        // The takeoff would be possible, but Departure/Approach has not released the aircraft (LOA concept, 7110.65 4-3-4): ask, and keep
        // asking every reask interval until it is answered. The aircraft simply stays at the hold line meanwhile.
        const open = findOpenRequest(state, 'RELEASE', ac.id);
        if (!open || (open.status === 'pending' && v.now - open.lastAskSec >= COORDINATION_DESIGN.reaskIntervalSec) || (renewDue && open.status === 'approved')) {
          plans.push({
            key: `${ac.id}:rel-ask:${open?.id ?? 'new'}:${open?.asks ?? 0}`, aircraftId: ac.id, callsign: ac.callsign, priority: 79, cmds: [],
            phrase: { text: '', spoken: '' }, cooldownSec: 20, summary: `${ac.callsign}: asking ${relPos} for the release`,
            coord: {
              to: relPos,
              run: (api) => {
                const req = api.request({ topic: 'RELEASE', from: 'TWR', to: relPos, aircraftId: ac.id, runwayId: g.runway.id, source: 'ai', renew: renewDue });
                const msgs = state.coordination?.messages ?? [];
                return req ? [...msgs].reverse().find((m) => m.requestId === req.id) : undefined;
              },
            },
          });
        }
      } else if (takeoffOk) {
        plans.push({
          key: `${ac.id}:takeoff`, aircraftId: ac.id, callsign: ac.callsign, priority: 80, cmds: [takeoff],
          phrase: heading ? say.clearedForTakeoffHeading(ac, g.end.id, heading.headingMag, heading.turn) : say.clearedForTakeoff(ac, g.end.id, ifr), cooldownSec: 20,
          summary: `${ac.callsign} cleared for takeoff runway ${g.end.id}${heading ? `, turn ${heading.turn} heading ${heading.headingMag} (diverging from the departure ahead)` : ''}`,
        });
      } else if (ac.phase === 'HOLDING_SHORT' && slack >= LINEUP_EXTRA_SEC && !(relPos && !validApproval(state, 'RELEASE', ac.id))) {
        // JO 7110.65 3-9-4: the aircraft authorised to line up and wait is told about the closest traffic within 6 miles for the same runway.
        const near = luawTraffic({ state }, ac, g);
        const luaw = mkCmd('LINE_UP_AND_WAIT', ac, { runwayEnd: g.end.id, runwayId: g.runway.id, ...(near ? { trafficAdvised: true } : {}) });
        if (safe(luaw)) {
          plans.push({
            key: `${ac.id}:luaw`, aircraftId: ac.id, callsign: ac.callsign, priority: 60, cmds: [luaw],
            phrase: near ? say.lineUpAndWaitTraffic(ac, g.end.id, describeTraffic({ state }, near.other, near.nm)) : say.lineUpAndWait(ac, g.end.id), cooldownSec: 20, once: true,
            summary: `${ac.callsign} line up and wait runway ${g.end.id}`,
          });
        }
      }
    }

    // ---- pattern sequence: extend downwind / turn base (sequence.ts) -------------------------------------------------------
    for (const endId of state.activeRunways.landing) {
      const g = findRunwayEnd(airport, endId);
      if (!g) continue;
      const rws = interactingRunways(airport, g.runway.id);
      const depWindows: SeqWindow[] = [];
      for (const o of Object.values(state.aircraft)) {
        if (!o.isDeparture || !o.onGround || (o.phase !== 'CLEARED_FOR_TAKEOFF' && o.phase !== 'TAKEOFF_ROLL')) continue;
        if (!o.occupyingRunways.some((r) => rws.includes(r)) && o.phase !== 'CLEARED_FOR_TAKEOFF') continue;
        depWindows.push({ start: 0, end: departureTimes(o, o.occupyingRunways.length > 0).beyond6000 });
      }
      // Aircraft waiting at a hold line to cross one of these runways get a window too (Ground asks, `crossingDecision` approves when no arrival is inside
      // CROSSING_ARRIVAL_SEC): the pattern traffic that can be delayed does not take every gap. DESIGN VALUE: 75 s to walk across, plus the sequencer's margin.
      for (const o of Object.values(state.aircraft)) {
        if (!o.onGround || o.groundSpeedKt >= 1 || o.pendingRequest?.kind !== 'CROSSING' || v.now - o.pendingRequest.sinceSec < CROSSING_PRIORITY_WAIT_SEC) continue;
        const rid = holdNodeAt(airport, o, 45)?.runwayId;
        if (rid && rws.includes(rid)) {
          depWindows.push({ start: 0, end: CROSSING_WINDOW_SEC });
          break;
        }
      }
      // A departure that has waited for a gap this long gets one: the pattern traffic that could be delayed is (the window stays free of landings that
      // can still be moved), instead of filling every gap between two landings. DESIGN VALUE.
      for (const o of v.onFrequency) {
        if (!o.isDeparture || !o.onGround || (o.phase !== 'HOLDING_SHORT' && o.phase !== 'LINE_UP_AND_WAIT') || !rws.includes(findRunwayEnd(airport, o.assignedRunwayEnd)?.runway.id ?? '')) continue;
        const since = mem.notes.get(`hold:${o.id}`);
        // (a departure that holds its release has the next window at once: Departure released it for this gap, 4-3-4; the pattern traffic that can be delayed gives way, 3-8-1 / 3-9-5)
        if (!validApproval(state, 'RELEASE', o.id) && !validApproval(state, 'GAP', o.id) && (since === undefined || v.now - since < DEPARTURE_PRIORITY_WAIT_SEC)) continue;
        // (the window is as long as the takeoff clearance needs behind the slowest arrival: the lined-up departure of soak seed 13 stood on the runway for 8 minutes because the
        // aircraft the sequencer let turn base were inside `neededEtaSec` when it was done, so every one of them went around - an F-16 and a Cessna five times)
        const lined = o.phase === 'LINE_UP_AND_WAIT';
        depWindows.push({ start: 0, end: Math.max(departureTimes(o, lined).beyond6000 + RELEASE_MARGIN_SEC, neededEtaSec(o, lined, 'C172', getPerformance('C172').approachSpeedKt)) });
        break;
      }
      for (const dec of sequenceDownwind(state, g, depWindows)) {
        const ac = dec.ac;
        if (!v.onFrequency.some((o) => o.id === ac.id) || ac.radioState === 'TRANSMITTING') continue;
        if (dec.action === 'extend') {
          plans.push({
            key: `${ac.id}:extend:${ac.spawnedAtSec}:${ac.lastGoAroundSec ?? 0}`, aircraftId: ac.id, callsign: ac.callsign, priority: 70, once: true,
            cmds: [mkCmd('PATTERN_INSTRUCTION', ac, { destination: 'EXTEND_DOWNWIND' })], phrase: say.extendDownwind(ac),
            summary: `${ac.callsign} extend downwind runway ${g.end.id} (landing sequence)`,
          });
        } else if (dec.action === 'release') {
          plans.push({
            key: `${ac.id}:base-now`, aircraftId: ac.id, callsign: ac.callsign, priority: 71, cooldownSec: 20,
            cmds: [mkCmd('PATTERN_INSTRUCTION', ac, { destination: 'TURN_BASE_NOW' })], phrase: say.turnBaseNow(ac),
            summary: `${ac.callsign} turn base now runway ${g.end.id} (landing sequence)`,
          });
        }
      }
    }

    // ---- everything else on the frequency --------------------------------------------------------------------------------
    for (const ac of v.onFrequency) {
      if (ac.radioState === 'TRANSMITTING') continue;
      if (isVehicleType(ac.type) || isRotorcraftType(ac.type)) continue; // special.ts
      const pending = ac.pendingRequest?.kind;
      const ready = pending !== undefined || v.settled(ac) >= 4;

      // A pilot who did not report the ATIS asks for the numbers (3-9-1 / 3-10-1): wind and altimeter from the observation.
      if (ac.pendingRequest?.kind === 'OTHER' && /wind and altimeter/.test(ac.pendingRequest.text)) {
        const w = state.weather;
        const magDir = w.windDirDeg === 'VRB' ? undefined : (Math.round(trueToMagnetic(w.windDirDeg, airport.magneticVariationDeg) / 10) * 10 + 360) % 360 || 360;
        plans.push({
          key: `${ac.id}:info`, aircraftId: ac.id, callsign: ac.callsign, priority: 88, once: true,
          cmds: [mkCmd('AIRPORT_INFO', ac, { info: { ...(w.windSpeedKt === 0 ? { calm: true } : { windSpeedKt: w.windSpeedKt, ...(magDir !== undefined ? { windDirDeg: magDir } : {}) }), altimeterInHg: Math.round(w.altimeterInHg * 100) / 100 } })],
          phrase: say.airportInfo(ac, magDir, w.windSpeedKt, w.altimeterInHg), summary: `${ac.callsign} wind and altimeter`,
        });
        continue;
      }

      // An exit arranged with Ground over the landline (3-1-4: "have Spirit ten thirty three exit left at Charlie", "hold short of runway four after
      // landing"): the instruction goes to the pilot now, on final or on the roll (3-10-9). The coordination agent answered the request already.
      const exitReq = !ac.isDeparture && (ac.phase === 'FINAL' || ac.phase === 'LANDING' || ac.phase === 'ROLLOUT') ? findOpenRequest(state, 'EXIT', ac.id) : undefined;
      if (exitReq && exitReq.status === 'approved' && exitReq.to === v.position && hasActive(ac, 'LAND')) { // (the landing clearance goes first)
        const cmds = [
          ...(exitReq.point || exitReq.exitSide ? [mkCmd('EXIT_RUNWAY', ac, { exitTaxiway: exitReq.point, turnDirection: exitReq.exitSide })] : []),
          ...(exitReq.holdShortRunwayId ? [mkCmd('HOLD_SHORT', ac, { holdShort: [exitReq.holdShortRunwayId], runwayId: exitReq.holdShortRunwayId })] : []),
        ];
        if (cmds.length) {
          plans.push({
            key: `${ac.id}:exit-req:${exitReq.id}`, aircraftId: ac.id, callsign: ac.callsign, priority: 69, once: true, cmds,
            phrase: say.exitInstruction(ac, { taxiway: exitReq.point, side: exitReq.exitSide, holdShortRunway: exitReq.holdShortRunwayId }),
            summary: `${ac.callsign} ${[exitReq.point || exitReq.exitSide ? `turn ${exitReq.exitSide ?? ''} at ${exitReq.point ?? 'the exit'}`.replace(/ +/g, ' ') : '', exitReq.holdShortRunwayId ? `hold short of runway ${exitReq.holdShortRunwayId}` : ''].filter(Boolean).join(', ')} (asked by Ground)`,
          });
          continue;
        }
      }

      // Arrival rolling out with Ground staffed: the exit and the frequency change in one transmission (3-10-9 example); the aircraft changes once clear.
      // (not for a touch-and-go / option: the aircraft is about to take off again, 3-8-2)
      const landDest = lastClearance(ac, 'LAND')?.destination;
      const goesAgain = landDest === 'touch_and_go' || landDest === 'option' || landDest === 'stop_and_go' || landDest === 'low_approach';
      if (!ac.isDeparture && ac.onGround && ac.phase === 'ROLLOUT' && !goesAgain && v.staffed.has('GND') && ac.groundSpeedKt <= EXIT_CALL_MAX_KT && !hasActive(ac, 'EXIT_RUNWAY')) {
        const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
        const gnd = frequencyForPosition(airport, 'GND');
        const ex = g ? predictedExit(state, ac, g, undefined, landingHoldShort(ac)) : undefined;
        if (g && gnd && ex) {
          plans.push({
            key: `${ac.id}:exit-gnd`, aircraftId: ac.id, callsign: ac.callsign, priority: 56, once: true,
            cmds: [mkCmd('EXIT_RUNWAY', ac, { exitTaxiway: ex.taxiway, turnDirection: ex.side }), mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: gnd.id })],
            phrase: say.exitAndContact(ac, airport, ex.taxiway, ex.side, gnd.id, gnd.mhz),
            summary: `${ac.callsign} turn ${ex.side} at ${ex.taxiway}, contact Ground${ex.wrongSide ? ' (the only exit it can make is on the far side of the runway from its parking)' : ''}${ex.blockedBy ? ` (taxiway occupied by ${ex.blockedBy})` : ''}`,
          });
          continue;
        }
      }

      // An arrival stopped on the runway ("unable to exit, request taxi instructions"): the nearest turnoff ahead, across the intersecting runway
      // when that is clear, and the frequency change, as after a normal landing (JO 7110.65 3-10-9, 3-7-2, 3-1-3). Departures are held meanwhile (runway occupied).
      if ((!ac.isDeparture && ac.onGround && ac.groundSpeedKt < 1 && ac.occupyingRunways.length > 0 && pending === 'OTHER' && /stopped on runway/.test(ac.pendingRequest?.text ?? '')) || stoppedAfterReject(ac)) {
        const gnd = v.staffed.has('GND') ? frequencyForPosition(airport, 'GND') : undefined;
        let issued = false;
        for (const o of stoppedExitOptionsFor(state, ac)) {
          const crossCmds = o.crosses.map((rid) => mkCmd('CROSS_RUNWAY', ac, { crossRunwayId: rid, runwayId: rid }));
          if (!crossCmds.every((c) => safe(c))) continue;
          plans.push({
            key: `${ac.id}:stopped-exit:${o.holdNodeId}`, aircraftId: ac.id, callsign: ac.callsign, priority: 57, cooldownSec: 20,
            cmds: [mkCmd('EXIT_RUNWAY', ac, { exitTaxiway: o.taxiway, turnDirection: o.side }), ...crossCmds, ...(gnd ? [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: gnd.id })] : [])],
            phrase: say.stoppedExit(ac, airport, o.taxiway, o.side, o.crosses, gnd ? { frequencyId: gnd.id, mhz: gnd.mhz } : undefined),
            summary: `${ac.callsign} stopped on the runway: ${o.crosses.length ? `cross runway ${o.crosses.join(', ')}, ` : ''}turn ${o.side} at ${o.taxiway}`,
          });
          issued = true;
          break;
        }
        if (!issued) {
          // no turnoff ahead: a taxi with a route from where it stands (the engine searches ahead first, then back-taxi)
          plans.push({
            key: `${ac.id}:stopped-taxi`, aircraftId: ac.id, callsign: ac.callsign, priority: 57, cooldownSec: 20,
            cmds: [mkCmd('TAXI_TO_PARKING', ac, { destination: 'RAMP' })], phrase: say.taxiToParking(ac, { id: 'RAMP', category: 'ga' }, [], []),
            summary: `${ac.callsign} stopped on the runway, no turnoff ahead: taxi to the ramp`,
          });
        }
        continue;
      }

      // A departure on the ground that asks for taxi or pushback on Tower's frequency (a pilot who took another aircraft's frequency change, a call that went to the
      // wrong frequency): Tower works aircraft at the runway, not at the gate. Back to Ground (3-7-2 is Ground's); nobody else would answer it, soak seed 4.
      if (ac.isDeparture && ac.onGround && (ac.pendingRequest?.kind === 'TAXI' || ac.pendingRequest?.kind === 'PUSHBACK') && ac.occupyingRunways.length === 0 && !holdNodeAt(airport, ac, 60) && v.staffed.has('GND')) {
        const gnd = frequencyForPosition(airport, 'GND');
        if (gnd) {
          plans.push({
            key: `${ac.id}:misrouted-to-gnd`, aircraftId: ac.id, callsign: ac.callsign, priority: 54, cooldownSec: 60,
            cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: gnd.id })],
            phrase: say.contact(ac, airport, gnd.id, gnd.mhz), summary: `${ac.callsign} is not at a runway, back to Ground`,
          });
          continue;
        }
      }

      // Departures that are airborne: handoff to Departure (IFR: the sector frequency of the clearance).
      if (ac.isDeparture && !ac.onGround && (ac.phase === 'INITIAL_CLIMB' || ac.phase === 'DEPARTURE') && ac.altitudeFt - airport.elevationFt >= DEP_HANDOFF_AGL_FT) {
        if (!(v.staffed.has('DEP') || v.staffed.has('APP'))) continue;
        const dep = frequencyForPosition(airport, 'DEP') ?? frequencyForPosition(airport, 'APP');
        const mhz = ac.flightPlan?.ifrClearance?.departureFrequencyMhz ?? dep?.mhz;
        if (!dep || mhz === undefined) continue;
        plans.push({
          key: `${ac.id}:to-dep`, aircraftId: ac.id, callsign: ac.callsign, priority: 55,
          cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: dep.id })],
          phrase: say.contact(ac, airport, dep.id, mhz), cooldownSec: 30, summary: `${ac.callsign} handed to Departure`,
        });
        continue;
      }

      // Arrivals after landing, clear of the runway: Ground (or taxi them ourselves when nobody works Ground).
      if (!ac.isDeparture && ac.onGround && ac.phase === 'RUNWAY_EXIT' && ac.occupyingRunways.length === 0 && (pending || ac.groundSpeedKt < 1) && v.settled(ac) >= 3) {
        if (v.staffed.has('GND')) {
          const gnd = frequencyForPosition(airport, 'GND');
          if (gnd) {
            plans.push({
              key: `${ac.id}:to-gnd`, aircraftId: ac.id, callsign: ac.callsign, priority: 55,
              cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: gnd.id })],
              phrase: say.contact(ac, airport, gnd.id, gnd.mhz), cooldownSec: 30, summary: `${ac.callsign} handed to Ground`,
            });
          }
        } else if (!hasActive(ac, 'TAXI_TO_PARKING') && ac.groundSpeedKt < 1) {
          const p = planParking(state, ac);
          if (p) {
            plans.push({
              key: `${ac.id}:to-parking`, aircraftId: ac.id, callsign: ac.callsign, priority: 50,
              cmds: [mkCmd('TAXI_TO_PARKING', ac, { destination: p.spot.id, route: p.via, holdShort: p.holdShort })],
              phrase: say.taxiToParking(ac, p.spot, p.via, p.holdShort), summary: `${ac.callsign} taxi to ${p.spot.name}`,
            });
          }
        }
        continue;
      }

      // A pilot asks for the runway lights up or down (free play, night / low visibility): the AI grants it (3-4-10 d).
      const lightsAsk = ac.pendingRequest?.kind === 'OTHER' ? /^request lights (up|down)/.exec(ac.pendingRequest.text) : null;
      if (lightsAsk && !ac.onGround && !ac.isDeparture) {
        const dir = lightsAsk[1] as 'up' | 'down';
        plans.push({
          key: `${ac.id}:lights:${dir}`, aircraftId: ac.id, callsign: ac.callsign, priority: 45, once: true,
          cmds: [mkCmd('RUNWAY_LIGHTS', ac, { lightsDirection: dir === 'up' ? 'UP' : 'DOWN' })], phrase: say.lightsAnswer(ac, dir), summary: `${ac.callsign} runway lights ${dir}`,
        });
      }

      if (ac.onGround || ac.isDeparture) continue;

      // Missed approach / go-around that reached the Tower frequency.
      if (ac.phase === 'GO_AROUND' || (ac.phase === 'HOLDING' && !ac.isDeparture)) {
        if (!ready) continue;
        const ifr = ac.flightPlan?.flightRules === 'IFR';
        if (ifr && v.staffed.has('APP')) {
          const app = frequencyForPosition(airport, 'APP');
          if (app) {
            plans.push({
              key: `${ac.id}:ga-to-app`, aircraftId: ac.id, callsign: ac.callsign, priority: 55,
              cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: app.id })],
              phrase: say.contact(ac, airport, app.id, app.mhz), cooldownSec: 30, summary: `${ac.callsign} missed approach, to Approach`,
            });
          }
        } else if (!ifr && (pending === 'LANDING' || pending === undefined) && ac.assignedRunwayEnd) {
          // (IFR with nobody on Approach is re-sequenced by the Approach agent that Tower runs then; see controllers.ts.)
          // After a runway change the pattern re-entry is for the runway now in use, not the one the go-around was flown from.
          const active = state.activeRunways.landing;
          const end = active.includes(ac.assignedRunwayEnd) || !active.length ? ac.assignedRunwayEnd : active[0];
          plans.push({
            key: `${ac.id}:pattern`, aircraftId: ac.id, callsign: ac.callsign, priority: 50,
            cmds: [mkCmd('ENTER_PATTERN', ac, { runwayEnd: end, patternLeg: 'left_downwind' })],
            phrase: say.enterPattern(ac, end, 'left downwind'), cooldownSec: 30, summary: `${ac.callsign} left downwind runway ${end}`,
          });
        }
        continue;
      }

      // Arrivals to land. An overhead maneuver is cleared to land only after the break (JO 7110.65 3-10-12 examples).
      if (!isInboundArrival(ac) || ac.phase === 'LANDING') continue;
      if (ac.flags.overhead && ac.flags.overhead !== 'BROKE') continue;
      const g = assignedEnd(airport, ac);
      if (!g) continue;
      // A pattern aircraft is cleared to land once it is on base or final: on downwind its place in the landing sequence is not settled (sequence.ts).
      if (isSequenceable(ac)) {
        const leg = patternLeg(ac, g);
        if (leg !== 'BASE' && leg !== 'FINAL') continue;
      }
      const d = distToThresholdNm(ac, g);
      // Flight training: touch-and-go while circuits remain (the pilot's request), a full stop on the last one.
      const touchGo = !!ac.flags.training && (ac.flags.circuits ?? 0) > 1;
      const land = mkCmd('LAND', ac, { runwayEnd: g.end.id, runwayId: g.runway.id, ...(touchGo ? { destination: 'touch_and_go' } : {}) });
      const landAssess = assessClearanceSafety(state, land);
      const ahead = blockedByLeader(v, ac, g);
      const landSafe = landAssess.safe && !ahead;
      const why = !landAssess.safe ? landAssess.issues.map((i) => i.text).join('; ') : ahead ? `traffic ahead: ${ahead.callsign}` : '';
      const cleared = hasActive(ac, 'LAND');

      // Safety first: inside the go-around range with a runway that is (or will be) blocked.
      const goAroundNm = Math.max(GO_AROUND_NM, (Math.max(ac.groundSpeedKt, 60) * GO_AROUND_SEC) / 3600);
      const inRange = (ac.phase === 'FINAL' ? d <= goAroundNm : isOnFinal(g, ac.pos, ac.headingDeg, goAroundNm)) && ['FINAL', 'APPROACH', 'PATTERN', 'INBOUND'].includes(ac.phase);
      const early = earlyGoAroundReason(v, ac, g);
      // A light VFR aircraft that stands in the way of a jet which has waited for its approach clearance joins the pattern (the jet is number one: it cannot slow
      // below 120-140 kt behind a 55 kt aircraft, and a final full of light aircraft 5 nm apart never has a hole for it, soak seed 12: 36 minutes at 1,800 ft).
      // Pattern aircraft are the ones the sequence can delay; 3-8-1, 3-10-6.
      if (!cleared && (ac.phase === 'APPROACH' || ac.phase === 'INBOUND') && ac.flightRules !== 'IFR' && getPerformance(ac.type).category === 'light' && !priorityArrival(ac)
        && d >= STRAIGHT_IN_TO_PATTERN_MIN_NM && !ac.flags.training && !mem.done.has(`${ac.id}:to-pattern`)) {
        const jet = jetWaitingBehind(v, ac, g);
        if (jet) {
          plans.push({
            key: `${ac.id}:to-pattern`, aircraftId: ac.id, callsign: ac.callsign, priority: 88, once: true,
            cmds: [mkCmd('ENTER_PATTERN', ac, { runwayEnd: g.end.id, patternLeg: 'left_downwind' })], phrase: say.enterPattern(ac, g.end.id, 'left downwind'),
            summary: `${ac.callsign} left downwind runway ${g.end.id} (${jet.callsign} is number one)`,
          });
          continue;
        }
      }
      // Spacing is made before the final: an aircraft on base that would meet the traffic ahead is given a 360 for spacing (JO 7110.65 3-8-1; the pilot makes it on the
      // base leg), not a go-around, which stays the safety action of the last 30 s. Twice at most; then it is next in the sequence (`PRIORITY_GO_AROUNDS`).
      if (!landSafe && !cleared && !inRange && !early && isSequenceable(ac) && patternLeg(ac, g) === 'BASE' && spacingCircles(ac) < PRIORITY_GO_AROUNDS && !mem.done.has(`${ac.id}:circle:${spacingCircles(ac)}`)) {
        plans.push({
          key: `${ac.id}:circle:${spacingCircles(ac)}`, aircraftId: ac.id, callsign: ac.callsign, priority: 90, once: true,
          cmds: [mkCmd('PATTERN_INSTRUCTION', ac, { destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 })], phrase: say.clauses(say.callsign(ac), 'make left three sixty for spacing'),
          summary: `${ac.callsign} make a left 360 for spacing (${why})`,
        });
        continue;
      }
      if ((inRange && !landSafe) || early) {
        plans.push({
          key: `${ac.id}:go-around`, aircraftId: ac.id, callsign: ac.callsign, priority: 100,
          cmds: [mkCmd('GO_AROUND', ac)], phrase: say.goAround(ac), cooldownSec: 30, summary: `${ac.callsign} go around runway ${g.end.id} (${early ?? why})`,
        });
        continue;
      }
      // A go-around is re-sequenced first (vectors / direct fix, a new approach clearance): no landing clearance while it is still on the missed approach.
      if (cleared || !ready || awaitingResequence(v, ac)) continue;
      if (d <= LAND_CLEARANCE_NM) {
        // Give Ground a gap to cross the runway: hold the clearance back while somebody waits at the hold line (until the arrival is close).
        if (landSafe && !(d > CROSSING_WINDOW_NM && crossingWaiting(v, g, ac.id))) {
          plans.push({
            key: `${ac.id}:land`, aircraftId: ac.id, callsign: ac.callsign, priority: 85, cmds: [land],
            phrase: touchGo ? say.clearedTouchAndGo(ac, g.end.id, landingInfo(v, g)) : say.clearedToLand(ac, g.end.id, landingInfo(v, g)), cooldownSec: 20, summary: `${ac.callsign} cleared ${touchGo ? 'touch-and-go' : 'to land'} runway ${g.end.id}`,
          });
        }
      } else if (pending === 'LANDING' && !mem.done.has(`${ac.id}:continue`)) {
        plans.push({
          key: `${ac.id}:continue`, aircraftId: ac.id, callsign: ac.callsign, priority: 40, once: true,
          cmds: [mkCmd('CONTINUE_APPROACH', ac)], phrase: say.continueApproach(ac), summary: `${ac.callsign} continue approach runway ${g.end.id}`,
        });
      }
    }
    return plans;
  };
}
