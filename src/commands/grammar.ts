import type { Element, Rule } from './draft';
import type { ParseContext } from './context';
import { makeFixMatcher } from './fixes';
import type { Toks } from './match';
import {
  ruleCross, ruleHoldPosition, ruleHoldShort, ruleLineUp, ruleTaxi, ruleTaxiIntoPosition,
} from './rules-ground';
import { makeAltitudeRule, ruleHeading, rulePattern, ruleSpeed } from './rules-flight';
import {
  ruleApproach, ruleDirectFix, ruleIfrClearance, rulePosition, ruleRadarContact, ruleResumeNav,
} from './rules-ifr';
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
 *  - land/takeoff before the approach / IFR clearance rules (all start with "cleared"),
 *    approach before IFR clearance ("cleared to the ILS ..."), both before the unsupported
 *    "cleared ... approach" catch-all (NDB, TACAN ...)
 *  - radar contact / resume nav / direct before heading ("proceed")
 *  - the positional "N miles from X" filler sits after the runway / route refs
 * Fix-aware rules (direct, until, position text) need `ctx.fixes`, so the list is built per parse.
 */
export function buildRules(ctx: Pick<ParseContext, 'fixes'> = {}): readonly Rule[] {
  const fixes = makeFixMatcher(ctx.fixes);
  return [
    ruleWind, ruleSayAgain, ruleTaxiIntoPosition, ruleLineUp, ruleTakeoff, ruleLand, ruleGoAround,
    rulePushback, ruleRadarContact(fixes), ruleResumeNav, ruleApproach, ruleDirectFix(fixes),
    ruleIfrClearance, ruleContact, ruleHoldShort, ruleHoldPosition, ruleCross, ruleTaxi,
    ruleHeading, ruleSpeed, makeAltitudeRule(fixes), rulePattern, ruleContinue, ruleUnsupported,
    ruleRunwayRef, ruleRoute, rulePosition(fixes), ruleFiller,
  ];
}

/** Rule list without fix knowledge (any single word after "direct" is accepted). */
export const RULES: readonly Rule[] = buildRules();

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
