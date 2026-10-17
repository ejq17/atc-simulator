/**
 * Radar-style situation display renderer (Canvas 2D). North-up (TRUE); the compass rose is labelled with
 * MAGNETIC bearings, since that is what controllers and pilots speak. Pure functions of (ctx, frame, view, layers).
 */
import type { Aircraft, Airport, NavigationAid, Vec2 } from '../../sim/types';
import type { Frame } from './frame';
import { FONT_MONO } from './palette';
import { placeLabels } from './labels';
import type { LabelRequest } from './labels';
import { worldToScreen } from './viewTransform';
import type { View } from './viewTransform';
import { M_PER_NM, deg2rad, headingVec, polygonCentroid } from '../lib/geom';
import { altHundreds, magHeading, phaseShort, trendArrow } from '../lib/format';
import { navLetter } from '../lib/ifr';
import { procedureGeometry } from '../lib/procedures';

export const RADAR_RANGES_NM = [5, 10, 20, 40, 60] as const;
export type RadarRangeNm = (typeof RADAR_RANGES_NM)[number];

export interface RadarLayers {
  rings: boolean;
  compass: boolean;
  approachPaths: boolean;
  /** Minimum vectoring altitude sectors (`airport.mvaSectors`); drawn from 20 NM range up, and only when the airport data has them. */
  mva: boolean;
  /** Instrument-procedure fixes (IF/FAF...) of the active landing runways and their final approach course. */
  procedures: boolean;
  /** Active route of the selected aircraft (dashed). */
  routes: boolean;
  navaids: boolean;
  fixes: boolean;
  allFixes: boolean;
  labels: boolean;
  history: boolean;
  groundTargets: boolean;
  sweep: boolean;
}

export const DEFAULT_RADAR_LAYERS: RadarLayers = {
  rings: true, compass: true, approachPaths: true, mva: true, procedures: true, routes: true, navaids: true, fixes: true, allFixes: false,
  labels: true, history: true, groundTargets: true, sweep: true,
};

export const RADAR_LAYER_LABELS: Record<keyof RadarLayers, string> = {
  rings: 'Range rings', compass: 'Compass rose', approachPaths: 'Approach paths', mva: 'MVA sectors (20 NM and up)', procedures: 'Procedure fixes (landing rwy)',
  routes: 'Selected aircraft route', navaids: 'Navaids', fixes: 'Approach fixes', allFixes: 'All fixes',
  labels: 'Data blocks', history: 'History dots', groundTargets: 'Ground targets', sweep: 'Sweep line (cosmetic)',
};

/** The approach fixes the product brief calls out; others appear under "all fixes". */
export const KEY_APPROACH_FIXES = ['CARYL', 'MAYBN', 'STEVV', 'PRSTY', 'SMITS'] as const;

export const RAD = {
  bg: '#040806',
  ring: '#16301d',
  ringText: '#3f7a50',
  rose: '#2f6a40',
  runway: '#9aa7b4',
  approach: '#2f7f95',
  navaid: '#8ea0b3',
  fix: '#6d8a78',
  ground: '#5a6a60',
  airborne: '#7bf08f',
  arrival: '#39c5e8',
  sweep: '57,211,83',
  route: '#c58cff',
  procFix: '#4fb3cf',
  mva: '#8a6f3c',
  text: '#c9ded0',
} as const;

/** Pixels per metre so that `rangeNm` just fits the shorter canvas axis. */
export function radarScale(rangeNm: number, width: number, height: number, marginPx = 34): number {
  return (Math.min(width, height) / 2 - marginPx) / (rangeNm * M_PER_NM);
}

/** Ring spacing (nm) for a range: aims for 4-5 rings. */
export function ringSpacingNm(rangeNm: number): number {
  return rangeNm <= 5 ? 1 : rangeNm <= 10 ? 2 : rangeNm <= 20 ? 5 : 10; // 40 and 60 NM: 10 NM rings
}

export interface DataBlock { lines: string[] }

/** Radar data block text for an airborne target. Altitude in hundreds of feet, heading magnetic. */
export function dataBlock(ac: Aircraft, variationDeg: number, groundSpeedKt = ac.groundSpeedKt, altitudeFt = ac.altitudeFt, headingDeg = ac.headingDeg): DataBlock {
  const arrow = trendArrow(ac.verticalSpeedFpm);
  const mode = navLetter(ac);
  return {
    lines: [
      `${ac.callsign} ${ac.type}`,
      `${altHundreds(altitudeFt)}${arrow || ' '}${String(Math.round(groundSpeedKt)).padStart(3, ' ')}${ac.squawk ? ` ${ac.squawk}` : ''}`,
      `H${magHeading(headingDeg, variationDeg)} ${phaseShort(ac.phase)}${mode ? ` ${mode}` : ''}`,
    ],
  };
}

/** Approach-path geometry for a landing runway end: the extended centreline outward from the threshold. */
export function approachPath(airport: Airport, endId: string, lengthNm = 10): { start: Vec2; end: Vec2; ticks: { nm: number; p: Vec2 }[] } | undefined {
  for (const rw of airport.runways) {
    const e = rw.ends.find((x) => x.id === endId);
    if (!e) continue;
    const dir = headingVec(e.trueHeadingDeg);
    const at = (nm: number): Vec2 => ({ x: e.threshold.x - dir.x * nm * M_PER_NM, y: e.threshold.y - dir.y * nm * M_PER_NM });
    const ticks = [];
    for (let nm = 1; nm <= lengthNm; nm++) ticks.push({ nm, p: at(nm) });
    return { start: e.threshold, end: at(lengthNm), ticks };
  }
  return undefined;
}

const toScr = (v: View, p: Vec2) => worldToScreen(v, p);

function drawRings(ctx: CanvasRenderingContext2D, v: View, rangeNm: number, layers: RadarLayers): void {
  const c = toScr(v, { x: 0, y: 0 });
  if (layers.rings) {
    const step = ringSpacingNm(rangeNm);
    ctx.lineWidth = 1;
    ctx.font = `10px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (let nm = step; nm <= rangeNm + 1e-6; nm += step) {
      const r = nm * M_PER_NM * v.scale;
      ctx.strokeStyle = nm === rangeNm ? RAD.rose : RAD.ring;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
      const a = deg2rad(135);
      ctx.fillStyle = RAD.ringText;
      ctx.fillText(nm === rangeNm ? `${nm} NM` : String(nm), c.x + Math.sin(a) * r - 4, c.y - Math.cos(a) * r - 3);
    }
    // Range crosshair
    ctx.strokeStyle = RAD.ring;
    const R = rangeNm * M_PER_NM * v.scale;
    ctx.beginPath();
    ctx.moveTo(c.x - R, c.y);
    ctx.lineTo(c.x + R, c.y);
    ctx.moveTo(c.x, c.y - R);
    ctx.lineTo(c.x, c.y + R);
    ctx.stroke();
  }
}

function drawCompassRose(ctx: CanvasRenderingContext2D, v: View, rangeNm: number, variationDeg: number): void {
  const c = toScr(v, { x: 0, y: 0 });
  const R = rangeNm * M_PER_NM * v.scale;
  ctx.strokeStyle = RAD.rose;
  ctx.fillStyle = RAD.ringText;
  ctx.font = `10px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let mag = 0; mag < 360; mag += 5) {
    // magnetic bearing -> true bearing: true = mag + variation (east-positive, KACY -10).
    const trueDeg = mag + variationDeg;
    const a = deg2rad(trueDeg);
    const long = mag % 30 === 0;
    const mid = mag % 10 === 0;
    const len = long ? 12 : mid ? 8 : 4;
    const sx = Math.sin(a);
    const sy = -Math.cos(a);
    ctx.lineWidth = long ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(c.x + sx * R, c.y + sy * R);
    ctx.lineTo(c.x + sx * (R + len), c.y + sy * (R + len));
    ctx.stroke();
    if (long) {
      const label = String(mag === 0 ? 360 : mag).padStart(3, '0');
      ctx.fillText(label, c.x + sx * (R + 24), c.y + sy * (R + 24));
    }
  }
}

function drawAirport(ctx: CanvasRenderingContext2D, v: View, airport: Airport): void {
  ctx.strokeStyle = RAD.runway;
  ctx.fillStyle = 'rgba(154,167,180,0.35)';
  ctx.lineWidth = 1;
  for (const rw of airport.runways) {
    const a = toScr(v, rw.ends[0].threshold);
    const b = toScr(v, rw.ends[1].threshold);
    const widthPx = Math.max(2.2, (rw.widthFt * 0.3048) * v.scale);
    ctx.lineWidth = widthPx;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawApproachPaths(ctx: CanvasRenderingContext2D, v: View, airport: Airport, landing: readonly string[], rangeNm: number, layers: RadarLayers): void {
  ctx.font = `10px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const id of landing) {
    // Out to the IF of the published procedure (at least 10 NM, never past the scope).
    const ifNm = layers.procedures ? Math.ceil(procedureGeometry(airport, id)?.ifNm ?? 0) : 0;
    const ap = approachPath(airport, id, Math.min(40, Math.max(10, ifNm, Math.min(10, rangeNm))));
    if (!ap) continue;
    const a = toScr(v, ap.start);
    const b = toScr(v, ap.end);
    ctx.strokeStyle = RAD.approach;
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Perpendicular unit on screen
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    for (const t of ap.ticks) {
      const s = toScr(v, t.p);
      const half = t.nm % 5 === 0 ? 6 : 3.5;
      ctx.beginPath();
      ctx.moveTo(s.x - px * half, s.y - py * half);
      ctx.lineTo(s.x + px * half, s.y + py * half);
      ctx.stroke();
      if (t.nm % 5 === 0) {
        ctx.fillStyle = RAD.approach;
        ctx.fillText(`${t.nm}`, s.x + px * 14, s.y + py * 14);
      }
    }
    ctx.fillStyle = RAD.approach;
    ctx.textAlign = 'left';
    // The far end of the course carries the published procedure name when there is one ("ILS 13"), else the runway.
    ctx.fillText(layers.procedures ? (procedureGeometry(airport, id)?.label ?? `RWY ${id}`) : `RWY ${id}`, b.x + 6, b.y);
    ctx.textAlign = 'center';
  }
}

function inRange(p: Vec2, rangeNm: number): boolean {
  return Math.hypot(p.x, p.y) <= rangeNm * M_PER_NM;
}

function drawNavaids(ctx: CanvasRenderingContext2D, v: View, airport: Airport, rangeNm: number, layers: RadarLayers, skip: ReadonlySet<string>): void {
  ctx.font = `10px ${FONT_MONO}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const keyFix = new Set<string>(KEY_APPROACH_FIXES);
  for (const n of airport.navaids as NavigationAid[]) {
    if (!inRange(n.pos, rangeNm) || skip.has(n.id)) continue;
    const s = toScr(v, n.pos);
    if (n.type === 'VORTAC' || n.type === 'VOR' || n.type === 'VOR/DME') {
      if (!layers.navaids) continue;
      ctx.strokeStyle = RAD.navaid;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const x = s.x + Math.cos(a) * 6;
        const y = s.y + Math.sin(a) * 6;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = RAD.navaid;
      ctx.fillRect(s.x - 1, s.y - 1, 2, 2);
      ctx.fillText(n.id, s.x + 9, s.y);
    } else if (n.type === 'FIX' || n.type === 'WAYPOINT') {
      if (!layers.fixes) continue;
      if (!layers.allFixes && !keyFix.has(n.id)) continue;
      ctx.strokeStyle = RAD.fix;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 5);
      ctx.lineTo(s.x + 4.5, s.y + 3.5);
      ctx.lineTo(s.x - 4.5, s.y + 3.5);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = RAD.fix;
      ctx.fillText(n.id, s.x + 8, s.y);
    }
  }
}

/** MVA sectors are drawn at 20 NM and wider, when the layer is on and the airport data has sectors. */
export const MVA_MIN_RANGE_NM = 20;
export function mvaVisible(airport: Pick<Airport, 'mvaSectors'>, layers: Pick<RadarLayers, 'mva'>, rangeNm: number): boolean {
  return layers.mva && rangeNm >= MVA_MIN_RANGE_NM && !!airport.mvaSectors?.length;
}

/** Sector label: altitude in hundreds of feet ("025") at the sector centroid. */
export function mvaLabel(sector: { polygon: Vec2[]; altitudeFt: number }): { text: string; at: Vec2 } {
  return { text: altHundreds(sector.altitudeFt), at: polygonCentroid(sector.polygon) };
}

function drawMva(ctx: CanvasRenderingContext2D, v: View, airport: Airport): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = RAD.mva;
  ctx.fillStyle = RAD.mva;
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([2, 3]);
  for (const sec of airport.mvaSectors ?? []) {
    if (sec.polygon.length < 3) continue;
    ctx.beginPath();
    sec.polygon.forEach((p, i) => {
      const s = toScr(v, p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = `600 11px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const sec of airport.mvaSectors ?? []) {
    if (sec.polygon.length < 3) continue;
    const l = mvaLabel(sec);
    const s = toScr(v, l.at);
    if (s.x < 0 || s.y < 0 || s.x > v.width || s.y > v.height) continue;
    ctx.fillText(l.text, s.x, s.y);
  }
  ctx.restore();
}

function navaidPos(airport: Airport, id: string): Vec2 | undefined {
  return airport.navaids.find((n) => n.id === id)?.pos;
}

function fixSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, filled: boolean): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(x, y - 6);
  ctx.lineTo(x + 5.5, y + 4);
  ctx.lineTo(x - 5.5, y + 4);
  ctx.closePath();
  if (filled) ctx.fill();
  else ctx.stroke();
}

/** Ids of the on-course approach fixes for the active landing runways (drawn by `drawProcedures`). */
function procedureFixIds(airport: Airport, landing: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const end of landing) for (const f of procedureGeometry(airport, end)?.onCourse ?? []) ids.add(f.id);
  return ids;
}

/** Published approach fixes of the active landing runways: on-course fixes with the IF/FAF tag and procedure name. */
function drawProcedures(ctx: CanvasRenderingContext2D, v: View, airport: Airport, landing: readonly string[], rangeNm: number): void {
  ctx.font = `10px ${FONT_MONO}`;
  ctx.textBaseline = 'middle';
  for (const end of landing) {
    const g = procedureGeometry(airport, end);
    const re = airport.runways.flatMap((r) => r.ends).find((e) => e.id === end);
    if (!g || !re || g.onCourse.length === 0) continue;
    const t = toScr(v, re.threshold);
    g.onCourse.forEach((f, i) => {
      if (!inRange(f.pos, rangeNm)) return;
      const s = toScr(v, f.pos);
      fixSymbol(ctx, s.x, s.y, RAD.procFix, true);
      // The course's distance numerals sit on one side of the line; the fix name goes on the other.
      const dx = s.x - t.x;
      const dy = s.y - t.y;
      const len = Math.hypot(dx, dy) || 1;
      const ox = (dy / len) * 11;
      const oy = (-dx / len) * 11;
      ctx.textAlign = ox < 0 ? 'right' : 'left';
      ctx.fillStyle = RAD.procFix;
      ctx.fillText(f.id, s.x + ox, s.y + oy - 5);
      // Tags: the farthest on-course fix is the IF, the nearest one at least 3 NM out is the FAF.
      const last = i === g.onCourse.length - 1;
      const faf = !last && f.alongNm >= 3 && g.onCourse.findIndex((x) => x.alongNm >= 3) === i;
      if (last || faf) {
        ctx.fillStyle = RAD.approach;
        ctx.fillText(last ? 'IF' : 'FAF', s.x + ox, s.y + oy + 6);
      }
    });
  }
  ctx.textAlign = 'left';
}

/** Ids on the selected aircraft's active route. */
function routeFixIds(frame: Frame): string[] {
  const ac = frame.selectedId ? frame.state.aircraft[frame.selectedId] : undefined;
  if (!ac?.nav || ac.onGround) return [];
  return ac.nav.fixes.slice(Math.min(ac.nav.index, ac.nav.fixes.length));
}

/** Dashed line from the selected aircraft through the fixes it is flying to; fainter when it is on vectors. */
function drawRoute(ctx: CanvasRenderingContext2D, v: View, frame: Frame, labelled: ReadonlySet<string>): void {
  const ac = frame.selectedId ? frame.state.aircraft[frame.selectedId] : undefined;
  if (!ac?.nav || ac.onGround) return;
  const airport = frame.state.airport;
  const ids = routeFixIds(frame);
  const pts: { id: string; p: Vec2 }[] = [];
  for (const id of ids) {
    const p = navaidPos(airport, id);
    if (p) pts.push({ id, p });
  }
  if (pts.length === 0) return;
  const vectors = ac.nav.mode === 'vectors';
  const pose = frame.pose(ac);
  const start = toScr(v, { x: pose.x, y: pose.y });
  ctx.save();
  ctx.strokeStyle = RAD.route;
  ctx.fillStyle = RAD.route;
  ctx.globalAlpha = vectors ? 0.35 : 0.9;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  for (const q of pts) {
    const s = toScr(v, q.p);
    ctx.lineTo(s.x, s.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `10px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  pts.forEach((q, i) => {
    if (labelled.has(q.id)) return; // already drawn (and tagged) as a procedure fix
    const s = toScr(v, q.p);
    fixSymbol(ctx, s.x, s.y, RAD.route, i === 0);
    ctx.fillText(q.id, s.x + 9, s.y - 2);
  });
  ctx.restore();
}

function drawSweep(ctx: CanvasRenderingContext2D, v: View, rangeNm: number, nowMs: number): void {
  const c = toScr(v, { x: 0, y: 0 });
  const R = rangeNm * M_PER_NM * v.scale;
  const ang = ((nowMs / 4000) * Math.PI * 2) % (Math.PI * 2); // one revolution per 4 s, cosmetic only
  const slices = 18;
  const span = deg2rad(34);
  for (let i = 0; i < slices; i++) {
    const a0 = ang - (span * (i + 1)) / slices - Math.PI / 2;
    const a1 = ang - (span * i) / slices - Math.PI / 2;
    ctx.fillStyle = `rgba(${RAD.sweep},${0.055 * (1 - i / slices)})`;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.arc(c.x, c.y, R, a0, a1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = `rgba(${RAD.sweep},0.35)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x + Math.cos(ang - Math.PI / 2) * R, c.y + Math.sin(ang - Math.PI / 2) * R);
  ctx.stroke();
}

function drawTargets(ctx: CanvasRenderingContext2D, v: View, frame: Frame, layers: RadarLayers): void {
  const variation = frame.state.airport.magneticVariationDeg;
  ctx.font = `11px ${FONT_MONO}`;
  const acs = Object.values(frame.state.aircraft)
    .filter((a) => layers.groundTargets || !a.onGround)
    .sort((a, b) => (a.id === frame.selectedId ? -1 : b.id === frame.selectedId ? 1 : 0));

  const items: { ac: Aircraft; x: number; y: number; lines: string[]; selected: boolean; air: boolean }[] = [];
  const reqs: LabelRequest[] = [];
  for (const ac of acs) {
    const p = frame.pose(ac);
    const s = toScr(v, { x: p.x, y: p.y });
    if (s.x < -80 || s.y < -80 || s.x > v.width + 80 || s.y > v.height + 80) continue;
    const air = !ac.onGround;
    const lines = air ? dataBlock(ac, variation, p.groundSpeedKt, p.altitudeFt, p.headingDeg).lines : [ac.callsign];
    items.push({ ac, x: s.x, y: s.y, lines, selected: ac.id === frame.selectedId, air });
    if (layers.labels) {
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
      reqs.push({ id: ac.id, x: s.x, y: s.y, w, h: lines.length * 13 + 6 });
    }
  }
  const placed = new Map(placeLabels(reqs, [], 14, { width: v.width, height: v.height }).map((p) => [p.id, p]));

  for (const it of items) {
    const { ac, x, y, selected, air } = it;
    const color = !air ? RAD.ground : ac.phase === 'APPROACH' || ac.phase === 'FINAL' || ac.phase === 'INBOUND' ? RAD.arrival : RAD.airborne;
    // History dots
    if (layers.history) {
      const h = ac.history;
      for (let i = 1; i <= 5 && h.length - i >= 0; i++) {
        const q = toScr(v, h[h.length - i]);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.65 - i * 0.1;
        ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
    }
    // Target symbol
    if (air) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 4, y - 4, 8, 8);
      if (ac.radarIdentified) {
        // Radar-identified: the target square carries a centre dot.
        ctx.fillStyle = color;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
      // heading tick (velocity vector, 60 s of ground speed would be long: use a fixed short stub)
      const hv = headingVec(frame.pose(ac).headingDeg);
      ctx.beginPath();
      ctx.moveTo(x + hv.x * 4, y - hv.y * 4);
      ctx.lineTo(x + hv.x * 13, y - hv.y * 13);
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (selected) {
      ctx.strokeStyle = '#39c5e8';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 10, y - 10, 20, 20);
    }
    const lab = placed.get(ac.id);
    if (lab) {
      ctx.strokeStyle = selected ? '#39c5e8' : color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(lab.anchorX, lab.anchorY);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(4,8,6,0.78)';
      ctx.fillRect(lab.x, lab.y, lab.w, lab.h);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      it.lines.forEach((l, i) => {
        ctx.fillStyle = selected ? '#39c5e8' : air ? (i === 0 ? color : RAD.text) : RAD.ground;
        ctx.font = `${i === 0 ? '600 ' : ''}11px ${FONT_MONO}`;
        ctx.fillText(l, lab.x + 5, lab.y + 3 + i * 13);
      });
    }
  }
}

function drawConflictLines(ctx: CanvasRenderingContext2D, v: View, frame: Frame): void {
  const pulse = 0.5 + 0.5 * Math.sin(frame.nowMs / 200);
  for (const al of frame.state.conflicts) {
    if (al.aircraftIds.length < 1) continue;
    const col = al.severity === 'critical' ? '#ff4d4f' : '#f2b33d';
    const pts = al.aircraftIds
      .map((id) => frame.state.aircraft[id])
      .filter(Boolean)
      .map((a) => {
        const p = frame.pose(a);
        return toScr(v, { x: p.x, y: p.y });
      });
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.5 + 0.5 * pulse;
    ctx.lineWidth = 2;
    for (const s of pts) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 16, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (pts.length === 2) {
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }
}

function drawCaption(ctx: CanvasRenderingContext2D, v: View, rangeNm: number, airport: Airport): void {
  const y = v.height - 62;
  ctx.font = `600 12px ${FONT_MONO}`;
  ctx.fillStyle = RAD.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`RANGE ${rangeNm} NM`, 14, y);
  ctx.font = `10px ${FONT_MONO}`;
  ctx.fillStyle = RAD.ringText;
  ctx.fillText('NORTH UP (TRUE)  ROSE: MAGNETIC', 14, y + 17);
  ctx.fillText(`VAR ${Math.abs(airport.magneticVariationDeg)}\u00b0${airport.magneticVariationDeg < 0 ? 'W' : 'E'}  ALT = HUNDREDS FT MSL`, 14, y + 30);
}

/** Render one complete radar frame. */
export function drawRadar(ctx: CanvasRenderingContext2D, frame: Frame, v: View, rangeNm: number, layers: RadarLayers): void {
  const { state } = frame;
  const airport = state.airport;
  ctx.fillStyle = RAD.bg;
  ctx.fillRect(0, 0, v.width, v.height);
  drawRings(ctx, v, rangeNm, layers);
  if (layers.compass) drawCompassRose(ctx, v, rangeNm, airport.magneticVariationDeg);
  if (mvaVisible(airport, layers, rangeNm)) drawMva(ctx, v, airport);
  if (layers.sweep) drawSweep(ctx, v, rangeNm, frame.nowMs);
  if (layers.approachPaths) drawApproachPaths(ctx, v, airport, state.activeRunways.landing, rangeNm, layers);
  drawAirport(ctx, v, airport);
  const skip = new Set<string>();
  const procIds = layers.procedures ? procedureFixIds(airport, state.activeRunways.landing) : new Set<string>();
  for (const id of procIds) skip.add(id);
  if (layers.routes) for (const id of routeFixIds(frame)) skip.add(id);
  drawNavaids(ctx, v, airport, rangeNm, layers, skip);
  if (layers.procedures) drawProcedures(ctx, v, airport, state.activeRunways.landing, rangeNm);
  if (layers.routes) drawRoute(ctx, v, frame, procIds);
  drawConflictLines(ctx, v, frame);
  drawTargets(ctx, v, frame, layers);
  drawCaption(ctx, v, rangeNm, airport);
}
