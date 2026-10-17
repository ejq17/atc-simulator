/** Small 2-D geometry helpers for the KACY build script (local metres). */
export type P = { x: number; y: number };

export const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Bearing in degrees (0 = north = +y, clockwise) from a to b. */
export function bearing(a: P, b: P): number {
  const d = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}

export function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

export interface SegProj {
  t: number; // unclamped parameter along a->b
  q: P; // closest point on the finite segment
  d: number; // distance from p to q
}

export function projectOnSegment(p: P, a: P, b: P): SegProj {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  const tc = Math.max(0, Math.min(1, t));
  const q = { x: a.x + dx * tc, y: a.y + dy * tc };
  return { t, q, d: Math.hypot(p.x - q.x, p.y - q.y) };
}

export interface SegHit {
  t: number; // along a->b
  u: number; // along c->d
  p: P;
}

/** Proper intersection of segments ab and cd (parameters strictly inside both by `eps`). */
export function segIntersect(a: P, b: P, c: P, d: P, eps = 1e-9): SegHit | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return { t, u, p: { x: a.x + rx * t, y: a.y + ry * t } };
}

export function polylineLength(pts: P[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

export function pointInPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonCentroid(poly: P[]): P {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Distance from p to the boundary of a polygon. */
export function distToPolygonEdge(p: P, poly: P[]): number {
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const r = projectOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (r.d < m) m = r.d;
  }
  return m;
}

export function distToPolyline(p: P, pts: P[]): number {
  let m = Infinity;
  for (let i = 1; i < pts.length; i++) m = Math.min(m, projectOnSegment(p, pts[i - 1], pts[i]).d);
  return m;
}

export const r2 = (n: number): number => Math.round(n * 100) / 100;
export const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
