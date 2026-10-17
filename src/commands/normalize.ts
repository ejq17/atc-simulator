import {
  AIRLINES, ALIASES, DISFLUENCIES, FILLERS, GA_PREFIXES, HOMOPHONE_DIGITS, KEEP_WORDS, NATO, PHRASES, TAXIWAY_CONTEXT,
} from './lexicon';
import { digitValue, evaluateNumberWords, numberWordClass } from './numbers';
import type { NormalizedText, Token, TokenKind } from './tokens';

export interface NormalizeOptions {
  /** Extra spoken-name -> ICAO prefix pairs (e.g. derived from the active aircraft list). */
  extraAirlines?: Readonly<Record<string, string>>;
}

interface Item { w: string; rawStart: number; rawEnd: number; pre?: TokenKind; /** raw word ended with , . ; : ! ? -> a spoken number cannot continue past it */ brk?: boolean }

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
  let items: Item[] = rawWords.flatMap((rw, idx) => {
    const pieces = cleanWord(rw, known).filter((w) => !DISFLUENCIES.has(w));
    const brk = /[,;:!?]$|[a-z]\.$/i.test(rw);
    return pieces.map((w, k): Item => ({ w, rawStart: idx, rawEnd: idx + 1, ...(brk && k === pieces.length - 1 ? { brk } : {}) }));
  });
  items = applyPhrases(items);
  items = applyAliases(items);
  const lead = new Set<string>([...airlines.keys(), ...GA_PREFIXES.keys(), 'november', 'delta']);
  items = repairNato(items, known, lead);
  items = numberPass(items, lead);
  const tokens = resolveTokens(items, airlines);
  return { raw, rawWords, tokens, text: tokens.map((t) => t.text).join(' ') };
}

/** Lower-case, drop punctuation, split letter/digit mixes ("n723ej" -> n 723 e j). */
function cleanWord(rw: string, known: (w: string) => boolean): string[] {
  const s = rw
    .toLowerCase()
    .replace(/(\d),(?=\d{3}(\D|$))/g, '$1')
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1') // "4th" is a spoken "four" (STT ordinal guess), never letters t h
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
    out.push({ w: hit.to.text, pre: hit.to.kind ?? 'word', rawStart: items[i].rawStart, rawEnd: last.rawEnd, ...(last.brk ? { brk: true } : {}) });
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

/** Levenshtein edit distance. */
export function editDistance(a: string, b: string): number {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, k) => k);
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

const NATO_WORDS = [...NATO.keys()].filter((w) => w.length >= 4 && NATO.get(w) !== 'n' && NATO.get(w) !== 'd');
const natoTolerance = (target: string): number => Math.floor(target.length / 3);

/** A NATO word within tolerance of `piece`, or null. */
function nearestNato(piece: string, maxExtra = 0): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const w of NATO_WORDS) {
    const d = editDistance(piece, w);
    if (d <= natoTolerance(w) + maxExtra && d < bestD) { best = w; bestD = d; }
  }
  return best;
}

/**
 * Repair mangled NATO words next to a callsign or taxiway ("november 467 ecosira" -> echo sierra, "via baravo" -> bravo).
 * Whisper tiny.en writes the sound it heard, often fusing two phonetic letters into one made-up word. Only words the
 * lexicon does not know, directly after a digit, a NATO word or a taxiway joiner, are touched.
 */
function repairNato(items: Item[], known: (w: string) => boolean, lead: ReadonlySet<string>): Item[] {
  const out: Item[] = [];
  const context = (prev: Item | undefined): boolean =>
    prev !== undefined && !prev.pre && (NATO.has(prev.w) || numberWordClass(prev.w) !== null || /^\d+$/.test(prev.w)
      || TAXIWAY_CONTEXT.has(prev.w) || lead.has(prev.w));
  for (const it of items) {
    const prev = out[out.length - 1];
    const w = it.w;
    const candidate = !it.pre && w.length >= 5 && /^[a-z]+$/.test(w) && !known(w) && !FILLERS.has(w)
      && numberWordClass(w) === null && !HOMOPHONE_DIGITS.has(w) && context(prev);
    if (!candidate) { out.push(it); continue; }
    const one = nearestNato(w);
    if (one && editDistance(w, one) <= 1) { out.push({ ...it, w: one }); continue; }
    let split: [string, string] | null = null;
    let splitD = Infinity;
    if (w.length >= 6) {
      for (let cut = 3; cut <= w.length - 3; cut++) {
        const a = nearestNato(w.slice(0, cut));
        const b = nearestNato(w.slice(cut));
        if (!a || !b) continue;
        const d = editDistance(w.slice(0, cut), a) + editDistance(w.slice(cut), b);
        if (d < splitD) { split = [a, b]; splitD = d; }
      }
    }
    if (split) out.push({ ...it, w: split[0] }, { ...it, w: split[1] });
    else out.push(it);
  }
  return out;
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
  /** The run beginning at i follows a callsign lead word ("november", "cessna", "spirit"): it is an aircraft identifier. */
  const afterLead = (i: number): boolean => {
    const prev = wordAt(i - 1);
    return (prev !== undefined && lead.has(prev)) || items[i - 1]?.pre === 'airline';
  };
  const natoAt = (j: number): boolean => { const w = wordAt(j); return w !== undefined && NATO.has(w); };
  const isDigits = (j: number): boolean => /^\d+$/.test(wordAt(j) ?? '');
  const numeric = (j: number, inCallsign = false): boolean => {
    const w = wordAt(j);
    if (w === undefined) return false;
    if (numberWordClass(w)) return true;
    if (w === 'oh') return ohOk(j);
    if (HOMOPHONE_DIGITS.has(w)) {
      const prev = wordAt(j - 1);
      // "runway for": the word after "runway" is always its number
      if (prev === 'runway' && !digitish(j + 1)) return true;
      const prevOk = strict(j - 1) || isDigits(j - 1) || (prev !== undefined && lead.has(prev)) || items[j - 1]?.pre === 'airline';
      // "six zero zero for tango": inside a callsign a homophone digit may be the last digit before the letters
      return prevOk && (digitish(j + 1) || (inCallsign && natoAt(j + 1)));
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
    if (!it.pre && /^\d*\.?\d+$/.test(it.w) && it.w.length > 1) {
      // "november 6000 for tango": a digit string, then a homophone digit, then the callsign letters
      const h = wordAt(i + 1);
      if (isDigits(i) && !it.brk && afterLead(i) && h !== undefined && HOMOPHONE_DIGITS.has(h) && natoAt(i + 2)) {
        out.push({ w: it.w + String(HOMOPHONE_DIGITS.get(h)), pre: 'number', rawStart: it.rawStart, rawEnd: items[i + 1].rawEnd });
        i += 2;
        continue;
      }
      out.push({ ...it, pre: 'number' }); i++; continue;
    }
    const startsDecimal = wordAt(i) === 'point' && fracDigit(i + 1);
    if (!it.pre && (numeric(i) || startsDecimal)) {
      let j = i;
      const inCallsign = afterLead(i);
      const words: string[] = [];
      while (numeric(j, inCallsign)) { words.push(toDigitWord(items[j].w)); j++; if (items[j - 1].brk) break; }
      const cut = words.length > 1 && /^minutes?$/.test(wordAt(j) ?? '') ? minuteCut(words, items[i - 1]?.w === 'fl') : 0;
      if (cut > 0) { words.length = cut; j = i + cut; }
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

/**
 * "expect one zero thousand one zero minutes after departure": the number run before
 * "minutes" is an altitude followed by a minute count. Returns how many words belong
 * to the first number (0 = leave the run alone).
 */
function minuteCut(words: readonly string[], afterFlightLevel: boolean): number {
  const t = words.lastIndexOf('thousand');
  if (t >= 0 && t < words.length - 1 && !words.slice(t + 1).includes('hundred')) return t + 1;
  if (afterFlightLevel && words.length > 3 && words.slice(0, 3).every((w) => numberWordClass(w) === 'digit')) return 3;
  return 0;
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
