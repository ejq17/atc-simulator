/**
 * Fix common browser-TTS mispronunciations. The engine already supplies
 * phonetic callsigns and spelled-out numbers; this is a safety net.
 */

const DIGIT_WORDS: Record<string, string> = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'niner',
};

const SUFFIX_WORDS: Record<string, string> = { L: 'left', R: 'right', C: 'center' };

/**
 * Acronyms spoken letter by letter. Pronounced-as-word acronyms (ATIS, METAR, TAF,
 * NOTAM, ASOS, AWOS, RNAV, TCAS, PAPI, VASI, SID) are deliberately NOT listed: the FAA
 * Pilot/Controller Glossary and common usage say them as words (see docs/PHRASEOLOGY-AUDIT.md).
 */
const LETTERED = [
  'ILS', 'VFR', 'IFR', 'VOR', 'DME', 'ATC',
  'VMC', 'IMC', 'GPS', 'RVR', 'FAA',
  'ACY', 'KACY', 'MSL', 'AGL', 'NDB', 'ADS-B',
];
const LETTERED_RE = new RegExp(`\\b(${LETTERED.map((a) => a.replace('-', '\\-')).join('|')})\\b`, 'g');

const WORD_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\bRWY\b/g, 'runway'],
  [/\bTWY\b/g, 'taxiway'],
  [/\bTRACON\b/g, 'tracon'],
  [/\bkts\b/gi, 'knots'],
  [/\bQNH\b/g, 'Q N H'],
];

function spellDigits(s: string): string {
  return s
    .split('')
    .map((c) => DIGIT_WORDS[c] ?? c)
    .join(' ');
}

export function prepareForTts(text: string): string {
  let out = text;
  for (const [re, rep] of WORD_REPLACEMENTS) out = out.replace(re, rep);

  // Runway designators: "runway 27L", "runway 09", "runways 4 and 22".
  out = out.replace(/\b(runways?)\s+(\d{1,2})([LRC])?\b/gi, (_m, word: string, num: string, suffix?: string) => {
    const digits = spellDigits(num);
    const side = suffix ? ` ${SUFFIX_WORDS[suffix.toUpperCase()]}` : '';
    return `${word} ${digits}${side}`;
  });
  out = out.replace(/\b(and|or)\s+(\d{1,2})([LRC])\b/g, (_m, c: string, num: string, suffix: string) =>
    `${c} ${spellDigits(num)} ${SUFFIX_WORDS[suffix]}`);

  // Headings and squawks given as digits.
  out = out.replace(/\b(heading|squawk|course)\s+(\d{3,4})\b/gi, (_m, word: string, num: string) => `${word} ${spellDigits(num)}`);

  // Frequencies: "121.7" -> "one two one point seven".
  out = out.replace(/\b(\d{3})\.(\d{1,3})\b/g, (_m, a: string, b: string) => `${spellDigits(a)} point ${spellDigits(b)}`);

  // Letter-by-letter acronyms.
  out = out.replace(LETTERED_RE, (a) => a.replace('-', '').split('').join(' '));

  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Respellings for the neural voices only. The neural engines phonemise with espeak-ng (en-us). Every ICAO alphabet word, the digit
 * words ("niner", "three", "zero"), "point", runway and frequency phrasing came out right (checked by reading the phoneme strings),
 * except these three; the browser voices say them acceptably, so this is not applied to them.
 *   Quebec  -> kwᵻbˈɛk ("kwi-BECK"); "kuh beck" -> kˈʌ bˈɛk, close to the ICAO "keh-BECK"
 *   ATIS    -> ˈæɾiz ("AD-iz"); "eightis" -> ˈeɪɾiz ("AY-diz"), close to the FAA "AY-tis"
 *   TRACON  -> tɹˈækən ("TRACK-en"); "traycon" -> tɹˈeɪkən ("TRAY-kun")
 */
const NEURAL_RESPELLINGS: ReadonlyArray<[RegExp, string]> = [
  [/\bquebec\b/gi, 'kuh beck'],
  [/\bATIS\b/gi, 'eightis'],
  [/\bTRACON\b/gi, 'traycon'],
];

export function prepareForNeuralTts(text: string): string {
  let out = prepareForTts(text);
  for (const [re, rep] of NEURAL_RESPELLINGS) out = out.replace(re, rep);
  return out;
}
