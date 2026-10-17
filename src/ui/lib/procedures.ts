/**
 * Instrument-procedure geometry for the radar: which published fixes of a landing runway's approach lie on the final
 * approach course ("on-course" fixes, the straight-in segment), where the IF is, and which are feeders. Pure functions of
 * `airport.procedures` + `airport.navaids`; no airport-specific knowledge.
 *
 * The test mirrors the engine's own rule (src/sim/README.md "Procedure geometry"): on-course = 1-40 nm out the back of the
 * threshold with |cross| <= 0.2 d + 0.3 nm; fixes listed before the last on-course one are feeders (VCN for ILS 13).
 */
import type { Airport, InstrumentProcedure, NavigationAid, Vec2 } from '../../sim/types';
import { M_PER_NM, headingVec } from './geom';

export interface ProcedureFixInfo {
  id: string;
  pos: Vec2;
  /** Distance along the final approach course out from the threshold, nm (negative: past the threshold). */
  alongNm: number;
  /** Lateral offset from the extended centreline, nm. */
  crossNm: number;
}

export interface ProcedureGeometry {
  endId: string;
  procedure: InstrumentProcedure;
  /** Short label such as "ILS 13", "RNAV 22". */
  label: string;
  /** On-course fixes, nearest the runway first. The last one is the IF/IAF. */
  onCourse: ProcedureFixInfo[];
  /** Fixes listed before the first on-course fix (feeders / IAF off the course). */
  feeders: ProcedureFixInfo[];
  /** Distance of the farthest on-course fix (the IF), nm; 0 when none. */
  ifNm: number;
}

const KIND_ORDER = ['ILS', 'RNAV', 'LOC', 'VOR'] as const;

function kindOf(p: InstrumentProcedure): (typeof KIND_ORDER)[number] | undefined {
  const n = p.name.toUpperCase();
  if (n.startsWith('HI-') || n.includes('COPTER')) return undefined;
  return KIND_ORDER.find((k) => n.includes(k));
}

/** The procedure the radar draws for a runway end: ILS first, then RNAV, LOC, VOR; the first listed among equals. */
export function pickProcedure(airport: Pick<Airport, 'procedures'>, endId: string): { procedure: InstrumentProcedure; label: string } | undefined {
  let best: { p: InstrumentProcedure; rank: number; kind: string } | undefined;
  for (const p of airport.procedures) {
    if (p.type !== 'IAP' || p.runwayEnd !== endId || !p.fixes?.length) continue;
    const kind = kindOf(p);
    if (!kind) continue;
    const rank = KIND_ORDER.indexOf(kind);
    if (!best || rank < best.rank) best = { p, rank, kind };
  }
  return best ? { procedure: best.p, label: `${best.kind} ${endId}` } : undefined;
}

const cache = new WeakMap<object, Map<string, ProcedureGeometry | null>>();

export function procedureGeometry(airport: Pick<Airport, 'procedures' | 'navaids' | 'runways'>, endId: string): ProcedureGeometry | undefined {
  let m = cache.get(airport);
  if (!m) cache.set(airport, (m = new Map()));
  const hit = m.get(endId);
  if (hit !== undefined) return hit ?? undefined;
  const g = compute(airport, endId);
  m.set(endId, g ?? null);
  return g;
}

function compute(airport: Pick<Airport, 'procedures' | 'navaids' | 'runways'>, endId: string): ProcedureGeometry | undefined {
  const pick = pickProcedure(airport, endId);
  const end = airport.runways.flatMap((r) => r.ends).find((e) => e.id === endId);
  if (!pick || !end) return undefined;
  const dir = headingVec(end.trueHeadingDeg);
  const byId = new Map<string, NavigationAid>(airport.navaids.map((n) => [n.id, n]));
  const infos: ProcedureFixInfo[] = [];
  for (const id of pick.procedure.fixes ?? []) {
    const n = byId.get(id);
    if (!n) continue;
    const dx = (n.pos.x - end.threshold.x) / M_PER_NM;
    const dy = (n.pos.y - end.threshold.y) / M_PER_NM;
    infos.push({ id, pos: n.pos, alongNm: -(dx * dir.x + dy * dir.y), crossNm: dx * -dir.y + dy * dir.x });
  }
  const on = (f: ProcedureFixInfo) => f.alongNm >= 1 && f.alongNm <= 40 && Math.abs(f.crossNm) <= 0.2 * f.alongNm + 0.3;
  const onCourse = infos.filter(on).sort((a, b) => a.alongNm - b.alongNm);
  const firstOn = infos.findIndex(on);
  const feeders = firstOn > 0 ? infos.slice(0, firstOn).filter((f) => !on(f) && f.alongNm > 0) : [];
  return { endId, procedure: pick.procedure, label: pick.label, onCourse, feeders, ifNm: onCourse.length ? onCourse[onCourse.length - 1].alongNm : 0 };
}
