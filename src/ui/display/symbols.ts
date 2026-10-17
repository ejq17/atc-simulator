/** Aircraft glyph geometry and sizing shared by both displays. */
import type { Aircraft } from '../../sim/types';
import { getPerformance } from '../../sim/performance';

/** Half-profile of a top-down airplane, nose up, unit half-length. Mirrored about x=0 when drawn. */
export const GLYPH_HALF: readonly (readonly [number, number])[] = [
  [0, -1], [0.09, -0.72], [0.09, -0.22], [0.92, 0.18], [0.92, 0.36], [0.09, 0.14],
  [0.09, 0.6], [0.4, 0.84], [0.4, 0.98], [0, 0.88],
];

export function glyphPath(ctx: CanvasRenderingContext2D, halfLenPx: number): void {
  ctx.beginPath();
  GLYPH_HALF.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * halfLenPx, y * halfLenPx) : ctx.lineTo(x * halfLenPx, y * halfLenPx)));
  for (let i = GLYPH_HALF.length - 1; i >= 1; i--) ctx.lineTo(-GLYPH_HALF[i][0] * halfLenPx, GLYPH_HALF[i][1] * halfLenPx);
  ctx.closePath();
}

const MIN_HALF_PX = { light: 7, large: 10, heavy: 13 } as const;

export interface AircraftSizing { halfLenPx: number; lengthM: number; category: 'light' | 'large' | 'heavy' }

/** Symbol half-length in px: true-to-scale when zoomed in, never below a readable minimum. */
export function symbolSize(ac: Pick<Aircraft, 'type'>, pxPerMetre: number): AircraftSizing {
  const perf = getPerformance(ac.type);
  const min = MIN_HALF_PX[perf.category];
  return { halfLenPx: Math.max(min, (perf.lengthM * pxPerMetre) / 2), lengthM: perf.lengthM, category: perf.category };
}
