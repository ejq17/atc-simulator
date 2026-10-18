/**
 * Runway configuration helpers shared by the store and the session: the wind-based recommendation (best headwind end, calm-wind rule, operator
 * preference order) with closed runways excluded (JO 7110.65 3-3-2: a closed runway is never assigned).
 */
import type { Airport, Weather } from '../../sim/types';
import { loadKacy } from '../../airport';
import { preferredEndOrder, recommendRunways } from '../../weather/runwaySelection';

/** Runway configuration recommended for a weather snapshot (best headwind end, used for both arrivals and departures). */
export function recommendedRunways(weather: Weather, airport: Pick<Airport, 'icao' | 'runways' | 'magneticVariationDeg'> = loadKacy(), closedEnds: readonly string[] = []): { departing: string[]; landing: string[]; summary: string } {
  const ends = airport.runways.flatMap((r) => r.ends.map((e) => ({ id: e.id, magneticHeadingDeg: e.magneticHeadingDeg })));
  const rec = recommendRunways(weather, ends, { preferredOrder: preferredEndOrder(airport, 'high'), variationDeg: airport.magneticVariationDeg, excludeEnds: closedEnds });
  const top = rec.ranking.find((r) => r.id === rec.primary);
  const summary = rec.calmWindRule
    ? `Wind calm or light: preferred runway ${rec.primary}`
    : `Runway ${rec.primary}: headwind ${Math.round(top?.headwindKt ?? 0)} kt, crosswind ${Math.round(Math.abs(top?.crosswindKt ?? 0))} kt`;
  return { departing: [rec.primary], landing: [rec.primary], summary };
}

/**
 * Live wind -> runway configuration, with the existing selection rules (best headwind, KACY preference order, calm-wind rule). To avoid flapping
 * on every METAR it only proposes a change when the runway now in use is no longer among the best ends AND (the wind is not calm OR the
 * current runway has a tailwind).
 */
export function runwayChangeForWind(weather: Weather, current: { landing: string[]; departing: string[] }, airport: Pick<Airport, 'icao' | 'runways' | 'magneticVariationDeg'> = loadKacy(), closedEnds: readonly string[] = []): { departing: string[]; landing: string[]; summary: string } | undefined {
  const ends = airport.runways.flatMap((r) => r.ends.map((e) => ({ id: e.id, magneticHeadingDeg: e.magneticHeadingDeg })));
  const rec = recommendRunways(weather, ends, { preferredOrder: preferredEndOrder(airport, 'high'), variationDeg: airport.magneticVariationDeg, excludeEnds: closedEnds });
  const inUse = current.landing[0] ?? current.departing[0];
  if (!inUse) return undefined;
  // the runway in use is closed (NOTAM): the best open runway replaces it whatever the wind
  const inUseClosed = closedEnds.some((e) => e.toUpperCase() === inUse.toUpperCase());
  if (inUseClosed) return { departing: [rec.primary], landing: [rec.primary], summary: `runway ${inUse} closed` };
  if (rec.best.includes(inUse)) return undefined;
  const cur = rec.ranking.find((r) => r.id === inUse);
  if (rec.calmWindRule && (cur?.headwindKt ?? 0) >= 0) return undefined;
  const top = rec.ranking.find((r) => r.id === rec.primary);
  const summary = `wind ${Math.round(top?.headwindKt ?? 0)} kt headwind on ${rec.primary}`;
  return { departing: [rec.primary], landing: [rec.primary], summary };
}
