/**
 * Pure time projections for runway traffic, used by the clearance gate (`conflicts.assessClearanceSafety`) and by the automatic
 * go-around: when will a preceding arrival cross the threshold, touch down and be clear of the runway; when will a rolling
 * departure or a rolling-out arrival reach a point along the runway; how long does a crossing aircraft occupy the other runway.
 *
 * Arrival model: constant speed to the threshold (`min(groundspeed, 1.15 x approach speed)` when more than 2 nm out, the aircraft
 * slows down), touchdown at the typical point (390 m light / 490 m jets, or later when high), then the rollout of
 * `predictRolloutPlan` (the same exit selection as the flight dynamics: braking at the type's sourced rate to the first exit at its
 * safe exit speed), then the exit connector at exit speed until the tail is off the runway surface. Without a reachable exit the
 * aircraft stops short of the end / intersection and is "clear" 45 s after stopping (taxi instructions needed).
 */
import type { Aircraft, SimulationState, Vec2 } from './types';
import { dist, ktToMps, mToFt, nmToM, pointInPolygon, deg2rad } from './geo';
import { alongCross } from './runways';
import type { RunwayEndGeom } from './runways';
import { getPerformance } from './performance';
import { predictRolloutPlan } from './flightDynamics';

const TAN_GP = Math.tan(deg2rad(3));
const TYPICAL_TD_LIGHT_M = 390;
const TYPICAL_TD_JET_M = 490;
const CLEAR_AFTER_STOP_SEC = 45;

export interface RolloutProjection {
  /** Seconds from touchdown at which the tail is clear of the runway surface. */
  clearAfterSec: number;
  /** Distance (m) along the runway the aircraft travels from touchdown until it leaves the runway axis (exit) or stops. */
  travelM: number;
  /** Position (m along the runway end) of the exit / stop. */
  endAlongM: number;
  /** Ground distance covered `tau` seconds after touchdown. */
  distanceAt(tau: number): number;
  /** Seconds after touchdown at which `s` m have been covered (Infinity when it exits / stops first). */
  timeAtDistance(s: number): number;
  exits: boolean;
}

/** Distance (m) from the exit node along the connector until the aircraft (length `lengthM`) is off the runway polygon. */
function clearDistanceM(state: SimulationState, g: RunwayEndGeom, exitNodeId: string, holdNodeId: string, lengthM: number): number {
  const graph = state.airport.taxiwayGraph;
  const a = graph.nodes[exitNodeId].pos;
  const b = graph.nodes[holdNodeId].pos;
  const total = dist(a, b);
  const ux = (b.x - a.x) / Math.max(total, 1e-6);
  const uy = (b.y - a.y) / Math.max(total, 1e-6);
  for (let s = 0; s <= total; s += 4) {
    if (!pointInPolygon({ x: a.x + ux * s, y: a.y + uy * s }, g.runway.polygon)) return s + lengthM / 2;
  }
  return total + lengthM / 2;
}

/** Rollout from `tdAlongM` at `vTdMps` for an aircraft of `type` landing on `g`. */
export function projectRollout(state: SimulationState, type: string, g: RunwayEndGeom, tdAlongM: number, vTdMps: number): RolloutProjection {
  const perf = getPerformance(type);
  const plan = predictRolloutPlan(state, type, g, tdAlongM, vTdMps);
  const normal = ktToMps(perf.decelKtPerSec);
  if (plan.exitNodeId && plan.holdNodeId) {
    const vC = Math.min(plan.exitSpeedMps, vTdMps);
    const a = Math.max(plan.brakeMps2, 0.1);
    const exitAlong = alongCross(g, state.airport.taxiwayGraph.nodes[plan.exitNodeId].pos).along;
    const total = Math.max(0, exitAlong - tdAlongM);
    const tBrake = vTdMps > vC ? (vTdMps - vC) / a : 0;
    const dBrake = vTdMps * tBrake - 0.5 * a * tBrake * tBrake;
    const distanceAt = (tau: number): number => {
      const braking = Math.min(tau, tBrake);
      const base = vTdMps * braking - 0.5 * a * braking * braking;
      return Math.min(total, tau <= tBrake ? base : dBrake + Math.max(vC, 1) * (tau - tBrake));
    };
    const timeAtDistance = (s: number): number => {
      if (s > total + 1e-6) return Infinity;
      if (s <= dBrake) {
        // vTd*t - a t^2/2 = s
        const disc = vTdMps * vTdMps - 2 * a * s;
        return a > 0 ? (vTdMps - Math.sqrt(Math.max(0, disc))) / a : s / Math.max(vTdMps, 1);
      }
      return tBrake + (s - dBrake) / Math.max(vC, 1);
    };
    const tExit = timeAtDistance(total);
    const clearAfterSec = tExit + clearDistanceM(state, g, plan.exitNodeId, plan.holdNodeId, perf.lengthM) / Math.max(vC, 1);
    return { clearAfterSec, travelM: total, endAlongM: exitAlong, distanceAt, timeAtDistance, exits: true };
  }
  const stopAlong = plan.stopAlongM ?? tdAlongM + (vTdMps * vTdMps) / (2 * normal);
  const room = Math.max(1, stopAlong - tdAlongM);
  const a = Math.max(plan.brakeMps2, 0.1);
  const tStop = vTdMps / a;
  const dStop = (vTdMps * vTdMps) / (2 * a);
  const distanceAt = (tau: number): number => (tau >= tStop ? Math.min(dStop, room) : vTdMps * tau - 0.5 * a * tau * tau);
  const timeAtDistance = (s: number): number => (s > Math.min(dStop, room) + 1e-6 ? Infinity : (vTdMps - Math.sqrt(Math.max(0, vTdMps * vTdMps - 2 * a * s))) / a);
  return { clearAfterSec: tStop + CLEAR_AFTER_STOP_SEC, travelM: Math.min(dStop, room), endAlongM: stopAlong, distanceAt, timeAtDistance, exits: false };
}

export interface ArrivalProjection {
  /** Seconds until the threshold is crossed (0 when past it). */
  tThr: number;
  /** Seconds until touchdown (0 when on the ground). */
  tTd: number;
  tdAlongM: number;
  rollout: RolloutProjection;
  /** Seconds until the tail is clear of the runway. */
  tClear: number;
  /** Position (m along the runway end, aircraft centre) `t` seconds from now; the aircraft is on the approach path until touchdown. */
  alongAt(t: number): number;
  /** Seconds from now until the aircraft centre reaches `s` m along the runway (Infinity if it exits / stops first). */
  timeAtAlong(s: number): number;
}

/** Projection of an arrival (airborne on final, or already rolling out) on runway end `g`. */
export function projectArrival(state: SimulationState, o: Aircraft, g: RunwayEndGeom): ArrivalProjection {
  const perf = getPerformance(o.type);
  const along0 = alongCross(g, o.pos).along;
  if (o.onGround) {
    const v = ktToMps(Math.max(o.groundSpeedKt, 5));
    const rollout = projectRollout(state, o.type, g, along0, v);
    return {
      tThr: 0, tTd: 0, tdAlongM: along0, rollout, tClear: rollout.clearAfterSec,
      alongAt: (t) => along0 + rollout.distanceAt(t),
      timeAtAlong: (s) => (s <= along0 ? 0 : rollout.timeAtDistance(s - along0)),
    };
  }
  const gs = ktToMps(o.groundSpeedKt);
  // distance to the LANDING threshold (the displaced one where there is one): 3-10-3 / 3-9-6 are about the landing threshold
  const dToThr = Math.max(0, g.displacedM - along0);
  const v = Math.max(ktToMps(perf.minSpeedKt), dToThr > nmToM(2) ? Math.min(gs, ktToMps(1.15 * perf.approachSpeedKt)) : gs);
  const aglM = Math.max(0, (o.altitudeFt - g.elevationFt) / mToFt(1));
  const typical = perf.category === 'light' ? TYPICAL_TD_LIGHT_M : TYPICAL_TD_JET_M;
  const tdAlongM = Math.max(g.displacedM + typical, along0 + aglM / TAN_GP);
  const tThr = dToThr / v;
  const tTd = Math.max(0, (tdAlongM - along0) / v);
  const rollout = projectRollout(state, o.type, g, tdAlongM, ktToMps(perf.touchdownSpeedKt));
  return {
    tThr, tTd, tdAlongM, rollout, tClear: tTd + rollout.clearAfterSec,
    alongAt: (t) => (t <= tTd ? along0 + v * t : tdAlongM + rollout.distanceAt(t - tTd)),
    timeAtAlong: (s) => (s <= tdAlongM ? Math.max(0, (s - along0) / v) : tTd + rollout.timeAtDistance(s - tdAlongM)),
  };
}

/** Time for the subject (airborne, on or toward the final of `g`) to cross the threshold, with the same speed model. */
export function timeToThreshold(o: Aircraft, g: RunwayEndGeom): number {
  const perf = getPerformance(o.type);
  const dToThr = Math.max(0, g.displacedM - alongCross(g, o.pos).along); // to the landing threshold
  const gs = ktToMps(o.groundSpeedKt);
  const v = Math.max(ktToMps(perf.minSpeedKt), dToThr > nmToM(2) ? Math.min(gs, ktToMps(1.15 * perf.approachSpeedKt)) : gs);
  return dToThr / v;
}

/**
 * The window (seconds from now) during which an aircraft taxiing along `path` (starting at its position) is on the surface of a
 * runway: from the first point inside `polygon` grown by `marginM` to the point where its tail has left it. Taxi speed: it starts
 * from rest (or the hold) and averages 0.6 x the taxi speed; `startDelaySec` is added (clearance acknowledged).
 */
export function surfaceWindow(path: Vec2[], polygon: readonly Vec2[], type: string, marginM: number, startDelaySec: number): { tEnter: number; tLeave: number; enterAt: Vec2 } | undefined {
  const perf = getPerformance(type);
  const v = Math.max(1.5, 0.6 * ktToMps(perf.taxiSpeedKt));
  let s = 0;
  let enter: number | undefined;
  let enterAt: Vec2 | undefined;
  let lastInside = -Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = dist(a, b);
    for (let k = 0; k <= len; k += 3) {
      const p = { x: a.x + ((b.x - a.x) * k) / Math.max(len, 1e-6), y: a.y + ((b.y - a.y) * k) / Math.max(len, 1e-6) };
      if (insideGrown(p, polygon, marginM)) {
        if (enter === undefined) {
          enter = s + k;
          enterAt = p;
        }
        lastInside = s + k;
      }
    }
    s += len;
  }
  if (enter === undefined || !enterAt) return undefined;
  return { tEnter: startDelaySec + enter / v, tLeave: startDelaySec + (lastInside + perf.lengthM) / v, enterAt };
}

function insideGrown(p: Vec2, polygon: readonly Vec2[], marginM: number): boolean {
  if (pointInPolygon(p, polygon)) return true;
  if (marginM <= 0) return false;
  // distance to the nearest edge
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / Math.max(abx * abx + aby * aby, 1e-9)));
    if (Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)) <= marginM) return true;
  }
  return false;
}
