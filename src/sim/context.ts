/**
 * Shared engine context. `SimulationState` (the public contract) is kept lean; engine-private
 * bookkeeping lives in per-aircraft `AircraftRuntime` records here so determinism and the public
 * type surface are unaffected.
 */
import type { Aircraft, AircraftPerformance, Clearance, ClearanceKind, ConflictAlert, FlightPhase, SimEvent, SimulationState } from './types';
import type { EngineOptions } from './api';
import type { Rng } from './rng';
import { getPerformance } from './performance';
import { assertTransition, transitionPath } from './stateMachines';

export const EVENT_CAP = 2000;

export interface ReadbackErrorRecord {
  sinceSec: number;
  kind: 'TAKEOFF' | 'LAND' | 'LINE_UP_AND_WAIT' | 'TAXI' | 'TAXI_TO_PARKING' | 'CROSS_RUNWAY' | 'HEADING';
  clearanceId: string;
  correct: string;
  spoken: string;
}

export interface AircraftRuntime {
  /** AUTO = the aircraft flies its own approach/departure logic; HEADING = flies the assigned heading. */
  navMode: 'AUTO' | 'HEADING';
  /** Current turn rate (deg/s, + right) so bank builds smoothly. */
  turnRateDegPerSec: number;
  turnDirection?: 'left' | 'right';
  /** Moving from the holding position onto the runway centreline. */
  lineUp?: { holdNodeId: string; runwayNodeId: string; runwayEnd: string; aligned: boolean };
  takeoffCleared: boolean;
  /** When the takeoff roll begins after clearance (pilot reaction time). */
  rollAtSec?: number;
  /** Runway end for which a landing clearance is currently held. */
  landingEnd?: string;
  /** Earliest time the first scripted pilot call is made. */
  firstCallAtSec: number;
  /** One-shot pilot calls already made (keys). */
  calls: Set<string>;
  pendingFreq?: { atSec: number; mhz: number; id?: string };
  readbackError?: ReadbackErrorRecord;
  rollout?: { exitNodeId?: string; holdNodeId?: string; exitSpeedMps: number };
  pattern?: { leg: 'DOWNWIND' | 'BASE'; side: 'left' | 'right'; runwayEnd: string };
  radioFreeAtSec: number;
  lastPilotText?: string;
  enteredRunways: Set<string>;
  /** Hold node the aircraft is currently stopped at because of a stop instruction. */
  stoppedAtNodeId?: string;
  /** FINAL decision point already evaluated for this approach. */
  decisionDone: boolean;
  /** A CONTACT_FREQUENCY handoff was completed. */
  handedOff: boolean;
  /** Since when the aircraft has been standing still (for 'ready' calls). */
  stillSince?: number;
  /** Time at which the pilot checks in on a newly selected frequency. */
  checkInAtSec?: number;
  /** Time the aircraft stopped on the ground at ARRIVED (for despawn). */
  arrivedAtSec?: number;
}

export interface SimContext {
  state: SimulationState;
  rng: Rng;
  runtime: Map<string, AircraftRuntime>;
  onPilotTransmission?: EngineOptions['onPilotTransmission'];
  readbackErrorRate: number;
  eventSeq: number;
  clearanceSeq: number;
  aircraftSeq: number;
  alertSeq: number;
  /** Events not yet consumed by scoring. */
  scoreQueue: SimEvent[];
  recentCommands: Map<string, number>;
  loggedTransmissions: Set<string>;
  /** Active dynamic conflict alerts by stable key, and expiring clearance-origin alerts. */
  dynamicAlerts: Map<string, ConflictAlert>;
  clearanceAlerts: { alert: ConflictAlert; expiresAtSec: number }[];
  waitStats: { count: number; totalSec: number; delaySec: number };
  spawnedIdx: Set<number>;
}

export function newRuntime(firstCallAtSec: number): AircraftRuntime {
  return {
    navMode: 'AUTO',
    turnRateDegPerSec: 0,
    takeoffCleared: false,
    firstCallAtSec,
    calls: new Set(),
    radioFreeAtSec: 0,
    enteredRunways: new Set(),
    decisionDone: false,
    handedOff: false,
  };
}

export function getRuntime(ctx: SimContext, ac: Aircraft): AircraftRuntime {
  let rt = ctx.runtime.get(ac.id);
  if (!rt) {
    rt = newRuntime(0);
    ctx.runtime.set(ac.id, rt);
  }
  return rt;
}

export function perfOf(ac: Aircraft): AircraftPerformance {
  return getPerformance(ac.type);
}

export function nowSec(ctx: SimContext): number {
  return ctx.state.clock.timeSec;
}

export function emitEvent(ctx: SimContext, ev: Omit<SimEvent, 'id' | 'timeSec'>): SimEvent {
  const full: SimEvent = { id: `ev-${++ctx.eventSeq}`, timeSec: ctx.state.clock.timeSec, ...ev };
  const events = ctx.state.events;
  events.push(full);
  if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
  ctx.scoreQueue.push(full);
  return full;
}

/** Rough speaking time of a transmission (seconds). */
export function speechDurationSec(text: string): number {
  return 1 + text.split(/\s+/).length * 0.38;
}

/** A pilot "speaks": logs a TRANSMISSION event, updates radio state, notifies the voice layer. */
export function pilotSay(ctx: SimContext, ac: Aircraft, text: string, data?: Record<string, unknown>): SimEvent {
  const rt = getRuntime(ctx, ac);
  const ev = emitEvent(ctx, {
    kind: 'TRANSMISSION',
    aircraftId: ac.id,
    callsign: ac.callsign,
    text,
    severity: 'info',
    frequencyMhz: ac.frequencyMhz,
    speaker: 'PILOT',
    data,
  });
  if (!data?.clarify) rt.lastPilotText = text;
  rt.radioFreeAtSec = ctx.state.clock.timeSec + speechDurationSec(text);
  ac.radioState = 'TRANSMITTING';
  ctx.onPilotTransmission?.({ aircraftId: ac.id, callsign: ac.callsign, text, frequencyMhz: ac.frequencyMhz, voiceId: ac.voiceId, event: ev });
  return ev;
}

/** Change phase through the explicit state machine (throws on an impossible transition). */
export function setPhase(ctx: SimContext, ac: Aircraft, next: FlightPhase, note?: string): void {
  if (ac.phase === next) return;
  assertTransition(ac.phase, next);
  const prev = ac.phase;
  ac.phase = next;
  emitEvent(ctx, {
    kind: 'PHASE_CHANGE',
    aircraftId: ac.id,
    callsign: ac.callsign,
    text: `${ac.callsign}: ${prev} -> ${next}${note ? ` (${note})` : ''}`,
    severity: 'info',
    speaker: 'SYSTEM',
    data: { from: prev, to: next },
  });
}

/** Walk through intermediate phases (e.g. PARKED -> READY -> TAXIING). Returns false if no legal path exists. */
export function advancePhase(ctx: SimContext, ac: Aircraft, target: FlightPhase, note?: string): boolean {
  const path = transitionPath(ac.phase, target);
  if (!path) return false;
  for (const p of path) setPhase(ctx, ac, p, note);
  return true;
}

/** Last clearance of a kind that has not been completed/cancelled. */
export function activeClearance(ac: Aircraft, kind: ClearanceKind): Clearance | undefined {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind === kind) return c.completedAtSec === undefined ? c : undefined;
  }
  return undefined;
}

export function completeClearances(ctx: SimContext, ac: Aircraft, kinds: ClearanceKind[]): void {
  for (const c of ac.clearances) {
    if (kinds.includes(c.kind) && c.completedAtSec === undefined) c.completedAtSec = ctx.state.clock.timeSec;
  }
}

export function findByCallsign(state: SimulationState, callsign: string): Aircraft | undefined {
  const up = callsign.toUpperCase();
  return Object.values(state.aircraft).find((a) => a.callsign.toUpperCase() === up);
}
