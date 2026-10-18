/**
 * Command executor: the only place where controller instructions change aircraft state.
 *
 * Pipeline: log ATC transmission -> resolve aircraft -> confidence/entity gate -> frequency check
 * -> duplicate (idempotency) check -> readback-error correction -> per-kind validation producing a Plan
 * -> safety assessment (training: refuse, otherwise: accept + flag + score) -> commit -> pilot readback.
 *
 * To add a command: add the kind to `requiredEntities`, write a `plan<Kind>` function returning
 * `{ plan }` or `{ reject }`, add it to the `PLANNERS` table, and add readback phrasing in
 * src/radio/readback.ts.
 */
import type {
  Aircraft, Airport, Clearance, ClearanceKind, CommandOutcome, ControllerPositionId, ParsedCommand, Runway, TaxiNode, TaxiwayGraph, Vec2,
} from './types';
import { dist, ftToM, headingDiff, magneticToTrue, nmToM } from './geo';
import {
  activeClearance, advancePhase, completeClearances, emitEvent, getRuntime, perfOf, pilotSay, setPhase, speechDurationSec,
} from './context';
import type { AircraftRuntime, ReadbackErrorRecord, SimContext } from './context';
import { findRunway, findRunwayEnd, alongCross, normalizeRunwayEndId } from './runways';
import type { RunwayEndGeom } from './runways';
import { findTaxiRoute, nearestNode, neighborIds, runwayCrossingsAlong, shortestDistances } from './pathfinding';
import type { TaxiRoute } from './pathfinding';
import { pickRunwayHold, runwayHoldCandidates, runwayRemainingM, takeoffRunM } from './holdSelection';
import { spokenTaxiway } from '../radio/spoken';
import { computeStopNodes } from './groundMovement';
import { glideAltitudeFt, initiateGoAround } from './flightDynamics';
import { freeParkingCandidates, parkingOccupant, resolveParkingQuery } from './parkingResolver';
import { assessClearanceSafety, recordUnsafeClearance } from './conflicts';
import { frequencyById, frequencyByMhz, frequencyForPosition, hearsFrequency, formatMhz } from '../radio/frequencies';
import { buildReadback, buildSayAgain, buildUnable } from '../radio/readback';
import { spokenRunway } from '../radio/spoken';
import { SPEED_LIMIT_BELOW_10K_KT, lineUpTimeSec, patternAltitudeFt } from './performance';
import { findNavFix, indexOfFix } from './navigation';
import { effectiveComponents, exceedsLimits } from './wind';
import { startHold } from './holding';
import { publishedHoldFor } from './missedApproach';
import { assessApproach, ceilingFt } from './approach';
import { isDaylight, simUtcMs } from './solar';
import { buildIfrClearance } from './ifr';
import {
  luawTrafficIssue, noteAirportInfo, planAirportInfo, planCancelTakeoff, planExitRunway, planFollowTraffic, planFrequencyApproved, planLandingHoldShort, planPatternInstruction,
  planReportPosition, planSquawk, planTrafficAdvisory,
} from './towerCommands';

const DUPLICATE_WINDOW_SEC = 5;

/** A controller position covers all of its frequencies (KACY Departure: south 124.6 and north 134.25 are one position, DEP). */
function sameControllerPosition(airport: Airport, ac: Aircraft, position: ControllerPositionId): boolean {
  return airport.frequencies.some((f) => f.position === position && hearsFrequency(ac, f.mhz));
}
/** IFR departures tune Ground and ask for taxi this long after reading back their clearance. */
export const IFR_TAXI_REQUEST_DELAY_SEC = 15;
const TAKEOFF_NEAR_HOLD_M = 100;
const CROSS_APPROACH_M = 600;

export interface Reject {
  reason: string;
  pilot?: string;
  commError?: boolean;
}
export interface Plan {
  patch: Partial<Clearance>;
  commit: (clr: Clearance) => void;
  /** The instruction is flyable but improper (non-training modes accept it): scored as a communication error, not as a correct clearance. */
  flag?: string;
}
export type PlanResult = { plan: Plan } | { reject: Reject };

export interface Env {
  ctx: SimContext;
  ac: Aircraft;
  rt: AircraftRuntime;
  cmd: ParsedCommand;
  g?: RunwayEndGeom;
  airport: Airport;
  now: number;
  position: ControllerPositionId;
}

export const unable = (env: Env, reason: string, phrase: string, commError = true): { reject: Reject } => ({
  reject: { reason, pilot: buildUnable(env.ac, phrase), commError },
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

type ExecOpts = { position?: ControllerPositionId; source?: 'voice' | 'typed' | 'ai'; transmissionId?: string; aiPosition?: ControllerPositionId };

/** Execute a command. Events produced by an AI controller's command (`opts.aiPosition`) carry that `aiPosition` and are not scored for the player. */
export function executeCommand(ctx: SimContext, cmdIn: ParsedCommand, opts?: ExecOpts): CommandOutcome {
  const prevAi = ctx.currentAi;
  ctx.currentAi = opts?.aiPosition;
  if (opts?.aiPosition) ctx.aiSeen = true;
  try {
    return executeInner(ctx, cmdIn, opts);
  } finally {
    ctx.currentAi = prevAi;
  }
}

/**
 * Dry run: the same validation, safety gate and outcome as `executeCommand`, without executing, logging, speaking or scoring
 * anything (no events, no pilot call, no alert, no state change). Training: an unsafe clearance is `rejected` with `unsafe`;
 * other modes: `accepted` (the real call would flag it). The returned clearance is a preview (`id: 'dry-run'`).
 */
export function validateCommand(ctx: SimContext, cmdIn: ParsedCommand, opts?: ExecOpts): CommandOutcome {
  const prevDry = ctx.dryRun;
  ctx.dryRun = true;
  try {
    return executeInner(ctx, cmdIn, opts);
  } finally {
    ctx.dryRun = prevDry;
  }
}

function executeInner(ctx: SimContext, cmdIn: ParsedCommand, opts?: ExecOpts): CommandOutcome {
  const { state } = ctx;
  const airport = state.airport;
  const now = state.clock.timeSec;
  const position = opts?.position ?? state.controllerPosition;
  const ctrlFreq = frequencyForPosition(airport, position)?.mhz ?? state.controllerFrequencyMhz;

  const tid = opts?.transmissionId;
  if (!ctx.dryRun && (!tid || !ctx.loggedTransmissions.has(tid))) {
    if (tid) ctx.loggedTransmissions.add(tid);
    emitEvent(ctx, {
      kind: 'TRANSMISSION', callsign: cmdIn.callsign ?? undefined, text: cmdIn.rawText, severity: 'info', speaker: 'ATC',
      frequencyMhz: ctrlFreq, aiPosition: opts?.aiPosition, data: { source: opts?.source, transmissionId: tid, normalized: cmdIn.normalizedText },
    });
  }

  const clarify = (ac: Aircraft | undefined, question: string, commError: boolean): CommandOutcome => {
    emitEvent(ctx, {
      kind: 'CLARIFICATION', aircraftId: ac?.id, callsign: ac?.callsign ?? cmdIn.callsign ?? undefined, text: question, severity: 'info',
      speaker: 'SYSTEM', data: { commError, kind: cmdIn.kind },
    });
    if (ac && hearsFrequency(ac, ctrlFreq)) pilotSay(ctx, ac, buildSayAgain(ac), { clarify: true });
    return { status: 'clarify', question };
  };
  const reject = (ac: Aircraft | undefined, r: Reject, extra?: { unsafe?: boolean }): CommandOutcome => {
    emitEvent(ctx, {
      kind: 'COMMAND_REJECTED', aircraftId: ac?.id, callsign: ac?.callsign ?? cmdIn.callsign ?? undefined, text: r.reason, severity: 'warning',
      speaker: 'SYSTEM', data: { commError: !!r.commError, unsafe: !!extra?.unsafe, kind: cmdIn.kind },
    });
    if (ac && r.pilot) pilotSay(ctx, ac, r.pilot, { rejection: true });
    return { status: 'rejected', reason: r.reason, pilotResponse: r.pilot, unsafe: extra?.unsafe };
  };

  // --- resolve the aircraft -------------------------------------------------
  if (!cmdIn.callsign) {
    if (cmdIn.callsignCandidates && cmdIn.callsignCandidates.length > 1) {
      return clarify(undefined, `Which aircraft? ${cmdIn.callsignCandidates.join(' or ')}`, false);
    }
    return clarify(undefined, 'No callsign recognised. Say the aircraft callsign.', true);
  }
  const ac = Object.values(state.aircraft).find((a) => a.callsign.toUpperCase() === cmdIn.callsign!.toUpperCase());
  if (!ac) return clarify(undefined, `No aircraft "${cmdIn.callsign}" is on the airport or in the area.`, true);
  const rt = getRuntime(ctx, ac);

  if (cmdIn.kind === 'UNKNOWN') return clarify(ac, cmdIn.issues[0] ?? `Instruction not understood for ${ac.callsign}.`, false);

  // --- frequency ------------------------------------------------------------
  if (!hearsFrequency(ac, ctrlFreq) && !sameControllerPosition(airport, ac, position)) {
    const here = frequencyByMhz(airport, ac.frequencyMhz);
    const mine = frequencyByMhz(airport, ctrlFreq);
    return reject(ac, {
      reason: `Not on frequency: ${ac.callsign} is on ${formatMhz(ac.frequencyMhz)}${here ? ` (${here.id})` : ''}; you are transmitting on ${formatMhz(ctrlFreq)}${mine ? ` (${mine.id})` : ` (${position})`}.`,
      commError: true,
    });
  }

  if (cmdIn.kind === 'SAY_AGAIN') {
    const text = rt.lastPilotText ?? buildSayAgain(ac);
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} repeats last transmission`, severity: 'info', speaker: 'SYSTEM' });
    pilotSay(ctx, ac, text, { repeated: true });
    return { status: 'rejected', reason: 'Say-again request: pilot repeated the last transmission.', pilotResponse: text };
  }

  // --- confidence + required entities --------------------------------------
  if (cmdIn.confidence < 0.6) {
    return clarify(ac, cmdIn.issues[0] ?? `Low confidence (${cmdIn.confidence.toFixed(2)}); say again, ${ac.callsign}.`, false);
  }
  const { cmd, g } = normalizeCommand(airport, ac, cmdIn, cmdIn.confidence >= 0.8);
  const missing = missingEntities(cmd, g);
  if (missing.length) {
    return clarify(ac, `${ac.callsign}: missing ${missing.join(', ')}${cmdIn.confidence < 0.8 ? ' (confidence too low to assume)' : ''}.`, false);
  }

  const env: Env = { ctx, ac, rt, cmd, g, airport, now, position };

  // --- readback-error correction -------------------------------------------
  if (!ctx.dryRun && rt.readbackError && rt.readbackError.kind === (cmd.kind as string)) {
    const original = ac.clearances.find((c) => c.id === rt.readbackError!.clearanceId);
    if (original && sameParams(original, cmd, g)) {
      const rb = buildReadback(ac, original, { airport });
      emitEvent(ctx, {
        kind: 'READBACK_ERROR', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
        text: `Readback error from ${ac.callsign} corrected (said "${rt.readbackError.spoken}", correct "${rt.readbackError.correct}")`,
        data: { corrected: true },
      });
      rt.readbackError = undefined;
      ac.flags.readbackErrorPending = false;
      ac.flags.readbackErrorClearanceId = undefined;
      pilotSay(ctx, ac, rb.text, { correction: true });
      ac.radioState = 'IDLE';
      emitEvent(ctx, { kind: 'COMMAND_ACCEPTED', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign}: ${cmd.kind} re-issued (correction)`, severity: 'info', speaker: 'SYSTEM', data: { kind: cmd.kind, scored: false, correction: true } });
      return { status: 'accepted', clearance: original, readback: rb.text };
    }
  }

  // --- idempotency ----------------------------------------------------------
  const key = commandKey(ac, cmd);
  const last = ctx.recentCommands.get(key);
  if (last !== undefined && now - last < DUPLICATE_WINDOW_SEC) {
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `Duplicate ${cmd.kind} for ${ac.callsign} ignored (${(now - last).toFixed(1)} s after the identical command).`, severity: 'info', speaker: 'SYSTEM', data: { duplicate: true } });
    return { status: 'rejected', reason: `Duplicate command ignored: identical ${cmd.kind} was issued ${(now - last).toFixed(1)} s ago.` };
  }

  // --- validation -----------------------------------------------------------
  const planner = PLANNERS[cmd.kind as ClearanceKind];
  if (!planner) return reject(ac, { reason: `Command ${cmd.kind} is not supported by the simulator.`, commError: false });
  const result = planner(env);
  if ('reject' in result) return reject(ac, result.reject);
  // Wind / altimeter spoken with the instruction (JO 7110.65 3-9-1 / 3-10-1): the pilot has the numbers; wrong numbers are an improper instruction.
  if (cmd.info && cmd.kind !== 'AIRPORT_INFO') {
    const mm = noteAirportInfo(env);
    if (mm && !result.plan.flag) result.plan.flag = `information does not match the current observation: ${mm} (JO 7110.65 3-9-1 / 3-10-1)`;
  }

  // --- safety ---------------------------------------------------------------
  const assessment = assessClearanceSafety(state, { ...cmd, callsign: ac.callsign });
  const training = state.scenario.mode === 'training';
  if (!assessment.safe) {
    if (training) {
      if (!ctx.dryRun) recordUnsafeClearance(ctx, ac, assessment, true);
      const detail = assessment.issues.map((i) => `${i.text}. See ${i.reference}.`).join(' ');
      return reject(ac, { reason: `Unsafe clearance not issued (training mode). ${detail}`, commError: false }, { unsafe: true });
    }
    if (!ctx.dryRun) recordUnsafeClearance(ctx, ac, assessment, false);
  }

  if (ctx.dryRun) {
    const preview: Clearance = { id: 'dry-run', kind: cmd.kind as ClearanceKind, issuedAtSec: now, byPosition: position, ...result.plan.patch };
    return { status: 'accepted', clearance: preview, readback: buildReadback(ac, preview, { airport }).text };
  }

  // --- commit ---------------------------------------------------------------
  const clr: Clearance = {
    id: `clr-${++ctx.clearanceSeq}`,
    kind: cmd.kind as ClearanceKind,
    issuedAtSec: now,
    byPosition: position,
    ...result.plan.patch,
  };
  result.plan.commit(clr);
  if (!ctx.currentAi) rt.playerTouched = true;
  const flagged = result.plan.flag;
  if (flagged) {
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `Improper instruction accepted: ${flagged}`, severity: 'warning', speaker: 'SYSTEM', data: { improper: true, kind: cmd.kind } });
  }
  ac.clearances.push(clr);
  ac.activeClearanceId = clr.id;
  const waitSec = ac.pendingRequest ? now - ac.pendingRequest.sinceSec : undefined;
  ac.pendingRequest = undefined;
  if (rt.readbackError && rt.readbackError.kind === (cmd.kind as string)) {
    // A new instruction of the SAME kind supersedes the earlier mistaken readback. A companion command from the same transmission
    // ("taxi to runway 35 via hotel, hold short of runway 35" parses as TAXI + HOLD_SHORT) must not wipe it: the misread TAXI stays
    // pending so the controller can still correct it (or have it scored as missed).
    rt.readbackError = undefined;
    ac.flags.readbackErrorPending = false;
    ac.flags.readbackErrorClearanceId = undefined;
  }

  const rb = buildReadback(ac, clr, { airport, rng: ctx.rng, errorRate: ctx.readbackErrorRate });
  if (rb.text) pilotSay(ctx, ac, rb.text, { readback: true, clearanceId: clr.id });
  else ac.radioState = rt.readbackError ? 'WAITING_FOR_READBACK' : 'IDLE'; // informational instruction: no readback
  if (rb.error) {
    rt.readbackError = { sinceSec: now, kind: cmd.kind as ReadbackErrorRecord['kind'], clearanceId: clr.id, correct: rb.error.correct, spoken: rb.error.spoken };
    ac.flags.readbackErrorPending = true;
    ac.flags.readbackErrorClearanceId = clr.id;
    ac.radioState = 'WAITING_FOR_READBACK';
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `(hidden from pilot) ${ac.callsign} misread back: ${rb.error.spoken} instead of ${rb.error.correct}`, severity: 'info', speaker: 'SYSTEM', data: { readbackError: true } });
  }
  if (cmd.kind === 'CONTACT_FREQUENCY' && rt.pendingFreq) rt.pendingFreq.atSec = now + speechDurationSec(rb.text) + 0.5;

  ctx.recentCommands.set(key, now);
  emitEvent(ctx, {
    kind: 'COMMAND_ACCEPTED', aircraftId: ac.id, callsign: ac.callsign, severity: assessment.safe ? 'info' : 'critical', speaker: 'SYSTEM',
    text: `${ac.callsign}: ${describeClearance(clr)}${assessment.safe ? '' : ' (UNSAFE)'}`,
    data: { kind: clr.kind, clearanceId: clr.id, scored: assessment.safe && !flagged, unsafe: !assessment.safe, waitSec, ...(flagged ? { commError: true } : {}) },
  });
  return { status: 'accepted', clearance: clr, readback: rb.text };
}

// ---------------------------------------------------------------------------
// Normalisation / gating helpers
// ---------------------------------------------------------------------------

function normalizeCommand(airport: Airport, ac: Aircraft, cmd: ParsedCommand, mayInfer: boolean): { cmd: ParsedCommand; g?: RunwayEndGeom } {
  const needsEnd = cmd.kind === 'TAKEOFF' || cmd.kind === 'LAND' || cmd.kind === 'LINE_UP_AND_WAIT' || cmd.kind === 'ENTER_PATTERN' || cmd.kind === 'APPROACH';
  const n: ParsedCommand = { ...cmd };
  let g: RunwayEndGeom | undefined;
  if (needsEnd) {
    const explicit = cmd.runwayEnd ?? (cmd.runwayId && !cmd.runwayId.includes('/') ? cmd.runwayId : undefined);
    g = findRunwayEnd(airport, explicit);
    if (!g && mayInfer) {
      const assigned = findRunwayEnd(airport, ac.assignedRunwayEnd);
      const pair = cmd.runwayId ? findRunway(airport, cmd.runwayId) : undefined;
      if (assigned && (!pair || pair.id === assigned.runway.id)) g = assigned;
    }
    if (g) n.runwayEnd = g.end.id;
  } else if (cmd.kind === 'TAXI' && !cmd.destination && cmd.runwayEnd) {
    g = findRunwayEnd(airport, cmd.runwayEnd);
  }
  return { cmd: n, g };
}

function missingEntities(cmd: ParsedCommand, g?: RunwayEndGeom): string[] {
  const m: string[] = [];
  switch (cmd.kind) {
    case 'TAXI':
      if (!cmd.destination && !cmd.runwayEnd) m.push('taxi destination');
      break;
    case 'TAKEOFF':
    case 'LAND':
    case 'LINE_UP_AND_WAIT':
    case 'ENTER_PATTERN':
      if (!g) m.push('runway');
      break;
    case 'APPROACH':
      if (!cmd.approachType) m.push('approach type');
      if (!g) m.push('runway');
      break;
    case 'DIRECT_FIX':
      if (!cmd.fix) m.push('fix');
      break;
    case 'HOLD_AT_FIX':
      if (!cmd.hold?.fix) m.push('fix to hold at');
      break;
    case 'CROSS_RUNWAY':
      if (!cmd.crossRunwayId && !cmd.runwayId && !cmd.runwayEnd) m.push('runway to cross');
      break;
    case 'HOLD_SHORT':
      if (!cmd.holdShort?.length && !cmd.runwayId && !cmd.runwayEnd && !cmd.crossRunwayId) m.push('runway to hold short of');
      break;
    case 'HEADING':
      if (cmd.headingDeg === undefined) m.push('heading');
      break;
    case 'ALTITUDE':
      if (cmd.altitudeFt === undefined) m.push('altitude');
      break;
    case 'SPEED':
      if (cmd.speedKt === undefined) m.push('speed');
      break;
    case 'CONTACT_FREQUENCY':
      if (cmd.frequencyMhz === undefined && !cmd.frequencyId) m.push('frequency');
      break;
    default:
      break;
  }
  return m;
}

function commandKey(ac: Aircraft, c: ParsedCommand): string {
  return [
    ac.id, c.kind, c.runwayEnd ?? '', c.runwayId ?? '', (c.route ?? []).join('>'), (c.holdShort ?? []).join(','), c.crossRunwayId ?? '',
    c.destination ?? '', c.headingDeg ?? '', c.turnDirection ?? '', c.altitudeFt ?? '', c.speedKt ?? '', c.frequencyMhz ?? '', c.frequencyId ?? '', c.patternLeg ?? '',
    c.approachType ?? '', c.fix ?? '', c.ifr ? JSON.stringify(c.ifr) : '', c.hold ? JSON.stringify(c.hold) : '',
    c.exitTaxiway ?? '', c.ifAble ?? '', c.traffic ? JSON.stringify(c.traffic) : '', c.sequenceNumber ?? '', c.distanceNm ?? '', c.turnDegrees ?? '', c.squawk ?? '', c.info ? JSON.stringify(c.info) : '',
  ].join('|');
}

function sameParams(clr: Clearance, cmd: ParsedCommand, g?: RunwayEndGeom): boolean {
  switch (cmd.kind) {
    case 'TAKEOFF':
    case 'LAND':
    case 'LINE_UP_AND_WAIT':
      return !!g && clr.runwayEnd === g.end.id;
    case 'APPROACH':
      return !!g && clr.runwayEnd === g.end.id && clr.approachType === cmd.approachType;
    case 'HEADING':
      return clr.headingDeg !== undefined && cmd.headingDeg !== undefined && Math.abs(clr.headingDeg - cmd.headingDeg) < 0.5 && (cmd.turnDirection ?? undefined) === (clr.turnDirection ?? undefined);
    case 'CROSS_RUNWAY': {
      const a = normalizeRunwayEndId(clr.runwayId ?? '');
      const b = normalizeRunwayEndId(cmd.crossRunwayId ?? cmd.runwayId ?? cmd.runwayEnd ?? '');
      return a === b || a.split('/').includes(b) || b.split('/').includes(a);
    }
    case 'TAXI':
    case 'TAXI_TO_PARKING':
      return (clr.destination ?? '') === (cmd.destination ?? '') && (clr.runwayEnd ?? '') === (g?.end.id ?? cmd.runwayEnd ?? '');
    default:
      return false;
  }
}

function describeClearance(c: Clearance): string {
  const bits: string[] = [c.kind];
  if (c.runwayEnd) bits.push(`rwy ${c.runwayEnd}`);
  else if (c.runwayId) bits.push(`rwy ${c.runwayId}`);
  if (c.destination) bits.push(`to ${c.destination}`);
  if (c.route?.length) bits.push(`via ${c.route.join(' ')}`);
  if (c.holdShort?.length) bits.push(`hold short ${c.holdShort.join(' ')}`);
  if (c.headingDeg !== undefined) bits.push(`hdg ${c.headingDeg}`);
  if (c.altitudeFt !== undefined) bits.push(`${c.altitudeFt} ft`);
  if (c.speedKt !== undefined) bits.push(`${c.speedKt} kt`);
  if (c.frequencyMhz !== undefined) bits.push(`${c.frequencyMhz}`);
  if (c.approachType) bits.push(`${c.approachType} approach`);
  if (c.fix) bits.push(`direct ${c.fix}`);
  if (c.hold) bits.push(`hold at ${c.hold.fix}${c.hold.asPublished ? ' as published' : ''}`);
  if (c.ifr) bits.push(`to ${c.ifr.destination}${c.ifr.departureProcedure ? ` via ${c.ifr.departureProcedure}` : ''} sq ${c.ifr.squawk}`);
  return bits.join(' ');
}

// ---------------------------------------------------------------------------
// Ground helpers
// ---------------------------------------------------------------------------

function isDepartureHold(n: TaxiNode, g: RunwayEndGeom): boolean {
  return (
    n.kind === 'holding_position' && n.runwayId === g.runway.id &&
    (!n.protectsRunwayEnd || normalizeRunwayEndId(n.protectsRunwayEnd) === normalizeRunwayEndId(g.end.id))
  );
}

/** The node the aircraft's next route should start from. */
function currentStartNode(env: Env): TaxiNode | undefined {
  const { ac, rt, airport } = env;
  const graph = airport.taxiwayGraph;
  if (rt.stoppedAtNodeId && graph.nodes[rt.stoppedAtNodeId] && dist(graph.nodes[rt.stoppedAtNodeId].pos, ac.pos) < 3) return graph.nodes[rt.stoppedAtNodeId];
  const near = nearestNode(graph, ac.pos, { maxDistM: 2 });
  if (near) return near;
  if (ac.route && ac.route.progressIndex < ac.route.nodeIds.length) return graph.nodes[ac.route.nodeIds[ac.route.progressIndex]];
  return nearestNode(graph, ac.pos, { maxDistM: 150 });
}

function runwayEntryNode(env: Env, hold: TaxiNode, g: RunwayEndGeom): TaxiNode | undefined {
  const graph = env.airport.taxiwayGraph;
  const nbrs = neighborIds(graph, hold.id).map((i) => graph.nodes[i]).filter((n) => n.kind === 'runway' && n.runwayId === g.runway.id);
  if (nbrs.length) return nbrs.sort((a, b) => dist(a.pos, hold.pos) - dist(b.pos, hold.pos))[0];
  return nearestNode(graph, hold.pos, { kinds: ['runway'], maxDistM: 200, filter: (n) => n.runwayId === g.runway.id });
}

/** Distance along the route from the aircraft to route node index i. */
function routeDistanceTo(env: Env, index: number): number {
  const route = env.ac.route!;
  const graph = env.airport.taxiwayGraph;
  let d = 0;
  let prev = env.ac.pos;
  for (let i = route.progressIndex; i <= index && i < route.nodeIds.length; i++) {
    const p = graph.nodes[route.nodeIds[i]].pos;
    d += dist(prev, p);
    prev = p;
  }
  return d;
}

function allRunwayIds(airport: Airport): string[] {
  return airport.runways.map((r) => r.id);
}

function parseRunwayDestination(raw: string): string | undefined {
  const m = /^(?:RWY|RUNWAY)\s*0?(\d{1,2}[LRC]?)$/i.exec(raw.trim()) ?? /^0?(\d{1,2}[LRC]?)$/i.exec(raw.trim());
  return m ? m[1].toUpperCase() : undefined;
}

// ---------------------------------------------------------------------------
// Planners
// ---------------------------------------------------------------------------

function planTaxi(env: Env): PlanResult {
  const { ac, rt, cmd, airport, ctx } = env;
  const graph = airport.taxiwayGraph;
  if (!ac.onGround) return unable(env, `${ac.callsign} is airborne; cannot taxi.`, "we're airborne");
  const departurePhases = ['PARKED', 'READY', 'TAXIING', 'HOLDING_SHORT'];
  const arrivalPhases = ['RUNWAY_EXIT', 'TAXI_TO_PARKING'];
  if (!departurePhases.includes(ac.phase) && !arrivalPhases.includes(ac.phase)) {
    return unable(env, `${ac.callsign} is in phase ${ac.phase}; a taxi instruction cannot be executed now.`, ac.phase === 'ARRIVED' ? "we're parked" : 'not able to taxi now');
  }
  const start = currentStartNode(env);
  if (!start) return unable(env, `${ac.callsign} is not on the taxiway system.`, "we're not on a taxiway");

  // Destination.
  let targets: string[] = [];
  let runwayEnd: string | undefined;
  let runwayG: RunwayEndGeom | undefined;
  let destRaw = cmd.destination ?? (cmd.runwayEnd ? `RWY${cmd.runwayEnd}` : undefined);
  let via = cmd.route ?? [];
  let kind = cmd.kind;
  // "continue taxiing": the destination of the taxi clearance in force, from here (a hold-short on the way is released).
  if (destRaw === 'CONTINUE') {
    const prev = activeClearance(ac, 'TAXI') ?? activeClearance(ac, 'TAXI_TO_PARKING');
    if (!prev || prev.completedAtSec !== undefined) return unable(env, `${ac.callsign} has no taxi clearance to continue.`, "we don't have a taxi clearance");
    destRaw = prev.destination ?? (prev.runwayEnd ? `RWY${prev.runwayEnd}` : undefined);
    kind = prev.kind as typeof kind;
    via = [];
  }
  const isRunwayWord = !!destRaw && /^\s*(RWY|RUNWAY)/i.test(destRaw);
  const twyDest = destRaw ? /^TWY\s*([A-Z]{1,2}\d{0,2})$/i.exec(destRaw.trim())?.[1]?.toUpperCase() : undefined;
  const pq = !isRunwayWord && !twyDest && (destRaw || kind === 'TAXI_TO_PARKING') ? resolveParkingQuery(airport, destRaw) : ({ kind: 'unknown' } as const);
  if (!destRaw && kind !== 'TAXI_TO_PARKING') return unable(env, 'No taxi destination given.', 'say destination', false);
  if (twyDest) {
    // "taxi to kilo via bravo": the nearest point of taxiway K (by taxi distance, never over a runway), reached via the route.
    const onTwy = Object.values(graph.nodes).filter((n) => n.kind !== 'runway' && n.kind !== 'parking' && n.taxiways.some((t) => t.toUpperCase() === twyDest) && dist(n.pos, ac.pos) > 5);
    if (!onTwy.length) return unable(env, `Taxiway ${twyDest} does not exist on this airport.`, `we can't find taxiway ${spokenTaxiway(twyDest)}`);
    const dm = shortestDistances(graph, start.id);
    const reachable = onTwy.filter((n) => dm.has(n.id)).sort((a, b) => dm.get(a.id)! - dm.get(b.id)!);
    targets = (reachable.length ? reachable : onTwy).slice(0, 3).map((n) => n.id);
  } else if (pq.kind === 'spot') {
    const occ = parkingOccupant(ctx.state, pq.parking, ac.id);
    if (occ) return unable(env, `Parking ${pq.parking.id} is occupied by ${occ.callsign}.`, 'that parking spot is occupied');
    targets = [pq.parking.nodeId];
  } else if (pq.kind === 'category' || pq.kind === 'default') {
    const cat = pq.kind === 'category' ? pq.category : undefined;
    const cands = freeParkingCandidates(ctx.state, ac, cat, rt.homeParkingCategory);
    if (!cands.length) {
      return unable(env, `No unoccupied ${cat ? `${cat} ` : ''}parking position is available.`, 'there is no parking available');
    }
    targets = cands.map((c) => c.nodeId);
  } else {
    const endRaw = parseRunwayDestination(destRaw ?? '');
    const g = findRunwayEnd(airport, endRaw);
    if (!g) {
      return unable(
        env,
        `Unknown taxi destination "${destRaw}": not a runway, a parking id/name, or a parking area (gate, ramp, FBO, cargo, military).`,
        "we can't find that destination",
      );
    }
    runwayEnd = g.end.id;
    runwayG = g;
  }
  if (runwayEnd && ac.isDeparture === false) return unable(env, 'Arriving aircraft cannot be taxied to a departure runway.', 'we are an arrival');

  // The route: the taxiways in the order given; failing that, the same taxiways with one of them left out (the controller named a
  // taxiway the route cannot use in that order, e.g. one that only branches off at the hold): accepted, read back as flown, flagged.
  let best: { route: TaxiRoute; target: string } | undefined;
  let why = '';
  let usedVia = via;
  const knownTwy = new Set(graph.edges.map((e) => e.taxiway.toUpperCase()));
  const unknownVia = via.filter((v) => !knownTwy.has(v.toUpperCase()));
  if (unknownVia.length) return unable(env, `Invalid taxi route for ${ac.callsign} via ${via.join(', ')}: Taxiway ${unknownVia.join(', ')} does not exist on this airport.`, `that route isn't available`);
  const touchesTarget = (twy: string, nodeId: string): boolean => {
    const t = twy.toUpperCase();
    return [nodeId, ...neighborIds(graph, nodeId)].some((id) => graph.nodes[id]?.taxiways.some((x) => x.toUpperCase() === t));
  };
  for (const attempt of viaAttempts(via)) {
    // Only a taxiway that merely meets the destination (named as "where it ends": "runway 31 via bravo kilo") may be dropped.
    if (attempt !== via) {
      const dropped = via.find((v, k) => attempt[k] !== v) ?? via[via.length - 1];
      const ends = runwayG ? runwayHoldCandidates(airport, runwayG, attempt[attempt.length - 1]).map((h) => h.id) : targets;
      if (!ends.some((id) => touchesTarget(dropped, id))) continue;
    }
    if (runwayG) {
      const r = pickRunwayHold(airport, start.id, runwayG, attempt);
      if (r.pick) best = { route: r.pick.route, target: r.pick.hold.id };
      else if (!why) why = r.reason ?? '';
    } else {
      for (const t of targets) {
        const res = findTaxiRoute(graph, start.id, t, { via: attempt, avoidRunways: true, allowedRunwayIds: allRunwayIds(airport) });
        if (res.route && (!best || res.route.lengthM < best.route.lengthM)) best = { route: res.route, target: t };
        else if (!res.route && !why) why = res.reason ?? '';
      }
    }
    if (best) { usedVia = attempt; break; }
  }
  if (!best) {
    return unable(env, `Invalid taxi route for ${ac.callsign}${via.length ? ` via ${via.join(', ')}` : ''}: ${why}.`, `that route isn't available`);
  }
  const route = best.route;
  const dest = airport.parking.find((p) => p.nodeId === best!.target);
  const flag = usedVia !== via ? `taxi route via ${via.join(', ')} is not usable in that order for ${ac.callsign}; taxiing via ${usedVia.join(', ') || 'the direct route'} (${why})` : undefined;
  const tooShort = runwayG && runwayRemainingM(runwayG, graph.nodes[best.target]) < takeoffRunM(ac)
    ? `runway ${runwayEnd} from ${graph.nodes[best.target].taxiways[0] ?? 'that intersection'} leaves ${Math.round(runwayRemainingM(runwayG, graph.nodes[best.target]) / 0.3048)} ft, ${ac.type} needs about ${perfOf(ac).takeoffDistanceFt} ft; the pilot will ask for full length`
    : undefined;

  return {
    plan: {
      patch: { route: usedVia, holdShort: cmd.holdShort, destination: dest?.id ?? (runwayEnd ? `RWY${runwayEnd}` : twyDest ? `TWY${twyDest}` : destRaw), runwayEnd },
      flag: flag ?? tooShort,
      commit: () => {
        const stops = new Set(computeStopNodes(graph, route.nodeIds, ac.runwayAuthorizations));
        for (const rid of cmd.holdShort ?? []) {
          const rw = findRunway(airport, rid);
          if (rw) {
            const holds = route.nodeIds.filter((id) => graph.nodes[id].kind === 'holding_position' && graph.nodes[id].runwayId === rw.id);
            if (holds.length && !holds.some((id) => stops.has(id))) stops.add(holds[0]);
            continue;
          }
          const twyStop = taxiwayStopNode(graph, route.nodeIds, 0, rid, ac.pos);
          if (twyStop) stops.add(twyStop);
        }
        ac.route = { nodeIds: route.nodeIds, taxiways: route.taxiways, stopAtNodeIds: [...stops], progressIndex: 0 };
        rt.stoppedAtNodeId = undefined;
        ac.flags.holdingPosition = false;
        rt.lineUp = undefined;
        rt.takeoffCleared = false;
        completeClearances(ctx, ac, ['TAXI', 'TAXI_TO_PARKING', 'HOLD_POSITION']);
        if (runwayEnd) ac.assignedRunwayEnd = runwayEnd;
        if (arrivalPhases.includes(ac.phase)) setPhase(ctx, ac, 'TAXI_TO_PARKING');
        else if (ac.phase === 'HOLDING_SHORT') setPhase(ctx, ac, 'TAXIING', 'taxi instruction');
        else advancePhase(ctx, ac, 'TAXIING');
      },
    },
  };
}

/** The via list as given, then (when it has 2+ taxiways) the same list with one taxiway dropped, last first. */
function viaAttempts(via: string[]): string[][] {
  const out: string[][] = [via];
  if (via.length >= 2) for (let i = via.length - 1; i >= 0; i--) out.push(via.filter((_, k) => k !== i));
  return out;
}

/**
 * Node at which a route first reaches taxiway `twy` (the intersection the aircraft holds short of). Nodes at the aircraft's own
 * position are skipped (it is already there). Undefined when the route never touches the taxiway.
 */
export function taxiwayStopNode(graph: TaxiwayGraph, nodeIds: readonly string[], from: number, twy: string, pos: Vec2): string | undefined {
  const t = twy.toUpperCase();
  for (let k = from; k < nodeIds.length; k++) {
    const n = graph.nodes[nodeIds[k]];
    if (!n || !n.taxiways.some((x) => x.toUpperCase() === t)) continue;
    if (dist(n.pos, pos) < 5) continue;
    return n.id;
  }
  return undefined;
}

function planHoldPosition(env: Env): PlanResult {
  const { ac } = env;
  // "Stop" / "hold position" to an aircraft that has been cleared for takeoff or is rolling is a cancellation of the takeoff clearance (JO 7110.65 3-9-11).
  if (ac.phase === 'CLEARED_FOR_TAKEOFF' || ac.phase === 'TAKEOFF_ROLL') return planCancelTakeoff(env);
  if (!ac.onGround) return unable(env, `${ac.callsign} is airborne; "hold position" applies to ground traffic.`, "we're airborne");
  return { plan: { patch: {}, commit: () => { ac.flags.holdingPosition = true; } } };
}

function planHoldShort(env: Env): PlanResult {
  const { ac, cmd, airport } = env;
  const graph = airport.taxiwayGraph;
  // during the landing roll / on final: stop short of the intersecting runway (JO 7110.65 3-10-9, 3-10-4)
  const landingHold = planLandingHoldShort(env);
  if (landingHold) return landingHold;
  if (!ac.onGround) return unable(env, `${ac.callsign} is airborne; "hold short" applies to ground traffic.`, "we're airborne");
  const refs = cmd.holdShort?.length ? cmd.holdShort : [cmd.crossRunwayId ?? cmd.runwayId ?? cmd.runwayEnd!];
  const rws: Runway[] = [];
  const twyStops: string[] = [];
  const knownTaxiways = new Set(graph.edges.map((e) => e.taxiway.toUpperCase()));
  for (const r of refs) {
    const rw = findRunway(airport, r);
    if (rw) { rws.push(rw); continue; }
    // Hold short of a taxiway: stop at the intersection where the route reaches it.
    const twy = r.toUpperCase().replace(/^TWY\s*/, '');
    if (!knownTaxiways.has(twy)) return unable(env, `Unknown runway or taxiway in hold-short instruction (${r}).`, "we can't find that runway or taxiway");
    if (!ac.route || ac.route.progressIndex >= ac.route.nodeIds.length) return unable(env, `${ac.callsign} has no taxi route; a hold short of taxiway ${twy} needs one.`, `we're not taxiing`);
    const stop = taxiwayStopNode(graph, ac.route.nodeIds, Math.max(0, ac.route.progressIndex - 1), twy, ac.pos);
    if (!stop) return unable(env, `The route of ${ac.callsign} does not reach taxiway ${twy}.`, `our route doesn't cross ${spokenTaxiway(twy)}`);
    twyStops.push(stop);
  }
  return {
    plan: {
      patch: { holdShort: refs },
      commit: () => {
        for (const rw of rws) {
          const i = ac.runwayAuthorizations.indexOf(rw.id);
          if (i >= 0) ac.runwayAuthorizations.splice(i, 1);
          if (ac.route) {
            for (let k = ac.route.progressIndex; k < ac.route.nodeIds.length; k++) {
              const n = graph.nodes[ac.route.nodeIds[k]];
              if (n.kind === 'holding_position' && n.runwayId === rw.id && !ac.route.stopAtNodeIds.includes(n.id)) ac.route.stopAtNodeIds.push(n.id);
            }
          }
        }
        for (const id of twyStops) if (ac.route && !ac.route.stopAtNodeIds.includes(id)) ac.route.stopAtNodeIds.push(id);
      },
    },
  };
}

function planCross(env: Env): PlanResult {
  const { ac, rt, cmd, airport } = env;
  const graph = airport.taxiwayGraph;
  if (!ac.onGround) return unable(env, `${ac.callsign} is airborne; cannot cross a runway.`, "we're airborne");
  const raw = cmd.crossRunwayId ?? cmd.runwayId ?? cmd.runwayEnd!;
  const rw = findRunway(airport, raw);
  if (!rw) return unable(env, `Unknown runway "${raw}".`, "we can't find that runway");
  const route = ac.route;
  if (!route) return unable(env, `${ac.callsign} has no taxi route; issue a taxi instruction first.`, "we don't have a taxi route");
  const from = rt.stoppedAtNodeId && route.nodeIds.includes(rt.stoppedAtNodeId) ? route.nodeIds.indexOf(rt.stoppedAtNodeId) : route.progressIndex;
  let holdIdx = -1;
  for (let i = from; i < route.nodeIds.length; i++) {
    const n = graph.nodes[route.nodeIds[i]];
    if (n.kind === 'holding_position' && n.runwayId === rw.id) {
      holdIdx = i;
      break;
    }
  }
  if (holdIdx < 0) return unable(env, `${ac.callsign} is not holding short of or approaching runway ${rw.id} on its route.`, `we're not approaching runway ${rw.id}`);
  const standing = rt.stoppedAtNodeId === route.nodeIds[holdIdx];
  if (!standing && routeDistanceTo(env, holdIdx) > CROSS_APPROACH_M) {
    return unable(env, `${ac.callsign} is still ${Math.round(routeDistanceTo(env, holdIdx))} m from runway ${rw.id}.`, `we're not at runway ${rw.id} yet`);
  }
  if (!runwayCrossingsAlong(graph, route.nodeIds.slice(holdIdx)).includes(rw.id)) {
    return unable(env, `The current route of ${ac.callsign} does not continue across runway ${rw.id}; issue a new taxi instruction.`, `our route doesn't cross runway ${rw.id}`);
  }
  return {
    plan: {
      patch: { runwayId: raw },
      commit: () => {
        if (!ac.runwayAuthorizations.includes(rw.id)) ac.runwayAuthorizations.push(rw.id);
        route.stopAtNodeIds = route.stopAtNodeIds.filter((id) => graph.nodes[id].runwayId !== rw.id);
        ac.flags.holdingPosition = false;
        if (ac.phase === 'HOLDING_SHORT') setPhase(env.ctx, ac, 'TAXIING', `crossing runway ${rw.id}`);
      },
    },
  };
}

/** Shared by LINE_UP_AND_WAIT and TAKEOFF: find the departure hold and build the route onto the runway. */
function planRunwayEntry(env: Env, g: RunwayEndGeom): { reject: Reject } | { hold: TaxiNode; entry: TaxiNode; nodeIds: string[] } {
  const { ac, rt, airport } = env;
  const graph = airport.taxiwayGraph;
  let hold: TaxiNode | undefined;
  let nodeIds: string[] = [];
  const stopped = rt.stoppedAtNodeId ? graph.nodes[rt.stoppedAtNodeId] : undefined;
  if (stopped && dist(stopped.pos, ac.pos) < 3 && isDepartureHold(stopped, g)) {
    hold = stopped;
    nodeIds = [stopped.id];
  } else if (ac.route && ac.phase === 'TAXIING') {
    for (let i = ac.route.progressIndex; i < ac.route.nodeIds.length; i++) {
      const n = graph.nodes[ac.route.nodeIds[i]];
      if (isDepartureHold(n, g)) {
        if (dist(ac.pos, n.pos) <= TAKEOFF_NEAR_HOLD_M) {
          hold = n;
          nodeIds = ac.route.nodeIds.slice(ac.route.progressIndex, i + 1);
        }
        break;
      }
    }
  }
  if (!hold) {
    return unable(env, `${ac.callsign} is not at (or within ${TAKEOFF_NEAR_HOLD_M} m of) a holding position for runway ${g.end.id}.`, `we're not at runway ${g.end.id}`);
  }
  const entry = runwayEntryNode(env, hold, g);
  if (!entry) return unable(env, `No runway entry from ${hold.id} onto runway ${g.runway.id}.`, "we can't see a way onto the runway");
  return { hold, entry, nodeIds: [...nodeIds, entry.id] };
}

function applyRunwayEntry(env: Env, g: RunwayEndGeom, hold: TaxiNode, entry: TaxiNode, nodeIds: string[]): void {
  const { ac, rt } = env;
  ac.route = { nodeIds, taxiways: hold.taxiways.slice(0, 1), stopAtNodeIds: [], progressIndex: 0 };
  if (!ac.runwayAuthorizations.includes(g.runway.id)) ac.runwayAuthorizations.push(g.runway.id);
  ac.assignedRunwayEnd = g.end.id;
  rt.lineUp = { holdNodeId: hold.id, runwayNodeId: entry.id, runwayEnd: g.end.id, aligned: false };
  rt.stoppedAtNodeId = undefined;
  ac.flags.holdingPosition = false;
}

function planLineUp(env: Env): PlanResult {
  const { ac, rt, ctx } = env;
  const g = env.g!;
  if (!ac.onGround) return unable(env, `${ac.callsign} is airborne.`, "we're airborne");
  if (ac.phase !== 'HOLDING_SHORT' && ac.phase !== 'TAXIING') {
    return unable(env, `${ac.callsign} is ${ac.phase}; line up and wait needs an aircraft holding short or taxiing to the runway.`, `we're not holding short of runway ${g.end.id}`);
  }
  const entry = planRunwayEntry(env, g);
  if ('reject' in entry) return entry;
  // JO 7110.65 3-9-4: traffic information to the aircraft authorised to line up and wait (closest traffic within 6 miles for the same runway).
  const trafficIssue = luawTrafficIssue(env, g);
  if (trafficIssue && ctx.state.scenario.mode === 'training') {
    return { reject: { reason: `Not issued (training mode): ${trafficIssue}.`, commError: true } };
  }
  return {
    plan: {
      patch: { runwayEnd: g.end.id, runwayId: g.runway.id },
      flag: trafficIssue,
      commit: () => {
        applyRunwayEntry(env, g, entry.hold, entry.entry, entry.nodeIds);
        rt.takeoffCleared = false;
        rt.luawSinceSec = undefined;
        setPhase(ctx, ac, 'LINE_UP_AND_WAIT', `runway ${g.end.id}`);
      },
    },
  };
}

function planTakeoff(env: Env): PlanResult {
  const { ac, rt, ctx, now } = env;
  const g = env.g!;
  if (!ac.onGround) return unable(env, `${ac.callsign} is airborne.`, "we're airborne");
  const windNo = windRefusal(env, g);
  if (windNo) return windNo;
  // IFR departures need their clearance first: refused in training, otherwise accepted and flagged as a communication error.
  let flag: string | undefined;
  if (ac.flightPlan?.flightRules === 'IFR' && !ac.flightPlan.ifrClearance) {
    const msg = `no IFR clearance on file for ${ac.callsign}; issue the IFR clearance (Clearance Delivery) before takeoff.`;
    if (ctx.state.scenario.mode === 'training') return unable(env, msg, "we don't have our IFR clearance yet");
    flag = msg;
  }
  if (ac.phase === 'LINE_UP_AND_WAIT') {
    if (ac.assignedRunwayEnd !== g.end.id) {
      return unable(env, `${ac.callsign} is lined up on runway ${ac.assignedRunwayEnd}, not ${g.end.id}.`, `we're lined up on runway ${ac.assignedRunwayEnd}`);
    }
    const entryNode = rt.lineUp ? env.airport.taxiwayGraph.nodes[rt.lineUp.runwayNodeId] : undefined;
    const lenErr = entryNode ? runwayLengthCheck(env, g, entryNode) : undefined;
    if (lenErr) return lenErr;
    return {
      plan: {
        patch: { runwayEnd: g.end.id, runwayId: g.runway.id },
        flag,
        commit: () => {
          rt.takeoffCleared = true;
          rt.rollAtSec = now + 2.5;
          setPhase(ctx, ac, 'CLEARED_FOR_TAKEOFF');
        },
      },
    };
  }
  if (ac.phase !== 'HOLDING_SHORT' && ac.phase !== 'TAXIING') {
    return unable(env, `${ac.callsign} is ${ac.phase}; takeoff requires holding short, lined up, or taxiing to the runway.`, `we're not at runway ${g.end.id}`);
  }
  const entry = planRunwayEntry(env, g);
  if ('reject' in entry) return entry;
  const lenErr = runwayLengthCheck(env, g, entry.entry);
  if (lenErr) return lenErr;
  return {
    plan: {
      patch: { runwayEnd: g.end.id, runwayId: g.runway.id },
      flag,
      commit: () => {
        // from the hold: the roll starts after the line-up (taxi onto the runway and turn), not 2.5 s after the clearance
        let pathM = 0;
        let prev = ac.pos;
        for (const id of entry.nodeIds) {
          const p = env.airport.taxiwayGraph.nodes[id].pos;
          pathM += dist(prev, p);
          prev = p;
        }
        applyRunwayEntry(env, g, entry.hold, entry.entry, entry.nodeIds);
        rt.takeoffCleared = true;
        rt.rollAtSec = now + Math.max(2.5, lineUpTimeSec(perfOf(ac), pathM));
        setPhase(ctx, ac, 'CLEARED_FOR_TAKEOFF');
      },
    },
  };
}

/**
 * Wind limits of the type (`maxCrosswindKt` / `maxTailwindKt`, only where a source is cited): the pilot refuses a runway whose
 * EFFECTIVE component, steady + 0.5 x (gust - steady) (DESIGN DECISION: the C172's 15 kt is demonstrated, not a limitation, so the full gust is not
 * held against it), exceeds them and asks for the best other runway end within the limits (JO 7110.65 3-5-1: a pilot who prefers another
 * runway advises ATC; the wording "unable, ..., request runway" is free text after PCG UNABLE, there is no prescribed phrase).
 */
function windRefusal(env: Env, g: RunwayEndGeom): { reject: Reject } | undefined {
  const perf = perfOf(env.ac);
  const w = env.ctx.state.weather;
  const why = exceedsLimits(effectiveComponents(w, g.headingDeg), perf);
  if (!why) return undefined;
  const alts = env.airport.runways
    .flatMap((r) => r.ends.map((e) => e.id))
    .filter((id) => id !== g.end.id)
    .map((id) => ({ id, c: effectiveComponents(w, findRunwayEnd(env.airport, id)!.headingDeg) }))
    .filter((a) => !exceedsLimits(a.c, perf))
    .sort((a, b) => b.c.headwindKt - a.c.headwindKt);
  const ask = alts.length ? `request runway ${spokenRunway(alts[0].id)}` : 'request a different runway';
  return unable(env, `runway ${g.end.id}: ${why} kt (limit of the ${env.ac.type}; effective component between the steady and the gust speed, ${w.windGustKt ?? w.windSpeedKt} kt gust); ${alts.length ? `runway ${alts[0].id} is within limits` : 'no runway is within limits'}.`, `runway ${spokenRunway(g.end.id)}, ${why.startsWith('crosswind') ? 'crosswind' : 'tailwind'} is above our limit, ${ask}`, false);
}

function runwayLengthCheck(env: Env, g: RunwayEndGeom, entry: TaxiNode): { reject: Reject } | undefined {
  const perf = perfOf(env.ac);
  // TORA (NASR declared distance, the full pavement at KACY / KMHT) measured from the pavement end, minus where the aircraft enters
  const avail = g.toraM - Math.max(0, alongCross(g, entry.pos).along);
  if (avail < ftToM(perf.takeoffDistanceFt)) {
    return unable(
      env,
      `Only ${Math.round(avail / 0.3048)} ft of runway ${g.end.id} remain from that position; ${env.ac.type} needs about ${perf.takeoffDistanceFt} ft.`,
      `runway ${g.end.id} is too short from this position`,
    );
  }
  return undefined;
}

/** AIM 4-3-11 / JO 7110.118 (11a) precipitation: "dry runway - no visible moisture". */
const PRECIPITATION = /(RA|SN|DZ|SG|PL|GR|GS|IC|UP|TS|SH)/;

/** Wind component (kt) of a tailwind on the given runway end (positive = tailwind). */
function tailwindKt(env: Env, endId: string): number {
  const w = env.ctx.state.weather;
  if (w.windDirDeg === 'VRB' || w.windSpeedKt <= 0) return 0;
  const g = findRunwayEnd(env.airport, endId);
  if (!g) return 0;
  // the wind blows FROM windDirDeg, i.e. toward windDirDeg + 180; a tailwind blows along the runway heading
  return w.windSpeedKt * Math.cos(((w.windDirDeg + 180 - g.headingDeg) * Math.PI) / 180);
}

/**
 * Land and hold short (JO 7110.65 3-10-4 / 3-10-5, AIM 4-3-11, JO 7110.118 - the 7/14/00 edition was fetched).
 * Validation, in order:
 *  - the runway end has a NASR LAHSO entry for the intersecting runway named in the clearance;
 *  - the pilot accepts only if the aircraft's landing distance (`landingDistanceFt`) fits the published available landing
 *    distance (AIM: "the pilot-in-command determines that the aircraft can safely land and stop within the ALD"): otherwise
 *    "we can't hold short" and the clearance is not issued as LAHSO;
 *  - conditions (7110.118 11a: ceiling 1,000 ft and visibility 3 sm for non-air-carrier operations, the AIM 4-3-11 minima;
 *    dry runway = no precipitation; tailwind on the hold-short runway < 3 kt) and daylight (see below): training refuses, other
 *    modes accept and flag it as an improper instruction.
 * Daylight: 7110.118 does not forbid night LAHSO, but it needs land-and-hold-short lights (11c) and, for air carriers, a visual glide
 * slope indicator (11d); the airport data states neither, so the simulator allows LAHSO only between sunrise and sunset (NOAA solar
 * position, `utcStartMs`). Not modelled: wind shear reports, air-carrier minima (1,500 ft / 5 sm without PAPI/VASI), student pilots,
 * the traffic-information exchange and the aircraft-list of 7110.118 appendix 1 (the ALD test stands in for it).
 */
function planLahso(env: Env, g: RunwayEndGeom): { reject: Reject } | { holdShort?: string; flag?: string; rollout?: { holdShortRunwayId: string; holdShortAlongM: number; stopAlongM: number } } {
  const { ac, cmd, airport, ctx } = env;
  const refs = cmd.holdShort?.filter(Boolean) ?? [];
  if (!refs.length) return {};
  const info = g.end.lahso;
  const target = findRunway(airport, refs[0]);
  const spoken = target ? spokenRunwayForPhrase(target.id) : refs[0];
  if (!info || !target || target.id !== info.holdShortOfRunwayId) {
    return unable(env, `No land and hold short operation is published for runway ${g.end.id} short of ${refs[0]}${info ? ` (the published one is short of ${info.holdShortOfRunwayId})` : ''}.`, `we can't hold short of runway ${spoken}`);
  }
  const perf = perfOf(ac);
  if (perf.landingDistanceFt > info.availableLandingDistanceFt) {
    return unable(
      env,
      `${ac.callsign} (${ac.type}) needs about ${perf.landingDistanceFt} ft to land and stop; the available landing distance on runway ${g.end.id} short of runway ${target.id} is ${info.availableLandingDistanceFt} ft (AIM 4-3-11: the pilot declines).`,
      `we're unable to hold short of runway ${spoken}`,
    );
  }
  const problems: string[] = [];
  const w = ctx.state.weather;
  const ceil = ceilingFt(w);
  if (ceil < 1000 || w.visibilitySm < 3) problems.push(`LAHSO needs a ceiling of at least 1,000 ft and 3 sm visibility (AIM 4-3-11; JO 7110.118 11a): ceiling ${Number.isFinite(ceil) ? Math.round(ceil) : 'none'} ft, visibility ${w.visibilitySm} sm`);
  if (w.phenomena.some((p) => PRECIPITATION.test(p.replace(/^[-+]|VC/g, '')))) problems.push('the runway must be dry (no visible moisture; JO 7110.118 11a2): precipitation is reported');
  if (!isDaylight(airport.arp, simUtcMs(ctx.state))) problems.push('LAHSO is limited to the period between sunrise and sunset: night LAHSO needs land and hold short lights and a visual glide slope indicator, which the airport data does not confirm (JO 7110.118 11c, 11d)');
  const ends = target.ends.map((e) => e.id).filter((id) => ctx.state.activeRunways.departing.includes(id) || ctx.state.activeRunways.landing.includes(id));
  const worstTail = Math.max(...(ends.length ? ends : target.ends.map((e) => e.id)).map((id) => tailwindKt(env, id)));
  if (worstTail >= 3) problems.push(`the tailwind on the hold-short runway must be calm, less than 3 kt (JO 7110.118 11a3): ${worstTail.toFixed(0)} kt`);
  let flag: string | undefined;
  if (problems.length) {
    const msg = `Land and hold short not authorised for ${ac.callsign} on runway ${g.end.id}: ${problems.join('; ')}.`;
    if (ctx.state.scenario.mode === 'training') return unable(env, msg, `we can't accept hold short operations now`);
    flag = msg;
  }
  const hsAlong = alongCross(g, info.holdShortPoint.pos).along;
  const stop = Math.min(hsAlong, ftToM(info.availableLandingDistanceFt)) - perf.lengthM / 2 - 10;
  return { holdShort: target.id, flag, rollout: { holdShortRunwayId: target.id, holdShortAlongM: hsAlong, stopAlongM: stop } };
}

const spokenRunwayForPhrase = (id: string): string => spokenRunway(id);

/** Aligned within this many degrees of the final course, no higher than the 3-degree path + the window, and at least this far out. */
const REESTABLISH_ALIGN_DEG = 15;
const REESTABLISH_ABOVE_PATH_FT = 300;
const REESTABLISH_MIN_NM = 2;
const GO_AROUND_RECENT_SEC = 300;

/** Why a go-around aircraft is not yet stable on final for `g` (undefined: stable, or not on a missed approach). */
function goAroundNotStabilised(env: Env, g: RunwayEndGeom): string | undefined {
  const { ac, rt, ctx } = env;
  const recent = ac.lastGoAroundSec !== undefined && ctx.state.clock.timeSec - ac.lastGoAroundSec < GO_AROUND_RECENT_SEC;
  const onMissed = ac.phase === 'GO_AROUND' || (rt.missedFlown === true && recent && (ac.phase === 'APPROACH' || ac.phase === 'INBOUND'));
  if (!onMissed) return undefined;
  const { along, cross } = alongCross(g, ac.pos);
  const dM = Math.max(0, -along);
  const problems: string[] = [];
  if (along > 0 || dM < nmToM(REESTABLISH_MIN_NM)) problems.push(`inside ${REESTABLISH_MIN_NM} nm of the threshold`);
  if (Math.abs(headingDiff(ac.headingDeg, g.headingDeg)) > REESTABLISH_ALIGN_DEG || Math.abs(cross) > nmToM(0.5)) problems.push(`not aligned with the final course (within ${REESTABLISH_ALIGN_DEG} degrees)`);
  if (ac.altitudeFt > glideAltitudeFt(g.elevationFt, dM) + REESTABLISH_ABOVE_PATH_FT) problems.push('above the 3 degree path');
  return problems.length ? problems.join(', ') : undefined;
}

function planLand(env: Env): PlanResult {
  const { ac, rt, ctx, cmd } = env;
  const g = env.g!;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  const ok = ['INBOUND', 'APPROACH', 'FINAL', 'PATTERN', 'GO_AROUND', 'LANDING'];
  if (!ok.includes(ac.phase) || ac.isDeparture && ac.phase !== 'GO_AROUND' && ac.phase !== 'PATTERN') {
    return unable(env, `${ac.callsign} (${ac.phase}) is not inbound for a landing.`, "we're not inbound for landing");
  }
  if (ac.phase === 'LANDING') return unable(env, `${ac.callsign} is already landing.`, "we're already landing", false);
  if (ac.assignedRunwayEnd && ac.assignedRunwayEnd !== g.end.id && ac.phase === 'FINAL') {
    return unable(env, `${ac.callsign} is established on final for runway ${ac.assignedRunwayEnd}.`, `we're established on final for runway ${ac.assignedRunwayEnd}`, false);
  }
  // A missed approach that has not been re-established on final cannot take a landing clearance: the pilot is climbing out / being
  // re-sequenced (JO 7110.65 5-8-3 / 3-10-5: the clearance is issued to an aircraft that can land). Accepting it only to go around a
  // moment later ("unstable approach") would be a false clearance.
  const unstable = goAroundNotStabilised(env, g);
  if (unstable) return unable(env, `${ac.callsign} is on a missed approach and is not established for runway ${g.end.id}: ${unstable}.`, "unable, we're going around");
  const windNo = windRefusal(env, g);
  if (windNo) return windNo;
  const ldaFt = g.ldaM / 0.3048;
  if (perfOf(ac).landingDistanceFt > ldaFt) {
    return unable(env, `${ac.type} needs about ${perfOf(ac).landingDistanceFt} ft to land; runway ${g.end.id} has ${Math.round(ldaFt)} ft landing distance available (declared LDA).`, `runway ${spokenRunway(g.end.id)} is too short to land`);
  }
  const lahso = planLahso(env, g);
  if ('reject' in lahso) return lahso;
  return {
    plan: {
      patch: { runwayEnd: g.end.id, runwayId: g.runway.id, destination: cmd.destination, ...(lahso.holdShort ? { holdShort: [lahso.holdShort] } : {}) },
      flag: lahso.flag,
      commit: () => {
        rt.lahso = lahso.rollout;
        // 7110.65 3-8-1: full stop, touch-and-go, stop-and-go, low approach, or the pilot's option
        rt.landingOp = cmd.destination === 'touch_and_go' ? 'touch_and_go' : cmd.destination === 'low_approach' ? 'low_approach'
          : cmd.destination === 'stop_and_go' ? 'stop_and_go' : cmd.destination === 'option' ? 'option' : 'full_stop';
        if (ac.assignedRunwayEnd !== g.end.id) {
          ac.assignedRunwayEnd = g.end.id;
          rt.decisionDone = false;
          rt.pattern = undefined;
        }
        rt.landingEnd = g.end.id;
        if (!rt.approach) {
          // Not on a cleared approach: the aircraft proceeds to the runway on its own (a route, if any, is dropped).
          rt.navMode = 'AUTO';
          ac.target.headingDeg = undefined;
          ac.nav = undefined;
        }
        if (!ac.runwayAuthorizations.includes(g.runway.id)) ac.runwayAuthorizations.push(g.runway.id);
        if (ac.phase === 'GO_AROUND') setPhase(ctx, ac, 'APPROACH', 'cleared to land');
        else if (ac.phase === 'PATTERN' && !rt.pattern) rt.pattern = undefined;
      },
    },
  };
}

function planGoAround(env: Env): PlanResult {
  const { ac, ctx } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  if (!['APPROACH', 'FINAL', 'LANDING', 'PATTERN'].includes(ac.phase)) {
    return unable(env, `${ac.callsign} (${ac.phase}) is not on an approach.`, "we're not on an approach");
  }
  return { plan: { patch: {}, commit: () => initiateGoAround(ctx, ac, { reason: 'ATC instruction', announce: false }) } };
}

function planContinueApproach(env: Env): PlanResult {
  const { ac, rt, ctx } = env;
  if (ac.onGround || !ac.assignedRunwayEnd || !['INBOUND', 'APPROACH', 'FINAL', 'PATTERN', 'GO_AROUND'].includes(ac.phase)) {
    return unable(env, `${ac.callsign} has no approach to continue.`, 'we have no approach to continue');
  }
  return {
    plan: {
      patch: {},
      commit: () => {
        if (!rt.approach) {
          rt.navMode = 'AUTO';
          ac.target.headingDeg = undefined;
          ac.nav = undefined;
        }
        if (ac.phase === 'GO_AROUND') setPhase(ctx, ac, 'APPROACH', 'continue approach');
      },
    },
  };
}

function leaveFinalIfNeeded(env: Env): void {
  const { ac, ctx, rt } = env;
  if (ac.phase === 'FINAL') setPhase(ctx, ac, 'APPROACH', 'vectored off final');
  else if (ac.phase === 'PATTERN') {
    rt.pattern = undefined;
    setPhase(ctx, ac, 'APPROACH', 'vectored out of the pattern');
  }
  if (rt.landingEnd) {
    rt.landingEnd = undefined;
    completeClearances(ctx, ac, ['LAND']);
  }
}

/** A heading assignment suspends the route (kept for DIRECT_FIX / RESUME_OWN_NAVIGATION) and cancels an approach clearance. */
function enterVectors(env: Env): void {
  const { ac, rt, ctx } = env;
  rt.missed = undefined;
  rt.hold = undefined;
  if (ac.phase === 'HOLDING' && !ac.isDeparture) setPhase(ctx, ac, 'APPROACH', 'vectored out of the hold');
  if (rt.approach) {
    rt.approach = undefined;
    completeClearances(ctx, ac, ['APPROACH']);
  }
  if (ac.nav && ac.nav.mode !== 'vectors') {
    rt.navBeforeVectors = ac.nav.mode === 'direct' ? 'direct' : 'route';
    ac.nav.mode = 'vectors';
  }
}

function planHeading(env: Env): PlanResult {
  const { ac, rt, cmd, airport } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground; headings apply to airborne aircraft.`, "we're on the ground");
  if (ac.phase === 'LANDING') return unable(env, `${ac.callsign} is on short final / landing.`, "we're landing");
  const h = cmd.headingDeg!;
  if (!(h >= 0 && h <= 360)) return unable(env, `Invalid heading ${h}.`, 'say again the heading');
  return {
    plan: {
      patch: { headingDeg: h, turnDirection: cmd.turnDirection },
      commit: () => {
        leaveFinalIfNeeded(env);
        enterVectors(env);
        ac.target.headingDeg = magneticToTrue(h, airport.magneticVariationDeg);
        rt.navMode = 'HEADING';
        rt.turnDirection = cmd.turnDirection;
      },
    },
  };
}

function planAltitude(env: Env): PlanResult {
  const { ac, cmd, airport } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  if (ac.phase === 'FINAL' || ac.phase === 'LANDING') {
    return unable(env, `${ac.callsign} is established on the approach; an altitude change requires a go-around.`, "we're established on the approach");
  }
  const alt = cmd.altitudeFt!;
  const perf = perfOf(ac);
  if (alt > perf.serviceCeilingFt) return unable(env, `${alt} ft is above the ${ac.type} service ceiling (${perf.serviceCeilingFt} ft).`, 'we cannot reach that altitude');
  if (alt < airport.elevationFt + 300) return unable(env, `${alt} ft is too close to the field elevation (${airport.elevationFt} ft).`, 'that altitude is too low');
  return {
    plan: {
      patch: { altitudeFt: alt },
      commit: () => {
        ac.target.altitudeFt = alt;
        if (ac.isDeparture && env.rt.handedOff) env.rt.depInstructed = true;
      },
    },
  };
}

function planSpeed(env: Env): PlanResult {
  const { ac, cmd } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  const perf = perfOf(ac);
  const v = cmd.speedKt!;
  if (v < perf.minSpeedKt || v > perf.maxSpeedKt) {
    return unable(env, `${v} kt is outside the ${ac.type} range (${perf.minSpeedKt}-${perf.maxSpeedKt} kt).`, 'we cannot fly that speed');
  }
  if (ac.altitudeFt < 10000 && perf.category !== 'light' && v > SPEED_LIMIT_BELOW_10K_KT) {
    return unable(env, `${v} kt exceeds the ${SPEED_LIMIT_BELOW_10K_KT} kt limit below 10,000 ft.`, 'that speed exceeds the limit below ten thousand');
  }
  return { plan: { patch: { speedKt: v }, commit: () => { ac.target.speedKt = v; } } };
}

function planContact(env: Env): PlanResult {
  const { ac, rt, cmd, airport, now } = env;
  if (['CLEARED_FOR_TAKEOFF', 'TAKEOFF_ROLL'].includes(ac.phase)) {
    return unable(env, `${ac.callsign} (${ac.phase}) cannot change frequency now.`, "we're busy at the moment");
  }
  // On final / during the landing roll the aircraft complies with the exit instruction first and changes frequency once clear of the runway
  // (JO 7110.65 3-10-9 example: "turn right next taxiway, cross runway two one, contact ground point seven").
  const afterClear = ac.phase === 'LANDING' || ac.phase === 'ROLLOUT';
  let mhz = cmd.frequencyMhz;
  let id = cmd.frequencyId;
  const named = id ? frequencyById(airport, id) : undefined;
  // "Contact departure" for an IFR departure: the sector frequency of its clearance (KACY: 124.6 south / 134.25 north).
  const clearedDep = ac.isDeparture ? ac.flightPlan?.ifrClearance?.departureFrequencyMhz : undefined;
  const byId =
    clearedDep !== undefined && named?.position === 'DEP' && mhz === undefined
      ? (airport.frequencies.find((f) => f.position === 'DEP' && Math.abs(f.mhz - clearedDep) < 0.0005) ?? named)
      : named;
  if (byId) {
    mhz = mhz ?? byId.mhz;
    id = byId.id;
  }
  if (mhz === undefined) return unable(env, `Unknown frequency "${id}".`, 'say again the frequency', false);
  const known = frequencyByMhz(airport, mhz);
  if (!known && !(mhz >= 118 && mhz <= 137)) return unable(env, `${mhz} is not a valid VHF voice frequency.`, 'say again the frequency', false);
  id = byId?.id ?? known?.id ?? id; // positions can share a frequency (APP/DEP): keep the one the controller named
  if (hearsFrequency(ac, mhz)) return unable(env, `${ac.callsign} is already on ${formatMhz(mhz)}.`, "we're already on that frequency", false);
  const finalMhz = mhz;
  const finalId = id;
  return {
    plan: {
      patch: { frequencyMhz: finalMhz, frequencyId: finalId },
      commit: () => {
        rt.pendingFreq = { atSec: now + 3, mhz: finalMhz, id: finalId, afterClear };
      },
    },
  };
}

function planPattern(env: Env): PlanResult {
  const { ac, rt, cmd, ctx, airport } = env;
  const g = env.g!;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  if (!['INBOUND', 'APPROACH', 'GO_AROUND', 'DEPARTURE', 'INITIAL_CLIMB', 'PATTERN'].includes(ac.phase)) {
    return unable(env, `${ac.callsign} (${ac.phase}) cannot enter the pattern now.`, 'we cannot enter the pattern now');
  }
  const leg = cmd.patternLeg ?? 'straight_in';
  return {
    plan: {
      patch: { runwayEnd: g.end.id, patternLeg: leg },
      commit: () => {
        ac.assignedRunwayEnd = g.end.id;
        rt.decisionDone = false;
        rt.navMode = 'AUTO';
        ac.target.headingDeg = undefined;
        ac.target.altitudeFt = undefined;
        ac.nav = undefined;
        rt.approach = undefined;
        rt.missed = undefined;
        rt.hold = undefined;
        if (leg === 'straight_in') {
          rt.pattern = undefined;
          if (ac.phase === 'GO_AROUND') setPhase(ctx, ac, 'APPROACH');
          else if (ac.phase === 'DEPARTURE' || ac.phase === 'INITIAL_CLIMB') {
            /* departures joining straight-in are not modelled; they stay on their heading */
            rt.navMode = 'HEADING';
          }
        } else {
          // A go-around or departure still low and near the runway starts on the upwind leg (AIM 4-3-3: climb straight ahead beyond the departure
          // end and within 300 ft of pattern altitude before the crosswind turn); anything else joins downwind / base.
          const low = leg !== 'base' && (ac.phase === 'GO_AROUND' || (['INITIAL_CLIMB', 'DEPARTURE'].includes(ac.phase) && ac.altitudeFt < patternAltitudeFt(perfOf(ac), g.elevationFt, airport.trafficPatternAltitudeFt) - 300));
          const side = leg === 'right_downwind' ? 'right' : 'left';
          rt.pattern = { leg: leg === 'base' ? 'BASE' : low ? 'UPWIND' : 'DOWNWIND', side, runwayEnd: g.end.id };
          if (low) rt.closedTraffic = { side };
          if (ac.phase !== 'PATTERN') setPhase(ctx, ac, 'PATTERN', leg);
        }
      },
    },
  };
}

function planPushback(env: Env): PlanResult {
  const { ac, ctx } = env;
  if (ac.phase !== 'PARKED' && ac.phase !== 'READY') return unable(env, `${ac.callsign} (${ac.phase}) cannot push back.`, "we can't push back now");
  return { plan: { patch: {}, commit: () => { if (ac.phase === 'PARKED') setPhase(ctx, ac, 'READY', 'pushback'); } } };
}

// ---------------------------------------------------------------------------
// IFR: clearance delivery, radar contact, routing, approaches
// ---------------------------------------------------------------------------

function planIfrClearance(env: Env): PlanResult {
  const { ac, rt, cmd, ctx, now } = env;
  const fp = ac.flightPlan;
  if (!fp || fp.flightRules !== 'IFR') return unable(env, `${ac.callsign} has no IFR flight plan on file.`, "we're VFR, we have no IFR flight plan");
  if (!ac.onGround || (ac.phase !== 'PARKED' && ac.phase !== 'READY')) {
    return unable(env, `${ac.callsign} (${ac.phase}) is not parked; an IFR clearance is issued before taxi.`, "we're already moving");
  }
  if (fp.ifrClearance) return unable(env, `${ac.callsign} already has its IFR clearance.`, 'we already have our clearance', false);
  if (ac.pendingRequest?.kind !== 'IFR_CLEARANCE') return unable(env, `${ac.callsign} has not requested an IFR clearance.`, "we haven't called for our clearance");
  const built = buildIfrClearance(ctx, ac, cmd.ifr);
  if (!built.ok) {
    // An element that cannot be used: the pilot asks for it again ("Say again the squawk code"), other problems are "Unable".
    if (built.sayAgain) return { reject: { reason: built.reason, pilot: `${built.pilot.charAt(0).toUpperCase()}${built.pilot.slice(1)}, ${ac.spokenCallsign}`, commError: true } };
    return unable(env, built.reason, built.pilot);
  }
  const ifr = built.ifr;
  return {
    plan: {
      patch: { ifr },
      commit: () => {
        ac.flightPlan = {
          ...fp,
          departureProcedure: ifr.departureProcedure,
          squawk: ifr.squawk,
          ifrClearance: { ...ifr, readBack: true, issuedAtSec: now },
        };
        ac.squawk = ifr.squawk;
        // The pilot copies the clearance, then tunes Ground and asks for taxi about 15 s later.
        rt.taxiRequestAtSec = now + IFR_TAXI_REQUEST_DELAY_SEC;
      },
    },
  };
}

function planRadarContact(env: Env): PlanResult {
  const { ac, ctx } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground; radar contact applies to airborne aircraft.`, "we're on the ground");
  return {
    plan: {
      patch: {},
      commit: () => {
        ac.radarIdentified = true;
        emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', text: `Radar contact: ${ac.callsign}${ac.squawk ? ` (squawk ${ac.squawk})` : ''}`, data: { radarContact: true } });
      },
    },
  };
}

const ROUTE_PHASES = ['INBOUND', 'APPROACH', 'INITIAL_CLIMB', 'DEPARTURE', 'GO_AROUND', 'HOLDING'];

/** After a missed approach, a route instruction re-sequences the aircraft for another approach. */
function rejoinFromGoAround(env: Env, note: string): void {
  env.rt.missed = undefined;
  env.rt.hold = undefined;
  if (env.ac.phase === 'GO_AROUND' || (env.ac.phase === 'HOLDING' && !env.ac.isDeparture)) setPhase(env.ctx, env.ac, 'APPROACH', note);
}

function planDirectFix(env: Env): PlanResult {
  const { ac, rt, cmd, airport, ctx } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  if (!ROUTE_PHASES.includes(ac.phase)) {
    return unable(env, `${ac.callsign} (${ac.phase}) cannot navigate direct to a fix now.`, ac.phase === 'FINAL' || ac.phase === 'LANDING' ? "we're established on the approach" : 'we cannot proceed direct now');
  }
  const navFix = findNavFix(airport, cmd.fix);
  if (!navFix) return unable(env, `Unknown fix "${cmd.fix}" at ${airport.icao}.`, "we don't have that fix");
  const known = ac.nav?.fixes ?? ac.flightPlan?.route ?? [];
  const k = indexOfFix(airport, known, navFix.id);
  const onApproach = !!rt.approach && ac.nav?.mode === 'approach' && indexOfFix(airport, ac.nav.fixes, navFix.id) >= 0;
  return {
    plan: {
      patch: { fix: navFix.id },
      commit: () => {
        if (rt.approach && !onApproach) {
          rt.approach = undefined; // leaving the published procedure cancels the approach clearance
          completeClearances(ctx, ac, ['APPROACH']);
        }
        if (onApproach) ac.nav = { fixes: ac.nav!.fixes, index: indexOfFix(airport, ac.nav!.fixes, navFix.id), mode: 'approach' };
        else ac.nav = k >= 0 ? { fixes: [...known], index: k, mode: 'direct' } : { fixes: [navFix.id], index: 0, mode: 'direct' };
        rt.navMode = 'AUTO';
        rt.turnDirection = undefined;
        ac.target.headingDeg = undefined;
        rt.navBeforeVectors = undefined;
        rejoinFromGoAround(env, `direct ${navFix.id}`);
        if (ac.isDeparture && rt.handedOff) rt.depInstructed = true;
      },
    },
  };
}

function planResumeNav(env: Env): PlanResult {
  const { ac, rt, airport } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  if (!ROUTE_PHASES.includes(ac.phase)) return unable(env, `${ac.callsign} (${ac.phase}) cannot resume own navigation now.`, 'we cannot resume own navigation now');
  if (ac.nav?.mode === 'approach') return unable(env, `${ac.callsign} is already flying the approach route.`, "we're already flying the approach", false);
  let fixes: string[];
  let index: number;
  let mode: 'route' | 'direct';
  if (ac.nav?.mode === 'vectors') {
    // Back to what was being flown before the vectors.
    fixes = ac.nav.fixes;
    index = ac.nav.index;
    mode = rt.navBeforeVectors ?? 'route';
  } else {
    fixes = ac.flightPlan?.route ?? ac.nav?.fixes ?? [];
    index = fixes.findIndex((f) => !rt.passedFixes.has((findNavFix(airport, f)?.id ?? f).toUpperCase()));
    if (index < 0) index = fixes.length;
    mode = 'route';
  }
  if (!fixes.length) return unable(env, `${ac.callsign} has no route to resume.`, "we don't have a route to resume");
  if (index >= fixes.length) return unable(env, `${ac.callsign} has flown its whole route; there is nothing to resume.`, "we've completed our route");
  return {
    plan: {
      patch: {},
      commit: () => {
        ac.nav = { fixes: [...fixes], index, mode };
        rt.navMode = 'AUTO';
        rt.turnDirection = undefined;
        ac.target.headingDeg = undefined;
        rt.navBeforeVectors = undefined;
        rejoinFromGoAround(env, 'resume own navigation');
        if (ac.isDeparture && rt.handedOff) rt.depInstructed = true;
      },
    },
  };
}

function planApproach(env: Env): PlanResult {
  const { ac, rt, cmd, ctx, airport } = env;
  const g = env.g!;
  const type = cmd.approachType!;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  if (ac.phase === 'LANDING') return unable(env, `${ac.callsign} is already landing.`, "we're already landing", false);
  if ((ac.phase === 'FINAL') && ac.assignedRunwayEnd && ac.assignedRunwayEnd !== g.end.id) {
    return unable(env, `${ac.callsign} is established on final for runway ${ac.assignedRunwayEnd}.`, `we're established on final for runway ${ac.assignedRunwayEnd}`, false);
  }
  if (!['INBOUND', 'APPROACH', 'FINAL', 'GO_AROUND', 'PATTERN', 'HOLDING'].includes(ac.phase) || (ac.isDeparture && ac.phase !== 'GO_AROUND')) {
    return unable(env, `${ac.callsign} (${ac.phase}) is not inbound for an approach.`, "we're not inbound for an approach");
  }
  const autoNav = rt.navMode === 'AUTO' && !ac.nav && ac.phase !== 'GO_AROUND';
  const a = assessApproach(ctx.state, ac, type, g, { autoNav });
  if (a.kind === 'hard') return unable(env, a.reason, a.pilot);
  let flag: string | undefined;
  if (a.geometry) {
    if (ctx.state.scenario.mode === 'training') return unable(env, a.geometry.reason, a.geometry.pilot);
    flag = a.geometry.reason;
  }
  const plan = a.plan;
  const established = ac.phase === 'FINAL';
  return {
    plan: {
      patch: { runwayEnd: g.end.id, runwayId: g.runway.id, approachType: type },
      flag,
      commit: () => {
        completeClearances(ctx, ac, ['APPROACH']);
        rt.missed = undefined;
        rt.hold = undefined;
        rt.missedFlown = false;
        if (ac.phase === 'HOLDING' && !ac.isDeparture) setPhase(ctx, ac, 'APPROACH', `cleared ${type} approach`);
        rt.approach = {
          type, runwayEnd: g.end.id, procedureId: plan.procedureId, onCourse: plan.onCourse, courseTrue: plan.courseTrue, ifDM: plan.ifDM,
          profile: airport.procedures.find((p) => p.id === plan.procedureId)?.fixAltitudes?.map((f) => ({ ...f, fix: f.fix.toUpperCase() })),
          fafDM: plan.fafDM, precision: type === 'ILS' || type === 'LOC',
          pendingCapture: !established && plan.mode === 'intercept', clearedAtSec: env.now,
        };
        if (ac.flightPlan) ac.flightPlan = { ...ac.flightPlan, arrivalApproach: { type, runwayEnd: g.end.id, procedureId: plan.procedureId } };
        if (ac.assignedRunwayEnd !== g.end.id) {
          ac.assignedRunwayEnd = g.end.id;
          rt.decisionDone = false;
          rt.pattern = undefined;
        }
        if (ac.phase === 'GO_AROUND') setPhase(ctx, ac, 'APPROACH', `cleared ${type} approach`);
        if (established) return;
        if (plan.mode === 'route') {
          ac.nav = { fixes: [...plan.fixes], index: 0, mode: 'approach' };
          rt.navMode = 'AUTO';
          rt.turnDirection = undefined;
          ac.target.headingDeg = undefined;
        } else if (plan.mode === 'intercept') {
          ac.target.headingDeg = ac.target.headingDeg ?? ac.headingDeg;
          rt.navMode = 'HEADING';
        } else {
          ac.nav = undefined;
          rt.navMode = 'AUTO';
          ac.target.headingDeg = undefined;
        }
        rt.navBeforeVectors = undefined;
      },
    },
  };
}

const HOLD_PHASES = ['INBOUND', 'APPROACH', 'DEPARTURE', 'GO_AROUND', 'HOLDING'];

/** "Hold at <fix> [as published | inbound course / radial, turns, legs, EFC]": direct-entry holding pattern (see holding.ts). */
function planHoldAtFix(env: Env): PlanResult {
  const { ac, rt, cmd, airport, ctx } = env;
  const h = cmd.hold!;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  if (!HOLD_PHASES.includes(ac.phase)) return unable(env, `${ac.callsign} (${ac.phase}) cannot enter a hold now.`, ac.phase === 'FINAL' || ac.phase === 'LANDING' ? "we're established on the approach" : 'we cannot hold now');
  const navFix = findNavFix(airport, h.fix);
  if (!navFix) return unable(env, `Unknown fix "${h.fix}" at ${airport.icao}.`, "we don't have that fix");
  const pub = publishedHoldFor(airport, navFix.id, rt.approach?.procedureId ?? rt.missed?.procedureId);
  const known = ac.nav?.fixes ?? ac.flightPlan?.route ?? [];
  const prevFixId = (() => {
    const k = indexOfFix(airport, known, navFix.id);
    return k > 0 ? known[k - 1] : undefined;
  })();
  let inboundMag: number;
  let source = 'as issued';
  let assumption: string | undefined;
  if (h.inboundCourseDeg !== undefined) inboundMag = h.inboundCourseDeg;
  else if (pub?.hold.inboundCourseMag !== undefined) {
    inboundMag = pub.hold.inboundCourseMag;
    source = `published (${pub.inboundSource ?? pub.source})`;
  } else {
    const prev = prevFixId ? findNavFix(airport, prevFixId) : undefined;
    const from = prev?.pos ?? ac.pos;
    const brg = Math.atan2(navFix.pos.x - from.x, navFix.pos.y - from.y) * (180 / Math.PI);
    inboundMag = (Math.round(brg - airport.magneticVariationDeg) + 720) % 360;
    source = pub ? `published (${pub.source})` : 'no published hold';
    assumption = `inbound course ${String(inboundMag || 360).padStart(3, '0')} = the course ${prev ? `from ${prev.id}` : 'from the aircraft'} to ${navFix.id} (inbound course not stated or transcribed)`;
  }
  const turns = h.asPublished ? (pub?.hold.turns ?? h.turns ?? 'right') : (h.turns ?? pub?.hold.turns ?? 'right');
  const legNm = h.legNm ?? (h.legMinutes === undefined ? pub?.hold.legNm : undefined);
  const legMinutes = h.legMinutes ?? (legNm === undefined ? pub?.hold.legMinutes : undefined);
  return {
    plan: {
      patch: { hold: { fix: navFix.id, inboundCourseDeg: h.inboundCourseDeg, turns: h.turns ?? 'right', legMinutes: h.legMinutes, legNm: h.legNm, asPublished: !!h.asPublished, efcZulu: h.efcZulu } },
      commit: () => {
        if (rt.approach) completeClearances(ctx, ac, ['APPROACH']);
        startHold(ctx, ac, rt, {
          fix: navFix.id, inboundTrueDeg: magneticToTrue(inboundMag, airport.magneticVariationDeg), turns, legMinutes, legNm, efcZulu: h.efcZulu, source, assumption,
        });
        if (ac.isDeparture && rt.handedOff) rt.depInstructed = true;
      },
    },
  };
}

/** "Execute the missed approach": go around and fly the published missed approach (FINAL / APPROACH). */
function planMissedApproach(env: Env): PlanResult {
  const { ac, ctx } = env;
  if (ac.onGround) return unable(env, `${ac.callsign} is on the ground.`, "we're on the ground");
  if (ac.phase !== 'FINAL' && ac.phase !== 'APPROACH') return unable(env, `${ac.callsign} (${ac.phase}) is not on an approach.`, "we're not on an approach");
  return { plan: { patch: {}, commit: () => initiateGoAround(ctx, ac, { reason: 'ATC instruction', announce: false }) } };
}

const PLANNERS: Partial<Record<ClearanceKind, (env: Env) => PlanResult>> = {
  HOLD_AT_FIX: planHoldAtFix,
  MISSED_APPROACH: planMissedApproach,
  IFR_CLEARANCE: planIfrClearance,
  APPROACH: planApproach,
  DIRECT_FIX: planDirectFix,
  RESUME_OWN_NAVIGATION: planResumeNav,
  RADAR_CONTACT: planRadarContact,
  TAXI: planTaxi,
  TAXI_TO_PARKING: planTaxi,
  HOLD_POSITION: planHoldPosition,
  HOLD_SHORT: planHoldShort,
  CROSS_RUNWAY: planCross,
  LINE_UP_AND_WAIT: planLineUp,
  TAKEOFF: planTakeoff,
  LAND: planLand,
  GO_AROUND: planGoAround,
  CONTINUE_APPROACH: planContinueApproach,
  CONTACT_FREQUENCY: planContact,
  HEADING: planHeading,
  ALTITUDE: planAltitude,
  SPEED: planSpeed,
  ENTER_PATTERN: planPattern,
  PUSHBACK: planPushback,
  EXIT_RUNWAY: planExitRunway,
  CANCEL_TAKEOFF: planCancelTakeoff,
  TRAFFIC_ADVISORY: planTrafficAdvisory,
  FOLLOW_TRAFFIC: planFollowTraffic,
  PATTERN_INSTRUCTION: planPatternInstruction,
  REPORT_POSITION: planReportPosition,
  FREQUENCY_CHANGE_APPROVED: planFrequencyApproved,
  SQUAWK: planSquawk,
  AIRPORT_INFO: planAirportInfo,
};
