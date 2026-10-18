/**
 * Controller transmission pipeline, used by BOTH push-to-talk speech and the typed command box:
 *
 *   text -> parseTransmission(ctx from the live aircraft list) -> for each command engine.applyCommand
 *        -> outcomes (the engine itself logs the ATC call, rejections, clarifications and pilot readbacks)
 *
 * Design decisions
 * - The parse context lists EVERY aircraft so a call to an aircraft on another frequency still resolves and the
 *   engine can answer "Not on frequency" instead of a vague "unknown callsign". Only when the callsign is
 *   ambiguous do we retry with just the aircraft on the controller's frequency(ies), which is how a real
 *   controller would disambiguate.
 * - One `transmissionId` is shared by all commands of a transmission so the engine logs the ATC call once.
 * - The engine already emits the pilot's readback / "say again" through `onPilotTransmission`; this module never
 *   speaks anything itself, so there is no double speech.
 * - Combined positions (Tower + Ground, Approach + Tower, All positions): each command is applied with whichever of
 *   the controller's positions matches the addressed aircraft's current frequency (positions sharing a frequency,
 *   like KACY Approach and Departure, are interchangeable: the earlier one in the set carries the call). An aircraft
 *   on a frequency the player does not work is sent to the primary position, so the engine answers "Not on frequency".
 * - The parse context carries every fix and navaid (`fixes`) so "proceed direct Cedar Lake / MAYBN" resolves.
 * - Processing stops at the first `clarify` (the controller must repeat), but not at a `rejected` command.
 */
import { parseTransmission } from '../../commands';
import type { AircraftRef, FixInfo } from '../../commands';
import type { SimulationEngine } from '../../sim/api';
import type { Aircraft, CommandOutcome, ControllerPositionId, ParsedCommand, SimulationState } from '../../sim/types';
import { frequencyForPosition, positionWord, sameFrequency } from '../../radio/frequencies';

/** The positions the controller is currently working. The first is primary. */
export interface ControllerSetup {
  positions: ControllerPositionId[];
  /**
   * Positions in the session that an AI controller works. The player cannot instruct an aircraft that is on one of their frequencies
   * (it is "with AI Tower"): the call is refused here and never reaches the engine.
   */
  aiPositions?: ControllerPositionId[];
}

export type TransmitSummary = 'accepted' | 'rejected' | 'clarify' | 'empty';

export interface CommandResult {
  command: ParsedCommand;
  outcome: CommandOutcome;
  position: ControllerPositionId;
}

export interface TransmitResult {
  transmissionId: string;
  text: string;
  source: 'voice' | 'typed';
  commands: ParsedCommand[];
  results: CommandResult[];
  summary: TransmitSummary;
  /** One-line human message for the radio panel. */
  message: string;
  /** Set when processing stopped at a clarification. */
  clarification?: string;
  /** True when the first rejection was "Not on frequency" (the aircraft is on a frequency the player does not work). */
  offFrequency?: boolean;
  /** Frequency (MHz) of the position that carried the first command, for the Radio panel's TX indicator. */
  txMhz?: number;
  /** Set when the call was refused because the aircraft is with an AI controller (the player does not work its frequency). */
  aiBlocked?: { callsign: string; position: ControllerPositionId; mhz: number };
}

let seq = 0;
export const nextTransmissionId = (): string => `tx-${Date.now().toString(36)}-${++seq}`;

export function controllerFrequencies(state: Pick<SimulationState, 'airport'>, setup: ControllerSetup): number[] {
  const out: number[] = [];
  for (const p of setup.positions) {
    const f = frequencyForPosition(state.airport, p);
    if (f && !out.some((m) => sameFrequency(m, f.mhz))) out.push(f.mhz);
  }
  return out;
}

const refOf = (a: Aircraft): AircraftRef => ({ callsign: a.callsign, spokenCallsign: a.spokenCallsign, type: a.type });

export function taxiwayNames(state: Pick<SimulationState, 'airport'>): string[] {
  const g = state.airport.taxiwayGraph;
  const names = new Set<string>(Object.keys(g.taxiwayPolylines));
  for (const n of Object.values(g.nodes)) for (const t of n.taxiways) names.add(t);
  names.delete('UNNAMED');
  return [...names].filter((n) => !n.startsWith('RWY')).sort();
}

/**
 * Every fix and navaid of the airport data, for DIRECT_FIX / "until <fix>" resolution. Names come from the data
 * ("CEDAR LAKE"); fixes without a name are matched by identifier or phonetically.
 */
export function fixList(state: Pick<SimulationState, 'airport'>): FixInfo[] {
  const out: FixInfo[] = [];
  for (const n of state.airport.navaids) {
    // Localizer / glideslope / DME ids ("I-PVO") are not places a controller sends an aircraft to.
    if (n.type === 'ILS' || n.type === 'LOC' || n.type === 'DME') continue;
    out.push(n.name ? { id: n.id, name: n.name } : { id: n.id });
  }
  return out;
}

/** The airport's transcribed STARs for the parser ("ROZZE TWO": ident ROZZE2, transitions CRIBB, MUCOW, PONCT, QUINZ, SMYTH). */
export function arrivalList(state: Pick<SimulationState, 'airport'>): { ident: string; spokenName: string; transitions: string[] }[] {
  return state.airport.procedures.filter((p) => p.star).map((p) => ({ ident: p.star!.ident, spokenName: p.star!.spokenName, transitions: p.star!.transitions.map((t) => t.name) }));
}

export function buildParseContext(state: SimulationState, aircraft: Aircraft[] = Object.values(state.aircraft)) {
  const ends = state.airport.runways.flatMap((r) => r.ends.map((e) => e.id));
  return {
    aircraft: aircraft.map(refOf),
    taxiways: taxiwayNames(state),
    runwayEnds: ends,
    frequencies: state.airport.frequencies.map((f) => ({ id: f.id, mhz: f.mhz })),
    fixes: fixList(state),
    arrivals: arrivalList(state),
  };
}

/** Which of the controller's positions should carry a call to `ac` (its frequency decides). */
export function positionFor(state: SimulationState, setup: ControllerSetup, ac: Aircraft | undefined): ControllerPositionId {
  const primary = setup.positions[0] ?? state.controllerPosition;
  if (!ac) return primary;
  for (const p of setup.positions) {
    const f = frequencyForPosition(state.airport, p);
    if (f && sameFrequency(f.mhz, ac.frequencyMhz)) return p;
  }
  return primary;
}

function findAircraft(state: SimulationState, callsign: string | null): Aircraft | undefined {
  if (!callsign) return undefined;
  const up = callsign.toUpperCase();
  return Object.values(state.aircraft).find((a) => a.callsign.toUpperCase() === up);
}

/** "120.3", "124.6", "127.85": a frequency the way a controller says it, without padding zeros. */
export function mhzText(mhz: number): string {
  return String(Number(mhz.toFixed(3)));
}

/** The AI position an aircraft is currently with, if its frequency is an AI one and not also one of the player's. */
export function aiPositionOf(state: Pick<SimulationState, 'airport'>, setup: ControllerSetup, ac: Pick<Aircraft, 'frequencyMhz'> | undefined): { position: ControllerPositionId; mhz: number } | undefined {
  if (!ac || !setup.aiPositions?.length) return undefined;
  if (controllerFrequencies(state, setup).some((m) => sameFrequency(m, ac.frequencyMhz))) return undefined;
  for (const p of setup.aiPositions) {
    const f = frequencyForPosition(state.airport, p);
    if (f && sameFrequency(f.mhz, ac.frequencyMhz)) return { position: p, mhz: f.mhz };
  }
  return undefined;
}

export function aiRefusal(callsign: string, position: ControllerPositionId, mhz: number): string {
  return `${callsign} is with AI ${positionWord(position)} on ${mhzText(mhz)}; wait for the handoff.`;
}

function describe(cmd: ParsedCommand): string {
  return `${cmd.kind.replace(/_/g, ' ').toLowerCase()}${cmd.callsign ? ` ${cmd.callsign}` : ''}`;
}

export interface TransmitInput {
  engine: SimulationEngine;
  text: string;
  source: 'voice' | 'typed';
  controller: ControllerSetup;
  transmissionId?: string;
}

export function transmit(input: TransmitInput): TransmitResult {
  const { engine, source, controller } = input;
  const text = input.text.trim();
  const transmissionId = input.transmissionId ?? nextTransmissionId();
  const empty = (message: string): TransmitResult => ({ transmissionId, text, source, commands: [], results: [], summary: 'empty', message });
  if (!text) return empty('Nothing to transmit.');

  const state = engine.getState();
  const all = Object.values(state.aircraft);
  let parsed = parseTransmission(text, buildParseContext(state, all));

  // Ambiguous callsign: retry among aircraft on the controller's frequencies only.
  const ambiguous = parsed.commands.some((c) => !c.callsign && (c.callsignCandidates?.length ?? 0) > 1);
  if (ambiguous) {
    const freqs = controllerFrequencies(state, controller);
    const onFreq = all.filter((a) => freqs.some((m) => sameFrequency(m, a.frequencyMhz)));
    if (onFreq.length > 0 && onFreq.length < all.length) {
      const retry = parseTransmission(text, buildParseContext(state, onFreq));
      if (retry.commands.length > 0 && retry.commands.every((c) => c.callsign)) parsed = retry;
    }
  }

  if (parsed.commands.length === 0) {
    engine.logEvent({ kind: 'CLARIFICATION', text: 'No instruction recognised in that transmission.', severity: 'info', speaker: 'SYSTEM' });
    return { ...empty('No instruction recognised.'), summary: 'clarify', clarification: 'No instruction recognised in that transmission.' };
  }

  const results: CommandResult[] = [];
  let clarification: string | undefined;
  let aiBlocked: TransmitResult['aiBlocked'];
  for (const command of parsed.commands) {
    const target = findAircraft(engine.getState(), command.callsign);
    const withAi = aiPositionOf(engine.getState(), controller, target);
    if (withAi && target) {
      // The aircraft is on a frequency an AI controller works. Refuse here: the engine would answer "Not on frequency" and the player
      // would not learn why. Nothing is sent, no pilot speaks, nothing is scored.
      const reason = aiRefusal(target.callsign, withAi.position, withAi.mhz);
      aiBlocked = { callsign: target.callsign, position: withAi.position, mhz: withAi.mhz };
      results.push({ command, outcome: { status: 'rejected', reason }, position: withAi.position });
      engine.logEvent({ kind: 'INFO', text: reason, severity: 'warning', speaker: 'SYSTEM', aircraftId: target.id, callsign: target.callsign, frequencyMhz: withAi.mhz });
      break;
    }
    const position = positionFor(engine.getState(), controller, target);
    const outcome = engine.applyCommand(command, { position, source, transmissionId });
    results.push({ command, outcome, position });
    if (outcome.status === 'clarify') {
      clarification = outcome.question;
      break;
    }
  }

  const accepted = results.filter((r) => r.outcome.status === 'accepted');
  const rejected = results.filter((r) => r.outcome.status === 'rejected' && r.command.kind !== 'SAY_AGAIN');
  let summary: TransmitSummary;
  let message: string;
  if (aiBlocked) {
    summary = 'rejected';
    message = (results[results.length - 1].outcome as Extract<CommandOutcome, { status: 'rejected' }>).reason;
  } else if (clarification) {
    summary = 'clarify';
    message = `Clarification needed: ${clarification}`;
  } else if (rejected.length > 0) {
    summary = 'rejected';
    const r = rejected[0].outcome as Extract<CommandOutcome, { status: 'rejected' }>;
    message = `Rejected: ${r.reason}`;
  } else {
    summary = 'accepted';
    message = accepted.length
      ? `Issued: ${accepted.map((r) => describe(r.command)).join(', ')}`
      : `Pilot repeated last transmission${results[0]?.command.callsign ? ` (${results[0].command.callsign})` : ''}.`;
  }
  const offFrequency = !aiBlocked && rejected.some((r) => (r.outcome as Extract<CommandOutcome, { status: 'rejected' }>).reason.startsWith('Not on frequency'));
  const txMhz = results[0] && !aiBlocked ? frequencyForPosition(engine.getState().airport, results[0].position)?.mhz : undefined;
  return { transmissionId, text, source, commands: parsed.commands, results, summary, message, clarification, offFrequency, txMhz, aiBlocked };
}
