/**
 * Airport data module: projection helpers, graph queries and the airport registry.
 * Add further airports by registering a loader in `AIRPORTS` below.
 */
import type { Airport } from '../sim/types';
import { loadKacy } from './kacy';
import { loadKmht } from './kmht';
import { loadKbos } from './kbos';
import { loadKpgd } from './kpgd';
import { loadKphl } from './kphl';
import { loadEgll } from './egll';

export { loadKacy } from './kacy';
export { loadKmht } from './kmht';
export { loadKbos } from './kbos';
export { loadKpgd } from './kpgd';
export { loadKphl } from './kphl';
export { loadEgll } from './egll';
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

const AIRPORTS: Record<string, () => Airport> = {
  KACY: loadKacy,
  KMHT: loadKmht,
  KBOS: loadKbos,
  KPHL: loadKphl,
  KPGD: loadKpgd,
  EGLL: loadEgll,
};

/** The airport used when none is chosen. */
export const DEFAULT_AIRPORT_ICAO = 'KACY';

/** Airport by ICAO code (case-insensitive); the FAA id ("ACY", "MHT") is accepted too. */
export function getAirport(icao: string): Airport | undefined {
  const key = icao.toUpperCase();
  const loader = AIRPORTS[key] ?? AIRPORTS[`K${key}`];
  return loader?.();
}

export function listAirports(): string[] {
  return Object.keys(AIRPORTS);
}

/** Airport by ICAO code, falling back to the default (KACY) for an unknown or missing code. */
export function airportOrDefault(icao: string | undefined): Airport {
  return getAirport(icao ?? DEFAULT_AIRPORT_ICAO) ?? getAirport(DEFAULT_AIRPORT_ICAO)!;
}
