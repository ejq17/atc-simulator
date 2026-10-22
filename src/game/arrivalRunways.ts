/**
 * Which landing runway ends an arrival may be given (shared by the traffic generator and the free-play opening population, so both apply the same rule).
 *
 * The aircraft's landing distance must fit the end's declared landing distance available; when IFR flows are on an airliner prefers the ends that have an
 * arrival procedure (a STAR for a turbojet, else an approach); the arrival slot (the generator's flow control) is applied by the caller.
 */
import type { Airport } from '../sim/types';
import { findRunwayEnd } from '../sim/runways';
import { getPerformance } from '../sim/performance';
import { arrivalProcedure, isTurbojet, starArrival } from './ifr';

/** The ends of `ends` an arrival of `type` can use: long enough first, then (airliner, IFR arrival flow) those with a procedure. Never empty when `ends` is not. */
export function landingEndPool(airport: Airport, ends: readonly string[], type: string, ga: boolean, ifrArrivals: boolean): string[] {
  if (ends.length <= 1) return [...ends];
  const ldaOk = (e: string): boolean => {
    const g = findRunwayEnd(airport, e);
    return !g || getPerformance(type).landingDistanceFt <= g.ldaM / 0.3048;
  };
  const long = ends.filter(ldaOk);
  const base = long.length ? long : [...ends];
  const withApproach = !ga && ifrArrivals ? base.filter((e) => (isTurbojet(type) && starArrival(airport, e)) || arrivalProcedure(airport, e)) : [];
  return withApproach.length ? withApproach : base;
}
