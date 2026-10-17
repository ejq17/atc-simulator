/**
 * Aviation vocabulary shared by the STT providers: keyterms for Deepgram and
 * plausibility scoring for picking among Web Speech alternatives.
 */

export const PHONETIC_ALPHABET = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
  'xray', 'yankee', 'zulu',
] as const;

export const AIRLINE_CALLSIGN_WORDS = [
  'Spirit', 'American', 'Delta', 'United', 'Southwest', 'JetBlue', 'Frontier',
] as const;

/** Words that strongly indicate ATC phraseology. */
export const AVIATION_KEYWORDS = [
  'runway', 'cleared', 'taxi', 'hold', 'contact', 'heading', 'maintain',
  'climb', 'descend', 'niner', 'tower', 'ground', 'approach', 'departure',
  'takeoff', 'landing', 'squawk', 'taxiway', 'short', 'wait', 'line',
  'traffic', 'wilco', 'roger', 'expedite', 'altitude', 'frequency', 'ident',
  'tree', 'fife', 'flight', 'level', 'turn', 'left', 'right', 'direct',
  ...PHONETIC_ALPHABET,
] as const;

/** Deepgram Nova-3 `keyterm` list (kept under the ~500 token limit). */
export const AVIATION_KEYTERMS: readonly string[] = [
  ...AIRLINE_CALLSIGN_WORDS,
  'Cessna', 'Piper', 'Cirrus', 'Skyhawk', 'Citation', 'Learjet', 'Cardinal',
  'Atlantic City', 'Atlantic City Tower', 'Atlantic City Ground',
  'runway', 'taxiway', 'niner', 'tree', 'fife',
  ...PHONETIC_ALPHABET,
  'hold short', 'line up and wait', 'cleared for takeoff', 'cleared to land',
  'cleared to taxi', 'taxi via', 'contact tower', 'contact ground',
  'contact departure', 'contact approach', 'go around', 'squawk', 'ident',
  'heading', 'maintain', 'expedite', 'wilco', 'roger', 'traffic',
  'readback', 'say again', 'flight level', 'frequency',
];

const KEYWORD_SET = new Set<string>(AVIATION_KEYWORDS);

export interface SttAlternative {
  transcript: string;
  confidence?: number;
}

/** Higher means more like an ATC transmission. */
export function scoreAviationPlausibility(text: string): number {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  for (const w of words) {
    if (KEYWORD_SET.has(w)) score += 2;
    else if (/^\d+$/.test(w) || ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].includes(w)) score += 0.5;
  }
  return score;
}

/**
 * Pick the alternative most likely to be an aviation transmission. The
 * recognizer's own ranking is the tie-breaker (first alternative wins ties),
 * and confidence contributes a small amount.
 */
export function pickBestAlternative(alts: readonly SttAlternative[]): SttAlternative | undefined {
  let best: SttAlternative | undefined;
  let bestScore = -Infinity;
  alts.forEach((alt, i) => {
    if (!alt.transcript.trim()) return;
    const s = scoreAviationPlausibility(alt.transcript) + (alt.confidence ?? 0) - i * 0.1;
    if (s > bestScore) {
      bestScore = s;
      best = alt;
    }
  });
  return best;
}
