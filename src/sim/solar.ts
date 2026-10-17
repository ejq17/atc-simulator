/**
 * Sunrise / sunset from the NOAA solar position algorithm (the "General Solar Position Calculations" spreadsheet formulas):
 * Julian century -> mean longitude / anomaly -> equation of the centre -> apparent longitude -> declination and equation of time,
 * then the hour angle for the official zenith of 90.833 degrees (refraction + the Sun's semi-diameter). Accuracy about a minute at
 * mid latitudes, ample for "between sunrise and sunset" (JO 7110.65 3-10-3, JO 7110.118 daytime LAHSO).
 *
 * The simulation clock is relative; the wall-clock epoch of scenario time 0 is `EngineOptionsExt.utcStartMs`
 * (registered per state here so the pure safety functions can ask "is it daylight now?"). Default: the real time at engine creation.
 */
import type { LatLon, SimulationState } from './types';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
export const OFFICIAL_ZENITH_DEG = 90.833;

const epochByState = new WeakMap<object, number>();

export function setSimulationEpoch(state: SimulationState, utcStartMs: number): void {
  epochByState.set(state, utcStartMs);
}

/** Wall-clock UTC (ms) of the current simulation time. */
export function simUtcMs(state: Pick<SimulationState, 'clock'>): number {
  const base = epochByState.get(state);
  return (base ?? 0) + state.clock.timeSec * 1000;
}

interface SolarTerms { declRad: number; eqTimeMin: number }

function solarTerms(utcMs: number): SolarTerms {
  const jd = utcMs / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eq =
    4 * DEG * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD) + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
  return { declRad: decl, eqTimeMin: eq };
}

/** Solar elevation (degrees, no refraction) at a place and time. */
export function solarElevationDeg(at: LatLon, utcMs: number): number {
  const { declRad, eqTimeMin } = solarTerms(utcMs);
  const d = new Date(utcMs);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60000;
  const trueSolarMin = (minutes + eqTimeMin + 4 * at.lon + 1440 * 4) % 1440;
  const hourAngle = (trueSolarMin / 4 < 0 ? trueSolarMin / 4 + 180 : trueSolarMin / 4 - 180) * RAD;
  const lat = at.lat * RAD;
  const cosZ = Math.sin(lat) * Math.sin(declRad) + Math.cos(lat) * Math.cos(declRad) * Math.cos(hourAngle);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) * DEG;
}

/** Sunrise and sunset (UTC ms) of the UTC calendar day containing `utcMs` that fall at the place's solar day; undefined in polar day / night. */
export function sunriseSunsetUtc(at: LatLon, utcMs: number): { sunriseMs: number; sunsetMs: number } | undefined {
  const dayStart = Math.floor(utcMs / 86400000) * 86400000;
  const noonLocalGuess = dayStart + (12 - at.lon / 15) * 3600000; // local solar noon, roughly
  const ev = (rise: boolean): number | undefined => {
    let t = noonLocalGuess + (rise ? -6 : 6) * 3600000;
    for (let i = 0; i < 4; i++) {
      const { declRad, eqTimeMin } = solarTerms(t);
      const lat = at.lat * RAD;
      const cosH = Math.cos(OFFICIAL_ZENITH_DEG * RAD) / (Math.cos(lat) * Math.cos(declRad)) - Math.tan(lat) * Math.tan(declRad);
      if (cosH > 1 || cosH < -1) return undefined;
      const H = Math.acos(cosH) * DEG;
      const minutesUtc = 720 - 4 * (at.lon + (rise ? H : -H)) - eqTimeMin;
      t = dayStart + minutesUtc * 60000;
    }
    return t;
  };
  const sunriseMs = ev(true);
  const sunsetMs = ev(false);
  return sunriseMs !== undefined && sunsetMs !== undefined ? { sunriseMs, sunsetMs } : undefined;
}

/** Is it between sunrise and sunset (centre of the Sun above -0.833 degrees)? */
export function isDaylight(at: LatLon, utcMs: number): boolean {
  return solarElevationDeg(at, utcMs) > 90 - OFFICIAL_ZENITH_DEG;
}
