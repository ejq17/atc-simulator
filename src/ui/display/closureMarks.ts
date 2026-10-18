/**
 * Geometry of the closure markings the Surface display draws (the Tower view builds its own meshes from the same functions):
 * a yellow X across a temporarily closed runway at each end, on or near the designation numbers (FAA AC 150/5370-2G 2.18.2.1.2, Figure 2-3;
 * "runways and runway exit taxiways closed to aircraft operations are marked with a yellow X", 2.18.2), and X markers on a closed taxiway.
 * Pure world geometry (metres, y up): no canvas, no three.js.
 */
import type { Runway, Vec2 } from '../../sim/types';

export interface XMark {
  center: Vec2;
  /** The two strokes of the X, world coordinates. */
  segments: [[Vec2, Vec2], [Vec2, Vec2]];
}

/** An X of half-extent `halfM` centred at `c`, its arms at 45 degrees to the axis direction `dir` (unit vector). */
export function xMark(c: Vec2, dir: Vec2, halfM: number): XMark {
  const right = { x: dir.y, y: -dir.x };
  const k = halfM;
  const p = (a: number, b: number): Vec2 => ({ x: c.x + dir.x * a * k + right.x * b * k, y: c.y + dir.y * a * k + right.y * b * k });
  return { center: c, segments: [[p(-1, -1), p(1, 1)], [p(-1, 1), p(1, -1)]] };
}

/** AC 150/5370-2G 2.18.2.1.2: "place an X at each end of the runway directly on or as near as practicable to the runway designation numbers". */
export const RUNWAY_X_INSET_M = 150;

/** The two X marks of a closed runway (one near each end, inside the threshold). */
export function closedRunwayMarks(rw: Pick<Runway, 'ends' | 'widthFt'>, insetM = RUNWAY_X_INSET_M): XMark[] {
  const [a, b] = rw.ends;
  const dx = b.threshold.x - a.threshold.x;
  const dy = b.threshold.y - a.threshold.y;
  const len = Math.hypot(dx, dy) || 1;
  const dir = { x: dx / len, y: dy / len };
  const half = Math.min(30, (rw.widthFt * 0.3048) / 2 * 0.9);
  return [
    xMark({ x: a.threshold.x + dir.x * insetM, y: a.threshold.y + dir.y * insetM }, dir, half),
    xMark({ x: b.threshold.x - dir.x * insetM, y: b.threshold.y - dir.y * insetM }, { x: -dir.x, y: -dir.y }, half),
  ];
}

/** X marks along a closed taxiway: at both ends of each polyline and about every `spacingM` between them. */
export function closedTaxiwayMarks(lines: readonly (readonly Vec2[])[], halfM = 12, spacingM = 220): XMark[] {
  const out: XMark[] = [];
  for (const pts of lines) {
    if (pts.length < 2) continue;
    const segLen: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); segLen.push(d); total += d; }
    if (total < 1) continue;
    const n = Math.max(1, Math.round(total / spacingM));
    for (let k = 0; k <= n; k++) {
      let d = (k * total) / n;
      // end marks are pulled slightly inside the polyline so the X is on the pavement
      d = Math.min(total - halfM, Math.max(halfM, d));
      let acc = 0;
      for (let i = 0; i < segLen.length; i++) {
        if (acc + segLen[i] >= d || i === segLen.length - 1) {
          const t = segLen[i] === 0 ? 0 : (d - acc) / segLen[i];
          const a = pts[i];
          const b = pts[i + 1];
          const dir = { x: (b.x - a.x) / (segLen[i] || 1), y: (b.y - a.y) / (segLen[i] || 1) };
          out.push(xMark({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir, halfM));
          break;
        }
        acc += segLen[i];
      }
    }
  }
  return out;
}
