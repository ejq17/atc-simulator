import type { Element, Rule } from './draft';
import type { ParseContext } from './context';
import { makeFixMatcher } from './fixes';
import type { Toks } from './match';
import {
  makeClearedToParkingRule, makeContinueTaxiRule, makeTaxiRule, ruleCancel, ruleCross, ruleHoldPosition, ruleHoldShort, ruleLineUp, ruleTaxiIntoPosition,
} from './rules-ground';
import { ruleHoldAtFix, ruleMissedApproach } from './rules-hold';
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
 *  - hold-at-fix before hold-short / hold-position (it only claims "hold at|as published|<compass>|<known fix>"
 *    and "cleared to FIX, hold"); missed approach before go-around ("go around, fly the published missed approach")
 *  - radar contact / resume nav / direct before heading ("proceed")
 *  - the positional "N miles from X" filler sits after the runway / route refs
 * Fix-aware rules (direct, until, position text) need `ctx.fixes`, so the list is built per parse.
 */
export function buildRules(ctx: Pick<ParseContext, 'fixes' | 'taxiways'> = {}): readonly Rule[] {
  const fixes = makeFixMatcher(ctx.fixes);
  return [
    ruleWind, ruleSayAgain, ruleTaxiIntoPosition, ruleLineUp, ruleTakeoff, ruleLand, ruleHoldAtFix(fixes),
    ruleMissedApproach, ruleGoAround, rulePushback, ruleRadarContact(fixes), ruleResumeNav, makeClearedToParkingRule(ctx.taxiways), ruleApproach, ruleDirectFix(fixes),
    ruleIfrClearance, ruleContact, ruleHoldShort, ruleHoldPosition, ruleCancel, ruleCross, makeContinueTaxiRule(ctx.taxiways), makeTaxiRule(ctx.taxiways),
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
