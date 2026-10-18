/**
 * Which runway exit an arrival should use (JO 7110.65 3-10-9: "Instruct aircraft where to turn-off the runway after landing, when appropriate").
 *
 * One rule for the landing rollout (`flightDynamics.chooseExit`, when the controller names no exit) and for the AI Tower (the exit it
 * instructs). Among the exits the aircraft can physically make (the engine's braking logic decides that, not this file) the preferred one is
 * the one with the lowest cost, in this order of importance:
 *
 *   (b) the taxiway beyond the hold line is not occupied: no aircraft stopped on it (a departure queue, an arrival waiting for taxi
 *       instructions, a pushback) and none taxiing toward the exit on the same lane (head-on);
 *   (d) the way to the parking position needs no runway crossing, and does not start with an immediate crossing of an active runway;
 *   (a) the exit is on the side of the runway the parking position is on;
 *   (c) the taxi route from the hold line to the parking position is the shortest, with a small charge for every metre of runway the
 *       aircraft occupies beyond the first exit it could have made, and a larger one beyond `OCCUPANCY_GATE_M` (runway occupancy time:
 *       the spacing of 3-10-3 / 3-9-6 depends on it).
 *
 * These are weights of one sum, not four separate passes: an exit that is a little longer to taxi but on the right side and free beats a
 * short taxi that ends in a queue. The weights are DESIGN VALUES below. Everything is a function of the state and the static airport data,
 * so the same state gives the same exit.
 */
import type { Aircraft, Airport, ParkingPosition, SimulationState, Vec2 } from './types';
import { dist, vDot, vSub } from './geo';
import { findTaxiRoute, shortestDistances } from './pathfinding';
import type { TaxiRoute } from './pathfinding';
import { closedTaxiways } from './airportOps';
import { freeParkingCandidates } from './parkingResolver';
import { getPerformance } from './performance';
import { alongCross } from './runways';
import type { RunwayEndGeom } from './runways';

/** Taxi metres a runway crossing is worth (an extra clearance, a wait at the hold line, a second runway occupancy). DESIGN VALUE. */
export const CROSSING_COST_M = 600;
/** ... and the extra charge when the first crossing is right at the exit (within `IMMEDIATE_CROSSING_M`) of a runway that is in use. DESIGN VALUE. */
export const IMMEDIATE_CROSSING_COST_M = 400;
export const IMMEDIATE_CROSSING_M = 250;
/** Taxi metres charged for an exit on the side of the runway away from the parking position. DESIGN VALUE. */
export const WRONG_SIDE_COST_M = 300;
/** Taxi metres charged per metre of runway rolled beyond the first exit the aircraft could make (runway occupancy). DESIGN VALUE. */
export const RUNWAY_OCCUPANCY_COST = 0.5;
/**
 * An exit more than this far (m) beyond the first exit the aircraft could make keeps the runway occupied about 40 s longer at taxi speed: it is
 * charged `BEYOND_GATE_COST_M` (less than a blocked exit, more than any ordinary difference in taxi distance). DESIGN VALUE.
 */
export const OCCUPANCY_GATE_M = 600;
export const BEYOND_GATE_COST_M = 2500;
/** An exit whose taxiway is occupied or has opposing traffic: charged so that any alternative within about 5 km of taxiing wins. DESIGN VALUE. */
export const BLOCKED_COST_M = 5000;
/** The part of the taxi route beyond the hold line that must be free for the exit to count as usable. */
export const EXIT_STUB_M = 400;
/** An aircraft this close (m) to the stub centreline is on it. */
const STUB_LANE_M = 35;
const NO_ROUTE_COST_M = 1e6;

/** Spots Ground would offer the arrival (nearest free one of its category, same filters as `ai/world.planParking`). */
export function arrivalParkingTargets(state: SimulationState, ac: Aircraft): ParkingPosition[] {
  const perf = getPerformance(ac.type);
  // (prediction helpers are called with a bare state in tests: no aircraft means nothing is occupied)
  const free = state.aircraft ? freeParkingCandidates(state, ac, undefined, undefined) : state.airport.parking;
  return free.filter((p) => p.category !== 'military' || perf.category === 'light' || !!perf.military);
}

interface HoldDistances {
  noCross: Map<string, number>;
  withCross: Map<string, number>;
}
const distCache = new WeakMap<Airport, Map<string, HoldDistances>>();
const routeCache = new WeakMap<Airport, Map<string, TaxiRoute | null>>();

const closedKey = (closed: ReadonlySet<string>): string => [...closed].sort().join(',');

function holdDistances(airport: Airport, holdId: string, closed: ReadonlySet<string>): HoldDistances {
  let byKey = distCache.get(airport);
  if (!byKey) distCache.set(airport, (byKey = new Map()));
  const key = `${holdId}|${closedKey(closed)}`;
  let hit = byKey.get(key);
  if (!hit) {
    const graph = airport.taxiwayGraph;
    hit = {
      noCross: shortestDistances(graph, holdId, { avoidTaxiways: closed }),
      withCross: shortestDistances(graph, holdId, { allowedRunwayIds: airport.runways.map((r) => r.id), avoidTaxiways: closed }),
    };
    byKey.set(key, hit);
  }
  return hit;
}

function routeBetween(airport: Airport, fromId: string, toId: string, closed: ReadonlySet<string>): TaxiRoute | null {
  let byKey = routeCache.get(airport);
  if (!byKey) routeCache.set(airport, (byKey = new Map()));
  const key = `${fromId}|${toId}|${closedKey(closed)}`;
  let hit = byKey.get(key);
  if (hit === undefined) {
    hit = findTaxiRoute(airport.taxiwayGraph, fromId, toId, { avoidRunways: true, allowedRunwayIds: airport.runways.map((r) => r.id), avoidTaxiways: closed }).route;
    byKey.set(key, hit);
  }
  return hit;
}

/** The taxi way from a hold line to the nearest of the parking spots, as the cost sees it. */
export interface HoldToParking {
  taxiM: number;
  crossings: number;
  /** The first runway crossing starts within `IMMEDIATE_CROSSING_M` of the hold line. */
  immediateCrossingRunway?: string;
  nodeIds: string[];
  spotId?: string;
}

export function holdToParking(state: SimulationState, holdId: string, targets: readonly ParkingPosition[]): HoldToParking {
  const airport = state.airport;
  const closed = closedTaxiways(state);
  const dm = holdDistances(airport, holdId, closed);
  let best: { p: ParkingPosition; cost: number } | undefined;
  for (const p of targets) {
    const d0 = dm.noCross.get(p.nodeId);
    const cost = d0 !== undefined ? d0 : (dm.withCross.get(p.nodeId) ?? Infinity) + CROSSING_COST_M;
    if (cost < Infinity && (!best || cost < best.cost)) best = { p, cost };
  }
  if (!best) return { taxiM: NO_ROUTE_COST_M, crossings: 0, nodeIds: [holdId] };
  const route = routeBetween(airport, holdId, best.p.nodeId, closed);
  if (!route) return { taxiM: best.cost, crossings: 0, nodeIds: [holdId], spotId: best.p.id };
  const graph = airport.taxiwayGraph;
  let immediate: string | undefined;
  let run = 0;
  for (let i = 1; i < route.nodeIds.length && run <= IMMEDIATE_CROSSING_M; i++) {
    run += dist(graph.nodes[route.nodeIds[i - 1]].pos, graph.nodes[route.nodeIds[i]].pos);
    const n = graph.nodes[route.nodeIds[i]];
    if (n.kind === 'runway' && run <= IMMEDIATE_CROSSING_M) {
      immediate = n.runwayId;
      break;
    }
  }
  return { taxiM: route.lengthM, crossings: route.runwayCrossings.length, immediateCrossingRunway: immediate, nodeIds: route.nodeIds, spotId: best.p.id };
}

/** The nodes of `nodeIds` within `EXIT_STUB_M` of the first one (the exit stub beyond the hold line). */
export function stubNodes(state: SimulationState, nodeIds: readonly string[]): string[] {
  const graph = state.airport.taxiwayGraph;
  const out: string[] = [];
  let run = 0;
  for (let i = 0; i < nodeIds.length; i++) {
    if (i > 0) run += dist(graph.nodes[nodeIds[i - 1]].pos, graph.nodes[nodeIds[i]].pos);
    if (run > EXIT_STUB_M) break;
    out.push(nodeIds[i]);
  }
  return out;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = vSub(b, a);
  const len2 = ab.x * ab.x + ab.y * ab.y;
  const t = len2 > 0 ? Math.max(0, Math.min(1, vDot(vSub(p, a), ab) / len2)) : 0;
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/** Distance (m) from `p` to the polyline through `nodeIds`. */
function distToStub(state: SimulationState, nodeIds: readonly string[], p: Vec2): number {
  const graph = state.airport.taxiwayGraph;
  let best = Infinity;
  for (let i = 1; i < nodeIds.length; i++) best = Math.min(best, distToSegment(p, graph.nodes[nodeIds[i - 1]].pos, graph.nodes[nodeIds[i]].pos));
  if (nodeIds.length === 1) best = dist(p, graph.nodes[nodeIds[0]].pos);
  return best;
}

export interface ExitBlockage {
  aircraftId: string;
  callsign: string;
  why: 'stopped' | 'pushback' | 'opposing';
}

/**
 * Is the exit stub (the first `EXIT_STUB_M` of `routeNodeIds`, which starts at the hold line) occupied? An aircraft standing on it (a
 * departure holding short at its far end or queued, an arrival waiting for taxi instructions, an aircraft being pushed back) or one whose
 * route comes toward the exit over the same nodes (head-on on a single lane) blocks it. Aircraft on a runway surface and parked ones do not.
 */
export function exitBlockage(state: SimulationState, exceptId: string, routeNodeIds: readonly string[]): ExitBlockage | undefined {
  const stub = stubNodes(state, routeNodeIds);
  if (stub.length < 1) return undefined;
  const order = new Map<string, number>();
  stub.forEach((id, i) => order.set(id, i));
  const graph = state.airport.taxiwayGraph;
  for (const o of Object.values(state.aircraft ?? {})) {
    if (o.id === exceptId || !o.onGround || o.phase === 'PARKED' || o.phase === 'ARRIVED' || o.occupyingRunways.length > 0) continue;
    // An aircraft standing on its parking position (no route, within a few metres of a stand) is not traffic on the taxiway.
    if (!o.route && o.groundSpeedKt < 0.1 && o.phase !== 'PUSHBACK' && state.airport.parking.some((p) => dist(p.pos, o.pos) < 8)) continue;
    const near = distToStub(state, stub, o.pos) <= STUB_LANE_M;
    if (near && (o.phase === 'PUSHBACK' || (o.phase === 'READY' && !o.route))) return { aircraftId: o.id, callsign: o.callsign, why: 'pushback' };
    if (near && o.groundSpeedKt < 1) return { aircraftId: o.id, callsign: o.callsign, why: 'stopped' };
    if (!o.route || o.groundSpeedKt < 1) continue;
    const rest = o.route.nodeIds.slice(Math.max(0, o.route.progressIndex - 1));
    let prevMine = -1;
    for (const id of rest) {
      const k = order.get(id);
      if (k === undefined || graph.nodes[id]?.kind === 'parking') continue;
      if (prevMine >= 0 && k < prevMine) return { aircraftId: o.id, callsign: o.callsign, why: 'opposing' };
      prevMine = k;
    }
  }
  return undefined;
}

export interface ExitScore {
  taxiM: number;
  crossings: number;
  wrongSide: boolean;
  blocked?: ExitBlockage;
  /** Runway metres rolled beyond the first reachable exit. */
  extraRolloutM: number;
  cost: number;
}

/** The side of the runway (as `RunwayExit.holds[].side`) the nearest of the parking spots lies on, seen from the landing direction. */
export function parkingSide(_state: SimulationState, g: RunwayEndGeom, targets: readonly ParkingPosition[], reference: Vec2): 'left' | 'right' | undefined {
  let best: ParkingPosition | undefined;
  for (const p of targets) if (!best || dist(p.pos, reference) < dist(best.pos, reference)) best = p;
  if (!best) return undefined;
  const { cross } = alongCross(g, best.pos);
  return Math.abs(cross) < 30 ? undefined : cross > 0 ? 'right' : 'left';
}

export interface ScoreInput {
  state: SimulationState;
  ac: Pick<Aircraft, 'id'>;
  g: RunwayEndGeom;
  holdId: string;
  holdSide: 'left' | 'right';
  extraRolloutM: number;
  targets: readonly ParkingPosition[];
  sideOfParking?: 'left' | 'right';
}

export function scoreExit(i: ScoreInput): ExitScore {
  const way = holdToParking(i.state, i.holdId, i.targets);
  const blocked = exitBlockage(i.state, i.ac.id, way.nodeIds);
  const wrongSide = i.sideOfParking !== undefined && i.sideOfParking !== i.holdSide;
  let immediate = 0;
  if (way.immediateCrossingRunway) {
    const rw = i.state.airport.runways.find((r) => r.id === way.immediateCrossingRunway);
    const active = !!rw && rw.ends.some((e) => i.state.activeRunways?.landing.includes(e.id) || i.state.activeRunways?.departing.includes(e.id));
    if (active) immediate = IMMEDIATE_CROSSING_COST_M;
  }
  const cost = way.taxiM + way.crossings * CROSSING_COST_M + immediate + (wrongSide ? WRONG_SIDE_COST_M : 0) + (blocked ? BLOCKED_COST_M : 0) + (i.extraRolloutM > OCCUPANCY_GATE_M ? BEYOND_GATE_COST_M : 0) + i.extraRolloutM * RUNWAY_OCCUPANCY_COST;
  return { taxiM: way.taxiM, crossings: way.crossings, wrongSide, blocked, extraRolloutM: i.extraRolloutM, cost };
}
