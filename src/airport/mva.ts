/**
 * Minimum vectoring altitude lookup. Sectors come from the FAA MVA digital product
 * (see KacyAirport.mvaSectors). A sector's `polygon` is its OUTER ring; `holes` are inner
 * rings (areas inside it that belong to other sectors) and are excluded from containment.
 */
import type { Airport, Vec2 } from '../sim/types';
import type { KacyMvaSector } from './types';

function inRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The sector containing `pos` (local metres), or undefined outside every published sector. */
export function mvaSectorAt(airport: Pick<Airport, 'mvaSectors'>, pos: Vec2): KacyMvaSector | undefined {
  const sectors = (airport.mvaSectors ?? []) as KacyMvaSector[];
  const hits = sectors.filter((s) => inRing(pos, s.polygon) && !(s.holes ?? []).some((h) => inRing(pos, h)));
  // On shared borders more than one may match; the highest altitude is the safe answer.
  return hits.sort((a, b) => b.altitudeFt - a.altitudeFt)[0];
}

/** Minimum vectoring altitude (ft MSL) at a point, or undefined if no sector covers it. */
export function mvaAltitudeAt(airport: Pick<Airport, 'mvaSectors'>, pos: Vec2): number | undefined {
  return mvaSectorAt(airport, pos)?.altitudeFt;
}
