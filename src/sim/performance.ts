/**
 * Aircraft performance tables.
 *
 * NOTE: every number here is a SIMPLIFIED APPROXIMATION chosen to look believable
 * on a radar/surface display. They are NOT certified performance data and must
 * never be used for real flight planning.
 *
 * Sources: values changed after the realism verification are annotated with `source:` comments naming the entry in
 * data/sources/aircraft-performance.json (and the evidence in docs/REALISM-VERIFICATION.md). Values without a comment were
 * checked as "match" or "acceptable simplification" there and are unchanged.
 */
import type { AircraftPerformance } from './types';

export const C172: AircraftPerformance = {
  type: 'C172',
  category: 'light',
  wakeCategory: 'light',
  taxiSpeedKt: 15,
  taxiTurnSpeedKt: 8,
  accelKtPerSec: 2.8, // derived 2.66 kt/s from the 960 ft ground roll (aircraft-performance.json C172.accelKtPerSec): kept
  decelKtPerSec: 3.0,
  rotateSpeedKt: 55, // POH172S Section 4: lift nose wheel at 55 KIAS (verified)
  climbSpeedKt: 75, // Vy 74 KIAS, normal climb 75-85 (verified)
  cruiseSpeedKt: 110,
  approachSpeedKt: 65, // POH172S: 60-70 KIAS (verified)
  touchdownSpeedKt: 55,
  climbRateFpm: 730, // source: aircraft-performance.json C172.climbRateFpm (Textron 730 fpm; was 700)
  descentRateFpm: 800,
  turnRateDegPerSec: 3,
  groundTurnRateDegPerSec: 30, // source: aircraft-performance.json C172.groundTurnRateDegPerSec (POH ~27 ft turning radius; was 40)
  minSpeedKt: 45,
  maxSpeedKt: 129, // source: aircraft-performance.json C172.maxSpeedKt (Vno 129 KIAS, EASA TCDS IM.A.051; was 140)
  serviceCeilingFt: 14000,
  takeoffDistanceFt: 1630, // source: aircraft-performance.json C172.takeoffDistanceFt (Textron 1,630 ft over 50 ft; was 1600)
  landingDistanceFt: 1335, // source: aircraft-performance.json C172.landingDistanceFt (Textron 1,335 ft over 50 ft; was 1300)
  lengthM: 8.3,
};

export const A320: AircraftPerformance = {
  type: 'A320',
  category: 'large',
  wakeCategory: 'medium',
  taxiSpeedKt: 20,
  taxiTurnSpeedKt: 10,
  accelKtPerSec: 4.0, // source: aircraft-performance.json A320.accelKtPerSec (ESTIMATE: ~35 s / ~5,000 ft roll to 140 kt; was 2.8)
  decelKtPerSec: 4.0,
  rotateSpeedKt: 140, // ACD_A320 V2 145 kt (verified within 5 kt)
  climbSpeedKt: 175, // source: aircraft-performance.json A320.climbSpeedKt (EUROCONTROL initial climb 175 kt IAS; was 180)
  cruiseSpeedKt: 250, // 250 kt below 10,000 ft (14 CFR 91.117(a))
  approachSpeedKt: 135, // Airbus AC 3-5-0: 136 kt at MLW (verified)
  touchdownSpeedKt: 130,
  climbRateFpm: 2500,
  descentRateFpm: 2000,
  turnRateDegPerSec: 2.5,
  groundTurnRateDegPerSec: 15,
  minSpeedKt: 120,
  maxSpeedKt: 320,
  serviceCeilingFt: 39000,
  takeoffDistanceFt: 5000, // source: aircraft-performance.json A320.takeoffDistanceFt (Airbus AC Fig 3-3-1 ~5,000 ft at ~68 t; was 6500, which refused 4/22)
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
