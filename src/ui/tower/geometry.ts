/**
 * Pure scene-building math for the Tower view. No three.js import: everything here returns plain arrays so it is unit-tested
 * in jsdom (which has no WebGL) and the renderer (towerScene.ts) only uploads the results.
 *
 * Frames: the sim's local frame is x = metres east, y = metres north, altitude up. Scene (three.js) frame is x = east, y = up,
 * z = -north (so north is -z and a heading H points along (sin H, 0, -cos H)). `toScene` is the only place the swap happens.
 * Viewed from above both frames have the same handedness, so a counter-clockwise polygon in the sim is counter-clockwise in the scene
 * and its triangles face up.
 */
import type { Runway, Vec2 } from '../../sim/types';

export interface MeshData {
  /** x,y,z triples in SCENE coordinates. */
  positions: number[];
  indices: number[];
}

export const FT = 0.3048;

export function toScene(p: Vec2, h = 0): [number, number, number] {
  return [p.x, h, -p.y];
}

export function emptyMesh(): MeshData {
  return { positions: [], indices: [] };
}

export function mergeMeshes(parts: MeshData[]): MeshData {
  const out = emptyMesh();
  for (const m of parts) {
    const base = out.positions.length / 3;
    for (const v of m.positions) out.positions.push(v);
    for (const i of m.indices) out.indices.push(i + base);
  }
  return out;
}

export function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Drop a repeated closing vertex and consecutive duplicates. */
export function cleanRing(poly: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) out.push(p);
  }
  if (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= 1e-6) out.pop();
  }
  return out;
}

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function inTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Ear-clipping triangulation of a simple polygon (either winding). Returns index triples into the CLEANED ring that are all
 * counter-clockwise. Degenerate input falls back to a fan so the caller always gets something drawable.
 */
export function triangulate(ring: readonly Vec2[]): { ring: Vec2[]; tris: number[] } {
  const pts = cleanRing(ring);
  const n = pts.length;
  if (n < 3) return { ring: pts, tris: [] };
  const order = Array.from({ length: n }, (_, i) => i);
  if (signedArea(pts) < 0) order.reverse();
  const tris: number[] = [];
  let guard = 0;
  while (order.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < order.length; k++) {
      const ia = order[(k + order.length - 1) % order.length];
      const ib = order[k];
      const ic = order[(k + 1) % order.length];
      const a = pts[ia];
      const b = pts[ib];
      const c = pts[ic];
      if (cross(a, b, c) <= 1e-9) continue; // reflex or collinear
      let ear = true;
      for (const j of order) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTriangle(pts[j], a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      tris.push(ia, ib, ic);
      order.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // self-intersecting or degenerate: fan the rest
  }
  if (order.length >= 3) for (let k = 1; k + 1 < order.length; k++) tris.push(order[0], order[k], order[k + 1]);
  return { ring: pts, tris };
}

/** A flat, upward-facing polygon at height `h` (metres). */
export function polygonMesh(poly: readonly Vec2[], h: number): MeshData {
  const { ring, tris } = triangulate(poly);
  const m = emptyMesh();
  for (const p of ring) m.positions.push(...toScene(p, h));
  m.indices.push(...tris);
  return m;
}

/** A prism: roof at `height`, walls from 0 to `height`. Walls face outward. */
export function extrudeMesh(poly: readonly Vec2[], height: number): MeshData {
  const roof = polygonMesh(poly, height);
  const ring = cleanRing(poly);
  if (ring.length < 3) return roof;
  const ccw = signedArea(ring) > 0 ? ring : [...ring].reverse();
  const walls = emptyMesh();
  for (let i = 0; i < ccw.length; i++) {
    const a = ccw[i];
    const b = ccw[(i + 1) % ccw.length];
    const base = walls.positions.length / 3;
    walls.positions.push(...toScene(a, 0), ...toScene(b, 0), ...toScene(b, height), ...toScene(a, height));
    // CCW ring seen from above: the outside is on the right of a->b; (a0,b0,b1) faces outward.
    walls.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return mergeMeshes([roof, walls]);
}

/**
 * A constant-width ribbon along a polyline (taxiway pavement, centreline stripe, edge line), mitred at interior vertices
 * (mitre length capped so tight bends do not spike), lying at height `h`.
 */
export function ribbonMesh(line: readonly Vec2[], width: number, h: number): MeshData {
  const pts: Vec2[] = [];
  for (const p of line) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) pts.push(p);
  }
  const m = emptyMesh();
  if (pts.length < 2) return m;
  const half = width / 2;
  const segDir = (i: number): Vec2 => {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };
  for (let i = 0; i < pts.length; i++) {
    const d0 = i > 0 ? segDir(i - 1) : segDir(0);
    const d1 = i < pts.length - 1 ? segDir(i) : d0;
    let nx = -(d0.y + d1.y);
    let ny = d0.x + d1.x; // left normal of the averaged direction
    const nl = Math.hypot(nx, ny);
    let scale = half;
    if (nl < 1e-6) {
      nx = -d0.y; ny = d0.x; scale = half;
    } else {
      nx /= nl; ny /= nl;
      const cosHalf = Math.max(0.5, nx * -d0.y + ny * d0.x); // cos of half the turn angle, capped (mitre limit 2x)
      scale = half / cosHalf;
    }
    m.positions.push(...toScene({ x: pts[i].x + nx * scale, y: pts[i].y + ny * scale }, h));
    m.positions.push(...toScene({ x: pts[i].x - nx * scale, y: pts[i].y - ny * scale }, h));
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const L0 = 2 * i, R0 = 2 * i + 1, L1 = 2 * i + 2, R1 = 2 * i + 3;
    m.indices.push(R0, R1, L1, R0, L1, L0);
  }
  return m;
}

/** A rectangle centred at `c`, `length` long along heading `headingDeg` (TRUE, clockwise from north) and `width` across. */
export function rectMesh(c: Vec2, headingDeg: number, length: number, width: number, h: number): MeshData {
  const r = (headingDeg * Math.PI) / 180;
  const f = { x: Math.sin(r), y: Math.cos(r) };
  const s = { x: f.y, y: -f.x }; // right of travel
  const corner = (a: number, b: number): Vec2 => ({ x: c.x + f.x * a + s.x * b, y: c.y + f.y * a + s.y * b });
  const quad = [corner(-length / 2, -width / 2), corner(length / 2, -width / 2), corner(length / 2, width / 2), corner(-length / 2, width / 2)];
  // (-,-) (+,-) (+,+) (-,+) with s = right: this order is counter-clockwise only when right/left are as below; let polygonMesh fix winding.
  return polygonMesh(quad, h);
}

// ---------------------------------------------------------------------------
// Runway markings (FAA AC 150/5340-1 proportions, scaled to the runway width in the data)
// ---------------------------------------------------------------------------

export interface MarkingRect { c: Vec2; headingDeg: number; length: number; width: number }

export interface RunwayMarkings {
  centreline: MarkingRect[];
  threshold: MarkingRect[];
  aiming: MarkingRect[];
  edge: MarkingRect[];
  /** Displaced threshold arrows (shafts and arrowheads) on the centreline of the displaced area. */
  displaced: MarkingRect[];
}

export interface RunwayAxis { origin: Vec2; headingDeg: number; length: number; widthM: number }

/** Axis from the first threshold to the second (what the markings are laid against). */
export function runwayAxis(rw: Runway): RunwayAxis {
  const a = rw.ends[0].threshold;
  const b = rw.ends[1].threshold;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { origin: a, headingDeg: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360, length: Math.hypot(dx, dy), widthM: rw.widthFt * FT };
}

export function runwayMarkings(rw: Runway): RunwayMarkings {
  const ax = runwayAxis(rw);
  const r = (ax.headingDeg * Math.PI) / 180;
  const f = { x: Math.sin(r), y: Math.cos(r) };
  const s = { x: f.y, y: -f.x };
  const at = (along: number, across = 0): Vec2 => ({ x: ax.origin.x + f.x * along + s.x * across, y: ax.origin.y + f.y * along + s.y * across });
  const out: RunwayMarkings = { centreline: [], threshold: [], aiming: [], edge: [], displaced: [] };
  const L = ax.length;
  const W = ax.widthM;
  // Displaced thresholds (NASR): the landing threshold of an end is `displacedThresholdFt` in from its pavement end. The threshold bars, the
  // aiming point and the centreline run from the LANDING thresholds; the displaced area carries arrows instead (AC 150/5340-1 marking 5.x, simplified).
  const disp: [number, number] = [(rw.ends[0].displacedThresholdFt ?? 0) * FT, (rw.ends[1].displacedThresholdFt ?? 0) * FT];
  const landing: [number, number] = [disp[0], L - disp[1]];

  // Centreline: 36.6 m (120 ft) dashes on a 61 m (200 ft) pitch, from 150 m after one threshold to 150 m before the other.
  const dash = 120 * FT;
  const pitch = 200 * FT;
  const start = 150;
  const usable = landing[1] - landing[0] - 2 * start;
  if (usable > dash) {
    const count = Math.floor((usable - dash) / pitch) + 1;
    const used = (count - 1) * pitch + dash;
    const first = landing[0] + start + (usable - used) / 2;
    for (let i = 0; i < count; i++) out.centreline.push({ c: at(first + i * pitch + dash / 2), headingDeg: ax.headingDeg, length: dash, width: 0.9 });
  }

  // Threshold bars at both ends: 4/8/12 stripes by runway width, 45.7 m long, starting 6 ft in.
  const stripes = W >= 45 ? 12 : W >= 30 ? 8 : W >= 20 ? 6 : 4;
  const barLen = 150 * FT;
  const barW = 1.8;
  const gap = (W - 3 - stripes * barW) / Math.max(1, stripes); // spread across the width, leaving 1.5 m at each edge
  for (const end of [0, 1] as const) {
    const sign = end === 0 ? 1 : -1;
    const base = landing[end];
    const along = base + sign * (6 * FT + barLen / 2);
    for (let i = 0; i < stripes; i++) {
      const across = -W / 2 + 1.5 + gap / 2 + barW / 2 + i * (barW + gap);
      out.threshold.push({ c: at(along, across), headingDeg: ax.headingDeg, length: barLen, width: barW });
    }
  }

  // Aiming point: two 45.7 x 9 m bars 305 m (1000 ft) in from each threshold, 11 m either side of the centreline.
  if (L > 900) {
    for (const end of [0, 1] as const) {
      const sign = end === 0 ? 1 : -1;
      const base = landing[end];
      for (const side of [-1, 1]) out.aiming.push({ c: at(base + sign * (1000 * FT + 22.8), side * 11), headingDeg: ax.headingDeg, length: 150 * FT, width: 9 });
    }
  }

  // Displaced-threshold arrows: 36.6 m shafts on a 61 m pitch along the centreline of the displaced area, each with a chevron head pointing at the landing threshold.
  for (const end of [0, 1] as const) {
    if (!(disp[end] > 0)) continue;
    const sign = end === 0 ? 1 : -1;
    const base = end === 0 ? 0 : L;
    const n = Math.max(1, Math.floor(disp[end] / pitch));
    const step = disp[end] / n;
    const headingToward = end === 0 ? ax.headingDeg : (ax.headingDeg + 180) % 360;
    for (let k = 0; k < n; k++) {
      const tip = (k + 1) * step - 4;
      const shaft = Math.min(dash, step * 0.6);
      out.displaced.push({ c: at(base + sign * (tip - shaft / 2)), headingDeg: headingToward, length: shaft, width: 0.9 });
      for (const sgn of [-1, 1]) {
        const head = (headingToward + sgn * 40 + 360) % 360; // chevron arms trail the tip at +-40 degrees
        const arm = 5;
        const hr = (head * Math.PI) / 180;
        const tipPos = at(base + sign * tip);
        out.displaced.push({ c: { x: tipPos.x - Math.sin(hr) * arm / 2, y: tipPos.y - Math.cos(hr) * arm / 2 }, headingDeg: head, length: arm, width: 0.9 });
      }
    }
  }

  // Edge lines: continuous, 0.6 m wide, 0.9 m inside the pavement edge, over the whole threshold-to-threshold length.
  for (const side of [-1, 1]) out.edge.push({ c: at(L / 2, side * (W / 2 - 0.9)), headingDeg: ax.headingDeg, length: L, width: 0.6 });
  return out;
}

export function markingsMesh(rects: readonly MarkingRect[], h: number): MeshData {
  return mergeMeshes(rects.map((q) => rectMesh(q.c, q.headingDeg, q.length, q.width, h)));
}

// ---------------------------------------------------------------------------
// Hold lines: yellow double bars across the taxiway, the pair nearest the runway being the solid ones
// ---------------------------------------------------------------------------

export interface HoldBarsInput { pos: Vec2; towardRunway: Vec2; taxiwayWidth: number }

/** Two 0.45 m bars 0.45 m apart, across the taxiway, centred on the hold node, perpendicular to the direction toward the runway. */
export function holdBarRects(input: HoldBarsInput): MarkingRect[] {
  const l = Math.hypot(input.towardRunway.x, input.towardRunway.y) || 1;
  const d = { x: input.towardRunway.x / l, y: input.towardRunway.y / l };
  // Bars run ACROSS the taxiway: their long axis is perpendicular to d.
  const alongHeading = ((Math.atan2(-d.y, d.x) * 180) / Math.PI + 360) % 360; // heading of the perpendicular vector (-d.y, d.x)
  const out: MarkingRect[] = [];
  for (const off of [-0.45, 0.45]) {
    out.push({ c: { x: input.pos.x + d.x * off, y: input.pos.y + d.y * off }, headingDeg: alongHeading, length: input.taxiwayWidth, width: 0.45 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Taxiway designator signs: at intersections first, then along long runs
// ---------------------------------------------------------------------------

export interface SignPlacement { name: string; pos: Vec2 }

/**
 * One designator per (taxiway letter, place): every `intersection` node that carries a letter claims a sign, subject to a
 * same-letter spacing and an any-letter spacing so signs do not stack. Letters with no intersection get their longest centreline's midpoint.
 */
export function taxiwaySigns(
  nodes: Record<string, { kind: string; pos: Vec2; taxiways: string[] }>,
  polylines: Record<string, Vec2[][]>,
  opts: { sameLetterM?: number; anyLetterM?: number } = {},
): SignPlacement[] {
  const same = opts.sameLetterM ?? 220;
  const any = opts.anyLetterM ?? 35;
  const out: SignPlacement[] = [];
  const clash = (name: string, p: Vec2) => out.some((s) => {
    const d = Math.hypot(s.pos.x - p.x, s.pos.y - p.y);
    return d < any || (s.name === name && d < same);
  });
  // (signs of one node are added together after the check, so they never clash with each other)
  const letters = (names: string[]) => names.filter((n) => n && n !== 'UNNAMED' && !n.startsWith('RWY'));
  const ids = Object.keys(nodes).sort();
  for (const id of ids) {
    const n = nodes[id];
    if (n.kind !== 'intersection') continue;
    // Letters meeting at one node stand side by side (6 m apart) rather than competing for the same spot.
    const claimed: SignPlacement[] = [];
    for (const name of letters(n.taxiways)) {
      if (clash(name, n.pos)) continue;
      claimed.push({ name, pos: n.pos });
    }
    claimed.forEach((c, k) => out.push({ name: c.name, pos: { x: c.pos.x + (k - (claimed.length - 1) / 2) * 6, y: c.pos.y } }));
  }
  for (const name of Object.keys(polylines).sort()) {
    if (name === 'UNNAMED' || out.some((s) => s.name === name)) continue;
    let best: Vec2[] | undefined;
    let bestLen = 0;
    for (const line of polylines[name]) {
      let len = 0;
      for (let i = 1; i < line.length; i++) len += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
      if (len > bestLen) { bestLen = len; best = line; }
    }
    if (best && best.length) out.push({ name, pos: best[Math.floor(best.length / 2)] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lights (night)
// ---------------------------------------------------------------------------

export type LightColour = 'white' | 'red' | 'green' | 'blue' | 'yellow';
export interface LightPoint { pos: Vec2; h: number; colour: LightColour }

/** Points every `spacing` metres along a polyline (including the start). */
export function samplePolyline(line: readonly Vec2[], spacing: number): Vec2[] {
  const out: Vec2[] = [];
  if (line.length === 0) return out;
  out.push(line[0]);
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg === 0) continue;
    let d = spacing - carry;
    while (d <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * d) / seg, y: a.y + ((b.y - a.y) * d) / seg });
      d += spacing;
    }
    carry = seg - (d - spacing);
  }
  return out;
}

/** Offset a polyline sideways by `off` metres (positive = left of travel); simple per-vertex normal, fine for lights. */
export function offsetPolyline(line: readonly Vec2[], off: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    out.push({ x: line[i].x - (dy / l) * off, y: line[i].y + (dx / l) * off });
  }
  return out;
}

export interface RunwayLightOptions { centreline: boolean; approach: boolean }

/**
 * Runway edge lights (white, 60 m), threshold lights (green, both ends),
 * optional centreline lights and an approach light bar (700 m of crossbar-less centreline lights) when the data says the end has one.
 */
export function runwayLights(rw: Runway, opts: RunwayLightOptions & { approachEnds?: string[] }): LightPoint[] {
  const ax = runwayAxis(rw);
  const r = (ax.headingDeg * Math.PI) / 180;
  const f = { x: Math.sin(r), y: Math.cos(r) };
  const s = { x: f.y, y: -f.x };
  const at = (along: number, across: number): Vec2 => ({ x: ax.origin.x + f.x * along + s.x * across, y: ax.origin.y + f.y * along + s.y * across });
  const out: LightPoint[] = [];
  const half = ax.widthM / 2 + 1.5;
  const dispFt: [number, number] = [rw.ends[0].displacedThresholdFt ?? 0, rw.ends[1].displacedThresholdFt ?? 0];
  for (let d = 0; d <= ax.length + 1e-6; d += 60) for (const side of [-1, 1]) out.push({ pos: at(d, side * half), h: 0.4, colour: 'white' });
  // Threshold lights (green) in a row across the full width at both ends.
  for (let k = 0; k <= 12; k++) {
    const across = -half + (k * 2 * half) / 12;
    out.push({ pos: at(dispFt[0] * FT - 1, across), h: 0.3, colour: 'green' });
    out.push({ pos: at(ax.length - dispFt[1] * FT + 1, across), h: 0.3, colour: 'green' });
  }
  if (opts.centreline) for (let d = 15; d < ax.length - 15; d += 15) out.push({ pos: at(d, 0), h: 0.15, colour: 'white' });
  if (opts.approach) {
    for (const end of opts.approachEnds ?? []) {
      const idx = rw.ends.findIndex((e) => e.id === end);
      if (idx < 0) continue;
      const sign = idx === 0 ? -1 : 1;
      const base = idx === 0 ? dispFt[0] * FT : ax.length - dispFt[1] * FT;
      for (let d = 10; d <= 720; d += 30) out.push({ pos: at(base + sign * d, 0), h: 1.2, colour: 'white' });
      for (const dd of [150, 300]) for (let x = -12; x <= 12; x += 3) out.push({ pos: at(base + sign * dd, x), h: 1.2, colour: 'white' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Closure markings and runway light intensity
// ---------------------------------------------------------------------------

/** Each stroke of an X (`closureMarks.ts`) as a thin marking rectangle `width` metres wide, for `markingsMesh`. */
export function xMarkRects(marks: readonly { segments: readonly (readonly [Vec2, Vec2])[] }[], width: number): MarkingRect[] {
  const out: MarkingRect[] = [];
  for (const m of marks) {
    for (const [a, b] of m.segments) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      out.push({ c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, headingDeg: (Math.atan2(dx, dy) * 180) / Math.PI, length: Math.hypot(dx, dy), width });
    }
  }
  return out;
}

/**
 * Brightness of the runway edge lights for an intensity step of the HIRL system (JO 7110.65 3-4-11: steps 1-5; 0 = off). `closed`: a closed runway's
 * edge lights are not turned on (3-4-10: "Do not turn on the runway edge lights when a NOTAM closing the runway is in effect"). `opacity` scales the
 * glow, `size` the light sprite; step 5 is the full-brightness reference. The ratios are a visual choice (the manual gives steps, not candela).
 */
export function runwayLightLevel(step: number, closed: boolean): { opacity: number; size: number } {
  if (closed || step <= 0) return { opacity: 0, size: 0 };
  const s = Math.max(1, Math.min(5, Math.round(step)));
  return { opacity: [0.28, 0.45, 0.62, 0.8, 1][s - 1], size: [0.7, 0.8, 0.9, 1, 1.15][s - 1] };
}
