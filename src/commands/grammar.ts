import type { Element, Rule } from './draft';
import type { Toks } from './match';
import {
  ruleCross, ruleHoldPosition, ruleHoldShort, ruleLineUp, ruleTaxi, ruleTaxiIntoPosition,
} from './rules-ground';
import { ruleAltitude, ruleHeading, rulePattern, ruleSpeed } from './rules-flight';
import {
  ruleContact, ruleFiller, ruleRoute, ruleRunwayRef, ruleSayAgain, ruleUnsupported, ruleWind,
} from './rules-misc';
import { ruleContinue, ruleGoAround, ruleLand, rulePushback, ruleTakeoff } from './rules-tower';

/**
 * Ordered rule list; the first rule that matches at a position wins.
 * Order matters where rules share a leading word:
 *  - taxi-into-position before taxi, hold-short before hold-position
 *  - heading before speed before altitude (all can start with "maintain")
 *  - heading before pattern ("fly"/"make"), heading before continue
 *  - land/takeoff before the unsupported "cleared ... approach" catch-all
 */
export const RULES: readonly Rule[] = [
  ruleWind, ruleSayAgain, ruleTaxiIntoPosition, ruleLineUp, ruleTakeoff, ruleLand, ruleGoAround,
  rulePushback, ruleContact, ruleHoldShort, ruleHoldPosition, ruleCross, ruleTaxi,
  ruleHeading, ruleSpeed, ruleAltitude, rulePattern, ruleContinue, ruleUnsupported,
  ruleRunwayRef, ruleRoute, ruleFiller,
];

/** Scan tokens left to right, producing non-overlapping recognised elements. */
export function scan(toks: Toks, rules: readonly Rule[] = RULES): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < toks.length;) {
    let hit = null;
    for (const rule of rules) {
      hit = rule(toks, i);
      if (hit && hit.end > i) break;
      hit = null;
    }
    if (hit) { out.push({ start: i, end: hit.end, body: hit.body }); i = hit.end; } else i++;
  }
  return out;
}
