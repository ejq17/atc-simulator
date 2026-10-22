/** Runway geometry helpers shared by dynamics, occupancy, conflicts and the executor. */
import type { Airport, Runway, RunwayEnd, Vec2 } from './types';
import { dist, ftToM, nmToM, pointInPolygon, polygonsOverlap, vDot, vNorm, vSub, vecToHeading } from './geo';

export interface RunwayEndGeom {
  runway: Runway;
  end: RunwayEnd;
  other: RunwayEnd;
  /** Unit vector pointing from this end's threshold toward the opposite end (landing / takeoff direction). */
  dir: Vec2;
  /** Unit vector to the right of `dir`. */
  right: Vec2;
  /** TRUE heading of `dir`. */
  headingDeg: number;
  lengthM: number;
  elevationFt: number;
  /** Displaced landing threshold: metres from the pavement end (`end.threshold`) along `dir`; 0 when none. */
  displacedM: number;
  /** The landing threshold (`end.threshold` moved `displacedM` along `dir`); equals `end.threshold` when none. */
  landingThreshold: Vec2;
  /** Landing distance available (m): the NASR declared LDA when published (it wins over the geometry: KMHT 35 declares 7,650 ft where the geometry gives 8,400), else the pavement length less the displacement. */
  ldaM: number;
  /** Takeoff run available (m): NASR declared TORA when published, else the pavement length. */
  toraM: number;
}

/** "RWY 04L" / "04" -> "4L"; leaves "13/31" untouched. */
export function normalizeRunwayEndId(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/^(RUNWAY|RWY)\s*/, '');
  if (s.includes('/')) return s;
  s = s.replace(/^0+(?=\d)/, '');
  return s;
}

export function findRunwayEnd(airport: Airport, endId: string | undefined): RunwayEndGeom | undefined {
  if (!endId) return undefined;
  const id = normalizeRunwayEndId(endId);
  for (const runway of airport.runways) {
    for (let i = 0; i < 2; i++) {
      const end = runway.ends[i];
      if (normalizeRunwayEndId(end.id) === id) {
        const other = runway.ends[1 - i];
        const dir = vNorm(vSub(other.threshold, end.threshold));
        const lengthM = dist(end.threshold, other.threshold);
        const displacedM = ftToM(end.displacedThresholdFt ?? 0);
        const lda = end.declaredDistancesFt?.lda;
        const tora = end.declaredDistancesFt?.tora;
        return {
          runway,
          end,
          other,
          dir,
          right: { x: dir.y, y: -dir.x },
          headingDeg: vecToHeading(dir),
          lengthM,
          elevationFt: end.tdzeFt ?? airport.elevationFt,
          displacedM,
          landingThreshold: displacedM > 0 ? { x: end.threshold.x + dir.x * displacedM, y: end.threshold.y + dir.y * displacedM } : end.threshold,
          ldaM: typeof lda === 'number' ? ftToM(lda) : lengthM - displacedM,
          toraM: typeof tora === 'number' ? ftToM(tora) : lengthM,
        };
      }
    }
  }
  return undefined;
}

/** Resolve "13/31", "13", "31", "RWY 13" to a runway. */
export function findRunway(airport: Airport, idOrEnd: string | undefined): Runway | undefined {
  if (!idOrEnd) return undefined;
  const id = normalizeRunwayEndId(idOrEnd);
  const direct = airport.runways.find((r) => r.id.toUpperCase() === id);
  if (direct) return direct;
  if (id.includes('/')) {
    const [a] = id.split('/');
    return findRunwayEnd(airport, a)?.runway;
  }
  return findRunwayEnd(airport, id)?.runway;
}

/** Resolve a runway end id out of a runway-end or runway id ("13/31" -> undefined, "13" -> "13"). */
export function resolveEndId(airport: Airport, raw: string | undefined): string | undefined {
  const g = findRunwayEnd(airport, raw);
  return g?.end.id;
}

/** Position relative to the extended centreline: along (m, negative before threshold), cross (m, + = right of course). */
export function alongCross(g: RunwayEndGeom, p: Vec2): { along: number; cross: number } {
  const rel = vSub(p, g.end.threshold);
  return { along: vDot(rel, g.dir), cross: vDot(rel, g.right) };
}

export function runwaysAt(airport: Airport, p: Vec2): Runway[] {
  return airport.runways.filter((r) => pointInPolygon(p, r.polygon));
}

/** Runways whose surfaces intersect the given runway (e.g. 4/22 for 13/31). */
export function crossingRunways(airport: Airport, runwayId: string): Runway[] {
  const rw = findRunway(airport, runwayId);
  if (!rw) return [];
  return airport.runways.filter((o) => o.id !== rw.id && polygonsOverlap(rw.polygon, o.polygon));
}

/** Distance (m) from threshold of `g` before which an approaching aircraft counts as 'on final' for N nm. */
export function isOnFinal(g: RunwayEndGeom, p: Vec2, headingDeg: number, maxNm: number): boolean {
  const { along, cross } = alongCross(g, p);
  const d = -along;
  if (d < -50 || d > nmToM(maxNm)) return false;
  if (Math.abs(cross) > Math.max(300, d * 0.25)) return false;
  let diff = Math.abs(((headingDeg - g.headingDeg + 540) % 360) - 180);
  diff = Math.abs(diff);
  return diff < 60;
}

/** A runway end on a parallel runway (same direction within 15 degrees, a different runway) near `g`. */
export interface ParallelNeighbour {
  end: RunwayEndGeom;
  /** Centreline spacing (ft); + = the neighbour is to the right of `g`'s landing direction. */
  lateralFt: number;
  /** The neighbour's threshold along `g`'s course (m): + = ahead of `g`'s threshold, - = behind it. */
  staggerM: number;
}

/** Parallel runways whose centrelines are within `maxFt` of `g`'s (default 9,000 ft: the dependent approach limit of JO 7110.65 5-9-6), same landing direction. */
export function parallelNeighbours(airport: Airport, g: RunwayEndGeom, maxFt = 9000): ParallelNeighbour[] {
  const out: ParallelNeighbour[] = [];
  for (const r of airport.runways) {
    if (r.id === g.runway.id) continue;
    for (const e of r.ends) {
      const og = findRunwayEnd(airport, e.id);
      if (!og) continue;
      let dh = Math.abs(og.headingDeg - g.headingDeg) % 360;
      if (dh > 180) dh = 360 - dh;
      if (dh > 15) continue;
      const { along, cross } = alongCross(g, og.end.threshold);
      const latFt = Math.abs(cross) / 0.3048;
      if (latFt > maxFt || latFt < 1) continue;
      // two runways that cross each other are not "parallel" however close their headings are
      if (polygonsOverlap(g.runway.polygon, r.polygon)) continue;
      out.push({ end: og, lateralFt: cross >= 0 ? latFt : -latFt, staggerM: along });
    }
  }
  return out;
}

/**
 * The traffic pattern side an arrival or a touch-and-go uses at `g` when nothing says otherwise: left (AIM 4-3-2), except that the patterns of parallel runways
 * turn away from each other (AIM 4-3-3, JO 7110.65 3-10: the right-hand runway of a pair flies right traffic), so that the downwind of one never runs over the
 * final of the other. A runway with a parallel neighbour on its left flies right traffic.
 */
export function defaultPatternSide(airport: Airport, g: RunwayEndGeom): 'left' | 'right' {
  const near = parallelNeighbours(airport, g);
  if (near.some((n) => n.lateralFt > 0)) return 'left';
  return near.some((n) => n.lateralFt < 0) ? 'right' : 'left';
}

/** Point where the centrelines of two runways cross (undefined if they do not intersect). */
export function runwayIntersection(a: Runway, b: Runway): Vec2 | undefined {
  const [a1, a2] = [a.ends[0].threshold, a.ends[1].threshold];
  const [b1, b2] = [b.ends[0].threshold, b.ends[1].threshold];
  const r = vSub(a2, a1);
  const q = vSub(b2, b1);
  const denom = r.x * q.y - r.y * q.x;
  if (Math.abs(denom) < 1e-9) return undefined;
  const w = vSub(b1, a1);
  const t = (w.x * q.y - w.y * q.x) / denom;
  const u = (w.x * r.y - w.y * r.x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return undefined;
  return { x: a1.x + r.x * t, y: a1.y + r.y * t };
}

export interface DisplacedThreshold {
  endId: string;
  /** The pavement end (`RunwayEnd.threshold`). */
  pavementEnd: Vec2;
  /** The displaced landing threshold. */
  threshold: Vec2;
  /** Unit vector in the landing direction of this end. */
  dir: Vec2;
  displacedM: number;
}

/** The displaced thresholds of a runway (ends without one are omitted); `threshold` is `displacedThresholdFt` from the pavement end along the runway. */
export function displacedThresholds(rw: Runway): DisplacedThreshold[] {
  const out: DisplacedThreshold[] = [];
  for (let i = 0; i < 2; i++) {
    const e = rw.ends[i];
    const o = rw.ends[1 - i];
    const ft = e.displacedThresholdFt ?? 0;
    if (!(ft > 0)) continue;
    const dir = vNorm(vSub(o.threshold, e.threshold));
    const displacedM = ftToM(ft);
    out.push({ endId: e.id, pavementEnd: e.threshold, threshold: { x: e.threshold.x + dir.x * displacedM, y: e.threshold.y + dir.y * displacedM }, dir, displacedM });
  }
  return out;
}
