/**
 * The projected paths of every airborne aircraft (and the departures about to be airborne), second by second, for the Tower's check of a sequencing
 * choice against the simulator's near-miss alert. Each aircraft's path is what it does if nobody tells it anything more (`defaultPath`): the pattern and
 * the final for an arrival in the pattern, on a go-around, on final or about to be established, the climb-out for a departure, a straight line for the rest
 * (a route or vector is not known beyond the current track). See `patternPath.ts` for the pattern model and `airbornePath.ts` for the departures.
 *
 * Pure functions of the simulation state; the paths of one simulation tick are cached.
 */
import type { Aircraft, SimulationState } from '../sim/types';
import { headingDiff, headingToVec, KT_TO_MPS, mToNm, normHeading } from '../sim/geo';
import { windVector } from '../sim/wind';
import { alongCross, findRunwayEnd } from '../sim/runways';
import { getPerformance } from '../sim/performance';
import { AIRBORNE_PROXIMITY_FT, AIRBORNE_PROXIMITY_NM } from '../sim/conflicts';
import { climbingPath, departurePath, HORIZON_SEC } from './airbornePath';
import type { Path } from './airbornePath';
import { circleDirectionOf, circleRemainingSec, extendedByController, patternProjection } from './patternPath';
import type { PatternPlan } from './patternPath';
import { assignedEnd, distToThresholdNm } from './world';

/** Seconds ahead over which paths are compared (the paths of the aircraft that fly a pattern are longer: their threshold time matters beyond it). */
const CHECK_SEC = 240;

/** An arrival farther than this from its threshold (nm) is flown as a straight line (its route is not projected). */
const ARRIVAL_PATH_RANGE_NM = 10;

/** A straight line at the current track and ground speed; the altitude moves toward the target altitude at the type's rate. */
export function straightPath(o: Aircraft, horizon = HORIZON_SEC): Path {
  const perf = getPerformance(o.type);
  const u = headingToVec(o.trackDeg);
  const v = Math.max(o.groundSpeedKt, 1) * KT_TO_MPS;
  const out: Path = [];
  let alt = o.altitudeFt;
  const target = o.target.altitudeFt ?? alt;
  for (let t = 0; t <= horizon; t++) {
    out.push({ x: o.pos.x + u.x * v * t, y: o.pos.y + u.y * v * t, altFt: alt });
    alt += Math.max(-perf.descentRateFpm / 60, Math.min(perf.climbRateFpm / 60, target - alt));
  }
  return out;
}

/**
 * The straight line of `straightPath` after a spacing turn (3-8-1 "make left three-sixty") of `degrees` made now at the type's turn rate in the wind: the aircraft turns
 * in a circle, then goes on along its original track. For an arrival that is still on its way in (the engine's `spacingTurn`).
 */
export function spacingTurnPath(state: SimulationState, o: Aircraft, dir: 'left' | 'right', degrees = 360, horizon = HORIZON_SEC): Path {
  const perf = getPerformance(o.type);
  const wind = windVector(state.weather);
  const out: Path = [];
  let hdg = o.headingDeg;
  let pos = { x: o.pos.x, y: o.pos.y };
  let left = degrees;
  const kt = Math.max(o.airspeedKt, perf.minSpeedKt);
  const v = kt * KT_TO_MPS;
  const track = o.trackDeg;
  let alt = o.altitudeFt;
  const target = o.target.altitudeFt ?? alt;
  for (let t = 0; t <= horizon; t++) {
    out.push({ x: pos.x, y: pos.y, altFt: alt });
    if (left > 0) {
      const step = Math.min(perf.turnRateDegPerSec, left);
      left -= step;
      hdg = normHeading(hdg + (dir === 'left' ? -step : step));
    } else hdg = track;
    const u = headingToVec(hdg);
    pos = { x: pos.x + u.x * v + wind.x, y: pos.y + u.y * v + wind.y };
    alt += Math.max(-perf.descentRateFpm / 60, Math.min(perf.climbRateFpm / 60, target - alt));
  }
  return out;
}

/** The pattern plan that describes what an arrival already told to do will do. */
export function currentPlan(state: SimulationState, o: Aircraft): PatternPlan {
  const plan: PatternPlan = {};
  if (extendedByController(o)) plan.extend = true;
  const left = circleRemainingSec(state, o);
  if (left > 0) {
    plan.circleDegLeft = left * getPerformance(o.type).turnRateDegPerSec;
    const dir = circleDirectionOf(o);
    if (dir) plan.circleDir = dir;
  }
  return plan;
}

/** What `o` does if nothing more is said to it; undefined for an aircraft that cannot be in an alert (on the ground and not about to take off). */
export function defaultPath(state: SimulationState, o: Aircraft): Path | undefined {
  const airport = state.airport;
  if (o.onGround) {
    if (!o.isDeparture || (o.phase !== 'CLEARED_FOR_TAKEOFF' && o.phase !== 'TAKEOFF_ROLL')) return undefined;
    const og = findRunwayEnd(airport, o.assignedRunwayEnd);
    return og ? departurePath(o, og, o.phase === 'CLEARED_FOR_TAKEOFF' && o.occupyingRunways.length > 0) : undefined;
  }
  if (o.isDeparture) return climbingPath(o);
  const og = assignedEnd(airport, o);
  if (!og || o.flags.transit || o.flags.overhead || getPerformance(o.type).military) return straightPath(o);
  switch (o.phase) {
    case 'PATTERN':
    case 'GO_AROUND':
    case 'FINAL':
    case 'LANDING':
      return patternProjection(state, o, og, currentPlan(state, o)).path;
    case 'INBOUND':
    case 'APPROACH': {
      const d = distToThresholdNm(o, og);
      if (d > ARRIVAL_PATH_RANGE_NM) return straightPath(o);
      // on the final course (a VFR straight-in, an arrival that has intercepted): the final of the pattern model (level until the 3 degree path, then down it)
      const { along, cross } = alongCross(og, o.pos);
      if (along < 0 && Math.abs(cross) < 400 && Math.abs(headingDiff(o.headingDeg, og.headingDeg)) < 25) return patternProjection(state, o, og, currentPlan(state, o)).path;
      return straightPath(o); // (vectored or direct to a fix: it keeps its track for the next minutes; the straight line to the threshold is not where it goes)
    }
    default:
      return straightPath(o);
  }
}

const cache = new WeakMap<SimulationState, { tick: number; paths: Map<string, Path | undefined> }>();

/** `defaultPath` of every aircraft, computed once per simulation tick. */
export function defaultPaths(state: SimulationState): Map<string, Path | undefined> {
  const hit = cache.get(state);
  if (hit && hit.tick === state.clock.tick) return hit.paths;
  const paths = new Map<string, Path | undefined>();
  for (const o of Object.values(state.aircraft)) paths.set(o.id, defaultPath(state, o));
  cache.set(state, { tick: state.clock.tick, paths });
  return paths;
}

/**
 * The direction of a spacing 360 (3-8-1) for `o` that keeps its loop outside the near-miss alert of every other aircraft's default path (`COMFORT_RATIO`), `preferred`
 * first; undefined when neither direction does. Used for the 360s that are not part of the downwind sequence (the departure gap, the straight-in aircraft behind a crossing arrival).
 */
export function clearSpacingTurn(state: SimulationState, o: Aircraft, preferred: 'left' | 'right' = 'left'): 'left' | 'right' | undefined {
  const others = defaultPaths(state);
  const dirs: ('left' | 'right')[] = [preferred, preferred === 'left' ? 'right' : 'left'];
  return dirs.find((dr) => (pathSeparation(state, o.id, spacingTurnPath(state, o, dr).slice(0, CHECK_SEC), others)?.ratio ?? Infinity) >= COMFORT_RATIO);
}

export interface PathConflict { otherId: string; minNm: number; atSec: number; /** Smallest over time of max(distance / 1.5 nm, height difference / 500 ft): below 1 is an alert. */ ratio: number }

/** Separation ratio at or above which a path is comfortably clear of the alert (a margin for the wind and the model), and at or above which it is clear at all. DESIGN VALUES. */
export const COMFORT_RATIO = 1.07;
export const CLEAR_RATIO = 1.01;

/**
 * How close `path` comes to the near-miss alert (1.5 nm and 500 ft) of any of `others` in the next `CHECK_SEC` seconds, ignoring the aircraft `selfId` and
 * anything farther than 15 nm now: the pair with the smallest `ratio` (undefined when there is no other path).
 */
export function pathSeparation(state: SimulationState, selfId: string, path: Path, others: ReadonlyMap<string, Path | undefined>): PathConflict | undefined {
  const me = state.aircraft[selfId];
  const limitM = AIRBORNE_PROXIMITY_NM * 1852;
  let worst: PathConflict | undefined;
  const n = Math.min(path.length, CHECK_SEC);
  for (const [id, p] of others) {
    if (id === selfId || !p) continue;
    const o = state.aircraft[id];
    if (me && o && mToNm(Math.hypot(o.pos.x - me.pos.x, o.pos.y - me.pos.y)) > 15) continue;
    for (let t = 0; t < n; t++) {
      const a = path[t];
      const b = p[t];
      if (!a || !b) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = Math.max(d / limitM, Math.abs(a.altFt - b.altFt) / AIRBORNE_PROXIMITY_FT);
      if (!worst || r < worst.ratio) worst = { otherId: id, minNm: d / 1852, atSec: t, ratio: r };
    }
  }
  return worst;
}

/** The alert distances the checks use (for tests and callers that report them). */
export const ALERT_NM = AIRBORNE_PROXIMITY_NM;
export const ALERT_FT = AIRBORNE_PROXIMITY_FT;
