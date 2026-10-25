/**
 * Approach keeps the arrivals it vectors apart from the other traffic it can see: JO 7110.65 5-5-4 (radar separation: 3 nm, or 1,000 ft vertical, 5-5-1) and 5-6-1
 * (vectors for separation). The arrivals of the AI Approach all received the lowest altitude the MVA allows (`descentAltitude`) and were then sent direct to the
 * same initial fix, so two or three of them converged at the same altitude (free-play soak KBOS / KPHL: "IFR/APPROACH | IFR/APPROACH" near-miss alerts, 1.5 nm
 * and under 500 ft, throughout). The controller's tool for that is the altitude: an arrival is not descended into the level of traffic it would meet, and one that
 * is above traffic it would meet is stopped at the level that keeps 1,000 ft above it ("maintain ...").
 *
 * The projection is the straight course at the current ground speed (`pathWorld.defaultPath`: the pattern for pattern traffic, a line for the rest) with the altitude
 * profile of the assignment under test; the separation is the ratio of `pathWorld.pathSeparation` against the near-miss alert (1.5 nm / 500 ft): `SEP_RATIO` of 2
 * is the radar minimum of 3 nm / 1,000 ft, the AI asks for a little less (`APPROACH_SEP_RATIO`) because it only acts on what it projects for the next two minutes.
 */
import type { Aircraft, SimulationState } from '../sim/types';
import { getPerformance } from '../sim/performance';
import { defaultPath, defaultPaths, pathSeparation } from './pathWorld';
import type { Path } from './airbornePath';

/** Smallest separation ratio the AI accepts between an arrival it works and any other aircraft over the next minutes (DESIGN VALUE: 3 nm / 1,000 ft is 2.0). */
export const APPROACH_SEP_RATIO = 1.7;
/** Seconds of the projection that count. */
const SEP_HORIZON_SEC = 150;

/** `path` with the altitude profile of an aircraft that descends (or holds) toward `targetFt` at its type's descent rate. */
export function withTargetAltitude(ac: Aircraft, path: Path, targetFt: number): Path {
  const rate = getPerformance(ac.type).descentRateFpm / 60;
  const climb = getPerformance(ac.type).climbRateFpm / 60;
  let alt = ac.altitudeFt;
  return path.map((p) => {
    const out = p ? { ...p, altFt: alt } : undefined;
    alt += Math.max(-rate, Math.min(climb, targetFt - alt));
    return out;
  });
}

/** The smallest separation ratio (and the other aircraft) of `ac` flying its projected course while descending to `targetFt`. */
export function separationAt(state: SimulationState, ac: Aircraft, targetFt: number): { ratio: number; otherId?: string; atSec?: number } {
  const base = defaultPath(state, ac);
  if (!base) return { ratio: Infinity };
  const path = withTargetAltitude(ac, base.slice(0, SEP_HORIZON_SEC), targetFt);
  const others = defaultPaths(state);
  const c = pathSeparation(state, ac.id, path, others);
  return c ? { ratio: c.ratio, otherId: c.otherId, atSec: c.atSec } : { ratio: Infinity };
}

/**
 * The altitude `ac` may be descended to: the lowest altitude at or above `preferredFt` (in steps of 500 ft up to where it is now) whose descent keeps the
 * separation, else the altitude it holds now. Never above where it is.
 */
export function safeDescentAltitude(state: SimulationState, ac: Aircraft, preferredFt: number): number {
  const now = Math.floor(ac.altitudeFt / 100) * 100;
  for (let alt = preferredFt; alt < now; alt += 500) {
    if (separationAt(state, ac, alt).ratio >= APPROACH_SEP_RATIO) return alt;
  }
  return Math.max(preferredFt, now);
}

/**
 * What to do about an arrival whose projected course comes inside the separation (`APPROACH_SEP_RATIO`) of other traffic: the altitude to give it, or undefined
 * when nothing is needed or the other aircraft is the one to act. The aircraft farther from its runway acts when both are worked by Approach (`worked`): it stops
 * its descent at the level it is at, else climbs 1,000 or 2,000 ft above it (5-5-1 vertical separation); anything the Approach does not work (pattern traffic, VFR
 * straight-ins on the Tower frequency, departures) is avoided the same way. A climb is also what a controller gives an arrival that has been brought down to the
 * level of another one ahead.
 */
export function separationAltitude(state: SimulationState, ac: Aircraft, worked: (other: Aircraft) => boolean, distNm: (a: Aircraft) => number): number | undefined {
  const target = ac.target.altitudeFt ?? ac.altitudeFt;
  const now = separationAt(state, ac, target);
  if (now.ratio >= APPROACH_SEP_RATIO) return undefined;
  const other = now.otherId ? state.aircraft[now.otherId] : undefined;
  if (other && worked(other)) {
    // who acts: the one that is descending into the other; else the follower (the one farther from its runway), the lower id when they are level with each other
    const otherTarget = other.target.altitudeFt ?? other.altitudeFt;
    const descending = target < ac.altitudeFt - 50;
    const otherDescending = otherTarget < other.altitudeFt - 50;
    const acAbove = ac.altitudeFt >= other.altitudeFt;
    if (otherDescending && !acAbove && !(descending && acAbove)) return undefined; // the one above is descending into this one: it acts
    if (!(descending && acAbove) && (distNm(other) > distNm(ac) || (distNm(other) === distNm(ac) && other.id < ac.id))) return undefined;
  }
  const level = Math.floor(ac.altitudeFt / 100) * 100;
  const base = Math.round(ac.altitudeFt / 100) * 100;
  for (const alt of [level, base + 1000, base + 2000]) {
    if (Math.abs(alt - target) < 50) continue; // already assigned: what it flies now conflicts
    if (separationAt(state, ac, alt).ratio >= APPROACH_SEP_RATIO) return alt;
  }
  return undefined;
}
