/** Pure label-layout and hit-testing helpers (no canvas). */

export interface Rect { x: number; y: number; w: number; h: number }

export interface LabelRequest {
  id: string;
  /** Anchor (symbol) position in screen pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedLabel extends Rect {
  id: string;
  /** Which corner of the box touches the leader line. */
  anchorX: number;
  anchorY: number;
  hidden: boolean;
}

export const rectsOverlap = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/**
 * Greedy label placement: try NE, SE, NW, SW offsets for each label in order and take the first that
 * does not overlap an already placed label or an `avoid` rectangle. If none is free the first candidate
 * is used anyway (never hide an aircraft's identity), flagged `hidden: false`. Earlier requests have priority,
 * so callers should pass the selected aircraft first.
 */
export function placeLabels(requests: readonly LabelRequest[], avoid: readonly Rect[] = [], offset = 16, bounds?: { width: number; height: number }): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const taken: Rect[] = [...avoid];
  for (const r of requests) {
    const cands: Rect[] = [
      { x: r.x + offset, y: r.y - offset - r.h, w: r.w, h: r.h },
      { x: r.x + offset, y: r.y + offset, w: r.w, h: r.h },
      { x: r.x - offset - r.w, y: r.y - offset - r.h, w: r.w, h: r.h },
      { x: r.x - offset - r.w, y: r.y + offset, w: r.w, h: r.h },
    ];
    const inside = (c: Rect) => !bounds || (c.x >= 2 && c.y >= 2 && c.x + c.w <= bounds.width - 2 && c.y + c.h <= bounds.height - 2);
    const free = cands.find((c) => inside(c) && !taken.some((t) => rectsOverlap(c, t, 2)))
      ?? cands.find((c) => !taken.some((t) => rectsOverlap(c, t, 2)));
    const chosen = free ?? cands.find(inside) ?? cands[0];
    taken.push(chosen);
    // Leader attaches to the box corner nearest the symbol.
    const ax = chosen.x >= r.x ? chosen.x : chosen.x + chosen.w;
    const ay = chosen.y >= r.y ? chosen.y : chosen.y + chosen.h;
    placed.push({ id: r.id, ...chosen, anchorX: ax, anchorY: ay, hidden: false });
  }
  return placed;
}

export interface HitItem { id: string; x: number; y: number }

/** Nearest item within `radiusPx` of (sx, sy), or undefined. Ties go to the closest. */
export function nearestWithin(items: readonly HitItem[], sx: number, sy: number, radiusPx: number): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const it of items) {
    const d = Math.hypot(it.x - sx, it.y - sy);
    if (d <= radiusPx && d < bestD) {
      bestD = d;
      best = it.id;
    }
  }
  return best;
}
