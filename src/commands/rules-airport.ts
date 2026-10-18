/**
 * Rules for the airport-state phraseology: bird activity and braking action advisories (JO 7110.65 2-1-23, 3-3-4, 3-3-5), runway light
 * intensity (3-4-10, 3-4-11) and STAR clearances (4-7-1 "CLEARED / (STAR name and number) ARRIVAL, (transition) TRANSITION", 4-5-7 "DESCEND VIA").
 */
import { cmdHit, fillerHit, makeDraft, type Rule } from './draft';
import { phoneticDistance, type FixMatcher } from './fixes';
import { intAt, isOneOf, seq, skipWords, txt, type Toks } from './match';
import type { BrakingTerm } from '../sim/types';

/** STAR names the parser knows (ParseContext.arrivals). `ident` is the computer code without the dot ("ROZZE2"). */
export interface ArrivalInfo {
  ident: string;
  /** Spoken name, name word(s) then number: "ROZZE TWO". */
  spokenName: string;
  /** Transition fix ids ("CRIBB", "MUCOW", ...). */
  transitions: string[];
}

// ---------------------------------------------------------------------------
// Advisories
// ---------------------------------------------------------------------------

const BIRD_LEAD = ['caution', 'attention', 'be', 'advised', 'advise', 'note', 'traffic', 'all', 'aircraft', 'of'];
const BIRD_START = ['bird', 'birds', 'flock', 'flocks', 'numerous', 'large', 'small'];
const BIRD_TAIL = [
  'bird', 'birds', 'flock', 'flocks', 'of', 'geese', 'goose', 'ducks', 'duck', 'gulls', 'gull', 'small', 'large', 'numerous', 'activity', 'reported', 'observed', 'in', 'the', 'immediate',
  'vicinity', 'airport', 'field', 'altitude', 'unknown', 'last', 'at', 'on', 'final', 'over', 'near', 'north', 'south', 'east', 'west', 'northbound', 'southbound', 'eastbound', 'westbound',
  'northeast', 'northwest', 'southeast', 'southwest', 'mile', 'miles', 'oclock', 'thousand', 'hundred', 'and', 'approach', 'departure', 'end', 'is', 'there', 'are',
];

/** "caution, bird activity in the vicinity of the airport", "flock of geese, one o'clock, seven miles, northbound" (2-1-23 examples). */
export const ruleBirdAdvisory: Rule = (t, i) => {
  const k = skipWords(t, i, BIRD_LEAD);
  if (!isOneOf(t, k, BIRD_START)) return null;
  // "small"/"large"/"numerous" only start a bird phrase when the word 'bird(s)' / 'flock(s)' follows within two tokens
  let has = false;
  for (let q = k; q < Math.min(t.length, k + 3); q++) if (isOneOf(t, q, ['bird', 'birds', 'flock', 'flocks'])) has = true;
  if (!has) return null;
  let j = k;
  let guard = 0;
  while (j < t.length && guard++ < 16 && (isOneOf(t, j, BIRD_TAIL) || intAt(t, j) !== null)) j++;
  const d = makeDraft('ADVISORY', { advisory: 'BIRDS' });
  return cmdHit(j, d);
};

const BRAKING_TERMS: { words: string; term: BrakingTerm }[] = [
  { words: 'good to medium', term: 'good to medium' },
  { words: 'medium to poor', term: 'medium to poor' },
  { words: 'good', term: 'good' },
  { words: 'medium', term: 'medium' },
  { words: 'poor', term: 'poor' },
  { words: 'nil', term: 'nil' },
];
const BRAKING_AIRCRAFT = ['heavy', 'boeing', 'airbus', 'cessna', 'embraer', 'crj'];
const BRAKING_TAIL = ['reported', 'by', 'a', 'an', 'the', ...BRAKING_AIRCRAFT];

/** "braking action medium, reported by a heavy Boeing seven sixty seven", "braking action advisories are in effect", "no braking action reports received" (3-3-4, 3-3-5). */
export const ruleBrakingAdvisory: Rule = (t, i) => {
  let j = seq(t, i, 'no? braking action');
  if (j < 0) return null;
  const noReports = seq(t, i, 'no braking action reports received?') >= 0;
  if (noReports) {
    let e = seq(t, i, 'no braking action reports received?');
    e = skipWords(t, e, ['for', 'runway']);
    const rw = intAt(t, e);
    if (rw !== null) e++;
    return cmdHit(e, makeDraft('ADVISORY', { advisory: 'BRAKING' }));
  }
  const adv = seq(t, j, 'advisories|advisory are? in? effect?');
  if (adv >= 0) return cmdHit(adv, makeDraft('ADVISORY', { advisory: 'BRAKING' }));
  for (const b of BRAKING_TERMS) {
    const e = seq(t, j, b.words);
    if (e < 0) continue;
    let k = e;
    let guard = 0;
    while (k < t.length && guard++ < 10 && (isOneOf(t, k, BRAKING_TAIL) || (intAt(t, k) !== null && isOneOf(t, k - 1, BRAKING_AIRCRAFT)))) k++;
    return cmdHit(k, makeDraft('ADVISORY', { advisory: 'BRAKING', brakingTerm: b.term }));
  }
  return null;
};

/** "runway one seven RVR two thousand four hundred", "RVR more than six thousand, rollout one thousand" (2-8-3): information, consumed. */
export const ruleRvr: Rule = (t, i) => {
  if (txt(t, i) !== 'rvr') return null;
  let j = i + 1;
  let guard = 0;
  while (j < t.length && guard++ < 14 && (intAt(t, j) !== null || isOneOf(t, j, ['more', 'less', 'than', 'variable', 'to', 'mid', 'rollout', 'touchdown', 'midpoint', 'and']))) j++;
  return fillerHit(j);
};

// ---------------------------------------------------------------------------
// Runway lights
// ---------------------------------------------------------------------------

const UP_VERBS = ['increase', 'raise', 'brighten', 'bump'];
const DOWN_VERBS = ['decrease', 'reduce', 'lower', 'dim'];

/** "increase the runway lights", "lights up", "turn the lights down", "set the runway lights to step four" (3-4-10 d, 3-4-11). */
export const ruleRunwayLights: Rule = (t, i) => {
  let j = i;
  let dir: 'UP' | 'DOWN' | undefined;
  let hasVerb = false;
  const w = txt(t, i);
  if (UP_VERBS.includes(w)) { dir = 'UP'; hasVerb = true; j = i + 1; }
  else if (DOWN_VERBS.includes(w)) { dir = 'DOWN'; hasVerb = true; j = i + 1; }
  else if (['turn', 'bring', 'take'].includes(w)) {
    hasVerb = true;
    j = i + 1;
    if (txt(t, j) === 'up') { dir = 'UP'; j++; } else if (txt(t, j) === 'down') { dir = 'DOWN'; j++; }
  } else if (['set', 'select'].includes(w)) { hasVerb = true; j = i + 1; }
  j = skipWords(t, j, ['the', 'runway', 'edge', 'all']);
  const lights = seq(t, j, 'lights|light');
  if (lights < 0) return null;
  let k = skipWords(t, lights, ['intensity', 'to', 'at']);
  const up = seq(t, k, 'up|increased|brighter|higher');
  const down = seq(t, k, 'down|decreased|dimmer|lower');
  if (up >= 0) { dir = 'UP'; k = up; } else if (down >= 0) { dir = 'DOWN'; k = down; }
  const d = makeDraft('RUNWAY_LIGHTS');
  const stepAt = seq(t, k, 'step|setting|level');
  if (stepAt >= 0) {
    const n = intAt(t, stepAt);
    if (n !== null && Number(n) >= 1 && Number(n) <= 5) { d.fields.lightStep = Number(n); k = stepAt + 1; dir = undefined; }
    else if (n !== null) { d.issues.push(`invalid light intensity step ${n} (1 to 5)`); d.unknownIds++; k = stepAt + 1; }
  }
  if (d.issues.length) return cmdHit(k, d); // a named but impossible step: reported, never guessed
  if (dir === undefined && d.fields.lightStep === undefined) return null;
  if (!hasVerb && dir === undefined && d.fields.lightStep === undefined) return null;
  if (dir) d.fields.lightsDirection = dir;
  return cmdHit(k, d);
};

// ---------------------------------------------------------------------------
// STAR clearance
// ---------------------------------------------------------------------------

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The arrival named at token i ("rozze two", "rozze 2", "rozze"): the arrival and the index after the name (and number). */
function matchArrival(t: Toks, i: number, arrivals: readonly ArrivalInfo[]): { arrival: ArrivalInfo; next: number; numberOk: boolean } | null {
  const tok = t[i];
  if (!tok || (tok.kind !== 'word' && tok.kind !== 'letter')) return null;
  let best: { arrival: ArrivalInfo; next: number; numberOk: boolean; d: number } | null = null;
  for (const a of arrivals) {
    const parts = a.spokenName.split(/\s+/);
    const base = parts.slice(0, -1).join('').toLowerCase();
    const num = /^\d+$/.test(a.ident.slice(-1)) ? a.ident.replace(/^\D+/, '') : '';
    for (let len = 1; len <= 2; len++) {
      const words = t.slice(i, i + len).map((x) => x.text);
      if (words.length < len || t.slice(i, i + len).some((x) => x.kind === 'number')) continue;
      const d = phoneticDistance(squash(words.join('')), base);
      if (d > 0.34) continue;
      const after = i + len;
      const n = intAt(t, after);
      const numberOk = n !== null && n === num;
      const next = n !== null ? after + 1 : after;
      if (!best || d < best.d || (d === best.d && next > best.next)) best = { arrival: a, next, numberOk: numberOk || n === null, d };
      if (n !== null && !numberOk) best = { arrival: a, next, numberOk: false, d };
    }
  }
  return best ? { arrival: best.arrival, next: best.next, numberOk: best.numberOk } : null;
}

/** "cleared ROZZE two arrival [CRIBB transition]", "descend via the ROZZE two arrival", "ROZZE two arrival" (4-7-1, 4-5-7). */
export const ruleStar = (arrivals: readonly ArrivalInfo[], fixes: FixMatcher): Rule => (t, i) => {
  if (!arrivals.length) return null;
  let j = i;
  let via = false;
  const dv = seq(t, i, 'descend via');
  if (dv >= 0) { via = true; j = dv; }
  else {
    const c = seq(t, i, 'cleared|clear');
    if (c >= 0) j = c;
  }
  j = skipWords(t, j, ['the']);
  const m = matchArrival(t, j, arrivals);
  if (!m) return null;
  let k = m.next;
  const arrival = seq(t, k, 'arrival|arrive');
  // a bare "descend via" without the word arrival is still the STAR clearance; a bare name needs the word 'arrival'
  if (arrival < 0 && !via && j === i) return null;
  if (arrival < 0 && !via && j !== i && seq(t, i, 'cleared|clear') < 0) return null;
  if (arrival >= 0) k = arrival;
  // A wrong number ("ROZZE three": only ROZZE TWO is published) is no arrival at all: the name stays unset, so the command is incomplete and the pilot asks.
  const d = makeDraft('STAR', m.numberOk ? { starName: m.arrival.ident, descendVia: via } : { descendVia: via });
  if (!m.numberOk) { d.issues.push(`unknown arrival "${t.slice(j, m.next).map((x) => x.text).join(' ')}"`); d.unknownIds++; }
  // optional ", CRIBB transition"
  const f = fixes.resolve(t, skipWords(t, k, ['the']));
  if (f && f.status === 'known' && isOneOf(t, f.next, ['transition', 'transitions']) && m.arrival.transitions.includes(f.id)) {
    d.fields.starTransition = f.id;
    k = f.next + 1;
  } else if (f && isOneOf(t, f.next, ['transition', 'transitions'])) {
    d.issues.push('unknown transition for this arrival');
    d.unknownIds++;
    k = f.next + 1;
  }
  // "descend via the ROZZE two arrival, runway six": a trailing runway is attached by the assembler (STAR accepts a runway).
  return cmdHit(k, d);
};

export { txt };
