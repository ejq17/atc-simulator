/**
 * Clean-up for Whisper output before it reaches the command parser.
 *
 * The parser (src/commands/lexicon.ts + normalize.ts) already handles number words vs digits ("723", "1 3"),
 * NATO words in any case ("Echo Juliet"), "clear to land", airline telephony and most phonetic drift. This file
 * only covers what it does NOT:
 *  - Whisper's silence/noise markers and well-known silence hallucinations ("Thank you.", "[BLANK_AUDIO]"),
 *  - misspellings of "Cessna" (Whisper writes the sound it heard: "Sessna", "SESNA"), which the parser flags as
 *    an unrecognised word even though the callsign still resolves.
 * Keep this list short and evidence-based: each entry was observed in a real transcript or is a plain spelling
 * variant of an aviation word.
 */

/** Spelling variants of "Cessna" seen from Whisper tiny/base. Compared lower-case, whole word. */
const CESSNA_VARIANTS = ['sessna', 'sesna', 'sesma', 'cesna', 'sesena', 'cessena', 'cessnah', 'sessnah', 'cessnia', 'cessner'];
const CESSNA_RE = new RegExp(`\\b(?:${CESSNA_VARIANTS.join('|')})\\b`, 'gi');

/** Whole-utterance outputs Whisper produces for silence or room noise. They must never become a transmission. */
const NOISE_ONLY_RE =
  /^(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+|thank you(?: very much)?\.?|thanks for watching\.?|you\.?|bye\.?|\.+)\s*)+$/i;

export function postProcessTranscript(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text || NOISE_ONLY_RE.test(text)) return '';
  // Inline noise markers such as "[BLANK_AUDIO]" or "(clicking)" next to real words.
  text = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(CESSNA_RE, () => 'Cessna');
  return text;
}
