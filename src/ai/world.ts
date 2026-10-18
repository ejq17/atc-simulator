/**
 * Read-only world queries for the AI controllers: runway geometry, ETAs, taxi route planning.
 * Nothing here mutates the simulation. Taxi planning mirrors `commandExecutor.planTaxi` so that the route the AI
 * announces is the route the engine will compute for the same command.
 */
import type { Aircraft, Airport, ParkingPosition, SimulationState, TaxiNode } from '../sim/types';
import { dist, ftToM, mToNm } from '../sim/geo';
import { alongCross, crossingRunways, findRunwayEnd, normalizeRunwayEndId } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { findTaxiRoute, nearestNode, shortestDistances } from '../sim/pathfinding';
import type { TaxiRoute } from '../sim/pathfinding';
import { freeParkingCandidates } from '../sim/parkingResolver';
import { getPerformance } from '../sim/performance';
import { pickRunwayHold } from '../sim/holdSelection';
import { closedTaxiways } from '../sim/airportOps';
import { runwayEntryNodes } from '../airport/graphUtils';

// ---------------------------------------------------------------------------------------------------------------------
// Arrivals
// ---------------------------------------------------------------------------------------------------------------------

/** Straight-line distance to the threshold of the aircraft's assigned runway end, nm. */
export function distToThresholdNm(ac: Aircraft, g: RunwayEndGeom): number {
  return mToNm(dist(ac.pos, g.end.threshold));
}

/** Seconds to the threshold at the current ground speed (floor 60 kt so a slow aircraft is not "infinitely far"). */
export function etaToThresholdSec(ac: Aircraft, g: RunwayEndGeom): number {
  const kt = Math.max(ac.groundSpeedKt, 60);
  return (distToThresholdNm(ac, g) / kt) * 3600;
}

/**
 * Speed (kt) an inbound aircraft will hold toward the threshold: its ground speed, or the speed restriction it is already slowing to
 * (or `assignedKt`, the restriction the controller is about to give), never below the approach speed unless it is already slower.
 */
export function inboundSpeedKt(ac: Aircraft, assignedKt?: number): number {
  const vApp = getPerformance(ac.type).approachSpeedKt;
  const cap = assignedKt ?? ac.target.speedKt ?? ac.groundSpeedKt;
  return Math.max(Math.min(ac.groundSpeedKt, cap), Math.min(ac.groundSpeedKt, vApp), 1);
}

export interface ProjectedGap {
  /** In-trail distance between the two now, nm (follower's distance to the threshold minus the leader's). */
  nowNm: number;
  /** Follower's distance to the threshold when the leader crosses it, nm: the in-trail gap at the leader's threshold crossing. */
  atLeaderThresholdNm: number;
  /** Smaller of the two (the gap is linear in between, so this is its minimum until the leader's threshold). */
  minNm: number;
}

/**
 * The gap between a follower and the arrival ahead of it on the same final, projected to the moment the leader crosses the threshold
 * (the leader's ETA from `etaToThresholdSec`, the follower flying on at `inboundSpeedKt`). A fast jet behind a slow single closes at
 * about a mile a minute: the gap that exists at the approach clearance is not the gap that matters.
 */
export function projectedGapNm(follower: Aircraft, leader: Aircraft, g: RunwayEndGeom, assignedKt?: number): ProjectedGap {
  const dF = distToThresholdNm(follower, g);
  const nowNm = dF - distToThresholdNm(leader, g);
  const tL = etaToThresholdSec(leader, g);
  const atLeaderThresholdNm = dF - (inboundSpeedKt(follower, assignedKt) * tL) / 3600;
  return { nowNm, atLeaderThresholdNm, minNm: Math.min(nowNm, atLeaderThresholdNm) };
}

/** Airborne arrival that has not landed (and is not already on a missed approach). */
export function isInboundArrival(ac: Aircraft): boolean {
  return !ac.isDeparture && !ac.onGround && ['INBOUND', 'APPROACH', 'FINAL', 'LANDING', 'PATTERN'].includes(ac.phase);
}

export function assignedEnd(airport: Airport, ac: Aircraft): RunwayEndGeom | undefined {
  return findRunwayEnd(airport, ac.assignedRunwayEnd);
}

/** The runway ids (13/31...) an operation on `runwayId` interacts with: itself and every runway that intersects it. */
export function interactingRunways(airport: Airport, runwayId: string): string[] {
  return [runwayId, ...crossingRunways(airport, runwayId).map((r) => r.id)];
}

// ---------------------------------------------------------------------------------------------------------------------
// Taxi planning
// ---------------------------------------------------------------------------------------------------------------------

const allRunwayIds = (airport: Airport): string[] => airport.runways.map((r) => r.id);

/** Where the engine will start the route (`commandExecutor.currentStartNode`, without its private stop-node memory). */
export function taxiStartNode(airport: Airport, ac: Aircraft): TaxiNode | undefined {
  const graph = airport.taxiwayGraph;
  const near = nearestNode(graph, ac.pos, { maxDistM: 2 });
  if (near) return near;
  if (ac.route && ac.route.progressIndex < ac.route.nodeIds.length) return graph.nodes[ac.route.nodeIds[ac.route.progressIndex]];
  return nearestNode(graph, ac.pos, { maxDistM: 150 });
}

/** Spoken-name taxiways of a route: named only, repeated names collapsed to their LAST use ([L N L M L M P B] -> [N L M P B]). */
export function namedTaxiways(taxiways: string[]): string[] {
  const named = taxiways.filter((t) => t && !/^RWY/i.test(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = named.length - 1; i >= 0; i--) {
    if (seen.has(named[i])) continue;
    seen.add(named[i]);
    out.unshift(named[i]);
  }
  return out;
}

/** Candidate `via` lists, most descriptive first, ending with "no via". */
function viaCandidates(taxiways: string[], allowEmpty = true): string[][] {
  const full = namedTaxiways(taxiways);
  const out: string[][] = [full];
  for (const n of [4, 3, 2, 1]) if (full.length > n) out.push(full.slice(-n));
  // A taxi to an assigned runway always names its route (JO 7110.65 3-7-2): "no via" only when the route has no named taxiway at all.
  if (allowEmpty || !full.length) out.push([]);
  return out;
}

interface PickedHold {
  hold: TaxiNode;
  route: TaxiRoute;
}

/** The target selection of `commandExecutor.planTaxi` for a "taxi to runway <end> via ..." instruction (full length by default). */
export function simulateRunwayTaxiPick(airport: Airport, startId: string, end: RunwayEndGeom, via: string[], closed?: ReadonlySet<string>): PickedHold | undefined {
  const r = pickRunwayHold(airport, startId, end, via, closed);
  return r.pick ? { hold: r.pick.hold, route: r.pick.route } : undefined;
}

export interface DeparturePlan {
  runwayEnd: string;
  via: string[];
  holdShort: string[];
  holdId: string;
  lengthM: number;
  /** Remaining runway length (m) from the chosen hold. */
  remainingM: number;
  nodeIds: string[];
}

/**
 * Route a departure to the full-length entry of the first active departure runway that is long enough for its type:
 * the hold nearest the threshold (`runwayEntryNodes`), a `via` list for which the engine's own target selection picks that
 * hold, and a hold-short for every runway the route crosses, in order.
 */
export function planDeparture(airport: Airport, ac: Aircraft, ends: string[], busyHolds: ReadonlyMap<string, number> = new Map(), closed?: ReadonlySet<string>): DeparturePlan | undefined {
  const graph = airport.taxiwayGraph;
  const start = taxiStartNode(airport, ac);
  if (!start) return undefined;
  const need = ftToM(getPerformance(ac.type).takeoffDistanceFt) + 50;
  let fallback: DeparturePlan | undefined;
  let queued: { plan: DeparturePlan; n: number } | undefined;
  for (const endId of ends) {
    const g = findRunwayEnd(airport, endId);
    if (!g) continue;
    const entries = runwayEntryNodes(airport, g.end.id).filter((h) => !h.protectsRunwayEnd || normalizeRunwayEndId(h.protectsRunwayEnd) === normalizeRunwayEndId(g.end.id));
    for (const h of entries) {
      const remaining = g.lengthM - alongCross(g, h.pos).along;
      const r0 = findTaxiRoute(graph, start.id, h.id, { avoidRunways: true, allowedRunwayIds: allRunwayIds(airport), avoidTaxiways: closed });
      if (!r0.route) continue;
      for (const via of viaCandidates(r0.route.taxiways, false)) {
        const pick = simulateRunwayTaxiPick(airport, start.id, g, via, closed);
        if (!pick) continue;
        const pickedRemaining = g.lengthM - alongCross(g, pick.hold.pos).along;
        const plan: DeparturePlan = {
          runwayEnd: g.end.id, via, holdShort: pick.route.runwayCrossings.filter((r) => r !== g.runway.id), holdId: pick.hold.id, lengthM: pick.route.lengthM, remainingM: pickedRemaining, nodeIds: pick.route.nodeIds,
        };
        if (pickedRemaining < need) continue;
        const n = busyHolds.get(pick.hold.id) ?? 0;
        // An unoccupied full-length entry wins; otherwise the least crowded one (aircraft queue behind each other, at most three deep).
        if (pick.hold.id === h.id && remaining >= need && n === 0) return plan;
        if (n < MAX_QUEUE && (!queued || n < queued.n)) queued = { plan, n };
        if (!fallback && n === 0) fallback = plan;
      }
    }
  }
  return fallback ?? queued?.plan;
}

/** Departures that may queue for one runway hold (the engine spaces them along the taxiway). */
const MAX_QUEUE = 3;

export interface ParkingPlan {
  spot: ParkingPosition;
  via: string[];
  holdShort: string[];
  lengthM: number;
  nodeIds: string[];
}

/** Nearest (by taxi distance) unoccupied parking position of the aircraft's natural category, with a described route. */
export function planParking(state: SimulationState, ac: Aircraft): ParkingPlan | undefined {
  const airport = state.airport;
  const graph = airport.taxiwayGraph;
  const start = taxiStartNode(airport, ac);
  if (!start) return undefined;
  const cands = freeParkingCandidates(state, ac, undefined, undefined).filter((p) => p.category !== 'military' || getPerformance(ac.type).category === 'light' || !!getPerformance(ac.type).military);
  if (!cands.length) return undefined;
  const closed = closedTaxiways(state);
  const dmap = shortestDistances(graph, start.id, { allowedRunwayIds: allRunwayIds(airport), avoidTaxiways: closed });
  let best: ParkingPosition | undefined;
  let bestD = Infinity;
  for (const p of cands) {
    const d = dmap.get(p.nodeId);
    if (d !== undefined && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (!best) return undefined;
  const r0 = findTaxiRoute(graph, start.id, best.nodeId, { avoidRunways: true, allowedRunwayIds: allRunwayIds(airport), avoidTaxiways: closed });
  if (!r0.route) return undefined;
  for (const via of viaCandidates(r0.route.taxiways)) {
    const r = findTaxiRoute(graph, start.id, best.nodeId, { via, avoidRunways: true, allowedRunwayIds: allRunwayIds(airport), avoidTaxiways: closed });
    if (r.route) return { spot: best, via, holdShort: r.route.runwayCrossings, lengthM: r.route.lengthM, nodeIds: r.route.nodeIds };
  }
  return undefined;
}

export interface ProgressiveSegment {
  /** Taxiways followed in this step, in order (usually one; short runs of changing designators on an apron are merged). */
  taxiways: string[];
  /** Side of the turn onto the first taxiway from the aircraft's heading (set only when the first leg of the route is on that taxiway and the step is that one taxiway). */
  turn?: 'left' | 'right';
  /** Taxiway to continue to; undefined when the step reaches the end of the route. */
  next?: string;
  /** Named taxiways (runs) left on the route including this step's. */
  remaining: number;
  /** Graph node where the step ends (the intersection with `next`, or the route's last node). */
  endNodeId: string;
}

/** A step is at least this long (m): shorter runs of taxiway designators (apron lanes change letters every few metres) are merged into it. */
const MIN_SEGMENT_M = 60;

/**
 * The next step of a progressive taxi (JO 7110.65 3-7-2, AIM 4-3-18) for a route of graph nodes from the aircraft's node: the first named
 * taxiway, which way to turn onto it, and the next taxiway to continue to.
 */
export function nextProgressiveSegment(airport: Airport, nodeIds: string[], headingDeg: number): ProgressiveSegment | undefined {
  const graph = airport.taxiwayGraph;
  const runs: { twy: string; firstEdge: number; lengthM: number }[] = [];
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    const e = graph.edges.find((x) => (x.from === nodeIds[i] && x.to === nodeIds[i + 1]) || (x.to === nodeIds[i] && x.from === nodeIds[i + 1]));
    const t = e?.taxiway ?? '';
    if (!t || /^RWY/i.test(t)) continue;
    if (!runs.length || runs[runs.length - 1].twy !== t) runs.push({ twy: t, firstEdge: i, lengthM: 0 });
    runs[runs.length - 1].lengthM += e!.lengthM;
  }
  if (!runs.length) return undefined;
  let k = 0;
  let len = runs[0].lengthM;
  while (len < MIN_SEGMENT_M && k + 1 < runs.length) len += runs[++k].lengthM;
  const first = runs[0];
  let turn: 'left' | 'right' | undefined;
  if (k === 0 && first.firstEdge === 0) {
    const a = graph.nodes[nodeIds[0]].pos;
    const b = graph.nodes[nodeIds[1]].pos;
    const d = ((((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI - headingDeg + 540) % 360) + 360) % 360 - 180; // signed turn, + right
    if (Math.abs(d) >= 20) turn = d > 0 ? 'right' : 'left';
  }
  const taxiways = runs.slice(0, k + 1).map((r) => r.twy).filter((t, i, a) => a.indexOf(t) === i);
  const endNodeId = runs[k + 1] ? nodeIds[runs[k + 1].firstEdge] : nodeIds[nodeIds.length - 1];
  return { taxiways, turn, next: runs[k + 1]?.twy, remaining: runs.length - k, endNodeId };
}

/** Remaining taxi distance (m) along the aircraft's current route, to its last node. */
export function remainingRouteM(airport: Airport, ac: Aircraft): number {
  const route = ac.route;
  if (!route) return 0;
  const graph = airport.taxiwayGraph;
  let d = 0;
  let prev = ac.pos;
  for (let i = route.progressIndex; i < route.nodeIds.length; i++) {
    const p = graph.nodes[route.nodeIds[i]].pos;
    d += dist(prev, p);
    prev = p;
  }
  return d;
}

/** Hold-position nodes on the route (from progress on) that the aircraft must still be cleared past, excluding the final node. */
export function pendingIntermediateStops(airport: Airport, ac: Aircraft): string[] {
  const route = ac.route;
  if (!route) return [];
  const last = route.nodeIds[route.nodeIds.length - 1];
  const graph = airport.taxiwayGraph;
  return route.stopAtNodeIds.filter((id) => {
    if (id === last) return false;
    const n = graph.nodes[id];
    if (!n) return false;
    const idx = route.nodeIds.indexOf(id);
    if (idx >= 0 && idx < route.progressIndex - 1) return false; // already passed
    return !(n.runwayId && ac.runwayAuthorizations.includes(n.runwayId));
  });
}

/** The runway hold node the (stopped) aircraft is standing at, if any. */
export function holdNodeAt(airport: Airport, ac: Aircraft): TaxiNode | undefined {
  const n = nearestNode(airport.taxiwayGraph, ac.pos, { kinds: ['holding_position'], maxDistM: 25 });
  return n && n.runwayId ? n : undefined;
}

/** Runway hold nodes that another departure is standing at, or is routed to. */
export function busyHoldIds(state: SimulationState, exceptId: string): Map<string, number> {
  const graph = state.airport.taxiwayGraph;
  const out = new Map<string, number>();
  const bump = (id: string) => out.set(id, (out.get(id) ?? 0) + 1);
  for (const o of Object.values(state.aircraft)) {
    if (o.id === exceptId || !o.onGround || !o.isDeparture) continue;
    if (o.phase !== 'TAXIING' && o.phase !== 'HOLDING_SHORT' && o.phase !== 'LINE_UP_AND_WAIT') continue;
    const last = o.route?.nodeIds[o.route.nodeIds.length - 1];
    const near = nearestNode(graph, o.pos, { kinds: ['holding_position'], maxDistM: 60 });
    if (last && graph.nodes[last]?.kind === 'holding_position') bump(last);
    else if (near) bump(near.id);
  }
  return out;
}

/**
 * Another aircraft is taxiing along part of `nodeIds` in the OPPOSITE direction (a head-on meeting the engine's ground spacing cannot
 * resolve) or is standing still on it. Aircraft in parking positions do not count.
 */
export function opposingTraffic(state: SimulationState, nodeIds: string[], exceptId: string): Aircraft | undefined {
  const graph = state.airport.taxiwayGraph;
  const mine = new Map<string, number>();
  nodeIds.forEach((id, i) => mine.set(id, i));
  for (const o of Object.values(state.aircraft)) {
    if (o.id === exceptId || !o.onGround || !o.route) continue;
    if (o.phase === 'PARKED' || o.phase === 'ARRIVED') continue;
    const rest = o.route.nodeIds.slice(Math.max(0, o.route.progressIndex - 1));
    let prevMine = -1;
    let prevTheirs = -1;
    for (let j = 0; j < rest.length; j++) {
      const k = mine.get(rest[j]);
      if (k === undefined || graph.nodes[rest[j]]?.kind === 'parking') continue;
      if (prevMine >= 0 && k < prevMine && j > prevTheirs) return o; // they pass the shared nodes in the reverse order
      prevMine = k;
      prevTheirs = j;
    }
  }
  return undefined;
}
