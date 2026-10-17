/**
 * Aircraft performance tables.
 *
 * NOTE: every number here is a SIMPLIFIED APPROXIMATION chosen to look believable
 * on a radar/surface display. They are NOT certified performance data and must
 * never be used for real flight planning.
 */
import type { AircraftPerformance } from './types';

export const C172: AircraftPerformance = {
  type: 'C172',
  category: 'light',
  wakeCategory: 'light',
  taxiSpeedKt: 15,
  taxiTurnSpeedKt: 8,
  accelKtPerSec: 2.8,
  decelKtPerSec: 3.0,
  rotateSpeedKt: 55,
  climbSpeedKt: 75,
  cruiseSpeedKt: 110,
  approachSpeedKt: 65,
  touchdownSpeedKt: 55,
  climbRateFpm: 700,
  descentRateFpm: 800,
  turnRateDegPerSec: 3,
  groundTurnRateDegPerSec: 40,
  minSpeedKt: 45,
  maxSpeedKt: 140,
  serviceCeilingFt: 14000,
  takeoffDistanceFt: 1600,
  landingDistanceFt: 1300,
  lengthM: 8.3,
};

export const A320: AircraftPerformance = {
  type: 'A320',
  category: 'large',
  wakeCategory: 'medium',
  taxiSpeedKt: 20,
  taxiTurnSpeedKt: 10,
  accelKtPerSec: 2.8,
  decelKtPerSec: 4.0,
  rotateSpeedKt: 140,
  climbSpeedKt: 180,
  cruiseSpeedKt: 250, // 250 kt below 10,000 ft
  approachSpeedKt: 135,
  touchdownSpeedKt: 130,
  climbRateFpm: 2500,
  descentRateFpm: 2000,
  turnRateDegPerSec: 2.5,
  groundTurnRateDegPerSec: 15,
  minSpeedKt: 120,
  maxSpeedKt: 320,
  serviceCeilingFt: 39000,
  takeoffDistanceFt: 6500,
  landingDistanceFt: 4500,
  lengthM: 37.6,
};

const registry: Record<string, AircraftPerformance> = { C172, A320 };

/** Register extra aircraft types (regional jets, helicopters...) without touching the engine. */
export function registerPerformance(perf: AircraftPerformance): void {
  registry[perf.type] = perf;
}

/** Look up performance; unknown types fall back to the closest default so the engine never crashes. */
export function getPerformance(type: string): AircraftPerformance {
  return registry[type] ?? (type.startsWith('A3') || type.startsWith('B7') ? A320 : C172);
}

/** Airspeed limit below 10,000 ft MSL (14 CFR 91.117 style restriction) for jets. */
export const SPEED_LIMIT_BELOW_10K_KT = 250;
