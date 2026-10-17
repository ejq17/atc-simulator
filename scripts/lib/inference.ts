/**
 * Identifier inference for taxiway ways that OSM left untagged.
 * Rules (in order, iterated to a fixed point):
 *  1. continuity: the way's end touches a named way and continues straight on
 *     (outgoing bearings within 20 degrees of a straight continuation);
 *  2. label proximity: the way is the nearest way (named or not) to an FAA
 *     diagram label and lies within `labelMaxM` of it.
 * Everything else is left unresolved (taxiways: []) and reported.
 */
import { angDiff, bearing, dist, distToPolyline } from './geom';
import type { P } from './geom';
import type { Planar, PWay } from './planar';

export interface DiagramLabel {
  id: string;
  p: P;
  /** diagram word bbox centre in PDF points (provenance) */
  pt: { x: number; y: number };
}

export interface Decision {
  osmId: number | null;
  key: string;
  ref: string | null;
  method: 'continuity' | 'label-proximity' | 'unresolved' | 'excluded';
  detail: string;
}

const LOOKAHEAD_M = 8;

/** Bearing leaving `node` along way `w` in direction `dir` (+1 = increasing index, -1 = decreasing). */
function outgoingBearing(pl: Planar, w: PWay, idx: number, dir: 1 | -1): number | null {
  const start = pl.pos[w.nodes[idx]];
  let acc = 0;
  let prev = start;
  for (let k = idx + dir; k >= 0 && k < w.nodes.length; k += dir) {
    const q = pl.pos[w.nodes[k]];
    acc += dist(prev, q);
    prev = q;
    if (acc >= LOOKAHEAD_M) return bearing(start, q);
  }
  return acc > 0 ? bearing(start, prev) : null;
}

export function inferIdentifiers(
  pl: Planar,
  labels: DiagramLabel[],
  opts: { labelMaxM: number; contAngleDeg: number; excludeKeys: Set<string> },
): Decision[] {
  const decisions: Decision[] = [];
  const taxi = pl.ways.filter((w) => w.kind === 'taxiway' && !opts.excludeKeys.has(w.key));
  for (const w of pl.ways) {
    if (opts.excludeKeys.has(w.key)) {
      decisions.push({
        osmId: w.osmId,
        key: w.key,
        ref: null,
        method: 'excluded',
        detail: `OSM ref "${w.origRef ?? ''}" is not an FAA taxiway identifier and does not appear on the airport diagram; geometry kept (apron/ramp lane) but no identifier is assigned`,
      });
    }
  }
  // label -> nearest way (any way, named or not)
  const nearestWayOfLabel = new Map<DiagramLabel, { w: PWay; d: number }>();
  for (const l of labels) {
    let best: { w: PWay; d: number } | null = null;
    for (const w of taxi) {
      const d = distToPolyline(l.p, w.nodes.map((n) => pl.pos[n]));
      if (!best || d < best.d) best = { w, d };
    }
    if (best && best.d <= opts.labelMaxM) nearestWayOfLabel.set(l, best);
  }
  const polyOf = (w: PWay): P[] => w.nodes.map((n) => pl.pos[n]);

  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const w of taxi) {
      if (w.ref) continue;
      // --- rule 1: continuity
      const cands = new Map<string, number>(); // ref -> smallest angle
      for (const end of [0, w.nodes.length - 1]) {
        const node = w.nodes[end];
        const wDir: 1 | -1 = end === 0 ? 1 : -1;
        const wb = outgoingBearing(pl, w, end, wDir);
        if (wb === null) continue;
        for (const v of taxi) {
          if (v === w || !v.ref) continue;
          v.nodes.forEach((n, vi) => {
            if (n !== node) return;
            for (const vDir of [1, -1] as const) {
              const k = vi + vDir;
              if (k < 0 || k >= v.nodes.length) continue;
              const vb = outgoingBearing(pl, v, vi, vDir);
              if (vb === null) continue;
              const a = angDiff(wb, (vb + 180) % 360); // straight continuation: W leaves opposite to V's outgoing
              if (a <= opts.contAngleDeg && a < (cands.get(v.ref!) ?? 1e9)) cands.set(v.ref!, a);
            }
          });
        }
      }
      if (cands.size >= 1) {
        const sorted = [...cands.entries()].sort((x, y) => x[1] - y[1]);
        const [ref, ang] = sorted[0];
        w.ref = ref;
        decisions.push({
          osmId: w.osmId,
          key: w.key,
          ref,
          method: 'continuity',
          detail: `continues ${ref} straight on (${ang.toFixed(0)} deg off)${sorted.length > 1 ? `; also touched ${sorted.slice(1).map((s) => `${s[0]} (${s[1].toFixed(0)} deg)`).join(', ')}` : ''}`,
        });
        changed = true;
        continue;
      }
      // --- rule 2: label proximity (this way is the nearest way to a diagram label)
      const mine = [...nearestWayOfLabel.entries()].filter(([, v]) => v.w === w).sort((x, y) => x[1].d - y[1].d);
      if (mine.length) {
        const [best, bd] = mine[0];
        w.ref = best.id;
        decisions.push({
          osmId: w.osmId,
          key: w.key,
          ref: best.id,
          method: 'label-proximity',
          detail: `FAA diagram label "${best.id}" is ${bd.d.toFixed(0)} m from the way and this is the closest way to that label${mine.length > 1 ? `; other labels nearest to this way: ${mine.slice(1).map(([l, v]) => `${l.id} ${v.d.toFixed(0)} m`).join(', ')}` : ''}`,
        });
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const w of taxi) {
    if (!w.ref) {
      const poly = polyOf(w);
      const near = labels
        .map((l) => ({ l, d: distToPolyline(l.p, poly) }))
        .sort((a, b) => a.d - b.d)[0];
      decisions.push({
        osmId: w.osmId,
        key: w.key,
        ref: null,
        method: 'unresolved',
        detail: near ? `no straight continuation from a named way and no diagram label within ${opts.labelMaxM} m (nearest label ${near.l.id} at ${near.d.toFixed(0)} m)` : 'no diagram labels available',
      });
    }
  }
  return decisions;
}
