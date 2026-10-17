/**
 * Pure sky, light and weather mapping for the Tower view: sun direction from the sim's UTC (elevation from src/sim/solar.ts),
 * sky/horizon colours and light levels by sun elevation, fog from visibility, and an overcast layer from the cloud ceiling.
 */
import type { LatLon, Weather } from '../../sim/types';
import { solarElevationDeg } from '../../sim/solar';

export type RGB = [number, number, number];

export interface SunPosition { azimuthDeg: number; elevationDeg: number }

const RAD = Math.PI / 180;

/**
 * Sun azimuth (TRUE, clockwise from north) and elevation. Elevation is `solarElevationDeg` (the sim's NOAA implementation, so day/night here
 * agrees with the LAHSO daylight rules); azimuth uses the same geometry with a low-order declination and equation of time (error under ~1 degree).
 */
export function sunPosition(at: LatLon, utcMs: number): SunPosition {
  const elevationDeg = solarElevationDeg(at, utcMs);
  const d = new Date(utcMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((utcMs - start) / 86400000);
  const decl = -23.44 * RAD * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const B = (2 * Math.PI / 364) * (dayOfYear - 81);
  const eqMin = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const solarHours = utcHours + at.lon / 15 + eqMin / 60;
  const hourAngle = (((solarHours - 12) * 15 + 540) % 360 - 180) * RAD; // negative in the morning
  const lat = at.lat * RAD;
  const h = elevationDeg * RAD;
  const cosA = (Math.sin(decl) - Math.sin(h) * Math.sin(lat)) / (Math.cos(h) * Math.cos(lat) || 1e-9);
  let az = Math.acos(Math.max(-1, Math.min(1, cosA))) / RAD;
  if (hourAngle > 0) az = 360 - az;
  return { azimuthDeg: ((az % 360) + 360) % 360, elevationDeg };
}

/** Unit vector toward the sun in scene coordinates (x east, y up, z = -north). */
export function sunVector(s: SunPosition): [number, number, number] {
  const a = s.azimuthDeg * RAD;
  const e = s.elevationDeg * RAD;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
export const toHex = (c: RGB): number => (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);

interface SkyKey { elev: number; top: RGB; horizon: RGB; ground: RGB; sun: number; ambient: number }

/** Keyframes by solar elevation: night, astronomical/nautical twilight, civil twilight, sunrise/sunset, golden hour, day. */
const KEYS: SkyKey[] = [
  { elev: -18, top: hex(0x03050b), horizon: hex(0x0b1222), ground: hex(0x0a0f0b), sun: 0, ambient: 0.62 },
  { elev: -9, top: hex(0x0a1226), horizon: hex(0x2a2f4a), ground: hex(0x141a14), sun: 0, ambient: 0.68 },
  { elev: -3, top: hex(0x1b2c52), horizon: hex(0x8a5a62), ground: hex(0x2a3022), sun: 0.1, ambient: 0.62 },
  { elev: 0, top: hex(0x3a5a92), horizon: hex(0xe39a62), ground: hex(0x4a5330), sun: 0.45, ambient: 0.75 },
  { elev: 8, top: hex(0x5b8ccc), horizon: hex(0xd9c8a8), ground: hex(0x58653a), sun: 0.85, ambient: 0.85 },
  { elev: 35, top: hex(0x3f7bc4), horizon: hex(0xaecfec), ground: hex(0x5f6e3d), sun: 1, ambient: 0.9 },
];

export interface SkyState {
  top: RGB;
  horizon: RGB;
  ground: RGB;
  /** Directional (sun) intensity 0..1. */
  sunIntensity: number;
  /** Hemisphere/ambient intensity 0..1 (never zero: night must stay legible). */
  ambient: number;
  /** 0 in full day .. 1 in full night: drives pavement lights, window glow, landing lights. */
  night: number;
}

export function skyState(sunElevationDeg: number, cloudiness = 0): SkyState {
  const e = Math.max(KEYS[0].elev, Math.min(KEYS[KEYS.length - 1].elev, sunElevationDeg));
  let i = 0;
  while (i < KEYS.length - 2 && e > KEYS[i + 1].elev) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = (e - a.elev) / (b.elev - a.elev);
  let top = mix(a.top, b.top, t);
  let horizon = mix(a.horizon, b.horizon, t);
  let ground = mix(a.ground, b.ground, t);
  let sun = a.sun + (b.sun - a.sun) * t;
  const ambient = a.ambient + (b.ambient - a.ambient) * t;
  // Overcast: skies go grey and darker, the sun is diffused.
  const c = Math.max(0, Math.min(1, cloudiness));
  const grey = (col: RGB, level: number): RGB => {
    const l = (col[0] + col[1] + col[2]) / 3;
    return mix(col, [l * level, l * level, l * level], 0.65 * c);
  };
  top = grey(top, 0.85);
  horizon = grey(horizon, 0.95);
  ground = grey(ground, 0.9);
  sun *= 1 - 0.7 * c;
  const night = Math.max(0, Math.min(1, (3 - sunElevationDeg) / 9)); // 0 above +3 degrees, 1 below -6 degrees
  return { top, horizon, ground, sunIntensity: sun, ambient, night };
}

/** Meteorological visibility to exponential-squared fog density (5% contrast at the visibility distance: sqrt(-ln 0.05) = 1.7308). */
export function fogDensityFromVisibility(visibilitySm: number): number {
  const metres = Math.max(100, visibilitySm * 1609.344);
  return 1.7308 / metres;
}

const COVER_FRACTION: Record<string, number> = { SKC: 0, CLR: 0, FEW: 0.2, SCT: 0.45, BKN: 0.8, OVC: 1, VV: 1 };

/** Overall cloudiness 0..1 (the largest layer cover). */
export function cloudiness(w: Pick<Weather, 'clouds'>): number {
  return w.clouds.reduce((m, c) => Math.max(m, COVER_FRACTION[c.cover] ?? 0), 0);
}

/** Lowest BKN/OVC/VV base (ft AGL), the ceiling; undefined when there is none. */
export function ceilingFtAgl(w: Pick<Weather, 'clouds'>): number | undefined {
  const bases = w.clouds.filter((c) => c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'VV').map((c) => c.baseFtAgl);
  return bases.length ? Math.min(...bases) : undefined;
}

export interface CloudDeck { baseM: number; opacity: number }

/**
 * A simple overcast plane when the ceiling is low enough to matter to a tower controller (the deck is drawn up to 8,000 ft; higher
 * ceilings are just a greyer sky). Opacity from cover: BKN 0.8, OVC/VV 1.
 */
export function cloudDeck(w: Pick<Weather, 'clouds'>): CloudDeck | undefined {
  const ceil = ceilingFtAgl(w);
  if (ceil === undefined || ceil > 8000) return undefined;
  const layer = w.clouds.filter((c) => c.baseFtAgl === ceil).sort((x, y) => (COVER_FRACTION[y.cover] ?? 0) - (COVER_FRACTION[x.cover] ?? 0))[0];
  return { baseM: ceil * 0.3048, opacity: layer ? COVER_FRACTION[layer.cover] ?? 0.8 : 0.8 };
}
