/**
 * Airport surface display renderer (Canvas 2D). Pure functions of (ctx, frame, view, layers): no React,
 * no globals, so they can be exercised with a stub context. World metres, y up (north).
 */
import type { Aircraft, Airport, SimulationState, Vec2 } from '../../sim/types';
import type { Frame } from './frame';
import { C, FONT_MONO } from './palette';
import { placeLabels } from './labels';
import type { LabelRequest } from './labels';
import { buildSurfaceStatic } from './surfaceStatic';
import { worldToScreen, visibleBounds } from './viewTransform';
import type { View } from './viewTransform';
import { glyphPath, symbolSize } from './symbols';
import { niceLength, deg2rad } from '../lib/geom';
import { TONE_COLOR, statusTone, phaseShort } from '../lib/format';

export interface SurfaceLayers {
  labels: boolean;
  taxiwayIds: boolean;
  routes: boolean;
  trails: boolean;
  parking: boolean;
  unnamed: boolean;
}

export const DEFAULT_SURFACE_LAYERS: SurfaceLayers = {
  labels: true, taxiwayIds: true, routes: true, trails: true, parking: true, unnamed: true,
};

export type RunwayTint = 'free' | 'occupied' | 'conflict';

/** Runway occupancy colour: red when a conflict alert names the runway, amber when anything is on / cleared onto it. */
export function runwayTint(state: Pick<SimulationState, 'runwayOccupancy' | 'conflicts'>, runwayId: string): RunwayTint {
  if (state.conflicts.some((c) => c.runwayId === runwayId && (c.kind === 'RUNWAY_CONFLICT' || c.kind === 'RUNWAY_INCURSION' || c.severity === 'critical'))) {
    return 'conflict';
  }
  const occ = state.runwayOccupancy[runwayId];
  if (occ && (occ.occupants.length > 0 || occ.departingId || occ.landingId || occ.lineUpId || occ.crossingIds.length > 0)) return 'occupied';
  return 'free';
}

const TINT_FILL: Record<RunwayTint, string> = {
  free: 'rgba(57,211,83,0.10)',
  occupied: 'rgba(242,179,61,0.30)',
  conflict: 'rgba(255,77,79,0.42)',
};

function poly(ctx: CanvasRenderingContext2D, v: View, pts: readonly Vec2[], close = false): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = worldToScreen(v, p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  if (close) ctx.closePath();
}

function drawBackdrop(ctx: CanvasRenderingContext2D, v: View): void {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, v.width, v.height);
  // Faint 1 km / 100 m reference grid so scale is legible at a glance.
  const step = v.scale > 0.5 ? 100 : 500;
  const b = visibleBounds(v);
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.floor(b.minX / step) * step; x <= b.maxX; x += step) {
    const s = worldToScreen(v, { x, y: 0 }).x;
    ctx.moveTo(Math.round(s) + 0.5, 0);
    ctx.lineTo(Math.round(s) + 0.5, v.height);
  }
  for (let y = Math.floor(b.minY / step) * step; y <= b.maxY; y += step) {
    const s = worldToScreen(v, { x: 0, y }).y;
    ctx.moveTo(0, Math.round(s) + 0.5);
    ctx.lineTo(v.width, Math.round(s) + 0.5);
  }
  ctx.stroke();
}

function drawAirportBase(ctx: CanvasRenderingContext2D, v: View, airport: Airport, layers: SurfaceLayers): void {
  // Aprons
  ctx.fillStyle = C.apron;
  ctx.strokeStyle = C.apronEdge;
  ctx.lineWidth = 1;
  for (const ap of airport.taxiwayGraph.aprons) {
    poly(ctx, v, ap, true);
    ctx.fill();
    ctx.stroke();
  }
  // Taxiways: wide pavement stroke, then a thin centreline.
  const widthPx = Math.max(2.5, 22 * v.scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const names = Object.keys(airport.taxiwayGraph.taxiwayPolylines);
  for (const pass of ['wide', 'line'] as const) {
    for (const name of names) {
      const unnamed = name === 'UNNAMED';
      if (unnamed && !layers.unnamed) continue;
      ctx.strokeStyle = pass === 'wide' ? C.twyWide : unnamed ? C.twyUnnamed : C.twyLine;
      ctx.lineWidth = pass === 'wide' ? widthPx : unnamed ? 1 : 1.25;
      if (pass === 'wide' && unnamed) ctx.lineWidth = Math.max(2, 14 * v.scale);
      for (const line of airport.taxiwayGraph.taxiwayPolylines[name]) {
        poly(ctx, v, line);
        ctx.stroke();
      }
    }
  }
  ctx.lineCap = 'butt';
}

function drawRunways(ctx: CanvasRenderingContext2D, v: View, state: SimulationState): void {
  const airport = state.airport;
  for (const rw of airport.runways) {
    poly(ctx, v, rw.polygon, true);
    ctx.fillStyle = C.runway;
    ctx.fill();
    ctx.fillStyle = TINT_FILL[runwayTint(state, rw.id)];
    ctx.fill();
    ctx.strokeStyle = C.runwayEdge;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    // Centreline dashes
    const [a, b] = rw.ends;
    const s1 = worldToScreen(v, a.threshold);
    const s2 = worldToScreen(v, b.threshold);
    ctx.setLineDash([10, 9]);
    ctx.strokeStyle = C.runwayCenter;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawRunwayNumbers(ctx: CanvasRenderingContext2D, v: View, airport: Airport): void {
  const st = buildSurfaceStatic(airport);
  const px = Math.min(20, Math.max(11, 38 * v.scale));
  ctx.font = `600 ${px}px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of st.runwayLabels) {
    const s = worldToScreen(v, l);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(-deg2rad(l.angleDeg));
    ctx.fillStyle = C.text;
    ctx.fillText(l.text, 0, 0);
    ctx.restore();
  }
}

function drawTaxiwayIds(ctx: CanvasRenderingContext2D, v: View, airport: Airport): void {
  if (v.scale < 0.12) return;
  const st = buildSurfaceStatic(airport);
  ctx.font = `600 11px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const drawn: Vec2[] = [];
  for (const l of st.taxiLabels) {
    const s = worldToScreen(v, l);
    if (s.x < -20 || s.y < -20 || s.x > v.width + 20 || s.y > v.height + 20) continue;
    if (drawn.some((d) => Math.hypot(d.x - s.x, d.y - s.y) < 34)) continue;
    drawn.push(s);
    const w = ctx.measureText(l.name).width + 8;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(-deg2rad(l.angleDeg));
    ctx.fillStyle = '#0b0e11';
    ctx.strokeStyle = C.hold;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -8, w, 16, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.hold;
    ctx.fillText(l.name, 0, 1);
    ctx.restore();
  }
}

export interface LahsoMark { endId: string; pos: Vec2; /** TRUE heading of the landing runway the point is on. */ headingDeg: number; availableFt: number; holdShortOfRunwayId: string }

/** NASR LAHSO hold-short points of the runway ends that have them (KACY: 4, 13, 31). */
export function lahsoMarks(airport: Pick<Airport, 'runways'>): LahsoMark[] {
  const out: LahsoMark[] = [];
  for (const rw of airport.runways) {
    for (const e of rw.ends) {
      const l = e.lahso;
      if (l) out.push({ endId: e.id, pos: l.holdShortPoint.pos, headingDeg: e.trueHeadingDeg, availableFt: l.availableLandingDistanceFt, holdShortOfRunwayId: l.holdShortOfRunwayId });
    }
  }
  return out;
}

const LAHSO_COLOR = '#e040fb';

/** A short magenta tick across the landing runway at each LAHSO hold-short point, labelled "LAHSO". */
function drawLahso(ctx: CanvasRenderingContext2D, v: View, airport: Airport): void {
  const half = Math.max(8, 22 * v.scale * 2);
  ctx.strokeStyle = LAHSO_COLOR;
  ctx.fillStyle = LAHSO_COLOR;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([]);
  ctx.font = `600 10px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const m of lahsoMarks(airport)) {
    const s = worldToScreen(v, m.pos);
    if (s.x < -40 || s.y < -40 || s.x > v.width + 40 || s.y > v.height + 40) continue;
    // Tick across the runway: perpendicular to its heading (screen: world (dx, dy) -> (dx, -dy)).
    const r = (m.headingDeg * Math.PI) / 180;
    const px = Math.cos(r);
    const py = Math.sin(r);
    ctx.beginPath();
    ctx.moveTo(s.x - px * half, s.y - py * half);
    ctx.lineTo(s.x + px * half, s.y + py * half);
    ctx.stroke();
    ctx.fillText('LAHSO', s.x + px * (half + 5), s.y + py * (half + 5));
  }
}

function drawHoldLines(ctx: CanvasRenderingContext2D, v: View, airport: Airport): void {
  const st = buildSurfaceStatic(airport);
  const half = Math.max(7, 13 * v.scale * 2);
  for (const h of st.holds) {
    const s = worldToScreen(v, h.pos);
    if (s.x < -30 || s.y < -30 || s.x > v.width + 30 || s.y > v.height + 30) continue;
    // Direction on screen: world (dx, dy) -> (dx, -dy)
    const dx = h.dir.x * half;
    const dy = -h.dir.y * half;
    const ox = -h.away.x * 1.8;
    const oy = h.away.y * 1.8; // away (world) -> screen y flipped; offset the dashed partner line toward the runway
    ctx.strokeStyle = C.hold;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(s.x - dx, s.y - dy);
    ctx.lineTo(s.x + dx, s.y + dy);
    ctx.stroke();
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(s.x - dx + ox * 1.6, s.y - dy + oy * 1.6);
    ctx.lineTo(s.x + dx + ox * 1.6, s.y + dy + oy * 1.6);
    ctx.stroke();
    ctx.setLineDash([]);
    if (v.scale > 0.4) {
      ctx.fillStyle = C.hold;
      ctx.font = `10px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(h.runwayId, s.x + h.away.x * 22, s.y - h.away.y * 14);
    }
  }
}

function drawParking(ctx: CanvasRenderingContext2D, v: View, airport: Airport): void {
  const st = buildSurfaceStatic(airport);
  const showNames = v.scale > 1.1;
  ctx.font = `10px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const p of st.parking) {
    const s = worldToScreen(v, p.pos);
    if (s.x < -30 || s.y < -30 || s.x > v.width + 30 || s.y > v.height + 30) continue;
    ctx.fillStyle = '#5d7c90';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    if (showNames) {
      ctx.fillStyle = C.muted;
      ctx.fillText(p.name, s.x + 6, s.y);
    }
  }
}

function drawMarkers(ctx: CanvasRenderingContext2D, v: View, airport: Airport): void {
  const st = buildSurfaceStatic(airport);
  // ARP
  const a = worldToScreen(v, { x: 0, y: 0 });
  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
  ctx.moveTo(a.x - 8, a.y);
  ctx.lineTo(a.x + 8, a.y);
  ctx.moveTo(a.x, a.y - 8);
  ctx.lineTo(a.x, a.y + 8);
  ctx.stroke();
  ctx.fillStyle = C.muted;
  ctx.font = `10px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('ARP', a.x + 8, a.y + 5);
  // HS 1
  if (st.hs1) {
    const h = worldToScreen(v, st.hs1);
    const r = Math.max(14, 90 * v.scale);
    ctx.strokeStyle = C.amber;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.amber;
    ctx.font = `600 11px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('HS 1', h.x, h.y - r - 3);
  }
}

function routePoints(state: SimulationState, ac: Aircraft, from: Vec2): Vec2[] {
  const r = ac.route;
  if (!r) return [];
  const nodes = state.airport.taxiwayGraph.nodes;
  const pts: Vec2[] = [from];
  for (let i = Math.max(0, r.progressIndex); i < r.nodeIds.length; i++) {
    const n = nodes[r.nodeIds[i]];
    if (n) pts.push(n.pos);
  }
  return pts.length > 1 ? pts : [];
}

function drawRoutes(ctx: CanvasRenderingContext2D, v: View, frame: Frame): void {
  const { state } = frame;
  for (const ac of Object.values(state.aircraft)) {
    if (!ac.route || !ac.onGround) continue;
    const selected = ac.id === frame.selectedId;
    const pose = frame.pose(ac);
    const pts = routePoints(state, ac, { x: pose.x, y: pose.y });
    if (!pts.length) continue;
    ctx.save();
    ctx.lineJoin = 'round';
    if (selected) {
      ctx.strokeStyle = C.cyan;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([9, 5]);
    } else {
      ctx.strokeStyle = 'rgba(57,197,232,0.28)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 4]);
    }
    poly(ctx, v, pts);
    ctx.stroke();
    ctx.setLineDash([]);
    // Hold-short / stop points
    const nodes = state.airport.taxiwayGraph.nodes;
    for (const id of ac.route.stopAtNodeIds) {
      const n = nodes[id];
      if (!n) continue;
      const s = worldToScreen(v, n.pos);
      const sz = selected ? 6 : 4;
      ctx.fillStyle = C.red;
      ctx.strokeStyle = '#1a0507';
      ctx.lineWidth = 1;
      ctx.fillRect(s.x - sz, s.y - sz, sz * 2, sz * 2);
      ctx.strokeRect(s.x - sz, s.y - sz, sz * 2, sz * 2);
      if (selected) {
        ctx.fillStyle = C.red;
        ctx.font = `600 10px ${FONT_MONO}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('HOLD', s.x + sz + 4, s.y);
      }
    }
    ctx.restore();
  }
}

function drawTrails(ctx: CanvasRenderingContext2D, v: View, frame: Frame): void {
  for (const ac of Object.values(frame.state.aircraft)) {
    const h = ac.history;
    if (h.length < 1) continue;
    const pose = frame.pose(ac);
    const pts = [...h, { x: pose.x, y: pose.y }];
    const base = TONE_COLOR[statusTone(ac)];
    const n = pts.length;
    for (let i = 1; i < n; i++) {
      const a = worldToScreen(v, pts[i - 1]);
      const b = worldToScreen(v, pts[i]);
      ctx.strokeStyle = base;
      ctx.globalAlpha = 0.12 + 0.5 * (i / n);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function drawConflicts(ctx: CanvasRenderingContext2D, v: View, frame: Frame): void {
  const pulse = 0.55 + 0.45 * Math.sin(frame.nowMs / 180);
  for (const al of frame.state.conflicts) {
    const col = al.severity === 'critical' ? C.red : C.amber;
    const acs = al.aircraftIds.map((id) => frame.state.aircraft[id]).filter(Boolean);
    const pts = acs.map((a) => {
      const p = frame.pose(a);
      return worldToScreen(v, { x: p.x, y: p.y });
    });
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.45 + 0.55 * pulse;
    for (const s of pts) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 22, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (pts.length === 2) {
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }
}

export function labelLines(ac: Aircraft, compact: boolean): string[] {
  if (compact) return [ac.callsign];
  return [ac.callsign, `${ac.type} ${phaseShort(ac.phase)} ${Math.round(ac.groundSpeedKt)}kt`];
}

function drawAircraft(ctx: CanvasRenderingContext2D, v: View, frame: Frame, layers: SurfaceLayers): void {
  const acs = Object.values(frame.state.aircraft);
  // Selected first so it wins label space.
  acs.sort((a, b) => (a.id === frame.selectedId ? -1 : b.id === frame.selectedId ? 1 : 0));
  const compact = v.scale < 0.15;
  ctx.font = `11px ${FONT_MONO}`;
  const reqs: LabelRequest[] = [];
  const draws: { ac: Aircraft; x: number; y: number; hdg: number }[] = [];
  for (const ac of acs) {
    const p = frame.pose(ac);
    const s = worldToScreen(v, { x: p.x, y: p.y });
    if (s.x < -60 || s.y < -60 || s.x > v.width + 60 || s.y > v.height + 60) continue;
    draws.push({ ac, x: s.x, y: s.y, hdg: p.headingDeg });
    if (layers.labels) {
      const lines = labelLines(ac, compact);
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
      reqs.push({ id: ac.id, x: s.x, y: s.y, w, h: lines.length * 13 + 6 });
    }
  }
  const placed = new Map(placeLabels(reqs, [], 16, { width: v.width, height: v.height }).map((p) => [p.id, p]));

  for (const d of draws) {
    const { ac } = d;
    const tone = statusTone(ac);
    const color = TONE_COLOR[tone];
    const size = symbolSize(ac, v.scale);
    const selected = ac.id === frame.selectedId;

    if (selected) {
      ctx.strokeStyle = C.cyan;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(d.x, d.y, size.halfLenPx + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(57,197,232,0.35)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(d.x, d.y, size.halfLenPx + 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(deg2rad(d.hdg));
    glyphPath(ctx, size.halfLenPx);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#05070a';
    ctx.lineWidth = 1.25;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (ac.pendingRequest) {
      ctx.fillStyle = C.amber;
      ctx.beginPath();
      ctx.arc(d.x + size.halfLenPx * 0.8 + 3, d.y - size.halfLenPx * 0.8 - 3, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const lab = placed.get(ac.id);
    if (lab) {
      const lines = labelLines(ac, compact);
      ctx.strokeStyle = selected ? C.cyan : 'rgba(215,221,228,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(lab.anchorX, lab.anchorY);
      ctx.stroke();
      ctx.fillStyle = C.labelBg;
      ctx.fillRect(lab.x, lab.y, lab.w, lab.h);
      if (selected) {
        ctx.strokeStyle = C.cyan;
        ctx.strokeRect(lab.x + 0.5, lab.y + 0.5, lab.w - 1, lab.h - 1);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => {
        ctx.fillStyle = i === 0 ? (selected ? C.cyan : color) : C.text;
        ctx.font = `${i === 0 ? '600 ' : ''}11px ${FONT_MONO}`;
        ctx.fillText(l, lab.x + 5, lab.y + 3 + i * 13);
      });
    }
  }
}

function drawScaleBar(ctx: CanvasRenderingContext2D, v: View): void {
  const metres = niceLength(150 / v.scale);
  const px = metres * v.scale;
  const x = 16;
  const y = v.height - 22;
  ctx.strokeStyle = C.text;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 4);
  ctx.stroke();
  ctx.fillStyle = C.text;
  ctx.font = `11px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, x, y - 6);
}

function drawCompass(ctx: CanvasRenderingContext2D, v: View): void {
  const cx = v.width - 40;
  const cy = 44;
  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = C.cyan;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 20);
  ctx.lineTo(cx - 5, cy + 2);
  ctx.lineTo(cx + 5, cy + 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = C.text;
  ctx.font = `600 11px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy + 12);
}

/** Render one complete surface frame. */
export function drawSurface(ctx: CanvasRenderingContext2D, frame: Frame, v: View, layers: SurfaceLayers): void {
  const { state } = frame;
  const airport = state.airport;
  drawBackdrop(ctx, v);
  drawAirportBase(ctx, v, airport, layers);
  drawRunways(ctx, v, state);
  drawRunwayNumbers(ctx, v, airport);
  if (layers.taxiwayIds) drawTaxiwayIds(ctx, v, airport);
  drawHoldLines(ctx, v, airport);
  drawLahso(ctx, v, airport);
  if (layers.parking) drawParking(ctx, v, airport);
  drawMarkers(ctx, v, airport);
  if (layers.routes) drawRoutes(ctx, v, frame);
  if (layers.trails) drawTrails(ctx, v, frame);
  drawConflicts(ctx, v, frame);
  drawAircraft(ctx, v, frame, layers);
  drawScaleBar(ctx, v);
  drawCompass(ctx, v);
}

