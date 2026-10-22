/**
 * Callsign conventions on the radio (JO 7110.65 2-4-20, AIM 4-2-4).
 *
 *  - Civil (N-number) aircraft: the controller states "November" on initial contact; the pilot states the type, model or manufacturer
 *    followed by the registration (the "N" is then dropped). After communications are established ATC may abbreviate to the prefix and
 *    the LAST THREE digits/letters, and the pilot may then use the abbreviation (AIM 4-2-4: "ATC specialists may initiate abbreviated
 *    call signs of other aircraft by using the prefix and the last three digits/letters of the aircraft identification after
 *    communications are established. The pilot may use the abbreviated call sign in subsequent contacts").
 *  - Never abbreviated on initial contact or when other callsigns on the frequency sound alike (AIM 4-2-4, 2-4-20: full identification
 *    in reply to similar sounding identifications). Air carriers and other aircraft with authorised callsigns are never abbreviated.
 */
import { digitsSpoken, gaPrefixWords, spokenCallsign } from './spoken';

const GA_ID = /^N(\d{1,5}[A-Z]{0,2})$/;

/** "N723EJ" -> "723EJ"; undefined for anything that is not a US registration. */
export function registrationOf(callsign: string): string | undefined {
  return GA_ID.exec(callsign.trim().toUpperCase())?.[1];
}

/** "N723EJ" -> "November seven two three echo juliet" (the form 7110.65 2-4-20 gives the controller for initial contact). */
export function novemberCallsign(callsign: string): string {
  const id = registrationOf(callsign);
  return id ? `November ${digitsSpoken(id)}` : spokenCallsign(callsign);
}

/** "N723EJ" (C172) -> "Cessna three echo juliet": the prefix (type word, else "November") and the last three characters. Undefined when not allowed (not a US registration, or fewer than four characters). */
export function abbreviatedCallsign(callsign: string, type?: string): string | undefined {
  const id = registrationOf(callsign);
  if (!id || id.length < 4) return undefined;
  const full = spokenCallsign(callsign, type);
  const prefix = gaPrefixWords(full);
  return `${prefix} ${digitsSpoken(id.slice(-3))}`;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/**
 * Two callsigns that a pilot (or a controller) could take for each other: N-numbers sharing the last two characters or within one
 * edit (AIM 4-2-4 examples: 6132F / 1622F, 123F / 7732F); airline flights of one carrier whose numbers share the last two digits or
 * are one edit apart. Design heuristic: the FAA text gives examples, not a rule.
 */
export function similarSounding(a: string, b: string): boolean {
  const ua = a.trim().toUpperCase();
  const ub = b.trim().toUpperCase();
  if (ua === ub) return false;
  const ra = registrationOf(ua);
  const rb = registrationOf(ub);
  if (ra && rb) {
    if (ra.slice(-2) === rb.slice(-2)) return true;
    return editDistance(ra, rb) <= 1;
  }
  const fa = /^([A-Z]{3})(\d{1,4})[A-Z]?$/.exec(ua);
  const fb = /^([A-Z]{3})(\d{1,4})[A-Z]?$/.exec(ub);
  if (fa && fb && fa[1] === fb[1]) return fa[2].slice(-2) === fb[2].slice(-2) || editDistance(fa[2], fb[2]) <= 1;
  return false;
}
