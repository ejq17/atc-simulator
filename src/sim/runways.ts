/** Runway geometry helpers shared by dynamics, occupancy, conflicts and the executor. */
import type { Airport, Runway, RunwayEnd, Vec2 } from './types';
import { dist, nmToM, pointInPolygon, polygonsOverlap, vDot, vNorm, vSub, vecToHeading } from './geo';

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
        return {
          runway,
          end,
          other,
          dir,
          right: { x: dir.y, y: -dir.x },
          headingDeg: vecToHeading(dir),
          lengthM: dist(end.threshold, other.threshold),
          elevationFt: end.tdzeFt ?? airport.elevationFt,
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
