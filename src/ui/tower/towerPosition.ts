/**
 * Where the tower cab is. Order of preference, and the source is reported so the UI/docs can say which was used:
 *   1. an Airport building whose name looks like a tower (generic: other airports' data may carry one);
 *   2. FALLBACK: the largest terminal building's footprint centroid, because the KACY OSM extract has no control tower feature
 *      (no aeroway=control_tower, no man_made=tower, and no building named like a tower; checked in data/sources/raw/overpass_kacy_raw.json);
 *   3. FALLBACK of last resort: the airport reference point.
 */
import type { Airport, Vec2 } from '../../sim/types';
import { polygonCentroid } from '../lib/geom';
import { signedArea } from './geometry';

export type TowerSource = 'named-building' | 'terminal-fallback' | 'arp-fallback';

export interface TowerSite { pos: Vec2; source: TowerSource; note: string }

/** Cab eye height above the ground at the tower base (m). Assumption: FAA ATCT cabs are roughly 15-35 m up; 30 m (about 100 ft) is a mid-size cab. */
export const CAB_EYE_HEIGHT_M = 30;

interface BuildingLike { kind?: string; name?: string; polygon: Vec2[] }

export function resolveTowerSite(airport: Airport): TowerSite {
  const buildings = ((airport as unknown as { buildings?: BuildingLike[] }).buildings ?? []).filter((b) => b.polygon && b.polygon.length >= 3);
  const named = buildings.find((b) => /\b(tower|atct)\b/i.test(b.name ?? ''));
  if (named) return { pos: polygonCentroid(named.polygon), source: 'named-building', note: `building "${named.name}"` };
  const terminals = buildings.filter((b) => b.kind === 'terminal').sort((a, b) => Math.abs(signedArea(b.polygon)) - Math.abs(signedArea(a.polygon)));
  if (terminals.length) return { pos: polygonCentroid(terminals[0].polygon), source: 'terminal-fallback', note: `centroid of terminal "${terminals[0].name ?? 'terminal'}" (no tower in the airport data)` };
  return { pos: { x: 0, y: 0 }, source: 'arp-fallback', note: 'airport reference point (no tower or terminal in the airport data)' };
}
