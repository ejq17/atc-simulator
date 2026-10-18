/**
 * Aircraft glyph geometry and sizing shared by both displays. Glyphs are top-down silhouettes (nose up) per model family, built from the
 * same proportions as the Tower view models (RECIPES in tower/aircraftModel.ts) and the real wingspan of the type, so an A320 on the
 * surface display has A320 swept wings and underwing engines, a CRJ aft engines and a T-tail, a Cessna a straight high wing and propeller.
 */
import type { Aircraft } from '../../sim/types';
import { getPerformance } from '../../sim/performance';
import { RECIPES, aircraftDims } from '../tower/aircraftModel';
import type { ModelFamily } from '../tower/aircraftModel';

type Pt = readonly [number, number];

export interface Glyph {
  family: ModelFamily;
  /**
   * Right half of the outline, unit half-length (x lateral, y from -1 at the nose to +1 at the tail), from the nose tip (x = 0) to the
   * tail tip (x = 0); the left half is its mirror image.
   */
  half: readonly Pt[];
  /** Extra closed shapes (propeller discs seen edge-on). `mirror` shapes are on the right side and are repeated on the left. */
  bars: readonly { pts: readonly Pt[]; mirror: boolean }[];
  /** Fuselage half-width and the nose/cockpit y, for the detail overlay. */
  fuselageHalfWidth: number;
  noseY: number;
  tailY: number;
  /** Wingspan over length (the glyph's maximum |x|). */
  spanRatio: number;
}

/** The original generic silhouette, kept for unknown input and as the fallback of `glyphPath` when no type is given. */
export const GLYPH_HALF: readonly Pt[] = [
  [0, -1], [0.09, -0.72], [0.09, -0.22], [0.92, 0.18], [0.92, 0.36], [0.09, 0.14],
  [0.09, 0.6], [0.4, 0.84], [0.4, 0.98], [0, 0.88],
];

const cache = new Map<string, Glyph>();

/** Build the glyph of a type from the family proportions and the type's real span/length. */
export function glyphFor(type: string): Glyph {
  const hit = cache.get(type);
  if (hit) return hit;
  const g = buildGlyph(type);
  cache.set(type, g);
  return g;
}

function buildGlyph(type: string): Glyph {
  const d = aircraftDims(type);
  const rc = RECIPES[d.family];
  const span = d.wingspanM / d.lengthM; // = max |x| in unit half-length
  const W = span;
  const fw = Math.max(0.085, 2 * rc.R * (rc.gaProfile ? 0.8 : 1)); // fuselage half-width in unit half-length
  const w = rc.wing;
  const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
  const yAt = (frac: number) => -1 + 2 * frac;
  const noseY = rc.gaProfile ? yAt(0.3) : yAt((rc.nose * rc.R * 1.0));
  const leRoot = yAt(w.t0);
  const teRoot = yAt(w.t0 + w.rc);
  const leTip = leRoot + (W - fw) * tan(w.sweep);
  const teTip = leTip + 2 * w.tc;
  const leAt = (x: number) => leRoot + (x - fw) * tan(w.sweep);
  const tailConeY = rc.gaProfile ? yAt(0.62) : yAt(1 - rc.tail * rc.R);
  const pts: Pt[] = [[0, -1]];
  // Nose: an ogive in three points.
  pts.push([fw * 0.55, -1 + (noseY + 1) * 0.3], [fw * 0.9, -1 + (noseY + 1) * 0.65], [fw, noseY]);
  // Rear-mounted engines sit on the fuselage side (CRJ, bizjets).
  const eng = rc.engine;
  const rN = 2 * eng.r;
  const eLen = 2 * eng.len;
  const bars: { pts: Pt[]; mirror: boolean }[] = [];

  // Wing leading edge, with underwing nacelles (airliner, turboprop) as bumps forward of it.
  pts.push([fw, leRoot]);
  if (rc.engines === 'wing' || rc.engines === 'turboprop') {
    const xe = eng.x * W;
    const x0 = Math.max(fw + 0.01, xe - rN);
    const x1 = xe + rN;
    const fwd = eLen * (rc.engines === 'turboprop' ? 0.9 : 0.62);
    pts.push([x0, leAt(x0)], [x0, leAt(x0) - fwd], [x1, leAt(x1) - fwd], [x1, leAt(x1)]);
    if (rc.engines === 'turboprop' && rc.prop) {
      const py = leAt(xe) - fwd - 0.02;
      bars.push({ pts: [[xe - rc.prop.r * 2, py], [xe + rc.prop.r * 2, py], [xe + rc.prop.r * 2, py - 0.012], [xe - rc.prop.r * 2, py - 0.012]], mirror: true });
    }
  }
  pts.push([W, leTip], [W, teTip]);
  // Wing trailing edge back to the fuselage, then the rear engines, tail cone and tailplane.
  pts.push([fw, teRoot]);
  if (rc.engines === 'rear') {
    const e0 = yAt(0.775);
    pts.push([fw, e0], [fw + rN * 1.8, e0 + 0.02], [fw + rN * 1.8, e0 + eLen], [fw, e0 + eLen * 0.95]);
  }
  const s = rc.stab;
  const sSemi = (s.span * W) ;
  const sTE = Math.min(1, yAt(1 - s.zTE));
  const sLE = sTE - 2 * s.rc;
  const sLeTip = Math.min(sLE + sSemi * tan(s.sweep), 1 - 2 * s.tc);
  const sTeTip = Math.min(1, sLeTip + 2 * s.tc);
  const stabY0 = Math.max(tailConeY, teRoot + 0.02);
  pts.push([fw, Math.max(pts[pts.length - 1][1] + 0.01, Math.min(stabY0, sLE - 0.02))]);
  pts.push([fw * 0.6, sLE], [sSemi, sLeTip], [sSemi, sTeTip], [fw * 0.22, sTE], [0, 1]);
  if (rc.gaProfile && rc.prop) {
    // Propeller disc seen edge-on from above: a thin bar across the nose.
    const pr = 2 * rc.prop.r;
    bars.push({ pts: [[-pr, -1.01], [pr, -1.01], [pr, -1.045], [-pr, -1.045]], mirror: false });
  }
  return { family: d.family, half: pts, bars, fuselageHalfWidth: fw, noseY, tailY: 1, spanRatio: W };
}

function pathHalf(ctx: CanvasRenderingContext2D, half: readonly Pt[], k: number): void {
  half.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * k, y * k) : ctx.lineTo(x * k, y * k)));
  for (let i = half.length - 2; i >= 1; i--) ctx.lineTo(-half[i][0] * k, half[i][1] * k);
  ctx.closePath();
}

/**
 * Trace the closed silhouette (and propeller bars) of `type`, centred on the origin, nose up, `halfLenPx` per unit half-length.
 * Without a type the original generic outline is used.
 */
export function glyphPath(ctx: CanvasRenderingContext2D, halfLenPx: number, type?: string): void {
  ctx.beginPath();
  if (!type) { pathHalf(ctx, GLYPH_HALF, halfLenPx); return; }
  const g = glyphFor(type);
  pathHalf(ctx, g.half, halfLenPx);
  const poly = (pts: readonly Pt[], mx: number): void => {
    const o = mx < 0 ? [...pts].reverse() : pts;
    o.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * mx * halfLenPx, y * halfLenPx) : ctx.lineTo(x * mx * halfLenPx, y * halfLenPx)));
    ctx.closePath();
  };
  for (const bar of g.bars) {
    poly(bar.pts, 1);
    if (bar.mirror) poly(bar.pts, -1);
  }
}

/**
 * Detail drawn over the filled silhouette at close zoom (ASDE-X style plan view): a lighter fuselage spine and the cockpit windows.
 * The caller sets nothing; this saves and restores its own state.
 */
export function drawGlyphDetail(ctx: CanvasRenderingContext2D, halfLenPx: number, type: string): void {
  const g = glyphFor(type);
  const k = halfLenPx;
  const fw = g.fuselageHalfWidth * k * 0.55;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.moveTo(0, (g.noseY * 0.55 - 0.45) * k);
  ctx.lineTo(fw, (g.noseY + 0.02) * k);
  ctx.lineTo(fw, 0.78 * k);
  ctx.lineTo(0, 0.95 * k);
  ctx.lineTo(-fw, 0.78 * k);
  ctx.lineTo(-fw, (g.noseY + 0.02) * k);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(5,8,12,0.75)';
  const wy = (g.noseY - 0.02) * k;
  ctx.beginPath();
  ctx.moveTo(-fw * 0.8, wy + 0.05 * k);
  ctx.lineTo(fw * 0.8, wy + 0.05 * k);
  ctx.lineTo(fw * 0.55, wy - 0.045 * k);
  ctx.lineTo(-fw * 0.55, wy - 0.045 * k);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

const MIN_HALF_PX = { light: 7, large: 10, heavy: 13 } as const;

export interface AircraftSizing { halfLenPx: number; lengthM: number; category: 'light' | 'large' | 'heavy' }

/** Symbol half-length in px: true-to-scale when zoomed in, never below a readable minimum. */
export function symbolSize(ac: Pick<Aircraft, 'type'>, pxPerMetre: number): AircraftSizing {
  const perf = getPerformance(ac.type);
  const min = MIN_HALF_PX[perf.category];
  return { halfLenPx: Math.max(min, (perf.lengthM * pxPerMetre) / 2), lengthM: perf.lengthM, category: perf.category };
}
