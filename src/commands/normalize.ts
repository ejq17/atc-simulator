import {
  AIRLINES, ALIASES, DISFLUENCIES, GA_PREFIXES, HOMOPHONE_DIGITS, KEEP_WORDS, NATO, PHRASES, TAXIWAY_CONTEXT,
} from './lexicon';
import { digitValue, evaluateNumberWords, numberWordClass } from './numbers';
import type { NormalizedText, Token, TokenKind } from './tokens';

export interface NormalizeOptions {
  /** Extra spoken-name -> ICAO prefix pairs (e.g. derived from the active aircraft list). */
  extraAirlines?: Readonly<Record<string, string>>;
}

interface Item { w: string; rawStart: number; rawEnd: number; pre?: TokenKind }

const ICAO_LOWER: ReadonlySet<string> = new Set([...AIRLINES.values()].map((c) => c.toLowerCase()));

/**
 * Normalise STT output / typed text into aviation tokens.
 * Lower-cases, strips punctuation, converts spoken numbers to digits, NATO words
 * to letters, airline telephony to ICAO prefixes. Every token keeps its raw word
 * range so the raw text can always be recovered (see `rawSlice`).
 */
export function normalize(raw: string, opts: NormalizeOptions = {}): NormalizedText {
  const airlines = new Map(AIRLINES);
  for (const [name, code] of Object.entries(opts.extraAirlines ?? {})) airlines.set(name.toLowerCase(), code.toUpperCase());
  const known = (w: string): boolean =>
    KEEP_WORDS.has(w) || ICAO_LOWER.has(w) || airlines.has(w) || NATO.has(w) || GA_PREFIXES.has(w) || ALIASES.has(w);

  const rawWords = raw.trim().split(/\s+/).filter(Boolean);
  let items: Item[] = rawWords.flatMap((rw, idx) =>
    cleanWord(rw, known).filter((w) => !DISFLUENCIES.has(w)).map((w) => ({ w, rawStart: idx, rawEnd: idx + 1 })));
  items = applyPhrases(items);
  items = applyAliases(items);
  const lead = new Set<string>([...airlines.keys(), ...GA_PREFIXES.keys(), 'november', 'delta']);
  items = numberPass(items, lead);
  const tokens = resolveTokens(items, airlines);
  return { raw, rawWords, tokens, text: tokens.map((t) => t.text).join(' ') };
}

/** Lower-case, drop punctuation, split letter/digit mixes ("n723ej" -> n 723 e j). */
function cleanWord(rw: string, known: (w: string) => boolean): string[] {
  const s = rw
    .toLowerCase()
    .replace(/(\d),(?=\d{3}(\D|$))/g, '$1')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\.(?!\d)/g, ' ');
  return s.split(/\s+/).filter(Boolean).flatMap((p) => splitAlnum(p, known));
}

function splitLetters(part: string, known: (w: string) => boolean): string[] {
  if (!part) return [];
  if (known(part) || part.length > 2) return [part];
  return part.split('');
}

function splitAlnum(p: string, known: (w: string) => boolean): string[] {
  const m1 = /^([a-z]+)(\d+(?:\.\d+)?)([a-z]*)$/.exec(p);
  if (m1) return [...splitLetters(m1[1], known), m1[2], ...splitLetters(m1[3], known)];
  const m2 = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(p);
  if (m2) return [m2[1], ...splitLetters(m2[2], known)];
  return [p];
}

function applyPhrases(items: Item[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const hit = PHRASES.find((ph) => ph.words.every((w, k) => items[i + k] !== undefined && !items[i + k].pre && items[i + k].w === w));
    if (!hit) { out.push(items[i]); continue; }
    const last = items[i + hit.words.length - 1];
    out.push({ w: hit.to.text, pre: hit.to.kind ?? 'word', rawStart: items[i].rawStart, rawEnd: last.rawEnd });
    i += hit.words.length - 1;
  }
  return out;
}

function applyAliases(items: Item[]): Item[] {
  return items.flatMap((it) => {
    const alias = it.pre ? undefined : ALIASES.get(it.w);
    return alias ? alias.map((w) => ({ ...it, w })) : [it];
  });
}

/** Collapse runs of number words into single digit tokens ("one two one point niner" -> "121.9"). */
function numberPass(items: Item[], lead: ReadonlySet<string>): Item[] {
  const n = items.length;
  const wordAt = (j: number): string | undefined => (j >= 0 && j < n && !items[j].pre ? items[j].w : undefined);
  const strict = (j: number): boolean => { const w = wordAt(j); return w !== undefined && numberWordClass(w) !== null; };
  const digitish = (j: number): boolean => { const w = wordAt(j); return w !== undefined && (numberWordClass(w) ?? 'mult') !== 'mult'; };
  const ohOk = (j: number): boolean => {
    let k = j - 1; while (wordAt(k) === 'oh') k--;
    let m = j + 1; while (wordAt(m) === 'oh') m++;
    return strict(k) || strict(m);
  };
  const fracDigit = (j: number): boolean => { const w = wordAt(j); return w !== undefined && (w === 'oh' || numberWordClass(w) === 'digit'); };
  const numeric = (j: number): boolean => {
    const w = wordAt(j);
    if (w === undefined) return false;
    if (numberWordClass(w)) return true;
    if (w === 'oh') return ohOk(j);
    if (HOMOPHONE_DIGITS.has(w)) {
      const prev = wordAt(j - 1);
      const prevOk = strict(j - 1) || (prev !== undefined && lead.has(prev)) || items[j - 1]?.pre === 'airline';
      return prevOk && digitish(j + 1);
    }
    return false;
  };
  const toDigitWord = (w: string): string =>
    w === 'oh' ? '0' : HOMOPHONE_DIGITS.has(w) ? String(HOMOPHONE_DIGITS.get(w)) : w;

  const w2d = (w: string): string => (w === 'oh' ? '0' : String(digitValue(w)));
  const out: Item[] = [];
  let i = 0;
  while (i < n) {
    const it = items[i];
    if (!it.pre && /^\d*\.?\d+$/.test(it.w) && it.w.length > 1) { out.push({ ...it, pre: 'number' }); i++; continue; }
    const startsDecimal = wordAt(i) === 'point' && fracDigit(i + 1);
    if (!it.pre && (numeric(i) || startsDecimal)) {
      let j = i;
      const words: string[] = [];
      while (numeric(j)) { words.push(toDigitWord(items[j].w)); j++; }
      let text = words.length ? evaluateNumberWords(words) : '';
      if (wordAt(j) === 'point' && fracDigit(j + 1)) {
        let frac = '';
        j++;
        while (fracDigit(j)) { frac += w2d(items[j].w); j++; }
        text += '.' + frac;
      }
      out.push({ w: text, pre: 'number', rawStart: it.rawStart, rawEnd: items[j - 1].rawEnd });
      i = j;
      continue;
    }
    out.push(it);
    i++;
  }
  return out;
}

function resolveTokens(items: Item[], airlines: ReadonlyMap<string, string>): Token[] {
  const tokens: Token[] = [];
  items.forEach((it, idx) => {
    const base = { rawStart: it.rawStart, rawEnd: it.rawEnd };
    const push = (text: string, kind: TokenKind) => tokens.push({ text, kind, ...base });
    if (it.pre === 'airline') return push(it.w.toUpperCase(), 'airline');
    if (it.pre) return push(it.w, it.pre);
    const next = items[idx + 1];
    const nextIsNumber = next?.pre === 'number';
    const w = it.w;
    if (ICAO_LOWER.has(w) && nextIsNumber) return push(w.toUpperCase(), 'airline');
    if (w === 'delta') {
      const prev = tokens[tokens.length - 1];
      const blocked = prev !== undefined && (TAXIWAY_CONTEXT.has(prev.text) || prev.kind === 'letter');
      return nextIsNumber && !blocked ? push('DAL', 'airline') : push('d', 'letter');
    }
    const code = airlines.get(w);
    if (code) return push(code, 'airline');
    if (GA_PREFIXES.has(w)) return push(w, 'gaPrefix');
    const letter = NATO.get(w);
    if (letter) return push(letter, 'letter');
    if (/^[a-z]$/.test(w)) return push(w, 'letter');
    return push(w, 'word');
  });
  return tokens;
}
