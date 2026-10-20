/**
 * What the AI does once Approach has approved a departure gap (coordination topic GAP, gap.ts): the arrivals behind the gap are delayed as far as the plan needs,
 * by the gentlest tool that is enough: a speed assignment (JO 7110.65 5-7-1, "keep speed adjustments to the minimum necessary") when it saves the time, else, for a
 * VFR straight-in aircraft, a 360 ("make left three-sixty", 3-8-1: the sequence is made by requiring aircraft "to adjust flight"), one at a time, and for an IFR
 * arrival without an approach clearance the published hold, the clearance coming `GAP_HOLD_DELAY_SEC` later (approach.ts).
 *
 * Every instruction is spoken by the position the aircraft is tuned to (the engine refuses an instruction on another frequency, and a pilot hears one voice):
 * Approach for the arrivals on its frequency (the IFR flow), Tower for the VFR straight-in aircraft the generator puts on the Tower frequency. Both read the same
 * plan from the same state, so the gap one of them promises is the gap the other builds. Plans are made once per aircraft (`once`).
 */
import type { Aircraft } from '../sim/types';
import { findRunwayEnd } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { validApproval } from '../sim/coordination';
import { mkCmd, onPosition } from './core';
import type { AgentView, Plan } from './core';
import { nmToM } from '../sim/geo';
import { getPerformance } from '../sim/performance';
import { CIRCLE_CLEAR_FT, CIRCLE_CLEAR_NM, delayOption, gapPlan, gapReach } from './gap';
import type { DelayOption, GapPlan } from './gap';
import { publishedHoldFor } from './approach';
import * as say from './phrase';

/** `GapOptions.optionOf` for the position of this view. */
export function gapOptionOf(v: AgentView): (ac: Aircraft, og: RunwayEndGeom) => DelayOption | undefined {
  const reach = gapReach(v);
  // a 360 is not given to an aircraft with other traffic close to the loop (the turn is not separated from it)
  // (and none while a fighter flight or an overhead maneuver is airborne: they fly their own fast pattern across the approach)
  const crowded = (ac: Aircraft) => Object.values(v.state.aircraft).some((o) => o.id !== ac.id && !o.onGround && (getPerformance(o.type).military || o.flags.overhead || Math.abs(o.altitudeFt - ac.altitudeFt) < CIRCLE_CLEAR_FT && Math.hypot(o.pos.x - ac.pos.x, o.pos.y - ac.pos.y) < nmToM(CIRCLE_CLEAR_NM)));
  return (ac, og) => delayOption(ac, og, reach, { state: v.state, holdAvailable: (a) => publishedHoldFor(v, a) !== undefined, crowded });
}

/** The plan for the departure of a GAP request (undefined when the departure is no longer at the hold). */
export function gapPlanFor(v: AgentView, dep: Aircraft, departures?: number): GapPlan | undefined {
  const g = findRunwayEnd(v.airport, dep.assignedRunwayEnd);
  if (!g || !dep.onGround || dep.phase !== 'HOLDING_SHORT') return undefined;
  return gapPlan(v.state, v.airport, g, dep, { lined: false, departures, optionOf: gapOptionOf(v) });
}

export function gapPlans(v: AgentView): Plan[] {
  const out: Plan[] = [];
  const reqs = (v.state.coordination?.requests ?? []).filter((r) => r.topic === 'GAP' && r.status === 'approved' && validApproval(v.state, 'GAP', r.aircraftId));
  if (!reqs.length) return out;
  const optionOf = gapOptionOf(v);
  const seen = new Set<string>();
  for (const r of reqs) {
    const dep = v.state.aircraft[r.aircraftId];
    if (!dep) continue;
    const plan = gapPlanFor(v, dep, r.departures);
    if (!plan?.feasible) continue;
    for (const d of plan.delays) {
      const ac = d.ac;
      const og = findRunwayEnd(v.airport, ac.assignedRunwayEnd);
      if (!og || seen.has(ac.id) || ac.radioState === 'TRANSMITTING' || !onPosition(v.airport, ac, v.position)) continue;
      seen.add(ac.id);
      const opt = optionOf(ac, og);
      if (!opt) continue;
      const why = `${d.delaySec.toFixed(0)} s later for ${dep.callsign}'s departure gap${plan.after ? ` behind ${plan.after.callsign}` : ''}`;
      if (opt.speedKt && (opt.speedGainSec >= d.delaySec + 5 || (opt.circles === 0 && !opt.hold))) {
        out.push({
          key: `${ac.id}:gap-slow:${opt.speedKt}`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, once: true,
          cmds: [mkCmd('SPEED', ac, { speedKt: opt.speedKt })], phrase: say.clauses(say.callsign(ac), say.reduceSpeed(opt.speedKt)),
          summary: `${ac.callsign} reduce speed ${opt.speedKt}, ${why}`,
        });
      } else if (opt.hold) {
        const hold = publishedHoldFor(v, ac);
        if (hold) {
          v.mem.notes.set(`gaphold:${ac.id}`, v.now); // Approach clears it from the hold when `GAP_HOLD_DELAY_SEC` have passed (approach.ts)
          out.push({
            key: `${ac.id}:hold:${hold.fix}`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, once: true,
            cmds: [mkCmd('HOLD_AT_FIX', ac, { hold: { fix: hold.fix, asPublished: true, turns: hold.turns } })],
            phrase: say.clauses(say.callsign(ac), say.holdAsPublished(v.airport, hold.fix)), summary: `${ac.callsign} hold at ${hold.fix} as published, ${why}`,
          });
        }
      } else if (opt.circles > 0) {
        const n = ac.clearances.filter((c) => c.kind === 'PATTERN_INSTRUCTION' && c.destination === 'CIRCLE').length;
        out.push({
          key: `${ac.id}:gap-360:${n}`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, once: true,
          cmds: [mkCmd('PATTERN_INSTRUCTION', ac, { destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 })], phrase: say.clauses(say.callsign(ac), 'make left three sixty for spacing'),
          summary: `${ac.callsign} make a left 360, ${why}`,
        });
      }
    }
  }
  return out;
}
