/**
 * "Make a one eighty": an aircraft on a taxiway stops and turns 180 degrees, then holds position for new taxi instructions (a lander pointed at a
 * departure queue, a taxiing aircraft that must go back the way it came).
 *
 * JO 7110.65 has no phrase for it ("make a one eighty" is common usage: the parser flags it non-standard and lowers the confidence). What the engine
 * checks is whether the aircraft can do it where it stands:
 *  - not on a runway surface (a turn there is a runway operation: back-taxi / exit instructions apply), not parked, in a pushback, or in the air;
 *  - there must be room. The airport data carries no pavement widths, so the rule is a simplification (docs/BEHAVIOUR-ACCURACY.md G11):
 *    a light aircraft (`category` light: the C172 pivots in a few metres, POH minimum turning radius 27 ft is its wing tip, REALISM-VERIFICATION.md)
 *    can turn on any taxiway; heavier aircraft need an apron or a parking connector within `APRON_ROOM_M` (AC 150/5300-13B Table 4-2: a straight
 *    taxiway is 25 ft wide for TDG 1A/1B up to 50 ft for TDG 3/4, the width of the pavement for the TDG, not a turning area; the Airbus A320 nose
 *    gear alone sweeps a 13.4 m radius, REALISM-VERIFICATION.md).
 */
import type { Aircraft } from './types';
import type { SimContext } from './context';
import { dist } from './geo';
import { perfOf } from './context';

/** A heavier aircraft finds room to turn around within this distance (m) of an apron or a parking connector. DESIGN VALUE. */
export const APRON_ROOM_M = 60;

export interface TurnAroundCheck {
  ok: boolean;
  reason?: string;
  /** Short phrase for the pilot's "unable". */
  pilot?: string;
}

export function turnAroundCheck(ctx: SimContext, ac: Aircraft): TurnAroundCheck {
  if (!ac.onGround) return { ok: false, reason: `${ac.callsign} is airborne.`, pilot: "we're airborne" };
  if (ac.occupyingRunways.length > 0 || ac.phase === 'ROLLOUT' || ac.phase === 'LANDING' || ac.phase === 'TAKEOFF_ROLL' || ac.phase === 'CLEARED_FOR_TAKEOFF' || ac.phase === 'LINE_UP_AND_WAIT') {
    return { ok: false, reason: `${ac.callsign} is on a runway: a one eighty applies to an aircraft on a taxiway.`, pilot: "we're on the runway" };
  }
  if (ac.phase === 'PARKED' || ac.phase === 'ARRIVED' || ac.phase === 'PUSHBACK' || ac.phase === 'READY') {
    return { ok: false, reason: `${ac.callsign} is at its stand.`, pilot: "we're on the stand" };
  }
  if (perfOf(ac).category === 'light') return { ok: true };
  const graph = ctx.state.airport.taxiwayGraph;
  for (const n of Object.values(graph.nodes)) {
    if ((n.kind === 'apron' || n.kind === 'parking') && dist(n.pos, ac.pos) <= APRON_ROOM_M) return { ok: true };
  }
  return { ok: false, reason: `There is no room for a ${ac.type} to turn around here: it needs an apron within ${APRON_ROOM_M} m.`, pilot: "there isn't room to turn around here" };
}
