/**
 * Conflict-free placement of generated aircraft: arrivals 10-12 nm out (on final or on a base-leg offset) and
 * departures on free parking positions. Shared by the traffic generator and the free-play builder.
 */
import type { Airport, ParkingPosition, ScenarioAircraftSpawn, Vec2 } from '../sim/types';
import { getPerformance } from '../sim/performance';
import { endOf, finalPosition, NM, norm360, parkingPoolFor } from './world';
import type { Rng } from '../sim/rng';

export type AirborneStart = Extract<ScenarioAircraftSpawn['start'], { kind: 'airborne' }>;

export interface AirbornePoint {
  pos: Vec2;
  type: string;
  /** Runway end the aircraft is assigned to (arrivals). */
  runwayEnd?: string;
}

/** Minimum separation of a newly generated arrival from any other arrival. */
export const MIN_ARRIVAL_GAP_NM = 3;
/** Larger gap when a faster aircraft would spawn behind a slower one on the same final. */
export const OVERTAKE_GAP_NM = 5;

const typicalSpeed = (type: string): number => (getPerformance(type).category === 'light' ? 100 : 170);

function dNm(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y) / NM;
}

/** Is `pos` acceptable given the airborne aircraft already in play? */
export function arrivalPositionOk(airport: Airport, pos: Vec2, type: string, endId: string, others: AirbornePoint[]): boolean {
  const thr = endOf(airport, endId).threshold;
  const hdg = (endOf(airport, endId).trueHeadingDeg * Math.PI) / 180;
  const dir = { x: Math.sin(hdg), y: Math.cos(hdg) };
  for (const o of others) {
    const d = dNm(pos, o.pos);
    if (d < MIN_ARRIVAL_GAP_NM) return false;
    // Same final (both within a 2 nm wide corridor of the extended centreline): faster behind slower needs more room.
    if (o.runwayEnd === endId) {
      const cross = (p: Vec2): number => (p.x - thr.x) * dir.y - (p.y - thr.y) * dir.x;
      const along = (p: Vec2): number => (p.x - thr.x) * dir.x + (p.y - thr.y) * dir.y;
      const sameCorridor = Math.abs(cross(pos)) < 1.5 * NM && Math.abs(cross(o.pos)) < 1.5 * NM;
      const newIsBehind = along(pos) < along(o.pos);
      if (sameCorridor && newIsBehind && typicalSpeed(type) > typicalSpeed(o.type) && d < OVERTAKE_GAP_NM) return false;
    }
  }
  return true;
}

/**
 * Pick a spawn 10-12 nm out for a landing on `endId`: half the time on the extended centreline, otherwise on a
 * base-leg bearing offset 20-50 degrees either side of it. Altitude 2,500-3,000 ft, speed by type.
 * Returns undefined when no acceptable spot is found in `tries` attempts.
 */
export function pickArrivalStart(
  airport: Airport, endId: string, type: string, rng: Rng, others: AirbornePoint[],
  o: { minNm?: number; maxNm?: number; tries?: number; forceFinal?: boolean } = {},
): AirborneStart | undefined {
  const e = endOf(airport, endId);
  const minNm = o.minNm ?? 10;
  const maxNm = o.maxNm ?? 12;
  const light = getPerformance(type).category === 'light';
  const speedKt = light ? 100 : 170;
  for (let i = 0; i < (o.tries ?? 24); i++) {
    const nm = minNm + rng() * (maxNm - minNm);
    const altitudeFt = Math.round((2500 + rng() * 500) / 100) * 100;
    const onFinalLine = o.forceFinal || rng() < 0.5;
    if (onFinalLine) {
      const pos = finalPosition(airport, endId, nm);
      if (!arrivalPositionOk(airport, pos, type, endId, others)) continue;
      return { kind: 'airborne', pos, altitudeFt, headingDeg: e.trueHeadingDeg, speedKt, runwayEnd: endId, distanceNm: nm };
    }
    const sign = rng() < 0.5 ? -1 : 1;
    const off = sign * (20 + rng() * 30);
    const back = ((e.trueHeadingDeg + 180 + off) * Math.PI) / 180;
    const pos = { x: e.threshold.x + Math.sin(back) * nm * NM, y: e.threshold.y + Math.cos(back) * nm * NM };
    if (!arrivalPositionOk(airport, pos, type, endId, others)) continue;
    // Head for a point on the final 4 nm out; the engine re-aims every tick anyway.
    const aim = finalPosition(airport, endId, 4);
    const headingDeg = norm360((Math.atan2(aim.x - pos.x, aim.y - pos.y) * 180) / Math.PI);
    return { kind: 'airborne', pos, altitudeFt, headingDeg, speedKt, runwayEnd: endId };
  }
  return undefined;
}

/** A parking position of the right category for `type` that nothing is standing on or about to appear on. */
export function pickParking(
  airport: Airport, type: string, rng: Rng, occupied: Vec2[], reservedIds: ReadonlySet<string>,
): ParkingPosition | undefined {
  const free = parkingPoolFor(airport, type).filter((p) => !reservedIds.has(p.id) && !occupied.some((o) => Math.hypot(o.x - p.pos.x, o.y - p.pos.y) < 20));
  if (!free.length) return undefined;
  return free[Math.min(free.length - 1, Math.floor(rng() * free.length))];
}
