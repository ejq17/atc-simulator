/**
 * Airport data module: projection helpers, graph queries and the airport registry.
 * Add further airports by registering a loader and preload in `AIRPORTS` below (docs/ADDING-AN-AIRPORT.md).
 */
import type { Airport } from '../sim/types';
import { loadKacy, preloadKacy } from './kacy';
import { loadKmht, preloadKmht } from './kmht';
import { loadKbos, preloadKbos } from './kbos';
import { loadKpgd, preloadKpgd } from './kpgd';
import { loadKphl, preloadKphl } from './kphl';
import { loadEgll, preloadEgll } from './egll';

export { loadKacy, preloadKacy } from './kacy';
export { loadKmht, preloadKmht } from './kmht';
export { loadKbos, preloadKbos } from './kbos';
export { loadKpgd, preloadKpgd } from './kpgd';
export { loadKphl, preloadKphl } from './kphl';
export { loadEgll, preloadEgll } from './egll';
export { createProjection, trueToMagnetic, magneticToTrue, normalizeDeg, bearingDeg, angleDiffDeg } from './projection';
export type { Projection } from './projection';
export {
  nearestNode,
  nodesForTaxiway,
  holdingPositionsForRunway,
  runwayEntryNodes,
  runwayExitNodes,
  edgesBetween,
  edgesOfNode,
  findParking,
  isRunwayEdge,
  normalizeRunwayEnd,
  normalizeRunwayId,
} from './graphUtils';
export { mvaSectorAt, mvaAltitudeAt } from './mva';
export type { GraphSource, RunwayExit } from './graphUtils';
export type {
  KacyAirport,
  KacyBuilding,
  KacyMvaSector,
  KacyParking,
  KacyRunway,
  KacyRunwayEnd,
  KacyTaxiEdge,
  KacyTaxiNode,
  KacyTaxiwayGraph,
  LahsoInfo,
} from './types';

/** Required attribution for the OSM-derived taxiway/apron layer (ODbL 1.0). Show it wherever the surface map is displayed. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, ODbL 1.0';

/**
 * Registry: ICAO -> display name (for the selector, which must not need the data), synchronous loader and the async
 * preload that fetches the airport's data chunk. Adding an airport is one import line (above) and one entry here;
 * `name` must equal the JSON's `name` (checked in preload.test.ts).
 */
const AIRPORTS: Record<string, { name: string; load: () => Airport; preload: () => Promise<Airport> }> = {
  KACY: { name: 'Atlantic City International', load: loadKacy, preload: preloadKacy },
  KMHT: { name: 'Manchester Boston Regional', load: loadKmht, preload: preloadKmht },
  KBOS: { name: 'General Edward Lawrence Logan International', load: loadKbos, preload: preloadKbos },
  KPHL: { name: 'Philadelphia International', load: loadKphl, preload: preloadKphl },
  KPGD: { name: 'Punta Gorda', load: loadKpgd, preload: preloadKpgd },
  EGLL: { name: 'Heathrow', load: loadEgll, preload: preloadEgll },
};

function entryFor(icao: string) {
  const key = icao.toUpperCase();
  return AIRPORTS[key] ?? AIRPORTS[`K${key}`];
}

/** The airport used when none is chosen. */
export const DEFAULT_AIRPORT_ICAO = 'KACY';

/** Airport by ICAO code (case-insensitive); the FAA id ("ACY", "MHT") is accepted too. Throws if the airport was not preloaded. */
export function getAirport(icao: string): Airport | undefined {
  return entryFor(icao)?.load();
}

/**
 * Loads an airport's data (one dynamic-import chunk per airport) so the synchronous `getAirport` / `airportOrDefault` work.
 * Idempotent; rejects for an unknown code. `getAirport` throws until this has resolved for that airport.
 */
export async function preloadAirport(icao: string): Promise<Airport> {
  const entry = entryFor(icao);
  if (!entry) throw new Error(`Unknown airport ${icao}`);
  return entry.preload();
}

/** ICAO and display name of every registered airport, available without loading any airport data. */
export function listAirportOptions(): { icao: string; name: string }[] {
  return Object.entries(AIRPORTS).map(([icao, e]) => ({ icao, name: e.name }));
}

/** True once `preloadAirport` has resolved for this airport (false for an unknown code). */
export function isAirportLoaded(icao: string): boolean {
  try {
    return getAirport(icao) !== undefined;
  } catch {
    return false;
  }
}

/** Preloads every registered airport (tests, tools). */
export async function preloadAllAirports(): Promise<void> {
  await Promise.all(Object.values(AIRPORTS).map((e) => e.preload()));
}

export function listAirports(): string[] {
  return Object.keys(AIRPORTS);
}

/** Airport by ICAO code, falling back to the default (KACY) for an unknown or missing code. */
export function airportOrDefault(icao: string | undefined): Airport {
  return getAirport(icao ?? DEFAULT_AIRPORT_ICAO) ?? getAirport(DEFAULT_AIRPORT_ICAO)!;
}
