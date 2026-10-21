import type { Element, Rule } from './draft';
import type { ParseContext } from './context';
import { makeFixMatcher } from './fixes';
import type { Toks } from './match';
import {
  makeClearedToParkingRule, makeContinueTaxiRule, makeHoldShortRule, makeTaxiRule, ruleCancel, ruleContinueSegment, makeCrossRule, ruleHoldPosition, ruleLineUp, ruleReadBackHold, ruleTaxiIntoPosition, ruleTurnAround,
} from './rules-ground';
import { ruleHoldAtFix, ruleMissedApproach } from './rules-hold';
import { makeAltitudeRule, ruleHeading, rulePattern, ruleSpeed } from './rules-flight';
import {
  ruleApproach, ruleDirectFix, ruleIfrClearance, rulePosition, ruleRadarContact, ruleResumeNav,
} from './rules-ifr';
import {
  ruleContact, ruleDidYouCopy, ruleFiller, ruleRoute, ruleRunwayRef, ruleSayAgain, ruleUnable, ruleUnsupported, ruleWind,
} from './rules-misc';
import { ruleContinue, ruleGoAround, ruleLand, rulePushback, ruleTakeoff } from './rules-tower';
import { ruleBirdAdvisory, ruleBrakingAdvisory, ruleRunwayLights, ruleRvr, ruleStar } from './rules-airport';
import { makeProceedRule, ruleAirTaxi, ruleHeliLand, ruleHeliTakeoff, ruleOverhead, ruleTrafficDirection } from './rules-special';
import {
  ruleAirportInfo, ruleCancelTakeoff, ruleExitRunway, ruleFollowTraffic, ruleFrequencyApproved, rulePatternInstruction, ruleRadarServiceTerminated, ruleReportPosition,
  ruleSquawk, ruleTrafficAdvisory, withLuawTraffic,
} from './rules-tower-ext';

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
 *  - tower vocabulary (rules-tower-ext.ts) sits before the heading / pattern / continue rules: "turn left at Charlie" and "turn base now"
 *    start like a heading, "continue to the end" like "continue"; cancel takeoff before the older "cancel" rule; airport info before the wind filler
 *  - the positional "N miles from X" filler sits after the runway / route refs
 *  - advisories (bird activity, braking action), runway lights and the STAR clearance come first: "descend via" must not reach the altitude rule,
 *    "cleared ROZZE two arrival" must not reach the IFR clearance / unsupported rules, "runway lights" must not reach the runway reference
 * Fix-aware rules (direct, until, position text) need `ctx.fixes`, so the list is built per parse.
 */
export function buildRules(ctx: Partial<Pick<ParseContext, 'fixes' | 'taxiways' | 'runwayEnds' | 'arrivals' | 'aircraft'>> = {}): readonly Rule[] {
  const fixes = makeFixMatcher(ctx.fixes);
  const taxiRule = makeTaxiRule(ctx.taxiways, ctx.runwayEnds);
  return [
    ruleAirTaxi, makeProceedRule(taxiRule), ruleHeliTakeoff, ruleHeliLand, ruleOverhead, ruleTrafficDirection,
    ruleAirportInfo, ruleWind, ruleDidYouCopy, ruleSayAgain, ruleUnable, ruleBirdAdvisory, ruleBrakingAdvisory, ruleRvr, ruleRunwayLights, ruleStar(ctx.arrivals ?? [], fixes), ruleTaxiIntoPosition, withLuawTraffic(ruleLineUp), ruleCancelTakeoff, ruleRadarServiceTerminated, ruleFrequencyApproved, ruleSquawk,
    ruleTurnAround, ruleExitRunway, rulePatternInstruction, ruleReportPosition, ruleFollowTraffic, ruleTrafficAdvisory, ruleTakeoff, ruleLand, ruleHoldAtFix(fixes),
    ruleMissedApproach, ruleGoAround, rulePushback, ruleReadBackHold, ruleContinueSegment, ruleRadarContact(fixes), ruleResumeNav, makeClearedToParkingRule(ctx.taxiways, ctx.runwayEnds), ruleApproach, ruleDirectFix(fixes),
    ruleIfrClearance, ruleContact, makeHoldShortRule(ctx.runwayEnds), ruleHoldPosition, ruleCancel, makeCrossRule(ctx.aircraft), makeContinueTaxiRule(ctx.taxiways, ctx.runwayEnds), makeTaxiRule(ctx.taxiways, ctx.runwayEnds),
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
