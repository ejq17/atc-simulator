/**
 * Kinematic projection of airborne traffic against the engine's near-miss alert (`AIRBORNE_PROXIMITY_NM` / `AIRBORNE_PROXIMITY_FT`), used by the Tower
 * before it releases a departure.
 *
 * JO 7110.65 3-9-6 (same runway separation), 5-8-3 (successive departures: 15 degrees of divergence or the radar minimum) and 3-9-5 (anticipating
 * separation) give the controller rules for the runway and the first minutes of the climb-out; none of them covers two aircraft that depart from parallel
 * runways 2,500 ft or more apart, or a departure that overtakes a slower one after both have left the runway environment. What the simulator flags is the
 * alert (1.5 nm and less than 500 ft), so the Tower projects the new departure's path (roll, lift-off, climb at its type's rate, the departure heading
 * from 400 ft AGL) against the paths of the other airborne or rolling departures and of the arrivals on the finals of the parallel runways, and does
 * not release the departure when the projection touches the alert (plus the DESIGN margins below) at any second of the next `HORIZON_SEC`. The paths
 * are straight lines at the current speeds: a leader that turns away is ignored only once it has turned (its track then differs).
 */
import type { Aircraft, SimulationState, Vec2 } from '../sim/types';
import { AIRBORNE_PROXIMITY_FT, AIRBORNE_PROXIMITY_NM } from '../sim/conflicts';
import { headingDiff, headingToVec, KT_TO_MPS, mToNm, normHeading } from '../sim/geo';
import { alongCross, findRunwayEnd, parallelNeighbours } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { getPerformance } from '../sim/performance';
import { isInboundArrival } from './world';

/** Seconds ahead that are projected. */
export const HORIZON_SEC = 240;
/** Margins added to the alert thresholds (the projection does not model speed changes, turns of the leader or the wind). DESIGN VALUES. */
export const PROJECTION_MARGIN_NM = 0.2;
export const PROJECTION_MARGIN_FT = 100;
/** Seconds from the clearance to the start of the roll for an aircraft cleared from the hold line (line-up and reaction), and for one already lined up. DESIGN VALUES (as `departureTimes`). */
const LINE_UP_DELAY_SEC = 20;
const ROLL_START_DELAY_SEC = 2.5;
/** Height above the field (ft) at which the departure heading is flown (flightDynamics: INITIAL_CLIMB becomes DEPARTURE at 400 ft AGL). */
const TURN_AGL_FT = 400;
/** The arrival touches down this long after crossing the threshold (as tower.ts `TOUCHDOWN_AFTER_THRESHOLD_SEC`). */
const TOUCHDOWN_AFTER_THRESHOLD_SEC = 8;

interface Sample { x: number; y: number; altFt: number }
/** One position per second from now (index 0) to `HORIZON_SEC`; `undefined` = on the ground or gone (no alert can involve it then). */
type Path = (Sample | undefined)[];

const KT = KT_TO_MPS;

/** A departure that is not yet airborne: rolls from where it stands (or from the hold line), lifts off, climbs on the runway heading and then flies `headingTrue` from 400 ft AGL. */
export function departurePath(ac: Aircraft, g: RunwayEndGeom, lined: boolean, headingTrue?: number, turn?: 'left' | 'right'): Path {
  const perf = getPerformance(ac.type);
  const rolling = ac.phase === 'TAKEOFF_ROLL';
  const { along } = alongCross(g, ac.pos);
  const origin: Vec2 = rolling ? { ...ac.pos } : { x: g.end.threshold.x + g.dir.x * Math.max(0, along), y: g.end.threshold.y + g.dir.y * Math.max(0, along) };
  const delay = rolling ? 0 : (lined ? 0 : LINE_UP_DELAY_SEC) + ROLL_START_DELAY_SEC;
  let v = rolling ? ac.groundSpeedKt : 0;
  let pos: Vec2 = origin;
  let track = g.headingDeg;
  let alt = g.elevationFt;
  let airborne = false;
  let liftoffAt = Infinity;
  const out: Path = [];
  for (let t = 0; t <= HORIZON_SEC; t++) {
    out.push(airborne ? { x: pos.x, y: pos.y, altFt: alt } : undefined);
    if (t < delay) continue;
    if (!airborne) {
      v = Math.min(perf.rotateSpeedKt, v + perf.accelKtPerSec);
      pos = { x: pos.x + g.dir.x * v * KT, y: pos.y + g.dir.y * v * KT };
      if (v >= perf.rotateSpeedKt) { airborne = true; liftoffAt = t; }
      continue;
    }
    v = Math.min(perf.climbSpeedKt, v + perf.accelKtPerSec);
    alt += perf.climbRateFpm / 60;
    if (headingTrue !== undefined && alt - g.elevationFt >= TURN_AGL_FT && t > liftoffAt) {
      const err = headingDiff(track, headingTrue);
      const dir = turn ?? (err >= 0 ? 'right' : 'left');
      const step = Math.min(Math.abs(err), perf.turnRateDegPerSec);
      if (Math.abs(err) > 0.5) track = normHeading(track + (dir === 'right' ? step : -step));
    }
    const u = headingToVec(track);
    pos = { x: pos.x + u.x * v * KT, y: pos.y + u.y * v * KT };
  }
  return out;
}

/** An airborne departure or go-around: straight on its track, speed rising to its climb speed, climbing at its type's rate up to its target altitude. */
export function climbingPath(o: Aircraft): Path {
  const perf = getPerformance(o.type);
  const cap = o.target.altitudeFt ?? o.altitudeFt + 3000;
  let v = Math.max(o.groundSpeedKt, 1);
  let pos: Vec2 = { ...o.pos };
  let alt = o.altitudeFt;
  const u = headingToVec(o.trackDeg);
  const out: Path = [];
  for (let t = 0; t <= HORIZON_SEC; t++) {
    out.push({ x: pos.x, y: pos.y, altFt: alt });
    if (v < perf.climbSpeedKt) v = Math.min(perf.climbSpeedKt, v + perf.accelKtPerSec);
    alt = Math.min(cap, alt + perf.climbRateFpm / 60);
    pos = { x: pos.x + u.x * v * KT, y: pos.y + u.y * v * KT };
  }
  return out;
}

/** An arrival on its way to the threshold of `g`: straight line at its speed, altitude falling linearly to the field at the threshold, airborne until `TOUCHDOWN_AFTER_THRESHOLD_SEC` later. */
export function arrivalPath(o: Aircraft, g: RunwayEndGeom): Path {
  const v = Math.max(o.groundSpeedKt, getPerformance(o.type).minSpeedKt) * KT;
  const toThr = { x: g.landingThreshold.x - o.pos.x, y: g.landingThreshold.y - o.pos.y };
  const distM = Math.hypot(toThr.x, toThr.y);
  const ahead = toThr.x * g.dir.x + toThr.y * g.dir.y > 0;
  const u = ahead && distM > 1 ? { x: toThr.x / distM, y: toThr.y / distM } : g.dir;
  const tThr = ahead ? distM / v : 0;
  const out: Path = [];
  for (let t = 0; t <= HORIZON_SEC; t++) {
    if (t > tThr + TOUCHDOWN_AFTER_THRESHOLD_SEC) { out.push(undefined); continue; }
    const alt = tThr > 0 ? Math.max(g.elevationFt, o.altitudeFt - ((o.altitudeFt - g.elevationFt) * Math.min(t, tThr)) / tThr) : Math.max(g.elevationFt, o.altitudeFt);
    out.push({ x: o.pos.x + u.x * v * t, y: o.pos.y + u.y * v * t, altFt: alt });
  }
  return out;
}

export interface ProjectedConflict {
  other: Aircraft;
  /** Smallest horizontal distance (nm) at a second when the vertical distance is inside the alert band. */
  minNm: number;
  atSec: number;
}

/** First pair of samples of two paths inside the alert (with margins); the nearest approach among them. */
function closest(a: Path, b: Path): { minNm: number; atSec: number } | undefined {
  const limitM = (AIRBORNE_PROXIMITY_NM + PROJECTION_MARGIN_NM) * 1852;
  const limitFt = AIRBORNE_PROXIMITY_FT + PROJECTION_MARGIN_FT;
  let best: { minNm: number; atSec: number } | undefined;
  for (let t = 0; t < a.length; t++) {
    const p = a[t];
    const q = b[t];
    if (!p || !q) continue;
    if (Math.abs(p.altFt - q.altFt) >= limitFt) continue;
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < limitM && (!best || d / 1852 < best.minNm)) best = { minNm: d / 1852, atSec: t };
  }
  return best;
}

/**
 * Would releasing `ac` (a departure on the ground, at the hold line or lined up) on `g` with `headingTrue` after 400 ft AGL (undefined: runway heading) touch the
 * near-miss alert against another departure (airborne, or rolling or cleared on any runway) or an arrival on the final of a parallel runway of `g`? The
 * conflicting aircraft nearest in time, or undefined.
 */
export function departureProjectedConflict(state: SimulationState, ac: Aircraft, g: RunwayEndGeom, lined: boolean, headingTrue?: number, turn?: 'left' | 'right'): ProjectedConflict | undefined {
  const mine = departurePath(ac, g, lined, headingTrue, turn);
  const parallel = new Set(parallelNeighbours(state.airport, g).map((n) => n.end.runway.id));
  let worst: ProjectedConflict | undefined;
  const consider = (o: Aircraft, path: Path): void => {
    const c = closest(mine, path);
    if (c && (!worst || c.atSec < worst.atSec)) worst = { other: o, ...c };
  };
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id) continue;
    if (o.isDeparture) {
      if (!o.onGround) {
        if (o.phase === 'INITIAL_CLIMB' || o.phase === 'DEPARTURE') consider(o, climbingPath(o));
      } else if (o.phase === 'TAKEOFF_ROLL' || o.phase === 'CLEARED_FOR_TAKEOFF') {
        const og = findRunwayEnd(state.airport, o.assignedRunwayEnd);
        // (a departure of the same runway rolling or cleared holds the runway: the engine's own check refuses the clearance; the other runways are judged here)
        if (og && og.runway.id !== g.runway.id) consider(o, departurePath(o, og, o.phase === 'CLEARED_FOR_TAKEOFF' && o.occupyingRunways.length > 0));
      }
      continue;
    }
    if (o.onGround) continue;
    if (o.phase === 'GO_AROUND') { consider(o, climbingPath(o)); continue; }
    if (!isInboundArrival(o)) continue;
    const og = findRunwayEnd(state.airport, o.assignedRunwayEnd);
    if (!og || !parallel.has(og.runway.id)) continue;
    // only an arrival that reaches its threshold inside the horizon matters (the straight line to a threshold far away says nothing about its path)
    if (mToNm(Math.hypot(o.pos.x - og.end.threshold.x, o.pos.y - og.end.threshold.y)) > 7) continue;
    consider(o, arrivalPath(o, og));
  }
  return worst;
}

/** Ordered departure instructions the Tower tries: no heading (runway heading), then a divergence of 30 degrees and of 60 degrees, away from a parallel neighbour first. */
export function divergenceOptions(state: SimulationState, g: RunwayEndGeom): { turn: 'left' | 'right'; deg: number }[] {
  const neighbourRight = parallelNeighbours(state.airport, g).some((n) => n.lateralFt > 0);
  const first: 'left' | 'right' = neighbourRight ? 'left' : 'right';
  const second: 'left' | 'right' = first === 'left' ? 'right' : 'left';
  return [30, 60].flatMap((deg) => [{ turn: first, deg }, { turn: second, deg }]);
}
