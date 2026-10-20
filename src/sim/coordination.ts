/**
 * Coordination channel between controller positions (the landline / the cab). See README.md "Coordination".
 *
 * Everything lives in `state.coordination` (plain JSON: requests + a message log + who is staffed by whom) and every message is also logged
 * as a `COORDINATION` event, so a session replays from the event log. Nothing here uses randomness: ids are counters, times are sim
 * seconds, so the same commands at the same times give the same channel (tested).
 *
 * Sources (JO 7110.65, verified on the FAA web edition on 2026-10-18, see docs/FAA-REFERENCES.md):
 *  - 3-1-3 USE OF ACTIVE RUNWAYS: "Ground control must obtain approval from local control before authorizing an aircraft or a vehicle to
 *    cross or use any portion of an active runway. The coordination must include the point/intersection at the runway where the operation
 *    will occur." Phraseology of the local controller's authorisation: CROSS (runway) AT (point/intersection). The ground controller
 *    "must advise the local controller when the coordinated runway operation is complete. This may be accomplished verbally or through
 *    visual aids as specified by a facility directive."
 *  - 4-3-4 DEPARTURE RELEASE, ...: phraseology "To another controller, (aircraft identification) RELEASED."; "Hold for release" informs a
 *    pilot or a controller that a departure clearance is not valid until additional instructions are received. That a TOWER must get a
 *    release from the TRACON before an IFR departure is a letter-of-agreement / facility-directive matter (JO 7210.3 4-3-1); the simulator
 *    makes it a scenario setting (`Scenario.coordination.releasesRequired`, default on when a separate Departure/Approach position exists).
 *  - 5-4-3 METHODS / 5-4-7 POINT OUT: "POINT OUT (aircraft position), (aircraft ID), (altitude, restrictions, ...)"; answers "POINT OUT
 *    APPROVED", "TRAFFIC OBSERVED" or "UNABLE (...)". The transferring controller keeps communications and responsibility for the aircraft.
 *
 *  - GAP (a departure gap, Tower to Approach): no paragraph of the order names such a request. What the order does say is 3-8-1 (the tower
 *    controller "establish[es] the sequence of arriving and departing aircraft by requiring them to adjust flight or ground operation, as
 *    necessary, to achieve proper spacing"), 3-9-5 (takeoff clearance need not be withheld until separation exists when there is reasonable
 *    assurance it will exist when the roll starts), 2-1-14 (before an instruction that changes an aircraft's heading, route, speed or altitude
 *    the controller must ensure the coordination with every controller whose area is affected: Tower cannot slow Approach's arrival by itself),
 *    4-3-4 (departure restrictions "to restrict or regulate the departure flow") and 5-7-1 / 5-6-1 (the tools Approach builds the gap with:
 *    speed adjustments kept to the minimum necessary, vectors). The request and its answer are plain words: a letter of agreement or facility
 *    directive (JO 7210.3 4-3-1) is where the real facilities fix them. The Pilot/Controller Glossary has no GAP entry (checked 2026-10-19).
 *
 * Not in the FAA text (plain words, flagged `standard: false`): the Ground-to-Tower request wording, "stand by", "rolling", "going around",
 * "traffic" information between positions, and the "crossing complete" wording (3-1-3 only requires that the advice happen).
 */
import type { Aircraft, ControllerPositionId, Runway, Scenario, SimulationState } from './types';
import { emitEvent } from './context';
import type { SimContext } from './context';
import { findRunway } from './runways';
import { positionWord } from '../radio/frequencies';
import { spokenAltitude, spokenRunway, spokenTaxiway } from '../radio/spoken';

// ---------------------------------------------------------------------------
// Design values (not FAA numbers)
// ---------------------------------------------------------------------------

export const COORDINATION_DESIGN = {
  /** A crossing approval stays valid this long (s) after it was given; the crossing must be authorised inside it. DESIGN VALUE. */
  crossingApprovalTtlSec: 60,
  /** A departure release stays valid this long (s); Tower must issue the takeoff clearance inside it. DESIGN VALUE. */
  releaseTtlSec: 120,
  /** An approved exit request stays valid this long (s): an aircraft on final is a minute or two from touchdown. DESIGN VALUE. */
  exitRequestTtlSec: 240,
  /** A request nobody answered (or that is on stand-by) is dropped after this long without a repeat (s). DESIGN VALUE. */
  openRequestTimeoutSec: 240,
  /** An AI requester repeats an unanswered request after this long (s). DESIGN VALUE. */
  reaskIntervalSec: 30,
  /** A requester repeating itself within this time of the previous call is ignored as a duplicate (s). */
  duplicateWindowSec: 5,
  /** Crossing is complete when the aircraft has left the runway; this long after the approval was used it is closed anyway (s). */
  crossingCloseSec: 180,
  /** Departure and arrival closer than this (nm) laterally, both airborne and under different radar positions, are pointed out. DESIGN VALUE. */
  pointOutNm: 4,
  /** Departure releases to one departure sector are at least this far apart (s) before the AI Departure says "hold for release". DESIGN VALUE. */
  releaseSpacingSec: 45,
  /** A departure that still waits at the hold asks for its release again when the one it holds has this long left (s), so that Departure's answer arrives before the old one lapses (4-3-4 extends no time limit; the release is the LOA's). DESIGN VALUE. */
  releaseRenewBeforeSec: 20,
  /** An approved departure-gap request stays valid this long (s): the time Approach has to build the gap for the departure that waits at the hold. DESIGN VALUE. */
  gapTtlSec: 360,
  /** Tower does not repeat a refused (or lapsed) gap request for the same departure before this long (s). DESIGN VALUE. */
  gapRetrySec: 120,
} as const;

/** Where each rule comes from (shown with a coordination error and in the debrief). */
export const COORDINATION_REFERENCES = {
  crossing: '7110.65 3-1-3 Use of Active Runways',
  release: '7110.65 4-3-4 Departure Release (and the letter of agreement)',
  pointOut: '7110.65 5-4-7 Point Out',
  gap: '7110.65 3-8-1 Sequence/Spacing Application, 3-9-5 Anticipating Separation, 2-1-14 Coordinate Use of Airspace (a gap request is not phraseology of the order)',
  exit: '7110.65 3-1-4 Coordination Between Local and Ground Controllers (exchange information as necessary for the safe and efficient use of runways and movement areas); 3-10-9 Runway Exiting',
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CoordTopic = 'CROSSING' | 'RELEASE' | 'POINT_OUT' | 'EXIT' | 'GAP';
export type CoordStatus = 'pending' | 'standby' | 'approved' | 'denied' | 'rescinded' | 'expired' | 'used' | 'completed';
export type CoordSource = 'player' | 'ai' | 'system';

export type CoordMessageKind =
  | 'CROSS_REQUEST' | 'CROSS_APPROVED' | 'CROSS_UNABLE' | 'CROSS_STANDBY' | 'CROSS_RESCINDED' | 'CROSS_COMPLETE'
  | 'RELEASE_REQUEST' | 'RELEASED' | 'HOLD_FOR_RELEASE' | 'RELEASE_STANDBY'
  | 'POINT_OUT' | 'POINT_OUT_APPROVED' | 'POINT_OUT_UNABLE' | 'TRAFFIC_OBSERVED'
  | 'EXIT_REQUEST' | 'EXIT_APPROVED' | 'EXIT_UNABLE'
  | 'GAP_REQUEST' | 'GAP_APPROVED' | 'GAP_UNABLE' | 'GAP_STANDBY'
  | 'ROLLING' | 'GOING_AROUND' | 'TRAFFIC' | 'TEXT';

export interface CoordRequest {
  id: string;
  topic: CoordTopic;
  /** The position that asked. */
  from: ControllerPositionId;
  /** The position that has to answer. */
  to: ControllerPositionId;
  aircraftId: string;
  callsign: string;
  spokenCallsign: string;
  /** CROSSING: runway id ("13/31"). */
  runwayId?: string;
  /** CROSSING: the point / intersection of the operation (3-1-3), e.g. the taxiway "A". EXIT: the taxiway of the exit asked for. */
  point?: string;
  /** EXIT: the side of the exit ("exit left at Charlie"). */
  exitSide?: 'left' | 'right';
  /** EXIT: "hold short of runway N after landing": the intersecting runway id ("13/31"). */
  holdShortRunwayId?: string;
  /** GAP: how many departures wait for the gap (the request is made for the first, `aircraftId`). */
  departures?: number;
  /** GAP: the departure runway end ("22"): the request names the end, not the runway ("4/22"). */
  runwayEnd?: string;
  /** POINT_OUT: position of the target relative to a fix ("two miles west of Cedar Lake") and altitude. */
  positionText?: string;
  altitudeFt?: number;
  createdSec: number;
  /** Last time the request was made (a repeat updates it). */
  lastAskSec: number;
  asks: number;
  status: CoordStatus;
  answeredSec?: number;
  approvedSec?: number;
  /** An approval is not valid after this time. */
  expiresSec?: number;
  /** "After the landing Spirit": the approval is for after this aircraft has landed and cleared the runway (callsign + id). GAP: the gap Approach builds follows this arrival. */
  afterCallsign?: string;
  afterAircraftId?: string;
  reason?: string;
  usedSec?: number;
  /** RELEASE: this request renews the (still valid) release with this id: it does not count as a new release for the spacing between departures. */
  renewalOf?: string;
  /** CROSSING: the aircraft has been seen on the runway since the approval was used. */
  onRunway?: boolean;
  source: CoordSource;
}

export interface CoordMessage {
  id: string;
  timeSec: number;
  from: ControllerPositionId;
  to: ControllerPositionId;
  kind: CoordMessageKind;
  requestId?: string;
  topic?: CoordTopic;
  aircraftId?: string;
  callsign?: string;
  runwayId?: string;
  /** What was said, with digits ("Tower, Ground, request to cross runway 13 at A ..."), and the TTS form with words. */
  text: string;
  spoken: string;
  /** True when the wording is the FAA's (3-1-3, 4-3-4, 5-4-3); false = plain words, not from the order. */
  standard: boolean;
  reference?: string;
  source: CoordSource;
}

export interface CoordinationState {
  seq: number;
  requests: CoordRequest[];
  messages: CoordMessage[];
  /** Positions a human works. A human who works both positions of a pair coordinates with himself (no message, no rule). */
  human: ControllerPositionId[];
  /** Positions that are worked at all (human or AI). */
  staffed: ControllerPositionId[];
}

export function newCoordinationState(scenario: Pick<Scenario, 'controllerPositions' | 'playerPositions'>): CoordinationState {
  const all = [...new Set(scenario.controllerPositions)];
  return { seq: 0, requests: [], messages: [], human: [...new Set(scenario.playerPositions?.length ? scenario.playerPositions : all)], staffed: all };
}

const MESSAGE_CAP = 400;
const REQUEST_CAP = 200;

// ---------------------------------------------------------------------------
// Pure queries (state only; the AI uses them too)
// ---------------------------------------------------------------------------

const coord = (state: SimulationState): CoordinationState => {
  if (!state.coordination) state.coordination = newCoordinationState(state.scenario);
  return state.coordination;
};

export const isStaffed = (state: SimulationState, p: ControllerPositionId): boolean => coord(state).staffed.includes(p);
export const isHuman = (state: SimulationState, p: ControllerPositionId): boolean => coord(state).human.includes(p);
/** The same person works both positions: nothing to coordinate. */
export const sameController = (state: SimulationState, a: ControllerPositionId, b: ControllerPositionId): boolean =>
  a === b || (isHuman(state, a) && isHuman(state, b));

/** Is the runway one of the active runways (a landing or departing end of the configuration)? */
export function runwayIsActive(state: SimulationState, rw: Runway): boolean {
  const ends = new Set(rw.ends.map((e) => e.id));
  return [...state.activeRunways.departing, ...state.activeRunways.landing].some((e) => ends.has(e));
}

/**
 * Does a crossing authorised by `issuer` need Tower's approval (3-1-3)? Ground crossing an ACTIVE runway while Tower is a separate controller.
 * Training/other modes alike: the rule is the same, the consequence differs (see the engine rule in commandExecutor.ts).
 */
export function crossingNeedsApproval(state: SimulationState, issuer: ControllerPositionId, rw: Runway): boolean {
  const scenarioRule = state.scenario.coordination?.crossingApprovalRequired;
  if (scenarioRule === false) return false;
  if (issuer !== 'GND') return false;
  if (!isStaffed(state, 'TWR') || sameController(state, 'GND', 'TWR')) return false;
  return runwayIsActive(state, rw);
}

/** The position that releases departures: Departure when it exists, else Approach (Approach also works the departures then). */
export function releasePosition(state: SimulationState): ControllerPositionId | undefined {
  if (isStaffed(state, 'DEP')) return 'DEP';
  if (isStaffed(state, 'APP')) return 'APP';
  return undefined;
}

/** Does Tower's takeoff clearance to `ac` need a release (LOA concept; scenario setting, default on when a separate DEP/APP exists)? */
export function releaseNeeded(state: SimulationState, issuer: ControllerPositionId, ac: Pick<Aircraft, 'flightPlan'>): ControllerPositionId | undefined {
  if (state.scenario.coordination?.releasesRequired === false) return undefined;
  if (issuer !== 'TWR' || ac.flightPlan?.flightRules !== 'IFR') return undefined;
  const dep = releasePosition(state);
  if (!dep || sameController(state, 'TWR', dep)) return undefined;
  return dep;
}

const isOpen = (r: CoordRequest, now: number): boolean =>
  r.status === 'pending' || r.status === 'standby' || (r.status === 'approved' && (r.expiresSec === undefined || now < r.expiresSec));

export function findOpenRequest(state: SimulationState, topic: CoordTopic, aircraftId: string, runwayId?: string): CoordRequest | undefined {
  const now = state.clock.timeSec;
  for (let i = coord(state).requests.length - 1; i >= 0; i--) {
    const r = coord(state).requests[i];
    if (r.topic === topic && r.aircraftId === aircraftId && (runwayId === undefined || r.runwayId === runwayId) && isOpen(r, now)) return r;
  }
  return undefined;
}

/** A current approval (crossing) or release for this aircraft: approved, not expired, not yet used. */
export function validApproval(state: SimulationState, topic: CoordTopic, aircraftId: string, runwayId?: string): CoordRequest | undefined {
  const now = state.clock.timeSec;
  for (let i = coord(state).requests.length - 1; i >= 0; i--) {
    const r = coord(state).requests[i];
    if (r.topic === topic && r.aircraftId === aircraftId && (runwayId === undefined || r.runwayId === runwayId) && r.status === 'approved' && (r.expiresSec === undefined || now < r.expiresSec)) return r;
  }
  return undefined;
}

/** Requests the position still has to answer (pending or on stand-by), oldest first. */
export function awaitingAnswer(state: SimulationState, position: ControllerPositionId): CoordRequest[] {
  return coord(state).requests.filter((r) => r.to === position && (r.status === 'pending' || r.status === 'standby'));
}

export function requestById(state: SimulationState, id: string): CoordRequest | undefined {
  return coord(state).requests.find((r) => r.id === id);
}

/** "after the landing Spirit": has the aircraft the approval waits for landed and cleared the runway (or gone)? */
export function afterAircraftClear(state: SimulationState, req: Pick<CoordRequest, 'afterAircraftId' | 'runwayId'>): boolean {
  if (!req.afterAircraftId) return true;
  const other = state.aircraft[req.afterAircraftId];
  if (!other) return true;
  if (!other.onGround) return false;
  return !(req.runwayId && other.occupyingRunways.includes(req.runwayId)) && other.phase !== 'LANDING' && other.phase !== 'ROLLOUT';
}

/** The taxiway at which the aircraft will cross: the hold position it stands at or the next one on its route. */
export function crossingPointFor(state: SimulationState, ac: Aircraft, runwayId: string): string | undefined {
  const graph = state.airport.taxiwayGraph;
  const route = ac.route;
  if (route) {
    for (let i = Math.max(0, route.progressIndex - 1); i < route.nodeIds.length; i++) {
      const n = graph.nodes[route.nodeIds[i]];
      if (n && n.kind === 'holding_position' && n.runwayId === runwayId) return n.taxiways.find((t) => !t.startsWith('RWY')) ?? n.taxiways[0];
    }
  }
  let best: { id: string; d: number } | undefined;
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== 'holding_position' || n.runwayId !== runwayId) continue;
    const d = Math.hypot(n.pos.x - ac.pos.x, n.pos.y - ac.pos.y);
    if (!best || d < best.d) best = { id: n.taxiways.find((t) => !t.startsWith('RWY')) ?? n.taxiways[0] ?? '', d };
  }
  return best && best.id ? best.id : undefined;
}

// ---------------------------------------------------------------------------
// Phraseology
// ---------------------------------------------------------------------------

const runwayName = (runwayId: string): string => (runwayId.includes('/') ? runwayId.split('/')[0] : runwayId).replace(/^0/, '');
const addressee = (to: ControllerPositionId, from: ControllerPositionId): string => `${positionWord(to)}, ${positionWord(from)}`;

interface Said { text: string; spoken: string; standard: boolean; reference?: string }

/** The wording of a message (digits and words). Exported for the parser tests and the AI. */
export function describeMessage(
  kind: CoordMessageKind,
  m: {
    from: ControllerPositionId; to: ControllerPositionId; spokenCallsign?: string; runwayId?: string; point?: string; afterCallsign?: string;
    afterSpoken?: string; reason?: string; positionText?: string; altitudeFt?: number; extra?: string;
    exitSide?: 'left' | 'right'; holdShortRunwayId?: string; departures?: number; runwayEnd?: string;
  },
): Said {
  const head = addressee(m.to, m.from);
  const cs = m.spokenCallsign ?? '';
  const rwyT = m.runwayId ? `runway ${runwayName(m.runwayId)}` : 'the runway';
  const rwyS = m.runwayId ? `runway ${spokenRunway(m.runwayId)}` : 'the runway';
  const atT = m.point ? ` at ${m.point}` : '';
  const atS = m.point ? ` at ${spokenTaxiway(m.point)}` : '';
  const say = (t: string, s: string, standard: boolean, reference?: string): Said => ({ text: `${head}, ${t}`, spoken: `${head}, ${s}`, standard, reference });
  switch (kind) {
    case 'CROSS_REQUEST':
      return say(`request cross ${rwyT}${atT} with ${cs}`, `request cross ${rwyS}${atS} with ${cs}`, false, '3-1-3 (the request wording is not prescribed)');
    case 'CROSS_APPROVED': {
      const after = m.afterCallsign ? `, behind the landing ${m.afterSpoken ?? m.afterCallsign}` : '';
      return say(`cross ${rwyT}${atT}${after}`, `cross ${rwyS}${atS}${after}`, !m.afterCallsign, '3-1-3 phraseology CROSS (runway) AT (point/intersection)');
    }
    case 'CROSS_UNABLE':
      return say(`unable${m.reason ? `, ${m.reason}` : ''}, hold short ${rwyT}`, `unable${m.reason ? `, ${m.reason}` : ''}, hold short ${rwyS}`, false, '3-1-3 (the refusal wording is not prescribed)');
    case 'CROSS_STANDBY':
      return say(`unable${m.reason ? `, ${m.reason}` : ''}, I'll call you back`, `unable${m.reason ? `, ${m.reason}` : ''}, I'll call you back`, false);
    case 'CROSS_RESCINDED':
      return say(`hold short ${rwyT}${m.reason ? `, ${m.reason}` : ''}, disregard the crossing`, `hold short ${rwyS}${m.reason ? `, ${m.reason}` : ''}, disregard the crossing`, false);
    case 'CROSS_COMPLETE':
      return say(`${cs} across ${rwyT}`, `${cs} across ${rwyS}`, false, '3-1-3 (advice of completion; verbal or visual aid)');
    case 'EXIT_REQUEST': {
      // "have Spirit ten thirty three exit left at Charlie" / "... hold short of runway four after landing"
      const parts = [m.point || m.exitSide ? `exit${m.exitSide ? ` ${m.exitSide}` : ''}${m.point ? ` at ${m.point}` : ''}` : '', m.holdShortRunwayId ? `hold short of runway ${runwayName(m.holdShortRunwayId)} after landing` : ''].filter(Boolean);
      const partsS = [m.point || m.exitSide ? `exit${m.exitSide ? ` ${m.exitSide}` : ''}${m.point ? ` at ${spokenTaxiway(m.point)}` : ''}` : '', m.holdShortRunwayId ? `hold short of runway ${spokenRunway(m.holdShortRunwayId)} after landing` : ''].filter(Boolean);
      return say(`have ${cs} ${parts.join(', ')}`, `have ${cs} ${partsS.join(', ')}`, false, '3-1-4 (the wording of the request is not prescribed); the instruction to the pilot is 3-10-9');
    }
    case 'EXIT_APPROVED': {
      const what = [m.exitSide || m.point ? `exit${m.exitSide ? ` ${m.exitSide}` : ''}${m.point ? ` at ${m.point}` : ''}` : '', m.holdShortRunwayId ? `hold short of runway ${runwayName(m.holdShortRunwayId)}` : ''].filter(Boolean);
      const whatS = [m.exitSide || m.point ? `exit${m.exitSide ? ` ${m.exitSide}` : ''}${m.point ? ` at ${spokenTaxiway(m.point)}` : ''}` : '', m.holdShortRunwayId ? `hold short of runway ${spokenRunway(m.holdShortRunwayId)}` : ''].filter(Boolean);
      return say(`${cs} will ${what.join(', ')}`, `${cs} will ${whatS.join(', ')}`, false, '3-1-4 (plain words); 3-10-9 instruction issued to the pilot');
    }
    case 'EXIT_UNABLE':
      return say(`unable${m.reason ? `, ${m.reason}` : ''}`, `unable${m.reason ? `, ${m.reason}` : ''}`, false, '3-1-4 (plain words)');
    case 'GAP_REQUEST': {
      const n = m.departures ?? 1;
      const forWhat = n > 1 ? `${n === 2 ? 'two' : n === 3 ? 'three' : String(n)} departures` : 'a departure';
      const forWhatT = n > 1 ? `${n} departures` : 'a departure';
      const gapRwyT = m.runwayEnd ? `runway ${m.runwayEnd.replace(/^0/, '')}` : rwyT;
      const gapRwyS = m.runwayEnd ? `runway ${spokenRunway(m.runwayEnd)}` : rwyS;
      return say(`need a gap for ${forWhatT} ${gapRwyT}`, `need a gap for ${forWhat} ${gapRwyS}`, false, '3-8-1 / 3-9-5 / 2-1-14 (a gap request is not phraseology of the order)');
    }
    case 'GAP_APPROVED': {
      const after = m.afterCallsign ? `gap after ${m.afterSpoken ?? m.afterCallsign}` : 'gap available now';
      const afterT = m.afterCallsign ? `gap after ${m.afterCallsign}` : 'gap available now';
      return say(afterT, after, false, '3-8-1 / 5-7-1 (the answer is plain words)');
    }
    case 'GAP_UNABLE':
      return say(`unable${m.reason ? `, ${m.reason}` : ''}`, `unable${m.reason ? `, ${m.reason}` : ''}`, false, '3-8-1 (plain words)');
    case 'GAP_STANDBY':
      return say(`stand by${m.reason ? `, ${m.reason}` : ''}`, `stand by${m.reason ? `, ${m.reason}` : ''}`, false);
    case 'RELEASE_REQUEST':
      return say(`request release ${cs}`, `request release ${cs}`, false, '4-3-4 / LOA (the request wording is not prescribed)');
    case 'RELEASED':
      return say(`${cs} released`, `${cs} released`, true, '4-3-4 phraseology (aircraft identification) RELEASED');
    case 'HOLD_FOR_RELEASE':
      return say(`${cs} hold for release${m.reason ? `, ${m.reason}` : ''}`, `${cs} hold for release${m.reason ? `, ${m.reason}` : ''}`, true, '4-3-4 Hold For Release');
    case 'RELEASE_STANDBY':
      return say(`${cs} stand by for release`, `${cs} stand by for release`, false);
    case 'POINT_OUT': {
      const alt = m.altitudeFt !== undefined ? `, ${m.altitudeFt}` : '';
      const altS = m.altitudeFt !== undefined ? `, ${spokenAltitude(m.altitudeFt)}` : '';
      return say(`point out, ${m.positionText ?? 'position unknown'}, ${cs}${alt}${m.extra ? `, ${m.extra}` : ''}`, `point out, ${m.positionText ?? 'position unknown'}, ${cs}${altS}${m.extra ? `, ${m.extra}` : ''}`, true, '5-4-3 phraseology POINT-OUT (aircraft position), (aircraft ID), (altitude, restrictions)');
    }
    case 'POINT_OUT_APPROVED':
      return say(`${cs} point out approved`, `${cs} point out approved`, true, '5-4-3 POINT OUT APPROVED');
    case 'POINT_OUT_UNABLE':
      return say(`${cs} unable${m.reason ? `, ${m.reason}` : ''}`, `${cs} unable${m.reason ? `, ${m.reason}` : ''}`, true, '5-4-3 UNABLE (appropriate information)');
    case 'TRAFFIC_OBSERVED':
      return say('traffic observed', 'traffic observed', true, '5-4-3 TRAFFIC OBSERVED');
    case 'ROLLING':
      return say(`${cs} rolling${m.runwayId ? ` runway ${runwayName(m.runwayId)}` : ''}`, `${cs} rolling${m.runwayId ? ` runway ${spokenRunway(m.runwayId)}` : ''}`, false);
    case 'GOING_AROUND':
      return say(`${cs} going around${m.runwayId ? `, runway ${runwayName(m.runwayId)}` : ''}`, `${cs} going around${m.runwayId ? `, runway ${spokenRunway(m.runwayId)}` : ''}`, false);
    case 'TRAFFIC':
      return say(`traffic, ${m.extra ?? ''}`.trim(), `traffic, ${m.extra ?? ''}`.trim(), false, '5-4-4 Traffic (wording of the information is not prescribed)');
    case 'TEXT':
    default:
      return say(m.extra ?? '', m.extra ?? '', false);
  }
}

// ---------------------------------------------------------------------------
// Operations (engine side)
// ---------------------------------------------------------------------------

function trim(c: CoordinationState): void {
  if (c.messages.length > MESSAGE_CAP) c.messages.splice(0, c.messages.length - MESSAGE_CAP);
  if (c.requests.length > REQUEST_CAP) {
    const open = (r: CoordRequest) => r.status === 'pending' || r.status === 'standby' || r.status === 'approved' || r.status === 'used';
    const keep = c.requests.filter(open);
    const closed = c.requests.filter((r) => !open(r)).slice(-(REQUEST_CAP - keep.length));
    c.requests = [...keep, ...closed].sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
  }
}

function post(
  ctx: SimContext, kind: CoordMessageKind, from: ControllerPositionId, to: ControllerPositionId, source: CoordSource,
  req: CoordRequest | undefined,
  said: Said, extra: { aircraft?: Aircraft; runwayId?: string } = {},
): CoordMessage {
  const c = coord(ctx.state);
  const msg: CoordMessage = {
    id: `cm-${++c.seq}`, timeSec: ctx.state.clock.timeSec, from, to, kind,
    requestId: req?.id, topic: req?.topic,
    aircraftId: req?.aircraftId ?? extra.aircraft?.id, callsign: req?.callsign ?? extra.aircraft?.callsign,
    runwayId: req?.runwayId ?? extra.runwayId, text: said.text, spoken: said.spoken, standard: said.standard, reference: said.reference, source,
  };
  if (ctx.dryRun) return msg;
  c.messages.push(msg);
  trim(c);
  emitEvent(ctx, {
    kind: 'COORDINATION', aircraftId: msg.aircraftId, callsign: msg.callsign, text: `[${from}>${to}] ${said.text}`, severity: 'info',
    speaker: source === 'system' ? 'SYSTEM' : 'ATC', aiPosition: source === 'ai' ? from : undefined,
    data: { coord: true, msgId: msg.id, msgKind: kind, from, to, requestId: req?.id, topic: req?.topic, standard: said.standard, spoken: said.spoken },
  });
  return msg;
}

export interface RequestInput {
  topic: CoordTopic;
  from: ControllerPositionId;
  to: ControllerPositionId;
  aircraftId: string;
  runwayId?: string;
  point?: string;
  /** EXIT: the side of the exit asked for, and the intersecting runway to hold short of after landing. */
  exitSide?: 'left' | 'right';
  holdShortRunwayId?: string;
  positionText?: string;
  altitudeFt?: number;
  /** POINT_OUT: restrictions / other pertinent information. */
  extra?: string;
  /** GAP: the number of departures that wait for the gap, and the runway end they depart from. */
  departures?: number;
  runwayEnd?: string;
  /** RELEASE: ask again while the current release is about to lapse (a second request; the current release stays valid until it lapses or is used). */
  renew?: boolean;
  source: CoordSource;
}

/** Make (or repeat) a request. A request that is already open for the same aircraft / runway is repeated, not duplicated. */
export function coordRequest(ctx: SimContext, input: RequestInput): CoordRequest | undefined {
  const { state } = ctx;
  const ac = state.aircraft[input.aircraftId];
  if (!ac) return undefined;
  const c = coord(state);
  const now = state.clock.timeSec;
  let runwayId = input.runwayId;
  if (runwayId) runwayId = findRunway(state.airport, runwayId)?.id ?? runwayId;
  const open = findOpenRequest(state, input.topic, ac.id, runwayId);
  const renewing = !!open && open.status === 'approved' && input.renew === true && open.topic === 'RELEASE' && open.expiresSec !== undefined && open.expiresSec - now <= COORDINATION_DESIGN.releaseRenewBeforeSec;
  if (open && open.to === input.to && !renewing) {
    if (open.status === 'approved') return open; // already approved: nothing to ask
    if (now - open.lastAskSec < COORDINATION_DESIGN.duplicateWindowSec) return open;
    open.asks++;
    open.lastAskSec = now;
    if (input.point) open.point = input.point;
    post(ctx, kindOfRequest(open.topic), open.from, open.to, input.source, open, describeMessage(kindOfRequest(open.topic), { from: open.from, to: open.to, spokenCallsign: ac.spokenCallsign, runwayId: open.runwayId, point: open.point, positionText: open.positionText, altitudeFt: open.altitudeFt, extra: input.extra, exitSide: open.exitSide, holdShortRunwayId: open.holdShortRunwayId, departures: open.departures, runwayEnd: open.runwayEnd }));
    return open;
  }
  if (ctx.dryRun) return undefined;
  const req: CoordRequest = {
    id: `cr-${++c.seq}`, topic: input.topic, from: input.from, to: input.to, aircraftId: ac.id, callsign: ac.callsign, spokenCallsign: ac.spokenCallsign,
    runwayId, point: input.point ?? (runwayId && input.topic === 'CROSSING' ? crossingPointFor(state, ac, runwayId) : undefined),
    exitSide: input.exitSide, holdShortRunwayId: input.holdShortRunwayId ? findRunway(state.airport, input.holdShortRunwayId)?.id ?? input.holdShortRunwayId : undefined,
    positionText: input.positionText, altitudeFt: input.altitudeFt, departures: input.topic === 'GAP' ? Math.max(1, Math.round(input.departures ?? 1)) : undefined, runwayEnd: input.topic === 'GAP' ? input.runwayEnd : undefined, createdSec: now, lastAskSec: now, asks: 1, status: 'pending', source: input.source,
    ...(renewing ? { renewalOf: open.id } : {}),
  };
  c.requests.push(req);
  const kind = kindOfRequest(req.topic);
  post(ctx, kind, req.from, req.to, input.source, req, describeMessage(kind, { from: req.from, to: req.to, spokenCallsign: ac.spokenCallsign, runwayId: req.runwayId, point: req.point, positionText: req.positionText, altitudeFt: req.altitudeFt, extra: input.extra, exitSide: req.exitSide, holdShortRunwayId: req.holdShortRunwayId, departures: req.departures, runwayEnd: req.runwayEnd }));
  return req;
}

const kindOfRequest = (t: CoordTopic): CoordMessageKind => (t === 'CROSSING' ? 'CROSS_REQUEST' : t === 'RELEASE' ? 'RELEASE_REQUEST' : t === 'EXIT' ? 'EXIT_REQUEST' : t === 'GAP' ? 'GAP_REQUEST' : 'POINT_OUT');

export interface RespondOptions {
  by: ControllerPositionId;
  source: CoordSource;
  /** Approve only: "after the landing <callsign>". */
  afterAircraftId?: string;
  /** EXIT, approve: the exit Tower will actually have the pilot take (it may differ from the one asked for: the request named only a side). */
  exitTaxiway?: string;
  exitSide?: 'left' | 'right';
  reason?: string;
}

export type CoordAnswer = 'approve' | 'deny' | 'standby';

/** The answering position's reply to an open request. */
export function coordRespond(ctx: SimContext, requestId: string, answer: CoordAnswer, o: RespondOptions): CoordRequest | undefined {
  const { state } = ctx;
  const req = requestById(state, requestId);
  if (!req || (req.status !== 'pending' && req.status !== 'standby')) return req;
  const ac = state.aircraft[req.aircraftId];
  const now = state.clock.timeSec;
  const after = o.afterAircraftId ? state.aircraft[o.afterAircraftId] : undefined;
  const base = { from: req.to, to: req.from, spokenCallsign: req.spokenCallsign, runwayId: req.runwayId, point: req.point, reason: o.reason, exitSide: req.exitSide, holdShortRunwayId: req.holdShortRunwayId };
  if (ctx.dryRun) return req;
  const apply = (status: CoordStatus, kind: CoordMessageKind, extra: Partial<Parameters<typeof describeMessage>[1]> = {}): void => {
    req.status = status;
    req.answeredSec = now;
    if (o.reason) req.reason = o.reason;
    post(ctx, kind, req.to, req.from, o.source, req, describeMessage(kind, { ...base, ...extra }), { aircraft: ac });
  };
  switch (req.topic) {
    case 'CROSSING':
      if (answer === 'approve') {
        req.approvedSec = now;
        req.expiresSec = now + COORDINATION_DESIGN.crossingApprovalTtlSec;
        req.afterAircraftId = after?.id;
        req.afterCallsign = after?.callsign;
        apply('approved', 'CROSS_APPROVED', { afterCallsign: after?.callsign, afterSpoken: after?.spokenCallsign });
      } else if (answer === 'deny') apply('denied', 'CROSS_UNABLE');
      else apply('standby', 'CROSS_STANDBY');
      break;
    case 'RELEASE':
      if (answer === 'approve') {
        req.approvedSec = now;
        req.expiresSec = now + COORDINATION_DESIGN.releaseTtlSec;
        apply('approved', 'RELEASED');
      } else if (answer === 'deny') apply('denied', 'HOLD_FOR_RELEASE');
      else apply('standby', 'RELEASE_STANDBY');
      break;
    case 'EXIT':
      if (answer === 'approve') {
        req.approvedSec = now;
        req.expiresSec = now + COORDINATION_DESIGN.exitRequestTtlSec;
        apply('approved', 'EXIT_APPROVED', { point: o.exitTaxiway ?? req.point, exitSide: o.exitSide ?? req.exitSide });
      } else if (answer === 'deny') apply('denied', 'EXIT_UNABLE');
      else apply('standby', 'TEXT', { extra: 'stand by' });
      break;
    case 'GAP':
      if (answer === 'approve') {
        req.approvedSec = now;
        req.expiresSec = now + COORDINATION_DESIGN.gapTtlSec;
        req.afterAircraftId = after?.id;
        req.afterCallsign = after?.callsign;
        apply('approved', 'GAP_APPROVED', { afterCallsign: after?.callsign, afterSpoken: after?.spokenCallsign });
      } else if (answer === 'deny') apply('denied', 'GAP_UNABLE');
      else apply('standby', 'GAP_STANDBY');
      break;
    case 'POINT_OUT':
      if (answer === 'approve') {
        req.approvedSec = now;
        apply('completed', 'POINT_OUT_APPROVED');
      } else if (answer === 'deny') apply('denied', 'POINT_OUT_UNABLE');
      else apply('standby', 'TEXT', { extra: 'stand by' });
      break;
  }
  return req;
}

/** The answering position takes an approval back ("hold short, traffic on final"). Only an approval that has not been used. */
export function coordRescind(ctx: SimContext, requestId: string, o: { by: ControllerPositionId; source: CoordSource; reason?: string }): CoordRequest | undefined {
  const req = requestById(ctx.state, requestId);
  if (!req || req.status !== 'approved' || ctx.dryRun) return req;
  req.status = 'rescinded';
  req.reason = o.reason;
  const ac = ctx.state.aircraft[req.aircraftId];
  const kind: CoordMessageKind = req.topic === 'RELEASE' ? 'HOLD_FOR_RELEASE' : 'CROSS_RESCINDED';
  post(ctx, kind, req.to, req.from, o.source, req, describeMessage(kind, { from: req.to, to: req.from, spokenCallsign: req.spokenCallsign, runwayId: req.runwayId, point: req.point, reason: o.reason }), { aircraft: ac });
  return req;
}

export interface InformInput {
  kind: 'ROLLING' | 'GOING_AROUND' | 'TRAFFIC' | 'TEXT' | 'TRAFFIC_OBSERVED' | 'CROSS_COMPLETE';
  from: ControllerPositionId;
  to: ControllerPositionId;
  aircraftId?: string;
  runwayId?: string;
  text?: string;
  source: CoordSource;
}

/** Information that needs no answer: "rolling", "going around", traffic, free text. */
export function coordInform(ctx: SimContext, input: InformInput): CoordMessage | undefined {
  const ac = input.aircraftId ? ctx.state.aircraft[input.aircraftId] : undefined;
  const said = describeMessage(input.kind, { from: input.from, to: input.to, spokenCallsign: ac?.spokenCallsign, runwayId: input.runwayId, extra: input.text });
  return post(ctx, input.kind, input.from, input.to, input.source, undefined, said, { aircraft: ac, runwayId: input.runwayId });
}

/** The approval was used by an accepted command: it cannot be used twice. */
export function coordConsume(ctx: SimContext, req: CoordRequest): void {
  if (ctx.dryRun) return;
  req.status = 'used';
  req.usedSec = ctx.state.clock.timeSec;
  // A release that was renewed while the departure waited: the renewal (or the release it renewed) is of no use any more.
  if (req.topic === 'RELEASE') {
    for (const o of ctx.state.coordination?.requests ?? []) {
      if (o !== req && o.topic === 'RELEASE' && o.aircraftId === req.aircraftId && (o.status === 'pending' || o.status === 'standby' || o.status === 'approved')) o.status = 'completed';
    }
  }
}

/** A coordination rule was broken (free play / career): logged as an event; the score counts it (scoring.ts). */
export function coordError(ctx: SimContext, ac: Aircraft, rule: 'crossing' | 'release', text: string): void {
  if (ctx.dryRun) return;
  emitEvent(ctx, {
    kind: 'COORDINATION', aircraftId: ac.id, callsign: ac.callsign, text, severity: 'warning', speaker: 'SYSTEM', aiPosition: ctx.currentAi,
    data: { error: true, rule, reference: COORDINATION_REFERENCES[rule] },
  });
}

/** Per tick: expire stale approvals and requests, close crossings that are done, forget requests of aircraft that are gone. */
export function updateCoordination(ctx: SimContext): void {
  const { state } = ctx;
  const c = state.coordination;
  if (!c || c.requests.length === 0) return;
  const now = state.clock.timeSec;
  for (const r of c.requests) {
    const ac = state.aircraft[r.aircraftId];
    switch (r.status) {
      case 'pending':
      case 'standby':
        if (!ac || now - r.lastAskSec > COORDINATION_DESIGN.openRequestTimeoutSec || (r.topic === 'GAP' && ac.phase !== 'HOLDING_SHORT' && ac.phase !== 'LINE_UP_AND_WAIT' && ac.phase !== 'READY' && ac.phase !== 'TAXIING')) r.status = 'expired';
        break;
      case 'approved':
        if (!ac) r.status = 'expired';
        else if (r.topic === 'EXIT' && ((ac.onGround && ac.phase !== 'ROLLOUT' && ac.phase !== 'LANDING') || ac.phase === 'GO_AROUND')) r.status = 'completed'; // landed and clear, or sent around: nothing left to arrange
        else if (r.topic === 'GAP' && ac.phase !== 'HOLDING_SHORT' && ac.phase !== 'LINE_UP_AND_WAIT' && ac.phase !== 'READY' && ac.phase !== 'TAXIING') r.status = 'completed'; // the departure has its takeoff clearance: the gap was used
        else if (r.topic === 'CROSSING' && r.afterAircraftId && !afterAircraftClear(state, r)) {
          r.expiresSec = now + COORDINATION_DESIGN.crossingApprovalTtlSec; // "behind the landing X": the interval starts when X is clear
        } else if (r.expiresSec !== undefined && now >= r.expiresSec) {
          r.status = 'expired';
          if (r.topic === 'RELEASE' || r.topic === 'CROSSING') {
            const kind: CoordMessageKind = 'TEXT';
            post(ctx, kind, r.to, r.from, 'system', r, { text: `${positionWord(r.from)}: the ${r.topic === 'RELEASE' ? 'release' : 'crossing approval'} for ${r.callsign} has expired`, spoken: '', standard: false });
          }
        }
        break;
      case 'used':
        if (r.topic !== 'CROSSING') break;
        if (!ac) {
          r.status = 'completed';
          break;
        }
        if (r.runwayId && ac.occupyingRunways.includes(r.runwayId)) r.onRunway = true;
        if ((r.onRunway && !ac.occupyingRunways.includes(r.runwayId ?? '')) || now - (r.usedSec ?? now) > COORDINATION_DESIGN.crossingCloseSec) {
          r.status = 'completed';
          // 3-1-3: the ground controller advises local control that the coordinated runway operation is complete (here: the visual aid / strip).
          post(ctx, 'CROSS_COMPLETE', r.from, r.to, 'system', r, describeMessage('CROSS_COMPLETE', { from: r.from, to: r.to, spokenCallsign: r.spokenCallsign, runwayId: r.runwayId }), { aircraft: ac });
        }
        break;
      default:
        break;
    }
  }
}


// ---------------------------------------------------------------------------
// Engine rules (called by the command planners)
// ---------------------------------------------------------------------------

export interface Gate {
  /** Set when the command must be refused (training mode): the reason, with the order's paragraph. */
  refuse?: string;
  /** Called when the command is accepted: uses the approval / release, or records the coordination error. */
  commit(): void;
}

const NO_GATE: Gate = { commit: () => undefined };

/**
 * CROSS_RUNWAY by Ground on an active runway (7110.65 3-1-3): needs Tower's current approval for this aircraft and runway, unless the same
 * person works both positions (or Tower is not staffed). Training refuses with the reason; other modes accept and score a coordination error.
 */
export function crossingGate(ctx: SimContext, ac: Aircraft, position: ControllerPositionId, rw: Runway): Gate {
  const { state } = ctx;
  if (!crossingNeedsApproval(state, position, rw)) return NO_GATE;
  const approval = validApproval(state, 'CROSSING', ac.id, rw.id);
  const waitingFor = approval && !afterAircraftClear(state, approval) ? state.aircraft[approval.afterAircraftId ?? ''] : undefined;
  if (approval && !waitingFor) return { commit: () => coordConsume(ctx, approval) };
  const why = waitingFor
    ? `Tower approved the crossing for after ${waitingFor.callsign}, which has not cleared runway ${rw.id} yet.`
    : `Runway ${rw.id} is active and Tower has not approved ${ac.callsign} to cross: ground control must obtain approval from local control before authorizing an aircraft or vehicle to cross or use any portion of an active runway (${COORDINATION_REFERENCES.crossing}). Ask Tower on the landline first.`;
  if (state.scenario.mode === 'training') return { refuse: why, commit: () => undefined };
  return { commit: () => coordError(ctx, ac, 'crossing', `${ac.callsign} authorised to cross runway ${rw.id} without Tower's approval (${COORDINATION_REFERENCES.crossing})`) };
}

/** TAKEOFF by Tower for an IFR departure when a separate Departure/Approach position must release it (LOA concept, 4-3-4). */
export function releaseGate(ctx: SimContext, ac: Aircraft, position: ControllerPositionId): Gate {
  const { state } = ctx;
  const dep = releaseNeeded(state, position, ac);
  if (!dep) return NO_GATE;
  const rel = validApproval(state, 'RELEASE', ac.id);
  if (rel) return { commit: () => coordConsume(ctx, rel) };
  const why = `${ac.callsign} has no departure release from ${positionWord(dep)}: with a separate ${positionWord(dep)} position an IFR departure is released before the takeoff clearance (${COORDINATION_REFERENCES.release}). Request the release on the landline first.`;
  if (state.scenario.mode === 'training') return { refuse: why, commit: () => undefined };
  return { commit: () => coordError(ctx, ac, 'release', `${ac.callsign} cleared for takeoff without a release from ${positionWord(dep)} (${COORDINATION_REFERENCES.release})`) };
}
