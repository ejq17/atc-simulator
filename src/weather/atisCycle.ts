/**
 * The real ATIS cycle: a new information letter is recorded about five minutes before every hour (with the routine hourly
 * METAR, KACY observes at :54) and again, out of cycle, when the weather changes materially (`atisNeedsUpdate` in atis.ts).
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
