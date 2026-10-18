/**
 * Faulty readbacks. When a pilot reads back a clearance wrongly (`flags.readbackErrorPending`), the position that issued it
 * re-issues the same clearance ("negative, runway one three, cleared for takeoff"); the engine then lets the pilot correct it.
 */
import type { Aircraft, Clearance } from '../sim/types';
import { mkCmd } from './core';
import type { Agent, Plan } from './core';
import * as say from './phrase';

const RETRY_COOLDOWN_SEC = 8;

function planFor(ac: Aircraft, clr: Clearance, parking: (id: string) => { id: string; category: string } | undefined): Pick<Plan, 'cmds' | 'phrase'> | undefined {
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
    default:
      return undefined;
  }
}

export const correctionAgent: Agent = (v) => {
  const plans: Plan[] = [];
  for (const ac of v.onFrequency) {
    if (!ac.flags.readbackErrorPending) continue;
    const clr = (ac.flags.readbackErrorClearanceId ? ac.clearances.find((c) => c.id === ac.flags.readbackErrorClearanceId && c.byPosition === v.position) : undefined)
      ?? [...ac.clearances].reverse().find((c) => c.byPosition === v.position);
    if (!clr) continue;
    const p = planFor(ac, clr, (id) => v.airport.parking.find((x) => x.id === id));
    if (!p) continue;
    plans.push({
      key: `${ac.id}:fix:${clr.id}`, aircraftId: ac.id, callsign: ac.callsign, priority: 95, cooldownSec: RETRY_COOLDOWN_SEC,
      ...p, summary: `${ac.callsign} re-issue ${clr.kind} (wrong readback)`,
    });
  }
  return plans;
};
