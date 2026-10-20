/**
 * Answers to pilot-initiated requests (`Aircraft.pendingRequest.request`, src/sim/pilotRequests.ts). Position-independent: the
 * agent answers every request of an aircraft tuned to this position's frequency. Approves what the engine can do safely and says
 * "unable" to the rest, so a pilot never waits for ever. Each answer is an ordinary command (or `UNABLE`).
 *
 *   RUNWAY_CHANGE    LAND on the requested runway when it is an active landing runway and the engine finds it safe, else unable
 *   SHORT_APPROACH   "make short approach"
 *   OPTION           "cleared for the option" when the engine finds a landing clearance safe, else unable
 *   STRAIGHT_IN      "straight-in runway N" (the Tower agent issues the landing clearance as usual)
 *   STAY_IN_PATTERN  "cleared for the touch-and-go" when safe, else "unable, make full stop"
 *   SPACING_360      "make left/right three sixty"
 *   HIGHER / LOWER   climb to the filed cruise or up to +2,000 ft / descend 1,000 ft
 *   DIRECT_FIX       "proceed direct <fix>"
 *   VISUAL_APPROACH  "cleared visual approach runway N"
 *   TAXI_BACK        Ground: taxi to the departure runway like any departure asking for taxi
 */
import type { ClearanceKind } from '../sim/types';
import { assessClearanceSafety } from '../sim/conflicts';
import { findRunwayEnd } from '../sim/runways';
import { getPerformance } from '../sim/performance';
import { mkCmd } from './core';
import type { Agent, Plan } from './core';
import { planDeparture } from './world';
import { tooHighForFaf } from './approach';
import * as say from './phrase';

/** Seconds a request is left alone before it is answered (the controller was busy, the AI reaction delay comes on top). */
const ANSWER_AFTER_SEC = 3;

export const requestAgent: Agent = (v) => {
  const plans: Plan[] = [];
  const { state, airport } = v;
  for (const ac of v.onFrequency) {
    const req = ac.pendingRequest;
    if (!req?.request || ac.radioState === 'TRANSMITTING' || v.now - req.sinceSec < ANSWER_AFTER_SEC) continue;
    const key = `${ac.id}:request:${req.request}`;
    const base = { key, aircraftId: ac.id, callsign: ac.callsign, priority: 55, once: true };
    const unable = (why: string): Plan => ({
      ...base, cmds: [mkCmd('UNABLE', ac)], phrase: say.clauses(say.callsign(ac), 'unable', why), summary: `${ac.callsign} unable (${req.request})`,
    });
    const g = findRunwayEnd(airport, req.runwayEnd ?? ac.assignedRunwayEnd);
    const safe = (c: ReturnType<typeof mkCmd>) => assessClearanceSafety(state, c).safe;
    const plan = (kind: ClearanceKind, f: Parameters<typeof mkCmd>[2], phrase: Plan['phrase'], summary: string): Plan => ({
      ...base, cmds: [mkCmd(kind, ac, f)], phrase, summary,
    });
    switch (req.request) {
      case 'RUNWAY_CHANGE': {
        if (!g || !state.activeRunways.landing.includes(g.end.id)) { plans.push(unable(`runway ${g?.end.id ?? ''} is not in use`.trim())); break; }
        const c = mkCmd('LAND', ac, { runwayEnd: g.end.id, runwayId: g.runway.id });
        plans.push(safe(c) ? plan('LAND', { runwayEnd: g.end.id, runwayId: g.runway.id }, say.clearedToLand(ac, g.end.id), `${ac.callsign} runway ${g.end.id} approved, cleared to land`) : unable('traffic on the runway'));
        break;
      }
      case 'SHORT_APPROACH':
        plans.push(plan('PATTERN_INSTRUCTION', { destination: 'SHORT_APPROACH' }, say.clauses(say.callsign(ac), 'make short approach'), `${ac.callsign} short approach approved`));
        break;
      case 'OPTION': {
        if (!g) { plans.push(unable('say again the runway')); break; }
        const c = mkCmd('LAND', ac, { runwayEnd: g.end.id, runwayId: g.runway.id, destination: 'option' });
        plans.push(safe(c) ? plan('LAND', { runwayEnd: g.end.id, runwayId: g.runway.id, destination: 'option' }, say.clauses(say.callsign(ac), say.words('runway', say.rwy(g.end.id)), 'cleared for the option'), `${ac.callsign} cleared for the option`) : unable('traffic on the runway'));
        break;
      }
      case 'STRAIGHT_IN':
        if (!g) { plans.push(unable('say again the runway')); break; }
        plans.push(plan('ENTER_PATTERN', { patternLeg: 'straight_in', runwayEnd: g.end.id, runwayId: g.runway.id }, say.enterPattern(ac, g.end.id, 'make straight-in'), `${ac.callsign} straight-in runway ${g.end.id}`));
        break;
      case 'STAY_IN_PATTERN': {
        if (!g) { plans.push(unable('make full stop')); break; }
        const c = mkCmd('LAND', ac, { runwayEnd: g.end.id, runwayId: g.runway.id, destination: 'touch_and_go' });
        plans.push(safe(c) ? plan('LAND', { runwayEnd: g.end.id, runwayId: g.runway.id, destination: 'touch_and_go' }, say.clauses(say.callsign(ac), say.words('runway', say.rwy(g.end.id)), 'cleared for the touch-and-go'), `${ac.callsign} cleared for the touch-and-go`) : unable('make full stop'));
        break;
      }
      case 'SPACING_360': {
        const side: 'left' | 'right' = 'left'; // the pattern side is not part of the public state; a left 360 is the default
        plans.push(plan('PATTERN_INSTRUCTION', { destination: 'CIRCLE', turnDirection: side, turnDegrees: 360 }, say.clauses(say.callsign(ac), `make ${side} three sixty`), `${ac.callsign} ${side} three sixty approved`));
        break;
      }
      case 'HIGHER': {
        const perf = getPerformance(ac.type);
        const cruise = ac.flightPlan?.cruiseAltitudeFt ?? 0;
        const target = Math.min(perf.serviceCeilingFt - 1000, cruise > ac.altitudeFt + 500 ? cruise : Math.round((ac.altitudeFt + 2000) / 500) * 500);
        plans.push(plan('ALTITUDE', { altitudeFt: target }, say.clauses(say.callsign(ac), say.descendMaintain(target, ac.altitudeFt)), `${ac.callsign} higher approved, ${target}`));
        break;
      }
      case 'LOWER': {
        const target = Math.max(airport.elevationFt + 1500, Math.round((ac.altitudeFt - 1000) / 500) * 500);
        plans.push(plan('ALTITUDE', { altitudeFt: target }, say.clauses(say.callsign(ac), say.descendMaintain(target, ac.altitudeFt)), `${ac.callsign} lower approved, ${target}`));
        break;
      }
      case 'DIRECT_FIX':
        if (!req.fix) { plans.push(unable('say again the fix')); break; }
        plans.push(plan('DIRECT_FIX', { fix: req.fix }, say.clauses(say.callsign(ac), say.direct(airport, req.fix)), `${ac.callsign} direct ${req.fix}`));
        break;
      case 'VISUAL_APPROACH': {
        if (!g) { plans.push(unable('say again the runway')); break; }
        const f = { approachType: 'VISUAL' as const, runwayEnd: g.end.id, runwayId: g.runway.id };
        // spacing is the Approach agent's business: no visual approach while another arrival to the runway is close ahead
        const mine = Math.hypot(ac.pos.x - g.end.threshold.x, ac.pos.y - g.end.threshold.y);
        const crowded = Object.values(state.aircraft).some((o) => o.id !== ac.id && !o.onGround && !o.isDeparture && o.assignedRunwayEnd === g.end.id
          && Math.hypot(o.pos.x - g.end.threshold.x, o.pos.y - g.end.threshold.y) < mine && mine - Math.hypot(o.pos.x - g.end.threshold.x, o.pos.y - g.end.threshold.y) < 6 * 1852);
        // nor from too high: the engine flies the descent at the airliner's 1,060 fpm, a visual approach cleared at 5,000 ft 5.7 nm out crossed the threshold at 2,350 ft and
        // touched down 7.6 km along the runway (soak seed 12). The same height test as the final approach fix (`tooHighForFaf`: 450 ft per nm and 1,000 ft), against the runway end.
        const tooHigh = tooHighForFaf(ac.altitudeFt - airport.elevationFt, mine / 1852);
        plans.push(!crowded && !tooHigh && safe(mkCmd('APPROACH', ac, f)) ? plan('APPROACH', f, say.clauses(say.callsign(ac), say.clearedApproach('VISUAL', g.end.id)), `${ac.callsign} cleared visual approach runway ${g.end.id}`) : unable('expect vectors for the approach'));
        break;
      }
      case 'TAXI_BACK': {
        if (!ac.onGround) break;
        const dep = planDeparture(airport, ac, state.activeRunways.departing);
        if (!dep) { plans.push(unable('taxi to parking')); break; }
        plans.push(plan('TAXI', { destination: `RWY${dep.runwayEnd}`, runwayEnd: dep.runwayEnd, route: dep.via, holdShort: dep.holdShort }, say.taxiToRunway(ac, dep.runwayEnd, dep.via, dep.holdShort), `${ac.callsign} taxi back to runway ${dep.runwayEnd}`));
        break;
      }
      default:
        break;
    }
  }
  return plans;
};

