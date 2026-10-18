/**
 * Landing sequence for the traffic pattern (Tower).
 *
 * Without it every pattern aircraft turned base on its own and was cleared to land from downwind, so several reached the final together and
 * went around, over and over (free-play soak, docs/PROGRESS.md "Free-play jam"). JO 7110.65 3-8-1 (sequence / spacing application) has the
 * controller sequence arrivals and gives him "EXTEND DOWNWIND" and "MAKE SHORT APPROACH" for it; 3-10-3 (same runway separation) says when the
 * runway is free for the next landing. The rule here:
 *
 *  - Everything that cannot wait (aircraft on final or base, straight-in arrivals, landings and departures using the runway) takes a time
 *    window on the runway: from its threshold crossing until it is clear (`projectArrival`), padded by `SEQ_MARGIN_SEC` (DESIGN VALUE).
 *  - Aircraft on downwind are taken in the order they reach their normal base turn. One whose window is free is left alone; one whose window
 *    is taken is told to extend its downwind, and told to turn base when a window is free again (the engine accepts "turn base now" from
 *    0.75 nm behind the threshold; that phrase is not from the order, see BEHAVIOUR-ACCURACY T15).
 *
 * Pure functions of the simulation state (the pattern leg is read from the aircraft's heading and position).
 */
import type { Aircraft, SimulationState } from '../sim/types';
import { headingDiff, nmToM } from '../sim/geo';
import { alongCross } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { projectArrival } from '../sim/runwayTiming';
import { BASE_ALONG_M, EXTEND_LIMIT_M } from '../sim/flightDynamics';
import { BASE_NOW_MIN_NM } from '../sim/towerCommands';
import { getPerformance } from '../sim/performance';
import { assignedEnd, interactingRunways } from './world';

/** Seconds between one aircraft being clear of the runway and the next crossing the threshold, and the other way round (DESIGN VALUE). */
export const SEQ_MARGIN_SEC = 15;
/** Lateral distance of the downwind leg from the runway (the engine's pattern geometry, flightDynamics `patternHeading`). */
const PATTERN_OFFSET_M = nmToM(0.8);
const MIN_SPEED_MPS = 50 * 0.514444;
/** A downwind aircraft closer than this to its normal base turn can no longer be told to extend (reaction time and the pilot's turn). */
const EXTEND_LAST_CHANCE_M = nmToM(0.35);

export type PatternLeg = 'UPWIND' | 'CROSSWIND' | 'DOWNWIND' | 'BASE' | 'FINAL';

/** The leg an aircraft in the pattern flies, read from its heading against the runway heading and which side of the threshold it is on. */
export function patternLeg(ac: Aircraft, g: RunwayEndGeom): PatternLeg {
  const along = alongCross(g, ac.pos).along - g.displacedM;
  const d = Math.abs(headingDiff(ac.headingDeg, g.headingDeg));
  if (d < 35) return along < 0 ? 'FINAL' : 'UPWIND';
  if (d > 145) return 'DOWNWIND';
  return along < 0 ? 'BASE' : 'CROSSWIND';
}

/** Metres behind the landing threshold (negative = past it) and lateral offset of an aircraft. */
function geometry(ac: Aircraft, g: RunwayEndGeom): { behindM: number; crossM: number } {
  const { along, cross } = alongCross(g, ac.pos);
  return { behindM: -(along - g.displacedM), crossM: Math.abs(cross) };
}

const speedMps = (ac: Aircraft): number => Math.max(ac.groundSpeedKt * 0.514444, MIN_SPEED_MPS);

/** The last "extend downwind" (and no base-turn call after it) still stands for this aircraft's current trip round the pattern. */
export function extendedByController(ac: Aircraft): boolean {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind === 'ENTER_PATTERN' || c.kind === 'GO_AROUND' || c.kind === 'LAND') return false;
    if (c.kind === 'PATTERN_INSTRUCTION') return c.destination === 'EXTEND_DOWNWIND';
  }
  return false;
}

/** Seconds until an aircraft on downwind crosses the threshold if it turns base where it normally does (or, past that point, now). */
export function etaNormalSec(ac: Aircraft, g: RunwayEndGeom): number {
  const { behindM } = geometry(ac, g);
  const toTurn = Math.max(0, BASE_ALONG_M - behindM);
  const pastTurn = behindM > BASE_ALONG_M;
  const finalM = pastTurn ? behindM : BASE_ALONG_M;
  return (toTurn + PATTERN_OFFSET_M + finalM) / speedMps(ac);
}

/** Seconds until it crosses the threshold if it is told to turn base as soon as that is possible. */
export function etaBaseNowSec(ac: Aircraft, g: RunwayEndGeom): number {
  const { behindM } = geometry(ac, g);
  const minM = nmToM(BASE_NOW_MIN_NM);
  const toPoint = Math.max(0, minM - behindM);
  return (toPoint + PATTERN_OFFSET_M + Math.max(behindM, minM)) / speedMps(ac);
}

const occupancyCache = new WeakMap<object, Map<string, number>>();

/** Seconds an aircraft of this type occupies the runway from the threshold crossing until it is clear. */
export function occupancySec(state: SimulationState, ac: Aircraft, g: RunwayEndGeom): number {
  let m = occupancyCache.get(state.airport);
  if (!m) occupancyCache.set(state.airport, (m = new Map()));
  const key = `${g.end.id}:${ac.type}`;
  let v = m.get(key);
  if (v === undefined) {
    const pa = projectArrival(state, { ...ac, onGround: false, altitudeFt: g.elevationFt + 600, groundSpeedKt: 70, pos: { x: g.end.threshold.x - g.dir.x * 1500, y: g.end.threshold.y - g.dir.y * 1500 } }, g);
    v = pa.tClear - pa.tThr;
    m.set(key, v);
  }
  return v;
}

export interface SeqWindow {
  start: number;
  end: number;
}

const free = (windows: SeqWindow[], start: number, end: number): boolean =>
  windows.every((w) => end + SEQ_MARGIN_SEC <= w.start || start >= w.end + SEQ_MARGIN_SEC);

/** Aircraft the sequencer may delay: light non-military aircraft flying the pattern (fighters and the overhead maneuver have their own handling). */
export function isSequenceable(ac: Aircraft): boolean {
  return !ac.onGround && !ac.isDeparture && ac.phase === 'PATTERN' && !getPerformance(ac.type).military && !ac.flags.overhead;
}

export type SeqAction = 'ok' | 'extend' | 'hold' | 'release';

export interface SeqDecision {
  ac: Aircraft;
  action: SeqAction;
  etaSec: number;
}

/**
 * Windows taken by everything on the runways that interact with `g` that cannot be delayed, plus `departureWindows` (seconds from now, from
 * the caller: it knows the takeoff roll model).
 */
export function committedWindows(state: SimulationState, g: RunwayEndGeom, departureWindows: SeqWindow[], exceptIds: ReadonlySet<string>): SeqWindow[] {
  const rws = interactingRunways(state.airport, g.runway.id);
  const out: SeqWindow[] = [...departureWindows];
  for (const o of Object.values(state.aircraft)) {
    if (exceptIds.has(o.id) || o.isDeparture) continue;
    const og = assignedEnd(state.airport, o);
    if (!og || !rws.includes(og.runway.id)) continue;
    if (o.onGround) {
      if (['LANDING', 'ROLLOUT', 'RUNWAY_EXIT'].includes(o.phase) && o.occupyingRunways.some((r) => rws.includes(r))) out.push({ start: 0, end: projectArrival(state, o, og).tClear });
      continue;
    }
    if (o.phase === 'GO_AROUND' || o.phase === 'HOLDING') continue;
    if (o.phase === 'PATTERN') {
      const leg = patternLeg(o, og);
      if (leg !== 'BASE' && leg !== 'FINAL') continue; // downwind aircraft are handled one by one; upwind / crosswind ones are far from landing
    }
    const pa = projectArrival(state, o, og);
    out.push({ start: pa.tThr, end: pa.tClear });
  }
  return out;
}

/** Decide for every sequenceable aircraft on downwind of `g` (see the file header). */
export function sequenceDownwind(state: SimulationState, g: RunwayEndGeom, departureWindows: SeqWindow[]): SeqDecision[] {
  const movable = Object.values(state.aircraft)
    .filter((a) => isSequenceable(a) && assignedEnd(state.airport, a)?.end.id === g.end.id && patternLeg(a, g) === 'DOWNWIND')
    .sort((a, b) => etaNormalSec(a, g) - etaNormalSec(b, g));
  const windows = committedWindows(state, g, departureWindows, new Set(movable.map((a) => a.id)));
  const out: SeqDecision[] = [];
  for (const ac of movable) {
    const occ = occupancySec(state, ac, g);
    const { behindM } = geometry(ac, g);
    const extended = extendedByController(ac) || behindM > BASE_ALONG_M;
    const eNormal = etaNormalSec(ac, g);
    if (!extended && free(windows, eNormal, eNormal + occ)) {
      windows.push({ start: eNormal, end: eNormal + occ });
      out.push({ ac, action: 'ok', etaSec: eNormal });
      continue;
    }
    const eNow = etaBaseNowSec(ac, g);
    if (extended && free(windows, eNow, eNow + occ)) {
      windows.push({ start: eNow, end: eNow + occ });
      out.push({ ac, action: behindM >= nmToM(BASE_NOW_MIN_NM) + nmToM(0.1) ? 'release' : 'hold', etaSec: eNow });
      continue;
    }
    // Still has to wait. Not yet told: extend while there is room before the normal turn (otherwise it turns and the landing check sends it around).
    const canExtend = !extended && behindM < BASE_ALONG_M - EXTEND_LAST_CHANCE_M && behindM < EXTEND_LIMIT_M;
    if (!extended && !canExtend) {
      windows.push({ start: eNormal, end: eNormal + occ });
      out.push({ ac, action: 'ok', etaSec: eNormal });
    } else {
      out.push({ ac, action: extended ? 'hold' : 'extend', etaSec: eNow });
    }
  }
  return out;
}

/** An aircraft on downwind within half a mile of its normal base turn (or already past it): it counts as traffic for a departure. */
export function turnsBaseSoon(ac: Aircraft, g: RunwayEndGeom): boolean {
  return geometry(ac, g).behindM > BASE_ALONG_M - nmToM(0.5);
}
