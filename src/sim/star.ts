/**
 * Standard terminal arrival routes (STARs) as transcribed from the d-TPP chart (`InstrumentProcedure.star`; KMHT ROZZE TWO).
 *
 * Phraseology: JO 7110.65 4-7-1 "(STAR name and number) ARRIVAL, (transition name) TRANSITION" and, for the vertical profile, 4-5-7
 * "DESCEND VIA (STAR name and number) ARRIVAL" (AIM 5-4-1: "descend via" authorizes the pilot to descend at pilot's discretion to meet the
 * published restrictions; the last assigned altitude is maintained until authorization to descend; vectors or a deviation off the STAR cancel
 * its altitude and speed restrictions; JO 7110.65 5-7-2 NOTE: "Aircraft will meet all published speed restrictions when on any route or
 * procedure with published speed restrictions regardless of climb via or descend via clearance"; AIM 5-4-1: pilots begin adjusting speed "the
 * minimum distance necessary prior to a published speed restriction" and then maintain it).
 *
 * Simulator model (docs/BEHAVIOUR-ACCURACY.md): an aircraft on a STAR flies `nav` (mode 'route' or 'direct') over the STAR's fixes. The
 * altitude restrictions are flown only after "descend via" (`Aircraft.star.descendVia`); the speed restrictions are always flown while the
 * aircraft is on the STAR. The route continues from the last fix of the runway leg through the expected approach's join fixes
 * (`StarProcedure.runways[].joinApproachFixes`, from the approach plate) so that an approach clearance finds a route that joins the procedure.
 */
import type { Aircraft, Airport, InstrumentProcedure, StarProcedure } from './types';
import { findNavFix } from './navigation';

export interface StarRef { procedure: InstrumentProcedure; star: StarProcedure }

const norm = (s: string): string => s.toUpperCase().replace(/\s+/g, '');

/** The airport's transcribed STARs (procedures of type STAR that carry `star`). */
export function airportStars(airport: Pick<Airport, 'procedures'>): StarRef[] {
  return airport.procedures.filter((p) => p.type === 'STAR' && p.star).map((p) => ({ procedure: p, star: p.star! }));
}

/** A STAR by identifier ("ROZZE2"), spoken name ("ROZZE TWO") or procedure id; the airport's only STAR when `ident` is undefined. */
export function findStar(airport: Pick<Airport, 'procedures'>, ident?: string): StarRef | undefined {
  const all = airportStars(airport);
  if (!ident) return all.length === 1 ? all[0] : undefined;
  const k = norm(ident);
  return all.find((s) => norm(s.star.ident) === k || norm(s.star.spokenName) === k || s.procedure.id === ident);
}

const sameFix = (airport: Airport, a: string, b: string): boolean => (findNavFix(airport, a)?.id ?? a).toUpperCase() === (findNavFix(airport, b)?.id ?? b).toUpperCase();

/** Every fix a STAR can fly (transitions, runway legs, joins), identifiers upper-case. */
export function starFixSet(star: StarProcedure): Set<string> {
  return new Set([
    ...star.transitions.flatMap((t) => t.fixes),
    ...star.runways.flatMap((r) => [...r.fixes, ...(r.joinApproachFixes ?? [])]),
  ].map((f) => f.toUpperCase()));
}

/** The runway leg for an end (accepts "6" / "06"). */
export function starRunwayLeg(star: StarProcedure, runwayEnd: string | undefined): StarProcedure['runways'][number] | undefined {
  if (!runwayEnd) return undefined;
  const e = String(parseInt(runwayEnd, 10)) + runwayEnd.replace(/^\d+/, '');
  return star.runways.find((r) => r.runwayEnd.toUpperCase() === e.toUpperCase());
}

/**
 * The fixes an aircraft flies from `from` (a transition entry fix, e.g. CRIBB, or any fix on a transition, e.g. FLYZZ) to the end of the
 * runway leg plus the approach join fixes. `transition` restricts the search to one transition. Undefined: the fix is not on the STAR
 * or the runway has no leg.
 */
export function starRouteFrom(airport: Airport, ref: StarRef, from: string, runwayEnd: string, transition?: string): { fixes: string[]; transition: string } | undefined {
  const leg = starRunwayLeg(ref.star, runwayEnd);
  if (!leg) return undefined;
  const trans = ref.star.transitions.filter((t) => !transition || norm(t.name) === norm(transition));
  for (const t of trans) {
    const i = t.fixes.findIndex((f) => sameFix(airport, f, from));
    if (i < 0) continue;
    const common = t.fixes[t.fixes.length - 1]; // every transition ends at the common fix (ROZZE)
    const runwayPart = leg.fixes[0] && sameFix(airport, leg.fixes[0], common) ? leg.fixes.slice(1) : leg.fixes;
    return { fixes: [...t.fixes.slice(i), ...runwayPart, ...(leg.joinApproachFixes ?? [])], transition: t.name };
  }
  // the common fix itself or a fix on the runway leg: join the runway part directly
  const j = leg.fixes.findIndex((f) => sameFix(airport, f, from));
  if (j >= 0) return { fixes: [...leg.fixes.slice(j), ...(leg.joinApproachFixes ?? [])], transition: '' };
  return undefined;
}

export interface StarProfileEntry { fix: string; minAltitudeFt?: number; maxAltitudeFt?: number; mandatoryAltitudeFt?: number; speedKt?: number }

/** The restrictions in the profile form `flightDynamics.profileAltitude` flies (min = at or above, max = at or below, mandatory = at). */
export function starProfile(star: StarProcedure): StarProfileEntry[] {
  return star.restrictions.map((r) => ({
    fix: r.fix.toUpperCase(),
    ...(r.atOrAboveFt !== undefined ? { minAltitudeFt: r.atOrAboveFt } : {}),
    ...(r.atOrBelowFt !== undefined ? { maxAltitudeFt: r.atOrBelowFt } : {}),
    ...(r.atFt !== undefined ? { mandatoryAltitudeFt: r.atFt } : {}),
    ...(r.speedKt !== undefined ? { speedKt: r.speedKt } : {}),
  }));
}

/** The lowest altitude a "descend via" will take the aircraft to over the remaining fixes: the lowest at / at-or-above altitude (undefined: none). */
export function starBottomAltitudeFt(star: StarProcedure, remaining: readonly string[]): number | undefined {
  const rem = new Set(remaining.map((f) => f.toUpperCase()));
  let low: number | undefined;
  for (const r of star.restrictions) {
    if (!rem.has(r.fix.toUpperCase())) continue;
    const a = r.atFt ?? r.atOrAboveFt;
    if (a !== undefined && (low === undefined || a < low)) low = a;
  }
  return low;
}

/** True when the aircraft is flying a STAR route right now (its navigation is the route / direct over fixes of the procedure). */
export function onStarRoute(ac: Pick<Aircraft, 'star' | 'nav'>): boolean {
  return !!ac.star && !!ac.nav && (ac.nav.mode === 'route' || ac.nav.mode === 'direct') && ac.nav.index < ac.nav.fixes.length;
}

/**
 * The aircraft on a STAR route has not yet crossed the last fix of the runway leg (the IAF of the expected approach): its next fix is that fix or an
 * earlier one. Once the IAF is crossed (the next fix is a join fix after it) the arrival is complete for the Approach controller, who then clears the approach.
 */
export function starBeforeIaf(airport: Airport, ac: Pick<Aircraft, 'star' | 'nav'>): boolean {
  if (!ac.star || !ac.nav) return false;
  const ref = findStar(airport, ac.star.procedureId);
  const leg = ref ? starRunwayLeg(ref.star, ac.star.runwayEnd) : undefined;
  if (!leg) return false;
  // "then on heading N, expect radar vectors": the procedure is flown to its end (the route ends, the pilot takes the heading)
  if (leg.thenHeadingMagDeg !== undefined) return true;
  const iaf = leg.fixes[leg.fixes.length - 1];
  const idx = ac.nav.fixes.findIndex((f) => sameFix(airport, f, iaf));
  return idx >= 0 && ac.nav.index <= idx;
}
