/**
 * An aircraft standing on a runway that cannot leave it by itself: a landing that found no exit it could make, or a rejected takeoff
 * (JO 7110.65 3-9-11). The controller can still move it: it taxis along the runway to a turnoff (and across an intersecting runway with a
 * crossing clearance, 3-7-2 / 3-1-3). These helpers find where it stands in the runway node chain and which turnoffs lie ahead.
 */
import type { Aircraft, TaxiNode } from './types';
import type { SimContext } from './context';
import { getRuntime } from './context';
import { dist, headingDiff } from './geo';
import { alongCross, findRunway, findRunwayEnd } from './runways';
import type { RunwayEndGeom } from './runways';
import { findTaxiRoute } from './pathfinding';
import { closedTaxiways } from './airportOps';
import { runwayExits } from './flightDynamics';

/** Stopped, on a runway surface, in a phase where the pilot has no taxi route of his own. */
export function stoppedOnRunway(ctx: SimContext, ac: Aircraft): boolean {
  if (!ac.onGround || ac.groundSpeedKt >= 1 || !ac.occupyingRunways.length) return false;
  const rt = getRuntime(ctx, ac);
  if (rt.aborting) return false;
  if (ac.phase === 'RUNWAY_EXIT' || ac.phase === 'ROLLOUT') return !ac.route || ac.route.progressIndex >= ac.route.nodeIds.length;
  if (ac.phase === 'LINE_UP_AND_WAIT') return !rt.lineUp || rt.lineUp.aligned;
  return false;
}

/** The end of the occupied runway in the direction the aircraft faces. */
export function runwayEndAhead(ctx: SimContext, ac: Aircraft): RunwayEndGeom | undefined {
  const airport = ctx.state.airport;
  const rw = findRunway(airport, ac.occupyingRunways[0]) ?? findRunway(airport, ac.assignedRunwayEnd);
  if (!rw) return undefined;
  const ends = rw.ends.map((e) => findRunwayEnd(airport, e.id)).filter((g): g is RunwayEndGeom => !!g);
  return ends.sort((a, b) => Math.abs(headingDiff(a.headingDeg, ac.headingDeg)) - Math.abs(headingDiff(b.headingDeg, ac.headingDeg)))[0];
}

const onRunway = (n: TaxiNode, rid: string): boolean => n.kind === 'runway' && (n.runwayId === rid || !!n.runwayIds?.includes(rid));

/** Where the aircraft stands in the chain of runway nodes: on a node, or between the node ahead of it and the node behind it. */
export function runwayChainPosition(ctx: SimContext, ac: Aircraft): { at?: TaxiNode; ahead?: TaxiNode; behind?: TaxiNode; g: RunwayEndGeom } | undefined {
  const g = runwayEndAhead(ctx, ac);
  if (!g) return undefined;
  const graph = ctx.state.airport.taxiwayGraph;
  const here = alongCross(g, ac.pos).along;
  const nodes = Object.values(graph.nodes).filter((n) => onRunway(n, g.runway.id) && Math.abs(alongCross(g, n.pos).cross) < 8);
  const at = nodes.find((n) => dist(n.pos, ac.pos) < 2);
  let ahead: TaxiNode | undefined;
  let behind: TaxiNode | undefined;
  let aheadAlong = Infinity;
  let behindAlong = -Infinity;
  for (const n of nodes) {
    const a = alongCross(g, n.pos).along;
    if (a > here + 2 && a < aheadAlong) { ahead = n; aheadAlong = a; }
    if (a < here - 2 && a > behindAlong) { behind = n; behindAlong = a; }
  }
  return { at, ahead, behind, g };
}

/** A turnoff ahead of a stopped aircraft and the taxi route to its hold line. */
export interface StoppedExit {
  exitNodeId: string;
  holdNodeId: string;
  /** Taxiway the aircraft leaves on (the name the controller uses). */
  taxiway: string;
  /** Side of the turnoff relative to the aircraft's heading. */
  side: 'left' | 'right';
  /** Nodes from the aircraft's start node (the node at or ahead of it) through the exit node to the hold line. */
  nodeIds: string[];
  /** Intersecting runways whose surface the route crosses on the way (they need a crossing clearance). */
  crosses: string[];
  /** Distance ahead along the runway (m) to the exit node. */
  aheadM: number;
}

/** The turnoffs ahead of a stopped aircraft, nearest first (closed taxiways excluded). */
export function stoppedExitOptions(ctx: SimContext, ac: Aircraft): StoppedExit[] {
  const pos = runwayChainPosition(ctx, ac);
  if (!pos) return [];
  const { g } = pos;
  const start = pos.ahead ?? pos.at;
  if (!start) return [];
  const graph = ctx.state.airport.taxiwayGraph;
  const closed = closedTaxiways(ctx.state);
  const here = alongCross(g, ac.pos).along;
  const out: StoppedExit[] = [];
  for (const row of runwayExits(ctx, g, true)) {
    if (row.along < here - 2) continue;
    for (const h of row.holds) {
      if (h.taxiways.some((t) => closed.has(t.toUpperCase()))) continue;
      const r = findTaxiRoute(graph, start.id, h.id, { avoidRunways: true, allowedRunwayIds: [g.runway.id], runwayTravelIds: [g.runway.id], avoidTaxiways: closed });
      if (!r.route) continue;
      const crosses = [...new Set(r.route.nodeIds.flatMap((id) => {
        const n = graph.nodes[id];
        return n.kind === 'runway' ? (n.runwayIds ?? (n.runwayId ? [n.runwayId] : [])).filter((x) => x !== g.runway.id) : [];
      }))];
      // the side seen from the aircraft: the data's side is relative to the landing direction g, the aircraft faces the same way
      out.push({ exitNodeId: row.id, holdNodeId: h.id, taxiway: h.taxiways[0] ?? row.taxiways[0] ?? '', side: h.side, nodeIds: r.route.nodeIds, crosses, aheadM: Math.max(0, row.along - here) });
    }
  }
  return out.sort((a, b) => a.aheadM - b.aheadM || (a.holdNodeId < b.holdNodeId ? -1 : 1));
}

/** `stoppedExitOptions` for callers that hold only the simulation state (the AI controllers). */
export function stoppedExitOptionsFor(state: SimContext['state'], ac: Aircraft): StoppedExit[] {
  return stoppedExitOptions({ state } as SimContext, ac);
}
