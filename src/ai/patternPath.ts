/**
 * Kinematic projection of an arrival flying the traffic pattern (or a straight-in / go-around that will join it), second by second, using the legs of
 * the engine's pattern model (`flightDynamics.patternHeading`: upwind to the runway end, crosswind to the downwind offset, downwind at 0.8 nm, base turned
 * at `BASE_ALONG_M` behind the threshold, capture of the final course, 3 degree path). The Tower uses it to see, before it extends a downwind, sends an
 * aircraft round or lets one turn base, whether the resulting path comes inside the simulator's near-miss alert (`AIRBORNE_PROXIMITY_NM` / `_FT`) of any
 * other airborne aircraft: JO 7110.65 3-8-1 (sequence / spacing), 3-10-6 and 7-2-1 (traffic information and visual separation) leave that to the controller's
 * judgement; this is the judgement. Wind is ignored (a margin is added by the callers).
 *
 * Pure functions of the simulation state; paths are indexed by whole seconds from now.
 */
import type { Aircraft, SimulationState, Vec2 } from '../sim/types';
import { clamp, deg2rad, headingDiff, headingToVec, KT_TO_MPS, mToFt, nmToM, normHeading, rad2deg } from '../sim/geo';
import { windVector } from '../sim/wind';
import { alongCross, defaultPatternSide } from '../sim/runways';
import type { Path } from './airbornePath';
import type { RunwayEndGeom } from '../sim/runways';
import { getPerformance, patternAltitudeFt } from '../sim/performance';
import { BASE_ALONG_M, EXTEND_LIMIT_M, SHORT_BASE_ALONG_M } from '../sim/flightDynamics';
import { BASE_NOW_MIN_NM } from '../sim/towerCommands';

export type PatternLeg = 'UPWIND' | 'CROSSWIND' | 'DOWNWIND' | 'BASE' | 'FINAL';

/** The leg an aircraft in the pattern flies, read from its heading against the runway heading and which side of the threshold it is on. */
export function patternLeg(ac: Aircraft, g: RunwayEndGeom): PatternLeg {
  const along = alongCross(g, ac.pos).along - g.displacedM;
  const d = Math.abs(headingDiff(ac.headingDeg, g.headingDeg));
  if (d < 35) {
    if (along >= 0) return 'UPWIND';
    // Aligned with the runway and short of it: on final, or (a go-around that was sent back into the pattern before it reached the runway) on the upwind leg, which the
    // engine flies level at pattern altitude over the runway before the crosswind turn. The engine's leg is not in the aircraft's data: the go-around followed by
    // ENTER_PATTERN in its clearances says which.
    return ac.phase === 'PATTERN' && reenteredAfterGoAround(ac) ? 'UPWIND' : 'FINAL';
  }
  if (d > 145) return 'DOWNWIND';
  return along < 0 ? 'BASE' : 'CROSSWIND';
}

/** The aircraft went around and has since been sent into the pattern (its clearances end with GO_AROUND, ENTER_PATTERN [, pattern instructions]). */
function reenteredAfterGoAround(ac: Aircraft): boolean {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind === 'ENTER_PATTERN') return c.patternLeg !== 'straight_in' && ac.clearances.slice(0, i).some((p) => p.kind === 'GO_AROUND') && ac.lastGoAroundSec !== undefined && c.issuedAtSec >= ac.lastGoAroundSec;
    if (c.kind === 'GO_AROUND' || c.kind === 'LAND' || c.kind === 'APPROACH') return false;
  }
  return false;
}

/** The last "extend downwind" (and no base-turn call after it) still stands for this aircraft's current trip round the pattern. */
export function extendedByController(ac: Aircraft): boolean {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind === 'ENTER_PATTERN' || c.kind === 'GO_AROUND' || c.kind === 'LAND') return false;
    if (c.kind === 'PATTERN_INSTRUCTION') return c.destination === 'EXTEND_DOWNWIND';
  }
  return false;
}

/** Seconds a turn takes beyond its 360 degrees (the bank builds and the aircraft rolls out on its track). DESIGN VALUE. */
export const CIRCLE_ROLL_IN_SEC = 6;

/** Seconds a 360 given for spacing still has to run (the aircraft's own turn rate; the turn is not yet part of its position and speed). */
export function circleRemainingSec(state: SimulationState, ac: Aircraft): number {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind !== 'PATTERN_INSTRUCTION') continue;
    if (c.destination !== 'CIRCLE') return 0;
    const total = (c.turnDegrees ?? 360) / Math.max(1, getPerformance(ac.type).turnRateDegPerSec) + CIRCLE_ROLL_IN_SEC;
    return Math.max(0, total - (state.clock.timeSec - c.issuedAtSec));
  }
  return 0;
}

/** Direction of the last 360 given to `ac`. */
export function circleDirectionOf(ac: Aircraft): 'left' | 'right' | undefined {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind === 'PATTERN_INSTRUCTION' && c.destination === 'CIRCLE') return c.turnDirection;
  }
  return undefined;
}

/** Seconds ahead that are projected. */
export const PATH_HORIZON_SEC = 480;
/** The arrival is airborne this long after it crosses the threshold (flare and float). */
const TOUCHDOWN_AFTER_THRESHOLD_SEC = 8;
/** Distance behind the threshold at which a fighter turns base (flightDynamics, 3.5 nm). */
const FIGHTER_BASE_ALONG_M = nmToM(3.5);
/** Metres behind the threshold at which the aircraft turns base without an instruction. */
export const baseTurnM = (ac: Aircraft): number => (getPerformance(ac.type).military && !getPerformance(ac.type).craft ? FIGHTER_BASE_ALONG_M : BASE_ALONG_M);
/** Lateral offset of the downwind leg (the engine's pattern geometry). */
const PATTERN_OFFSET_M = nmToM(0.8);
/** The crosswind turn is made this far below pattern altitude (flightDynamics `CROSSWIND_TURN_BELOW_TPA_FT`). */
const CROSSWIND_TURN_BELOW_TPA_FT = 300;
/** Descent rate (ft per second) to the pattern altitude and, on final, down to the glide path (3 degrees at 65 kt is 345 fpm, plus up to 400 fpm of correction). */
const BASE_DESCENT_FPS = 600 / 60;
const FINAL_CAPTURE_DESCENT_FPS = 745 / 60;

export type { Path } from './airbornePath';

export interface PatternPlan {
  /** Turn base this many seconds from now (JO 7110.65 3-10-6 "turn base"; needs the 0.75 nm of `BASE_NOW_MIN_NM` behind the threshold). Undefined: at the normal point, or never while `extend`. */
  baseAtSec?: number;
  /** An "extend downwind" is in effect: no base turn until `baseAtSec` (or the extension limit). */
  extend?: boolean;
  /** A short approach: the base turn is made at `SHORT_BASE_ALONG_M`. */
  short?: boolean;
  /** 360-degree turns made first (each costs about 120 s for a light aircraft). */
  circles?: number;
  /** Degrees of a 360 already under way (overrides `circles`). */
  circleDegLeft?: number;
  /** Direction of those turns; default away from the runway (a turn toward it on downwind crosses the final course, the engine establishes the aircraft on final and it goes around: `circleDirectionFor`). */
  circleDir?: 'left' | 'right';
}

export interface PatternProjection {
  path: Path;
  /** Seconds from now until the aircraft crosses the landing threshold (Infinity when it does not inside the horizon). */
  thresholdSec: number;
}

/** The pattern side of an aircraft: read from where it flies when it is on downwind / base, else the side the runway uses. */
export function sideOf(state: SimulationState, ac: Aircraft, g: RunwayEndGeom, leg: PatternLeg): 'left' | 'right' {
  if (leg === 'DOWNWIND' || leg === 'BASE') {
    const { cross } = alongCross(g, ac.pos);
    if (Math.abs(cross) > 250) return cross < 0 ? 'left' : 'right';
  }
  return defaultPatternSide(state.airport, g);
}

/** The direction of a 360 on the downwind leg: away from the runway (right for a left-hand pattern). */
export const circleDirectionFor = (side: 'left' | 'right'): 'left' | 'right' => (side === 'left' ? 'right' : 'left');

/** Heading to fly so that the ground track is `trackDeg` in the given wind (the engine's `headingForTrack`). */
function headingForTrack(trackDeg: number, tasKt: number, wind: Vec2): number {
  const t = headingToVec(trackDeg);
  const wp = wind.x * t.y - wind.y * t.x; // component of the wind to the right of the track
  const s = clamp(wp / Math.max(1, tasKt * KT_TO_MPS), -0.5, 0.5);
  return normHeading(trackDeg - rad2deg(Math.asin(s)));
}

/** Final-course guidance of the engine (`centrelineHeading`, no wind). */
function centrelineHeading(g: RunwayEndGeom, pos: Vec2, hdg: number, gs: number, turnRadiusM: number): number {
  const { along, cross } = alongCross(g, pos);
  const d = Math.max(0, -along);
  const gain = clamp(57.3 / (Math.max(gs, 15) * 15), 0.03, 0.15);
  let cap = Math.min(45, 8 + d / 120);
  const theta = Math.min(90, Math.abs(headingDiff(hdg, g.headingDeg)));
  const lead = turnRadiusM * (1 - Math.cos(deg2rad(theta)));
  if (Math.abs(cross) <= lead + 80) cap = Math.min(cap, 12);
  return normHeading(g.headingDeg - clamp(cross * gain, -cap, cap));
}

/** The engine's `inCaptureZone`. */
function inCaptureZone(g: RunwayEndGeom, pos: Vec2, hdg: number, turnRadiusM: number): boolean {
  const { along, cross } = alongCross(g, pos);
  const d = -along;
  if (d <= 150) return false;
  const theta = Math.min(90, Math.abs(headingDiff(hdg, g.headingDeg)));
  const lead = turnRadiusM * (1 - Math.cos(deg2rad(theta)));
  return Math.abs(cross) <= Math.max(100, 0.05 * d) + lead;
}

/**
 * Where `ac` (an arrival to runway end `g`: in the pattern, on a go-around, on base or final, or a straight-in not yet established) will be each second
 * if the Tower does what `plan` says. Altitude is the pattern altitude on downwind, falling to the 3 degree path on base and final.
 */
export function patternProjection(state: SimulationState, ac: Aircraft, g: RunwayEndGeom, plan: PatternPlan = {}, horizon = PATH_HORIZON_SEC): PatternProjection {
  const perf = getPerformance(ac.type);
  const elev = g.elevationFt;
  const tpa = patternAltitudeFt(perf, elev, state.airport.trafficPatternAltitudeFt);
  let leg: PatternLeg = ac.phase === 'GO_AROUND' || ac.isDeparture ? 'UPWIND' : ac.phase === 'FINAL' || ac.phase === 'LANDING' ? 'FINAL' : patternLeg(ac, g);
  const side = sideOf(state, ac, g, leg);
  const sideSign = side === 'left' ? -1 : 1;
  const offset = sideSign * PATTERN_OFFSET_M;
  // speed: the engine's targets (`defaultSpeedKt`: climb speed on the go-around, the mean of climb and approach speed in the pattern, approach speed on final), reached at its rates
  const patternKt = ac.target.speedKt ?? (perf.climbSpeedKt + perf.approachSpeedKt) / 2;
  const targetKt = (l: PatternLeg): number => clamp(l === 'FINAL' ? perf.approachSpeedKt : l === 'UPWIND' && ac.phase === 'GO_AROUND' ? perf.climbSpeedKt : patternKt, perf.minSpeedKt, perf.maxSpeedKt);
  const upKt = 0.5 * perf.accelKtPerSec;
  const downKt = perf.category === 'light' ? 1.0 : 1.5;
  const wind = windVector(state.weather);
  let kt = Math.max(ac.airspeedKt, perf.minSpeedKt * 0.8);
  const tpaRound = Math.round(tpa / 100) * 100;
  const turnRate = perf.turnRateDegPerSec;
  let pos: Vec2 = { ...ac.pos };
  let hdg = ac.headingDeg;
  let alt = ac.altitudeFt;
  let circleLeft = plan.circleDegLeft ?? (plan.circles ?? 0) * 360;
  const circleDir = plan.circleDir ?? (side === 'left' ? 'right' : 'left');
  let extended = !!plan.extend;
  const out: Path = [];
  let thresholdSec = Infinity;
  // (a fighter flies a wide pattern: flightDynamics `FIGHTER_BASE_ALONG_M`)
  const turnAt = plan.short ? SHORT_BASE_ALONG_M : perf.military && !perf.craft ? FIGHTER_BASE_ALONG_M : BASE_ALONG_M;
  for (let t = 0; t <= horizon; t++) {
    const { along: alongPave, cross } = alongCross(g, pos);
    const along = alongPave - g.displacedM;
    // after the threshold: airborne for the float, then gone
    if (leg === 'FINAL' && along > 0 && thresholdSec === Infinity) thresholdSec = t;
    if (thresholdSec !== Infinity && t > thresholdSec + TOUCHDOWN_AFTER_THRESHOLD_SEC) { out.push(undefined); continue; }
    out.push({ x: pos.x, y: pos.y, altFt: alt });
    kt += clamp(targetKt(leg) - kt, -downKt, upKt);
    const v = kt * KT_TO_MPS;
    const radius = v / deg2rad(turnRate);
    let want = hdg;
    if (circleLeft > 0 && (leg === 'DOWNWIND' || leg === 'BASE' || leg === 'FINAL')) {
      // a steady 360 at the type's turn rate, in the direction of the pattern
      const step = Math.min(turnRate, circleLeft);
      circleLeft -= step;
      hdg = normHeading(hdg + (circleDir === 'left' ? -step : step));
      const u = headingToVec(hdg);
      pos = { x: pos.x + u.x * v + wind.x, y: pos.y + u.y * v + wind.y };
      continue;
    }
    if (leg === 'UPWIND') {
      const agl = alt - elev;
      if (alongPave >= g.lengthM && agl >= tpa - elev - CROSSWIND_TURN_BELOW_TPA_FT) leg = 'CROSSWIND';
      else want = normHeading(g.headingDeg - clamp(cross * 0.03, -20, 20));
    }
    if (leg === 'CROSSWIND') {
      if (Math.abs(cross) >= Math.abs(offset) - 200) leg = 'DOWNWIND';
      else want = normHeading(g.headingDeg + (side === 'left' ? -90 : 90));
    }
    if (leg === 'DOWNWIND') {
      const beyondLimit = -along > EXTEND_LIMIT_M;
      const baseNow = plan.baseAtSec !== undefined && t >= plan.baseAtSec && -along >= nmToM(BASE_NOW_MIN_NM);
      const normal = !extended && plan.baseAtSec === undefined && along <= -turnAt;
      if ((baseNow || normal || beyondLimit) && Math.abs(cross - offset) < 600) leg = 'BASE';
      else want = normHeading(g.headingDeg + 180 + clamp((cross - offset) * 0.04, -45, 45));
    }
    if (leg === 'BASE') {
      if (inCaptureZone(g, pos, hdg, radius) && -along > 150) {
        leg = 'FINAL';
        want = centrelineHeading(g, pos, hdg, v, radius);
      } else want = normHeading(g.headingDeg + (side === 'left' ? 90 : -90));
    } else if (leg === 'FINAL') {
      want = centrelineHeading(g, pos, hdg, v, radius);
    }
    // vertical: upwind climbs to pattern altitude, downwind holds it, base and final follow the 3 degree path from the pattern altitude (level until they meet it)
    const dM = Math.max(0, -along);
    const glide = elev + 50 + mToFt(dM) * Math.tan(deg2rad(3));
    if (leg === 'UPWIND' || leg === 'CROSSWIND') alt = Math.min(tpaRound, alt + perf.climbRateFpm / 60);
    else if (leg === 'DOWNWIND' || leg === 'BASE') alt += clamp(tpaRound - alt, -BASE_DESCENT_FPS, perf.climbRateFpm / 60);
    else if (alt > glide) alt = Math.max(glide, alt - FINAL_CAPTURE_DESCENT_FPS); // (the engine's vertical speed: the glide rate plus up to 400 fpm to the path)
    const dh = clamp(headingDiff(hdg, headingForTrack(want, kt, wind)), -turnRate, turnRate);
    hdg = normHeading(hdg + dh);
    const u = headingToVec(hdg);
    pos = { x: pos.x + u.x * v + wind.x, y: pos.y + u.y * v + wind.y };
  }
  return { path: out, thresholdSec };
}
