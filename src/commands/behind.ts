/**
 * "behind the landing Spirit four fifty one", "after the Cessna": a reference to ONE active aircraft by callsign, telephony word or type word.
 * Shared by the landline parser (Ground -> Tower "cross ... behind the landing ...") and the conditional crossing clearance (rules-ground.ts).
 */
import { CALLSIGN_ACCEPT, resolveCallsign } from './callsign';
import type { AircraftRef } from './callsign';
import { GA_PREFIXES } from './lexicon';
import type { Token } from './tokens';

/** Words that may stand between "behind" and the aircraft ("behind the landing Cessna", "after the departing traffic"). */
const AIRCRAFT_FILLER: ReadonlySet<string> = new Set(['the', 'a', 'an', 'landing', 'arriving', 'arrival', 'traffic', 'departing', 'aircraft']);
/** The longest aircraft phrase read ("november one two three four five alpha bravo" plus a type word). */
const MAX_PHRASE_TOKENS = 10;

export interface AircraftPhrase {
  /** The one aircraft the phrase names (callsign of an active aircraft), undefined when none or several match. */
  callsign?: string;
  /** More than one active aircraft fits the words (type or telephony word shared by several). */
  ambiguous: string[];
  /** The words as spoken, filler included ("the landing cessna"). */
  spoken: string;
  /** Token index where the phrase starts (after "behind") and the index after its last token. */
  start: number;
  next: number;
}

const telephony = (a: AircraftRef): string => a.spokenCallsign.toLowerCase().split(' ')[0] ?? '';

/**
 * Read the aircraft phrase starting at `i` (the token after "behind"/"after"). Accepts a callsign (resolved with `resolveCallsign`), or, when no
 * number is spoken, a telephony word ("Spirit") or a type word ("Cessna", "Skyhawk") that exactly one active aircraft fits.
 */
export function matchAircraftPhrase(tokens: readonly Token[], i: number, aircraft: readonly AircraftRef[]): AircraftPhrase {
  const names = new Set<string>([...GA_PREFIXES.keys(), ...aircraft.map(telephony)]);
  let s = i;
  while (tokens[s] && tokens[s].kind === 'word' && AIRCRAFT_FILLER.has(tokens[s].text)) s++;
  let e = s;
  while (e < tokens.length && e - s < MAX_PHRASE_TOKENS) {
    const t = tokens[e];
    const part = t.kind === 'number' || t.kind === 'letter' || t.kind === 'airline' || t.kind === 'gaPrefix' || (t.kind === 'word' && names.has(t.text));
    if (!part) break;
    e++;
    if (t.comma) break;
  }
  const spoken = tokens.slice(i, e).map((t) => t.text).join(' ').trim();
  const out: AircraftPhrase = { ambiguous: [], spoken, start: i, next: Math.max(e, i) };
  const slice = tokens.slice(s, e);
  if (!slice.length) return out;
  const res = resolveCallsign(slice, aircraft);
  if (res.callsign && res.score >= CALLSIGN_ACCEPT) return { ...out, callsign: res.callsign };
  if (slice.some((t) => t.kind === 'number')) return out; // digits spoken but no aircraft fits them: never guess from the telephony alone
  const first = slice[0];
  const word = first.text.toLowerCase();
  const hits = aircraft.filter((a) =>
    telephony(a) === word
    || (first.kind === 'airline' && a.callsign.toUpperCase().startsWith(first.text.toUpperCase()) && /^[A-Z]{3}\d/.test(a.callsign))
    || (first.kind === 'gaPrefix' && GA_PREFIXES.get(word)?.test(a.type.toUpperCase()) === true));
  if (hits.length === 1) return { ...out, callsign: hits[0].callsign };
  return { ...out, ambiguous: hits.map((a) => a.callsign) };
}

const isBehindWord = (t: Token | undefined): boolean => !!t && t.kind === 'word' && (t.text === 'behind' || t.text === 'after');

/** Token range of the aircraft phrase of a "cross ... behind <aircraft>" clause, so the callsign resolver does not take that aircraft for the addressed one. */
export function behindClauseSpan(tokens: readonly Token[], aircraft: readonly AircraftRef[]): { start: number; end: number } | null {
  const cross = tokens.findIndex((t) => t.kind === 'word' && t.text === 'cross');
  if (cross < 0) return null;
  const b = tokens.findIndex((t, k) => k > cross && isBehindWord(t));
  if (b < 0) return null;
  const m = matchAircraftPhrase(tokens, b + 1, aircraft);
  return m.next > m.start ? { start: m.start, end: m.next } : null;
}
