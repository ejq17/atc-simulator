import type { Token } from './tokens';

export type Toks = readonly Token[];

/** Normalised text of token i ('' when out of range). */
export const txt = (t: Toks, i: number): string => t[i]?.text ?? '';
export const isOneOf = (t: Toks, i: number, words: readonly string[]): boolean => words.includes(txt(t, i));

/**
 * Match a token pattern at i. Pattern is space separated; `a|b` = alternatives,
 * trailing `?` = optional. Returns the index after the match, or -1.
 *   seq(t, i, 'cleared|clear for|to? the? takeoff')
 */
export function seq(t: Toks, i: number, pattern: string): number {
  let j = i;
  for (const part of pattern.split(' ')) {
    const optional = part.endsWith('?');
    const alts = (optional ? part.slice(0, -1) : part).split('|');
    if (alts.includes(txt(t, j))) j++;
    else if (!optional) return -1;
  }
  return j;
}

/** Skip any run of the given words. */
export function skipWords(t: Toks, i: number, words: ReadonlySet<string> | readonly string[]): number {
  const has = (w: string) => (Array.isArray(words) ? (words as readonly string[]).includes(w) : (words as ReadonlySet<string>).has(w));
  let j = i;
  while (j < t.length && has(txt(t, j))) j++;
  return j;
}

/** Integer number token (no decimal point). */
export const intAt = (t: Toks, i: number): string | null =>
  t[i]?.kind === 'number' && /^\d+$/.test(t[i].text) ? t[i].text : null;
