/**
 * Instrument / visual approach analysis. Pure functions of (airport, weather, aircraft): used by the APPROACH
 * planner in commandExecutor and by the clearance safety assessment in conflicts.
 *
 * Nothing here is airport specific. A procedure is `Airport.procedures[]` of type IAP with a `runwayEnd` and an
 * ordered `fixes` list that refers to `Airport.navaids`. The fix list is classified GEOMETRICALLY against the
 * runway end (d = distance before the threshold along the runway course, cross = lateral offset):
 *
 *   on-course   1 nm <= d <= 40 nm and |cross| <= 0.2 d + 0.3 nm. These form the straight-in segment, flown
 *               farthest first. FAF = the on-course fix closest to the threshold that is still >= 3 nm out.
 *   feeders     fixes listed BEFORE the last on-course fix that are not themselves on course (IAFs / transitions),
 *               kept in list order.
 *   the rest    fixes listed after the last on-course fix, or on the threshold (missed approach points / holding
 *               fixes) are never flown as part of the approach.
 *
 * Simplifications (documented in README): the final approach course is the RUNWAY HEADING for every approach type
 * (RNAV 22 and VOR 4 at KACY are really offset by a few degrees); no minimums, no altitude restrictions per fix, no
 * procedure turns. Altitude handling lives in flightDynamics (hold the assigned altitude, then the 3 degree path).
 */
import type { Aircraft, Airport, ApproachType, InstrumentProcedure, SimulationState, Weather } from './types';
import { bearingDeg, deg2rad, dist, headingDiff, headingToVec, magneticToTrue, mToNm, nmToM } from './geo';
import type { Vec2 } from './types';
import { alongCross, normalizeRunwayEndId } from './runways';
import type { RunwayEndGeom } from './runways';
import { findNavFix, fixPosition } from './navigation';
import { spokenRunway } from '../radio/spoken';

export const APPROACH_RANGE_NM = 30;
export const MAX_INTERCEPT_ANGLE_DEG = 30;
export const MAX_INTERCEPT_AHEAD_NM = 10;
/** 7110.65 TBL 5-9-1: 20 degrees when the intercept is less than 2 miles from the approach gate. */
export const MAX_INTERCEPT_ANGLE_NEAR_GATE_DEG = 20;
export const GATE_INTERCEPT_MARGIN_M = nmToM(2);
/** P/CG APPROACH GATE: 1 nm outside the FAF on the final approach course and no closer than 5 nm to the landing threshold. */
export const approachGateDM = (fafDM: number): number => Math.max(nmToM(5), fafDM + nmToM(1));
export const FALLBACK_FAF_NM = 4.5;
/** Aircraft that cleared for an approach join FINAL (glidepath logic) when established inside this distance. */
export const APPROACH_FINAL_NM = 8;
/** Simplified VMC for a visual approach: category VFR or MVFR, ceiling >= 1000 ft AGL, visibility >= 3 sm. */
export const VISUAL_MIN_CEILING_FT = 1000;
export const VISUAL_MIN_VISIBILITY_SM = 3;
/** Within this lateral distance of the course (and <= 30 degrees) the aircraft counts as already established. */
const ESTABLISHED_CROSS_M = nmToM(0.25);

export interface CourseFix {
  id: string;
  /** Distance before the threshold along the course (m). */
  dM: number;
  /** Lateral offset (m, + = right of the course). */
  crossM: number;
}

export interface ProcedureInfo {
  procedure: InstrumentProcedure;
  /** TRUE final approach course (see `finalCourseTrue`). */
  courseTrue: number;
  feeders: string[];
  onCourse: CourseFix[];
  faf?: CourseFix;
}

export function isOnCourse(dNm: number, crossNm: number): boolean {
  return dNm >= 1 && dNm <= 40 && Math.abs(crossNm) <= 0.2 * dNm + 0.3;
}

/**
 * A copy of the runway end geometry whose along/cross frame is the given final approach COURSE (origin: the threshold, unchanged),
 * so the lateral / approach logic can use `alongCross`, `centrelineHeading` etc. against a course that is not the runway heading.
 */
export function courseGeom(g: RunwayEndGeom, courseTrue: number | undefined): RunwayEndGeom {
  // A displaced threshold moves the origin of the approach frame to the LANDING threshold (distances on the plate, the glidepath and the
  // decision point are measured to it); the pavement end stays the origin of everything else (takeoff, rollout, occupancy).
  const base = g.displacedM > 0 ? { ...g, end: { ...g.end, threshold: g.landingThreshold } } : g;
  if (courseTrue === undefined || Math.abs(headingDiff(g.headingDeg, courseTrue)) < 1e-9) return base;
  const dir = headingToVec(courseTrue);
  return { ...base, dir, right: { x: dir.y, y: -dir.x }, headingDeg: courseTrue };
}

/**
 * Final approach course (TRUE) of a procedure:
 *   ILS / LOC procedures: the NASR localizer course of the runway end (`RunwayEnd.ils.courseDeg`, magnetic) when present;
 *   otherwise the bearing from the FAF to the runway threshold (the FAF = the on-course fix nearest the threshold that is >= 3 nm out);
 *   the runway heading only when neither exists.
 */
export function finalCourseTrue(airport: Airport, g: RunwayEndGeom, proc: InstrumentProcedure | undefined, faf: CourseFix | undefined): number {
  if (proc && /\b(ILS|LOC)\b/i.test(proc.name) && g.end.ils && Number.isFinite(g.end.ils.courseDeg)) {
    return magneticToTrue(g.end.ils.courseDeg, airport.magneticVariationDeg);
  }
  const fp = faf ? findNavFix(airport, faf.id)?.pos : undefined;
  return fp ? bearingDeg(fp, g.end.threshold) : g.headingDeg;
}

export function analyzeProcedure(airport: Airport, proc: InstrumentProcedure, g: RunwayEndGeom): ProcedureInfo {
  const listed = (proc.fixes ?? []).map((id) => {
    const n = findNavFix(airport, id);
    if (!n) return { id, known: false, dM: 0, crossM: 0, on: false };
    const { along, cross } = alongCross(g, n.pos);
    const dM = -along;
    return { id: n.id, known: true, dM, crossM: cross, on: isOnCourse(mToNm(dM), mToNm(cross)) };
  });
  let lastOn = -1;
  listed.forEach((f, i) => {
    if (f.on) lastOn = i;
  });
  const feeders = listed.filter((f, i) => f.known && !f.on && i < lastOn).map((f) => f.id);
  const onCourse = listed.filter((f) => f.on).map((f) => ({ id: f.id, dM: f.dM, crossM: f.crossM })).sort((a, b) => b.dM - a.dM);
  const outside3 = onCourse.filter((f) => f.dM >= nmToM(3));
  const faf = outside3.length ? outside3[outside3.length - 1] : onCourse[onCourse.length - 1];
  return { procedure: proc, courseTrue: finalCourseTrue(airport, g, proc, faf), feeders, onCourse, faf };
}

const TYPE_PATTERN: Record<Exclude<ApproachType, 'VISUAL'>, RegExp> = {
  ILS: /\bILS\b/i,
  LOC: /\bLOC\b/i,
  RNAV: /\bRNAV\b/i,
  VOR: /\bVOR\b/i,
};

/** Published IAPs for the runway end whose title names the approach type (copter and high-altitude variants last). */
export function matchingProcedures(airport: Airport, type: ApproachType, runwayEnd: string): InstrumentProcedure[] {
  if (type === 'VISUAL') return [];
  const end = normalizeRunwayEndId(runwayEnd);
  const out = airport.procedures.filter(
    (p) => p.type === 'IAP' && !!p.runwayEnd && normalizeRunwayEndId(p.runwayEnd) === end && TYPE_PATTERN[type].test(p.name) && !/\bCOPTER\b/i.test(p.name),
  );
  const hi = (p: InstrumentProcedure) => (/^HI[- ]/i.test(p.name) ? 1 : 0);
  return out.map((p, i) => ({ p, i })).sort((a, b) => hi(a.p) - hi(b.p) || a.i - b.i).map((x) => x.p);
}

/** Lowest broken / overcast / vertical-visibility layer base (ft AGL); Infinity if none. */
export function ceilingFt(w: Weather): number {
  let c = Infinity;
  for (const l of w.clouds) if ((l.cover === 'BKN' || l.cover === 'OVC' || l.cover === 'VV') && l.baseFtAgl < c) c = l.baseFtAgl;
  return c;
}

export function visualApproachAllowed(w: Weather): { ok: boolean; why?: string } {
  if (w.flightCategory !== 'VFR' && w.flightCategory !== 'MVFR') return { ok: false, why: `the weather is ${w.flightCategory}` };
  const c = ceilingFt(w);
  if (c < VISUAL_MIN_CEILING_FT) return { ok: false, why: `the ceiling is ${Math.round(c)} ft` };
  if (w.visibilitySm < VISUAL_MIN_VISIBILITY_SM) return { ok: false, why: `the visibility is ${w.visibilitySm} sm` };
  return { ok: true };
}

export interface ApproachPlan {
  /** TRUE final approach course (undefined for visual approaches: the runway heading). */
  courseTrue?: number;
  /** route: fly `fixes` (join a published route); intercept: keep the vector, capture the course, then `fixes`; auto: fly to the runway on its own. */
  mode: 'route' | 'intercept' | 'auto';
  procedureId?: string;
  fixes: string[];
  /** Fixes of the straight-in segment (farthest first). */
  onCourse: string[];
  fafDM: number;
  /**
   * Distance before the threshold (m) where the aircraft is (or will be) established on the course: its own
   * distance when it is already on / within the on-course tolerance of the course, else the projected join point
   * (intercept point, or the first on-course fix it will fly).
   */
  joinDM: number;
  /** Distance (m) the aircraft still has to fly to reach `joinDM` (0 when already on the course); used to project spacing to the moment of joining. */
  joinTravelM: number;
  /** Distance before the threshold (m) of the outermost on-course fix (IF / IAF of the straight-in segment). */
  ifDM?: number;
  interceptDM?: number;
  interceptAngleDeg?: number;
}

export type ApproachAssessment =
  | { kind: 'hard'; reason: string; pilot: string }
  | { kind: 'ok'; plan: ApproachPlan; geometry?: { reason: string; pilot: string } };

/** Length (m) of the path from `from` through the given fixes (unknown fixes are skipped). */
function pathLengthM(airport: Airport, from: Vec2, ids: string[]): number {
  let len = 0;
  let prev = from;
  for (const id of ids) {
    const p = fixPosition(airport, id);
    if (!p) continue;
    len += dist(prev, p);
    prev = p;
  }
  return len;
}

const typeWord = (t: ApproachType): string => (t === 'LOC' ? 'localizer' : t === 'VISUAL' ? 'visual' : t);

/**
 * Can `ac` fly `type` to runway end `g`? `hard` = impossible (always refused); `geometry` = flyable but improperly
 * set up (intercept angle too large, inside the final approach fix...): training refuses, other modes accept and flag.
 * `autoNav` marks aircraft that navigate to the runway on their own (legacy AUTO guidance, no vectors, no route).
 */
export function assessApproach(
  state: Pick<SimulationState, 'airport' | 'weather'>,
  ac: Aircraft,
  type: ApproachType,
  g: RunwayEndGeom,
  o: { autoNav?: boolean } = {},
): ApproachAssessment {
  const { airport, weather } = state;
  const rwy = spokenRunway(g.end.id);
  const distThrNm = mToNm(dist(ac.pos, g.end.threshold));
  if (distThrNm > APPROACH_RANGE_NM) {
    return {
      kind: 'hard',
      reason: `${ac.callsign} is ${distThrNm.toFixed(0)} nm from runway ${g.end.id}; approach clearances are limited to ${APPROACH_RANGE_NM} nm.`,
      pilot: `we're too far out for the approach to runway ${rwy}`,
    };
  }
  const { along, cross } = alongCross(g, ac.pos);
  const d = -along;

  if (type === 'VISUAL') {
    const v = visualApproachAllowed(weather);
    if (!v.ok) {
      return { kind: 'hard', reason: `A visual approach needs VFR/MVFR weather with a ceiling of at least ${VISUAL_MIN_CEILING_FT} ft and ${VISUAL_MIN_VISIBILITY_SM} sm visibility: ${v.why}.`, pilot: `we can't accept a visual approach, we're not in visual conditions` };
    }
    return { kind: 'ok', plan: { mode: 'auto', fixes: [], onCourse: [], fafDM: nmToM(FALLBACK_FAF_NM), joinDM: Math.max(0, d), joinTravelM: 0 } };
  }

  const cands = matchingProcedures(airport, type, g.end.id);
  if (!cands.length) {
    return {
      kind: 'hard',
      reason: `No ${typeWord(type)} approach is published for runway ${g.end.id} at ${airport.icao}.`,
      pilot: `there is no ${type === 'LOC' ? 'localizer' : type} approach to runway ${rwy}`,
    };
  }
  const infos = cands.map((p) => analyzeProcedure(airport, p, g));
  const best = [...infos].sort((a, b) => b.onCourse.length - a.onCourse.length)[0];

  if (o.autoNav) {
    return { kind: 'ok', plan: { mode: 'auto', courseTrue: best.courseTrue, procedureId: best.procedure.id, fixes: [], onCourse: best.onCourse.map((f) => f.id), fafDM: best.faf?.dM ?? nmToM(FALLBACK_FAF_NM), joinDM: Math.max(0, d), joinTravelM: 0 } };
  }

  const nav = ac.nav;
  // --- A. aircraft on a route: it must join the procedure ---------------------
  if (nav && nav.mode !== 'vectors' && nav.index < nav.fixes.length) {
    const remaining = nav.fixes.slice(nav.index).map((f) => (findNavFix(airport, f)?.id ?? f).toUpperCase());
    for (const info of infos) {
      const on = info.onCourse.map((f) => f.id.toUpperCase());
      const fe = info.feeders.map((f) => f.toUpperCase());
      const j = remaining.find((r) => on.includes(r) || fe.includes(r));
      if (!j) continue;
      const fixes = fe.includes(j) ? [...info.feeders.slice(fe.indexOf(j)), ...info.onCourse.map((f) => f.id)] : info.onCourse.slice(on.indexOf(j)).map((f) => f.id);
      const joinFix = info.onCourse.find((f) => f.id.toUpperCase() === j) ?? info.onCourse[0];
      const fafDM = info.faf?.dM ?? nmToM(FALLBACK_FAF_NM);
      // Already on (or within the tolerance of) the course: measured at its own position. Otherwise at the first on-course fix it will fly.
      const onNow = d > 0 && isOnCourse(mToNm(d), mToNm(cross));
      const firstOn = fixes.findIndex((f) => on.includes(f.toUpperCase()));
      const plan: ApproachPlan = {
        mode: 'route', courseTrue: info.courseTrue, procedureId: info.procedure.id, fixes, onCourse: info.onCourse.map((f) => f.id), fafDM,
        joinDM: onNow ? d : joinFix ? joinFix.dM : Math.max(0, d),
        joinTravelM: onNow ? 0 : pathLengthM(airport, ac.pos, fixes.slice(0, (firstOn < 0 ? fixes.length - 1 : firstOn) + 1)),
        ifDM: info.onCourse[0]?.dM,
      };
      const inside = (joinFix && on.includes(j) && joinFix.dM < fafDM - 1) || (d > 0 && d < fafDM - 100 && Math.abs(cross) < nmToM(2));
      return inside
        ? { kind: 'ok', plan, geometry: { reason: `Unable: ${ac.callsign} is inside the final approach fix for the ${typeWord(type)} approach to runway ${g.end.id}.`, pilot: `we're inside the final approach fix` } }
        : { kind: 'ok', plan };
    }
    return {
      kind: 'hard',
      reason: `${ac.callsign} is not on a route that joins the ${typeWord(type)} approach to runway ${g.end.id}; vector the aircraft or send it direct to an approach fix.`,
      pilot: `we're not on a route that joins the approach, request vectors`,
    };
  }

  // --- B. vectors / heading: intercept geometry against the final approach course -------------
  const info = best;
  const fafDM = info.faf?.dM ?? nmToM(FALLBACK_FAF_NM);
  const gc = courseGeom(g, info.courseTrue); // the geometry below is against the final approach COURSE
  const { along: alongC, cross: crossC } = alongCross(gc, ac.pos);
  const dC = -alongC;
  const rel = headingDiff(gc.headingDeg, ac.target.headingDeg ?? ac.headingDeg); // assigned heading (TRUE); + = right of the course
  const angle = Math.abs(rel);
  const s = Math.sin(deg2rad(rel));
  const established = Math.abs(crossC) <= ESTABLISHED_CROSS_M;
  const converging = crossC * s < 0 && Math.abs(s) > 1e-3;
  const tM = established ? 0 : converging ? -crossC / s : Infinity;
  const dInt = established ? dC : converging ? dC - tM * Math.cos(deg2rad(rel)) : NaN;
  const ahead = (limit: number) => info.onCourse.filter((f) => f.dM < limit - 200).map((f) => f.id);
  const plan: ApproachPlan = {
    mode: 'intercept', courseTrue: info.courseTrue, procedureId: info.procedure.id, fixes: Number.isFinite(dInt) ? ahead(dInt) : [], onCourse: info.onCourse.map((f) => f.id), fafDM,
    joinDM: Number.isFinite(dInt) ? Math.max(0, dInt) : Math.max(0, dC), joinTravelM: Number.isFinite(dInt) && !established ? tM : 0, ifDM: info.onCourse[0]?.dM, interceptDM: Number.isFinite(dInt) ? dInt : undefined, interceptAngleDeg: angle,
  };
  const bad = (reason: string, pilot: string): ApproachAssessment => ({ kind: 'ok', plan, geometry: { reason: `Unable: ${reason}`, pilot } });
  if (dC > 0 ? dC < fafDM : true) {
    return bad(`${ac.callsign} is inside the final approach fix for runway ${g.end.id} (${mToNm(Math.max(0, dC)).toFixed(1)} nm from the threshold, FAF ${mToNm(fafDM).toFixed(1)} nm); the approach clearance must be issued outside the FAF.`, `we're inside the final approach fix`);
  }
  // 7110.65 5-9-1 / 5-9-2 (TBL 5-9-1): approach gate = 1 nm outside the FAF, no closer than 5 nm to the threshold
  // (P/CG APPROACH GATE). Vector to intercept at least 2 nm outside the gate at <= 30 degrees; closer than 2 nm outside (but not
  // inside) the gate only with ceiling >= MVA + 500 and visibility >= 3 sm (MVA is not in the data: approximated by the
  // simplified visual-approach VMC), not for RNAV aircraft on a GPS/RNAV approach, and at <= 20 degrees. Inside the gate (but
  // outside the FAF) only if the pilot asks, which the simulator cannot express: improper.
  const gateDM = approachGateDM(fafDM);
  const maxAngleFar = MAX_INTERCEPT_ANGLE_DEG;
  if (established) {
    if (angle > maxAngleFar) return bad(`intercept angle too large (${angle.toFixed(0)} deg; maximum ${maxAngleFar}) for runway ${g.end.id}.`, `the intercept angle is too large`);
    return { kind: 'ok', plan };
  }
  if (!converging) return bad(`${ac.callsign} is not on a heading that intercepts the runway ${g.end.id} final approach course.`, `we're not on an intercept heading`);
  if (dInt < fafDM) return bad(`the intercept point is inside the final approach fix for runway ${g.end.id}.`, `we'd intercept inside the final approach fix`);
  const outsideGate = dInt - gateDM;
  const farEnough = outsideGate >= GATE_INTERCEPT_MARGIN_M;
  const maxAngle = farEnough ? MAX_INTERCEPT_ANGLE_DEG : MAX_INTERCEPT_ANGLE_NEAR_GATE_DEG;
  if (angle > maxAngle) {
    return bad(
      `intercept angle too large (${angle.toFixed(0)} deg; maximum ${maxAngle} ${farEnough ? 'when the intercept is 2 nm or more outside the approach gate' : 'when it is less than 2 nm outside the approach gate'}, 7110.65 5-9-2) for runway ${g.end.id}.`,
      `the intercept angle is too large`,
    );
  }
  if (!farEnough) {
    const relaxed = outsideGate >= 0 && type !== 'RNAV' && visualApproachAllowed(weather).ok;
    if (!relaxed) {
      return bad(
        `the intercept point is ${mToNm(dInt).toFixed(1)} nm from the threshold, ${outsideGate < 0 ? 'inside' : 'less than 2 nm outside'} the approach gate (${mToNm(gateDM).toFixed(1)} nm): vector to intercept at least 2 nm outside the gate, ${mToNm(gateDM + GATE_INTERCEPT_MARGIN_M).toFixed(1)} nm for runway ${g.end.id} (7110.65 5-9-1${type === 'RNAV' ? '; the relaxations do not apply to RNAV aircraft' : ''}).`,
        `the intercept is inside the approach gate`,
      );
    }
  }
  if (mToNm(tM) > MAX_INTERCEPT_AHEAD_NM) {
    return bad(`the final approach course is ${mToNm(tM).toFixed(0)} nm ahead; clear the approach when the intercept is within ${MAX_INTERCEPT_AHEAD_NM} nm.`, `we're too far from the final approach course`);
  }
  return { kind: 'ok', plan };
}
