/**
 * Aircraft glyph geometry and sizing shared by both displays. Glyphs are top-down silhouettes (nose up) per model family, built from the
 * same proportions as the Tower view models (RECIPES in tower/aircraftModel.ts) and the real wingspan of the type, so an A320 on the
 * surface display has A320 swept wings and underwing engines, a CRJ aft engines and a T-tail, a Cessna a straight high wing and propeller.
 */
import type { Aircraft } from '../../sim/types';
import { getPerformance, isMilitaryType, isRotorcraftType, isVehicleType } from '../../sim/performance';
import { RECIPES, aircraftDims } from '../tower/aircraftModel';
import type { ModelFamily } from '../tower/aircraftModel';
import { C } from './palette';

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

/** Which special mark a type carries on the displays: the rotor cross of a helicopter, the military outline, the airport-vehicle box. */
export type SpecialMark = 'rotorcraft' | 'military' | 'vehicle';

/** Helicopter, military and vehicle types get their own symbol treatment; every other type is undefined. Rotorcraft wins over military (the Coast Guard MH-65). */
export function specialMark(type: string): SpecialMark | undefined {
  if (isVehicleType(type)) return 'vehicle';
  if (isRotorcraftType(type)) return 'rotorcraft';
  if (isMilitaryType(type)) return 'military';
  return undefined;
}

/** Thin bar from (x0, y0) to (x1, y1) as a closed rectangle `w` wide (unit half-length). */
function bar(x0: number, y0: number, x1: number, y1: number, w: number): readonly Pt[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const n = Math.hypot(dx, dy) || 1;
  const px = (-dy / n) * (w / 2);
  const py = (dx / n) * (w / 2);
  return [[x0 + px, y0 + py], [x1 + px, y1 + py], [x1 - px, y1 - py], [x0 - px, y0 - py]];
}

/** Top-down silhouettes of the special-traffic families (unit half-length; the proportions follow specialModels.ts). */
function buildSpecialGlyph(family: 'helicopter' | 'fighter' | 'groundVehicle', spanRatio: number): Glyph {
  if (family === 'helicopter') {
    // Slim cabin, tail boom with the stabiliser; the main rotor is drawn as a cross of two blade bars through the mast.
    const half: Pt[] = [[0, -1], [0.17, -0.9], [0.2, -0.7], [0.2, -0.3], [0.16, -0.05], [0.07, 0.2], [0.05, 0.5], [0.05, 0.74], [0.2, 0.78], [0.2, 0.86], [0.05, 0.9], [0.04, 0.97], [0, 1]];
    const c = -0.18; // mast position
    const k = spanRatio * 0.707;
    return {
      family, half, fuselageHalfWidth: 0.2, noseY: -0.78, tailY: 1, spanRatio: k,
      bars: [{ pts: bar(-k, c - k, k, c + k, 0.07), mirror: false }, { pts: bar(k, c - k, -k, c + k, 0.07), mirror: false }],
    };
  }
  if (family === 'fighter') {
    const W = spanRatio;
    const half: Pt[] = [
      [0, -1], [0.05, -0.8], [0.09, -0.55], [0.1, -0.35], [0.2, -0.17], [0.24, -0.1], [W, 0.27], [W, 0.46], [0.12, 0.47], [0.12, 0.64],
      [0.37, 0.8], [0.37, 0.95], [0.09, 0.93], [0.08, 1], [0, 1],
    ];
    return { family, half, bars: [], fuselageHalfWidth: 0.1, noseY: -0.55, tailY: 1, spanRatio: W };
  }
  // ground vehicle: a chamfered rectangle (pickup seen from above)
  const W = spanRatio;
  const half: Pt[] = [[0, -1], [W * 0.8, -1], [W, -0.9], [W, 0.92], [W * 0.85, 1], [0, 1]];
  return { family, half, bars: [], fuselageHalfWidth: W, noseY: -0.9, tailY: 1, spanRatio: W };
}

function buildGlyph(type: string): Glyph {
  const d = aircraftDims(type);
  if (d.family === 'helicopter' || d.family === 'fighter' || d.family === 'groundVehicle') return buildSpecialGlyph(d.family, d.wingspanM / d.lengthM);
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
  if (g.family === 'groundVehicle') {
    // cab glass and the amber beacon on the roof
    ctx.save();
    ctx.fillStyle = 'rgba(5,8,12,0.75)';
    ctx.fillRect(-g.spanRatio * k * 0.72, -0.5 * k, g.spanRatio * k * 1.44, 0.32 * k);
    ctx.fillStyle = C.amber;
    ctx.beginPath();
    ctx.arc(0, -0.06 * k, Math.max(1.5, g.spanRatio * k * 0.28), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  const fw = g.fuselageHalfWidth * k * 0.55;
  if (g.family === 'helicopter') {
    // windscreen only (the boom is too narrow for the spine) and the rotor hub
    ctx.save();
    ctx.fillStyle = 'rgba(5,8,12,0.75)';
    ctx.beginPath();
    ctx.moveTo(-fw * 1.2, -0.7 * k);
    ctx.lineTo(fw * 1.2, -0.7 * k);
    ctx.lineTo(fw * 1.55, -0.5 * k);
    ctx.lineTo(-fw * 1.55, -0.5 * k);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(0, -0.18 * k, Math.max(1.2, 0.05 * k), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
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
