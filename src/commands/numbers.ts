import { DIGIT_WORDS, MULT_WORDS, TEEN_WORDS, TENS_WORDS } from './lexicon';

export type NumberClass = 'digit' | 'teen' | 'tens' | 'mult';

/** Classify a word as part of a spoken number (typed single digits count as digits). */
export function numberWordClass(w: string): NumberClass | null {
  if (DIGIT_WORDS.has(w) || /^\d$/.test(w)) return 'digit';
  if (TEEN_WORDS.has(w)) return 'teen';
  if (TENS_WORDS.has(w)) return 'tens';
  if (MULT_WORDS.has(w)) return 'mult';
  return null;
}

export function digitValue(w: string): number {
  return DIGIT_WORDS.get(w) ?? Number(w);
}

type Last = 'none' | 'digit' | 'tens' | 'teen' | 'unit' | 'hundred' | 'thousand';

/**
 * Evaluate a run of number words into a digit string.
 *  - pure digit words concatenate and keep leading zeros: "zero niner zero" -> "090"
 *  - otherwise group form is evaluated: "four fifty one" -> "451",
 *    "two thousand five hundred" -> "2500", "one zero thousand" -> "10000"
 */
export function evaluateNumberWords(words: readonly string[]): string {
  const classes = words.map((w) => numberWordClass(w));
  if (classes.every((c) => c === 'digit')) return words.map((w) => String(digitValue(w))).join('');

  let total = 0;
  let acc = 0;
  let last: Last = 'none';
  words.forEach((w, idx) => {
    switch (classes[idx]) {
      case 'digit': {
        const v = digitValue(w);
        if ((last === 'tens' && acc % 10 === 0) || last === 'hundred') { acc += v; last = 'unit'; }
        else { acc = acc * 10 + v; last = 'digit'; }
        break;
      }
      case 'tens':
      case 'teen': {
        const v = (TENS_WORDS.get(w) ?? TEEN_WORDS.get(w)) as number;
        acc = acc > 0 && acc % 100 !== 0 ? acc * 100 + v : acc + v;
        last = classes[idx] === 'tens' ? 'tens' : 'teen';
        break;
      }
      case 'mult':
        if (w === 'hundred') { acc = (acc === 0 ? 1 : acc) * 100; last = 'hundred'; }
        else { total += (acc === 0 ? 1 : acc) * 1000; acc = 0; last = 'thousand'; }
        break;
    }
  });
  return String(total + acc);
}
