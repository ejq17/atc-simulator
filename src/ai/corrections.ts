/**
 * Faulty readbacks. When a pilot reads back a clearance wrongly (`flags.readbackErrorPending`), the position that issued it
 * re-issues the same clearance ("negative, runway one three, cleared for takeoff"); the engine then lets the pilot correct it.
 */
import type { Aircraft, Clearance } from '../sim/types';
import { mkCmd } from './core';
import type { Agent, AgentView, Plan } from './core';
import * as say from './phrase';
import { findStar } from '../sim/star';

const RETRY_COOLDOWN_SEC = 8;

function planFor(v: AgentView, ac: Aircraft, clr: Clearance, parking: (id: string) => { id: string; category: string } | undefined): Pick<Plan, 'cmds' | 'phrase'> | undefined {
  switch (clr.kind) {
    case 'TAKEOFF':
      return {
        cmds: [mkCmd('TAKEOFF', ac, { runwayEnd: clr.runwayEnd, runwayId: clr.runwayId })],
        phrase: say.negative(say.clearedForTakeoff(ac, clr.runwayEnd ?? '', ac.flightPlan?.flightRules === 'IFR')),
      };
    case 'LAND':
      return {
        cmds: [mkCmd('LAND', ac, { runwayEnd: clr.runwayEnd, runwayId: clr.runwayId, holdShort: clr.holdShort })],
        phrase: say.negative(say.clearedToLand(ac, clr.runwayEnd ?? '')),
      };
    case 'LINE_UP_AND_WAIT':
      return {
        cmds: [mkCmd('LINE_UP_AND_WAIT', ac, { runwayEnd: clr.runwayEnd, runwayId: clr.runwayId })],
        phrase: say.negative(say.lineUpAndWait(ac, clr.runwayEnd ?? '')),
      };
    case 'TAXI':
    case 'TAXI_TO_PARKING': {
      const cmds = [mkCmd(clr.kind, ac, { destination: clr.destination, runwayEnd: clr.runwayEnd, route: clr.route, holdShort: clr.holdShort })];
      const spot = clr.destination ? parking(clr.destination) : undefined;
      const phrase = clr.runwayEnd
        ? say.taxiToRunway(ac, clr.runwayEnd, clr.route ?? [], clr.holdShort ?? [])
        : say.taxiToParking(ac, spot ?? { id: clr.destination ?? '', category: 'other' }, clr.route ?? [], clr.holdShort ?? []);
      return { cmds, phrase: say.negative(phrase) };
    }
    case 'CROSS_RUNWAY':
      return {
        cmds: [mkCmd('CROSS_RUNWAY', ac, { crossRunwayId: clr.runwayId, runwayId: clr.runwayId })],
        phrase: say.negative(say.crossRunway(ac, clr.runwayId ?? '')),
      };
    case 'APPROACH':
      return {
        cmds: [mkCmd('APPROACH', ac, { approachType: clr.approachType, runwayEnd: clr.runwayEnd, runwayId: clr.runwayId })],
        phrase: say.negative(say.clauses(say.callsign(ac), say.clearedApproach(clr.approachType ?? 'ILS', clr.runwayEnd ?? ''))),
      };
    case 'ALTITUDE':
      return {
        cmds: [mkCmd('ALTITUDE', ac, { altitudeFt: clr.altitudeFt })],
        phrase: say.negative(say.clauses(say.callsign(ac), say.descendMaintain(clr.altitudeFt ?? 0, ac.altitudeFt))),
      };
    case 'CONTACT_FREQUENCY': {
      const id = clr.frequencyId ?? v.airport.frequencies.find((f) => clr.frequencyMhz !== undefined && Math.abs(f.mhz - clr.frequencyMhz) < 0.0005)?.id;
      if (!id || clr.frequencyMhz === undefined) return undefined;
      return {
        cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: id, frequencyMhz: clr.frequencyMhz })],
        phrase: say.negative(say.contact(ac, v.airport, id, clr.frequencyMhz)),
      };
    }
    case 'CONTINUE_APPROACH':
      return { cmds: [mkCmd('CONTINUE_APPROACH', ac)], phrase: say.negative(say.continueApproach(ac)) };
    case 'GO_AROUND':
      return { cmds: [mkCmd('GO_AROUND', ac)], phrase: say.negative(say.goAround(ac)) };
    case 'SPEED':
      return clr.speedKt !== undefined ? { cmds: [mkCmd('SPEED', ac, { speedKt: clr.speedKt })], phrase: say.negative(say.clauses(say.callsign(ac), say.reduceSpeed(clr.speedKt))) } : undefined;
    case 'DIRECT_FIX':
      return clr.fix ? { cmds: [mkCmd('DIRECT_FIX', ac, { fix: clr.fix })], phrase: say.negative(say.clauses(say.callsign(ac), say.direct(v.airport, clr.fix))) } : undefined;
    // Approach / Departure / Tower / Ground instructions that had no case here were never repeated when the pilot gave no readback (soak seed 8: "hold at CARYL
    // as published"; the pilot did not receive it, the 20 s window dropped it and nothing was said for 190 s).
    case 'HOLD_AT_FIX':
      return clr.hold?.fix && clr.hold.asPublished
        ? { cmds: [mkCmd('HOLD_AT_FIX', ac, { hold: clr.hold })], phrase: say.negative(say.clauses(say.callsign(ac), say.holdAsPublished(v.airport, clr.hold.fix))) }
        : undefined;
    case 'STAR':
      return clr.starName
        ? { cmds: [mkCmd('STAR', ac, { starName: clr.starName, descendVia: clr.descendVia })], phrase: say.negative(say.clauses(say.callsign(ac), say.descendViaArrival(findStar(v.airport, clr.starName)?.star.spokenName ?? clr.starName))) }
        : undefined;
    case 'PUSHBACK':
      return { cmds: [mkCmd('PUSHBACK', ac, clr.pushTailDeg !== undefined ? { pushTailDeg: clr.pushTailDeg } : {})], phrase: say.negative(say.pushbackApproved(ac)) };
    case 'ENTER_PATTERN':
      return clr.runwayEnd && clr.patternLeg
        ? { cmds: [mkCmd('ENTER_PATTERN', ac, { runwayEnd: clr.runwayEnd, patternLeg: clr.patternLeg })], phrase: say.negative(say.enterPattern(ac, clr.runwayEnd, clr.patternLeg.replace('_', ' '))) }
        : undefined;
    case 'SQUAWK':
      return clr.squawk ? { cmds: [mkCmd('SQUAWK', ac, { squawk: clr.squawk })], phrase: say.negative(say.squawkCode(ac, clr.squawk)) } : undefined;
    case 'IFR_CLEARANCE':
      return clr.ifr
        ? { cmds: [mkCmd('IFR_CLEARANCE', ac, { ifr: clr.ifr })], phrase: say.negative(say.ifrClearance(ac, v.facility(ac), clr.ifr, v.airport)) }
        : undefined;
    default:
      return undefined;
  }
}

/** The pilot gave no readback, or another aircraft answered: the instruction is simply repeated ("negative" only fits a wrong readback). */
const PLAIN_REPEAT = new Set(['no_readback', 'callsign']);

export const correctionAgent: Agent = (v) => {
  const plans: Plan[] = [];
  for (const ac of v.onFrequency) {
    if (!ac.flags.readbackErrorPending) continue;
    const clr = (ac.flags.readbackErrorClearanceId ? ac.clearances.find((c) => c.id === ac.flags.readbackErrorClearanceId && c.byPosition === v.position) : undefined)
      ?? [...ac.clearances].reverse().find((c) => c.byPosition === v.position);
    if (!clr) continue;
    const p = planFor(v, ac, clr, (id) => v.airport.parking.find((x) => x.id === id));
    if (!p) continue;
    if (PLAIN_REPEAT.has(ac.flags.readbackErrorKind ?? '')) p.phrase = { text: p.phrase.text.replace(/^negative, /, ''), spoken: p.phrase.spoken.replace(/^negative, /, '') };
    plans.push({
      key: `${ac.id}:fix:${clr.id}`, aircraftId: ac.id, callsign: ac.callsign, priority: 95, cooldownSec: RETRY_COOLDOWN_SEC,
      ...p, summary: `${ac.callsign} re-issue ${clr.kind} (wrong readback)`,
    });
  }
  return plans;
};
