/**
 * Conflict-free placement of generated aircraft: arrivals 10-12 nm out (on final or on a base-leg offset) and
 * departures on free parking positions. Shared by the traffic generator and the free-play builder.
 */
import type { Airport, ParkingPosition, ScenarioAircraftSpawn, Vec2 } from '../sim/types';
import { getPerformance } from '../sim/performance';
import { alongCross, findRunwayEnd } from '../sim/runways';
import { glideAltitudeFt, glidePathFor } from '../sim/flightDynamics';
import { dependentMates, dependentPairClear } from '../ai/world';
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
/**
 * Nominal speeds (kt) to the threshold used to project two arrivals on adjacent parallel finals against each other (`dependentPairClear`): the mean from 10 nm out
 * (APPROACH phase flies (climb + approach speed) / 2, then the final approach speed): Cessna about 66 kt, A320 about 150 kt. DESIGN VALUES.
 */
export const NOMINAL_APPROACH_LIGHT_KT = 66;
export const NOMINAL_APPROACH_JET_KT = 150;
const nominalKt = (type: string): number => (getPerformance(type).category === 'light' ? NOMINAL_APPROACH_LIGHT_KT : NOMINAL_APPROACH_JET_KT);

const typicalSpeed = (type: string): number => (getPerformance(type).category === 'light' ? 100 : 170);

function dNm(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y) / NM;
}

/** Is `pos` acceptable given the airborne aircraft already in play? */
export function arrivalPositionOk(airport: Airport, pos: Vec2, type: string, endId: string, others: AirbornePoint[]): boolean {
  const thr = endOf(airport, endId).threshold;
  const g = findRunwayEnd(airport, endId)!;
  const mates = dependentMates(airport, g);
  const hdg = (endOf(airport, endId).trueHeadingDeg * Math.PI) / 180;
  const dir = { x: Math.sin(hdg), y: Math.cos(hdg) };
  for (const o of others) {
    const d = dNm(pos, o.pos);
    if (d < MIN_ARRIVAL_GAP_NM) return false;
    // The adjacent final of a parallel runway (dependent approaches, JO 7110.65 5-9-6): projected straight to the thresholds at nominal speeds the two keep the
    // stagger along the course and never pass each other (`dependentPairClear`).
    const mate = o.runwayEnd !== undefined && o.runwayEnd !== endId ? mates.find((m) => m.end.end.id === o.runwayEnd) : undefined;
    if (mate && !dependentPairClear(mate, alongCross(g, pos).along / NM, nominalKt(type), alongCross(g, o.pos).along / NM, nominalKt(o.type))) return false;
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
    const randomAlt = Math.round((2500 + rng() * 500) / 100) * 100;
    // The altitude follows the distance: ON the glide path of the final (the plate's angle and TCH, else the visual path / 3 degrees: the path the engine flies) when
    // placed on the extended centreline, and no higher than that path on a base-leg start (a start above it floated down the runway or went around, see
    // `cannotTouchDownInZone`). Farther out the old 2,500-3,000 ft is already below the path and is kept.
    const rg = findRunwayEnd(airport, endId)!;
    const pathFt = glideAltitudeFt(rg.elevationFt, nm * NM, glidePathFor(airport, undefined, rg, getPerformance(type)));
    // (an arrival for a runway with a parallel neighbour is placed on its final: a base-leg start is offset from the course and its along-course speed is lower than
    // the neighbour's traffic, so the stagger of `dependentPairClear` would not hold)
    const dependent = dependentMates(airport, findRunwayEnd(airport, endId)!).length > 0;
    const onFinalLine = o.forceFinal || dependent || rng() < 0.5;
    if (onFinalLine) {
      const pos = finalPosition(airport, endId, nm);
      if (!arrivalPositionOk(airport, pos, type, endId, others)) continue;
      return { kind: 'airborne', pos, altitudeFt: Math.round(pathFt / 100) * 100, headingDeg: e.trueHeadingDeg, speedKt, runwayEnd: endId, distanceNm: nm };
    }
    const sign = rng() < 0.5 ? -1 : 1;
    const off = sign * (20 + rng() * 30);
    const back = ((e.trueHeadingDeg + 180 + off) * Math.PI) / 180;
    const pos = { x: e.threshold.x + Math.sin(back) * nm * NM, y: e.threshold.y + Math.cos(back) * nm * NM };
    if (!arrivalPositionOk(airport, pos, type, endId, others)) continue;
    // Head for a point on the final 4 nm out; the engine re-aims every tick anyway.
    const aim = finalPosition(airport, endId, 4);
    const headingDeg = norm360((Math.atan2(aim.x - pos.x, aim.y - pos.y) * 180) / Math.PI);
    return { kind: 'airborne', pos, altitudeFt: Math.min(randomAlt, Math.round(pathFt / 100) * 100), headingDeg, speedKt, runwayEnd: endId };
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
