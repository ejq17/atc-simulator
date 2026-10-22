/**
 * Read-only world queries for the AI controllers: runway geometry, ETAs, taxi route planning.
 * Nothing here mutates the simulation. Taxi planning mirrors `commandExecutor.planTaxi` so that the route the AI
 * announces is the route the engine will compute for the same command.
 */
import type { Aircraft, Airport, ParkingPosition, SimulationState, TaxiNode } from '../sim/types';
import { dist, ftToM, mToNm } from '../sim/geo';
import { alongCross, crossingRunways, findRunwayEnd, normalizeRunwayEndId, parallelNeighbours } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { pushbackGeometry } from '../sim/pushback';
import { findTaxiRoute, nearestNode, routeStartNode, shortestDistances } from '../sim/pathfinding';
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
// Dependent parallel finals
// ---------------------------------------------------------------------------------------------------------------------

/** Longest centreline spacing (ft) of adjacent parallel finals still handled as dependent approaches (JO 7110.65 5-9-6: up to 9,000 ft). */
export const DEPENDENT_PARALLEL_MAX_FT = 9000;
/**
 * Diagonal radar separation between successive aircraft on adjacent final approach courses (JO 7110.65 5-9-6, read on faa.gov 2026-10-21): 1 nm when the
 * centrelines are 2,500 to 3,600 ft apart, 1.5 nm for 3,600 to 8,300 ft, 2 nm for 8,300 to 9,000 ft. Closer than 2,500 ft the paragraph gives no
 * stagger: the AI keeps the 3 nm radar separation then.
 */
export function dependentDiagonalNm(centrelineFt: number): number {
  if (centrelineFt < 2500) return 3;
  if (centrelineFt <= 3600) return 1;
  return centrelineFt <= 8300 ? 1.5 : 2;
}
/** The simulator's near-miss alert distance (1.5 nm, conflicts.ts) plus a margin the stagger keeps above it (DESIGN VALUE: speeds differ and the finals converge). */
export const DEPENDENT_ALERT_MARGIN_NM = 0.2;
/**
 * The diagonal the AI keeps between aircraft on adjacent finals that are not yet established: the 5-9-6 minimum, and never less than the alert distance plus
 * `DEPENDENT_ALERT_MARGIN_NM` (a 1 nm stagger is a legal radar separation but the simulator's near-miss alert fires at 1.5 nm below 500 ft of altitude difference).
 */
export function dependentKeepDiagonalNm(centrelineFt: number): number {
  return Math.max(dependentDiagonalNm(centrelineFt), 1.5 + DEPENDENT_ALERT_MARGIN_NM);
}

export interface DependentMate {
  end: RunwayEndGeom;
  latFt: number;
  /** Along-course distance (nm) between the two aircraft that keeps the diagonal at `dependentKeepDiagonalNm`. */
  alongNm: number;
  /** The mate's threshold ahead of (+) or behind (-) this end's threshold along the course, nm. */
  staggerNm: number;
}

/** The runway ends whose finals are adjacent and dependent on the final of `g` (same direction, centrelines up to 9,000 ft apart), with the along-course spacing they need. */
export function dependentMates(airport: Airport, g: RunwayEndGeom): DependentMate[] {
  return parallelNeighbours(airport, g, DEPENDENT_PARALLEL_MAX_FT).map((n) => {
    const latFt = Math.abs(n.lateralFt);
    const latNm = (latFt * 0.3048) / 1852;
    const diag = dependentKeepDiagonalNm(latFt);
    return { end: n.end, latFt, alongNm: Math.sqrt(Math.max(0, diag * diag - latNm * latNm)), staggerNm: n.staggerM / 1852 };
  });
}

/** How far behind (+nm along the course; - = ahead) the aircraft `ac`, going to `g`, is of `o`, going to the parallel end `og`: both measured to their own thresholds, `staggerNm` removed. */
export function parallelGapNm(ac: Aircraft, g: RunwayEndGeom, o: Aircraft, og: RunwayEndGeom, staggerNm: number): number {
  return distToThresholdNm(ac, g) - (distToThresholdNm(o, og) - staggerNm);
}

/**
 * Margin (nm) added to the along-course spacing of two arrivals on adjacent finals when their paths are projected at nominal speeds. DESIGN VALUE: speeds and paths differ,
 * and a leader that floats in the flare stays airborne (for the near-miss alert) 15 to 25 s after its threshold crossing, during which a follower 70 kt faster closes 0.3 to 0.5 nm.
 */
export const PARALLEL_PROJECTION_MARGIN_NM = 0.6;

/**
 * Two arrivals for adjacent dependent finals, both flying straight to their thresholds at constant speeds (`kNew`, `kOther`): do they keep `mate.alongNm` plus the
 * margin between them along the course until the first one reaches its threshold, without passing each other? Positions are along `g`'s course (nm, the threshold of
 * `g` at 0, negative before it); the other aircraft's threshold is `mate.staggerNm` ahead. The gap is linear in time, so its ends decide: a faster aircraft behind a
 * slower one that reaches its threshold first has overtaken it (abreast, 0.7 nm apart for a 4,000 ft pair) and fails; a slower one behind keeps the gap it had.
 */
export function dependentPairClear(mate: DependentMate, aNewNm: number, kNew: number, aOtherNm: number, kOther: number): boolean {
  const need = mate.alongNm + PARALLEL_PROJECTION_MARGIN_NM;
  const tEnd = Math.min(Math.max(0, -aNewNm) / Math.max(kNew, 1), Math.max(0, mate.staggerNm - aOtherNm) / Math.max(kOther, 1)); // hours
  const gap0 = aNewNm - aOtherNm;
  const gapEnd = aNewNm + kNew * tEnd - (aOtherNm + kOther * tEnd);
  return Math.sign(gap0) === Math.sign(gapEnd) && Math.min(Math.abs(gap0), Math.abs(gapEnd)) >= need;
}

/**
 * Seconds that must separate the threshold crossings of an aircraft and one on the dependent final next to it: the along-course spacing at the speed of the one
 * that crosses second (it closes on the first until the first crosses: faster behind slower is the worst case). Used with `etaToThresholdSec`-like times.
 */
export function dependentStaggerSec(alongNm: number, followerKt: number): number {
  return (alongNm / Math.max(followerKt, 40)) * 3600;
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
  return routeStartNode(graph, ac.pos, ac.headingDeg);
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

/**
 * Taxi-equivalent distance (m) one departure already queued for a runway adds to the cost of sending another aircraft there. DESIGN VALUE: a departure occupies the
 * runway about a minute (roll, climb-out spacing, the arrivals in between), which a taxiing aircraft at the plan speed (`LANE_PLAN_SPEED_MPS`, 6.7 m/s) covers in 400 m.
 */
export const QUEUE_PENALTY_M = 400;

/** Departures waiting for or taxiing to a hold of the runway of `holdId` (the artificial "avoid" counts of `busyHoldIds` are not queue length). */
function runwayQueue(graph: Airport['taxiwayGraph'], busyHolds: ReadonlyMap<string, number>, runwayId: string): number {
  let n = 0;
  for (const [id, k] of busyHolds) if (graph.nodes[id]?.runwayId === runwayId && k < AVOID_EXTRA) n += k;
  return n;
}

/**
 * Which route a departure gets, among the runway ends of the departure configuration that leave the type its takeoff distance. The tiers of the old rule stay: an
 * unoccupied full-length entry first, then any unoccupied hold, then the least crowded hold with room (three deep at most). Inside a tier the choice is the shortest
 * taxi route from the stand, plus `QUEUE_PENALTY_M` for every departure already queued for that runway (so a runway whose queue is much longer is not picked while another
 * is nearly as close); the order in which the configuration lists the ends decides a tie (an operator preference).
 */
function planDepartureOnce(airport: Airport, ac: Aircraft, ends: string[], busyHolds: ReadonlyMap<string, number>, closed?: ReadonlySet<string>): DeparturePlan | undefined {
  const start = taxiStartNode(airport, ac);
  if (!start) return undefined;
  const need = ftToM(getPerformance(ac.type).takeoffDistanceFt) + 50;
  const graph = airport.taxiwayGraph;
  // Within one runway end the entries keep the order of `departureCandidates` (the first unoccupied full-length entry, else the first unoccupied hold, else the least crowded one).
  const perEnd = new Map<string, { plan: DeparturePlan; tier: number; n: number }>();
  for (const { plan, fullEntry } of departureCandidates(airport, start.id, ends, need, closed)) {
    const n = busyHolds.get(plan.holdId) ?? 0;
    const tier = fullEntry && n === 0 ? 0 : n === 0 ? 1 : n < MAX_QUEUE ? 2 : undefined;
    if (tier === undefined) continue;
    const cur = perEnd.get(plan.runwayEnd);
    if (!cur || tier < cur.tier || (tier === 2 && cur.tier === 2 && n < cur.n)) perEnd.set(plan.runwayEnd, { plan, tier, n });
  }
  let best: { plan: DeparturePlan; tier: number; cost: number } | undefined;
  for (const { plan, tier, n } of perEnd.values()) {
    const rid = graph.nodes[plan.holdId]?.runwayId;
    const cost = plan.lengthM + QUEUE_PENALTY_M * (rid ? runwayQueue(graph, busyHolds, rid) : 0) + (tier === 2 ? 1e6 * n : 0);
    if (!best || tier < best.tier || (tier === best.tier && cost < best.cost)) best = { plan, tier, cost };
  }
  return best?.plan;
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
    // (also when it has been given its taxi instructions and still stands there: the lane in front of it is occupied by the aircraft it waits for, soak seed 3)
    if (o.id !== exceptId && o.onGround && !o.isDeparture && (o.phase === 'RUNWAY_EXIT' || (o.phase === 'TAXI_TO_PARKING' && o.groundSpeedKt < 1))) {
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
function onRoute(graph: SimulationState['airport']['taxiwayGraph'], nodeIds: string[], p: { x: number; y: number }, facingDeg?: number, withStandLeadIn = false): boolean {
  for (let i = 1; i < nodeIds.length; i++) {
    const a = graph.nodes[nodeIds[i - 1]];
    const b = graph.nodes[nodeIds[i]];
    if (!a || !b || (!withStandLeadIn && (a.kind === 'parking' || b.kind === 'parking'))) continue;
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

/**
 * What stands between a departure taxiing toward its runway hold and the hold line, so that Tower could not move it if it were handed over now: an arrival
 * that left the runway and waits on the route (the exit stub of the hold the departure is bound for), an aircraft stopped or coming the other way on it
 * (`opposingTraffic`, which includes the stub a lander is about to use), or a pushed-back aircraft standing on it. A departure queued behind another departure
 * (same direction) is not blocked: the queue moves in order. JO 7110.65 3-7-2 (taxi instructions that keep aircraft apart are Ground's): the switch to Tower is made when the
 * aircraft is holding short or approaching the hold with no conflict ahead; with one ahead Ground keeps the aircraft, because only Ground can taxi it aside
 * or turn it around (docs/PROGRESS.md "Throughput").
 */
export function blockedBeforeHold(state: SimulationState, ac: Aircraft): Aircraft | undefined {
  const r = ac.route;
  if (!r) return undefined;
  const rest = r.nodeIds.slice(Math.max(0, r.progressIndex - 1));
  if (rest.length < 2) return undefined;
  const opp = opposingTraffic(state, rest, ac.id);
  if (opp) return opp;
  const graph = state.airport.taxiwayGraph;
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id || !o.onGround || o.occupyingRunways.length > 0 || o.phase === 'PARKED' || o.phase === 'ARRIVED') continue;
    if (o.isDeparture ? o.groundSpeedKt < 1 && onRoute(graph, rest, o.pos, o.headingDeg) : (o.phase === 'RUNWAY_EXIT' || o.phase === 'TAXI_TO_PARKING') && onRoute(graph, rest, o.pos)) return o;
  }
  return undefined;
}

/**
 * Another aircraft stands (or taxis) so close to the pushback path that the push would stop at once (`groundMovement.pushBlocked`: half the two lengths plus 8 m from
 * the push point or the point ahead of the tail). Ground approves the push when nobody is in the way instead: an approved push that cannot start holds the aircraft in
 * PUSHBACK, and the aircraft in the way - waiting for its own taxi clearance, which is held for the pushing aircraft - never leaves (soak seed 1: two airliners at
 * neighbouring gates, an hour).
 */
export function pushbackBlockedBy(state: SimulationState, ac: Aircraft, from: { x: number; y: number }, to: { x: number; y: number }): Aircraft | undefined {
  const la = getPerformance(ac.type).lengthM;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id || !o.onGround || o.phase === 'ARRIVED' || o.phase === 'PARKED') continue;
    if (!o.route && o.groundSpeedKt < 0.1 && state.airport.parking.some((p) => dist(p.pos, o.pos) < 8)) continue; // on its own stand
    // a push already in progress nearby: two pushes onto the same stretch of lane stop each other
    const need = (la + getPerformance(o.type).lengthM) / 2 + 8;
    if (o.phase === 'PUSHBACK') {
      const dest = pushDestination(state, o);
      if (dest && dist(dest, to) < need) return o;
      continue; // (the pushing aircraft itself, mid-way, is judged by its destination: the engine's push only stops for what stands near the push point)
    }
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((o.pos.x - from.x) * dx + (o.pos.y - from.y) * dy) / len2)) : 0;
    if (Math.hypot(o.pos.x - (from.x + dx * t), o.pos.y - (from.y + dy * t)) < need) return o;
  }
  return undefined;
}

/** Distance (m) within which a pushback in progress counts as standing on a route (the longest lead-in from a stand to the lane at KACY is 55 m; ground.ts `PUSHBACK_LANE_CLEAR_M` keeps 90 m for the reverse check). DESIGN VALUE. */
const PUSHBACK_LEAD_IN_M = 70;

/** Where a pushback in progress ends (the lane end of its stand's lead-in, `pushback.pushbackGeometry`): the nearest stand to the aircraft. */
function pushDestination(state: SimulationState, o: Aircraft): { x: number; y: number } | undefined {
  let stand: ParkingPosition | undefined;
  let best = 80;
  for (const p of state.airport.parking) {
    const d = dist(p.pos, o.pos);
    if (d < best) { best = d; stand = p; }
  }
  return stand ? pushbackGeometry(state.airport, stand, o, { departingEnds: state.activeRunways.departing })?.to : undefined;
}

/** `me` stands in a lane within the reach of the push of `o` (half the two lengths plus 8 m of its destination or of its path): the push is held up by it, so it has to go first. */
function blocksPush(state: SimulationState, me: Aircraft, o: Aircraft): boolean {
  if (state.airport.parking.some((p) => dist(p.pos, me.pos) < 8)) return false; // on its own stand
  const need = (getPerformance(me.type).lengthM + getPerformance(o.type).lengthM) / 2 + 8;
  const dest = pushDestination(state, o);
  if (!dest) return dist(me.pos, o.pos) < need;
  const dx = dest.x - o.pos.x;
  const dy = dest.y - o.pos.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((me.pos.x - o.pos.x) * dx + (me.pos.y - o.pos.y) * dy) / len2)) : 0;
  return Math.hypot(me.pos.x - (o.pos.x + dx * t), me.pos.y - (o.pos.y + dy * t)) < need;
}

/** Some segment of the node path passes within `radiusM` of `p` (parking nodes included: the lead-in itself is the thing being asked about). */
function routeWithin(graph: SimulationState['airport']['taxiwayGraph'], nodeIds: string[], p: { x: number; y: number }, radiusM: number): boolean {
  for (let i = 1; i < nodeIds.length; i++) {
    const a = graph.nodes[nodeIds[i - 1]];
    const b = graph.nodes[nodeIds[i]];
    if (!a || !b) continue;
    const dx = b.pos.x - a.pos.x;
    const dy = b.pos.y - a.pos.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.pos.x) * dx + (p.y - a.pos.y) * dy) / len2)) : 0;
    if (Math.hypot(p.x - (a.pos.x + dx * t), p.y - (a.pos.y + dy * t)) <= radiusM) return true;
  }
  return false;
}

/**
 * A departure on a progressive taxi (AIM 4-3-18) holds only the segment it was told, but it is going to the runway entry Ground plans for it: that whole way
 * is its route for the purpose of keeping traffic off the lane (an arrival sent along the lane while the next segment is still to be issued meets it head-on,
 * as the soak showed). The planned rest is `planDeparture` from the segment's end node.
 */
function withPlannedRoute(state: SimulationState, o: Aircraft): Aircraft {
  const r = o.route;
  if (!r || !o.isDeparture || o.phase !== 'TAXIING') return o;
  const seg = lastClearanceOf(o, 'TAXI');
  if (!seg?.segment || seg.completedAtSec !== undefined) return o;
  const graph = state.airport.taxiwayGraph;
  const endN = graph.nodes[r.nodeIds[r.nodeIds.length - 1]];
  const prevN = graph.nodes[r.nodeIds[Math.max(0, r.nodeIds.length - 2)]];
  if (!endN || !prevN || endN.kind === 'holding_position' || endN.kind === 'parking') return o;
  const virtual: Aircraft = { ...o, pos: endN.pos, route: undefined, headingDeg: (Math.atan2(endN.pos.x - prevN.pos.x, endN.pos.y - prevN.pos.y) * 180 / Math.PI + 360) % 360 };
  const dep = planDeparture(state.airport, virtual, state.activeRunways.departing, new Map(), closedTaxiways(state));
  if (!dep) return o;
  const start = dep.nodeIds.indexOf(endN.id);
  const rest = start >= 0 ? dep.nodeIds.slice(start + 1) : dep.nodeIds;
  return { ...o, route: { ...r, nodeIds: [...r.nodeIds, ...rest] } };
}

function lastClearanceOf(o: Aircraft, kind: string) {
  for (let i = o.clearances.length - 1; i >= 0; i--) if (o.clearances[i].kind === kind) return o.clearances[i];
  return undefined;
}

export function opposingTraffic(state: SimulationState, nodeIds: string[], exceptId: string, opts: { ignoreStopped?: boolean; ignoreStoppedAhead?: boolean } = {}): Aircraft | undefined {
  // The exit stub a lander inside 2 nm (or rolling out) is about to use is as good as occupied: a route over it ends head-on with the lander
  // (exitStubs.ts). AI Ground waits; the lander is returned as the blocker.
  const lander = landerStubOnRoute(state, nodeIds, exceptId);
  if (lander) return state.aircraft[lander.aircraftId];
  const graph = state.airport.taxiwayGraph;
  const mine = new Map<string, number>();
  nodeIds.forEach((id, i) => mine.set(id, i));
  const me = state.aircraft[exceptId];
  for (const o0 of Object.values(state.aircraft)) {
    if (o0.id === exceptId || !o0.onGround) continue;
    const o = withPlannedRoute(state, o0);
    // `ignoreStopped`: an aircraft that stands still on the route is no reason to wait when it is itself held up by this one (an arrival at the head of an exit stub
    // and a departure that stopped short of the stub because of it): the route is issued, the engine stops the pair nose to nose and the pilot's call is answered
    // (ai/headOn.ts) instead of both waiting for good.
    if (opts.ignoreStopped && o.groundSpeedKt < 1 && o.route) continue;
    // `ignoreStoppedAhead`: the stopped one is not waiting for something else, it is waiting for THIS aircraft, which stands on the part of its route still ahead
    // (a departure that came up behind an arrival at the head of its exit stub): that is the mutual wait, the pair is released and the head-on resolution answers.
    if (opts.ignoreStoppedAhead && o.groundSpeedKt < 1 && o.route && me && onRoute(graph, o.route.nodeIds.slice(Math.max(0, o.route.progressIndex - 1)), me.pos, undefined, true)) continue;
    if (!o.route) {
      // A pushed-back aircraft standing on the lane (READY / PUSHBACK, no route yet) blocks every route over its position just as a stopped one would:
      // an arrival sent past it would wait behind it while it waits for the arrival to clear (free-play soak, docs/PROGRESS.md "Free-play jam").
      if ((o.phase === 'READY' || o.phase === 'PUSHBACK') && onRoute(graph, nodeIds, o.pos)) return o;
      // An aircraft being pushed back is moving onto the lane (its push point is up to ~55 m from where it is now): a route that passes within the pushback lead-in
      // of it would find it standing in the lane within the minute (soak seed 2: a taxi clearance 10 s after a pushback approval, both stopped for an hour).
      // (not when the requester itself stands in the lane within reach of the push - a pushed-back airliner waiting for its own taxi clearance: the push is held up by it
      // (`groundMovement.pushBlocked`), so it has to go first: two gates, each pushed-back airliner waiting for its taxi clearance behind the other, stopped for an hour in the soak)
      if (o.phase === 'PUSHBACK' && routeWithin(graph, nodeIds, o.pos, PUSHBACK_LEAD_IN_M) && !(me && me.groundSpeedKt < 1 && blocksPush(state, me, o))) return o;
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
        // (Only this aircraft is cleared by the window test: the others are still to be looked at - returning here would let every aircraft after it in the
        // list through, soak seed 1: an arrival sent along the lane towards a departure that was listed after one whose window did not overlap.)
        if (sharedLaneInSameWindow(state, nodeIds, o)) return o;
        break;
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
    // I stand IN the way of that aircraft's planned route (a pushed-back departure on the lane the arrival's route follows): it cannot go before me, so it
    // is no reason for me to wait (the other way round it is: `opposingTraffic` holds the arrival back for an aircraft standing on its route).
    if (me && me.groundSpeedKt < 1 && onRoute(graph, plan, me.pos)) continue;
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
