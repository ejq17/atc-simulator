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
  propulsion: 'piston',
  maxCrosswindKt: 15, // POH172S: maximum DEMONSTRATED crosswind component 15 kt (not a limitation); used as the simulator's refusal / go-around limit. Source: docs/REALISM-VERIFICATION.md section 8
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
  propulsion: 'turbofan',
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
  takeoffDistanceFt: 6000, landingDistanceFt: 4700, lengthM: 39.5, propulsion: 'turbofan', // ESTIMATE: typical weight; Boeing 737 airport planning document D6-58325-6
};

/** Airbus A220-300 (Breeze "Moxy"; ICAO type BCS3). */
export const BCS3: AircraftPerformance = {
  type: 'BCS3', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.9, decelKtPerSec: 6.0,
  rotateSpeedKt: 135, climbSpeedKt: 175, cruiseSpeedKt: 250, approachSpeedKt: 133, touchdownSpeedKt: 128,
  climbRateFpm: 2800, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 115, maxSpeedKt: 340, serviceCeilingFt: 41000,
  takeoffDistanceFt: 4900, landingDistanceFt: 4300, lengthM: 38.7, propulsion: 'turbofan', // ESTIMATE: A220-300 airport planning data, typical weight
};

/** Embraer 175 (Piedmont, Republic "Brickyard", SkyWest). */
export const E175: AircraftPerformance = {
  type: 'E175', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 4.0, decelKtPerSec: 6.0,
  rotateSpeedKt: 132, climbSpeedKt: 170, cruiseSpeedKt: 250, approachSpeedKt: 128, touchdownSpeedKt: 122,
  climbRateFpm: 2800, descentRateFpm: 2000, turnRateDegPerSec: 3, groundTurnRateDegPerSec: 16,
  minSpeedKt: 110, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 5000, landingDistanceFt: 4000, lengthM: 31.7, propulsion: 'turbofan', // ESTIMATE: Embraer 175 airport planning data, typical weight
};

/** Bombardier CRJ-900 (PSA "Blue Streak", GoJet "Lindbergh"). */
export const CRJ9: AircraftPerformance = {
  type: 'CRJ9', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 4.0, decelKtPerSec: 6.0,
  rotateSpeedKt: 138, climbSpeedKt: 180, cruiseSpeedKt: 250, approachSpeedKt: 135, touchdownSpeedKt: 128,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 3, groundTurnRateDegPerSec: 16,
  minSpeedKt: 115, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 5500, landingDistanceFt: 4200, lengthM: 36.4, propulsion: 'turbofan', // ESTIMATE: CRJ900 airport planning data, typical weight
};

/** Boeing 757-200 (UPS, FedEx freighters). */
export const B752: AircraftPerformance = {
  type: 'B752', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.3, decelKtPerSec: 5.5,
  rotateSpeedKt: 150, climbSpeedKt: 185, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 2600, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 12,
  minSpeedKt: 125, maxSpeedKt: 350, serviceCeilingFt: 42000,
  takeoffDistanceFt: 6800, landingDistanceFt: 5000, lengthM: 47.3, propulsion: 'turbofan', // ESTIMATE: Boeing 757 airport planning document D6-58327, typical freighter weight
};

/** Cessna 208 Caravan (Wiggins Airways feeder flights). Small single-engine turboprop: SRS I, RECAT I, parks on the GA ramp. */
export const C208: AircraftPerformance = {
  type: 'C208', category: 'light', wakeCategory: 'light',
  taxiSpeedKt: 15, taxiTurnSpeedKt: 8, accelKtPerSec: 3.0, decelKtPerSec: 4.0,
  rotateSpeedKt: 75, climbSpeedKt: 95, cruiseSpeedKt: 175, approachSpeedKt: 85, touchdownSpeedKt: 70,
  climbRateFpm: 900, descentRateFpm: 1000, turnRateDegPerSec: 3, groundTurnRateDegPerSec: 25,
  minSpeedKt: 60, maxSpeedKt: 175, serviceCeilingFt: 25000,
  takeoffDistanceFt: 2300, landingDistanceFt: 1900, lengthM: 11.5, propulsion: 'turbofan', // ESTIMATE: Textron 208B/208 specifications, POH Section 5, typical weight
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Types added for the traffic variety task (U.S. Coast Guard helicopters, Air National Guard fighters, airport vehicles).
// Every figure names its source; a figure without one is marked UNVERIFIED and is a conservative gameplay (design) value. The evidence
// and the retrieval dates are in docs/REALISM-VERIFICATION.md section 9 and data/sources/aircraft-performance.json.
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Eurocopter MH-65 Dolphin (US Coast Guard Air Station Atlantic City). Sourced: USCG MH-65E fact sheet (dcms.uscg.mil, Dec 2024, read through a search
 * result: the PDF itself answers HTTP 403 to scripts): maximum weight 9,480 lb, cruise speed 148 kt, length 44 ft 5 in with blades turning, rotor diameter
 * 39 ft 2 in, endurance 3 h; Coast Guard Aviation Association MH-65C table: maximum speed 175 kt. All other values are UNVERIFIED design values.
 * Hover and air-taxi limits are the procedure values of JO 7110.65 3-11-1 and AIM 4-3-17 (hover taxi "normally below 20 knots", air taxi "normally below
 * 100 feet AGL and at airspeeds above 20 knots"). Not in JO 7110.126A Appendix A (no helicopter appears in TBL A-1): `wakeRecatCategory` falls back to I
 * (small), and `srsCategory` is 1 by JO 7110.65 3-9-6 NOTE ("all helicopters" are Category I).
 */
export const H65: AircraftPerformance = {
  type: 'H65', category: 'light', wakeCategory: 'light',
  taxiSpeedKt: 10, taxiTurnSpeedKt: 5, // UNVERIFIED design: wheeled ground taxi (3-11-1 "ground taxiing"); not used by the air-taxi model
  accelKtPerSec: 4, decelKtPerSec: 5, // UNVERIFIED design
  rotateSpeedKt: 0, climbSpeedKt: 80, // UNVERIFIED design: translational lift / best climb speed
  cruiseSpeedKt: 148, // USCG MH-65E fact sheet (Dec 2024): cruise speed 148 kt
  approachSpeedKt: 70, touchdownSpeedKt: 0, // UNVERIFIED design
  climbRateFpm: 1500, descentRateFpm: 800, // UNVERIFIED design
  turnRateDegPerSec: 3, groundTurnRateDegPerSec: 20, // UNVERIFIED design (3 deg/s is standard rate)
  minSpeedKt: 0,
  maxSpeedKt: 175, // Coast Guard Aviation Association, MH-65C: maximum speed 175 kt (the MH-65E fact sheet lists 148 kt cruise only)
  serviceCeilingFt: 10000, // UNVERIFIED design
  takeoffDistanceFt: 0, landingDistanceFt: 0, // vertical lift-off and landing
  lengthM: 13.5, // 44 ft 5 in (USCG MH-65E fact sheet) = 13.54 m
  propulsion: 'turbofan', // turbine powered (AIM 4-3-3 groups it with turbine aircraft; helicopters use the 500 ft AGL pattern, see `patternAltitudeFt`)
  craft: 'rotorcraft', military: true,
  rotorcraft: { hoverTaxiMaxKt: 20, airTaxiKt: 35, hoverAglFt: 15, verticalRateFpm: 500, hoverTurnRateDegPerSec: 15 },
};

/**
 * General Dynamics / Lockheed Martin F-16C Fighting Falcon (New Jersey Air National Guard, 177th Fighter Wing). Sourced: USAF F-16 fact sheets (af.mil
 * and unit sheets, read through search results: af.mil refuses scripted requests): length 49 ft 5 in, empty weight 19,700 lb, maximum takeoff weight
 * 37,500 lb (the Block 50/52 sheet at Shaw lists about 39,000 lb), speed "Mach 2 at altitude / 1,500 mph", ceiling above 50,000 ft. RECAT category G
 * (Lower Large): JO 7110.126A Appendix A TBL A-1 lists F16 in the Lower Large column. SRS category III (JO 7110.65 3-9-6 "all other aircraft"). Pattern
 * and approach speeds, acceleration and climb are UNVERIFIED design values: the only sources found for the overhead break (300 kt, 1,500 ft AGL, about
 * 7 s break, 200-250 kt downwind) are forum posts and a flight-simulator syllabus, not USAF documents.
 */
export const F16: AircraftPerformance = {
  type: 'F16', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 8, // UNVERIFIED design
  accelKtPerSec: 6, decelKtPerSec: 5, // UNVERIFIED design
  rotateSpeedKt: 150, // UNVERIFIED design
  climbSpeedKt: 300, // UNVERIFIED design (below 10,000 ft the 250 kt limit of 14 CFR 91.117 is waived by `maxSpeedKt` only for the overhead break entry)
  cruiseSpeedKt: 350, // UNVERIFIED design
  approachSpeedKt: 160, touchdownSpeedKt: 140, // UNVERIFIED design
  climbRateFpm: 6000, descentRateFpm: 2500, // UNVERIFIED design (far below capability, sized for the simulation area)
  turnRateDegPerSec: 8, groundTurnRateDegPerSec: 18, // UNVERIFIED design (8 deg/s is about a 2.5 g break at 300 kt; the sources above give the 2 to 2.5 g break)
  minSpeedKt: 130, // UNVERIFIED design
  maxSpeedKt: 450, // UNVERIFIED design (fact sheet: Mach 2 at altitude)
  serviceCeilingFt: 50000, // USAF fact sheet: ceiling above 50,000 ft
  takeoffDistanceFt: 3000, landingDistanceFt: 3500, // UNVERIFIED design (the KACY runways are far longer)
  lengthM: 15.06, // 49 ft 5 in (USAF fact sheet)
  propulsion: 'turbofan', military: true,
};

/**
 * Airport ground vehicle (operations truck, pavement / runway inspection vehicle). All figures are UNVERIFIED design values: FAA AC 150/5210-20A gives
 * no vehicle speed (airport operators set limits). It moves on the taxiway graph with the ground-movement model and is subject to the same
 * runway authorisation rules (JO 7110.65 3-7-2, 3-1-3).
 */
export const VEH: AircraftPerformance = {
  type: 'VEH', category: 'light', wakeCategory: 'light',
  taxiSpeedKt: 18, taxiTurnSpeedKt: 8, accelKtPerSec: 3, decelKtPerSec: 5,
  rotateSpeedKt: 0, climbSpeedKt: 0, cruiseSpeedKt: 0, approachSpeedKt: 0, touchdownSpeedKt: 0, climbRateFpm: 0, descentRateFpm: 0,
  turnRateDegPerSec: 0, groundTurnRateDegPerSec: 35, minSpeedKt: 0, maxSpeedKt: 30, serviceCeilingFt: 0, takeoffDistanceFt: 0, landingDistanceFt: 0,
  lengthM: 5.5, craft: 'vehicle',
};

/** True for the helicopter model (`AircraftPerformance.craft`). */
export function isRotorcraftType(type: string): boolean {
  return getPerformance(type).craft === 'rotorcraft';
}
/** True for airport ground vehicles. */
export function isVehicleType(type: string): boolean {
  return getPerformance(type).craft === 'vehicle';
}
/** True for military types (Air Guard / Coast Guard callsign forms of JO 7110.65 2-4-20). */
export function isMilitaryType(type: string): boolean {
  return getPerformance(type).military === true;
}

import type { WakeCategory } from './wake';
const registry: Record<string, AircraftPerformance> = { C172, A320, B738, BCS3, E175, CRJ9, B752, C208, H65, F16, VEH };

/**
 * Same-runway-separation (SRS) category, FAA JO 7110.65 3-9-6 NOTE (aircraft types per JO 7360.1):
 * I = small single-engine propeller-driven <= 12,500 lb and all helicopters; II = small twin-engine propeller-driven <= 12,500 lb;
 * III = all other aircraft. Derived here from the type code; unknown types are I when `category === 'light'`, else III.
 */
const SRS: Record<string, 1 | 2 | 3> = { C172: 1, C182: 1, C152: 1, C210: 1, PA28: 1, SR22: 1, BE36: 1, PA34: 2, BE58: 2, C310: 2, C208: 1, H65: 1, A320: 3, B738: 3, BCS3: 3, E175: 3, CRJ9: 3, B752: 3, F16: 3 };
export function srsCategory(type: string): 1 | 2 | 3 {
  return SRS[type] ?? (getPerformance(type).category === 'light' ? 1 : 3);
}

/**
 * Wake RECAT category, FAA JO 7110.126A Appendix A (verified by the accuracy review): A320 = F ("other aircraft over 41,000 lb"),
 * C172 = I ("41,000 lb and under"); B757 = E; heavies B / D. Added types follow the same convention: B738 = F (TBL A-1 Upper Large), E175 and CRJ9 = G (TBL A-1 Lower Large: E75L / E75S / CRJ9 read visually on the rendered page A1, 2026-10-18), BCS3 = F
 * (NOT listed in TBL A-1: kept F by the over-41,000-lb convention, UNVERIFIED); B752 = E (TBL A-1 lists B752 / B753 under E); C208 = I (MTOW 8,750 lb). Types not listed: `wakeCategory` light -> I, medium -> F, heavy -> D.
 */
const RECAT: Record<string, WakeCategory> = { C172: 'I', C182: 'I', C152: 'I', C210: 'I', PA28: 'I', SR22: 'I', BE36: 'I', PA34: 'I', BE58: 'I', C310: 'I', C208: 'I', F16: 'G', A320: 'F', B738: 'F', BCS3: 'F', E175: 'G', CRJ9: 'G', B752: 'E' };
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

/** Standard pattern altitudes, FAA AIM 4-3-3 (fetched 2026-10-18): propeller-driven 1,000 ft AGL; large and turbine-powered not less than 1,500 ft AGL or 500 ft above the established pattern altitude. */
export const AIM_PROPELLER_PATTERN_AGL_FT = 1000;
export const AIM_TURBINE_PATTERN_AGL_FT = 1500;
/** AIM 4-3-3 (fetched 2026-10-18): helicopters in the traffic pattern fly 500 ft AGL, closer to the runway. */
export const AIM_HELICOPTER_PATTERN_AGL_FT = 500;

/** Large or turbine-powered (AIM 4-3-3): turboprops and turbofans, any aircraft of category large / heavy; unknown light types are propeller-driven. */
export function isLargeOrTurbine(perf: AircraftPerformance): boolean {
  return perf.propulsion ? perf.propulsion !== 'piston' : perf.category !== 'light';
}

/**
 * Traffic pattern altitude (ft MSL) for an aircraft type at a field of `fieldElevFt`. `publishedTpaFt` is the published pattern altitude
 * (Chart Supplement / NASR) when the dataset has one: propeller aircraft fly it, large / turbine aircraft fly 500 ft above it (AIM 4-3-3).
 * Without one the AIM defaults apply (1,000 / 1,500 ft AGL). Neither KACY nor KMHT has a TPA in NASR, so the defaults apply there.
 */
export function patternAltitudeFt(perf: AircraftPerformance, fieldElevFt: number, publishedTpaFt?: number): number {
  // AIM 4-3-3: helicopters "may fly a pattern similar to the fixed-wing aircraft pattern, but at a lower altitude (500 AGL)".
  if (perf.craft === 'rotorcraft') return fieldElevFt + AIM_HELICOPTER_PATTERN_AGL_FT;
  const turbine = isLargeOrTurbine(perf);
  if (publishedTpaFt !== undefined) return turbine ? Math.max(publishedTpaFt + 500, fieldElevFt + AIM_TURBINE_PATTERN_AGL_FT) : publishedTpaFt;
  return fieldElevFt + (turbine ? AIM_TURBINE_PATTERN_AGL_FT : AIM_PROPELLER_PATTERN_AGL_FT);
}
