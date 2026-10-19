/**
 * Token model shared by the normaliser, callsign resolver and grammar.
 *
 * A token is one *normalised* unit ("13", "a", "NKS", "takeoff"). It remembers
 * which raw (whitespace separated) words of the original text it came from so
 * the transformation is reversible: `rawSlice` gives back the original text.
 */
export type TokenKind =
  | 'word'      // ordinary lower-case word
  | 'number'    // digit string, may contain one '.', may start with '.' (".9")
  | 'letter'    // single letter (spelled, NATO phonetic or typed)
  | 'airline'   // ICAO telephony prefix, upper-case ("NKS")
  | 'gaPrefix'  // general-aviation type prefix ("cessna")
  | 'barrier';  // masks tokens already consumed (callsign); matches nothing

export interface Token {
  text: string;
  kind: TokenKind;
  /** Raw word range [rawStart, rawEnd) in `NormalizedText.rawWords`. */
  rawStart: number;
  rawEnd: number;
  /** The raw word this token ends carries a comma or semicolon: a clause ends here. */
  comma?: boolean;
}

export interface NormalizedText {
  raw: string;
  rawWords: string[];
  tokens: Token[];
  /** tokens joined by single spaces */
  text: string;
}

/** Original text covered by tokens[from..to). */
export function rawSlice(n: NormalizedText, from: number, to: number): string {
  if (to <= from || from < 0 || to > n.tokens.length) return '';
  return n.rawWords.slice(n.tokens[from].rawStart, n.tokens[to - 1].rawEnd).join(' ');
}
