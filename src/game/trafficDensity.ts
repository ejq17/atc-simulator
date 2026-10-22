/**
 * Traffic density by local time of day (real-time mode).
 *
 * The scenario's hourly rates describe the busiest banks; in real-time mode they are scaled by this curve of the airport's LOCAL
 * hour (the airport's IANA zone, default America/New_York, so daylight saving is handled by Intl). Piecewise-linear between key points, 1.0 at the peaks:
 *
 *   00:00-05:00  0.10   overnight, very quiet
 *   05:00-07:30  ramps up to 1.00   morning bank, 07:30
 *   09:00        0.85
 *   10:30-15:00  0.65   midday
 *   16:30        1.00   evening bank (19:00 at 0.90)
 *   21:00        0.50
 *   23:00        0.25
 *   24:00        0.10
 *
 * Pure and deterministic: the same instant always gives the same factor. The generator applies it by thinning (traffic.ts).
 */
import type { SimulationState } from '../sim/types';
import { simUtcMs } from '../sim/solar';

/** Zone of an airport without `Airport.timeZone` (KACY and KMHT). Other airports carry their own IANA zone in the airport data. */
export const AIRPORT_TIME_ZONE = 'America/New_York';

/** IANA time zone of an airport (`Airport.timeZone`), default America/New_York. */
export function airportTimeZone(airport: { timeZone?: string }): string {
  return airport.timeZone ?? AIRPORT_TIME_ZONE;
}

/** [local hour, density] key points, hour 0..24. */
export const DENSITY_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.1], [5, 0.1], [7.5, 1.0], [9, 0.85], [10.5, 0.65], [15, 0.65], [16.5, 1.0], [19, 0.9], [21, 0.5], [23, 0.25], [24, 0.1],
];

/** Density factor 0..1 for a local hour (fractional; values outside 0..24 wrap). */
export function trafficDensityForLocalHour(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 1; i < DENSITY_CURVE.length; i++) {
    const [h1, d1] = DENSITY_CURVE[i];
    if (h <= h1) {
      const [h0, d0] = DENSITY_CURVE[i - 1];
      return d0 + ((d1 - d0) * (h - h0)) / (h1 - h0);
    }
  }
  return DENSITY_CURVE[DENSITY_CURVE.length - 1][1];
}

/** Fractional local hour at a UTC instant in a time zone. */
export function localHourAt(utcMs: number, timeZone: string = AIRPORT_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get('hour') % 24) + get('minute') / 60 + get('second') / 3600;
}

export function trafficDensityAt(utcMs: number, timeZone?: string): number {
  return trafficDensityForLocalHour(localHourAt(utcMs, timeZone));
}

/** `densityAt` for the traffic generator: follows the simulation's UTC epoch, i.e. the real clock in real-time mode. */
export function realTimeDensity(state: Readonly<SimulationState>): number {
  return trafficDensityAt(simUtcMs(state), airportTimeZone(state.airport));
}
