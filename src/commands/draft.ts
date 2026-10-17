import type { CommandKind, ParsedCommand } from '../sim/types';
import type { RunwayParse, RunwayRef } from './entities';
import type { Toks } from './match';

/** Command under construction: ParsedCommand fields found by the grammar. */
export interface Draft {
  kind: CommandKind;
  fields: Partial<ParsedCommand>;
  issues: string[];
  /** count of non-standard phraseology deviations (each lowers confidence) */
  nonstandard: number;
  /** count of conflicting entities (each lowers confidence) */
  conflicts: number;
  /** identifiers that failed hard validation (bad runway number etc.) */
  unknownIds: number;
  /** IFR clearance: token range of the route phrase, resolved to raw text by parse.ts */
  routeSpan?: [number, number];
}

export type Body =
  | { type: 'cmd'; draft: Draft }
  | { type: 'runway'; parse: RunwayParse }
  | { type: 'route'; ids: string[] }
  | { type: 'filler' };

export interface Hit { end: number; body: Body }
export type Rule = (t: Toks, i: number) => Hit | null;
/** A recognised span of tokens [start, end). */
export interface Element { start: number; end: number; body: Body }

export function makeDraft(kind: CommandKind, fields: Partial<ParsedCommand> = {}): Draft {
  return { kind, fields, issues: [], nonstandard: 0, conflicts: 0, unknownIds: 0 };
}

export const cmdHit = (end: number, draft: Draft): Hit => ({ end, body: { type: 'cmd', draft } });
export const fillerHit = (end: number): Hit => ({ end, body: { type: 'filler' } });

/** Write a runway reference into the field(s) that suit the command kind. */
export function applyRunway(d: Draft, ref: RunwayRef): void {
  const f = d.fields;
  f.runwayEnd = ref.end;
  f.runwayId = ref.id;
  if (d.kind === 'TAXI') f.destination = `RWY${ref.end}`;
  if (d.kind === 'HOLD_SHORT') f.holdShort = [`RWY${ref.end}`];
  if (d.kind === 'CROSS_RUNWAY') f.crossRunwayId = ref.id;
}

/** Kinds that take a runway argument, and whether one is still missing. */
export function acceptsRunway(d: Draft): boolean {
  return ['TAXI', 'HOLD_SHORT', 'CROSS_RUNWAY', 'LINE_UP_AND_WAIT', 'TAKEOFF', 'LAND', 'ENTER_PATTERN', 'APPROACH'].includes(d.kind);
}

export function lacksRunway(d: Draft): boolean {
  const f = d.fields;
  switch (d.kind) {
    case 'TAXI': return !f.destination;
    case 'HOLD_SHORT': return !f.holdShort?.length;
    case 'CROSS_RUNWAY': return !f.crossRunwayId;
    default: return !f.runwayEnd;
  }
}

/** Spoken runway end already stored on a draft, if any. */
export const draftRunwayEnd = (d: Draft): string | undefined => d.fields.runwayEnd;
