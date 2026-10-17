/**
 * Geometry and unit helpers for the local frame (x east, y north, metres).
 * Headings are degrees clockwise from north.
 */
import type { Vec2 } from './types';

export const M_PER_FT = 0.3048;
export const M_PER_NM = 1852;
export const KT_TO_MPS = M_PER_NM / 3600;

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// --- units ------------------------------------------------------------------
export const ftToM = (ft: number): number => ft * M_PER_FT;
export const mToFt = (m: number): number => m / M_PER_FT;
export const nmToM = (nm: number): number => nm * M_PER_NM;
export const mToNm = (m: number): number => m / M_PER_NM;
export const ftToNm = (ft: number): number => mToNm(ftToM(ft));
export const nmToFt = (nm: number): number => mToFt(nmToM(nm));
export const ktToMps = (kt: number): number => kt * KT_TO_MPS;
export const mpsToKt = (mps: number): number => mps / KT_TO_MPS;
export const fpmToMps = (fpm: number): number => (fpm * M_PER_FT) / 60;

// --- headings ---------------------------------------------------------------
/** Normalise to [0, 360). */
export function normHeading(h: number): number {
  const r = h % 360;
  return r < 0 ? r + 360 : r;
}

/** Normalise an angle difference to (-180, 180]. */
export function normSigned(a: number): number {
  let r = normHeading(a);
  if (r > 180) r -= 360;
  return r;
}

/** Signed shortest turn from `from` to `to` in degrees: positive = turn right (clockwise). */
export function headingDiff(from: number, to: number): number {
  return normSigned(to - from);
}

/** Heading as a unit vector (east=x, north=y). */
export function headingToVec(h: number): Vec2 {
  const r = deg2rad(h);
  return { x: Math.sin(r), y: Math.cos(r) };
}

export function vecToHeading(v: Vec2): number {
  return normHeading(rad2deg(Math.atan2(v.x, v.y)));
}

/** True bearing from `a` to `b`. */
export function bearingDeg(a: Vec2, b: Vec2): number {
  return vecToHeading({ x: b.x - a.x, y: b.y - a.y });
}

/** magnetic = true - variation (variation east-positive). */
export function trueToMagnetic(trueDeg: number, variationEastDeg: number): number {
  return normHeading(trueDeg - variationEastDeg);
}
export function magneticToTrue(magDeg: number, variationEastDeg: number): number {
  return normHeading(magDeg + variationEastDeg);
}

const CARDINALS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;
/** 8-point compass word for a bearing. */
export function cardinal(bearing: number): string {
  return CARDINALS[Math.round(normHeading(bearing) / 45) % 8];
}

// --- vectors ----------------------------------------------------------------
export const vAdd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vSub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vScale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const vDot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** z-component of a x b. */
export const vCross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const vLen = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export function vNorm(a: Vec2): Vec2 {
  const l = vLen(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}
export const vLerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const vClone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });

// --- polygons / segments ----------------------------------------------------
/** Ray-casting point-in-polygon. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = vSub(b, a);
  const l2 = vDot(ab, ab);
  if (l2 < 1e-12) return vClone(a);
  const t = clamp(vDot(vSub(p, a), ab) / l2, 0, 1);
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

export function distancePointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  return dist(p, closestPointOnSegment(p, a, b));
}

function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = vCross(vSub(p4, p3), vSub(p1, p3));
  const d2 = vCross(vSub(p4, p3), vSub(p2, p3));
  const d3 = vCross(vSub(p2, p1), vSub(p3, p1));
  const d4 = vCross(vSub(p2, p1), vSub(p4, p1));
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** True if two simple polygons overlap (edge crossing or containment). */
export function polygonsOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

/** Total length of a polyline. */
export function polylineLength(pts: readonly Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}
