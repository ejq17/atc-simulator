/** Small pure geometry helpers for the displays (local frame: x east, y north, metres). */
import type { Vec2 } from '../../sim/types';

export const M_PER_NM = 1852;
export const deg2rad = (d: number) => (d * Math.PI) / 180;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Interpolate headings along the shortest arc (degrees). */
export function lerpAngleDeg(a: number, b: number, t: number): number {
  let d = (((b - a) % 360) + 540) % 360 - 180;
  if (d === -180) d = 180;
  return (a + d * t + 360) % 360;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Unit vector for a TRUE heading in the local frame. */
export function headingVec(deg: number): Vec2 {
  const r = deg2rad(deg);
  return { x: Math.sin(r), y: Math.cos(r) };
}

/** Distance from point p to segment ab. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function polylineLength(pts: readonly Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

/** "Nice" scale-bar length (1, 2, 5 x 10^n) not exceeding `maxMetres`. */
export function niceLength(maxMetres: number): number {
  if (maxMetres <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(maxMetres)));
  for (const m of [5, 2, 1]) if (m * p <= maxMetres) return m * p;
  return p;
}

/** Area centroid of a simple polygon (falls back to the vertex mean for degenerate shapes). */
export function polygonCentroid(pts: readonly Vec2[]): Vec2 {
  if (pts.length === 0) return { x: 0, y: 0 };
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-6) return { x: pts.reduce((m, p) => m + p.x, 0) / pts.length, y: pts.reduce((m, p) => m + p.y, 0) / pts.length };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}
