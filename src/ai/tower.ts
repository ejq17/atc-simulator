/**
 * Tower: takeoff / line-up clearances for departures at the hold, landing clearances (or continue / go-around) for arrivals,
 * the handoff of departures to Departure and of landed arrivals to Ground, and a go-around when the runway will not be clear.
 *
 * Every candidate clearance is pre-checked with the engine's own pure `assessClearanceSafety` so the AI never issues
 * (and never logs) a clearance the engine would refuse in training mode or flag outside it. On top of that the AI applies
 * its own, more conservative arrival/departure spacing (`releaseSlackSec`).
 */
import type { Aircraft } from '../sim/types';
import { assessClearanceSafety } from '../sim/conflicts';
import { findRunwayEnd, isOnFinal } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { frequencyForPosition } from '../radio/frequencies';
import { KT_TO_MPS } from '../sim/geo';
import { getPerformance } from '../sim/performance';
import { hasActive, mkCmd } from './core';
import type { Agent, AgentView, Plan } from './core';
import {
  assignedEnd, distToThresholdNm, etaToThresholdSec, holdNodeAt, interactingRunways, isInboundArrival, planParking,
} from './world';
import * as say from './phrase';

/** Seconds between a takeoff clearance and the pilot starting the roll when the aircraft is still at the hold line (turn onto the runway and align). */
const LINE_UP_DELAY_SEC = 20;
const RELEASE_MARGIN_SEC = 30;
/** Distance from the threshold beyond which a departure no longer blocks the landing runway for a following arrival (7110.65 3-10-3: 6,000 ft, category III). */
const DEPARTURE_CLEAR_M = 1829;

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
/** Aircraft in the traffic pattern closer than this to the threshold (nm) block departures. */
const PATTERN_BLOCK_NM = 3.5;

/** A released departure and an arrival on short final stay at least this far apart (nm) when the departure lifts off (engine near-miss alert: 1.5 nm / 500 ft). */
const LIFTOFF_SEPARATION_NM = 2.4;

/**
 * Smallest "slack" (seconds) over all arrivals that use `end`'s runway or one intersecting it: how much longer than needed the arrival
 * takes to reach its threshold if `dep` is released now. Negative = releasing the departure would put it too close to an arrival.
 */
export function releaseSlackSec(v: AgentView, end: RunwayEndGeom, dep: Aircraft, lined: boolean): number {
  const rws = interactingRunways(v.airport, end.runway.id);
  const t = departureTimes(dep, lined);
  let best = Infinity;
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === dep.id || !isInboundArrival(o)) continue;
    const g = assignedEnd(v.airport, o);
    if (!g || !rws.includes(g.runway.id)) continue;
    const d = distToThresholdNm(o, g);
    // Pattern traffic is separated visually by the controller: anything in the pattern near the field blocks departures.
    if (o.phase === 'PATTERN' && d < PATTERN_BLOCK_NM) return -Infinity;
    const eta = etaToThresholdSec(o, g);
    const kt = Math.max(o.groundSpeedKt, 60);
    const needBeyond = t.beyond6000 + RELEASE_MARGIN_SEC; // the departure is 6,000 ft down the runway (landing behind a departure)
    const needLiftoff = t.liftoff + (LIFTOFF_SEPARATION_NM / kt) * 3600; // the arrival is still >= 2.4 nm out when it lifts off
    best = Math.min(best, eta - Math.max(needBeyond, needLiftoff));
  }
  return best;
}

/** Two arrivals to one runway need at least this many seconds between their threshold crossings (runway occupancy of the leader). */
const ARRIVAL_RUNWAY_GAP_SEC = 80;

/**
 * An arrival ahead of `ac` on the same runway (or an intersecting one) that has not left the runway yet, or will not have by the
 * time `ac` arrives. The engine only judges a landing clearance against aircraft that are already on the ground.
 */
export function blockedByLeader(v: AgentView, ac: Aircraft, g: RunwayEndGeom): Aircraft | undefined {
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

/** Landing clearances are held back (down to this distance, nm) while an aircraft has been waiting at a hold line to cross the runway. */
const CROSSING_WINDOW_NM = 1.3;
const CROSSING_WAIT_SEC = 15;

/** An aircraft stands at a hold line asking to cross this runway (Ground will walk it across in the next gap). */
export function crossingWaiting(v: AgentView, g: RunwayEndGeom, exceptId: string): Aircraft | undefined {
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === exceptId || !o.onGround || o.pendingRequest?.kind !== 'CROSSING' || o.groundSpeedKt >= 1) continue;
    if (v.now - o.pendingRequest.sinceSec < CROSSING_WAIT_SEC) continue;
    if (holdNodeAt(v.airport, o)?.runwayId === g.runway.id) return o;
  }
  return undefined;
}

const stationary = (ac: Aircraft): boolean => ac.groundSpeedKt < 1;
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
      if (!ac.isDeparture || !ac.onGround || ac.radioState === 'TRANSMITTING') continue;
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
      if (!g) continue;
      const waiting = ac.phase === 'HOLDING_SHORT' && atDepartureHold(v, ac, g);
      const lined = ac.phase === 'LINE_UP_AND_WAIT' && stationary(ac) && ac.occupyingRunways.includes(g.runway.id);
      if (!waiting && !lined) continue;
      const ready = ac.pendingRequest?.kind === 'DEPARTURE' || v.settled(ac) >= 8 || lined;
      if (!ready) continue;
      const k = `hold:${ac.id}`;
      if (!mem.notes.has(k)) mem.notes.set(k, v.now);
      queue.push({ ac, g, since: mem.notes.get(k)! });
    }
    queue.sort((a, b) => (isLinedUp(a.ac) === isLinedUp(b.ac) ? a.since - b.since : isLinedUp(a.ac) ? -1 : 1));
    const firstPerRunway = new Set<string>();
    for (const { ac, g } of queue) {
      if (firstPerRunway.has(g.runway.id)) continue;
      firstPerRunway.add(g.runway.id);
      const takeoff = mkCmd('TAKEOFF', ac, { runwayEnd: g.end.id, runwayId: g.runway.id });
      const slack = releaseSlackSec(v, g, ac, isLinedUp(ac));
      const ifr = ac.flightPlan?.flightRules === 'IFR';
      if (safe(takeoff) && slack >= 0 && !(ifr && !ac.flightPlan?.ifrClearance && state.scenario.mode === 'training')) {
        plans.push({
          key: `${ac.id}:takeoff`, aircraftId: ac.id, callsign: ac.callsign, priority: 80, cmds: [takeoff],
          phrase: say.clearedForTakeoff(ac, g.end.id, ifr), cooldownSec: 20,
          summary: `${ac.callsign} cleared for takeoff runway ${g.end.id}`,
        });
      } else if (ac.phase === 'HOLDING_SHORT' && slack >= LINEUP_EXTRA_SEC) {
        const luaw = mkCmd('LINE_UP_AND_WAIT', ac, { runwayEnd: g.end.id, runwayId: g.runway.id });
        if (safe(luaw)) {
          plans.push({
            key: `${ac.id}:luaw`, aircraftId: ac.id, callsign: ac.callsign, priority: 60, cmds: [luaw],
            phrase: say.lineUpAndWait(ac, g.end.id), cooldownSec: 20, once: true,
            summary: `${ac.callsign} line up and wait runway ${g.end.id}`,
          });
        }
      }
    }

    // ---- everything else on the frequency --------------------------------------------------------------------------------
    for (const ac of v.onFrequency) {
      if (ac.radioState === 'TRANSMITTING') continue;
      const pending = ac.pendingRequest?.kind;
      const ready = pending !== undefined || v.settled(ac) >= 4;

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
        } else if (!ifr && pending === 'LANDING' && ac.assignedRunwayEnd) {
          plans.push({
            key: `${ac.id}:pattern`, aircraftId: ac.id, callsign: ac.callsign, priority: 50,
            cmds: [mkCmd('ENTER_PATTERN', ac, { runwayEnd: ac.assignedRunwayEnd, patternLeg: 'left_downwind' })],
            phrase: say.enterPattern(ac, ac.assignedRunwayEnd, 'left downwind'), cooldownSec: 30, summary: `${ac.callsign} left downwind runway ${ac.assignedRunwayEnd}`,
          });
        }
        continue;
      }

      // Arrivals to land.
      if (!isInboundArrival(ac) || ac.phase === 'LANDING') continue;
      const g = assignedEnd(airport, ac);
      if (!g) continue;
      const d = distToThresholdNm(ac, g);
      const land = mkCmd('LAND', ac, { runwayEnd: g.end.id, runwayId: g.runway.id });
      const landAssess = assessClearanceSafety(state, land);
      const ahead = blockedByLeader(v, ac, g);
      const landSafe = landAssess.safe && !ahead;
      const why = !landAssess.safe ? landAssess.issues.map((i) => i.text).join('; ') : ahead ? `traffic ahead: ${ahead.callsign}` : '';
      const cleared = hasActive(ac, 'LAND');

      // Safety first: inside the go-around range with a runway that is (or will be) blocked.
      const goAroundNm = Math.max(GO_AROUND_NM, (Math.max(ac.groundSpeedKt, 60) * GO_AROUND_SEC) / 3600);
      const inRange = (ac.phase === 'FINAL' ? d <= goAroundNm : isOnFinal(g, ac.pos, ac.headingDeg, goAroundNm)) && ['FINAL', 'APPROACH', 'PATTERN', 'INBOUND'].includes(ac.phase);
      if (inRange && !landSafe) {
        plans.push({
          key: `${ac.id}:go-around`, aircraftId: ac.id, callsign: ac.callsign, priority: 100,
          cmds: [mkCmd('GO_AROUND', ac)], phrase: say.goAround(ac), cooldownSec: 30, summary: `${ac.callsign} go around runway ${g.end.id} (${why})`,
        });
        continue;
      }
      if (cleared || !ready) continue;
      if (d <= LAND_CLEARANCE_NM) {
        // Give Ground a gap to cross the runway: hold the clearance back while somebody waits at the hold line (until the arrival is close).
        if (landSafe && !(d > CROSSING_WINDOW_NM && crossingWaiting(v, g, ac.id))) {
          plans.push({
            key: `${ac.id}:land`, aircraftId: ac.id, callsign: ac.callsign, priority: 85, cmds: [land],
            phrase: say.clearedToLand(ac, g.end.id), cooldownSec: 20, summary: `${ac.callsign} cleared to land runway ${g.end.id}`,
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
