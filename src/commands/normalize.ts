import {
  AIRLINES, ALIASES, DISFLUENCIES, FACILITIES, FILLERS, FUZZY_KEYWORDS, FUZZ_PROTECTED, GA_PREFIXES, HOMOPHONE_DIGITS, FOXTROT_FUSED, FOXTROT_WORDS, KEEP_WORDS, N_PREFIX_WORDS,
  NATO, PHRASES, TAXIWAY_CONTEXT, TOWER_MISHEARD, ARTICLES, ARTICLE_AFTER,
} from './lexicon';
import { digitValue, evaluateNumberWords, numberWordClass } from './numbers';
import type { NormalizedText, Token, TokenKind } from './tokens';

export interface NormalizeOptions {
  /** Extra spoken-name -> ICAO prefix pairs (e.g. derived from the active aircraft list). */
  extraAirlines?: Readonly<Record<string, string>>;
  /** Lower-case words the fuzzy corrector must leave alone (spoken callsigns, fix names ...). */
  protectedWords?: ReadonlySet<string>;
  /** The airport's taxiway ids: enables the foxtrot-drift repair (only when F is one of them). */
  taxiways?: readonly string[];
  /** The airport's runway ends: a bare end after "cross" gets its "runway" word back. */
  runwayEnds?: readonly string[];
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
  items = dropViaArticle(items, rawWords);
  items = dropVehicleWord(items);
  const lead = new Set<string>([...airlines.keys(), ...GA_PREFIXES.keys(), 'november', 'delta']);
  items = foxtrotDrift(items, known, lead, opts);
  items = repairNato(items, known, lead);
  items = fuzzyCorrect(items, known, lead, opts.protectedWords);
  items = numberPass(items, lead);
  items = crossCleanup(items, opts.runwayEnds);
  const tokens = resolveTokens(items, airlines);
  tokens.forEach((tk, k) => {
    const next = tokens[k + 1];
    if (/[,;]$/.test(rawWords[tk.rawEnd - 1] ?? '') && (!next || next.rawStart >= tk.rawEnd)) tk.comma = true;
  });
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
    if (hit.to.text === '') { i += hit.words.length - 1; continue; } // filler phrase: dropped
    if (hit.to.text.includes(' ') && !hit.to.kind) {
      for (const w of hit.to.text.split(' ')) out.push({ w, rawStart: items[i].rawStart, rawEnd: last.rawEnd, ...(last.brk ? { brk: true } : {}) });
      i += hit.words.length - 1;
      continue;
    }
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

/**
 * "via a Lima" -> "via Lima", "on an Alpha" -> "on Alpha": the STT article (lower-case in the raw text) between a route preposition and a
 * spelled NATO word is noise. For "via" it is the second half of the word, so it is merged into it.
 */
function dropViaArticle(items: Item[], rawWords: readonly string[]): Item[] {
  const out: Item[] = [];
  items.forEach((it, k) => {
    const prev = out[out.length - 1];
    const next = items[k + 1];
    if (!it.pre && ARTICLES.has(it.w) && rawWords[it.rawStart] === it.w && prev && (!prev.pre || prev.pre === 'word') && ARTICLE_AFTER.has(prev.w)
      && next && !next.pre && NATO.has(next.w)) {
      out[out.length - 1] = { ...prev, rawEnd: it.rawEnd, ...(it.brk ? { brk: true } : {}) };
      return;
    }
    out.push(it);
  });
  return out;
}

/** "airport vehicle one" -> "airport one": the vehicle form spoken in either order (AC 150/5210-20A has "Airport 21 vehicle"). */
function dropVehicleWord(items: Item[]): Item[] {
  return items.filter((it, k) => !(!it.pre && it.w === 'vehicle' && items[k - 1]?.w === 'airport' && !items[k - 1].pre
    && items[k + 1] !== undefined && !items[k + 1].pre && (numberWordClass(items[k + 1].w) !== null || /^\d+$/.test(items[k + 1].w))));
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
    const base = !it.pre && /^[a-z]+$/.test(w) && !known(w) && !FILLERS.has(w) && numberWordClass(w) === null && !HOMOPHONE_DIGITS.has(w);
    const candidate = base && w.length >= 5 && context(prev);
    // Callsign-letter repair: a 3-5 letter unknown word straight after a callsign digit run ("november 3619 kila", "n 12 xra")
    const letterSlot = base && !candidate && w.length >= 3 && w.length <= 5 && !FUZZ_PROTECTED.has(w) && !TOWER_MISHEARD.has(w)
      && !N_PREFIX_WORDS.has(w) && afterCallsignDigits(out, lead);
    if (letterSlot) {
      const near = nearestNato(w);
      // 3 letters only as a clipped NATO word ("xra" -> xray): a prefix of it
      if (near && editDistance(w, near) <= 1 && (w.length > 3 || near.startsWith(w))) out.push({ ...it, w: near }); else out.push(it);
      continue;
    }
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

/** The items so far end in a run of digits that follows a callsign lead word ("november 3 6 19", "remember 3619"). */
function afterCallsignDigits(out: readonly Item[], lead: ReadonlySet<string>): boolean {
  let k = out.length - 1;
  const digitLike = (x: Item): boolean => !x.pre && (/^\d+$/.test(x.w) || numberWordClass(x.w) !== null);
  if (k < 0 || !digitLike(out[k])) return false;
  while (k >= 0 && digitLike(out[k])) k--;
  const before = out[k];
  return before !== undefined && (before.pre === 'airline' || (!before.pre && (lead.has(before.w) || N_PREFIX_WORDS.has(before.w))));
}

const FUZZ_NATO = [...NATO.keys()].filter((w) => w.length >= 4 && NATO.get(w) !== 'n' && NATO.get(w) !== 'd');
/** NATO words after which a spelled letter is expected (a taxiway list): the only place a NATO word is fuzz-corrected. */
const ROUTE_CONTEXT: ReadonlySet<string> = new Set([...TAXIWAY_CONTEXT, 'taxi', 'taxiing']);

/** Allowed edit distance for an unknown word of length n: 1 for 4-5 letters, 2 from 6, none below 4. */
const fuzzLimit = (n: number): number => (n >= 6 ? 2 : n >= 4 ? 1 : -1);

/**
 * The single replacement within the fuzz distance of `w` among `candidates` (mapped through `out`), or null when none
 * is close enough or two different replacements tie.
 */
function uniqueNear(w: string, candidates: readonly string[], out: (c: string) => string): string | null {
  const limit = fuzzLimit(w.length);
  let best: string | null = null;
  let bestD = Infinity;
  let tie = false;
  for (const c of candidates) {
    if (Math.abs(c.length - w.length) > limit) continue;
    const d = editDistance(w, c);
    if (d > limit) continue;
    if (d < bestD) { best = out(c); bestD = d; tie = false; } else if (d === bestD && out(c) !== best) tie = true;
  }
  return tie ? null : best;
}

/**
 * General STT repair: an unknown word within Levenshtein distance 1 (4-5 letters) or 2 (6+) of exactly one core
 * instruction keyword ("taxa" -> taxi, "shore" -> short) or, in a taxiway list, one NATO word ("branvo" -> bravo) is
 * replaced by it. "viaLima" style fusions become "via lima". Left alone: digits, anything the lexicon, grammar or the
 * active aircraft/fixes give a meaning to, callsign lead words, and NATO corrections right after a number or callsign
 * lead (those are callsign letters; `repairNato` owns them). The raw word range is kept for `rawSlice`.
 */
function fuzzyCorrect(items: Item[], known: (w: string) => boolean, lead: ReadonlySet<string>, protectedWords?: ReadonlySet<string>): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    const w = it.w;
    const unknown = !it.pre && /^[a-z]{4,}$/.test(w) && !known(w) && !FILLERS.has(w) && !FUZZ_PROTECTED.has(w)
      && !protectedWords?.has(w) && numberWordClass(w) === null && !HOMOPHONE_DIGITS.has(w) && !FACILITIES.has(w)
      && !N_PREFIX_WORDS.has(w) && !TOWER_MISHEARD.has(w) && !TAXIWAY_CONTEXT.has(w) && !lead.has(w)
      && !FUZZY_KEYWORDS.includes(w);
    if (!unknown) { out.push(it); continue; }
    if (w.startsWith('via') && w.length >= 7) {
      const rest = nearestNato(w.slice(3));
      if (rest && editDistance(w.slice(3), rest) <= 1) { out.push({ ...it, w: 'via' }, { ...it, w: rest }); continue; }
    }
    const keyword = uniqueNear(w, FUZZY_KEYWORDS, (c) => c);
    if (keyword) { out.push({ ...it, w: keyword }); continue; }
    const afterCallsign = prev !== undefined && (prev.pre === 'number' || /^\d+$/.test(prev.w) || numberWordClass(prev.w) !== null || lead.has(prev.w));
    const routeish = prev !== undefined && !prev.pre && (NATO.has(prev.w) || ROUTE_CONTEXT.has(prev.w));
    const letter = !afterCallsign && routeish ? uniqueNear(w, FUZZ_NATO, (c) => NATO.get(c) as string) : null;
    if (letter) out.push({ ...it, w: [...NATO.entries()].find(([k, v]) => v === letter && k.length >= 4)?.[0] ?? w });
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
  const natoAt = (j: number): boolean => { const w = wordAt(j); return (w !== undefined && NATO.has(w)) || items[j]?.pre === 'letter'; };
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
      // "american 3.23" / "runway 1.7": STT dots inside a flight number or runway are not decimals
      if (/^\d{1,2}\.\d{1,3}$/.test(it.w) && (afterLead(i) || wordAt(i - 1) === 'runway')) {
        out.push({ ...it, w: it.w.replace('.', ''), pre: 'number' }); i++; continue;
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

/** Callsign words of the military / vehicle forms that are also ordinary words ("air", "airport", "coast"). */
const SERVICE_CODES: ReadonlySet<string> = new Set(['APT', 'ANG', 'CGD']);

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
    if (code && (!SERVICE_CODES.has(code) || nextIsNumber)) return push(code, 'airline'); // "airport 21 vehicle", "air guard": words of ordinary phrases ("air taxi"), a callsign only before a number
    if (code) return push(w, 'word');
    if (GA_PREFIXES.has(w)) return push(w, 'gaPrefix');
    const letter = NATO.get(w);
    if (letter) return push(letter, 'letter');
    if (/^[a-z]$/.test(w)) return push(w, 'letter');
    return push(w, 'word');
  });
  return tokens;
}

/**
 * Foxtrot drift: Whisper hears "foxtrot" as "fox drive", "fucks truck", "foxdrought" ... In a taxiway context (after via, on,
 * at, cross, and ..., or after a spelled letter) and only when F is one of the airport's taxiways, a fox word followed by one
 * unknown short word (or a single fused fox-word) becomes the NATO word "foxtrot". A lone fox word in that context too.
 */
function foxtrotDrift(items: Item[], known: (w: string) => boolean, lead: ReadonlySet<string>, opts: NormalizeOptions): Item[] {
  if (!opts.taxiways?.some((t) => t.toUpperCase() === 'F')) return items;
  const junk = (it: Item | undefined): boolean => {
    if (!it || it.pre) return false;
    const w = it.w;
    return /^[a-z]{3,14}$/.test(w) && !known(w) && !FILLERS.has(w) && !FUZZ_PROTECTED.has(w) && !TAXIWAY_CONTEXT.has(w)
      && !FUZZY_KEYWORDS.includes(w) && numberWordClass(w) === null && !HOMOPHONE_DIGITS.has(w) && !FOXTROT_WORDS.has(w)
      && !FACILITIES.has(w) && !N_PREFIX_WORDS.has(w) && !TOWER_MISHEARD.has(w) && !lead.has(w) && !opts.protectedWords?.has(w);
  };
  const letterish = (x: Item | undefined): boolean => x !== undefined && (x.pre === 'letter' || (!x.pre && (NATO.has(x.w) || /^[a-z]$/.test(x.w))));
  const inRoute = (out: readonly Item[]): boolean => {
    const prev = out[out.length - 1];
    if (!prev) return false;
    if (prev.pre) return prev.pre === 'letter';
    if (TAXIWAY_CONTEXT.has(prev.w) || ROUTE_CONTEXT.has(prev.w) || letterish(prev)) return true;
    return /^\d$/.test(prev.w) && letterish(out[out.length - 2]); // "alpha 2 fox drive"
  };
  const out: Item[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const fox = !it.pre && inRoute(out);
    const fused = fox && FOXTROT_FUSED.test(it.w) && junk(it);
    const lone = fox && FOXTROT_WORDS.has(it.w);
    if (fused || lone) {
      const tail = lone && junk(items[k + 1]) ? items[k + 1] : null;
      const last = tail ?? it;
      out.push({ w: 'foxtrot', rawStart: it.rawStart, rawEnd: last.rawEnd, ...(last.brk ? { brk: true } : {}) });
      if (tail) k++;
      continue;
    }
    out.push(it);
  }
  return out;
}

/**
 * After numbers are formed: (1) "cross <taxiway> cross <runway>" - the first cross-and-letter is noise (STT repeat) and is
 * dropped; (2) "cross 3 5" with 35 a runway end of this airport regains its word "runway".
 */
function crossCleanup(items: Item[], runwayEnds?: readonly string[]): Item[] {
  const isLetter = (x: Item | undefined): boolean => x !== undefined && (x.pre === 'letter' || (!x.pre && (NATO.has(x.w) || /^[a-z]$/.test(x.w))));
  const isCross = (x: Item | undefined): boolean => x !== undefined && !x.pre && x.w === 'cross';
  const strip = (e: string): string => e.replace(/^0+(?=\d)/, '').toUpperCase();
  const ends = new Set((runwayEnds ?? []).map(strip));
  const out: Item[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (isCross(it) && isLetter(items[k + 1]) && isCross(items[k + 2])) { k++; continue; }
    out.push(it);
    const next = items[k + 1];
    if (isCross(it) && next?.pre === 'number' && /^\d{1,2}$/.test(next.w) && ends.has(strip(next.w))) {
      out.push({ w: 'runway', rawStart: next.rawStart, rawEnd: next.rawEnd });
    }
  }
  return out;
}
