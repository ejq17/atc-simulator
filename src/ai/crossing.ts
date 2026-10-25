/**
 * Arrivals to intersecting runways (JO 7110.65 3-10-4, text read on faa.gov, see docs/FAA-REFERENCES.md "Intersecting runways").
 *
 * The engine refuses a landing clearance (`conflicts.intersectingIssues`) when two arrivals to intersecting runways would cross their thresholds so
 * close in time that the one that lands first has not passed the intersection when the other crosses its threshold: the first has "passed" when it has
 * covered `sInt + 60 m` (its runway's intersection with the other one, measured from its threshold) at half its touchdown speed. That figure is a time
 * of up to 150 s at KBOS (9/27 against 4R/22L), not the runway occupancy time of the same-runway rule, and the Tower and Approach sequencing used the
 * latter: the result was a landing clearance the engine refused, and a go-around at 1 nm, over and over (free-play soak KBOS SW / NW).
 *
 * `intersectionPassSec` mirrors the engine's figure so the AI plans with the number the clearance gate will use; `CROSSING_MARGIN_SEC` is the AI's own
 * margin on top (DESIGN VALUE). Pure functions of the airport geometry and the aircraft type.
 */
import type { Aircraft, Airport } from '../sim/types';
import { ktToMps } from '../sim/geo';
import { alongCross, findRunway, runwayIntersection } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { getPerformance } from '../sim/performance';

/** The engine's margin past the intersection (m): conflicts.ts `INTERSECTION_PASS_MARGIN_M`. */
export const INTERSECTION_PASS_MARGIN_M = 60;
/** Seconds the AI keeps on top of the engine's passing time between two arrivals to intersecting runways. DESIGN VALUE. */
export const CROSSING_MARGIN_SEC = 12;

const cache = new WeakMap<Airport, Map<string, number | null>>();

/** Metres from the landing threshold of `g` to the intersection with `otherRunwayId` (undefined when the runways do not cross). */
export function intersectionAlongM(airport: Airport, g: RunwayEndGeom, otherRunwayId: string): number | undefined {
  const other = findRunway(airport, otherRunwayId);
  if (!other || other.id === g.runway.id) return undefined;
  const P = runwayIntersection(g.runway, other);
  return P ? alongCross(g, P).along : undefined;
}

/**
 * Seconds an arrival of `type` on `g` needs after its threshold crossing to pass the intersection with `otherRunwayId` (the engine's rule: `sInt + 60 m` at
 * half the touchdown speed). Undefined when the two runways do not cross.
 */
export function intersectionPassSec(airport: Airport, type: string, g: RunwayEndGeom, otherRunwayId: string): number | undefined {
  let m = cache.get(airport);
  if (!m) cache.set(airport, (m = new Map()));
  const key = `${g.end.id}>${otherRunwayId}:${type}`;
  let v = m.get(key);
  if (v === undefined) {
    const s = intersectionAlongM(airport, g, otherRunwayId);
    v = s === undefined ? null : (s + INTERSECTION_PASS_MARGIN_M) / (0.5 * ktToMps(getPerformance(type).touchdownSpeedKt));
    m.set(key, v);
  }
  return v ?? undefined;
}

/** Seconds the arrival `ac` (assigned to `g`) blocks the crossing runway `otherRunwayId`: from its threshold crossing for `intersectionPassSec`. */
export const crossingWindowSec = (airport: Airport, ac: Aircraft, g: RunwayEndGeom, otherRunwayId: string): number | undefined => intersectionPassSec(airport, ac.type, g, otherRunwayId);

/**
 * Do two arrivals with threshold times `tA` and `tB` (seconds from now) to intersecting runways satisfy the engine's rule with `CROSSING_MARGIN_SEC` to spare?
 * The first to cross its threshold must have passed the intersection (`passA` / `passB` after its own crossing) when the other crosses its threshold.
 */
export function crossingPairClear(tA: number, passA: number, tB: number, passB: number): boolean {
  return tA <= tB ? tB >= tA + passA + CROSSING_MARGIN_SEC : tA >= tB + passB + CROSSING_MARGIN_SEC;
}
