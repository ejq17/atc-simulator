/**
 * Pure helpers around the phrase interpreter: when to ask it, how to turn its answer into full `ParsedCommand`s
 * (callsign resolved against the active list, identifiers validated like the grammar's), and which result to keep.
 * No network and no DOM here; the session wires the client (client.ts) in.
 */
import type { ParseResult, ParsedCommand } from '../../sim/types';
import { CALLSIGN_ACCEPT, resolveCallsign } from '../callsign';
import type { AircraftRef } from '../callsign';
import type { ParseContext } from '../context';
import { normalize } from '../normalize';
import { deriveAirlines, protectedWords } from '../parse';
import { validateFields } from '../validate';
import type { LlmCommand, LlmParseResponse } from './contract';

/**
 * A command below this confidence is not trusted to the grammar alone. 0.6 is the engine's own floor
 * (commandExecutor: below 0.6 the pilot asks for clarification instead of acting), so anything the engine would refuse
 * to act on is worth a second reading. In confidence.ts terms (see its factor table) values under 0.6 come from:
 *   - unrecognised words (Fg = coverage^0.75: half the tokens unexplained gives ~0.6 on its own),
 *   - a missing required entity (Fe = 0.55 per missing runway / value / fix),
 *   - a callsign that was not resolved (Fc = 0.40, so never above 0.40),
 *   - conflicts (0.60 each) and unknown identifiers (0.85 each) stacking up.
 * Non-standard wording alone (0.90 per deviation) stays above it, so merely sloppy but understood phraseology never
 * costs a model call.
 */
export const INTERPRETER_BELOW = 0.6;

/** Confidence given to a model command with no validation issue; each issue takes 0.1 off, never below the floor. */
export const LLM_BASE_CONFIDENCE = 0.9;
export const LLM_CONFIDENCE_STEP = 0.1;
export const LLM_CONFIDENCE_FLOOR = 0.5;

export function needsInterpreter(parsed: ParseResult): boolean {
  if (parsed.commands.length === 0) return true;
  return parsed.commands.some((c) => c.kind === 'UNKNOWN' || c.confidence < INTERPRETER_BELOW);
}

/** Exact (case-insensitive, whitespace-free) match first, then the grammar's own resolver on the spoken form. */
function resolveModelCallsign(raw: string | null | undefined, aircraft: readonly AircraftRef[]): string | null {
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  const exact = aircraft.find((a) => a.callsign.toUpperCase() === compact);
  if (exact) return exact.callsign;
  const norm = normalize(raw, { extraAirlines: deriveAirlines(aircraft) });
  const r = resolveCallsign(norm.tokens, aircraft);
  return r.callsign && r.score >= CALLSIGN_ACCEPT ? r.callsign : null;
}

const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * Turn the model's commands into a ParseResult the engine can run. Never trusts the model: the callsign must exist in
 * `ctx.aircraft` (otherwise that command is dropped and the reason is kept on the surviving commands), and runway ends,
 * taxiways, frequencies and fixes go through `validateFields`, the grammar's own check. Null when nothing usable survives,
 * in which case the caller keeps the grammar result.
 */
export function adoptLlmCommands(resp: LlmParseResponse, text: string, ctx: ParseContext): ParseResult | null {
  const norm = normalize(text, { extraAirlines: deriveAirlines(ctx.aircraft), protectedWords: protectedWords(ctx), taxiways: ctx.taxiways, runwayEnds: ctx.runwayEnds });
  const dropped: string[] = [];
  const commands: ParsedCommand[] = [];
  for (const raw of resp.commands ?? []) {
    if (!raw || typeof raw.kind !== 'string' || raw.kind === 'UNKNOWN') continue;
    const callsign = resolveModelCallsign(raw.callsign, ctx.aircraft);
    if (!callsign) {
      dropped.push(raw.callsign ? `interpreter named ${raw.callsign}, which is not an active aircraft` : `interpreter gave no callsign for ${raw.kind}`);
      continue;
    }
    const behind = raw.behindCallsign ? resolveModelCallsign(raw.behindCallsign, ctx.aircraft) : null;
    const fields: Partial<ParsedCommand> = { ...(raw as LlmCommand), callsign };
    if (raw.behindCallsign) {
      if (behind) fields.behindCallsign = behind;
      else delete fields.behindCallsign;
    }
    const val = validateFields(fields, ctx);
    const issues = [...val.issues];
    if (raw.behindCallsign && !behind) issues.push(`unknown aircraft to pass first: ${raw.behindCallsign}`);
    commands.push({
      ...(fields as ParsedCommand),
      kind: raw.kind,
      callsign,
      confidence: 0, // set below, once the issue list is final
      rawText: text,
      normalizedText: norm.text,
      issues: uniq(issues),
      interpretedBy: 'llm',
    });
  }
  if (commands.length === 0) return null;
  for (const c of commands) {
    const issues = uniq([...c.issues, ...dropped]);
    c.issues = issues;
    c.confidence = Math.max(LLM_CONFIDENCE_FLOOR, Math.round((LLM_BASE_CONFIDENCE - LLM_CONFIDENCE_STEP * issues.length) * 100) / 100);
  }
  const nonUnknown = commands.filter((c) => c.kind !== 'UNKNOWN');
  if (commands.length > 1) for (const c of commands) c.groupSize = nonUnknown.length;
  return { commands, callsign: commands[0].callsign, rawText: text, normalizedText: norm.text };
}

/** The interpreter's reading wins when it produced commands; otherwise the grammar's stays (including its clarification path). */
export function mergeResults(grammar: ParseResult, llm: ParseResult | null): ParseResult {
  return llm && llm.commands.length > 0 ? llm : grammar;
}
