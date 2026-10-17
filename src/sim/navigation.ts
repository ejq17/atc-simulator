/**
 * Lateral navigation over named fixes (IFR routing).
 *
 * Everything airport specific comes from `Airport.navaids` (fixes and navaids with a local-frame `pos`);
 * nothing here knows about KACY. `Aircraft.nav` = `{ fixes, index, mode }`:
 *
 *   route    flying the filed / assigned route (`flightPlan.route`, a spawn route, or a resumed route)
 *   direct   told to proceed direct to a fix (the fix is flown, then the rest of the route if the fix is on it)
 *   approach flying the fixes of a cleared instrument approach
 *   vectors  controller headings are being flown; the fix list is kept so DIRECT_FIX / RESUME_OWN_NAVIGATION can use it
 *
 * Sequencing (fly-by): the aircraft turns toward `fixes[index]` and moves to the next fix once it is within the
 * turn-anticipation distance
 *
 *     lead = max(0.3 nm, R * tan(turn / 2)),   R = V / omega   (V = current airspeed, omega = standard turn rate)
 *
 * where `turn` is the angle between the course to the fix and the course from the fix to the following fix
 * (0 for the last fix). A fix that ends up behind the aircraft within 2 nm is also sequenced (no orbiting).
 * When the route is exhausted the aircraft holds its last heading (see flightDynamics).
 */
import type { Aircraft, AircraftPerformance, Airport, NavigationAid, Vec2 } from './types';
import { bearingDeg, clamp, deg2rad, dist, headingDiff, ktToMps, mToNm, nmToM, trueToMagnetic } from './geo';

export type NavState = NonNullable<Aircraft['nav']>;
export type NavMode = NavState['mode'];

export const MIN_ANTICIPATION_NM = 0.3;
const PASSED_RANGE_NM = 2;

const NON_NAVIGABLE: ReadonlySet<NavigationAid['type']> = new Set(['ILS', 'LOC', 'DME']);

interface FixIndex {
  byId: Map<string, NavigationAid>;
  byName: Map<string, NavigationAid>;
}
const indexCache = new WeakMap<Airport, FixIndex>();

const NAME_SUFFIX = /\s+(VORTAC|VOR DME|VOR|NDB|DME|TACAN)$/;

function normName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function fixIndex(airport: Airport): FixIndex {
  let ix = indexCache.get(airport);
  if (!ix) {
    ix = { byId: new Map(), byName: new Map() };
    for (const n of airport.navaids) {
      if (NON_NAVIGABLE.has(n.type)) continue;
      ix.byId.set(n.id.toUpperCase(), n);
      if (n.name) {
        const nm = normName(n.name);
        if (!ix.byName.has(nm)) ix.byName.set(nm, n);
        // "CEDAR LAKE VOR" / "CEDAR LAKE VORTAC" style references
        const stripped = nm.replace(NAME_SUFFIX, '');
        if (stripped !== nm && !ix.byName.has(stripped)) ix.byName.set(stripped, n);
      }
    }
    indexCache.set(airport, ix);
  }
  return ix;
}

/** Resolve a fix / navaid by identifier ("CARYL", "VCN") or by name ("Cedar Lake"). */
export function findNavFix(airport: Airport, ref: string | undefined): NavigationAid | undefined {
  if (!ref) return undefined;
  const ix = fixIndex(airport);
  const up = ref.trim().toUpperCase();
  const nm = normName(ref);
  return ix.byId.get(up) ?? ix.byName.get(nm) ?? ix.byName.get(nm.replace(NAME_SUFFIX, '')) ?? ix.byId.get(up.replace(/\s+/g, ''));
}

export function fixPosition(airport: Airport, ref: string | undefined): Vec2 | undefined {
  return findNavFix(airport, ref)?.pos;
}

type PosLike = Vec2 | Pick<Aircraft, 'pos'>;
const posOf = (p: PosLike): Vec2 => ('pos' in p ? p.pos : p);

/** Great-circle-free (local frame) distance from an aircraft / point to a fix, in nm; undefined if the fix is unknown. */
export function distanceToFixNm(airport: Airport, from: PosLike, fixRef: string): number | undefined {
  const p = fixPosition(airport, fixRef);
  return p ? mToNm(dist(posOf(from), p)) : undefined;
}

/** TRUE bearing from an aircraft / point to a fix. */
export function bearingToFixTrue(airport: Airport, from: PosLike, fixRef: string): number | undefined {
  const p = fixPosition(airport, fixRef);
  return p ? bearingDeg(posOf(from), p) : undefined;
}

/** MAGNETIC bearing from an aircraft / point to a fix (what a pilot or controller would quote). */
export function bearingToFixMag(airport: Airport, from: PosLike, fixRef: string): number | undefined {
  const t = bearingToFixTrue(airport, from, fixRef);
  return t === undefined ? undefined : trueToMagnetic(t, airport.magneticVariationDeg);
}

/** Turn radius (m) at the current airspeed and the type's standard turn rate. */
export function turnRadiusM(ac: Pick<Aircraft, 'airspeedKt'>, perf: AircraftPerformance): number {
  return ktToMps(Math.max(ac.airspeedKt, 40)) / deg2rad(perf.turnRateDegPerSec);
}

/** Turn-anticipation distance (m) for a fly-by turn of `turnDeg` degrees. */
export function turnLeadM(ac: Pick<Aircraft, 'airspeedKt'>, perf: AircraftPerformance, turnDeg: number): number {
  const t = clamp(Math.abs(turnDeg), 0, 150);
  return Math.max(nmToM(MIN_ANTICIPATION_NM), turnRadiusM(ac, perf) * Math.tan(deg2rad(t) / 2));
}

export function navExhausted(nav: NavState | undefined): boolean {
  return !nav || nav.index >= nav.fixes.length;
}

/** Identifier of the fix currently flown toward, if any. */
export function currentFixId(ac: Pick<Aircraft, 'nav'>): string | undefined {
  const n = ac.nav;
  return n && n.index < n.fixes.length ? n.fixes[n.index] : undefined;
}

/**
 * Advance `nav.index` past every fix the aircraft has reached (or passed). Unknown fixes are skipped.
 * Returns the identifiers that were sequenced this call.
 */
export function advanceNav(airport: Airport, ac: Aircraft, perf: AircraftPerformance): string[] {
  const nav = ac.nav;
  const done: string[] = [];
  if (!nav || nav.mode === 'vectors') return done;
  for (let guard = 0; guard < 4 && nav.index < nav.fixes.length; guard++) {
    const id = nav.fixes[nav.index];
    const p = fixPosition(airport, id);
    if (!p) {
      done.push(id);
      nav.index++;
      continue;
    }
    const d = dist(ac.pos, p);
    const brg = bearingDeg(ac.pos, p);
    const nextPos = nav.index + 1 < nav.fixes.length ? fixPosition(airport, nav.fixes[nav.index + 1]) : undefined;
    const turn = nextPos ? Math.abs(headingDiff(brg, bearingDeg(p, nextPos))) : 0;
    const lead = turnLeadM(ac, perf, turn);
    const behind = d < nmToM(PASSED_RANGE_NM) && Math.abs(headingDiff(brg, ac.trackDeg)) > 100;
    if (d <= lead || behind) {
      done.push(id);
      nav.index++;
    } else break;
  }
  return done;
}

/** Case-insensitive position of `ref` in `fixes` (identifier compare, falls back to name resolution). */
export function indexOfFix(airport: Airport, fixes: string[], ref: string): number {
  const up = ref.toUpperCase();
  const direct = fixes.findIndex((f) => f.toUpperCase() === up);
  if (direct >= 0) return direct;
  const id = findNavFix(airport, ref)?.id.toUpperCase();
  return id ? fixes.findIndex((f) => f.toUpperCase() === id) : -1;
}
