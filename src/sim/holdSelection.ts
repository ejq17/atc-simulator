/**
 * Which holding position a "taxi to runway N [via ...]" instruction leads to.
 *
 * Full length by default: JO 7110.65 3-7-2 and AIM 4-3-10 treat an intersection departure as something the pilot requests or
 * the controller offers, never the default. So without a route the hold with the most runway remaining wins (ties within
 * `SAME_LENGTH_M`: the shorter taxi); when the route's last taxiway leads to a hold, that hold is the one meant ("runway 31 via
 * bravo" ends at bravo's hold, "via hotel" is an intersection departure at hotel). Shared by the engine's taxi planner and the
 * AI Ground controller so both pick the same hold.
 */
import type { Aircraft, Airport, TaxiNode } from './types';
import { findTaxiRoute } from './pathfinding';
import type { TaxiRoute } from './pathfinding';
import { alongCross, normalizeRunwayEndId } from './runways';
import type { RunwayEndGeom } from './runways';
import { ftToM } from './geo';
import { getPerformance } from './performance';

export interface PickedHold {
  hold: TaxiNode;
  route: TaxiRoute;
  /** Runway remaining (m) from the hold's position along the runway. */
  remainingM: number;
}

/** Holds whose remaining runway differs by less than this are "the same length": the shorter taxi wins. */
const SAME_LENGTH_M = 30;

/** Runway length (m) remaining from a point beside the runway (the hold line) to the far end. */
export function runwayRemainingM(g: RunwayEndGeom, node: Pick<TaxiNode, 'pos'>): number {
  return g.lengthM - Math.max(0, alongCross(g, node.pos).along);
}

/** Takeoff distance (m) the aircraft's type needs. */
export function takeoffRunM(ac: Pick<Aircraft, 'type'>): number {
  return ftToM(getPerformance(ac.type).takeoffDistanceFt);
}

/** The hold has too little runway ahead of it for this aircraft's takeoff. */
export function holdTooShort(g: RunwayEndGeom, node: Pick<TaxiNode, 'pos'>, ac: Pick<Aircraft, 'type'>): boolean {
  return runwayRemainingM(g, node) < takeoffRunM(ac);
}

/** Holding positions that can serve a departure from `g`; `lastVia` narrows them to the holds on that taxiway. */
export function runwayHoldCandidates(airport: Airport, g: RunwayEndGeom, lastVia?: string): TaxiNode[] {
  const holds = Object.values(airport.taxiwayGraph.nodes).filter((n) => n.kind === 'holding_position' && n.runwayId === g.runway.id);
  const explicit = holds.filter((h) => h.protectsRunwayEnd && normalizeRunwayEndId(h.protectsRunwayEnd) === normalizeRunwayEndId(g.end.id));
  const implicit = holds.filter((h) => !h.protectsRunwayEnd);
  const cands = explicit.length ? explicit : implicit;
  if (lastVia) {
    const v = lastVia.toUpperCase();
    const m = [...explicit, ...implicit].filter((h) => h.taxiways.some((t) => t.toUpperCase() === v));
    if (m.length) return m;
  }
  return cands;
}

/**
 * The hold a taxi instruction to runway end `g` via `via` leads to, with its route from `startId`. `reason` explains a failure
 * (no hold, or no route that follows the taxiways in that order).
 */
export function pickRunwayHold(airport: Airport, startId: string, g: RunwayEndGeom, via: string[] = []): { pick?: PickedHold; reason?: string } {
  const graph = airport.taxiwayGraph;
  const cands = runwayHoldCandidates(airport, g, via[via.length - 1]);
  if (!cands.length) return { reason: `No holding position serves runway ${g.end.id}` };
  const allowedRunwayIds = airport.runways.map((r) => r.id);
  let best: PickedHold | undefined;
  let reason = '';
  for (const h of cands) {
    const res = findTaxiRoute(graph, startId, h.id, { via, avoidRunways: true, allowedRunwayIds });
    if (!res.route) {
      if (!reason) reason = res.reason ?? '';
      continue;
    }
    const c: PickedHold = { hold: h, route: res.route, remainingM: runwayRemainingM(g, h) };
    const longer = !best || c.remainingM > best.remainingM + SAME_LENGTH_M;
    const sameButShorter = !!best && Math.abs(c.remainingM - best.remainingM) <= SAME_LENGTH_M && c.route.lengthM < best.route.lengthM;
    if (longer || sameButShorter) best = c;
  }
  return best ? { pick: best } : { reason };
}
