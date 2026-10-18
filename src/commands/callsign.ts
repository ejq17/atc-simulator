import { GA_PREFIXES, N_PREFIX_WORDS } from './lexicon';
import { editDistance } from './normalize';
import type { Token } from './tokens';

export interface AircraftRef { callsign: string; spokenCallsign: string; type: string }

export interface CallsignCandidate { callsign: string; score: number }

export interface CallsignResolution {
  /** Resolved callsign, or null when missing / ambiguous / low score. Never a guess. */
  callsign: string | null;
  /** Best score found (0 when nothing was mentioned). */
  score: number;
  /** Ranked candidates (score > 0.3). */
  candidates: CallsignCandidate[];
  ambiguous: boolean;
  /** A callsign-shaped phrase was found in the text. */
  mentioned: boolean;
  /** Token range [start, end) of the chosen mention. */
  span: { start: number; end: number } | null;
  /** Other aircraft that also matched strongly in other mentions. */
  otherCallsigns: string[];
  issues: string[];
}

export const CALLSIGN_ACCEPT = 0.75;
const AMBIGUITY_MARGIN = 0.1;

interface Mention {
  start: number;
  end: number;
  airline?: string;      // ICAO prefix when spoken as airline + number
  explicitPrefix: boolean; // "november" / "N" / GA type word given
  gaPrefix?: string;
  id: string;            // digits + trailing letters ("723EJ") or flight digits ("451")
}

/** Words directly before a number that mean the number is NOT a callsign. */
const NUMBER_OWNERS: ReadonlySet<string> = new Set([
  'runway', 'heading', 'maintain', 'speed', 'fl', 'point', 'to', 'at', 'below', 'above', 'via', 'knots',
  'ground', 'tower', 'approach', 'departure', 'final', 'mile', 'miles', 'wind', 'on', 'of', 'short',
  'climb', 'descend', 'gate', 'turn', 'left', 'right', 'squawk', 'taxiway', 'than',
]);

const isInt = (t: Token | undefined): t is Token => t !== undefined && t.kind === 'number' && /^\d{1,5}$/.test(t.text);

function findMentions(tokens: readonly Token[]): Mention[] {
  const out: Mention[] = [];
  for (let i = 0; i < tokens.length;) {
    const t = tokens[i];
    // airline telephony + flight number
    if (t.kind === 'airline' && isInt(tokens[i + 1]) && tokens[i + 1].text.length <= (t.text === 'CGD' || t.text === 'ANG' ? 5 : 4)) {
      out.push({ start: i, end: i + 2, airline: t.text, explicitPrefix: true, id: tokens[i + 1].text });
      i += 2;
      continue;
    }
    // N-number / GA: [type word] [n] digits [letters]
    let j = i;
    let gaPrefix: string | undefined;
    let explicit = false;
    if (tokens[j].kind === 'gaPrefix') { gaPrefix = tokens[j].text; explicit = true; j++; }
    if (tokens[j]?.kind === 'letter' && tokens[j].text === 'n' && isInt(tokens[j + 1])) { explicit = true; j++; }
    // "number 678 mike victor": a misheard "november"; only with the registration letters after the digits ("runway number 4" is not one)
    else if (tokens[j]?.kind === 'word' && N_PREFIX_WORDS.has(tokens[j].text) && isInt(tokens[j + 1]) && (tokens[j + 2]?.kind === 'letter' || (isInt(tokens[j + 2]) && tokens[j + 3]?.kind === 'letter'))) { explicit = true; j++; }
    if (isInt(tokens[j])) {
      let digits = tokens[j].text;
      let k = j + 1;
      // "november 4, 5, romeo tango": STT punctuation split the digits into separate number tokens
      while (isInt(tokens[k]) && digits.length + tokens[k].text.length <= 5) { digits += tokens[k].text; k++; }
      let letters = '';
      while (letters.length < 2 && tokens[k]?.kind === 'letter') { letters += tokens[k].text.toUpperCase(); k++; }
      const prev = tokens[i - 1];
      const prevOk = j > i || prev === undefined || (prev.kind !== 'number' && prev.kind !== 'letter' && !NUMBER_OWNERS.has(prev.text));
      if (prevOk && (explicit || letters.length > 0)) {
        out.push({ start: i, end: k, explicitPrefix: explicit, gaPrefix, id: digits + letters });
        i = k;
        continue;
      }
    }
    i++;
  }
  return out;
}

const hamming = (a: string, b: string): number => {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
};

function prefixAdjust(m: Mention, ac: AircraftRef): number {
  if (!m.gaPrefix) return 0;
  const spoken = ac.spokenCallsign.toLowerCase();
  const rx = GA_PREFIXES.get(m.gaPrefix);
  if (spoken.includes(m.gaPrefix) || rx?.test(ac.type.toUpperCase())) return 0.03;
  return -0.05;
}

const splitId = (id: string): { digits: string; letters: string } => {
  const m = /^(\d*)([A-Z]*)$/.exec(id);
  return { digits: m?.[1] ?? id, letters: m?.[2] ?? '' };
};

/**
 * An explicitly prefixed N-number ("november ...", "cessna ...") whose digits are off by one inserted or dropped digit while
 * the letters match: "november 60004 tango" for N6004T, "november 604 tango" for N6004T. A substituted digit is NOT
 * accepted this way (that could be another aircraft); see the hamming rule.
 */
function digitSlip(m: Mention, full: string): boolean {
  if (!m.explicitPrefix || m.id.length < 4) return false;
  const a = splitId(m.id);
  const b = splitId(full);
  return a.letters === b.letters && b.letters.length > 0 && Math.abs(a.digits.length - b.digits.length) === 1
    && editDistance(a.digits, b.digits) === 1;
}

/** Score one mention against one aircraft, 0..1. */
function scoreMention(m: Mention, ac: AircraftRef): number {
  const cs = ac.callsign.toUpperCase();
  const nNum = /^N(\d{1,5}[A-Z]{0,2})$/.exec(cs);
  const airline = /^([A-Z]{3})(\d{1,5}[A-Z]?)$/.exec(cs);
  const positionPenalty = m.start === 0 ? 0 : 0.02;
  let s = 0;
  if (nNum && !m.airline) {
    const full = nNum[1];
    if (m.id === full) s = m.explicitPrefix ? 1 : 0.97;
    else if (m.id.length >= 3 && m.id.length < full.length && full.endsWith(m.id)) s = m.id.length >= 4 ? 0.93 : 0.9;
    // "november 467" / "cessna 467 echo" for N467ES: all the digits, letters missing or garbled by STT
    else if (m.explicitPrefix && m.id.length >= 3 && m.id.length < full.length && full.startsWith(m.id) && splitId(m.id).digits === splitId(full).digits) s = 0.8;
    else if (digitSlip(m, full)) s = 0.8;
    else if (m.id.length >= 3 && m.id.length <= full.length && hamming(m.id, full.slice(-m.id.length)) === 1) s = m.id.length >= 4 ? 0.6 : 0.5;
    else if (m.id.length < 3 && full.endsWith(m.id)) s = 0.4;
    if (s > 0) s += prefixAdjust(m, ac);
  } else if (airline && m.airline) {
    if (m.airline !== airline[1]) s = 0;
    else if (m.id === airline[2]) s = 1;
    else if (hamming(m.id, airline[2]) === 1) s = 0.55;
  }
  return s > 0 ? Math.max(0, Math.min(1, s - positionPenalty)) : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** `heard` is `full` with exactly one digit missing, the rest in order ("43" for "483"). */
const missingOneDigit = (heard: string, full: string): boolean =>
  heard.length >= 2 && full.length === heard.length + 1 && [...full].some((_, k) => full.slice(0, k) + full.slice(k + 1) === heard);

/**
 * Dropped-digit flight number: heard "Spirit 43" with exactly ONE active aircraft of that airline whose flight number is the
 * heard digits plus one more (NKS483). Accepted at a reduced score (0.8). Refused when any other active aircraft of the airline
 * is also a plausible reading (edit distance <= 2 from the heard digits, e.g. NKS487 for "43"): then it stays unrecognised.
 */
function droppedDigitMatch(m: Mention, aircraft: readonly AircraftRef[]): string | null {
  if (!m.airline) return null;
  const same = aircraft
    .map((ac) => ({ cs: ac.callsign, flight: /^([A-Z]{3})(\d{1,5}[A-Z]?)$/.exec(ac.callsign.toUpperCase()) }))
    .filter((x) => x.flight !== null && x.flight[1] === m.airline)
    .map((x) => ({ cs: x.cs, id: (x.flight as RegExpExecArray)[2] }));
  const hits = same.filter((x) => missingOneDigit(m.id, x.id));
  if (hits.length !== 1) return null;
  if (same.some((x) => x.cs !== hits[0].cs && editDistance(m.id, x.id) <= 2)) return null;
  return hits[0].cs;
}

function rank(m: Mention, aircraft: readonly AircraftRef[]): CallsignCandidate[] {
  const dropped = droppedDigitMatch(m, aircraft);
  const positionPenalty = m.start === 0 ? 0 : 0.02;
  return aircraft
    .map((ac) => ({ callsign: ac.callsign, score: round2(ac.callsign === dropped ? 0.8 - positionPenalty : scoreMention(m, ac)) }))
    .filter((c) => c.score > 0.3)
    .sort((a, b) => b.score - a.score);
}

/**
 * Resolve the spoken callsign in `tokens` against the active aircraft.
 * Returns the best match only when its score >= CALLSIGN_ACCEPT and no other
 * aircraft scores within AMBIGUITY_MARGIN of it. Otherwise `callsign` is null
 * and `candidates` lists what the caller may ask the controller to confirm.
 */
export function resolveCallsign(tokens: readonly Token[], aircraft: readonly AircraftRef[]): CallsignResolution {
  const mentions = findMentions(tokens);
  const empty: CallsignResolution = {
    callsign: null, score: 0, candidates: [], ambiguous: false, mentioned: false,
    span: null, otherCallsigns: [], issues: ['missing callsign'],
  };
  if (mentions.length === 0) return empty;

  const ranked = mentions.map((m) => ({ m, cands: rank(m, aircraft) }));
  ranked.sort((a, b) => (b.cands[0]?.score ?? 0) - (a.cands[0]?.score ?? 0) || a.m.start - b.m.start);
  const { m, cands } = ranked[0];
  const best = cands[0];
  const second = cands[1];
  const span = { start: m.start, end: m.end };
  const spoken = tokens.slice(m.start, m.end).map((t) => t.text).join(' ');
  const base = { candidates: cands, mentioned: true, span, otherCallsigns: [] as string[] };

  if (!best) return { ...base, callsign: null, score: 0, ambiguous: false, issues: [`callsign not recognised: "${spoken}"`] };

  const others = ranked.slice(1)
    .map((r) => r.cands[0])
    .filter((c): c is CallsignCandidate => c !== undefined && c.score >= CALLSIGN_ACCEPT && c.callsign !== best.callsign)
    .map((c) => c.callsign);
  base.otherCallsigns = others;

  if (best.score < CALLSIGN_ACCEPT) {
    return { ...base, callsign: null, score: best.score, ambiguous: false,
      issues: [`low-confidence callsign match: ${best.callsign} (${best.score.toFixed(2)}) for "${spoken}"`] };
  }
  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    const names = cands.filter((c) => best.score - c.score < AMBIGUITY_MARGIN).map((c) => c.callsign);
    return { ...base, callsign: null, score: best.score, ambiguous: true,
      issues: [`ambiguous callsign: ${names.join(', ')}`] };
  }
  return { ...base, callsign: best.callsign, score: best.score, ambiguous: false, issues: [] };
}
