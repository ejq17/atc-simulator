/**
 * World <-> screen mapping shared by both displays.
 * World: metres, x east, y NORTH (up). Screen: CSS pixels, y DOWN. North is always up.
 */
import type { Vec2 } from '../../sim/types';
import { clamp } from '../lib/geom';

export interface View {
  /** World point shown at the canvas centre. */
  cx: number;
  cy: number;
  /** Pixels per metre. */
  scale: number;
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

export function worldToScreen(v: View, p: Vec2): Vec2 {
  return { x: v.width / 2 + (p.x - v.cx) * v.scale, y: v.height / 2 - (p.y - v.cy) * v.scale };
}

export function screenToWorld(v: View, s: Vec2): Vec2 {
  return { x: v.cx + (s.x - v.width / 2) / v.scale, y: v.cy - (s.y - v.height / 2) / v.scale };
}

export function clampScale(s: number): number {
  return clamp(s, MIN_SCALE, MAX_SCALE);
}

/** Zoom by `factor` keeping the world point under screen position `anchor` fixed. */
export function zoomAt(v: View, factor: number, anchor?: Vec2): View {
  const scale = clampScale(v.scale * factor);
  if (!anchor) return { ...v, scale };
  const before = screenToWorld(v, anchor);
  const next = { ...v, scale };
  const after = screenToWorld(next, anchor);
  return { ...next, cx: v.cx + (before.x - after.x), cy: v.cy + (before.y - after.y) };
}

/** Pan by a screen-space drag delta. */
export function panBy(v: View, dxPx: number, dyPx: number): View {
  return { ...v, cx: v.cx - dxPx / v.scale, cy: v.cy + dyPx / v.scale };
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function boundsOf(points: readonly Vec2[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** View that fits `b` with a margin (fraction of the canvas). */
export function fitBounds(b: Bounds, width: number, height: number, margin = 0.08): View {
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const scale = clampScale(Math.min((width * (1 - 2 * margin)) / w, (height * (1 - 2 * margin)) / h));
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale, width, height };
}

/** Visible world rectangle plus an optional pixel margin (for culling). */
export function visibleBounds(v: View, marginPx = 0): Bounds {
  const a = screenToWorld(v, { x: -marginPx, y: v.height + marginPx });
  const b = screenToWorld(v, { x: v.width + marginPx, y: -marginPx });
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}
