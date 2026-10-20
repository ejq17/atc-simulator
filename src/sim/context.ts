/**
 * Shared engine context. `SimulationState` (the public contract) is kept lean; engine-private
 * bookkeeping lives in per-aircraft `AircraftRuntime` records here so determinism and the public
 * type surface are unaffected.
 */
import type { Aircraft, AircraftPerformance, ApproachType, Vec2, Clearance, ClearanceKind, ConflictAlert, ControllerPositionId, FlightPhase, SimEvent, SimulationState, PendingRequest } from './types';
import type { EngineOptions } from './api';
import type { Rng } from './rng';
import { getPerformance } from './performance';
import { assertTransition, transitionPath } from './stateMachines';
import type { MissedState } from './missedApproach';
import type { HoldState } from './holding';
import type { Minima } from './minima';
import type { PilotBehaviour } from './pilotBehaviour';
import type { GustState } from './wind';
import type { HeliRuntime } from './rotorcraft';
import type { VehicleRuntime } from './vehicles';
import type { SpecialRuntime } from './special';

export const EVENT_CAP = 2000;

export interface ReadbackErrorRecord {
  sinceSec: number;
  /** The kind of the clearance that was misread (the controller corrects by re-issuing a command of this kind). */
  kind: ClearanceKind;
  /** What went wrong (`ReadbackError.kind` in radio/readback.ts); undefined = the pre-realism runway / heading digit error. */
  errorKind?: string;
  clearanceId: string;
  /** What the pilot understood (`ReadbackError.wrong`): flown when the window ends without a correction, or at once for time-critical kinds (`flown`). */
  wrong?: Record<string, unknown>;
  /** No readback / wrong-callsign answer: the addressed pilot never received the clearance and did nothing with it; it is dropped when the window ends. */
  held?: boolean;
  /** The wrong version was already put into effect (takeoff, line up, crossing, landing); a correction then restores the right one. */
  flown?: boolean;
  /** The controller's clearance before the wrong version was put in (compared with the re-issued instruction). */
  correctClr?: Clearance;
  /** Wrong-callsign answer: the aircraft that read the clearance back and will fly it if nobody corrects. */
  answererId?: string;
  /** The controller position that issued the clearance (who has to correct it). */
  byPosition?: ControllerPositionId;
  correct: string;
  spoken: string;
}

/** An instrument / visual approach the aircraft has been cleared for (engine-private; see approach.ts). */
export interface ApproachRuntime {
  type: ApproachType;
  runwayEnd: string;
  procedureId?: string;
  /** Straight-in segment fixes (farthest first). Next fix in this list => glidepath logic applies. */
  onCourse: string[];
  /** TRUE final approach course of the procedure (undefined for visual approaches). */
  courseTrue?: number;
  /** Published fix altitudes of the procedure (`InstrumentProcedure.fixAltitudes`), fix ids upper-cased; undefined when the plate has none. */
  profile?: { fix: string; minAltitudeFt?: number; maxAltitudeFt?: number; mandatoryAltitudeFt?: number }[];
  /** Distance before the threshold (m) of the FAF: non-precision approaches intercept the 3 degree path there (precision ones from the IF). */
  fafDM?: number;
  /** Precision (ILS / LOC) approach: the glidepath is intercepted from the IF on; otherwise at the FAF when a published profile exists. */
  precision?: boolean;
  /** Distance before the threshold (m) of the outermost on-course fix: the glidepath is flown from here inward. */
  ifDM?: number;
  /** Vector-intercept clearance: keep the assigned heading until the course is captured. */
  pendingCapture: boolean;
  clearedAtSec: number;
  /** Resolved minima (computed lazily at the first decision altitude check). */
  minima?: Minima;
  /** The decision altitude was already evaluated on this approach. */
  daChecked?: boolean;
}

/** Traffic-pattern state (flightDynamics.patternHeading). Legs follow AIM 4-3-2 / 4-3-3. */
export interface PatternState {
  leg: 'UPWIND' | 'CROSSWIND' | 'DOWNWIND' | 'BASE';
  side: 'left' | 'right';
  runwayEnd: string;
  /** "Extend downwind": no base turn until "turn base now" (or the 6 nm safety limit). JO 7110.65 3-8-1. */
  extend?: boolean;
  /** "Make short approach": base is turned early (SHORT_BASE_ALONG_M instead of BASE_ALONG_M). */
  short?: boolean;
  /** "Make left/right three-sixty / two seventy": turn in progress (heading change so far in `turnedDeg`). */
  circle?: { dir: 'left' | 'right'; totalDeg: number; turnedDeg: number; lastHeadingDeg: number };
}

/** A runway exit instruction in force for the landing roll (JO 7110.65 3-10-9). */
export interface ExitInstruction {
  taxiway?: string;
  side?: 'left' | 'right';
  /** "continue to the end": the last exit. */
  toEnd?: boolean;
  /** "turn right next taxiway": the first exit on that side. */
  next?: boolean;
  ifAble?: boolean;
}

/** A pilot looking for traffic the controller described (JO 7110.65 3-1-6, 7-2-1). */
export interface TrafficLook {
  targetId: string;
  sinceSec: number;
  /** The pilot reports the traffic in sight at this time (or negative contact if it is out of range then). */
  acquireAtSec: number;
}

/** A position report the controller asked for (JO 7110.65 3-10-1: requests for additional position reports). */
export interface PositionReport {
  kind: 'MIDFIELD_DOWNWIND' | 'BASE' | 'FINAL';
  distanceNm?: number;
}

/** A pushback in progress (groundMovement.ts `stepPushback`). */
export interface PushbackState {
  /** Stand position and the push point (where the stand lead-in meets the apron lane). */
  from: Vec2;
  to: Vec2;
  /** Graph node at the push point: the taxi route starts here. */
  nodeId: string;
  lengthM: number;
  /** Nose heading when the push is done (true degrees): along the lane, chosen from the lane geometry and the requested direction. */
  finalHeadingDeg: number;
  startSec: number;
  /** Set once the aircraft has stopped at the push point and the heading is final. */
  stoppedAtSec?: number;
  /** Requested tail / nose direction as spoken (true degrees), for the record. */
  requestedTailDeg?: number;
  requestedFaceDeg?: number;
}

/** A missing hold-short readback the controller has to obtain (JO 7110.65 2-4-3, 3-7-2; AIM 4-3-18). */
export interface UnreadHoldShort {
  clearanceId: string;
  sinceSec: number;
  /** The hold-short references of the instruction ("RWY13", "C"). */
  refs: string[];
  /** The controller was already charged a communication error for this one. */
  charged?: boolean;
}

export interface AircraftRuntime {
  /** "Make left/right three-sixty" for spacing on the way in (JO 7110.65 3-8-1; Approach: 5-6-1 vectors): a steady turn before the approach, then the route / approach guidance again. */
  spacingTurn?: { dir: 'left' | 'right'; totalDeg: number; turnedDeg: number; lastHeadingDeg: number };
  /** Pushback in progress or completed. */
  pushback?: PushbackState;
  /** Nose heading when the push began. */
  pushStartHeadingDeg?: number;
  /** The aircraft has been pushed back from its stand (an airliner needs this before it calls ready to taxi). */
  pushedBack?: boolean;
  /** An airliner at a gate / cargo stand: pushback is part of its departure. */
  needsPushback?: boolean;
  /** When the pilot calls "ready to taxi" (engine start complete). */
  readyAtSec?: number;
  /** Time of the last "request pushback" call. */
  pushbackAskedAtSec?: number;
  /** The pilot asked for progressive taxi: the controller gives the route in steps. */
  progressive?: boolean;
  unreadHoldShort?: UnreadHoldShort;
  /** "Turn left on Bravo" just heard: the turn constraint for the segment that follows in the same transmission. */
  segmentTurn?: { dir: 'left' | 'right'; taxiway: string; atSec: number };
  /** Runway exit instruction for the rollout in progress / about to start. */
  exit?: ExitInstruction;
  /** "Make a one eighty" on a taxiway: the aircraft stops, then turns to this heading (groundMovement.ts) and holds position for new instructions. */
  turnAround?: { headingDeg: number };
  /** Nose to nose with `otherId` on a shared lane (headOn.ts): set while both stand on the stretch, cleared two seconds after the conflict is gone. */
  /** The pilot called "nose to nose" and the conflict has since ended: he asks for new taxi instructions when he stands still (traffic.ts). */
  headOnCalled?: number;
  /** A head-on just ended: wait for the counterpart to move off before driving up to it (groundMovement.ts). */
  headOnLinger?: { otherId: string; untilSec: number };
  headOn?: { otherId: string; taxiway: string; sinceSec: number; laneNodeIds: string[]; lastSeenSec?: number; lastCallSec?: number; resumeCall?: boolean; /** found by `traffic.ts` from two aircraft standing nose to nose (the route test saw no conflict any more) */ synthetic?: boolean };
  /** "Hold short of runway N" given during the landing roll / on final: the intersecting runway the rollout must stop short of. */
  exitHoldShort?: string;
  /** Touch-and-go ground roll in progress (phase ROLLOUT, runway occupied): see `stepTouchAndGo` in flightDynamics.ts. */
  tgo?: { startSec: number; holdUntilSec: number; phase: 'DECEL' | 'RECONFIGURE' | 'ACCEL' };
  /** Rejected takeoff: braking on the runway to a stop. */
  aborting?: boolean;
  /** Sim time at which the aircraft completed LUAW alignment (3-9-4 NOTE: not more than 90 s without further instructions). */
  luawSinceSec?: number;
  /** The pilot has the wind and altimeter (ATIS code reported or the controller issued the numbers). */
  haveNumbers?: boolean;
  /** The pilot already asked for the numbers once. */
  numbersRequested?: boolean;
  /** The request (landing, departure) the pilot was waiting on when he asked for the numbers: the numbers do not answer it, so it is restored after the answer. */
  requestBeforeNumbers?: PendingRequest;
  trafficLook?: TrafficLook;
  /** Ids of traffic the pilot has reported in sight. */
  trafficSeen?: string[];
  /** Time of the last traffic advisory (counts as the traffic information a line-up-and-wait needs, 3-9-4). */
  lastTrafficAdvisorySec?: number;
  /** The aircraft was told to follow this traffic (3-8-1). */
  follow?: { targetId: string; sequence?: number };
  reports: PositionReport[];
  /** Closed traffic approved / assumed after a touch-and-go, low approach or option (3-10-11). */
  closedTraffic?: { side: 'left' | 'right' };
  /** What the current landing clearance allows: full stop (default), touch-and-go, low approach, stop-and-go, option (3-8-1). */
  landingOp?: 'full_stop' | 'touch_and_go' | 'low_approach' | 'stop_and_go' | 'option';
  /** The player (not an AI controller) has issued an accepted command to this aircraft: only then does it count as "handled" once an AI is active. */
  playerTouched?: boolean;
  /** AUTO = the aircraft flies its own approach/departure logic; HEADING = flies the assigned heading. */
  navMode: 'AUTO' | 'HEADING';
  /** Current turn rate (deg/s, + right) so bank builds smoothly. */
  turnRateDegPerSec: number;
  turnDirection?: 'left' | 'right';
  /** Moving from the holding position onto the runway centreline. */
  lineUp?: { holdNodeId: string; runwayNodeId: string; runwayEnd: string; aligned: boolean };
  takeoffCleared: boolean;
  /** Heading (TRUE) and turn to fly once the departure is 400 ft AGL (AIM 5-2-9 initial-turn point), from the takeoff clearance (JO 7110.65 5-8-2 INITIAL HEADING); until then the runway heading. */
  departureHeading?: { trueDeg: number; turn?: 'left' | 'right' };
  /** When the takeoff roll begins after clearance (pilot reaction time). */
  rollAtSec?: number;
  /** Runway end for which a landing clearance is currently held. */
  landingEnd?: string;
  /** Earliest time the first scripted pilot call is made. */
  firstCallAtSec: number;
  /** One-shot pilot calls already made (keys). */
  calls: Set<string>;
  /** `afterClear`: the change happens only once the aircraft is clear of the runway (exit instruction + "contact Ground", 3-10-9). */
  pendingFreq?: { atSec: number; mhz: number; id?: string; afterClear?: boolean; silent?: boolean };
  readbackError?: ReadbackErrorRecord;
  rollout?: { exitNodeId?: string; holdNodeId?: string; viaNodeIds?: string[]; exitSpeedMps: number; brakeMps2: number; stopAlongM?: number; honoured?: boolean; unableReason?: string };
  pattern?: PatternState;
  radioFreeAtSec: number;
  lastPilotText?: string;
  enteredRunways: Set<string>;
  /** Hold node the aircraft is currently stopped at because of a stop instruction. */
  stoppedAtNodeId?: string;
  /** FINAL decision point already evaluated for this approach. */
  decisionDone: boolean;
  /** A CONTACT_FREQUENCY handoff was completed. */
  handedOff: boolean;
  /** Category of the parking position the aircraft spawned on (preferred when returning to parking). */
  homeParkingCategory?: 'ga' | 'airline' | 'cargo' | 'military' | 'fbo' | 'other';
  /** Since when the aircraft has been standing still (for 'ready' calls). */
  stillSince?: number;
  /** Time at which the pilot checks in on a newly selected frequency. */
  checkInAtSec?: number;
  /** Time the aircraft stopped on the ground at ARRIVED (for despawn). */
  arrivedAtSec?: number;
  /** Active approach clearance (IFR approaches and visual approaches). */
  approach?: ApproachRuntime;
  /** Published missed approach in progress (nav mode 'missed'). */
  missed?: MissedState;
  /** Holding pattern in progress (nav mode 'holding'). */
  hold?: HoldState;
  /** Accepted land-and-hold-short clearance: the aircraft must stop (or exit) before `holdShortAlongM` along its landing runway. */
  lahso?: { holdShortRunwayId: string; holdShortAlongM: number; stopAlongM: number };
  /** A missed approach / go-around was flown and the aircraft has not yet been cleared for another approach. */
  missedFlown?: boolean;
  /** Nav mode to return to on RESUME_OWN_NAVIGATION after vectors. */
  navBeforeVectors?: 'route' | 'direct';
  /** IFR departure: when to tune Ground and ask for taxi after the clearance was read back. */
  taxiRequestAtSec?: number;
  /** Arrival spawned at a fix: its first call is the approach check-in (replaces the 'inbound' call). */
  approachCheckIn?: boolean;
  /** A taxiway on the remaining route closed: the aircraft stops short of it at `nodeId` and asks for instructions (`airportOps.enforceClosuresOnRoutes`). */
  closedHold?: { nodeId: string; taxiway: string };
  /** Speed (kt) of the last STAR speed restriction passed: held until the next restricted fix (AIM 5-4-1). */
  starSpeedCapKt?: number;
  /** Runway end the aircraft touched down on (for the braking action report after landing). */
  landedEnd?: string;
  /** Identifiers (upper case) of fixes already sequenced; RESUME_OWN_NAVIGATION restarts at the first filed fix not in this set. */
  passedFixes: Set<string>;
  /** An altitude / direct / resume instruction was issued after the handoff (IFR departure counts as handled). */
  depInstructed: boolean;
  /** Seeded gust process of this aircraft (wind.ts); created at its first airborne or takeoff-roll tick. */
  gust?: GustState;
  /** Airspeed (kt) the gusts added to this aircraft and the speed controller has not yet removed (drives balloon / sink in the flare). */
  gustAirKt?: number;
  /** Seconds the effective (gusted) crosswind / tailwind has been over the type's limit on final. */
  windExceedSec?: number;
  /** Calls made so far (seeds the per-call timing and style draws). */
  callSeq: number;
  /** Commands this aircraft has been given so far: the key of every pilot-behaviour draw about a command (same seed + same command sequence = same behaviour, at any sim time). */
  cmdSeq: number;
  /** Frequencies (3 decimals) on which the pilot has already spoken: the first pilot-initiated call on a new one is the initial contact. */
  contacted: Set<string>;
  /** The controller addressed this aircraft by an abbreviated callsign: its pilot may abbreviate too (AIM 4-2-4). */
  abbreviationOk?: boolean;
  /** The pilot missed the controller's call: nothing was done or said, a second call is needed (realism `delayedResponseRate`). */
  unanswered?: { sinceSec: number; kind: string };
  /** Pushback requests made so far (seeds the jitter of the next repeat). */
  pushbackAsks?: number;
  /** After a wrong frequency was flown: the pilot finds his way back to this frequency at this time. */
  returnFreq?: { atSec: number; mhz: number; id?: string };
  /** Last time the pilot looked for something to request (once a second). */
  requestCheckedAtSec?: number;
  /** Sim time of the aircraft's latest pilot-initiated request (cooldown). */
  lastRequestAtSec?: number;
  /** "We need a minute": the pilot is not ready for takeoff until this time. */
  notReadyUntilSec?: number;
  /** Pilot-initiated request codes already made or ruled out (one of each per aircraft). */
  requestsDone: Set<string>;
  /** Set when "request taxi back" was made: the next accepted taxi to a runway makes the aircraft a departure again. */
  taxiBackFor?: string;
  /** "Request to stay in the pattern" already answered for this circuit: the touch-and-go count flown. */
  patternCircuits?: number;
  /** Commands of one transmission that the pilot has asked to say again (by transmission id). */
  sayAgainTx?: string;
  /** Helicopter state (rotorcraft.ts): lift-off, approach to a helipad, hover. */
  heli?: HeliRuntime;
  /** Airport vehicle task (vehicles.ts). */
  vehicle?: VehicleRuntime;
  /** VFR transition, flight training and overhead-maneuver state (special.ts). */
  special?: SpecialRuntime;
}

export interface SimContext {
  state: SimulationState;
  /** Second at which `refreshArrivalStands` last ran (parkingResolver.ts). */
  standCheckSec?: number;
  /** Resolved `Scenario.pilotBehaviour` (design values, pilotBehaviour.ts). */
  pilotBehaviour: PilotBehaviour;
  rng: Rng;
  runtime: Map<string, AircraftRuntime>;
  onPilotTransmission?: EngineOptions['onPilotTransmission'];
  readbackErrorRate: number;
  /** Pilot calls waiting for their response delay / key-up window (radioDiscipline.ts). */
  scheduledSpeech: import('./radioDiscipline').ScheduledSpeech[];
  speechSeq: number;
  /** The pilot readback fragments of the transmission being applied, to be spoken as ONE readback (radioDiscipline.ts `addReadbackFragment`). */
  readbackGroup?: { tid: string; aircraftId: string; parts: { text: string; clearanceId: string }[]; delaySec: number };
  /** Commands applied so far of the transmission being applied (`executeCommand`): the group is spoken when all of them have been. */
  transmissionProgress?: { tid: string; applied: number };
  /** Frequency (3 decimals) -> sim time at which the call now on it ends. */
  frequencyUse: Map<string, number>;
  /** Frequency -> sim time from / until which pilots queued on the channel will be on the air; a pilot who keys up before `from` cannot know about them (radioDiscipline.ts). */
  /** Frequency -> the time in which the pilot addressed by the controller is expected to answer (others wait for it). */
  answerWindow: Map<string, { from: number; end: number }>;
  frequencyReserved: Map<string, { from: number; end: number }>;
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
  /** Closure start / end announcements already logged (`airportOps.announceClosureChanges`). */
  opsAnnounced: Set<string>;
  /** Dry run (`validateCommand`): nothing is logged, spoken, scored or changed. */
  dryRun?: boolean;
  /** Position of the AI controller whose command is being executed: its scored events carry `aiPosition`. */
  currentAi?: ControllerPositionId;
  /** An AI-issued command has been seen: the score then counts only the player's own actions. */
  aiSeen?: boolean;
}

/**
 * Ground behaviour values in force. Pilot mistakes (hold-short readback omissions, wrong taxiways) and unfamiliar pilots belong to the
 * "imperfect pilots" setting: they are off when the engine's `readbackErrorRate` is 0 (training mode, and the engine tests).
 */
export function groundBehaviour(ctx: Pick<SimContext, 'pilotBehaviour' | 'readbackErrorRate' | 'state'>): PilotBehaviour['ground'] {
  const g = ctx.pilotBehaviour.ground;
  if (ctx.readbackErrorRate > 0) return g;
  // A scenario that sets one of these values explicitly (a lesson that teaches hold-short readbacks) turns it on whatever the readback error rate.
  const ov = ctx.state.scenario.pilotBehaviour?.ground ?? {};
  return {
    ...g,
    holdShortOmitFraction: ov.holdShortOmitFraction !== undefined ? g.holdShortOmitFraction : 0,
    taxiwayErrorShare: ov.taxiwayErrorShare !== undefined ? g.taxiwayErrorShare : 0,
    unfamiliarFraction: ov.unfamiliarFraction !== undefined ? g.unfamiliarFraction : 0,
  };
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
    depInstructed: false,
    passedFixes: new Set(),
    reports: [],
    callSeq: 0,
    cmdSeq: 0,
    contacted: new Set(),
    requestsDone: new Set(),
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

/** Event kinds an AI command produces that the score would otherwise attribute to the player. */
const AI_ATTRIBUTED = new Set(['COMMAND_ACCEPTED', 'COMMAND_REJECTED', 'CLARIFICATION', 'CONFLICT', 'READBACK_ERROR']);

export function emitEvent(ctx: SimContext, ev: Omit<SimEvent, 'id' | 'timeSec'>): SimEvent {
  if (ctx.dryRun) return { id: 'ev-dry', timeSec: ctx.state.clock.timeSec, ...ev };
  if (ctx.currentAi && ev.aiPosition === undefined && AI_ATTRIBUTED.has(ev.kind)) ev = { ...ev, aiPosition: ctx.currentAi };
  const full: SimEvent = { id: `ev-${++ctx.eventSeq}`, timeSec: ctx.state.clock.timeSec, ...ev };
  const events = ctx.state.events;
  events.push(full);
  if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
  ctx.scoreQueue.push(full);
  return full;
}

export { pilotSay, speechDurationSec } from './radioDiscipline';

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
