/**
 * Planar-graph construction for an airport taxiway network.
 *
 * Input: polylines (OSM ways) in local metres. Output: a planar arrangement
 * where every shared point is a node, ways that cross or touch are split at the
 * junction, and runway centrelines are woven in with their entry/exit/crossing
 * nodes. Every `PWay` keeps its ordered node list, which is the single source of
 * truth for edges and for rendered polylines.
 */
import { dist, projectOnSegment, segIntersect } from './geom';
import type { P } from './geom';

export interface PWayIn {
  key: string;
  osmId: number | null;
  ref: string | null;
  pts: P[];
}

export interface PWay {
  key: string;
  osmId: number | null;
  /** Identifier used for edges (may be inferred later). */
  ref: string | null;
  /** Identifier as tagged in OSM (null = untagged). */
  origRef: string | null;
  kind: 'taxiway' | 'runway';
  runwayId?: string;
  nodes: number[];
}

export interface RunwayDef {
  id: string; // "13/31"
  a: P;
  b: P;
}

export class Planar {
  pos: P[] = [];
  alive: boolean[] = [];
  ways: PWay[] = [];
  pinned = new Set<number>();
  /** runway id -> node ids lying on its centreline (including thresholds). */
  runwayNodes = new Map<string, Set<number>>();
  runways: RunwayDef[] = [];
  notes: string[] = [];

  addNode(p: P): number {
    this.pos.push({ x: p.x, y: p.y });
    this.alive.push(true);
    return this.pos.length - 1;
  }

  /** 1. Merge vertices of different ways within `snap` metres (shared OSM nodes are distance 0). */
  init(inputs: PWayIn[], snap: number): void {
    const verts: { w: number; i: number; p: P }[] = [];
    inputs.forEach((w, wi) => w.pts.forEach((p, i) => verts.push({ w: wi, i, p })));
    const parent = verts.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let i = 0; i < verts.length; i++) {
      for (let j = i + 1; j < verts.length; j++) {
        if (verts[i].w !== verts[j].w && dist(verts[i].p, verts[j].p) <= snap) {
          const a = find(i);
          const b = find(j);
          if (a !== b) parent[b] = a;
        }
      }
    }
    const clusterNode = new Map<number, number>();
    const members = new Map<number, number[]>();
    verts.forEach((_, i) => {
      const r = find(i);
      if (!members.has(r)) members.set(r, []);
      members.get(r)!.push(i);
    });
    for (const [r, ms] of members) {
      const p = { x: ms.reduce((s, m) => s + verts[m].p.x, 0) / ms.length, y: ms.reduce((s, m) => s + verts[m].p.y, 0) / ms.length };
      clusterNode.set(r, this.addNode(p));
    }
    let vi = 0;
    inputs.forEach((w) => {
      const nodes: number[] = [];
      for (let i = 0; i < w.pts.length; i++, vi++) {
        const n = clusterNode.get(find(vi))!;
        if (nodes[nodes.length - 1] !== n) nodes.push(n);
      }
      if (nodes.length >= 2) {
        this.ways.push({ key: w.key, osmId: w.osmId, ref: w.ref, origRef: w.ref, kind: 'taxiway', nodes });
      } else {
        this.notes.push(`way ${w.key} collapsed to a single node after ${snap} m snapping and was dropped`);
      }
    });
  }

  /** 2. Split ways wherever another way's node touches the middle of one of their segments. */
  tJunctions(snap: number, kind: 'taxiway' = 'taxiway'): number {
    let total = 0;
    for (let iter = 0; iter < 10; iter++) {
      let changed = false;
      for (let n = 0; n < this.pos.length; n++) {
        if (!this.alive[n]) continue;
        for (const w of this.ways) {
          if (w.kind !== kind || w.nodes.includes(n)) continue;
          for (let k = 0; k < w.nodes.length - 1; k++) {
            const a = w.nodes[k];
            const b = w.nodes[k + 1];
            const pr = projectOnSegment(this.pos[n], this.pos[a], this.pos[b]);
            const len = dist(this.pos[a], this.pos[b]);
            if (pr.d <= snap && pr.t * len > 0.3 && (1 - pr.t) * len > 0.3) {
              w.nodes.splice(k + 1, 0, n);
              changed = true;
              total++;
              break;
            }
          }
        }
      }
      if (!changed) break;
    }
    return total;
  }

  /** 3. Insert nodes where segments of different taxiway ways properly cross. */
  crossings(): number {
    const splits = new Map<string, { t: number; node: number }[]>();
    const push = (w: number, k: number, t: number, node: number) => {
      const key = `${w}:${k}`;
      if (!splits.has(key)) splits.set(key, []);
      splits.get(key)!.push({ t, node });
    };
    let count = 0;
    for (let wi = 0; wi < this.ways.length; wi++) {
      for (let wj = wi + 1; wj < this.ways.length; wj++) {
        const A = this.ways[wi];
        const B = this.ways[wj];
        if (A.kind !== 'taxiway' || B.kind !== 'taxiway') continue;
        for (let ia = 0; ia < A.nodes.length - 1; ia++) {
          for (let ib = 0; ib < B.nodes.length - 1; ib++) {
            const a = A.nodes[ia];
            const b = A.nodes[ia + 1];
            const c = B.nodes[ib];
            const d = B.nodes[ib + 1];
            if (a === c || a === d || b === c || b === d) continue;
            const hit = segIntersect(this.pos[a], this.pos[b], this.pos[c], this.pos[d]);
            if (!hit) continue;
            const n = this.addNode(hit.p);
            push(wi, ia, hit.t, n);
            push(wj, ib, hit.u, n);
            count++;
          }
        }
      }
    }
    this.applySplits(splits);
    return count;
  }

  private applySplits(splits: Map<string, { t: number; node: number }[]>): void {
    this.ways.forEach((w, wi) => {
      const out: number[] = [];
      for (let k = 0; k < w.nodes.length; k++) {
        out.push(w.nodes[k]);
        const s = splits.get(`${wi}:${k}`);
        if (s) {
          s.sort((x, y) => x.t - y.t);
          for (const e of s) out.push(e.node);
        }
      }
      w.nodes = out;
    });
  }

  mergeNodes(keep: number, drop: number, newPos?: P): void {
    if (keep === drop) return;
    for (const w of this.ways) {
      if (!w.nodes.includes(drop)) continue;
      const out: number[] = [];
      for (const n of w.nodes) {
        const m = n === drop ? keep : n;
        if (out[out.length - 1] !== m) out.push(m);
      }
      w.nodes = out;
    }
    if (this.pinned.has(drop)) this.pinned.add(keep);
    for (const set of this.runwayNodes.values()) {
      if (set.delete(drop)) set.add(keep);
    }
    this.alive[drop] = false;
    if (newPos) this.pos[keep] = { x: newPos.x, y: newPos.y };
  }

  /** 4. Contract edges shorter than `minLen` (never merges two pinned nodes). */
  contractTiny(minLen: number): number {
    let total = 0;
    for (let guard = 0; guard < 1000; guard++) {
      let did = false;
      outer: for (const w of this.ways) {
        for (let k = 0; k < w.nodes.length - 1; k++) {
          const a = w.nodes[k];
          const b = w.nodes[k + 1];
          if (dist(this.pos[a], this.pos[b]) >= minLen) continue;
          const pa = this.pinned.has(a);
          const pb = this.pinned.has(b);
          if (pa && pb) continue;
          if (pa) this.mergeNodes(a, b);
          else if (pb) this.mergeNodes(b, a);
          else {
            const mid = { x: (this.pos[a].x + this.pos[b].x) / 2, y: (this.pos[a].y + this.pos[b].y) / 2 };
            this.mergeNodes(a, b, mid);
          }
          total++;
          did = true;
          break outer;
        }
      }
      this.ways = this.ways.filter((w) => w.nodes.length >= 2);
      if (!did) break;
    }
    return total;
  }

  private isWayEnd(n: number): boolean {
    return this.ways.some((w) => w.kind === 'taxiway' && (w.nodes[0] === n || w.nodes[w.nodes.length - 1] === n));
  }

  /** 5. Weave runway centrelines into the network. Returns per-runway entry nodes. */
  attachRunways(runways: RunwayDef[], snap: number): void {
    this.runways = runways;
    for (const r of runways) {
      const na = this.addNode(r.a);
      const nb = this.addNode(r.b);
      this.pinned.add(na);
      this.pinned.add(nb);
      this.runwayNodes.set(r.id, new Set([na, nb]));
    }
    for (const r of runways) {
      const set = this.runwayNodes.get(r.id)!;
      // (a) taxiway way ends within `snap` of the centreline are snapped onto it
      for (let n = 0; n < this.pos.length; n++) {
        if (!this.alive[n] || this.pinned.has(n) || !this.isWayEnd(n)) continue;
        const pr = projectOnSegment(this.pos[n], r.a, r.b);
        if (pr.d <= snap) {
          // a taxiway that ends within 1.5 m of a runway threshold joins the threshold node (otherwise the runway gets a second node < 0.5 m away)
          const na = [...set].find((q) => this.alive[q] && (dist(this.pos[q], r.a) < 1e-6 || dist(this.pos[q], r.b) < 1e-6) && dist(this.pos[q], pr.q) < 1.5);
          if (na !== undefined) {
            this.mergeNodes(na, n);
            continue;
          }
          this.pos[n] = pr.q;
          this.pinned.add(n);
          set.add(n);
        }
      }
      // (b) taxiway segments that properly cross the centreline
      for (const w of this.ways) {
        if (w.kind !== 'taxiway') continue;
        for (let k = 0; k < w.nodes.length - 1; k++) {
          const a = w.nodes[k];
          const b = w.nodes[k + 1];
          const hit = segIntersect(this.pos[a], this.pos[b], r.a, r.b);
          if (!hit) continue;
          let v: number;
          if (dist(hit.p, this.pos[a]) <= snap && !this.pinned.has(a)) v = a;
          else if (dist(hit.p, this.pos[b]) <= snap && !this.pinned.has(b)) v = b;
          else {
            v = this.addNode(hit.p);
            w.nodes.splice(k + 1, 0, v);
          }
          this.pos[v] = hit.p;
          this.pinned.add(v);
          set.add(v);
        }
      }
    }
    // (c) any two centrelines intersect: one shared node per intersection (none for parallel runways)
    for (let i = 0; i < runways.length; i++) {
      for (let j = i + 1; j < runways.length; j++) {
        const [r1, r2] = [runways[i], runways[j]];
        const hit = segIntersect(r1.a, r1.b, r2.a, r2.b);
        if (hit) {
          const x = this.addNode(hit.p);
          this.pinned.add(x);
          this.runwayNodes.get(r1.id)!.add(x);
          this.runwayNodes.get(r2.id)!.add(x);
          this.notes.push(`runway centrelines ${r1.id} and ${r2.id} intersect at local (${hit.p.x.toFixed(1)}, ${hit.p.y.toFixed(1)})`);
        }
      }
    }
    // (d) build the runway ways, nodes sorted along the centreline
    for (const r of runways) {
      const set = this.runwayNodes.get(r.id)!;
      const sorted = [...set].filter((n) => this.alive[n]).sort((p, q) => projectOnSegment(this.pos[p], r.a, r.b).t - projectOnSegment(this.pos[q], r.a, r.b).t);
      this.ways.push({ key: `RWY${r.id}`, osmId: null, ref: `RWY${r.id}`, origRef: `RWY${r.id}`, kind: 'runway', runwayId: r.id, nodes: sorted });
    }
  }

  /**
   * 5b. Collapse mapped turn-on fillets. Some airports map each runway entrance as the straight crossing taxiway PLUS short untagged
   * curves from that taxiway to the runway centreline on either side. Those curves would each become an extra runway entry whose
   * hold line is far from the runway node, so the exit/entry logic (runway node adjacent to its hold) cannot use them. An untagged
   * taxiway way is dropped when one end is pinned to a runway centreline, it is shorter than `maxLenM`, and its other end lies on a
   * NAMED way that itself reaches the same runway centreline within `reachM` along its own nodes. Returns the dropped ways.
   */
  collapseFillets(maxLenM: number, reachM: number): PWay[] {
    const dropped: PWay[] = [];
    const lenOf = (w: PWay): number => w.nodes.slice(1).reduce((s, n, i) => s + dist(this.pos[w.nodes[i]], this.pos[n]), 0);
    for (const w of Array.from(this.ways)) {
      if (w.kind !== 'taxiway' || w.ref || w.origRef) continue;
      const a = w.nodes[0];
      const b = w.nodes[w.nodes.length - 1];
      for (const [runEnd, far] of [[a, b], [b, a]] as [number, number][]) {
        if (!this.pinned.has(runEnd) || this.pinned.has(far)) continue;
        if (lenOf(w) > maxLenM) continue;
        const rids = [...this.runwayNodes.entries()].filter(([, set]) => set.has(runEnd)).map(([id]) => id);
        if (rids.length !== 1) continue;
        const set = this.runwayNodes.get(rids[0])!;
        const through = this.ways.find((v) => {
          if (v === w || v.kind !== 'taxiway' || !v.ref || !v.nodes.includes(far)) return false;
          return v.nodes.some((n) => n !== far && set.has(n) && dist(this.pos[n], this.pos[far]) <= reachM);
        });
        if (!through) continue;
        dropped.push(w);
        break;
      }
    }
    if (dropped.length) {
      const gone = new Set(dropped);
      this.ways = this.ways.filter((w) => !gone.has(w));
    }
    return dropped;
  }

  /** Insert `node` into every way that has the consecutive pair (a, b). Returns how many ways were updated. */
  insertOnEdge(a: number, b: number, node: number): number {
    let n = 0;
    for (const w of this.ways) {
      for (let k = 0; k < w.nodes.length - 1; k++) {
        const x = w.nodes[k];
        const y = w.nodes[k + 1];
        if ((x === a && y === b) || (x === b && y === a)) {
          w.nodes.splice(k + 1, 0, node);
          n++;
          break;
        }
      }
    }
    return n;
  }

  /** Unique undirected edges (a<b key) with the ways that carry them. */
  edgeList(): { a: number; b: number; ways: PWay[] }[] {
    const m = new Map<string, { a: number; b: number; ways: PWay[] }>();
    for (const w of this.ways) {
      for (let k = 0; k < w.nodes.length - 1; k++) {
        const a = w.nodes[k];
        const b = w.nodes[k + 1];
        if (a === b) continue;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        let e = m.get(key);
        if (!e) {
          e = { a, b, ways: [] };
          m.set(key, e);
        }
        e.ways.push(w);
      }
    }
    return [...m.values()];
  }
}
