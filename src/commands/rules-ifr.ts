import type { ApproachType, IfrClearanceDetails } from '../sim/types';
import { AIRPORT_NAMES, FAA_CODES } from './airports';
import { applyRunway, cmdHit, fillerHit, makeDraft, type Draft, type Rule } from './draft';
import { makeRunwayRef, parseRunway } from './entities';
import type { FixMatcher } from './fixes';
import { intAt, isOneOf, seq, skipWords, txt, type Toks } from './match';

// ---------------------------------------------------------------------------
// Fix helper shared by direct / position / altitude-until rules
// ---------------------------------------------------------------------------

/** Resolve a fix at i, recording unknown / ambiguous findings on the draft. Returns the fix id and end. */
export function applyFix(d: Draft, m: FixMatcher, t: Toks, i: number): { id?: string; next: number } {
  const r = m.resolve(t, i);
  if (!r) return { next: i };
  if (r.status === 'known') return { id: r.id, next: r.next };
  if (r.status === 'ambiguous') {
    d.conflicts++;
    d.issues.push(`ambiguous fix: ${r.ids.join(' or ')}`);
    return { next: r.next };
  }
  if (m.hasList) { d.issues.push(`unknown fix ${r.raw}`); d.unknownIds++; }
  return { id: r.raw, next: r.next };
}

// ---------------------------------------------------------------------------
// APPROACH
// ---------------------------------------------------------------------------

const APPROACH_WORDS: Record<string, ApproachType> = {
  ils: 'ILS', localizer: 'LOC', loc: 'LOC', rnav: 'RNAV', gps: 'RNAV', rnp: 'RNAV', vor: 'VOR', visual: 'VISUAL',
};
const APPROACH_LEAD = ['for', 'to', 'the', 'a', 'straight', 'in'];
const APPROACH_NOISE = ['gps', 'dme', 'rnp', 'or', 'localizer', 'loc', 'approach'];

/** Bare "13" / "13 left" straight after the approach type ("cleared for the ILS one three"). */
function bareRunway(t: Toks, i: number): { ref: ReturnType<typeof makeRunwayRef>; digits: string; next: number } | null {
  const digits = intAt(t, i);
  if (digits === null || digits.length > 2) return null;
  let next = i + 1;
  let suffix = '';
  const w = txt(t, next);
  if ((w === 'left' || w === 'right' || w === 'center') && !isOneOf(t, next + 1, ['heading', 'turn'])) { suffix = w[0].toUpperCase(); next++; }
  return { ref: makeRunwayRef(digits, suffix), digits, next };
}

/** "cleared ILS runway 13 approach", "cleared for the visual, runway 13", "cleared RNAV GPS runway 22 approach" */
export const ruleApproach: Rule = (t, i) => {
  if (!isOneOf(t, i, ['cleared', 'clear'])) return null;
  let j = skipWords(t, i + 1, APPROACH_LEAD);
  const type = APPROACH_WORDS[txt(t, j)];
  if (!type) return null;
  const d = makeDraft('APPROACH', { approachType: type });
  j = skipWords(t, j + 1, APPROACH_NOISE);
  const r = parseRunway(t, j);
  if (r) {
    if (r.ok) applyRunway(d, r.ref); else { d.issues.push(r.reason); d.unknownIds++; }
    j = r.next;
  } else {
    const b = bareRunway(t, j);
    if (b) {
      if (b.ref) applyRunway(d, b.ref); else { d.issues.push(`invalid runway "${b.digits}"`); d.unknownIds++; }
      j = b.next;
    }
  }
  return cmdHit(skipWords(t, j, ['approach']), d);
};

// ---------------------------------------------------------------------------
// DIRECT_FIX / RESUME_OWN_NAVIGATION / RADAR_CONTACT / position text
// ---------------------------------------------------------------------------

/** "proceed direct CARYL", "direct Cedar Lake", "cleared direct SIE", "direct to MAYBN" */
export const ruleDirectFix = (m: FixMatcher): Rule => (t, i) => {
  let j = i;
  if (seq(t, j, 'when able') >= 0) j += 2;
  if (isOneOf(t, j, ['proceed', 'cleared', 'clear', 'fly', 'go'])) j = skipWords(t, j + 1, ['when', 'able', 'to']);
  if (txt(t, j) !== 'direct') return null;
  j = skipWords(t, j + 1, ['to', 'the', 'when', 'able']);
  const d = makeDraft('DIRECT_FIX');
  const f = applyFix(d, m, t, j);
  if (f.id) d.fields.fix = f.id;
  return cmdHit(f.next, d);
};

/** "resume own navigation", "resume own nav", "proceed on course" */
export const ruleResumeNav: Rule = (t, i) => {
  let j = seq(t, i, 'resume your? own navigation|nav');
  if (j < 0) j = seq(t, i, 'resume normal navigation');
  if (j < 0) j = seq(t, i, 'proceed|continue on course');
  return j < 0 ? null : cmdHit(j, makeDraft('RESUME_OWN_NAVIGATION'));
};

const COMPASS = ['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'];

/**
 * Position text "two miles south of the field", "four miles from CARYL": informational,
 * consumed and ignored. Returns the end index (== i when there is none).
 */
function positionTail(m: FixMatcher, t: Toks, i: number): number {
  const k = skipWords(t, i, ['at']);
  if (intAt(t, k) === null || !isOneOf(t, k + 1, ['mile', 'miles'])) return i;
  const j = skipWords(t, k + 2, [...COMPASS, 'of', 'from', 'the', 'to']);
  if (j === k + 2) return i;
  if (isOneOf(t, j, ['field', 'airport'])) return j + 1;
  const f = m.resolve(t, j);
  return f ? f.next : j;
}

/** "four miles from CARYL" on its own (position report from the controller). */
export const rulePosition = (m: FixMatcher): Rule => (t, i) => {
  const e = positionTail(m, t, i);
  return e > i ? fillerHit(e) : null;
};

/** "radar contact [two miles south of the field]" */
export const ruleRadarContact = (m: FixMatcher): Rule => (t, i) => {
  const j = seq(t, i, 'radar contact');
  if (j < 0) return null;
  return cmdHit(positionTail(m, t, j), makeDraft('RADAR_CONTACT'));
};

// ---------------------------------------------------------------------------
// IFR_CLEARANCE
// ---------------------------------------------------------------------------

const DIGIT_NAMES = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
const COMM_MIN_MHZ = 108;
const COMM_MAX_MHZ = 137;

/** Words that end a route phrase (start of another element or another instruction). */
const ROUTE_STOP: ReadonlySet<string> = new Set([
  'maintain', 'climb', 'expect', 'squawk', 'contact', 'turn', 'fly', 'heading', 'left', 'right', 'descend',
  'cleared', 'hold', 'taxi', 'report', 'runway', 'proceed', 'direct', 'resume',
]);
const NAME_STOP: ReadonlySet<string> = new Set(['via', 'the', 'a', 'airport', 'as', 'filed', 'then', 'radar', 'vectors', 'and', 'to', 'departure']);
const DEST_END = ['airport', 'via', 'as', 'maintain', 'climb', 'expect', 'squawk', 'radar'];

const isDecimal = (t: Toks, i: number) => /^\d{3}\.\d{1,3}$/.test(txt(t, i));

function isRouteStop(t: Toks, i: number): boolean {
  const w = txt(t, i);
  if (ROUTE_STOP.has(w)) return true;
  if (w === 'departure') {
    const a = skipWords(t, i + 1, ['frequency', 'on', 'control']);
    return isDecimal(t, a);
  }
  return false;
}

interface Dest { icao?: string; unknown?: string; next: number }

/** Destination airport at i: known name, spoken/typed ICAO, FAA code, or an unknown name before "airport"/"via". */
function parseDestination(t: Toks, i: number): Dest | null {
  const j = skipWords(t, i, ['the']);
  for (const a of AIRPORT_NAMES) {
    if (a.words.every((w, k) => txt(t, j + k) === w)) return { icao: a.icao, next: j + a.words.length };
  }
  let run = 0;
  while (run < 5 && t[j + run]?.kind === 'letter') run++;
  if (run === 4) return { icao: t.slice(j, j + 4).map((x) => x.text).join('').toUpperCase(), next: j + 4 };
  if (run === 3) {
    const faa = FAA_CODES.get(t.slice(j, j + 3).map((x) => x.text).join(''));
    if (faa) return { icao: faa, next: j + 3 };
  }
  const w = txt(t, j);
  if (t[j]?.kind === 'word') {
    if (/^k[a-z]{3}$/.test(w)) return { icao: w.toUpperCase(), next: j + 1 };
    const faa = FAA_CODES.get(w);
    if (faa) return { icao: faa, next: j + 1 };
  }
  let k = j;
  while (k < j + 4 && t[k]?.kind === 'word' && !DEST_END.includes(txt(t, k)) && !ROUTE_STOP.has(txt(t, k))) k++;
  if (k > j && isOneOf(t, k, DEST_END)) return { unknown: t.slice(j, k).map((x) => x.text).join(' ').toUpperCase(), next: k };
  return null;
}

/** "Atlantic City 3 departure" -> "ATLANTIC CITY THREE" (name words before a number before "departure"). */
function departureProcedure(t: Toks, from: number, to: number): string | undefined {
  for (let q = from + 1; q < to; q++) {
    if (txt(t, q) !== 'departure') continue;
    const num = t[q - 1];
    if (num?.kind !== 'number' || !/^\d{1,2}$/.test(num.text) || q - 1 <= from) continue;
    let s = q - 1;
    while (s > from && q - 1 - (s - 1) <= 3 && t[s - 1].kind === 'word' && !NAME_STOP.has(t[s - 1].text)) s--;
    if (s === q - 1) continue;
    const name = t.slice(s, q - 1).map((x) => x.text.toUpperCase());
    return [...name, num.text.length === 1 ? DIGIT_NAMES[Number(num.text)] : num.text].join(' ');
  }
  return undefined;
}

/** Altitude / flight level at i: { ft, next } or null. */
function altitudeAt(t: Toks, i: number): { ft: number; next: number } | null {
  const fl = txt(t, i) === 'fl';
  const n = intAt(t, fl ? i + 1 : i);
  if (n === null) return null;
  const v = Number.parseInt(n, 10);
  return { ft: fl ? v * 100 : v, next: fl ? i + 2 : i + 1 };
}

/**
 * "cleared to <dest> [airport] via <DP / route>, maintain N, expect N [N minutes after departure],
 * departure frequency X, squawk NNNN". Elements may come in any order and any may be missing;
 * the whole clearance is one IFR_CLEARANCE command. The route phrase is resolved to raw text in parse.ts.
 */
export const ruleIfrClearance: Rule = (t, i) => {
  if (!isOneOf(t, i, ['cleared', 'clear'])) return null;
  const d = makeDraft('IFR_CLEARANCE');
  const ifr: Partial<IfrClearanceDetails> = {};
  d.fields.ifr = ifr;
  let k: number;
  if (txt(t, i + 1) === 'to') {
    const dest = parseDestination(t, i + 2);
    if (!dest) return null;
    if (dest.icao) ifr.destination = dest.icao;
    else d.issues.push(`unknown destination ${dest.unknown}`);
    k = skipWords(t, dest.next, ['airport', 'international', 'the']);
  } else if (seq(t, i + 1, 'as filed') >= 0) {
    k = i + 1;
  } else return null;

  let end = k;
  for (;;) {
    const s = skipWords(t, k, ['and', 'then', 'also']);
    const w = txt(t, s);
    if ((w === 'maintain' || w === 'climb') && ifr.initialAltitudeFt === undefined) {
      if (w === 'climb' && txt(t, s + 1) === 'via') {
        d.issues.push('climb via is not supported: state an explicit initial altitude');
        k = end = skipWords(t, s + 2, ['the', 'sid', 'departure']);
        continue;
      }
      const a = altitudeAt(t, skipWords(t, s + 1, ['and', 'maintain', 'to', 'altitude', 'initially']));
      if (!a) break;
      if (a.ft < 100 || a.ft > 60000) d.issues.push(`invalid altitude ${a.ft}`); else ifr.initialAltitudeFt = a.ft;
      k = end = a.next;
    } else if (w === 'expect' && ifr.expectAltitudeFt === undefined) {
      const a = altitudeAt(t, skipWords(t, s + 1, ['and', 'maintain', 'altitude']));
      if (!a) break;
      if (a.ft < 100 || a.ft > 60000) d.issues.push(`invalid expected altitude ${a.ft}`); else ifr.expectAltitudeFt = a.ft;
      let e = skipWords(t, a.next, ['in', 'within']);
      if (intAt(t, e) !== null && isOneOf(t, e + 1, ['minute', 'minutes'])) {
        e += 2;
        const after = seq(t, e, 'after departure|takeoff|liftoff');
        if (after >= 0) e = after;
        else if (seq(t, e, 'after') >= 0) e++;
        a.next = e;
      }
      k = end = a.next;
    } else if (w === 'squawk' && ifr.squawk === undefined) {
      const code = intAt(t, s + 1);
      if (code === null) break;
      if (code.length !== 4) { d.issues.push(`invalid squawk ${code}: must be four digits`); d.unknownIds++; }
      else if (/[89]/.test(code)) { d.issues.push(`invalid squawk ${code}: digits must be 0-7`); d.unknownIds++; }
      else ifr.squawk = code;
      k = end = s + 2;
    } else if (w === 'departure' && ifr.departureFrequencyMhz === undefined) {
      const a = skipWords(t, s + 1, ['frequency', 'on', 'control']);
      if (!isDecimal(t, a)) break;
      const mhz = Number(txt(t, a));
      if (mhz >= COMM_MIN_MHZ && mhz <= COMM_MAX_MHZ) ifr.departureFrequencyMhz = mhz;
      else d.issues.push(`frequency ${txt(t, a)} outside the VHF comm band`);
      k = end = a + 1;
    } else if (!d.routeSpan && t[s]?.kind === 'word' && !isRouteStop(t, s) && w !== 'departure') {
      const r0 = skipWords(t, s, ['via', 'the', 'a']);
      let r1 = r0;
      while (r1 < t.length && !isRouteStop(t, r1)) r1++;
      while (r1 > r0 && isOneOf(t, r1 - 1, ['and', 'then', 'also'])) r1--;
      if (r1 <= r0) break;
      d.routeSpan = [r0, r1];
      const dp = departureProcedure(t, r0, r1);
      if (dp) ifr.departureProcedure = dp;
      k = end = r1;
    } else break;
  }
  return cmdHit(end, d);
};
