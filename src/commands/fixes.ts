import type { Toks } from './match';

/** A named fix / navaid the parser may be asked to recognise (passed in `ParseContext.fixes`). */
export interface FixInfo {
  /** Identifier as stored in the dataset: "CARYL", "SIE". */
  id: string;
  /** Navaid / long name: "Cedar Lake", "Sea Isle", "Atlantic City VOR". Matched exactly (case-insensitive). */
  name?: string;
  /** Pronunciation hint for 5-letter fixes: "carol". Matched exactly or loosely. */
  spoken?: string;
}

export type FixResult =
  | { status: 'known'; id: string; next: number }
  | { status: 'ambiguous'; ids: string[]; next: number }
  | { status: 'unknown'; raw: string; next: number };

export interface FixMatcher {
  /** True when the context supplied a fix list, i.e. "unknown" is a real finding. */
  readonly hasList: boolean;
  /** Resolve the fix named at token i (null when the token cannot start a fix name). */
  resolve(t: Toks, i: number): FixResult | null;
}

/** Normalised Levenshtein threshold for the loose phonetic match. */
export const FIX_MAX_DISTANCE = 0.34;
const MAX_FIX_WORDS = 4;

/** Words that can never be part of a fix name (they start the next instruction or are glue). */
const NOT_FIX: ReadonlySet<string> = new Set([
  'the', 'to', 'then', 'and', 'when', 'able', 'after', 'maintain', 'climb', 'descend', 'turn', 'fly',
  'heading', 'expect', 'contact', 'report', 'cleared', 'clear', 'proceed', 'squawk', 'radar', 'resume',
  'reduce', 'speed', 'runway', 'approach', 'until', 'direct', 'left', 'right', 'hold', 'taxi', 'say',
  'cross', 'line', 'go', 'continue', 'via', 'at', 'of', 'from', 'for', 'on', 'in', 'a', 'airport', 'field',
]);

/** Rough phonetic spelling so "carol" ~ "caryl" and "stev" ~ "stevv". */
export function phon(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c/g, 'k').replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Levenshtein distance divided by the longer length, on phonetic forms. */
export function phoneticDistance(a: string, b: string): number {
  const x = phon(a);
  const y = phon(b);
  const len = Math.max(x.length, y.length);
  return len === 0 ? 1 : levenshtein(x, y) / len;
}

const usable = (t: Toks, i: number): boolean => {
  const tok = t[i];
  return tok !== undefined && (tok.kind === 'word' || tok.kind === 'letter') && !NOT_FIX.has(tok.text);
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function makeFixMatcher(fixes?: readonly FixInfo[]): FixMatcher {
  const list = fixes ?? [];

  function unknownAt(t: Toks, i: number): FixResult | null {
    if (!usable(t, i)) return null;
    if (t[i].kind === 'letter') {
      let j = i;
      while (j < i + 5 && t[j]?.kind === 'letter') j++;
      return { status: 'unknown', raw: t.slice(i, j).map((x) => x.text).join('').toUpperCase(), next: j };
    }
    return { status: 'unknown', raw: t[i].text.toUpperCase(), next: i + 1 };
  }

  function resolve(t: Toks, i: number): FixResult | null {
    if (!usable(t, i)) return null;
    if (list.length === 0) return unknownAt(t, i);
    let best: { d: number; len: number; ids: Set<string> } | null = null;
    for (let len = 1; len <= MAX_FIX_WORDS; len++) {
      if (!usable(t, i + len - 1)) break;
      const words = t.slice(i, i + len).map((x) => x.text);
      const spaced = words.join(' ');
      const flat = squash(spaced);
      for (const f of list) {
        let d = Infinity;
        const names = [f.name, f.spoken].filter((x): x is string => !!x);
        if (names.some((n) => n.toLowerCase() === spaced || squash(n) === flat) || squash(f.id) === flat) d = 0;
        else if (flat.length >= 3) {
          for (const c of [f.id, f.spoken]) if (c) d = Math.min(d, phoneticDistance(flat, c));
          if (d > FIX_MAX_DISTANCE) d = Infinity;
        }
        if (d === Infinity) continue;
        if (!best || d < best.d || (d === best.d && len > best.len)) best = { d, len, ids: new Set([f.id.toUpperCase()]) };
        else if (d === best.d && len === best.len) best.ids.add(f.id.toUpperCase());
      }
    }
    if (best) {
      const ids = [...best.ids];
      const next = i + best.len;
      return ids.length === 1 ? { status: 'known', id: ids[0], next } : { status: 'ambiguous', ids, next };
    }
    return unknownAt(t, i);
  }

  return { hasList: list.length > 0, resolve };
}
