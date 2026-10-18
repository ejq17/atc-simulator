import type { ParseResult, ParsedCommand } from '../sim/types';
import { assemble, type PlacedDraft } from './assemble';
import { resolveCallsign, type AircraftRef, type CallsignResolution } from './callsign';
import { commandConfidence } from './confidence';
import type { ParseContext } from './context';
import { makeDraft } from './draft';
import { buildRules, scan } from './grammar';
import { GA_PREFIXES } from './lexicon';
import { normalize } from './normalize';
import { numberWordClass } from './numbers';
import { missingRequired } from './requirements';
import { rawSlice, type NormalizedText, type Token } from './tokens';
import { validateFields } from './validate';

/** Spoken airline names found in the active aircraft ("Foo twelve" for FOO12) -> ICAO prefix. */
function deriveAirlines(aircraft: readonly AircraftRef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ac of aircraft) {
    const code = /^([A-Z]{3})\d/.exec(ac.callsign.toUpperCase())?.[1];
    const first = ac.spokenCallsign.toLowerCase().match(/^[a-z]+/)?.[0];
    if (code && first && first.length >= 3 && !GA_PREFIXES.has(first) && !numberWordClass(first)) out[first] = code;
  }
  return out;
}

/** Words of the active callsigns and fixes: never fuzz-corrected into instruction words. */
function protectedWords(ctx: ParseContext): ReadonlySet<string> {
  const words = new Set<string>();
  const add = (s: string | undefined) => { for (const w of (s ?? '').toLowerCase().match(/[a-z]+/g) ?? []) words.add(w); };
  for (const ac of ctx.aircraft) add(ac.spokenCallsign);
  for (const f of ctx.fixes ?? []) { add(f.id); add(f.name); add(f.spoken); }
  return words;
}

/** Contiguous runs of unconsumed tokens: [start, end). */
function leftoverRuns(consumed: readonly boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  for (let i = 0; i < consumed.length;) {
    if (consumed[i]) { i++; continue; }
    let j = i;
    while (j < consumed.length && !consumed[j]) j++;
    runs.push([i, j]);
    i = j;
  }
  return runs;
}

function nearest(drafts: readonly PlacedDraft[], run: [number, number]): PlacedDraft | undefined {
  const dist = (p: PlacedDraft) => Math.max(p.start - run[1], run[0] - p.end, 0);
  return [...drafts].sort((a, b) => dist(a) - dist(b))[0];
}

const uniq = (xs: string[]) => [...new Set(xs)];

/** Mask tokens consumed by the callsign so grammar rules cannot read them as numbers/letters. */
function maskCallsign(tokens: readonly Token[], cs: CallsignResolution): { toks: Token[]; masked: boolean[] } {
  const masked = tokens.map((_, i) => cs.span !== null && i >= cs.span.start && i < cs.span.end);
  const toks = tokens.map((t, i): Token => (masked[i] ? { ...t, text: '\u0000', kind: 'barrier' } : t));
  return { toks, masked };
}

export function parse(text: string, ctx: ParseContext): ParseResult {
  const norm: NormalizedText = normalize(text, { extraAirlines: deriveAirlines(ctx.aircraft), protectedWords: protectedWords(ctx) });
  const cs = resolveCallsign(norm.tokens, ctx.aircraft);
  const { toks, masked } = maskCallsign(norm.tokens, cs);
  const { drafts, consumed } = assemble(scan(toks, buildRules(ctx)), toks.length, masked);
  const coverage = toks.length === 0 ? 0 : consumed.filter(Boolean).length / toks.length;

  const leftovers = new Map<PlacedDraft, string[]>();
  const orphan: string[] = [];
  for (const run of leftoverRuns(consumed)) {
    const words = `unrecognised words: "${norm.tokens.slice(run[0], run[1]).map((t) => t.text).join(' ')}"`;
    const owner = nearest(drafts, run);
    if (owner) leftovers.set(owner, [...(leftovers.get(owner) ?? []), words]);
    else orphan.push(words);
  }

  const placed: PlacedDraft[] = drafts.length > 0 ? drafts : [{ draft: makeDraft('UNKNOWN'), start: 0, end: 0 }];
  if (drafts.length === 0) {
    placed[0].draft.issues.push(toks.length === 0 ? 'empty transmission' : 'no recognised instruction', ...orphan);
  }
  const multi = cs.otherCallsigns.length > 0 ? [`multiple callsigns mentioned: ${[cs.callsign ?? '?', ...cs.otherCallsigns].join(', ')}`] : [];

  const commands: ParsedCommand[] = placed.map((p) => {
    const d = p.draft;
    if (d.routeSpan && d.fields.ifr) {
      const route = rawSlice(norm, d.routeSpan[0], d.routeSpan[1]).replace(/[\s,.;]+$/, '').trim();
      if (route) d.fields.ifr.routeText = route;
    }
    const val = validateFields(d.fields, ctx);
    const missing = d.kind === 'UNKNOWN' ? [] : missingRequired(d);
    const confidence = commandConfidence({
      kind: d.kind,
      coverage,
      callsignScore: cs.callsign ? cs.score : null,
      missingRequired: missing.length,
      conflicts: d.conflicts + val.conflicts + multi.length,
      unknownIds: d.unknownIds + val.unknownIds,
      nonstandard: d.nonstandard,
    });
    const cmd: ParsedCommand = {
      kind: d.kind,
      callsign: cs.callsign,
      ...d.fields,
      confidence,
      rawText: text,
      normalizedText: norm.text,
      issues: uniq([...cs.issues, ...multi, ...d.issues, ...missing, ...val.issues, ...(leftovers.get(p) ?? [])]),
    };
    if (!cs.callsign && cs.candidates.length > 0) cmd.callsignCandidates = cs.candidates.map((c) => c.callsign);
    return cmd;
  });

  return { commands, callsign: cs.callsign, rawText: text, normalizedText: norm.text };
}
