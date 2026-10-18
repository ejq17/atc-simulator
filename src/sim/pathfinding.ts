/**
 * Taxi routing over a TaxiwayGraph (Dijkstra over (node, viaProgress) states).
 *
 * Semantics of `via`: the route must traverse the listed taxiways IN THAT ORDER
 * (as a subsequence of the taxiway names of the edges it uses). Edges of other
 * taxiways (apron links, connectors) are tolerated but cost double, so the search
 * prefers staying on the named taxiways. Runway surfaces (edges with `onRunwayId`)
 * are avoided unless allowed, and edges on a taxiway literally named "RWYxx/yy"
 * (runway travel / back-taxi) are only usable when named in `via`.
 */
import type { TaxiEdge, TaxiNode, TaxiNodeKind, TaxiwayGraph, Vec2 } from './types';
import { dist } from './geo';

export interface RouteOptions {
  via?: string[];
  /** Default true: runway edges are not used unless listed in allowedRunwayIds. */
  avoidRunways?: boolean;
  allowedRunwayIds?: string[];
  /** Extra cost (m-equivalent) per runway edge so routes touch runways as little as possible. Default 300. */
  runwayPenaltyM?: number;
  /** Taxiway designators (any case) that are closed (NOTAM, `airportOps.closedTaxiways`): their edges are never used. */
  avoidTaxiways?: Iterable<string>;
}

export interface TaxiRoute {
  nodeIds: string[];
  /** Human taxiway sequence, consecutive duplicates collapsed, e.g. ["RAMP","B","A"]. */
  taxiways: string[];
  lengthM: number;
  /** Runway ids whose surface the route traverses, in order (crossings / runway travel). */
  runwayCrossings: string[];
  edgeIds: string[];
}

export interface RouteSearchResult {
  route: TaxiRoute | null;
  /** Present when route is null. */
  reason?: string;
}

export interface RouteValidation {
  valid: boolean;
  reason?: string;
  taxiways: string[];
  runwayCrossings: string[];
}

interface Arc {
  edge: TaxiEdge;
  to: string;
}

const adjacencyCache = new WeakMap<TaxiwayGraph, Map<string, Arc[]>>();

function adjacency(graph: TaxiwayGraph): Map<string, Arc[]> {
  let adj = adjacencyCache.get(graph);
  if (adj) return adj;
  adj = new Map();
  const push = (a: string, arc: Arc) => {
    const l = adj!.get(a);
    if (l) l.push(arc);
    else adj!.set(a, [arc]);
  };
  for (const e of graph.edges) {
    push(e.from, { edge: e, to: e.to });
    if (!e.oneWay) push(e.to, { edge: e, to: e.from });
  }
  adjacencyCache.set(graph, adj);
  return adj;
}

export function neighborIds(graph: TaxiwayGraph, nodeId: string): string[] {
  return (adjacency(graph).get(nodeId) ?? []).map((a) => a.to);
}

const up = (s: string) => s.toUpperCase();
const isRunwayTravel = (taxiway: string) => /^RWY/i.test(taxiway);

class MinHeap<T> {
  private items: { p: number; seq: number; v: T }[] = [];
  private seq = 0;
  get size(): number {
    return this.items.length;
  }
  push(p: number, v: T): void {
    const it = { p, seq: this.seq++, v };
    const a = this.items;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(a[i], a[parent])) {
        [a[i], a[parent]] = [a[parent], a[i]];
        i = parent;
      } else break;
    }
  }
  pop(): { p: number; v: T } | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  private less(x: { p: number; seq: number }, y: { p: number; seq: number }): boolean {
    return x.p < y.p || (x.p === y.p && x.seq < y.seq);
  }
}

function edgeAllowed(edge: TaxiEdge, opts: RouteOptions, viaSet: Set<string>, avoid?: ReadonlySet<string>): boolean {
  if (avoid && avoid.has(up(edge.taxiway))) return false;
  if (edge.onRunwayId) {
    const avoid = opts.avoidRunways ?? true;
    if (avoid && !(opts.allowedRunwayIds ?? []).some((r) => up(r) === up(edge.onRunwayId!))) return false;
  }
  if (isRunwayTravel(edge.taxiway) && !viaSet.has(up(edge.taxiway))) return false;
  return true;
}

function collapseTaxiways(edges: TaxiEdge[]): string[] {
  const out: string[] = [];
  for (const e of edges) if (out[out.length - 1] !== e.taxiway) out.push(e.taxiway);
  return out;
}

function runwaysOf(edges: TaxiEdge[]): string[] {
  const out: string[] = [];
  for (const e of edges) if (e.onRunwayId && out[out.length - 1] !== e.onRunwayId) out.push(e.onRunwayId);
  return out;
}

function viaSatisfied(edges: TaxiEdge[], via: string[]): boolean {
  let k = 0;
  for (const e of edges) if (k < via.length && up(e.taxiway) === up(via[k])) k++;
  return k === via.length;
}

function search(graph: TaxiwayGraph, from: string, to: string, opts: RouteOptions): TaxiRoute | null {
  const via = opts.via ?? [];
  const viaSet = new Set(via.map(up));
  const avoid = opts.avoidTaxiways ? new Set([...opts.avoidTaxiways].map(up)) : undefined;
  const adj = adjacency(graph);
  const penalty = opts.runwayPenaltyM ?? 300;
  // Dijkstra state is (node, via progress k, node we arrived from). Tracking the arrival node
  // forbids reversing straight back along the edge just used; otherwise the cheapest way to
  // "touch" a via taxiway is a one-edge poke onto it followed by a U-turn.
  const key = (n: string, k: number, p: string) => `${n}#${k}#${p}`;
  const nodeOf = new Map<string, string>();
  const best = new Map<string, number>();
  const prev = new Map<string, { key: string; edge: TaxiEdge } | null>();
  const heap = new MinHeap<{ n: string; k: number; p: string }>();
  const k0 = key(from, 0, '');
  best.set(k0, 0);
  prev.set(k0, null);
  nodeOf.set(k0, from);
  heap.push(0, { n: from, k: 0, p: '' });
  while (heap.size) {
    const top = heap.pop()!;
    const { n, k, p: from_ } = top.v;
    const ck = key(n, k, from_);
    if (top.p > (best.get(ck) ?? Infinity)) continue;
    if (n === to && k === via.length) {
      const edges: TaxiEdge[] = [];
      const nodes: string[] = [];
      let cur: string | undefined = ck;
      while (cur) {
        nodes.push(nodeOf.get(cur)!);
        const p: { key: string; edge: TaxiEdge } | null | undefined = prev.get(cur);
        if (!p) break;
        edges.push(p.edge);
        cur = p.key;
      }
      nodes.reverse();
      edges.reverse();
      return {
        nodeIds: nodes,
        taxiways: collapseTaxiways(edges),
        lengthM: edges.reduce((s, e) => s + e.lengthM, 0),
        runwayCrossings: runwaysOf(edges),
        edgeIds: edges.map((e) => e.id),
      };
    }
    for (const arc of adj.get(n) ?? []) {
      if (!edgeAllowed(arc.edge, opts, viaSet, avoid)) continue;
      if (arc.to === from_) continue;
      const nk = k < via.length && up(arc.edge.taxiway) === up(via[k]) ? k + 1 : k;
      let cost = arc.edge.lengthM;
      if (via.length && !viaSet.has(up(arc.edge.taxiway))) cost *= 2;
      // Charge the runway penalty once per crossing (when stepping onto a runway), not per
      // edge, so a long crossing built from many short edges is not mistaken for a detour.
      if (arc.edge.onRunwayId && prev.get(ck)?.edge.onRunwayId !== arc.edge.onRunwayId) cost += penalty;
      const c = top.p + cost;
      const nkey = key(arc.to, nk, n);
      if (c < (best.get(nkey) ?? Infinity) - 1e-9) {
        best.set(nkey, c);
        prev.set(nkey, { key: ck, edge: arc.edge });
        nodeOf.set(nkey, arc.to);
        heap.push(c, { n: arc.to, k: nk, p: n });
      }
    }
  }
  return null;
}

export function findTaxiRoute(graph: TaxiwayGraph, fromNodeId: string, toNodeId: string, opts: RouteOptions = {}): RouteSearchResult {
  if (!graph.nodes[fromNodeId]) return { route: null, reason: `Unknown start node ${fromNodeId}` };
  if (!graph.nodes[toNodeId]) return { route: null, reason: `Unknown destination node ${toNodeId}` };
  const via = opts.via ?? [];
  const known = new Set(graph.edges.map((e) => up(e.taxiway)));
  const missing = via.filter((v) => !known.has(up(v)));
  if (missing.length) return { route: null, reason: `Taxiway ${missing.join(', ')} does not exist on this airport` };
  const avoidSet = opts.avoidTaxiways ? new Set([...opts.avoidTaxiways].map(up)) : undefined;
  const closedVia = avoidSet ? via.filter((v) => avoidSet.has(up(v))) : [];
  if (closedVia.length) return { route: null, reason: `Taxiway ${closedVia.join(', ')} is closed` };

  const route = search(graph, fromNodeId, toNodeId, opts);
  if (route) {
    if (new Set(route.nodeIds).size !== route.nodeIds.length) {
      return { route: null, reason: `The only way to use taxiway ${via.join(' then ')} in that order would double back over the same taxiway` };
    }
    return { route };
  }

  // Diagnose.
  if (via.length) {
    const noVia = search(graph, fromNodeId, toNodeId, { ...opts, via: [] });
    if (noVia) return { route: null, reason: `No route reaches the destination using taxiway ${via.join(' then ')} in that order` };
  }
  const unrestricted = search(graph, fromNodeId, toNodeId, { ...opts, via: [], avoidRunways: false });
  if (unrestricted) {
    const rw = unrestricted.runwayCrossings.join(', ');
    return { route: null, reason: `The only route requires using runway ${rw}, which is not allowed in this instruction` };
  }
  return { route: null, reason: 'No connected taxi route exists between those points' };
}

/** Validate an explicit node path (connectivity, one-way, optional via order). */
export function validateRoute(graph: TaxiwayGraph, route: { nodeIds: string[] } | string[], via: string[] = []): RouteValidation {
  const nodeIds = Array.isArray(route) ? route : route.nodeIds;
  const adj = adjacency(graph);
  const edges: TaxiEdge[] = [];
  for (let i = 0; i < nodeIds.length; i++) {
    if (!graph.nodes[nodeIds[i]]) return { valid: false, reason: `Unknown node ${nodeIds[i]}`, taxiways: [], runwayCrossings: [] };
    if (i === 0) continue;
    const arc = (adj.get(nodeIds[i - 1]) ?? []).find((a) => a.to === nodeIds[i]);
    if (!arc) {
      return { valid: false, reason: `${nodeIds[i - 1]} is not connected to ${nodeIds[i]} (or one-way)`, taxiways: [], runwayCrossings: [] };
    }
    edges.push(arc.edge);
  }
  const taxiways = collapseTaxiways(edges);
  const runwayCrossings = runwaysOf(edges);
  if (via.length && !viaSatisfied(edges, via)) {
    return { valid: false, reason: `Route does not follow taxiways ${via.join(' then ')} in order`, taxiways, runwayCrossings };
  }
  return { valid: true, taxiways, runwayCrossings };
}

export function nearestNode(
  graph: TaxiwayGraph,
  pos: Vec2,
  opts: { kinds?: TaxiNodeKind[]; maxDistM?: number; filter?: (n: TaxiNode) => boolean } = {},
): TaxiNode | undefined {
  let best: TaxiNode | undefined;
  let bestD = opts.maxDistM ?? Infinity;
  for (const id of Object.keys(graph.nodes)) {
    const n = graph.nodes[id];
    if (opts.kinds && !opts.kinds.includes(n.kind)) continue;
    if (opts.filter && !opts.filter(n)) continue;
    const d = dist(n.pos, pos);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Holding-position nodes (those protecting a runway) along a node path, in order. */
export function holdingPositionsAlong(graph: TaxiwayGraph, nodeIds: string[]): TaxiNode[] {
  return nodeIds.map((id) => graph.nodes[id]).filter((n): n is TaxiNode => !!n && n.kind === 'holding_position' && !!n.runwayId);
}

/** Runway-surface nodes along a node path (for crossing detection), in order. */
export function runwayNodesAlong(graph: TaxiwayGraph, nodeIds: string[]): TaxiNode[] {
  return nodeIds.map((id) => graph.nodes[id]).filter((n): n is TaxiNode => !!n && n.kind === 'runway');
}

/** The taxiway of each segment of a node path: element `i` belongs to the edge between `nodeIds[i - 1]` and `nodeIds[i]` (element 0 is undefined). */
export function routeSegmentTaxiways(graph: TaxiwayGraph, nodeIds: readonly string[]): (string | undefined)[] {
  const adj = adjacency(graph);
  return nodeIds.map((id, i) => (i === 0 ? undefined : (adj.get(nodeIds[i - 1]) ?? []).find((a) => a.to === id)?.edge.taxiway));
}

/** Runway ids whose surface the node path traverses (via edge.onRunwayId), in order. */
export function runwayCrossingsAlong(graph: TaxiwayGraph, nodeIds: string[]): string[] {
  const adj = adjacency(graph);
  const edges: TaxiEdge[] = [];
  for (let i = 1; i < nodeIds.length; i++) {
    const arc = (adj.get(nodeIds[i - 1]) ?? []).find((a) => a.to === nodeIds[i]);
    if (arc) edges.push(arc.edge);
  }
  return runwaysOf(edges);
}

/** Shortest distances (m) from a node to every reachable node, not using runway surfaces. */
export function shortestDistances(graph: TaxiwayGraph, fromId: string, opts: { allowedRunwayIds?: string[]; avoidTaxiways?: Iterable<string> } = {}): Map<string, number> {
  const adj = adjacency(graph);
  const avoid = opts.avoidTaxiways ? new Set([...opts.avoidTaxiways].map(up)) : undefined;
  const distMap = new Map<string, number>([[fromId, 0]]);
  const heap = new MinHeap<string>();
  heap.push(0, fromId);
  while (heap.size) {
    const top = heap.pop()!;
    if (top.p > (distMap.get(top.v) ?? Infinity)) continue;
    for (const arc of adj.get(top.v) ?? []) {
      if (!edgeAllowed(arc.edge, { avoidRunways: true, allowedRunwayIds: opts.allowedRunwayIds }, new Set(), avoid)) continue;
      const c = top.p + arc.edge.lengthM;
      if (c < (distMap.get(arc.to) ?? Infinity)) {
        distMap.set(arc.to, c);
        heap.push(c, arc.to);
      }
    }
  }
  return distMap;
}
