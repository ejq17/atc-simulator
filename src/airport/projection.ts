/**
 * Geographic <-> local-metre conversion for the simulation frame.
 *
 * Local frame: x = metres EAST, y = metres NORTH of the airport reference
 * point (ARP). Equirectangular (plate carree) about the ARP latitude: longitude
 * differences are scaled by cos(lat0). The per-degree metre scales are the
 * WGS84 ellipsoid values at the ARP latitude (meridional / prime-vertical radii
 * of curvature), which keeps distances within ~0.05% over the few km of an
 * airport (a spherical R=6371 km would be ~0.2% off in one axis).
 *
 * Headings: the sim stores TRUE headings; controllers speak MAGNETIC.
 * `variationDeg` is EAST-POSITIVE (KACY NASR variation is 10 W => -10), so
 *   magnetic = true - variation        true = magnetic + variation
 * and for KACY a true heading of 118 is magnetic 128.
 */
import type { LatLon, Vec2 } from '../sim/types';

const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;

export interface Projection {
  /** WGS84 degrees -> local metres east/north of the ARP. */
  toLocal(latLon: LatLon): Vec2;
  /** Local metres -> WGS84 degrees. */
  toLatLon(vec: Vec2): LatLon;
  readonly origin: LatLon;
  /** Metres per degree of latitude / longitude at the ARP (for diagnostics). */
  readonly metresPerDegLat: number;
  readonly metresPerDegLon: number;
}

export function createProjection(arp: LatLon): Projection {
  const phi = (arp.lat * Math.PI) / 180;
  const sin = Math.sin(phi);
  const w = Math.sqrt(1 - WGS84_E2 * sin * sin);
  const meridionalRadius = (WGS84_A * (1 - WGS84_E2)) / (w * w * w);
  const primeVerticalRadius = WGS84_A / w;
  const metresPerDegLat = (meridionalRadius * Math.PI) / 180;
  const metresPerDegLon = (primeVerticalRadius * Math.cos(phi) * Math.PI) / 180; // == R_N * cos(lat0)
  const origin: LatLon = { lat: arp.lat, lon: arp.lon };
  return {
    origin,
    metresPerDegLat,
    metresPerDegLon,
    toLocal(p: LatLon): Vec2 {
      return { x: (p.lon - origin.lon) * metresPerDegLon, y: (p.lat - origin.lat) * metresPerDegLat };
    },
    toLatLon(v: Vec2): LatLon {
      return { lat: origin.lat + v.y / metresPerDegLat, lon: origin.lon + v.x / metresPerDegLon };
    },
  };
}

/** Normalise an angle to [0, 360). */
export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** True -> magnetic. `variationDeg` is east-positive (KACY: -10). */
export function trueToMagnetic(trueDeg: number, variationDeg: number): number {
  return normalizeDeg(trueDeg - variationDeg);
}

/** Magnetic -> true. `variationDeg` is east-positive (KACY: -10). */
export function magneticToTrue(magneticDeg: number, variationDeg: number): number {
  return normalizeDeg(magneticDeg + variationDeg);
}

/** Compass bearing (degrees TRUE, 0 = north, clockwise) of a local-frame vector. */
export function bearingDeg(dx: number, dy: number): number {
  return normalizeDeg((Math.atan2(dx, dy) * 180) / Math.PI);
}

/** Smallest absolute difference between two headings, 0..180. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(normalizeDeg(a) - normalizeDeg(b)) % 360;
  return d > 180 ? 360 - d : d;
}
