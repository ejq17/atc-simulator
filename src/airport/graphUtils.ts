/**
 * Query helpers over the ground-movement graph (`TaxiwayGraph`).
 *
 * All functions accept either a bare `TaxiwayGraph` or a whole `Airport`
 * (runway thresholds are only available from an `Airport`; with a bare graph the
 * KACY threshold nodes `THR<end>` are used instead). Lookups are indexed once per
 * graph object (WeakMap cache) so they are cheap to call every tick.
 *
 * Runway identifiers are normalised: "04" == "4", "RWY13/31" == "13-31" == "13/31".
 */
import type { Airport, TaxiEdge, TaxiNode, TaxiNodeKind, TaxiwayGraph, Vec2 } from '../sim/types';
import type { KacyTaxiNode } from './types';

export type GraphSource = TaxiwayGraph | Airport;

export interface RunwayExit {
  node: TaxiNode;
  /** Distance along the runway centreline from the given end's threshold (m). */
  distanceFromThresholdM: number;
  /** Identifier of the exit taxiway ('' when the lane is unnamed). */
  taxiway: string;
  /** Angle (0..180 deg) between the landing direction and the exit taxiway's initial direction. 0 = straight ahead, 90 = perpendicular. */
  exitAngleDeg: number;
  /** Side of the runway (as seen travelling from the threshold) the exit is on. */
  side: 'left' | 'right';
  /** The first non-runway edge of the exit path. */
  edge: TaxiEdge;
}

interface GraphIndex {
  nodes: TaxiNode[];
  byTaxiway: Map<string, TaxiNode[]>;
  byKind: Map<TaxiNodeKind, TaxiNode[]>;
  adjacency: Map<string, TaxiEdge[]>;
}

const cache = new WeakMap<TaxiwayGraph, GraphIndex>();

export function graphOf(source: GraphSource): TaxiwayGraph {
  return 'taxiwayGraph' in source ? source.taxiwayGraph : source;
}

function indexOf(graph: TaxiwayGraph): GraphIndex {
  let idx = cache.get(graph);
  if (idx) return idx;
  const nodes = Object.values(graph.nodes);
  const byTaxiway = new Map<string, TaxiNode[]>();
  const byKind = new Map<TaxiNodeKind, TaxiNode[]>();
  for (const n of nodes) {
    for (const t of n.taxiways) {
      const list = byTaxiway.get(t) ?? [];
      list.push(n);
      byTaxiway.set(t, list);
    }
    const k = byKind.get(n.kind) ?? [];
    k.push(n);
    byKind.set(n.kind, k);
  }
  const adjacency = new Map<string, TaxiEdge[]>();
  for (const e of graph.edges) {
    for (const id of [e.from, e.to]) {
      const list = adjacency.get(id) ?? [];
      list.push(e);
      adjacency.set(id, list);
    }
  }
  idx = { nodes, byTaxiway, byKind, adjacency };
  cache.set(graph, idx);
  return idx;
}

/** "04" -> "4", "RWY 13L" -> "13L". */
export function normalizeRunwayEnd(id: string): string {
  return id.toUpperCase().replace(/^RWY\s*/, '').replace(/^0+(?=\d)/, '');
}

/** "04/22", "RWY4-22" -> "4/22". */
export function normalizeRunwayId(id: string): string {
  return id
    .toUpperCase()
    .replace(/^RWY\s*/, '')
    .split(/[/-]/)
    .map((p) => normalizeRunwayEnd(p.trim()))
    .join('/');
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Nearest node to `pos`, optionally restricted to a kind / list of kinds / predicate. */
export function nearestNode(source: GraphSource, pos: Vec2, kind?: TaxiNodeKind | TaxiNodeKind[] | ((n: TaxiNode) => boolean)): TaxiNode | undefined {
  const idx = indexOf(graphOf(source));
  let pool: TaxiNode[] = idx.nodes;
  let pred: ((n: TaxiNode) => boolean) | undefined;
  if (typeof kind === 'string') pool = idx.byKind.get(kind) ?? [];
  else if (Array.isArray(kind)) pool = kind.flatMap((k) => idx.byKind.get(k) ?? []);
  else if (typeof kind === 'function') pred = kind;
  let best: TaxiNode | undefined;
  let bestD = Infinity;
  for (const n of pool) {
    if (pred && !pred(n)) continue;
    const d = (n.pos.x - pos.x) ** 2 + (n.pos.y - pos.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** All nodes that belong to the taxiway with this identifier (e.g. "A"). */
export function nodesForTaxiway(source: GraphSource, id: string): TaxiNode[] {
  return indexOf(graphOf(source)).byTaxiway.get(id.toUpperCase()) ?? [];
}

/** Holding positions for a runway ("13/31", "04/22", "4-22" ...), ordered by node id. */
export function holdingPositionsForRunway(source: GraphSource, runwayId: string): TaxiNode[] {
  const want = normalizeRunwayId(runwayId);
  return (indexOf(graphOf(source)).byKind.get('holding_position') ?? [])
    .filter((n) => n.runwayId !== undefined && normalizeRunwayId(n.runwayId) === want)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Edges directly connecting nodes `a` and `b` (either direction). */
export function edgesBetween(source: GraphSource, a: string, b: string): TaxiEdge[] {
  return (indexOf(graphOf(source)).adjacency.get(a) ?? []).filter((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
}

/** Edges incident to a node. */
export function edgesOfNode(source: GraphSource, nodeId: string): TaxiEdge[] {
  return indexOf(graphOf(source)).adjacency.get(nodeId) ?? [];
}

interface EndGeometry {
  runwayId: string;
  threshold: Vec2;
  far: Vec2;
}

function endGeometry(source: GraphSource, runwayEnd: string): EndGeometry {
  const end = normalizeRunwayEnd(runwayEnd);
  if ('runways' in source) {
    for (const r of source.runways) {
      const i = r.ends.findIndex((e) => normalizeRunwayEnd(e.id) === end);
      if (i >= 0) return { runwayId: r.id, threshold: r.ends[i].threshold, far: r.ends[1 - i].threshold };
    }
    throw new Error(`unknown runway end "${runwayEnd}"`);
  }
  const graph = source;
  const thr = graph.nodes[`THR${end}`];
  if (!thr || !thr.runwayId) throw new Error(`no threshold node THR${end} in graph; pass the Airport to resolve runway end "${runwayEnd}"`);
  const runwayId = normalizeRunwayId(thr.runwayId);
  const otherEnd = runwayId.split('/').find((e) => e !== end)!;
  const far = graph.nodes[`THR${otherEnd}`];
  if (!far) throw new Error(`no threshold node THR${otherEnd} in graph`);
  return { runwayId, threshold: thr.pos, far: far.pos };
}

/**
 * Holding positions for the runway that `runwayEnd` belongs to, ordered by the
 * distance from that end's threshold to the point where the taxiway meets the
 * runway (the hold line's entry point). The first element is therefore the
 * full-length entry for a departure from that end.
 */
export function runwayEntryNodes(source: GraphSource, runwayEnd: string): TaxiNode[] {
  const g = endGeometry(source, runwayEnd);
  const graph = graphOf(source);
  const key = (h: TaxiNode): number => {
    const entryId = (h as KacyTaxiNode).entryNodeId;
    const entry = entryId ? graph.nodes[entryId] : undefined;
    return dist(g.threshold, (entry ?? h).pos);
  };
  return holdingPositionsForRunway(source, g.runwayId)
    .map((h) => ({ h, d: key(h) }))
    .sort((a, b) => a.d - b.d || (a.h.id < b.h.id ? -1 : 1))
    .map((x) => x.h);
}

/**
 * Runway nodes at which a taxiway leaves the runway, ordered by distance along
 * the runway from the threshold of `runwayEnd`. A crossing taxiway yields one
 * exit per side. Excludes thresholds and the runway/runway intersection.
 */
export function runwayExitNodes(source: GraphSource, runwayEnd: string): RunwayExit[] {
  const g = endGeometry(source, runwayEnd);
  const graph = graphOf(source);
  const idx = indexOf(graph);
  const len = dist(g.threshold, g.far);
  const ux = (g.far.x - g.threshold.x) / len;
  const uy = (g.far.y - g.threshold.y) / len;
  const out: RunwayExit[] = [];
  for (const n of idx.byKind.get('runway') ?? []) {
    const rids = ((n as KacyTaxiNode).runwayIds ?? (n.runwayId ? [n.runwayId] : [])).map(normalizeRunwayId);
    if (!rids.includes(g.runwayId)) continue;
    for (const e of idx.adjacency.get(n.id) ?? []) {
      if (e.onRunwayId) continue; // runway edge
      const nbId = e.from === n.id ? e.to : e.from;
      let nb = graph.nodes[nbId];
      // look ~25 m down the exit path (first edges can be very short)
      let walked = e.lengthM;
      let prevId = n.id;
      let cur = e;
      while (walked < 25) {
        const nextEdge = (idx.adjacency.get(nb.id) ?? []).find((x) => x !== cur && !x.onRunwayId && (x.from !== prevId && x.to !== prevId) && nb.kind !== 'intersection');
        if (!nextEdge) break;
        prevId = nb.id;
        nb = graph.nodes[nextEdge.from === nb.id ? nextEdge.to : nextEdge.from];
        walked += nextEdge.lengthM;
        cur = nextEdge;
      }
      const dx = nb.pos.x - n.pos.x;
      const dy = nb.pos.y - n.pos.y;
      const dl = Math.hypot(dx, dy) || 1;
      const cos = Math.max(-1, Math.min(1, (dx * ux + dy * uy) / dl));
      const cross = ux * dy - uy * dx; // >0: exit lies to the left of the landing direction
      const along = (n.pos.x - g.threshold.x) * ux + (n.pos.y - g.threshold.y) * uy;
      out.push({
        node: n,
        distanceFromThresholdM: Math.round(along * 100) / 100,
        taxiway: e.taxiway,
        exitAngleDeg: Math.round((Math.acos(cos) * 180) / Math.PI * 10) / 10,
        side: cross > 0 ? 'left' : 'right',
        edge: e,
      });
    }
  }
  return out.sort((a, b) => a.distanceFromThresholdM - b.distanceFromThresholdM || (a.node.id < b.node.id ? -1 : 1));
}
