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
  decelKtPerSec: 4.4, // source: docs/BEHAVIOUR-ACCURACY.md F9: Textron 575 ft landing roll at max braking from 55 kt = 4.4 kt/s (was 3.0)
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
  decelKtPerSec: 6.0, // source: docs/BEHAVIOUR-ACCURACY.md F9: Airbus AC 3-4-0 actual landing distance ~2,900 ft (~6 kt/s); was 4.0
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Types added for KMHT traffic (airport traffic profile, src/game/airportProfile.ts). Figures are public-data approximations at typical
// (not maximum) operating weight; each is documented, with its source or "ESTIMATE", in data/sources/aircraft-performance.json and
// docs/REALISM-VERIFICATION.md section 7. Shared simplifications follow A320/C172: taxi speeds, turn rates and descent rates are gameplay values.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Boeing 737-800 (Southwest 737-700/-800/MAX 8 and Sun Country are flown as B738). */
export const B738: AircraftPerformance = {
  type: 'B738', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.7, decelKtPerSec: 5.8,
  rotateSpeedKt: 145, climbSpeedKt: 180, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 2500, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 125, maxSpeedKt: 340, serviceCeilingFt: 41000,
  takeoffDistanceFt: 6000, landingDistanceFt: 4700, lengthM: 39.5, // ESTIMATE: typical weight; Boeing 737 airport planning document D6-58325-6
};

/** Airbus A220-300 (Breeze "Moxy"; ICAO type BCS3). */
export const BCS3: AircraftPerformance = {
  type: 'BCS3', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.9, decelKtPerSec: 6.0,
  rotateSpeedKt: 135, climbSpeedKt: 175, cruiseSpeedKt: 250, approachSpeedKt: 133, touchdownSpeedKt: 128,
  climbRateFpm: 2800, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 115, maxSpeedKt: 340, serviceCeilingFt: 41000,
  takeoffDistanceFt: 4900, landingDistanceFt: 4300, lengthM: 38.7, // ESTIMATE: A220-300 airport planning data, typical weight
};

/** Embraer 175 (Piedmont, Republic "Brickyard", SkyWest). */
export const E175: AircraftPerformance = {
  type: 'E175', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 4.0, decelKtPerSec: 6.0,
  rotateSpeedKt: 132, climbSpeedKt: 170, cruiseSpeedKt: 250, approachSpeedKt: 128, touchdownSpeedKt: 122,
  climbRateFpm: 2800, descentRateFpm: 2000, turnRateDegPerSec: 3, groundTurnRateDegPerSec: 16,
  minSpeedKt: 110, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 5000, landingDistanceFt: 4000, lengthM: 31.7, // ESTIMATE: Embraer 175 airport planning data, typical weight
};

/** Bombardier CRJ-900 (PSA "Blue Streak", GoJet "Lindbergh"). */
export const CRJ9: AircraftPerformance = {
  type: 'CRJ9', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 4.0, decelKtPerSec: 6.0,
  rotateSpeedKt: 138, climbSpeedKt: 180, cruiseSpeedKt: 250, approachSpeedKt: 135, touchdownSpeedKt: 128,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 3, groundTurnRateDegPerSec: 16,
  minSpeedKt: 115, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 5500, landingDistanceFt: 4200, lengthM: 36.4, // ESTIMATE: CRJ900 airport planning data, typical weight
};

/** Boeing 757-200 (UPS, FedEx freighters). */
export const B752: AircraftPerformance = {
  type: 'B752', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.3, decelKtPerSec: 5.5,
  rotateSpeedKt: 150, climbSpeedKt: 185, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 2600, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 12,
  minSpeedKt: 125, maxSpeedKt: 350, serviceCeilingFt: 42000,
  takeoffDistanceFt: 6800, landingDistanceFt: 5000, lengthM: 47.3, // ESTIMATE: Boeing 757 airport planning document D6-58327, typical freighter weight
};

/** Cessna 208 Caravan (Wiggins Airways feeder flights). Small single-engine turboprop: SRS I, RECAT I, parks on the GA ramp. */
export const C208: AircraftPerformance = {
  type: 'C208', category: 'light', wakeCategory: 'light',
  taxiSpeedKt: 15, taxiTurnSpeedKt: 8, accelKtPerSec: 3.0, decelKtPerSec: 4.0,
  rotateSpeedKt: 75, climbSpeedKt: 95, cruiseSpeedKt: 175, approachSpeedKt: 85, touchdownSpeedKt: 70,
  climbRateFpm: 900, descentRateFpm: 1000, turnRateDegPerSec: 3, groundTurnRateDegPerSec: 25,
  minSpeedKt: 60, maxSpeedKt: 175, serviceCeilingFt: 25000,
  takeoffDistanceFt: 2300, landingDistanceFt: 1900, lengthM: 11.5, // ESTIMATE: Textron 208B/208 specifications, POH Section 5, typical weight
};

import type { WakeCategory } from './wake';
const registry: Record<string, AircraftPerformance> = { C172, A320, B738, BCS3, E175, CRJ9, B752, C208 };

/**
 * Same-runway-separation (SRS) category, FAA JO 7110.65 3-9-6 NOTE (aircraft types per JO 7360.1):
 * I = small single-engine propeller-driven <= 12,500 lb and all helicopters; II = small twin-engine propeller-driven <= 12,500 lb;
 * III = all other aircraft. Derived here from the type code; unknown types are I when `category === 'light'`, else III.
 */
const SRS: Record<string, 1 | 2 | 3> = { C172: 1, C182: 1, C152: 1, C210: 1, PA28: 1, SR22: 1, BE36: 1, PA34: 2, BE58: 2, C310: 2, C208: 1, A320: 3, B738: 3, BCS3: 3, E175: 3, CRJ9: 3, B752: 3 };
export function srsCategory(type: string): 1 | 2 | 3 {
  return SRS[type] ?? (getPerformance(type).category === 'light' ? 1 : 3);
}

/**
 * Wake RECAT category, FAA JO 7110.126A Appendix A (verified by the accuracy review): A320 = F ("other aircraft over 41,000 lb"),
 * C172 = I ("41,000 lb and under"); B757 = E; heavies B / D. Added types follow the same convention: B738, BCS3, E175, CRJ9 = F (over 41,000 lb, not
 * heavy); B752 = E (the file's B757 convention; the 7110.126A Appendix A listing of the 757 was not re-fetched when it was added); C208 = I (MTOW 8,750 lb). Types not listed: `wakeCategory` light -> I, medium -> F, heavy -> D.
 */
const RECAT: Record<string, WakeCategory> = { C172: 'I', C182: 'I', C152: 'I', C210: 'I', PA28: 'I', SR22: 'I', BE36: 'I', PA34: 'I', BE58: 'I', C310: 'I', C208: 'I', A320: 'F', B738: 'F', BCS3: 'F', E175: 'F', CRJ9: 'F', B752: 'E' };
export function wakeRecatCategory(type: string): WakeCategory {
  const known = RECAT[type];
  if (known) return known;
  const w = getPerformance(type).wakeCategory;
  return w === 'light' ? 'I' : w === 'medium' ? 'F' : 'D';
}

/**
 * Time (s) from the takeoff clearance, given to an aircraft holding short or still taxiing to the hold, until it starts its roll:
 * the pilot's reaction, the taxi over `pathM` to the runway centreline at the line-up speed, and the 90 degree turn onto the runway
 * heading, never less than the floor of 10 s (light single, C172) / 17 s (jets, A320): an aircraft cleared from the hold is not
 * rolling 2.5 s later. (Typical pilot practice; there is no FAA figure.)
 */
export function lineUpTimeSec(perf: AircraftPerformance, pathM: number): number {
  const floor = perf.category === 'light' ? 10 : 17;
  const natural = 3 + pathM / Math.max(1, (perf.taxiTurnSpeedKt * 1852) / 3600) + 90 / Math.max(1, perf.groundTurnRateDegPerSec);
  return Math.max(floor, natural);
}

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
