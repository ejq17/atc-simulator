/**
 * Minimum vectoring altitude (JO 7110.65 5-6-1): vectors and altitude assignments to IFR aircraft keep them "at or above the MVA".
 * Sectors come from `Airport.mvaSectors` (FAA MVA product). The engine is airport-agnostic, so a sector's optional `holes`
 * (inner rings where other sectors sit; the airport package adds them) are duck-typed: a point inside a hole is NOT in that sector.
 * Where several sectors still contain a point (nested synthetic sectors) the smallest one wins; equal areas take the higher altitude.
 */
import type { Aircraft, Airport, Vec2 } from './types';
import { headingToVec, nmToM } from './geo';

type Sector = NonNullable<Airport['mvaSectors']>[number] & { holes?: Vec2[][] };

function inRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function ringArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  return Math.abs(a) / 2;
}

/** The sector covering `pos` (local metres), or undefined outside every published sector. */
export function mvaSectorAt(airport: Pick<Airport, 'mvaSectors'>, pos: Vec2): { id: string; altitudeFt: number } | undefined {
  const sectors = (airport.mvaSectors ?? []) as Sector[];
  let best: Sector | undefined;
  let bestArea = Infinity;
  for (const s of sectors) {
    if (!inRing(pos, s.polygon) || (s.holes ?? []).some((h) => inRing(pos, h))) continue;
    const area = ringArea(s.polygon) - (s.holes ?? []).reduce((sum, h) => sum + ringArea(h), 0);
    if (area < bestArea - 1e-6 || (Math.abs(area - bestArea) <= 1e-6 && best && s.altitudeFt > best.altitudeFt)) {
      best = s;
      bestArea = area;
    }
  }
  return best && { id: best.id, altitudeFt: best.altitudeFt };
}

/** Minimum vectoring altitude (ft MSL) at a point, or undefined where no sector is published. */
export function mvaAltitudeAt(airport: Pick<Airport, 'mvaSectors'>, pos: Vec2): number | undefined {
  return mvaSectorAt(airport, pos)?.altitudeFt;
}

export const MVA_LOOKAHEAD_NM = 2;
const MVA_SAMPLE_NM = 0.25;

/** The highest MVA over the aircraft's position and the next `MVA_LOOKAHEAD_NM` along `trackTrueDeg` (its sector now, and sectors it enters). */
export function highestMvaAhead(airport: Pick<Airport, 'mvaSectors'>, pos: Vec2, trackTrueDeg: number): { altitudeFt: number; sectorId: string } | undefined {
  let worst: { altitudeFt: number; sectorId: string } | undefined;
  const dir = headingToVec(trackTrueDeg);
  for (let d = 0; d <= MVA_LOOKAHEAD_NM + 1e-9; d += MVA_SAMPLE_NM) {
    const q = { x: pos.x + dir.x * nmToM(d), y: pos.y + dir.y * nmToM(d) };
    const s = mvaSectorAt(airport, q);
    if (s && (!worst || s.altitudeFt > worst.altitudeFt)) worst = { altitudeFt: s.altitudeFt, sectorId: s.id };
  }
  return worst;
}

/**
 * Exempt from the MVA check: not IFR; on the ground; on a published procedure segment (an approach being flown on its fixes (after the vectors-to-final
 * capture) / final / the published missed approach and holding pattern); a radar departure still in its initial climb (5-6-1: "except as
 * authorized for radar approaches, radar departures, special VFR, VFR operations, or by paragraph 5-6-3").
 */
export function mvaExempt(ac: Aircraft): boolean {
  if (ac.flightRules !== 'IFR' || ac.onGround) return true;
  if (ac.phase === 'INITIAL_CLIMB' || ac.phase === 'FINAL' || ac.phase === 'LANDING' || ac.phase === 'ROLLOUT') return true;
  const mode = ac.nav?.mode;
  if (mode === 'approach' || mode === 'missed' || mode === 'holding') return true;
  return false;
}
