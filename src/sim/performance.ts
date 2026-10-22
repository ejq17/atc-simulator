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
  takeoffDistanceFt: 2300, landingDistanceFt: 1900, lengthM: 11.5, propulsion: 'turboprop', // (was 'turbofan', a data error: the Caravan is a single PT6A turboprop) ESTIMATE: Textron 208B/208 specifications, POH Section 5, typical weight
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Types added for the KBOS / KPHL / EGLL traffic (2026-10-21). Every figure is read from the EUROCONTROL Aircraft Performance Database
// (ACD) page of the type, retrieved 2026-10-21, or derived from it by the formula stated per field in data/sources/aircraft-performance.json
// (_sources of each type): rotate = V2 - 5 kt, approach = Vat, touchdown = Vat - 5, climb speed / rate = initial climb IAS / ROC, take-off and
// landing distance = the ACD figures at MTOW (A359: Airbus AC chart-read), cruise = 14 CFR 91.117(a) 250 kt for jets. Taxi, turn, descent
// (jets) and braking values are DESIGN values as for A320 / B738. Take-off distances are MTOW-basis, so they are larger than the typical-weight
// ESTIMATEs of the KMHT types: `runwayLongEnoughFor` therefore keeps the heaviest types off short runways.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Airbus A319. EUROCONTROL ACD page A319 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A319._sources. RECAT F. */
export const A319: AircraftPerformance = {
  type: 'A319', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.1, decelKtPerSec: 6.0,
  rotateSpeedKt: 130, climbSpeedKt: 165, cruiseSpeedKt: 250, approachSpeedKt: 130, touchdownSpeedKt: 125,
  climbRateFpm: 2500, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 115, maxSpeedKt: 320, serviceCeilingFt: 39000,
  takeoffDistanceFt: 5740, landingDistanceFt: 4430, lengthM: 33.8, propulsion: 'turbofan',
};

/** Airbus A320neo. EUROCONTROL ACD page A20N (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A20N._sources. RECAT F (UNVERIFIED: not in TBL A-1). */
export const A20N: AircraftPerformance = {
  type: 'A20N', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.2, decelKtPerSec: 6.0,
  rotateSpeedKt: 140, climbSpeedKt: 175, cruiseSpeedKt: 250, approachSpeedKt: 135, touchdownSpeedKt: 130,
  climbRateFpm: 2200, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 120, maxSpeedKt: 320, serviceCeilingFt: 39000,
  takeoffDistanceFt: 6400, landingDistanceFt: 5410, lengthM: 37.6, propulsion: 'turbofan',
};

/** Airbus A321neo. EUROCONTROL ACD page A21N (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A21N._sources. RECAT F (UNVERIFIED: not in TBL A-1). */
export const A21N: AircraftPerformance = {
  type: 'A21N', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.9, decelKtPerSec: 6.0,
  rotateSpeedKt: 140, climbSpeedKt: 175, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 2000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 125, maxSpeedKt: 320, serviceCeilingFt: 39000,
  takeoffDistanceFt: 7050, landingDistanceFt: 6070, lengthM: 44.5, propulsion: 'turbofan',
};

/** Airbus A321. EUROCONTROL ACD page A321 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A321._sources. RECAT F. */
export const A321: AircraftPerformance = {
  type: 'A321', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.9, decelKtPerSec: 6.0,
  rotateSpeedKt: 140, climbSpeedKt: 175, cruiseSpeedKt: 250, approachSpeedKt: 141, touchdownSpeedKt: 136,
  climbRateFpm: 2500, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 126, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 7250, landingDistanceFt: 5250, lengthM: 44.5, propulsion: 'turbofan',
};

/** Boeing 737-700. EUROCONTROL ACD page B737 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B737._sources. RECAT F. */
export const B737: AircraftPerformance = {
  type: 'B737', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.8, decelKtPerSec: 6.0,
  rotateSpeedKt: 145, climbSpeedKt: 165, cruiseSpeedKt: 250, approachSpeedKt: 137, touchdownSpeedKt: 132,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 122, maxSpeedKt: 310, serviceCeilingFt: 41000,
  takeoffDistanceFt: 5910, landingDistanceFt: 4590, lengthM: 33.6, propulsion: 'turbofan',
};

/** Boeing 737 MAX 8. EUROCONTROL ACD page B38M (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B38M._sources. RECAT F (UNVERIFIED: not in TBL A-1). */
export const B38M: AircraftPerformance = {
  type: 'B38M', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.5, decelKtPerSec: 6.0,
  rotateSpeedKt: 140, climbSpeedKt: 165, cruiseSpeedKt: 250, approachSpeedKt: 145, touchdownSpeedKt: 140,
  climbRateFpm: 2500, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 130, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 8200, landingDistanceFt: 4920, lengthM: 39.5, propulsion: 'turbofan',
};

/** Boeing 737-900. EUROCONTROL ACD page B739 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B739._sources. RECAT F. */
export const B739: AircraftPerformance = {
  type: 'B739', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.9, decelKtPerSec: 6.0,
  rotateSpeedKt: 144, climbSpeedKt: 165, cruiseSpeedKt: 250, approachSpeedKt: 150, touchdownSpeedKt: 145,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 15,
  minSpeedKt: 135, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 7550, landingDistanceFt: 5580, lengthM: 42.1, propulsion: 'turbofan',
};

/** Embraer 190. EUROCONTROL ACD page E190 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json E190._sources. RECAT F. */
export const E190: AircraftPerformance = {
  type: 'E190', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.8, decelKtPerSec: 6.0,
  rotateSpeedKt: 133, climbSpeedKt: 190, cruiseSpeedKt: 250, approachSpeedKt: 131, touchdownSpeedKt: 126,
  climbRateFpm: 3400, descentRateFpm: 2000, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 16,
  minSpeedKt: 116, maxSpeedKt: 330, serviceCeilingFt: 41000,
  takeoffDistanceFt: 6750, landingDistanceFt: 4340, lengthM: 36.2, propulsion: 'turbofan',
};

/** Bombardier CRJ-700. EUROCONTROL ACD page CRJ7 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json CRJ7._sources. RECAT G. */
export const CRJ7: AircraftPerformance = {
  type: 'CRJ7', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.4, decelKtPerSec: 6.0,
  rotateSpeedKt: 130, climbSpeedKt: 165, cruiseSpeedKt: 250, approachSpeedKt: 135, touchdownSpeedKt: 130,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 16,
  minSpeedKt: 120, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 5250, landingDistanceFt: 4850, lengthM: 32.5, propulsion: 'turbofan',
};

/** Boeing 767-200. EUROCONTROL ACD page B762 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B762._sources. RECAT C. */
export const B762: AircraftPerformance = {
  type: 'B762', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.9, decelKtPerSec: 5.5,
  rotateSpeedKt: 155, climbSpeedKt: 190, cruiseSpeedKt: 250, approachSpeedKt: 135, touchdownSpeedKt: 130,
  climbRateFpm: 2000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 120, maxSpeedKt: 320, serviceCeilingFt: 45000,
  takeoffDistanceFt: 8860, landingDistanceFt: 4920, lengthM: 48.5, propulsion: 'turbofan',
};

/** Boeing 767-300. EUROCONTROL ACD page B763 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B763._sources. RECAT C. */
export const B763: AircraftPerformance = {
  type: 'B763', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.7, decelKtPerSec: 5.5,
  rotateSpeedKt: 155, climbSpeedKt: 190, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 125, maxSpeedKt: 320, serviceCeilingFt: 45000,
  takeoffDistanceFt: 9510, landingDistanceFt: 5910, lengthM: 54.9, propulsion: 'turbofan',
};

/** Airbus A300-600. EUROCONTROL ACD page A306 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A306._sources. RECAT C. */
export const A306: AircraftPerformance = {
  type: 'A306', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.4, decelKtPerSec: 5.5,
  rotateSpeedKt: 155, climbSpeedKt: 190, cruiseSpeedKt: 250, approachSpeedKt: 139, touchdownSpeedKt: 134,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 124, maxSpeedKt: 320, serviceCeilingFt: 37000,
  takeoffDistanceFt: 7350, landingDistanceFt: 5030, lengthM: 54.1, propulsion: 'turbofan',
};

/** Boeing 777-200. EUROCONTROL ACD page B772 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B772._sources. RECAT B. */
export const B772: AircraftPerformance = {
  type: 'B772', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.0, decelKtPerSec: 5.5,
  rotateSpeedKt: 165, climbSpeedKt: 200, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 125, maxSpeedKt: 330, serviceCeilingFt: 43000,
  takeoffDistanceFt: 9510, landingDistanceFt: 5580, lengthM: 63.7, propulsion: 'turbofan',
};

/** Boeing 777-300ER. EUROCONTROL ACD page B77W (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B77W._sources. RECAT B. */
export const B77W: AircraftPerformance = {
  type: 'B77W', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.8, decelKtPerSec: 5.5,
  rotateSpeedKt: 163, climbSpeedKt: 200, cruiseSpeedKt: 250, approachSpeedKt: 149, touchdownSpeedKt: 144,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 134, maxSpeedKt: 330, serviceCeilingFt: 43000,
  takeoffDistanceFt: 9840, landingDistanceFt: 5910, lengthM: 73.9, propulsion: 'turbofan',
};

/** Boeing 787-8. EUROCONTROL ACD page B788 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B788._sources. RECAT B. */
export const B788: AircraftPerformance = {
  type: 'B788', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.9, decelKtPerSec: 5.5,
  rotateSpeedKt: 160, climbSpeedKt: 190, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 2700, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 125, maxSpeedKt: 330, serviceCeilingFt: 43000,
  takeoffDistanceFt: 9250, landingDistanceFt: 4990, lengthM: 56.7, propulsion: 'turbofan',
};

/** Boeing 787-9. EUROCONTROL ACD page B789 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B789._sources. RECAT B. */
export const B789: AircraftPerformance = {
  type: 'B789', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.9, decelKtPerSec: 5.5,
  rotateSpeedKt: 160, climbSpeedKt: 190, cruiseSpeedKt: 250, approachSpeedKt: 150, touchdownSpeedKt: 145,
  climbRateFpm: 2700, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 135, maxSpeedKt: 330, serviceCeilingFt: 43000,
  takeoffDistanceFt: 9190, landingDistanceFt: 4990, lengthM: 62.8, propulsion: 'turbofan',
};

/** Airbus A330-200. EUROCONTROL ACD page A332 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A332._sources. RECAT B. */
export const A332: AircraftPerformance = {
  type: 'A332', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.7, decelKtPerSec: 5.5,
  rotateSpeedKt: 140, climbSpeedKt: 175, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 2000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 125, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 7550, landingDistanceFt: 5910, lengthM: 58.8, propulsion: 'turbofan',
};

/** Airbus A330-300. EUROCONTROL ACD page A333 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A333._sources. RECAT B. */
export const A333: AircraftPerformance = {
  type: 'A333', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.7, decelKtPerSec: 5.5,
  rotateSpeedKt: 140, climbSpeedKt: 175, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 2000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 125, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 7550, landingDistanceFt: 5580, lengthM: 63.6, propulsion: 'turbofan',
};

/** Airbus A330-900. EUROCONTROL ACD page A339 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A339._sources. RECAT D. */
export const A339: AircraftPerformance = {
  type: 'A339', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.7, decelKtPerSec: 5.5,
  rotateSpeedKt: 140, climbSpeedKt: 175, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 2000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 125, maxSpeedKt: 320, serviceCeilingFt: 41000,
  takeoffDistanceFt: 7710, landingDistanceFt: 6070, lengthM: 63.7, propulsion: 'turbofan',
};

/** Airbus A350-900. EUROCONTROL ACD page A359 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A359._sources. RECAT B. */
export const A359: AircraftPerformance = {
  type: 'A359', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.6, decelKtPerSec: 5.5,
  rotateSpeedKt: 145, climbSpeedKt: 220, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 3000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 125, maxSpeedKt: 330, serviceCeilingFt: 43000,
  takeoffDistanceFt: 8370, landingDistanceFt: 6400, lengthM: 66.9, propulsion: 'turbofan',
};

/** Airbus A350-1000. EUROCONTROL ACD page A35K (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A35K._sources. RECAT B (UNVERIFIED: not in TBL A-1). */
export const A35K: AircraftPerformance = {
  type: 'A35K', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.8, decelKtPerSec: 5.5,
  rotateSpeedKt: 150, climbSpeedKt: 220, cruiseSpeedKt: 250, approachSpeedKt: 150, touchdownSpeedKt: 145,
  climbRateFpm: 2500, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 135, maxSpeedKt: 330, serviceCeilingFt: 41000,
  takeoffDistanceFt: 8530, landingDistanceFt: 6560, lengthM: 73.8, propulsion: 'turbofan',
};

/** Airbus A380-800. EUROCONTROL ACD page A388 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json A388._sources. RECAT A. */
export const A388: AircraftPerformance = {
  type: 'A388', category: 'heavy', wakeCategory: 'super',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.3, decelKtPerSec: 5.5,
  rotateSpeedKt: 145, climbSpeedKt: 190, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 1500, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 8,
  minSpeedKt: 125, maxSpeedKt: 350, serviceCeilingFt: 43000,
  takeoffDistanceFt: 9740, landingDistanceFt: 6590, lengthM: 73.0, propulsion: 'turbofan',
};

/** Boeing 747-400. EUROCONTROL ACD page B744 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B744._sources. RECAT B. */
export const B744: AircraftPerformance = {
  type: 'B744', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.2, decelKtPerSec: 5.5,
  rotateSpeedKt: 180, climbSpeedKt: 215, cruiseSpeedKt: 250, approachSpeedKt: 152, touchdownSpeedKt: 147,
  climbRateFpm: 1500, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 137, maxSpeedKt: 330, serviceCeilingFt: 45000,
  takeoffDistanceFt: 10830, landingDistanceFt: 6990, lengthM: 70.6, propulsion: 'turbofan',
};

/** Boeing 747-8. EUROCONTROL ACD page B748 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json B748._sources. RECAT B. */
export const B748: AircraftPerformance = {
  type: 'B748', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.9, decelKtPerSec: 5.5,
  rotateSpeedKt: 170, climbSpeedKt: 230, cruiseSpeedKt: 250, approachSpeedKt: 145, touchdownSpeedKt: 140,
  climbRateFpm: 2500, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 130, maxSpeedKt: 290, serviceCeilingFt: 43000,
  takeoffDistanceFt: 10470, landingDistanceFt: 8790, lengthM: 76.3, propulsion: 'turbofan',
};

/** McDonnell Douglas MD-11. EUROCONTROL ACD page MD11 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json MD11._sources. RECAT C. */
export const MD11: AircraftPerformance = {
  type: 'MD11', category: 'heavy', wakeCategory: 'heavy',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.5, decelKtPerSec: 5.5,
  rotateSpeedKt: 155, climbSpeedKt: 190, cruiseSpeedKt: 250, approachSpeedKt: 159, touchdownSpeedKt: 154,
  climbRateFpm: 2000, descentRateFpm: 2000, turnRateDegPerSec: 2.5, groundTurnRateDegPerSec: 10,
  minSpeedKt: 144, maxSpeedKt: 330, serviceCeilingFt: 41000,
  takeoffDistanceFt: 10170, landingDistanceFt: 6890, lengthM: 61.2, propulsion: 'turbofan',
};

/** De Havilland Dash 8 Q400. EUROCONTROL ACD page DH8D (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json DH8D._sources. RECAT F. */
export const DH8D: AircraftPerformance = {
  type: 'DH8D', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.0, decelKtPerSec: 4.5,
  rotateSpeedKt: 110, climbSpeedKt: 150, cruiseSpeedKt: 210, approachSpeedKt: 121, touchdownSpeedKt: 116,
  climbRateFpm: 3500, descentRateFpm: 1500, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 16,
  minSpeedKt: 106, maxSpeedKt: 270, serviceCeilingFt: 25000,
  takeoffDistanceFt: 4270, landingDistanceFt: 3610, lengthM: 32.8, propulsion: 'turboprop',
};

/** Beechcraft King Air 200. EUROCONTROL ACD page BE20 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json BE20._sources. RECAT I. */
export const BE20: AircraftPerformance = {
  type: 'BE20', category: 'light', wakeCategory: 'light',
  taxiSpeedKt: 15, taxiTurnSpeedKt: 8, accelKtPerSec: 6.8, decelKtPerSec: 4.5,
  rotateSpeedKt: 110, climbSpeedKt: 145, cruiseSpeedKt: 230, approachSpeedKt: 100, touchdownSpeedKt: 95,
  climbRateFpm: 2000, descentRateFpm: 1500, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 25,
  minSpeedKt: 85, maxSpeedKt: 250, serviceCeilingFt: 35000,
  takeoffDistanceFt: 1870, landingDistanceFt: 1770, lengthM: 13.4, propulsion: 'turboprop',
};

/** Beechcraft King Air 90. EUROCONTROL ACD page BE9L (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json BE9L._sources. RECAT I (UNVERIFIED: not in TBL A-1). */
export const BE9L: AircraftPerformance = {
  type: 'BE9L', category: 'light', wakeCategory: 'light',
  taxiSpeedKt: 15, taxiTurnSpeedKt: 8, accelKtPerSec: 4.1, decelKtPerSec: 4.5,
  rotateSpeedKt: 95, climbSpeedKt: 130, cruiseSpeedKt: 200, approachSpeedKt: 105, touchdownSpeedKt: 100,
  climbRateFpm: 1500, descentRateFpm: 1000, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 25,
  minSpeedKt: 90, maxSpeedKt: 240, serviceCeilingFt: 29000,
  takeoffDistanceFt: 2300, landingDistanceFt: 1250, lengthM: 10.8, propulsion: 'turboprop',
};

/** Pilatus PC-12. EUROCONTROL ACD page PC12 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json PC12._sources. RECAT I. */
export const PC12: AircraftPerformance = {
  type: 'PC12', category: 'light', wakeCategory: 'light',
  taxiSpeedKt: 15, taxiTurnSpeedKt: 8, accelKtPerSec: 5.9, decelKtPerSec: 4.5,
  rotateSpeedKt: 105, climbSpeedKt: 130, cruiseSpeedKt: 180, approachSpeedKt: 85, touchdownSpeedKt: 80,
  climbRateFpm: 1700, descentRateFpm: 1500, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 25,
  minSpeedKt: 70, maxSpeedKt: 210, serviceCeilingFt: 30000,
  takeoffDistanceFt: 1970, landingDistanceFt: 1800, lengthM: 14.4, propulsion: 'turboprop',
};

/** Cessna 402C. EUROCONTROL ACD page C402 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json C402._sources. RECAT I. */
export const C402: AircraftPerformance = {
  type: 'C402', category: 'light', wakeCategory: 'light',
  taxiSpeedKt: 15, taxiTurnSpeedKt: 8, accelKtPerSec: 3.8, decelKtPerSec: 4.4,
  rotateSpeedKt: 90, climbSpeedKt: 125, cruiseSpeedKt: 150, approachSpeedKt: 110, touchdownSpeedKt: 105,
  climbRateFpm: 1200, descentRateFpm: 800, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 25,
  minSpeedKt: 95, maxSpeedKt: 220, serviceCeilingFt: 27000,
  takeoffDistanceFt: 2220, landingDistanceFt: 1770, lengthM: 11.1, propulsion: 'piston',
};

/** Cessna Citation Excel / XLS. EUROCONTROL ACD page C56X (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json C56X._sources. RECAT H. */
export const C56X: AircraftPerformance = {
  type: 'C56X', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 3.7, decelKtPerSec: 6.0,
  rotateSpeedKt: 110, climbSpeedKt: 145, cruiseSpeedKt: 250, approachSpeedKt: 117, touchdownSpeedKt: 112,
  climbRateFpm: 2500, descentRateFpm: 2000, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 20,
  minSpeedKt: 102, maxSpeedKt: 300, serviceCeilingFt: 45000,
  takeoffDistanceFt: 3460, landingDistanceFt: 2920, lengthM: 15.8, propulsion: 'turbofan',
};

/** Bombardier Challenger 350. EUROCONTROL ACD page CL35 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json CL35._sources. RECAT H (UNVERIFIED: not in TBL A-1). */
export const CL35: AircraftPerformance = {
  type: 'CL35', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 4.0, decelKtPerSec: 6.0,
  rotateSpeedKt: 135, climbSpeedKt: 160, cruiseSpeedKt: 250, approachSpeedKt: 125, touchdownSpeedKt: 120,
  climbRateFpm: 4500, descentRateFpm: 2000, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 20,
  minSpeedKt: 110, maxSpeedKt: 290, serviceCeilingFt: 45000,
  takeoffDistanceFt: 4840, landingDistanceFt: 2710, lengthM: 20.9, propulsion: 'turbofan',
};

/** Gulfstream V. EUROCONTROL ACD page GLF5 (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json GLF5._sources. RECAT F. */
export const GLF5: AircraftPerformance = {
  type: 'GLF5', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 4.0, decelKtPerSec: 6.0,
  rotateSpeedKt: 140, climbSpeedKt: 175, cruiseSpeedKt: 250, approachSpeedKt: 140, touchdownSpeedKt: 135,
  climbRateFpm: 4000, descentRateFpm: 2000, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 20,
  minSpeedKt: 125, maxSpeedKt: 330, serviceCeilingFt: 51000,
  takeoffDistanceFt: 5150, landingDistanceFt: 2900, lengthM: 29.4, propulsion: 'turbofan',
};

/** Bombardier Global Express. EUROCONTROL ACD page GLEX (retrieved 2026-10-21); derivations and gameplay values per field in data/sources/aircraft-performance.json GLEX._sources. RECAT F. */
export const GLEX: AircraftPerformance = {
  type: 'GLEX', category: 'large', wakeCategory: 'medium',
  taxiSpeedKt: 20, taxiTurnSpeedKt: 10, accelKtPerSec: 2.3, decelKtPerSec: 6.0,
  rotateSpeedKt: 115, climbSpeedKt: 150, cruiseSpeedKt: 250, approachSpeedKt: 125, touchdownSpeedKt: 120,
  climbRateFpm: 4000, descentRateFpm: 2000, turnRateDegPerSec: 3.0, groundTurnRateDegPerSec: 20,
  minSpeedKt: 110, maxSpeedKt: 330, serviceCeilingFt: 51000,
  takeoffDistanceFt: 6140, landingDistanceFt: 2670, lengthM: 30.3, propulsion: 'turbofan',
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
/** Business jets of the registry (FAA large by weight, but they park on the FBO ramp, not at an airline gate): Citation Excel, Challenger 350, Gulfstream V, Global Express. */
const BUSINESS_JETS: ReadonlySet<string> = new Set(['C56X', 'CL35', 'GLF5', 'GLEX']);
export function isBusinessJetType(type: string): boolean {
  return BUSINESS_JETS.has(type);
}
/** True for military types (Air Guard / Coast Guard callsign forms of JO 7110.65 2-4-20). */
export function isMilitaryType(type: string): boolean {
  return getPerformance(type).military === true;
}

import type { WakeCategory } from './wake';
const registry: Record<string, AircraftPerformance> = {
  C172, A320, B738, BCS3, E175, CRJ9, B752, C208, A319, A20N, A21N, A321,
  B737, B38M, B739, E190, CRJ7, B762, B763, A306, B772, B77W, B788, B789,
  A332, A333, A339, A359, A35K, A388, B744, B748, MD11, DH8D, BE20, BE9L,
  PC12, C402, C56X, CL35, GLF5, GLEX, H65, F16, VEH,
};

/**
 * Same-runway-separation (SRS) category, FAA JO 7110.65 3-9-6 NOTE (aircraft types per JO 7360.1):
 * I = small single-engine propeller-driven <= 12,500 lb and all helicopters; II = small twin-engine propeller-driven <= 12,500 lb;
 * III = all other aircraft. Derived here from the type code; unknown types are I when `category === 'light'`, else III.
 */
const SRS: Record<string, 1 | 2 | 3> = { C172: 1, C182: 1, C152: 1, C210: 1, PA28: 1, SR22: 1, BE36: 1, PA34: 2, BE58: 2, C310: 2, C208: 1, H65: 1, A320: 3, B738: 3, BCS3: 3, E175: 3, CRJ9: 3, B752: 3, F16: 3,
  // Added 2026-10-21: PC12 single-engine turboprop <= 12,500 lb = I; C402 and King Air 90 / 200 twin-engine propeller-driven <= 12,500 lb = II; every other added type (jets, DH8D, heavies) = III.
  PC12: 1, C402: 2, BE20: 2, BE9L: 2 };
export function srsCategory(type: string): 1 | 2 | 3 {
  return SRS[type] ?? (getPerformance(type).category === 'light' ? 1 : 3);
}

/**
 * Wake RECAT category, FAA JO 7110.126A Appendix A (verified by the accuracy review): A320 = F ("other aircraft over 41,000 lb"),
 * C172 = I ("41,000 lb and under"); B757 = E; heavies B / D. Added types follow the same convention: B738 = F (TBL A-1 Upper Large), E175 and CRJ9 = G (TBL A-1 Lower Large: E75L / E75S / CRJ9 read visually on the rendered page A1, 2026-10-18), BCS3 = F
 * (NOT listed in TBL A-1: kept F by the over-41,000-lb convention, UNVERIFIED); B752 = E (TBL A-1 lists B752 / B753 under E); C208 = I (MTOW 8,750 lb). Types not listed: `wakeCategory` light -> I, medium -> F, heavy -> D, super -> A.
 */
const RECAT: Record<string, WakeCategory> = { C172: 'I', C182: 'I', C152: 'I', C210: 'I', PA28: 'I', SR22: 'I', BE36: 'I', PA34: 'I', BE58: 'I', C310: 'I', C208: 'I', F16: 'G', A320: 'F', B738: 'F', BCS3: 'F', E175: 'G', CRJ9: 'G', B752: 'E',
  // Added 2026-10-21, JO 7110.126A TBL A-1 (page A1, read visually 2026-10-21). A = A388; B = A332 A333 A359 B744 B748 B772 B77W B788 B789; C = A306 B762 B763 MD11; D = A339;
  // F = A319 A321 B737 B739 DH8D E190 GLEX GLF5; G = CRJ7; H = C56X; I = C402 PC12 BE20. NOT in TBL A-1 (derived, UNVERIFIED as listings): A20N, A21N, B38M = F (sibling types
  // are F), A35K = B (A359 is B), BE9L = I (10,100 lb MTOW is within the Category I definition, 15,400 lb or less), CL35 = H (40,600 lb is within the Category H definition).
  A319: 'F', A20N: 'F', A21N: 'F', A321: 'F', B737: 'F', B38M: 'F', B739: 'F', E190: 'F', CRJ7: 'G', B762: 'C', B763: 'C', A306: 'C', B772: 'B', B77W: 'B', B788: 'B', B789: 'B',
  A332: 'B', A333: 'B', A339: 'D', A359: 'B', A35K: 'B', A388: 'A', B744: 'B', B748: 'B', MD11: 'C', DH8D: 'F', BE20: 'I', BE9L: 'I', PC12: 'I', C402: 'I', C56X: 'H', CL35: 'H',
  GLF5: 'F', GLEX: 'F' };
export function wakeRecatCategory(type: string): WakeCategory {
  const known = RECAT[type];
  if (known) return known;
  const w = getPerformance(type).wakeCategory;
  return w === 'light' ? 'I' : w === 'medium' ? 'F' : w === 'super' ? 'A' : 'D';
}

/**
 * The word a pilot and the controller add to the callsign: "super" for RECAT Category A (the A388), "heavy" for Categories B, C and D, none otherwise.
 * FAA JO 7110.126A Appendix B (amended JO 7110.65 2-4-14 and 2-1-20): "the word Super must be used as part of the identification in all communications
 * with or about Category A aircraft", "Heavy" likewise for B, C and D. ICAO Doc 4444 / Doc 4444 wake category H ("Heavy") and J ("Super") give the same
 * words (the A388 is J, the B744 / B772 / B788 H). The B757 (Category E) is neither. `wakeCategory` 'heavy' / 'super' follow the ICAO category in the ACD.
 */
export function wakeCallsignWord(type: string): 'super' | 'heavy' | undefined {
  const c = wakeRecatCategory(type);
  return c === 'A' ? 'super' : c === 'B' || c === 'C' || c === 'D' ? 'heavy' : undefined;
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
