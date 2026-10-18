/**
 * Pushback geometry (airport-agnostic).
 *
 * An airliner (or cargo jet) on a gate / nose-in stand is pushed straight back along the stand lead-in (the `apron_connector` edge of the
 * taxi graph) to the PUSH POINT: the graph node where the lead-in meets the apron lane. AC 150/5300-13B Chg 1 5.17.1 item 2 asks for "a
 * pushback area ... with sufficient space to push aircraft back to a point where aircraft initiate maneuvering under their own power";
 * the lane node is that point here. While it is pushed the nose swings onto the lane: the final nose heading is the direction of one of
 * the lane edges at the push point, chosen from the requested tail / nose direction or, when none was given, the lane direction that
 * leads to the departure runway holds by the shorter taxi route (so the taxi that follows needs no reversal).
 *
 * Distances come from the OSM-derived lead-ins of the dataset, not from charted stand data.
 */
import type { Aircraft, Airport, ParkingPosition, TaxiNode, Vec2 } from './types';
import { bearingDeg, dist, headingDiff, normHeading } from './geo';
import { neighborIds, shortestDistances } from './pathfinding';
import { perfOf } from './context';
import { findRunwayEnd } from './runways';

export interface PushbackGeometry {
  stand: ParkingPosition;
  from: Vec2;
  to: Vec2;
  nodeId: string;
  lengthM: number;
  /** Direction the aircraft moves in while pushed (stand -> push point), true degrees. The tail points this way. */
  pushDirDeg: number;
  /** Nose heading when the push is done. */
  finalHeadingDeg: number;
  /** Lane directions available at the push point (nose headings), with the chosen one first. */
  candidatesDeg: number[];
}

/** Stand the aircraft stands on (within 5 m of a parking position). */
export function standOf(airport: Airport, ac: Aircraft): ParkingPosition | undefined {
  let best: ParkingPosition | undefined;
  let bd = 5;
  for (const p of airport.parking) {
    const d = dist(p.pos, ac.pos);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/**
 * Does this departure push back? Airliners and cargo jets on airline / cargo stands do. GA aircraft on ramp stands and tie-downs start up and
 * taxi on their own power, as does anything on a military or FBO ramp.
 */
export function pushbackStand(airport: Airport, ac: Aircraft): ParkingPosition | undefined {
  if (perfOf(ac).category === 'light') return undefined;
  const stand = standOf(airport, ac);
  if (!stand || (stand.category !== 'airline' && stand.category !== 'cargo')) return undefined;
  return stand;
}

const LANE_KINDS = new Set(['parking']);

/**
 * Push point and final heading for a stand. `tailDeg` / `faceDeg` are the requested directions (true degrees); with neither, the lane
 * direction toward the active departure runway holds wins. Returns undefined when the stand has no lead-in.
 * `misfitDeg` is how far the best lane direction is from the request (0 when nothing was requested).
 */
export function pushbackGeometry(
  airport: Airport, stand: ParkingPosition, ac: Aircraft,
  o: { tailDeg?: number; faceDeg?: number; departingEnds?: string[] } = {},
): (PushbackGeometry & { misfitDeg: number }) | undefined {
  const graph = airport.taxiwayGraph;
  const standNode = graph.nodes[stand.nodeId];
  if (!standNode) return undefined;
  let lead: { to: TaxiNode; len: number } | undefined;
  for (const e of graph.edges) {
    if (e.from !== stand.nodeId && e.to !== stand.nodeId) continue;
    const other = graph.nodes[e.from === stand.nodeId ? e.to : e.from];
    if (other && (!lead || e.lengthM < lead.len)) lead = { to: other, len: e.lengthM };
  }
  if (!lead) return undefined;
  const n1 = lead.to;
  const pushDirDeg = bearingDeg(stand.pos, n1.pos);
  // Lane directions at the push point: edges to anything that is not a stand.
  const lanes = neighborIds(graph, n1.id).map((id) => graph.nodes[id]).filter((n) => n && n.id !== stand.nodeId && !LANE_KINDS.has(n.kind));
  const cands = lanes.map((q) => ({ q, hdg: bearingDeg(n1.pos, q.pos) }));
  if (!cands.length) {
    const h = ac.headingDeg;
    return { stand, from: { ...stand.pos }, to: { ...n1.pos }, nodeId: n1.id, lengthM: lead.len, pushDirDeg, finalHeadingDeg: h, candidatesDeg: [h], misfitDeg: 0 };
  }
  let ranked: { hdg: number; cost: number; misfit: number }[];
  if (o.tailDeg !== undefined || o.faceDeg !== undefined) {
    ranked = cands.map((c) => {
      const misfit = Math.abs(o.tailDeg !== undefined ? headingDiff(normHeading(c.hdg + 180), o.tailDeg) : headingDiff(c.hdg, o.faceDeg!));
      return { hdg: c.hdg, cost: misfit, misfit };
    });
  } else {
    // Toward the departure runway holds by the shorter route; the turn needed breaks ties.
    const holds = Object.values(graph.nodes).filter((n) => n.kind === 'holding_position' && n.runwayId && (o.departingEnds ?? []).some((end) => {
      const g = findRunwayEnd(airport, end);
      return g && g.runway.id === n.runwayId && (!n.protectsRunwayEnd || n.protectsRunwayEnd === g.end.id);
    }));
    ranked = cands.map((c) => {
      const dm = shortestDistances(graph, c.q.id);
      let best = Infinity;
      for (const h of holds) best = Math.min(best, dm.get(h.id) ?? Infinity);
      const turn = Math.abs(headingDiff(ac.headingDeg, c.hdg));
      return { hdg: c.hdg, cost: (Number.isFinite(best) ? best + dist(n1.pos, c.q.pos) : 1e6) + turn * 0.01, misfit: 0 };
    });
  }
  ranked.sort((a, b) => a.cost - b.cost);
  return {
    stand, from: { ...stand.pos }, to: { ...n1.pos }, nodeId: n1.id, lengthM: lead.len, pushDirDeg,
    finalHeadingDeg: ranked[0].hdg, candidatesDeg: ranked.map((r) => r.hdg), misfitDeg: ranked[0].misfit,
  };
}

/** Largest miss (degrees) between the requested tail / nose direction and the best lane direction that is still pushed. */
export const PUSH_DIRECTION_TOLERANCE_DEG = 70;
