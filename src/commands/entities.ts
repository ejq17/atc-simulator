import { intAt, isOneOf, seq, skipWords, txt, type Toks } from './match';

export interface RunwayRef { end: string; id: string }

export type RunwayParse =
  | { ok: true; ref: RunwayRef; next: number }
  | { ok: false; reason: string; next: number };

const SUFFIX: Record<string, string> = { l: 'L', r: 'R', c: 'C' };
const OPPOSITE_SUFFIX: Record<string, string> = { L: 'R', R: 'L', C: 'C', '': '' };

/** Build a runway reference from spoken digits ("04" -> end "4", id "4/22"). */
export function makeRunwayRef(digits: string, suffix = ''): RunwayRef | null {
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n) || n < 1 || n > 36 || digits.length > 2 + (digits.startsWith('0') ? 1 : 0)) return null;
  const opp = ((n + 18 - 1) % 36) + 1;
  const end = `${n}${suffix}`;
  const oppEnd = `${opp}${OPPOSITE_SUFFIX[suffix] ?? ''}`;
  const id = n < opp ? `${end}/${oppEnd}` : `${oppEnd}/${end}`;
  return { end, id };
}

/** Parse "runway <number> [left|right|l|r]" with i pointing at the word "runway". */
export function parseRunway(t: Toks, i: number): RunwayParse | null {
  if (txt(t, i) !== 'runway' && txt(t, i) !== 'runways') return null;
  let j = skipWords(t, i + 1, ['number']);
  const digits = intAt(t, j);
  if (digits === null) return null;
  j++;
  let suffix = '';
  const w = txt(t, j);
  if ((w === 'left' || w === 'right' || w === 'center') && !isOneOf(t, j + 1, ['heading', 'turn'])) {
    suffix = w[0].toUpperCase(); j++;
  } else if (t[j]?.kind === 'letter' && (w === 'l' || w === 'r') && !isOneOf(t, j + 1, ['heading', 'turn'])) {
    suffix = SUFFIX[w]; j++;
  }
  const ref = makeRunwayRef(digits, suffix);
  return ref ? { ok: true, ref, next: j } : { ok: false, reason: `invalid runway "${digits}${suffix}"`, next: j };
}

/** Optional "on|the runway N" directly after a trigger. */
export function runwayAfter(t: Toks, i: number): RunwayParse | null {
  return parseRunway(t, skipWords(t, i, ['on', 'the']));
}

const TAXIWAY_JOINERS: ReadonlySet<string> = new Set(['via', 'along', 'using', 'taxiway', 'taxiways', 'then', 'and', 'on', 'the']);

/** One taxiway identifier at i: a letter, optionally followed by 1-2 digits ("A1"). */
export function parseOneTaxiway(t: Toks, i: number): { id: string; next: number } | null {
  if (t[i]?.kind !== 'letter') return null;
  let id = t[i].text.toUpperCase();
  let j = i + 1;
  const d = intAt(t, j);
  if (d !== null && d.length <= 2 && !d.startsWith('0')) { id += d; j++; }
  return { id, next: j };
}

/** Ordered taxiway list: "via alpha, bravo one then charlie". `next` is just past the last identifier. */
export function parseTaxiways(t: Toks, i: number): { ids: string[]; next: number } {
  const ids: string[] = [];
  let j = i;
  let end = i;
  for (;;) {
    j = skipWords(t, j, TAXIWAY_JOINERS);
    const one = parseOneTaxiway(t, j);
    if (!one) break;
    ids.push(one.id);
    j = end = one.next;
  }
  return { ids, next: end };
}

/** Parking / ramp style destination at i. */
export function parseParking(t: Toks, i: number): { dest: string; next: number } | null {
  const j = skipWords(t, i, ['to', 'the', 'into', 'a']);
  const tryPat = (pattern: string, dest: string) => { const e = seq(t, j, pattern); return e < 0 ? null : { dest, next: e }; };
  const gate = seq(t, j, 'gate');
  if (gate >= 0) {
    const n = intAt(t, gate);
    return n ? { dest: `GATE${n}`, next: gate + 1 } : { dest: 'GATE', next: gate };
  }
  return tryPat('general aviation ramp|parking|area|apron?', 'GA')
    ?? tryPat('ga ramp|parking|area|apron?', 'GA')
    ?? tryPat('fbo ramp?', 'FBO')
    ?? tryPat('cargo ramp|apron|area?', 'CARGO')
    ?? tryPat('terminal', 'TERMINAL')
    ?? tryPat('hangar', 'HANGAR')
    ?? tryPat('ramp', 'RAMP')
    ?? tryPat('parking', 'PARKING')
    ?? tryPat('apron', 'APRON');
}
