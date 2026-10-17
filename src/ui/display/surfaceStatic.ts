/**
 * Static (per-airport) geometry derived once for the surface display: taxiway label placements,
 * hold-line ticks and runway number placements. Pure and unit-tested.
 */
import type { Airport, Runway, RunwayEnd, Vec2 } from '../../sim/types';
import { boundsOf } from './viewTransform';
import type { Bounds } from './viewTransform';
import { dist, polylineLength } from '../lib/geom';

export interface TaxiLabel {
  name: string;
  x: number;
  y: number;
  /** World angle of the line in degrees, counter-clockwise from east, normalised to (-90, 90] so text stays upright. */
  angleDeg: number;
}

/** Normalise a line angle so text drawn along it is never upside down. */
export function uprightAngleDeg(angleDeg: number): number {
  let a = ((angleDeg % 360) + 360) % 360;
  if (a > 180) a -= 360;
  if (a > 90) a -= 180;
  if (a <= -90) a += 180;
  return a;
}

function pointAt(pts: readonly Vec2[], d: number): { p: Vec2; angleDeg: number } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (acc + seg >= d || i === pts.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, Math.max(0, (d - acc) / seg));
      const a = pts[i - 1];
      const b = pts[i];
      return {
        p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        angleDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      };
    }
    acc += seg;
  }
  return { p: pts[0], angleDeg: 0 };
}

export interface LabelOptions {
  /** Target spacing of labels along one polyline. */
  intervalM?: number;
  /** Labels with the same name closer than this are dropped. */
  sameNameSpacingM?: number;
  /** Any two labels closer than this are dropped (avoids overprint). */
  anySpacingM?: number;
  /** Polylines shorter than this get no label. */
  minLengthM?: number;
}

/**
 * Place taxiway identifier labels along each named polyline roughly every `intervalM`, rotated to the line,
 * de-duplicated so no label crowds another. 'UNNAMED' lanes never get labels.
 */
export function placeTaxiwayLabels(polylines: Record<string, Vec2[][]>, opts: LabelOptions = {}): TaxiLabel[] {
  const interval = opts.intervalM ?? 400;
  const sameName = opts.sameNameSpacingM ?? 160;
  const anySpacing = opts.anySpacingM ?? 45;
  const minLen = opts.minLengthM ?? 25;
  const out: TaxiLabel[] = [];
  const names = Object.keys(polylines).filter((n) => n !== 'UNNAMED').sort();
  // Longest polylines first so the best-represented segments claim label slots.
  const cands: { name: string; pts: Vec2[]; len: number }[] = [];
  for (const name of names) for (const pts of polylines[name]) {
    const len = polylineLength(pts);
    if (len >= minLen) cands.push({ name, pts, len });
  }
  cands.sort((a, b) => b.len - a.len);
  for (const { name, pts, len } of cands) {
    const n = Math.max(1, Math.round(len / interval));
    for (let i = 0; i < n; i++) {
      const d = ((i + 0.5) * len) / n;
      const { p, angleDeg } = pointAt(pts, d);
      const clash = out.some((l) => {
        const dd = Math.hypot(l.x - p.x, l.y - p.y);
        return dd < anySpacing || (l.name === name && dd < sameName);
      });
      if (!clash) out.push({ name, x: p.x, y: p.y, angleDeg: uprightAngleDeg(angleDeg) });
    }
  }
  return out;
}

export interface RunwayLabel {
  text: string;
  x: number;
  y: number;
  /** World angle (deg CCW from east), upright. */
  angleDeg: number;
  /** TRUE heading of landing on this end, for the pilot-orientation option. */
  headingDeg: number;
  endId: string;
}

/**
 * Runway number placed `insetM` inside the threshold of each end, so "13" sits at the 13 threshold and
 * "31" at the opposite end. Text is rotated along the runway axis and kept upright.
 */
export function runwayLabels(rw: Runway, insetM = 110): RunwayLabel[] {
  const [a, b] = rw.ends;
  return rw.ends.map((e: RunwayEnd, i) => {
    const other = i === 0 ? b : a;
    const dx = other.threshold.x - e.threshold.x;
    const dy = other.threshold.y - e.threshold.y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      text: e.id,
      endId: e.id,
      x: e.threshold.x + (dx / len) * insetM,
      y: e.threshold.y + (dy / len) * insetM,
      angleDeg: uprightAngleDeg((Math.atan2(dy, dx) * 180) / Math.PI),
      headingDeg: e.trueHeadingDeg,
    };
  });
}

export interface HoldMark {
  nodeId: string;
  pos: Vec2;
  runwayId: string;
  /** Unit vector of the tick (parallel to the runway). */
  dir: Vec2;
  /** Unit vector pointing away from the runway centreline (label side). */
  away: Vec2;
}

export function holdMarks(airport: Airport): HoldMark[] {
  const out: HoldMark[] = [];
  for (const n of Object.values(airport.taxiwayGraph.nodes)) {
    if (n.kind !== 'holding_position' || !n.runwayId) continue;
    const rw = airport.runways.find((r) => r.id === n.runwayId);
    if (!rw) continue;
    const a = rw.ends[0].threshold;
    const b = rw.ends[1].threshold;
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    // Signed distance of the node from the runway centreline decides which side is "away".
    const side = (n.pos.x - a.x) * -dir.y + (n.pos.y - a.y) * dir.x;
    const away = side >= 0 ? { x: -dir.y, y: dir.x } : { x: dir.y, y: -dir.x };
    out.push({ nodeId: n.id, pos: n.pos, runwayId: n.runwayId, dir, away });
  }
  return out;
}

export interface SurfaceStatic {
  bounds: Bounds;
  taxiLabels: TaxiLabel[];
  runwayLabels: RunwayLabel[];
  holds: HoldMark[];
  parking: { id: string; name: string; pos: Vec2 }[];
  hs1?: Vec2;
}

const cache = new WeakMap<Airport, SurfaceStatic>();

export function buildSurfaceStatic(airport: Airport): SurfaceStatic {
  const hit = cache.get(airport);
  if (hit) return hit;
  const pts: Vec2[] = [];
  for (const r of airport.runways) pts.push(...r.polygon);
  for (const a of airport.taxiwayGraph.aprons) pts.push(...a);
  for (const lines of Object.values(airport.taxiwayGraph.taxiwayPolylines)) for (const l of lines) pts.push(...l);
  const built: SurfaceStatic = {
    bounds: boundsOf(pts.length ? pts : [{ x: -1500, y: -800 }, { x: 1500, y: 800 }]),
    taxiLabels: placeTaxiwayLabels(airport.taxiwayGraph.taxiwayPolylines),
    runwayLabels: airport.runways.flatMap((r) => runwayLabels(r)),
    holds: holdMarks(airport),
    parking: airport.parking.map((p) => ({ id: p.id, name: p.name, pos: p.pos })),
    hs1: airport.hotSpots.find((h) => h.id === 'HS 1')?.pos ?? airport.hotSpots[0]?.pos,
  };
  cache.set(airport, built);
  return built;
}
