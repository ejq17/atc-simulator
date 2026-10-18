/**
 * Explicit departure / arrival phase machines (goal.md section 7).
 * The engine never assigns a phase directly: every change goes through
 * `assertTransition` so impossible transitions are programming errors that throw.
 *
 * Departure:  PARKED -> READY -> TAXIING <-> HOLDING_SHORT -> LINE_UP_AND_WAIT
 *             -> CLEARED_FOR_TAKEOFF -> TAKEOFF_ROLL -> INITIAL_CLIMB -> DEPARTURE
 * Arrival:    INBOUND -> APPROACH -> FINAL -> LANDING -> ROLLOUT -> RUNWAY_EXIT
 *             -> TAXI_TO_PARKING -> ARRIVED   (GO_AROUND / PATTERN / HOLDING side branches)
 */
import type { FlightPhase } from './types';

export const ALLOWED_TRANSITIONS: Readonly<Record<FlightPhase, readonly FlightPhase[]>> = {
  // --- departure ---
  PARKED: ['READY'],
  READY: ['TAXIING'],
  TAXIING: ['HOLDING_SHORT', 'LINE_UP_AND_WAIT', 'CLEARED_FOR_TAKEOFF', 'PARKED'],
  HOLDING_SHORT: ['TAXIING', 'LINE_UP_AND_WAIT', 'CLEARED_FOR_TAKEOFF'],
  LINE_UP_AND_WAIT: ['CLEARED_FOR_TAKEOFF'],
  CLEARED_FOR_TAKEOFF: ['TAKEOFF_ROLL', 'LINE_UP_AND_WAIT'], // LINE_UP_AND_WAIT: takeoff clearance cancelled (JO 7110.65 3-9-11)
  TAKEOFF_ROLL: ['INITIAL_CLIMB', 'LINE_UP_AND_WAIT'], // rejected takeoff, stopped on the runway
  INITIAL_CLIMB: ['DEPARTURE', 'PATTERN'],
  DEPARTURE: ['PATTERN', 'HOLDING'],
  // --- arrival ---
  INBOUND: ['APPROACH', 'FINAL', 'PATTERN', 'HOLDING'],
  APPROACH: ['FINAL', 'INBOUND', 'PATTERN', 'HOLDING', 'GO_AROUND'],
  FINAL: ['LANDING', 'GO_AROUND', 'APPROACH'],
  LANDING: ['ROLLOUT', 'GO_AROUND', 'PATTERN'], // PATTERN: touch-and-go / low approach / option into closed traffic (JO 7110.65 3-8-2)
  ROLLOUT: ['RUNWAY_EXIT', 'PATTERN'], // PATTERN: lift-off after the ground roll of a touch-and-go
  RUNWAY_EXIT: ['TAXI_TO_PARKING'],
  TAXI_TO_PARKING: ['ARRIVED'],
  ARRIVED: [],
  // --- shared side branches ---
  GO_AROUND: ['APPROACH', 'INBOUND', 'PATTERN', 'HOLDING'],
  PATTERN: ['FINAL', 'APPROACH', 'INBOUND', 'GO_AROUND', 'HOLDING'],
  HOLDING: ['INBOUND', 'APPROACH'],
};

export const DEPARTURE_PHASES: readonly FlightPhase[] = [
  'PARKED', 'READY', 'TAXIING', 'HOLDING_SHORT', 'LINE_UP_AND_WAIT', 'CLEARED_FOR_TAKEOFF', 'TAKEOFF_ROLL', 'INITIAL_CLIMB', 'DEPARTURE',
];
export const ARRIVAL_PHASES: readonly FlightPhase[] = [
  'INBOUND', 'APPROACH', 'FINAL', 'LANDING', 'ROLLOUT', 'RUNWAY_EXIT', 'TAXI_TO_PARKING', 'ARRIVED',
];

export function canTransition(from: FlightPhase, to: FlightPhase): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  readonly from: FlightPhase;
  readonly to: FlightPhase;
  constructor(from: FlightPhase, to: FlightPhase) {
    super(`Impossible phase transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: FlightPhase, to: FlightPhase): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Non-throwing variant for callers that want to report an error instead. */
export function tryTransition(from: FlightPhase, to: FlightPhase): { ok: true } | { ok: false; error: string } {
  return canTransition(from, to) ? { ok: true } : { ok: false, error: `Impossible phase transition ${from} -> ${to}` };
}

/** Shortest legal chain of intermediate phases from -> to (excluding `from`), or null. Used to e.g. go PARKED -> READY -> TAXIING. */
export function transitionPath(from: FlightPhase, to: FlightPhase): FlightPhase[] | null {
  if (from === to) return [];
  const prev = new Map<FlightPhase, FlightPhase>();
  const queue: FlightPhase[] = [from];
  const seen = new Set<FlightPhase>([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nxt of ALLOWED_TRANSITIONS[cur]) {
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      prev.set(nxt, cur);
      if (nxt === to) {
        const path: FlightPhase[] = [to];
        let c = to;
        while (prev.get(c) !== from) {
          c = prev.get(c)!;
          path.unshift(c);
        }
        return path;
      }
      queue.push(nxt);
    }
  }
  return null;
}

/** Ground phases in which an aircraft is taxiing/standing and therefore may not be on a runway unauthorised. */
export const TAXI_PHASES: readonly FlightPhase[] = ['PARKED', 'READY', 'TAXIING', 'HOLDING_SHORT', 'RUNWAY_EXIT', 'TAXI_TO_PARKING', 'ARRIVED'];
