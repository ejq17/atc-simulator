/**
 * The real ATIS cycle (FAA JO 7110.65 2-9-2): a new information letter is recorded about five minutes before every hour (with the routine hourly
 * METAR, KACY and KMHT observe at :54) "upon receipt of any new official weather regardless of whether there is or is not a change in values", and
 * again, out of cycle, when something material changes: wind, altimeter, categories, runway or approach in use, new or canceled NOTAMs, braking action
 * reported worse than in the broadcast (`atisUpdateReasons` in atis.ts).
 *
 *  - Simulated weather has no observation time: the hourly HH:55Z slot below stands for the routine hourly observation (real-time mode).
 *  - Live weather carries the real observation time: a new routine hourly METAR or SPECI is a new observation (`weather/observation.ts`,
 *    `atisUpdateReasons` reason "new weather observation") and makes a new letter even with identical values. The session does not also run the
 *    HH:55Z slot for live weather, so one observation never makes two letters.
 * Letters advance A..Z and wrap.
 */
import { nextAtisLetter } from './atis';

/** Minute of the hour at which the routine hourly ATIS is recorded (HH:55). */
export const ATIS_HOURLY_MINUTE = 55;

/** Hourly ATIS "slot" of a UTC instant: increments at every HH:55Z. */
export function atisSlot(utcMs: number): number {
  return Math.floor((utcMs + (60 - ATIS_HOURLY_MINUTE) * 60000) / 3600000);
}

/** Letter in force at session start. Slots map onto A..X (24 per day), so the same clock time gives the same letter. */
export function initialAtisLetter(utcMs: number): string {
  return String.fromCharCode(65 + (((atisSlot(utcMs) % 24) + 24) % 24));
}

/** Pure decision for the session loop: has the hourly cycle moved on since `lastSlot`? Returns the new slot and letter if so. */
export function hourlyAtisAdvance(lastSlot: number, utcMs: number, currentLetter: string): { slot: number; letter: string } | undefined {
  const slot = atisSlot(utcMs);
  if (slot === lastSlot) return undefined;
  return { slot, letter: nextAtisLetter(currentLetter) };
}

/**
 * Whether the HH:55Z slot makes a letter for this weather. Live weather has real observation times: its routine hourly METAR / SPECI makes the letter
 * (`isNewObservation`, atis.ts), so the clock adds none (one observation, one letter). Simulated weather has no observation time and uses the slot.
 */
export function hourlySlotApplies(weather: { source: 'simulated' | 'live' }): boolean {
  return weather.source !== 'live';
}
