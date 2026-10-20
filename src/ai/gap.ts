/**
 * Departure gap: what Tower asks Approach for when a departure cannot get out between the arrivals, and what Approach does about it.
 *
 * Real-world mechanism. The tower controller sequences "arriving and departing aircraft by requiring them to adjust flight or ground operation, as
 * necessary, to achieve proper spacing" (JO 7110.65 3-8-1) and may clear a departure when "there is a reasonable assurance" that the separation
 * will exist when the roll starts (3-9-5). The arrivals he cannot reach are the approach controller's, and 2-1-14 requires the coordination before
 * an instruction that changes the speed or heading of an aircraft in another controller's area: Tower asks Approach for a gap, Approach spaces the
 * stream (speed adjustments "to the minimum necessary", 5-7-1; vectors, 5-6-1) and Tower gives the departure the hole. No paragraph of the order
 * words the request or the answer (a letter of agreement does, JO 7210.3 4-3-1): the words here are plain words, `standard: false`.
 * (docs/FAA-REFERENCES.md "Departure gap" has the verified text.)
 *
 * Pure functions of the simulation state:
 *  - `arrivalSlots`: the threshold crossing and the runway-clear time of everything that cannot be moved by Tower (seconds from now);
 *  - `gapPlan`: the cheapest gap for a waiting departure: after which arrival, how long Approach must delay the arrivals behind it, with which tool;
 *  - `usableWindowSec`: when the departure could be cleared without any change to the stream (Tower asks for a gap when that is later than
 *    `GAP_USABLE_WITHIN_SEC`).
 */
import type { Aircraft, Airport, SimulationState } from '../sim/types';
import { projectArrival } from '../sim/runwayTiming';
import { getPerformance, isRotorcraftType, isVehicleType } from '../sim/performance';
import type { RunwayEndGeom } from '../sim/runways';
import { findRunwayEnd } from '../sim/runways';
import { isHuman } from '../sim/coordination';
import { hasActive, onPosition } from './core';
import type { AgentView } from './core';
import { arrivalWindow, etaNormalSec, isSequenceable, occupancySec, patternLeg, SEQ_MARGIN_SEC, turnsBaseSoon } from './sequence';
import { departureTimes, neededEtaSec } from './tower';
import { assignedEnd, distToThresholdNm, interactingRunways, isInboundArrival } from './world';

/** A departure that has stood ready at the hold line this long (s) without a usable window gets a gap request. DESIGN VALUE (the 480 s of `DEPARTURE_WAIT_BOUND_SEC` is the lanes' fairness bound; at the hold of a runway a controller asks for the hole after a few minutes). */
export const GAP_REQUEST_WAIT_SEC = 150;
/** A window that opens inside this many seconds is "usable": Tower waits for it and does not ask (covers the lander still rolling out). DESIGN VALUE. */
export const GAP_USABLE_WITHIN_SEC = 150;
/** The gap Approach builds must start inside this many seconds: farther than that the arrivals are not yet in radar contact / not yet generated. DESIGN VALUE. */
export const GAP_HORIZON_SEC = 360;
/** Seconds between two departures released into one gap (their takeoff clearances are at least 45 s apart, `releaseSpacingSec`, plus line-up). DESIGN VALUE. */
export const GAP_PER_EXTRA_DEPARTURE_SEC = 60;
/**
 * Approach does not assign a speed adjustment inside the final approach fix on final or a point 5 miles from the runway, whichever is closer to the runway
 * (JO 7110.65 5-7-1): an IFR arrival closer than this (nm, 5 + a margin of one mile) is out of reach.
 */
export const GAP_IFR_MIN_NM = 6;
/** A VFR straight-in aircraft farther than this (nm) from the threshold can still be slowed or sent to the left downwind (Tower's `STRAIGHT_IN_TO_PATTERN_MIN_NM`). DESIGN VALUE. */
export const GAP_VFR_MIN_NM = 4;
/** An arrival held for a gap is held this long (s) before its approach clearance: a standard pattern leg (1 min each way, two turns) is about 4 minutes, the clearance may come after the first circuit. DESIGN VALUE. */
export const GAP_HOLD_DELAY_SEC = 180;
/** Most 360s one aircraft is given for spacing (the pilot's patience and the radar picture; two turns are four minutes). DESIGN VALUE. */
export const GAP_MAX_CIRCLES = 2;
/** A speed assignment must save at least this long (s) to be worth a transmission. DESIGN VALUE. */
const MIN_SPEED_GAIN_SEC = 15;
/** Seconds a turn takes beyond its 360 degrees (the bank builds and the aircraft rolls out on its track). DESIGN VALUE. */
const CIRCLE_ROLL_IN_SEC = 6;

/** What Approach can still do to one arrival. */
export interface DelayOption {
  /** Speed to assign (kt), when the aircraft can still be slowed, and the seconds it saves over the current speed. */
  speedKt?: number;
  speedGainSec: number;
  /** 360s still available (a VFR aircraft before its approach) and what one costs (s). */
  circles: number;
  circleSec: number;
  /** The aircraft can be held at its published hold-in-lieu (IFR, no approach clearance yet) and cleared `GAP_HOLD_DELAY_SEC` later. */
  hold: boolean;
  /** Largest delay (s) the tools can give. */
  maxSec: number;
}

export interface ArrivalSlot {
  ac: Aircraft;
  /** Seconds from now until the threshold crossing (0 for an aircraft on the runway) and until the runway is clear of it. */
  start: number;
  end: number;
  /** Approach can delay this arrival. */
  option?: DelayOption;
}

/** The speed (kt) Approach assigns to build a gap: the approach speed for a light aircraft, 20 kt above the approach speed (clean enough to keep the flaps up) for the others. DESIGN VALUE. */
export function gapSpeedKt(ac: Aircraft): number {
  const perf = getPerformance(ac.type);
  return perf.category === 'light' ? Math.max(perf.approachSpeedKt, perf.minSpeedKt + 10) : Math.max(perf.approachSpeedKt + 20, perf.minSpeedKt + 15);
}

/** Seconds to the threshold when the aircraft flies the straight distance at `kt` (the model of `arrivalWindow`: never above 1.15 times the approach speed). */
function directSec(ac: Aircraft, g: RunwayEndGeom, kt: number): number {
  const perf = getPerformance(ac.type);
  const v = Math.max(perf.minSpeedKt, Math.min(Math.max(kt, 1), 1.15 * perf.approachSpeedKt));
  return (distToThresholdNm(ac, g) / v) * 3600;
}

/**
 * What Approach can do to this arrival: assign a speed (JO 7110.65 5-7-1: not inside 5 nm; the AI keeps a mile of margin), and for a VFR straight-in aircraft
 * the 360. A speed assignment already in effect (the aircraft's target speed) is not repeated. `reach` says whether the position may work the aircraft.
 */
export function delayOption(ac: Aircraft, g: RunwayEndGeom, reach: (ac: Aircraft) => boolean, extra: { state?: SimulationState; holdAvailable?: (ac: Aircraft) => boolean; crowded?: (ac: Aircraft) => boolean } = {}): DelayOption | undefined {
  if (ac.phase !== 'INBOUND' && ac.phase !== 'APPROACH') return undefined; // established on final, in the pattern, on a missed approach: not Approach's
  if (hasActive(ac, 'LAND') || ac.flags.transit || ac.flags.overhead || getPerformance(ac.type).military || isRotorcraftType(ac.type) || isVehicleType(ac.type)) return undefined;
  if (!reach(ac)) return undefined;
  const ifr = ac.flightPlan?.flightRules === 'IFR' || ac.flightRules === 'IFR';
  const d = distToThresholdNm(ac, g);
  if (d < (ifr ? GAP_IFR_MIN_NM : GAP_VFR_MIN_NM)) return undefined;
  const kt = gapSpeedKt(ac);
  const cur = Math.max(ac.groundSpeedKt, 1);
  const speedOk = (ac.target.speedKt === undefined || ac.target.speedKt > kt + 2) && cur > kt + 2;
  const gain = speedOk ? Math.max(0, directSec(ac, g, kt) - directSec(ac, g, Math.min(cur, 1.15 * getPerformance(ac.type).approachSpeedKt))) : 0;
  const speedKt = gain >= MIN_SPEED_GAIN_SEC ? kt : undefined;
  // A 360 (3-8-1 "make left three-sixty") for a VFR aircraft that has no clearance yet: a steady turn at the type's turn rate (`turnRateDegPerSec`), 120 s for a C172.
  const used = ac.clearances.filter((c) => c.kind === 'PATTERN_INSTRUCTION' && c.destination === 'CIRCLE').length;
  const cleared = ac.clearances.some((c) => c.kind === 'APPROACH' && c.completedAtSec === undefined);
  const turning = extra.state ? circleRemainingSec(extra.state, ac) > 0 : false;
  const circles = !ifr && !cleared && !turning && !(extra.crowded?.(ac)) ? Math.max(0, GAP_MAX_CIRCLES - used) : 0;
  const circleSec = 360 / Math.max(1, getPerformance(ac.type).turnRateDegPerSec) + CIRCLE_ROLL_IN_SEC;
  // An IFR arrival that has no approach clearance yet and is still outside the gate (`GAP_IFR_MIN_NM`) is held at the published fix and cleared later.
  const hold = ifr && !cleared && !!extra.holdAvailable?.(ac);
  return { speedKt, speedGainSec: speedKt ? gain : 0, circles, circleSec, hold, maxSec: (speedKt ? gain : 0) + circles * circleSec + (hold ? GAP_HOLD_DELAY_SEC : 0) };
}

/** Other airborne aircraft this close (nm laterally, ft vertically) to an aircraft keep it from being given a 360: the loop is not separated from them. DESIGN VALUE. */
export const CIRCLE_CLEAR_NM = 2.5;
export const CIRCLE_CLEAR_FT = 1500;

/** Seconds a 360 given for spacing still has to run (the aircraft's own turn rate; the turn is not yet part of its position and speed). */
export function circleRemainingSec(state: SimulationState, ac: Aircraft): number {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind !== 'PATTERN_INSTRUCTION') continue;
    if (c.destination !== 'CIRCLE') return 0;
    const total = (c.turnDegrees ?? 360) / Math.max(1, getPerformance(ac.type).turnRateDegPerSec) + CIRCLE_ROLL_IN_SEC;
    return Math.max(0, total - (state.clock.timeSec - c.issuedAtSec));
  }
  return 0;
}

/** Everything on the runways that interact with `g` that Tower cannot move, as windows in seconds from now, sorted by threshold time. `dep` is the waiting departure (never a slot). */
export function arrivalSlots(state: SimulationState, airport: Airport, g: RunwayEndGeom, dep: Aircraft, optionOf: (ac: Aircraft, og: RunwayEndGeom) => DelayOption | undefined): ArrivalSlot[] {
  const rws = interactingRunways(airport, g.runway.id);
  const out: ArrivalSlot[] = [];
  for (const o of Object.values(state.aircraft)) {
    if (o.id === dep.id) continue;
    if (o.isDeparture) {
      // a departure that is cleared or rolling occupies the runway until it is 6,000 ft down it
      if (o.onGround && (o.phase === 'CLEARED_FOR_TAKEOFF' || o.phase === 'TAKEOFF_ROLL' || o.phase === 'LINE_UP_AND_WAIT') && (o.occupyingRunways.some((r) => rws.includes(r)) || o.phase === 'CLEARED_FOR_TAKEOFF')) {
        const og = findRunwayEnd(airport, o.assignedRunwayEnd);
        if (og && rws.includes(og.runway.id)) out.push({ ac: o, start: 0, end: departureTimes(o, o.occupyingRunways.length > 0).beyond6000 + SEQ_MARGIN_SEC });
      }
      continue;
    }
    const og = assignedEnd(airport, o);
    if (!og || !rws.includes(og.runway.id)) continue;
    if (o.onGround) {
      if (['LANDING', 'ROLLOUT', 'RUNWAY_EXIT'].includes(o.phase) && o.occupyingRunways.some((r) => rws.includes(r))) out.push({ ac: o, start: 0, end: Math.max(0, projectArrival(state, o, og).tClear) });
      continue;
    }
    if (!isInboundArrival(o)) continue;
    if (o.phase === 'PATTERN') {
      if (!isSequenceable(o)) {
        if (distToThresholdNm(o, og) < 3.5) out.push({ ac: o, start: 0, end: 60 });
        continue;
      }
      const leg = patternLeg(o, og);
      if (leg === 'BASE' || leg === 'FINAL') {
        const w = arrivalWindow(state, o, og);
        out.push({ ac: o, start: w.start, end: Math.max(w.end, w.start + occupancySec(state, o, og)) });
      } else if (leg === 'DOWNWIND' && turnsBaseSoon(o, og)) {
        const e = etaNormalSec(o, og);
        out.push({ ac: o, start: e, end: e + occupancySec(state, o, og) });
      }
      continue;
    }
    const w = arrivalWindow(state, o, og);
    const turn = circleRemainingSec(state, o);
    out.push({ ac: o, start: w.start + turn, end: Math.max(w.end, w.start + occupancySec(state, o, og)) + turn, option: optionOf(o, og) });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

export interface GapDelay {
  ac: Aircraft;
  /** Seconds this arrival has to lose, and the threshold time it must not beat. */
  delaySec: number;
  requiredStartSec: number;
}

export interface GapPlan {
  feasible: boolean;
  /** The arrival the gap follows (the last one that lands ahead of the departure); undefined when nothing lands before the gap. */
  after?: Aircraft;
  /** Seconds from now until the departure may be cleared. */
  startSec: number;
  /** The arrivals that have to be delayed, in landing order (empty: the stream already holds the window). */
  delays: GapDelay[];
  /** Why no gap can be built. */
  reason?: string;
}

export interface GapOptions {
  lined: boolean;
  /** Departures that will use the gap (the request says "two departures"). */
  departures?: number;
  optionOf: (ac: Aircraft, og: RunwayEndGeom) => DelayOption | undefined;
}

/**
 * The cheapest gap for `dep` on runway end `g`: for each point in the stream after which the departure could go (each arrival's clear time, and now), the
 * arrivals behind it are pushed back as far as needed (the first to clear the departure's need, `neededEtaSec` + the departure's own line-up, the next ones
 * to stay `SEQ_MARGIN_SEC` behind the one ahead), each within what Approach can do to it. The plan with the smallest `start + total delay` wins; the arrival
 * stream is not touched by a plan with no delays (`delays` empty = a window exists at `startSec`).
 */
export function gapPlan(state: SimulationState, airport: Airport, g: RunwayEndGeom, dep: Aircraft, o: GapOptions): GapPlan {
  const slots = arrivalSlots(state, airport, g, dep, o.optionOf);
  const extra = Math.max(0, (o.departures ?? 1) - 1) * GAP_PER_EXTRA_DEPARTURE_SEC;
  let best: GapPlan | undefined;
  let bestCost = Infinity;
  let reason = 'no window in the stream';
  let reasonAt = Infinity;
  let prevEnd = 0;
  for (let k = 0; k <= slots.length; k++) {
    if (k > 0) prevEnd = Math.max(prevEnd, slots[k - 1].end);
    const t0 = prevEnd;
    if (t0 > GAP_HORIZON_SEC) break;
    // slots k.. are behind the gap
    const delays: GapDelay[] = [];
    let cursorEnd = t0;
    let ok = true;
    let total = 0;
    for (let j = k; j < slots.length; j++) {
      const s = slots[j];
      const need = j === k ? t0 + neededEtaSec(dep, o.lined, s.ac.type, Math.max(s.ac.groundSpeedKt, 60)) + extra : cursorEnd + SEQ_MARGIN_SEC;
      let start = s.start;
      if (start < need) {
        const d = need - start;
        if (!s.option || d > s.option.maxSec) {
          ok = false;
          if (t0 < reasonAt) {
            reasonAt = t0;
            reason = s.option ? `${s.ac.callsign} cannot be delayed enough` : `${s.ac.callsign} is too close to the runway to be delayed`;
          }
          break;
        }
        delays.push({ ac: s.ac, delaySec: d, requiredStartSec: need });
        total += d;
        start = need;
      }
      cursorEnd = start + (s.end - s.start);
    }
    if (!ok) continue;
    const cost = t0 + total;
    if (cost < bestCost - 1e-6) {
      bestCost = cost;
      best = { feasible: true, after: k > 0 ? slots[k - 1].ac : undefined, startSec: t0, delays };
    }
  }
  return best ?? { feasible: false, startSec: Infinity, delays: [], reason };
}

/** Seconds until `dep` could be cleared with the stream as it is (Infinity beyond the horizon): no gap request is needed when this is within `GAP_USABLE_WITHIN_SEC`. */
export function usableWindowSec(state: SimulationState, airport: Airport, g: RunwayEndGeom, dep: Aircraft, lined: boolean, departures = 1): number {
  const slots = arrivalSlots(state, airport, g, dep, () => undefined);
  const extra = Math.max(0, departures - 1) * GAP_PER_EXTRA_DEPARTURE_SEC;
  let prevEnd = 0;
  for (let k = 0; k <= slots.length; k++) {
    if (k > 0) prevEnd = Math.max(prevEnd, slots[k - 1].end);
    if (prevEnd > GAP_HORIZON_SEC) break;
    const next = slots[k];
    if (!next || next.start >= prevEnd + neededEtaSec(dep, lined, next.ac.type, Math.max(next.ac.groundSpeedKt, 60)) + extra) return prevEnd;
  }
  return Infinity;
}

/**
 * Which arrivals can be worked for the gap: the ones tuned to the frequency of Approach or of Tower when that position is the AI's (the engine refuses an instruction
 * on another frequency; a person's aircraft are his to space). The VFR straight-in aircraft are on the Tower frequency (they check in from 10-12 nm), the IFR flow on
 * Approach's, so each position speaks to its own (`gapActions.ts`).
 */
export function gapReach(v: AgentView): (ac: Aircraft) => boolean {
  const ai = (['APP', 'TWR'] as const).filter((p) => v.staffed.has(p) && !isHuman(v.state, p));
  return (ac) => ai.some((p) => onPosition(v.airport, ac, p));
}
