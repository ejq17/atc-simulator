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
import { assignedStandOf, freeParkingCandidates } from '../sim/parkingResolver';
import { getPerformance } from '../sim/performance';
import { pickRunwayHold } from '../sim/holdSelection';
import { closedTaxiways } from '../sim/airportOps';
import { runwayEntryNodes } from '../airport/graphUtils';
import { landerStubOnRoute } from '../sim/exitStubs';
import { reversedRuns, pathOf } from '../sim/headOn';
import { runwayExits } from '../sim/flightDynamics';
import type { SimContext } from '../sim/context';
import type { Path } from '../sim/headOn';
import { isRotorcraftType, isVehicleType } from '../sim/performance';

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
  const strict = planDepartureOnce(airport, ac, ends, busyHolds, closed);
  if (strict || ![...busyHolds.values()].some((n) => n >= MAX_QUEUE + AVOID_EXTRA)) return strict;
  // Every other entry is full: the exit holds are used after all (the queue is not allowed to grow without limit at the runway end).
  const relaxed = new Map<string, number>();
  for (const [id, n] of busyHolds) relaxed.set(id, n >= MAX_QUEUE + AVOID_EXTRA ? n - AVOID_EXTRA - 1 : n);
  return planDepartureOnce(airport, ac, ends, relaxed, closed);
}

const AVOID_EXTRA = 100;

function planDepartureOnce(airport: Airport, ac: Aircraft, ends: string[], busyHolds: ReadonlyMap<string, number>, closed?: ReadonlySet<string>): DeparturePlan | undefined {
  const start = taxiStartNode(airport, ac);
  if (!start) return undefined;
  const need = ftToM(getPerformance(ac.type).takeoffDistanceFt) + 50;
  let fallback: DeparturePlan | undefined;
  let queued: { plan: DeparturePlan; n: number } | undefined;
  for (const { plan, fullEntry } of departureCandidates(airport, start.id, ends, need, closed)) {
    const n = busyHolds.get(plan.holdId) ?? 0;
    // An unoccupied full-length entry wins; otherwise the least crowded one (aircraft queue behind each other, at most three deep).
    if (fullEntry && n === 0) return plan;
    if (n < MAX_QUEUE && (!queued || n < queued.n)) queued = { plan, n };
    if (!fallback && n === 0) fallback = plan;
  }
  return fallback ?? queued?.plan;
}

interface DepartureCandidate {
  plan: DeparturePlan;
  /** The picked hold is the entry node itself and leaves the type its full takeoff distance. */
  fullEntry: boolean;
}

/**
 * Every (runway end, entry hold, via list) route from `startId` that leaves `needM` of runway, in the order `planDeparture` tries them.
 * Pure in the static airport data, the start node, the runway ends, the distance and the closed taxiways, and a taxi route search costs
 * milliseconds (several hundred searches per call), so it is cached: a Ground controller with an aircraft that cannot be released yet asks
 * every second, and in a 2 h free-play soak that was 85 % of the run time (docs/PROGRESS.md, "Free-play jam").
 */
const departureCandidateCache = new WeakMap<Airport, Map<string, DepartureCandidate[]>>();

function departureCandidates(airport: Airport, startId: string, ends: string[], needM: number, closed?: ReadonlySet<string>): DepartureCandidate[] {
  let byKey = departureCandidateCache.get(airport);
  if (!byKey) departureCandidateCache.set(airport, (byKey = new Map()));
  const key = `${startId}|${ends.join(',')}|${Math.round(needM)}|${closed ? [...closed].sort().join(',') : ''}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const graph = airport.taxiwayGraph;
  const out: DepartureCandidate[] = [];
  for (const endId of ends) {
    const g = findRunwayEnd(airport, endId);
    if (!g) continue;
    const entries = runwayEntryNodes(airport, g.end.id).filter((h) => !h.protectsRunwayEnd || normalizeRunwayEndId(h.protectsRunwayEnd) === normalizeRunwayEndId(g.end.id));
    for (const h of entries) {
      const remaining = g.lengthM - alongCross(g, h.pos).along;
      const r0 = findTaxiRoute(graph, startId, h.id, { avoidRunways: true, allowedRunwayIds: allRunwayIds(airport), avoidTaxiways: closed });
      if (!r0.route) continue;
      for (const via of viaCandidates(r0.route.taxiways, false)) {
        const pick = simulateRunwayTaxiPick(airport, startId, g, via, closed);
        if (!pick) continue;
        const pickedRemaining = g.lengthM - alongCross(g, pick.hold.pos).along;
        if (pickedRemaining < needM) continue;
        out.push({
          fullEntry: pick.hold.id === h.id && remaining >= needM,
          plan: { runwayEnd: g.end.id, via, holdShort: pick.route.runwayCrossings.filter((r) => r !== g.runway.id), holdId: pick.hold.id, lengthM: pick.route.lengthM, remainingM: pickedRemaining, nodeIds: pick.route.nodeIds },
        });
      }
    }
  }
  byKey.set(key, out);
  return out;
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
  const start = taxiStartNode(airport, ac);
  if (!start) return undefined;
  const bound = assignedStandOf(state, ac);
  const perf = getPerformance(ac.type);
  const military = (p: ParkingPosition) => p.category !== 'military' || perf.category === 'light' || !!perf.military;
  const zone = ac.parkingIntent === 'military' ? (ac.type === 'H65' ? 'USCG-' : 'ANG-') : undefined;
  // The stand the arrival is bound for (assigned in the engine), else the nearest free one of its category; any free stand when those are unreachable.
  const lists = [bound ? [bound] : [], freeParkingCandidates(state, ac, ac.parkingIntent, undefined, zone).filter(military), freeParkingCandidates(state, ac, undefined, undefined).filter(military)];
  if (!lists.some((l) => l.length)) return undefined;
  const closed = closedTaxiways(state);
  const { dmap, routeTo } = parkingRouting(airport, start.id, closed);
  let best: ParkingPosition | undefined;
  for (const cands of lists) {
    let bestD = Infinity;
    for (const p of cands) {
      const d = dmap.get(p.nodeId);
      if (d !== undefined && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (best) break;
  }
  if (!best) return undefined;
  const r = routeTo(best.nodeId);
  return r ? { spot: best, via: r.via, holdShort: r.holdShort, lengthM: r.lengthM, nodeIds: r.nodeIds } : undefined;
}

interface ParkingRoute {
  via: string[];
  holdShort: string[];
  lengthM: number;
  nodeIds: string[];
}

/**
 * Taxi distances from a start node and, per parking node, the described route there. Static airport data plus the closed taxiways, so cached: an
 * arrival that cannot be sent yet is asked about every second (docs/PROGRESS.md, "Free-play jam").
 */
const parkingRoutingCache = new WeakMap<Airport, Map<string, { dmap: Map<string, number>; routes: Map<string, ParkingRoute | null> }>>();

function parkingRouting(airport: Airport, startId: string, closed: ReadonlySet<string>): { dmap: Map<string, number>; routeTo(nodeId: string): ParkingRoute | undefined } {
  let byKey = parkingRoutingCache.get(airport);
  if (!byKey) parkingRoutingCache.set(airport, (byKey = new Map()));
  const key = `${startId}|${[...closed].sort().join(',')}`;
  let entry = byKey.get(key);
  if (!entry) {
    entry = { dmap: shortestDistances(airport.taxiwayGraph, startId, { allowedRunwayIds: allRunwayIds(airport), avoidTaxiways: closed }), routes: new Map() };
    byKey.set(key, entry);
  }
  const e = entry;
  return {
    dmap: e.dmap,
    routeTo(nodeId) {
      let r = e.routes.get(nodeId);
      if (r === undefined) {
        const graph = airport.taxiwayGraph;
        r = null;
        const r0 = findTaxiRoute(graph, startId, nodeId, { avoidRunways: true, allowedRunwayIds: allRunwayIds(airport), avoidTaxiways: closed });
        if (r0.route) {
          for (const via of viaCandidates(r0.route.taxiways)) {
            const rr = findTaxiRoute(graph, startId, nodeId, { via, avoidRunways: true, allowedRunwayIds: allRunwayIds(airport), avoidTaxiways: closed });
            if (rr.route) {
              r = { via, holdShort: rr.route.runwayCrossings, lengthM: rr.route.lengthM, nodeIds: rr.route.nodeIds };
              break;
            }
          }
        }
        e.routes.set(nodeId, r);
      }
      return r ?? undefined;
    },
  };
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

/**
 * The runway hold node the (stopped) aircraft is standing at, if any. `maxDistM` is 25 m by default; a taxi that starts at a hold line the
 * aircraft already passed (`HOLD_START_SNAP_M` in the engine) is "at" that hold from up to that far.
 */
export function holdNodeAt(airport: Airport, ac: Aircraft, maxDistM = 25): TaxiNode | undefined {
  const n = nearestNode(airport.taxiwayGraph, ac.pos, { kinds: ['holding_position'], maxDistM });
  return n && n.runwayId ? n : undefined;
}

/**
 * Hold lines of the exits the arrivals of the active landing runway use. A departure queue at one of them leaves an arrival that exits there nose to nose with
 * it (the single-line taxiway data has no room beside a hold line), so Ground sends departures to another entry when it has one (free-play soak: with the
 * exit choice preferring the parking side, the midfield Bravo hold of runway 4/22 was both the Cessnas' intersection entry and the arrivals' exit, and
 * neither could move). An exit nearer than `EXIT_AVOID_MIN_ALONG_M` to the threshold is not one the arrivals use.
 */
export const EXIT_AVOID_MIN_ALONG_M = 400;
const exitHoldCache = new WeakMap<Airport, Map<string, ReadonlySet<string>>>();
export function landingExitHoldIds(state: SimulationState): ReadonlySet<string> {
  const key = state.activeRunways.landing.join(',');
  let byKey = exitHoldCache.get(state.airport);
  if (!byKey) exitHoldCache.set(state.airport, (byKey = new Map()));
  let hit = byKey.get(key);
  if (!hit) {
    const out = new Set<string>();
    for (const endId of state.activeRunways.landing) {
      const g = findRunwayEnd(state.airport, endId);
      if (!g) continue;
      for (const ex of runwayExits({ state } as SimContext, g, false)) {
        if (ex.along - g.displacedM < EXIT_AVOID_MIN_ALONG_M) continue;
        for (const h of ex.holds) out.add(h.id);
      }
    }
    byKey.set(key, (hit = out));
  }
  return hit;
}

/** Runway hold nodes that another departure is standing at, or is routed to. */
export function busyHoldIds(state: SimulationState, exceptId: string): Map<string, number> {
  const graph = state.airport.taxiwayGraph;
  const out = new Map<string, number>();
  const bump = (id: string) => out.set(id, (out.get(id) ?? 0) + 1);
  // exit holds of the landing runway are not used by a light aircraft (the one type that takes an intersection entry) while another entry has room
  // (`planDeparture` relaxes this when none has). An airliner needs the runway end anyway.
  const mine = state.aircraft[exceptId];
  if (mine && getPerformance(mine.type).category === 'light') for (const id of landingExitHoldIds(state)) out.set(id, MAX_QUEUE + AVOID_EXTRA);
  for (const o of Object.values(state.aircraft)) {
    // An arrival standing at a runway hold line after its exit (waiting for taxi instructions) occupies that hold: a departure sent to it would end nose to
    // nose with the arrival, which cannot leave until the departure has gone by (free-play soak, docs/PROGRESS.md). Counted as a full queue.
    if (o.id !== exceptId && o.onGround && !o.isDeparture && o.phase === 'RUNWAY_EXIT') {
      const at = nearestNode(graph, o.pos, { kinds: ['holding_position'], maxDistM: 60 });
      if (at) { out.set(at.id, (out.get(at.id) ?? 0) + MAX_QUEUE); continue; }
    }
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
/** `p` lies within `LANE_WIDTH_M` of a segment of the node path and is not at a parking position (aircraft on their stand are not on the lane). */
const LANE_WIDTH_M = 12;
function onRoute(graph: SimulationState['airport']['taxiwayGraph'], nodeIds: string[], p: { x: number; y: number }, facingDeg?: number): boolean {
  for (let i = 1; i < nodeIds.length; i++) {
    const a = graph.nodes[nodeIds[i - 1]];
    const b = graph.nodes[nodeIds[i]];
    if (!a || !b || a.kind === 'parking' || b.kind === 'parking') continue;
    const dx = b.pos.x - a.pos.x;
    const dy = b.pos.y - a.pos.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.pos.x) * dx + (p.y - a.pos.y) * dy) / len2)) : 0;
    if (Math.hypot(p.x - (a.pos.x + dx * t), p.y - (a.pos.y + dy * t)) > LANE_WIDTH_M) continue;
    if (facingDeg === undefined) return true;
    const along = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (Math.abs(((facingDeg - along + 540) % 360) - 180) > 100) return true; // faces against the direction of the path
  }
  return false;
}

/** Bearing (deg) of the path segment `p` lies within `LANE_WIDTH_M` of, if any. */
function pathBearingAt(graph: SimulationState['airport']['taxiwayGraph'], nodeIds: string[], p: { x: number; y: number }): number | undefined {
  for (let i = 1; i < nodeIds.length; i++) {
    const a = graph.nodes[nodeIds[i - 1]];
    const b = graph.nodes[nodeIds[i]];
    if (!a || !b) continue;
    const dx = b.pos.x - a.pos.x;
    const dy = b.pos.y - a.pos.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.pos.x) * dx + (p.y - a.pos.y) * dy) / len2)) : 0;
    if (Math.hypot(p.x - (a.pos.x + dx * t), p.y - (a.pos.y + dy * t)) <= LANE_WIDTH_M) return (Math.atan2(dx, dy) * 180) / Math.PI;
  }
  return undefined;
}

export function opposingTraffic(state: SimulationState, nodeIds: string[], exceptId: string, opts: { ignoreStopped?: boolean } = {}): Aircraft | undefined {
  // The exit stub a lander inside 2 nm (or rolling out) is about to use is as good as occupied: a route over it ends head-on with the lander
  // (exitStubs.ts). AI Ground waits; the lander is returned as the blocker.
  const lander = landerStubOnRoute(state, nodeIds, exceptId);
  if (lander) return state.aircraft[lander.aircraftId];
  const graph = state.airport.taxiwayGraph;
  const mine = new Map<string, number>();
  nodeIds.forEach((id, i) => mine.set(id, i));
  for (const o of Object.values(state.aircraft)) {
    if (o.id === exceptId || !o.onGround) continue;
    // `ignoreStopped`: an aircraft that stands still on the route is no reason to wait when it is itself held up by this one (an arrival at the head of an exit stub
    // and a departure that stopped short of the stub because of it): the route is issued, the engine stops the pair nose to nose and the pilot's call is answered
    // (ai/headOn.ts) instead of both waiting for good.
    if (opts.ignoreStopped && o.groundSpeedKt < 1 && o.route) continue;
    if (!o.route) {
      // A pushed-back aircraft standing on the lane (READY / PUSHBACK, no route yet) blocks every route over its position just as a stopped one would:
      // an arrival sent past it would wait behind it while it waits for the arrival to clear (free-play soak, docs/PROGRESS.md "Free-play jam").
      if ((o.phase === 'READY' || o.phase === 'PUSHBACK') && onRoute(graph, nodeIds, o.pos)) return o;
      continue;
    }
    if (o.phase === 'PARKED' || o.phase === 'ARRIVED') continue;
    // An arrival that left the runway and waits for taxi instructions still carries its short exit route; it is not going anywhere on it.
    if (o.phase === 'RUNWAY_EXIT') continue;
    // Waiting at a runway hold line for a crossing: Ground does not release it while anything is on the far side of its route (ground.ts, crossing),
    // so what lies beyond the runway on its route is no reason to keep other traffic off the taxiways there.
    // The exception: it stands on this path and its way on points back along it (an exit stub: it waits to go east, the path goes west past it).
    if (o.groundSpeedKt < 1 && o.pendingRequest?.kind === 'CROSSING') {
      const mineBearing = pathBearingAt(graph, nodeIds, o.pos);
      const next = graph.nodes[o.route.nodeIds[o.route.progressIndex]];
      if (mineBearing !== undefined && next) {
        const theirs = (Math.atan2(next.pos.x - o.pos.x, next.pos.y - o.pos.y) * 180) / Math.PI;
        if (Math.abs(((theirs - mineBearing + 540) % 360) - 180) > 100) return o;
      }
      continue;
    }
    // Standing still at the end of a route that arrived over this path from the other side (a departure at the far hold line of a runway the path
    // crosses): the reverse-order test below needs two shared nodes and sees only one.
    if (o.groundSpeedKt < 1 && o.route.progressIndex >= 2) {
      const cur = mine.get(o.route.nodeIds[o.route.progressIndex - 1]);
      const prev = mine.get(o.route.nodeIds[o.route.progressIndex - 2]);
      if (cur !== undefined && prev !== undefined && prev > cur) return o;
    }
    const rest = o.route.nodeIds.slice(Math.max(0, o.route.progressIndex - 1));
    let prevMine = -1;
    let prevTheirs = -1;
    for (let j = 0; j < rest.length; j++) {
      const k = mine.get(rest[j]);
      if (k === undefined || graph.nodes[rest[j]]?.kind === 'parking') continue;
      if (prevMine >= 0 && k < prevMine && j > prevTheirs) {
        // They pass the shared nodes in the reverse order. Time-based: the two only meet if both are on the shared stretch in the same minutes
        // (a lane the other aircraft clears long before this one reaches it is no obstacle; the engine's head-on logic is the backstop).
        return sharedLaneInSameWindow(state, nodeIds, o) ? o : undefined;
      }
      prevMine = k;
      prevTheirs = j;
    }
  }
  return plannedOpposingTraffic(state, nodeIds, exceptId);
}

/** Design taxi speed (m/s) for the time-based lane check: 13 kt, the taxilane limit and about the cruise speed of the slower types. */
export const LANE_PLAN_SPEED_MPS = 6.7;
/** Two aircraft whose windows on a shared stretch come this close (s) count as meeting there. DESIGN VALUE. */
export const LANE_WINDOW_MARGIN_SEC = 15;

/** Do this route (starting where the aircraft is, at t = 0) and `o`'s remaining route use some stretch they traverse in opposite directions at overlapping times? Shared-node-only meetings (no common edge) count as meeting. */
function sharedLaneInSameWindow(state: SimulationState, nodeIds: string[], o: Aircraft): boolean {
  const graph = state.airport.taxiwayGraph;
  const theirs = pathOf(graph, o);
  if (!theirs) return true;
  const cum: number[] = [0];
  for (let i = 1; i < nodeIds.length; i++) cum.push(cum[i - 1] + dist(graph.nodes[nodeIds[i - 1]].pos, graph.nodes[nodeIds[i]].pos));
  const runs = reversedRuns(graph, nodeIds, theirs);
  if (!runs.length) return true; // not a shared edge: keep the node-order verdict
  const stopped = o.groundSpeedKt < 1;
  for (const r of runs) {
    const tMa = cum[r.k0] / LANE_PLAN_SPEED_MPS;
    const tMc = cum[r.kEnd + 1] / LANE_PLAN_SPEED_MPS;
    const tTc = stopped ? 0 : Math.max(0, theirs.cum[r.jEnd]) / LANE_PLAN_SPEED_MPS;
    const tTa = stopped ? Infinity : Math.max(0, theirs.cum[r.j0 + 1]) / LANE_PLAN_SPEED_MPS;
    if (tMa <= tTa + LANE_WINDOW_MARGIN_SEC && tTc <= tMc + LANE_WINDOW_MARGIN_SEC) return true;
  }
  return false;
}

/**
 * A departure that has waited longer than this (s) since it first called is in a hurry: it outranks every arrival waiting to taxi in for the lanes,
 * and its pushback is no longer held for taxiing traffic (ground.ts). DESIGN VALUE: 8 minutes. Not an FAA figure; the free-play soak showed
 * airline departures held 40 to 100 minutes while arrivals kept using the same single-width lanes (docs/PROGRESS.md).
 */
export const DEPARTURE_WAIT_BOUND_SEC = 480;

/** When the aircraft started waiting for Ground: a departure since it was created (its first call follows within a minute), an arrival since its request. */
export function waitStartSec(o: Aircraft): number {
  return o.isDeparture ? o.spawnedAtSec : (o.pendingRequest?.sinceSec ?? o.spawnedAtSec);
}

/** Waiting longer than `DEPARTURE_WAIT_BOUND_SEC` (a departure for its pushback / taxi clearance, an arrival for its taxi instructions). */
export function overdue(state: SimulationState, o: Aircraft): boolean {
  if (!o.onGround) return false;
  const waiting = o.isDeparture ? !o.route && (o.phase === 'PARKED' || o.phase === 'READY' || o.phase === 'PUSHBACK') : o.phase === 'RUNWAY_EXIT' && o.pendingRequest?.kind === 'TAXI';
  return waiting && state.clock.timeSec - waitStartSec(o) > DEPARTURE_WAIT_BOUND_SEC;
}

/** A departure that has waited longer than `DEPARTURE_WAIT_BOUND_SEC`. */
export function starvingDeparture(state: SimulationState, o: Aircraft): boolean {
  return o.isDeparture && overdue(state, o);
}

/**
 * Does `a` go before `b` for the lanes? Only an overdue aircraft outranks another one: a departure that waited past the bound before any arrival
 * that is not overdue yet (and an arrival that waited past it before a departure that is not), then the one that has waited longer (the lower id on a tie).
 */
export function outranks(state: SimulationState, a: Aircraft, b: Aircraft): boolean {
  const oa = overdue(state, a);
  const ob = overdue(state, b);
  if (oa !== ob) return oa;
  const ta = waitStartSec(a);
  const tb = waitStartSec(b);
  return ta < tb || (ta === tb && a.id < b.id);
}

/**
 * Aircraft that are about to start moving - an arrival waiting at its exit for taxi instructions (it stands on the stub with its short exit route),
 * a departure waiting for its pushback or taxi clearance - and rank before this one (`outranks`): their planned route is as good as a route they
 * already have, so a route that would meet it head-on in the same minutes waits. A strict order (no two aircraft each defer to the other).
 */
function plannedOpposingTraffic(state: SimulationState, nodeIds: string[], exceptId: string): Aircraft | undefined {
  const me = state.aircraft[exceptId];
  // Only aircraft that have not entered the lane yet (at a stand, or at the hold of the exit they took) wait for a higher-ranked one: an aircraft already
  // taxiing (a progressive-taxi pilot asking for its next segment, a re-route) stands IN the lane, and holding it back would plug the lane for everyone.
  if (me && me.onGround && me.phase === 'TAXIING') return undefined;
  for (const o of Object.values(state.aircraft)) {
    if (o.id === exceptId || !o.onGround || o.pendingRequest?.unheard) continue;
    const kind = o.pendingRequest?.kind;
    const exitWaiter = !o.isDeparture && o.phase === 'RUNWAY_EXIT' && kind === 'TAXI';
    const departureWaiter = o.isDeparture && !o.route && (o.phase === 'READY' || o.phase === 'PARKED' || o.phase === 'PUSHBACK') && (kind === 'TAXI' || kind === 'PUSHBACK') && !isVehicleType(o.type) && !isRotorcraftType(o.type);
    if (!exitWaiter && !departureWaiter) continue;
    // Batching: traffic that is not overdue does not hold a route back (same-direction aircraft share a lane, and alternating single aircraft on a
    // 1.4 km single-width lane cannot carry 10 + 10 movements an hour); only an overdue aircraft that outranks this one does.
    if (!overdue(state, o) || (me && !outranks(state, o, me))) continue;
    const plan = exitWaiter ? planParking(state, o)?.nodeIds : planDeparture(state.airport, o, state.activeRunways.departing, busyHoldIds(state, o.id), closedTaxiways(state))?.nodeIds;
    if (!plan) continue;
    const graph = state.airport.taxiwayGraph;
    const pcum: number[] = [0];
    for (let i = 1; i < plan.length; i++) pcum.push(pcum[i - 1] + dist(graph.nodes[plan[i - 1]].pos, graph.nodes[plan[i]].pos));
    const theirs: Path = { ids: plan, cum: pcum };
    const runs = reversedRuns(graph, nodeIds, theirs);
    if (!runs.length) continue;
    const cum: number[] = [0];
    for (let i = 1; i < nodeIds.length; i++) cum.push(cum[i - 1] + dist(graph.nodes[nodeIds[i - 1]].pos, graph.nodes[nodeIds[i]].pos));
    for (const r of runs) {
      const tMa = cum[r.k0] / LANE_PLAN_SPEED_MPS;
      const tMc = cum[r.kEnd + 1] / LANE_PLAN_SPEED_MPS;
      const tTc = theirs.cum[r.jEnd] / LANE_PLAN_SPEED_MPS;
      const tTa = theirs.cum[r.j0 + 1] / LANE_PLAN_SPEED_MPS;
      if (tMa <= tTa + LANE_WINDOW_MARGIN_SEC && tTc <= tMc + LANE_WINDOW_MARGIN_SEC) return o;
    }
  }
  return undefined;
}

/**
 * Another aircraft is taxiing (or waiting with a route) over a lane within `radiusM` of `pos` in the part of its route still ahead of it.
 * Ground holds a pushback while this is true: the pushed-back aircraft would stand in the lane in front of the taxiing one, which then waits
 * behind it while it waits for the lane to clear.
 */
export function routePassesNear(state: SimulationState, pos: { x: number; y: number }, radiusM: number, exceptId: string): Aircraft | undefined {
  const graph = state.airport.taxiwayGraph;
  for (const o of Object.values(state.aircraft)) {
    if (o.id === exceptId || !o.onGround || !o.route || (o.phase !== 'TAXIING' && o.phase !== 'TAXI_TO_PARKING')) continue;
    const rest = o.route.nodeIds.slice(Math.max(0, o.route.progressIndex - 1));
    for (let i = 0; i < rest.length; i++) {
      const n = graph.nodes[rest[i]];
      if (n && n.kind !== 'parking' && Math.hypot(n.pos.x - pos.x, n.pos.y - pos.y) <= radiusM) return o;
    }
  }
  return undefined;
}

/**
 * Another stopped aircraft stands between this one and the first runway node of its route, on the same lane (an exit stub where several
 * arrivals wait to cross): it must go first, the one behind cannot pass it.
 */
export function aheadInCrossingQueue(state: SimulationState, ac: Aircraft): Aircraft | undefined {
  const r = ac.route;
  if (!r) return undefined;
  const graph = state.airport.taxiwayGraph;
  const runwayNode = r.nodeIds.slice(Math.max(0, r.progressIndex - 1)).map((id) => graph.nodes[id]).find((n) => n?.kind === 'runway');
  if (!runwayNode) return undefined;
  const mine = Math.hypot(ac.pos.x - runwayNode.pos.x, ac.pos.y - runwayNode.pos.y);
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id || !o.onGround || o.groundSpeedKt >= 1) continue;
    if (Math.hypot(o.pos.x - ac.pos.x, o.pos.y - ac.pos.y) > 60) continue;
    if (Math.hypot(o.pos.x - runwayNode.pos.x, o.pos.y - runwayNode.pos.y) < mine - 2) return o;
  }
  return undefined;
}
