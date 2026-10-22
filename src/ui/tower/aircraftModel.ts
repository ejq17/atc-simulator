/**
 * Pure aircraft helpers for the Tower view: class and model family by type, the real dimensions of each type, gear / pitch / bank /
 * light logic, the world placement/orientation of an aircraft, and the scale that keeps a callsign billboard a constant size on screen.
 * No three.js here: aircraftMeshes.ts turns a ModelSpec into meshes.
 */
import type { Aircraft, FlightPhase } from '../../sim/types';
import { getPerformance } from '../../sim/performance';
import type { Pose } from '../display/renderBuffer';
import { FT } from './geometry';
import type { FuselageStyle } from './liveries';

export type AircraftClass = 'airliner' | 'bizjet' | 'ga' | 'rotorcraft' | 'fighter' | 'vehicle';

/** Model families: each is built by its own recipe in aircraftMeshes.ts. */
export type ModelFamily = 'narrowbody' | 'widebody' | 'widebodyQuad' | 'regionalJet' | 'bizjet' | 'gaHigh' | 'gaLow' | 'turboprop' | 'turbopropSingle' | 'helicopter' | 'fighter' | 'groundVehicle';

/** Families built from a parametric Recipe; the special-traffic families (helicopter, fighter, ground vehicle) have their own builders in specialModels.ts. */
export type RecipeFamily = Exclude<ModelFamily, 'helicopter' | 'fighter' | 'groundVehicle'>;
export const SPECIAL_FAMILIES: ReadonlySet<ModelFamily> = new Set<ModelFamily>(['helicopter', 'fighter', 'groundVehicle']);

/** ICAO type designators of business jets the sim may use; others are classed by length (see classifyAircraft). */
const BIZJET = /^(C25[A-Z0-9]?|C5[0-9]{2}[A-Z]?|C6[0-9]{2}[A-Z]?|C7[0-9]{2}|LJ[0-9]{2}|GLF[0-9]|GL[0-9T]{2,3}|FA[0-9][0-9X]|F2TH|F900|H25[A-C]|E50P|E55P|PRM1|CL[0-9]{2}|SF50|ASTR|G[0-9]{3})$/;

interface TypeDims {
  family: ModelFamily;
  /** Real overall length, wingspan and height (m), used when the performance table has no entry for the type, and for the span/height ratios. */
  len: number; span: number; height: number;
  /** Low wing on a family that is normally high-winged (Beech 1900/King Air 350 are low-winged). */
  low?: boolean;
}

/** Real dimensions (manufacturer data sheets / ICAO airport planning documents). */
const TYPES: Readonly<Record<string, TypeDims>> = {
  A318: { family: 'narrowbody', len: 31.44, span: 34.1, height: 12.56 },
  A319: { family: 'narrowbody', len: 33.84, span: 35.8, height: 11.76 },
  A320: { family: 'narrowbody', len: 37.57, span: 35.8, height: 11.76 },
  A20N: { family: 'narrowbody', len: 37.57, span: 35.8, height: 11.76 },
  A321: { family: 'narrowbody', len: 44.51, span: 35.8, height: 11.76 },
  A21N: { family: 'narrowbody', len: 44.51, span: 35.8, height: 11.76 },
  B737: { family: 'narrowbody', len: 33.6, span: 34.3, height: 12.5 },
  B738: { family: 'narrowbody', len: 39.5, span: 35.8, height: 12.5 },
  B739: { family: 'narrowbody', len: 42.1, span: 35.8, height: 12.5 },
  B38M: { family: 'narrowbody', len: 39.5, span: 35.9, height: 12.3 },
  B752: { family: 'narrowbody', len: 47.3, span: 38.0, height: 13.6 },
  BCS1: { family: 'narrowbody', len: 35.0, span: 35.1, height: 11.5 }, // A220-100
  BCS3: { family: 'narrowbody', len: 38.7, span: 35.1, height: 11.5 }, // A220-300
  // Wide-bodies (EUROCONTROL ACD technical data, retrieved 2026-10-21: length / wing span / height). The MD11 has a third engine in the fin that the twin model does not draw.
  A306: { family: 'widebody', len: 54.1, span: 44.84, height: 16.54 },
  A332: { family: 'widebody', len: 58.8, span: 60.3, height: 17.4 },
  A333: { family: 'widebody', len: 63.6, span: 60.3, height: 16.85 },
  A339: { family: 'widebody', len: 63.66, span: 64.0, height: 16.79 },
  A359: { family: 'widebody', len: 66.9, span: 64.8, height: 17.05 },
  A35K: { family: 'widebody', len: 73.79, span: 64.75, height: 17.08 },
  B762: { family: 'widebody', len: 48.5, span: 47.6, height: 15.9 },
  B763: { family: 'widebody', len: 54.9, span: 47.6, height: 15.9 },
  B772: { family: 'widebody', len: 63.7, span: 60.9, height: 18.4 },
  B77W: { family: 'widebody', len: 73.9, span: 64.8, height: 18.5 },
  B788: { family: 'widebody', len: 56.7, span: 52.0, height: 16.9 },
  B789: { family: 'widebody', len: 62.8, span: 60.12, height: 16.9 },
  MD11: { family: 'widebody', len: 61.2, span: 51.7, height: 17.6 },
  A388: { family: 'widebodyQuad', len: 73.0, span: 79.8, height: 24.1 },
  B744: { family: 'widebodyQuad', len: 70.6, span: 64.8, height: 19.4 },
  B748: { family: 'widebodyQuad', len: 76.3, span: 68.5, height: 19.4 },
  E170: { family: 'narrowbody', len: 29.9, span: 26.0, height: 9.7 },
  E75S: { family: 'narrowbody', len: 31.7, span: 26.0, height: 9.7 },
  E75L: { family: 'narrowbody', len: 31.7, span: 26.0, height: 9.7 },
  E175: { family: 'narrowbody', len: 31.7, span: 26.0, height: 9.7 },
  E190: { family: 'narrowbody', len: 36.2, span: 28.7, height: 10.3 },
  E195: { family: 'narrowbody', len: 38.7, span: 28.7, height: 10.5 },
  CRJ2: { family: 'regionalJet', len: 26.8, span: 21.2, height: 6.2 },
  CRJ7: { family: 'regionalJet', len: 32.5, span: 23.2, height: 7.5 },
  CRJ9: { family: 'regionalJet', len: 36.4, span: 24.9, height: 7.5 },
  CRJX: { family: 'regionalJet', len: 39.1, span: 26.2, height: 7.5 },
  DH8D: { family: 'turboprop', len: 32.8, span: 28.4, height: 8.3 },
  DH8C: { family: 'turboprop', len: 25.7, span: 27.4, height: 7.5 },
  AT72: { family: 'turboprop', len: 27.2, span: 27.05, height: 7.65 },
  AT75: { family: 'turboprop', len: 27.2, span: 27.05, height: 7.65 },
  B350: { family: 'turboprop', len: 14.22, span: 17.65, height: 4.37, low: true },
  C208: { family: 'turbopropSingle', len: 11.46, span: 15.88, height: 4.52 },
  PC12: { family: 'turbopropSingle', len: 14.4, span: 16.28, height: 4.26 },
  C25A: { family: 'bizjet', len: 13.0, span: 14.3, height: 4.2 },
  C25B: { family: 'bizjet', len: 14.4, span: 15.9, height: 4.6 },
  C510: { family: 'bizjet', len: 12.2, span: 13.2, height: 4.1 },
  C56X: { family: 'bizjet', len: 15.8, span: 17.0, height: 5.2 }, // ACD (was 19.4 / 17.2 / 5.8, which are not Citation Excel figures)
  CL35: { family: 'bizjet', len: 20.9, span: 21.0, height: 6.1 },
  GLEX: { family: 'bizjet', len: 30.3, span: 28.6, height: 7.6 },
  // King Air 200 / 90: low-wing twin turboprops (drawn with the turboprop recipe, low wing). Cessna 402C: twin piston, drawn with the single-prop low-wing GA recipe (no twin-piston model).
  BE20: { family: 'turboprop', len: 13.4, span: 16.6, height: 4.5, low: true },
  BE9L: { family: 'turboprop', len: 10.8, span: 15.3, height: 4.3, low: true },
  C402: { family: 'gaLow', len: 11.1, span: 13.5, height: 3.6 },
  LJ45: { family: 'bizjet', len: 17.7, span: 14.5, height: 4.3 },
  E50P: { family: 'bizjet', len: 12.8, span: 12.8, height: 4.3 },
  E55P: { family: 'bizjet', len: 15.9, span: 16.2, height: 5.0 },
  GLF4: { family: 'bizjet', len: 26.9, span: 23.7, height: 7.4 },
  GLF5: { family: 'bizjet', len: 29.4, span: 28.5, height: 7.9 },
  GLF6: { family: 'bizjet', len: 30.4, span: 30.4, height: 7.8 },
  C172: { family: 'gaHigh', len: 8.28, span: 11.0, height: 2.72 },
  C182: { family: 'gaHigh', len: 8.84, span: 10.97, height: 2.8 },
  C152: { family: 'gaHigh', len: 7.34, span: 10.16, height: 2.6 },
  C206: { family: 'gaHigh', len: 8.6, span: 10.97, height: 2.8 },
  C210: { family: 'gaHigh', len: 8.59, span: 11.2, height: 2.9 },
  PA28: { family: 'gaLow', len: 7.2, span: 10.8, height: 2.2 },
  SR22: { family: 'gaLow', len: 7.92, span: 11.68, height: 2.7 },
  SR20: { family: 'gaLow', len: 7.92, span: 10.85, height: 2.7 },
  DA40: { family: 'gaLow', len: 8.06, span: 11.94, height: 2.0 },
  BE36: { family: 'gaLow', len: 8.4, span: 10.2, height: 2.5 },
  M20P: { family: 'gaLow', len: 7.7, span: 11.0, height: 2.3 },
  // Special traffic. H65: length with the rotors turning, rotor diameter 39 ft 2 in, height 13 ft 1 in (USCG MH-65 fact sheet / Airbus AS365N).
  // F16: USAF F-16C fact sheet (length 49 ft 5 in, span 32 ft 8 in over the wingtip missiles, height 16 ft). VEH: a full-size pickup, 5.5 m.
  H65: { family: 'helicopter', len: 13.54, span: 11.94, height: 3.99 },
  F16: { family: 'fighter', len: 15.06, span: 9.96, height: 4.88 },
  VEH: { family: 'groundVehicle', len: 5.5, span: 2.0, height: 1.9 },
};

/** The model family of a type: the table above, else a guess from the designator and the performance category/length. */
export function familyOf(type: string): ModelFamily {
  const known = TYPES[type];
  if (known) return known.family;
  const perf = getPerformance(type);
  if (BIZJET.test(type)) return 'bizjet';
  if (perf.category === 'light' || perf.lengthM < 14) return /^(PA|SR|DA|BE|M2|CH|RV)/.test(type) ? 'gaLow' : 'gaHigh';
  if (/^(DH8|AT7)/.test(type)) return 'turboprop';
  if (perf.category === 'heavy') return perf.lengthM > 68 && /^(B74|A38)/.test(type) ? 'widebodyQuad' : 'widebody';
  if (type.startsWith('CRJ')) return 'regionalJet';
  return perf.lengthM < 22 && !/^(A3|B7|E1|E7)/.test(type) ? 'bizjet' : 'narrowbody';
}

const FAMILY_CLASS: Record<ModelFamily, AircraftClass> = {
  narrowbody: 'airliner', widebody: 'airliner', widebodyQuad: 'airliner', regionalJet: 'airliner', turboprop: 'airliner', bizjet: 'bizjet', gaHigh: 'ga', gaLow: 'ga', turbopropSingle: 'ga',
  helicopter: 'rotorcraft', fighter: 'fighter', groundVehicle: 'vehicle',
};

export function classifyAircraft(type: string): AircraftClass {
  return FAMILY_CLASS[familyOf(type)];
}

/** Families whose gear retracts. GA singles and the Caravan keep fixed gear. */
export const RETRACTABLE: Readonly<Record<ModelFamily, boolean>> = {
  narrowbody: true, widebody: true, widebodyQuad: true, regionalJet: true, turboprop: true, bizjet: true, gaHigh: false, gaLow: false, turbopropSingle: false,
  helicopter: false, fighter: true, groundVehicle: false,
};

/** Default ratios for a family when the type has no table entry (wingspan / length, height / length). */
const FAMILY_RATIOS: Record<ModelFamily, { span: number; height: number }> = {
  narrowbody: { span: 0.95, height: 0.31 }, widebody: { span: 0.95, height: 0.28 }, widebodyQuad: { span: 0.95, height: 0.27 }, regionalJet: { span: 0.68, height: 0.205 }, turboprop: { span: 1.0, height: 0.27 },
  bizjet: { span: 1.0, height: 0.31 }, gaHigh: { span: 1.33, height: 0.33 }, gaLow: { span: 1.45, height: 0.3 }, turbopropSingle: { span: 1.38, height: 0.39 },
  helicopter: { span: 0.88, height: 0.295 }, fighter: { span: 0.66, height: 0.324 }, groundVehicle: { span: 0.36, height: 0.345 },
};

export interface ModelDims { lengthM: number; wingspanM: number; heightM: number; cls: AircraftClass; family: ModelFamily; lowWing: boolean }

/**
 * Length from the performance table when the type is registered there (it is the sim's own size for the type), else the real length of
 * the type; wingspan and height keep the real span/length and height/length ratios of that type.
 */
export function aircraftDims(type: string): ModelDims {
  const family = familyOf(type);
  const perf = getPerformance(type);
  const t = TYPES[type];
  const registered = perf.type === type;
  const lengthM = registered || !t ? perf.lengthM : t.len;
  const spanRatio = t ? t.span / t.len : FAMILY_RATIOS[family].span;
  const heightRatio = t ? t.height / t.len : FAMILY_RATIOS[family].height;
  const lowWing = family === 'gaLow' || family === 'narrowbody' || family === 'widebody' || family === 'widebodyQuad' || family === 'regionalJet' || family === 'bizjet' || !!t?.low;
  return { lengthM, wingspanM: lengthM * spanRatio, heightM: lengthM * heightRatio, cls: FAMILY_CLASS[family], family, lowWing };
}

// ---- family proportions -------------------------------------------------------------------------------------------------------------

/** Parametric proportions of a family (fractions of the aircraft length unless noted); read by the 3D models and the 2D glyphs. */
export interface Recipe {
  /** Fuselage radius as a fraction of the length, vertical stretch, belly clearance (fraction of length). */
  R: number; sq: number; clear: number;
  /** Jet fuselage: ogive nose length and tail cone length in radii, tail upsweep in radii. GA fuselages use `gaProfile`. */
  nose: number; tail: number; up: number;
  gaProfile?: boolean;
  wing: {
    t0: number; rc: number; tc: number; sweep: number; dih: number; high: boolean; winglet: number; thick: number; struts?: boolean;
  };
  fin: { rc: number; tc: number; sweep: number; zTE: number };
  stab: { span: number; rc: number; tc: number; sweep: number; zTE: number; tTail: boolean };
  engines: 'wing' | 'rear' | 'turboprop' | 'nose';
  /** `x2`: spanwise position (fraction of the semi-span) of a second, outboard engine on each wing (four-engine types). */
  engine: { r: number; len: number; x: number; x2?: number };
  /** Main gear at this fraction of the length from the nose, half track (fraction of length), wheel radius (fraction of length). */
  gear: { nose: number; main: number; track: number; wheelR: number; pants: boolean; twin: boolean };
  prop?: { r: number; blades: number };
  windowsPerLen: number;
  style: FuselageStyle;
}

export const RECIPES: Record<RecipeFamily, Recipe> = {
  // A320 / B738 / A220 / E-jets: low swept wing with sharklets, underwing turbofans, conventional tail.
  narrowbody: {
    R: 0.05, sq: 1, clear: 0.045, nose: 2.8, tail: 5.2, up: 0.9,
    wing: { t0: 0.36, rc: 0.165, tc: 0.045, sweep: 27, dih: 5, high: false, winglet: 0.062, thick: 0.13 },
    fin: { rc: 0.17, tc: 0.065, sweep: 36, zTE: 0.045 },
    stab: { span: 0.35, rc: 0.075, tc: 0.03, sweep: 32, zTE: 0.03, tTail: false },
    engines: 'wing', engine: { r: 0.027, len: 0.105, x: 0.32 },
    gear: { nose: 0.12, main: 0.45, track: 0.1, wheelR: 0.0155, pants: false, twin: true },
    windowsPerLen: 1.4, style: 'airliner',
  },
  // 777 / 787 / A330 / A350 / 767 / A300 / MD11: wide fuselage, long swept wing, two large underwing turbofans.
  widebody: {
    R: 0.048, sq: 1, clear: 0.04, nose: 2.9, tail: 5.6, up: 0.9,
    wing: { t0: 0.37, rc: 0.15, tc: 0.04, sweep: 32, dih: 5, high: false, winglet: 0.03, thick: 0.12 },
    fin: { rc: 0.15, tc: 0.06, sweep: 40, zTE: 0.04 },
    stab: { span: 0.31, rc: 0.075, tc: 0.03, sweep: 35, zTE: 0.03, tTail: false },
    engines: 'wing', engine: { r: 0.03, len: 0.095, x: 0.33 },
    gear: { nose: 0.1, main: 0.5, track: 0.07, wheelR: 0.0165, pants: false, twin: true },
    windowsPerLen: 1.4, style: 'airliner',
  },
  // 747 / A380: as the wide-body with four underwing engines.
  widebodyQuad: {
    R: 0.05, sq: 1.02, clear: 0.04, nose: 2.9, tail: 5.6, up: 0.9,
    wing: { t0: 0.38, rc: 0.17, tc: 0.045, sweep: 37, dih: 5, high: false, winglet: 0.02, thick: 0.12 },
    fin: { rc: 0.15, tc: 0.06, sweep: 40, zTE: 0.04 },
    stab: { span: 0.32, rc: 0.08, tc: 0.03, sweep: 37, zTE: 0.03, tTail: false },
    engines: 'wing', engine: { r: 0.026, len: 0.085, x: 0.3, x2: 0.6 },
    gear: { nose: 0.1, main: 0.5, track: 0.075, wheelR: 0.0155, pants: false, twin: true },
    windowsPerLen: 1.4, style: 'airliner',
  },
  // CRJ: low wing with winglets, aft-mounted engines, T-tail.
  regionalJet: {
    R: 0.037, sq: 1, clear: 0.032, nose: 3.0, tail: 6.2, up: 0.8,
    wing: { t0: 0.38, rc: 0.12, tc: 0.034, sweep: 26, dih: 3, high: false, winglet: 0.04, thick: 0.13 },
    fin: { rc: 0.15, tc: 0.065, sweep: 40, zTE: 0.02 },
    stab: { span: 0.37, rc: 0.065, tc: 0.028, sweep: 32, zTE: 0.0, tTail: true },
    engines: 'rear', engine: { r: 0.022, len: 0.095, x: 0 },
    gear: { nose: 0.11, main: 0.5, track: 0.08, wheelR: 0.015, pants: false, twin: true },
    windowsPerLen: 1.5, style: 'regional',
  },
  // Citation / Learjet / Gulfstream / Phenom: slender fuselage, swept low wing, aft engines, T-tail.
  bizjet: {
    R: 0.047, sq: 1, clear: 0.04, nose: 3.4, tail: 5.8, up: 0.6,
    wing: { t0: 0.4, rc: 0.13, tc: 0.05, sweep: 22, dih: 3, high: false, winglet: 0.05, thick: 0.12 },
    fin: { rc: 0.15, tc: 0.07, sweep: 40, zTE: 0.0 },
    stab: { span: 0.36, rc: 0.065, tc: 0.03, sweep: 30, zTE: -0.01, tTail: true },
    engines: 'rear', engine: { r: 0.024, len: 0.115, x: 0 },
    gear: { nose: 0.17, main: 0.52, track: 0.09, wheelR: 0.0225, pants: false, twin: false },
    windowsPerLen: 1.0, style: 'bizjet',
  },
  // DH8D / ATR 72: high straight wing, wing nacelles with propellers, T-tail.
  turboprop: {
    R: 0.045, sq: 1, clear: 0.034, nose: 2.2, tail: 5.2, up: 0.8,
    wing: { t0: 0.34, rc: 0.105, tc: 0.062, sweep: 3, dih: 2, high: true, winglet: 0, thick: 0.13 },
    fin: { rc: 0.13, tc: 0.06, sweep: 36, zTE: 0.02 },
    stab: { span: 0.4, rc: 0.06, tc: 0.04, sweep: 10, zTE: 0.0, tTail: true },
    engines: 'turboprop', engine: { r: 0.02, len: 0.14, x: 0.34 },
    gear: { nose: 0.1, main: 0.42, track: 0.09, wheelR: 0.016, pants: false, twin: true },
    prop: { r: 0.06, blades: 4 },
    windowsPerLen: 1.3, style: 'turboprop',
  },
  // Cessna 172 / 182: high wing with struts, fixed tricycle gear with wheel fairings, nose propeller.
  gaHigh: {
    R: 0.085, sq: 1.12, clear: 0.058, nose: 0, tail: 0, up: 0.5, gaProfile: true,
    wing: { t0: 0.27, rc: 0.19, tc: 0.135, sweep: 0, dih: 1.5, high: true, winglet: 0, thick: 0.1, struts: true },
    fin: { rc: 0.15, tc: 0.075, sweep: 32, zTE: 0.01 },
    stab: { span: 0.32, rc: 0.115, tc: 0.085, sweep: 5, zTE: 0.0, tTail: false },
    engines: 'nose', engine: { r: 0, len: 0, x: 0 },
    gear: { nose: 0.2, main: 0.4, track: 0.165, wheelR: 0.026, pants: true, twin: false },
    prop: { r: 0.115, blades: 2 },
    windowsPerLen: 0, style: 'ga',
  },
  // Piper PA-28 / Cirrus SR22 / Diamond DA40: low wing, fixed tricycle gear, nose propeller.
  gaLow: {
    R: 0.08, sq: 1.1, clear: 0.058, nose: 0, tail: 0, up: 0.4, gaProfile: true,
    wing: { t0: 0.33, rc: 0.2, tc: 0.15, sweep: 0, dih: 5, high: false, winglet: 0, thick: 0.1 },
    fin: { rc: 0.15, tc: 0.075, sweep: 32, zTE: 0.01 },
    stab: { span: 0.33, rc: 0.11, tc: 0.08, sweep: 4, zTE: 0.0, tTail: false },
    engines: 'nose', engine: { r: 0, len: 0, x: 0 },
    gear: { nose: 0.17, main: 0.4, track: 0.17, wheelR: 0.026, pants: true, twin: false },
    prop: { r: 0.115, blades: 2 },
    windowsPerLen: 0, style: 'ga',
  },
  // Cessna 208 Caravan / PC-12: stout single turboprop, high wing with struts.
  turbopropSingle: {
    R: 0.072, sq: 1.15, clear: 0.065, nose: 0, tail: 0, up: 0.4, gaProfile: true,
    wing: { t0: 0.3, rc: 0.15, tc: 0.1, sweep: 0, dih: 2, high: true, winglet: 0, thick: 0.1, struts: true },
    fin: { rc: 0.14, tc: 0.07, sweep: 35, zTE: 0.0 },
    stab: { span: 0.36, rc: 0.1, tc: 0.07, sweep: 5, zTE: 0.0, tTail: false },
    engines: 'nose', engine: { r: 0, len: 0, x: 0 },
    gear: { nose: 0.2, main: 0.42, track: 0.14, wheelR: 0.03, pants: false, twin: false },
    prop: { r: 0.11, blades: 3 },
    windowsPerLen: 0, style: 'ga',
  },
};


// ---- gear, pitch, bank and lights ------------------------------------------------------------------------------------------------

/** Height above the field (ft) above which a retractable gear is up after takeoff. */
export const GEAR_UP_AGL_FT = 200;

export interface FlightState { onGround: boolean; aglFt: number; verticalSpeedFpm: number; phase: FlightPhase }

const FINAL_PHASES: ReadonlySet<string> = new Set(['FINAL', 'LANDING', 'ROLLOUT', 'PATTERN']);

/** Whether the gear is extended. Fixed-gear types always are; retractable gear is up above ~200 ft AGL unless on final or descending low. */
export function gearDown(family: ModelFamily, s: FlightState): boolean {
  if (!RETRACTABLE[family]) return true;
  if (s.onGround || s.aglFt <= GEAR_UP_AGL_FT) return true;
  if (FINAL_PHASES.has(s.phase)) return true;
  return s.verticalSpeedFpm < -200 && s.aglFt < 2500;
}

const DEG = Math.PI / 180;

/**
 * Model pitch: about 3 degrees nose-up on final, 6 to 8 degrees climbing, a rotation of 6 degrees past the rotate speed on the roll, and
 * the flight-path angle plus 2 degrees otherwise (the same range as pitchFromVerticalSpeed).
 */
export function modelPitchRad(type: string, s: FlightState & { groundSpeedKt: number }): number {
  if (s.onGround) {
    const rotate = getPerformance(type).rotateSpeedKt;
    return s.phase === 'TAKEOFF_ROLL' && s.groundSpeedKt > rotate ? 6 * DEG : 0;
  }
  const base = pitchFromVerticalSpeed(s.verticalSpeedFpm, s.groundSpeedKt, false);
  if (s.verticalSpeedFpm > 250) return Math.max(6 * DEG, Math.min(8 * DEG, base + 4 * DEG));
  if (FINAL_PHASES.has(s.phase) || (s.verticalSpeedFpm < -200 && s.aglFt < 3000)) return 3 * DEG;
  return base;
}

/** Bank angle for a coordinated turn at the given turn rate (deg/s, positive clockwise) and ground speed; positive = right wing down. */
export function bankFromTurnRate(turnRateDegPerSec: number, groundSpeedKt: number, maxBankDeg = 30): number {
  const v = groundSpeedKt * 0.514444;
  const bank = Math.atan((turnRateDegPerSec * DEG * v) / 9.81);
  const lim = maxBankDeg * DEG;
  return Math.max(-lim, Math.min(lim, bank));
}

export interface LightInput { lightsOn: boolean; onGround: boolean; aglFt: number; phase: FlightPhase; nowMs: number; seed: number }
export interface LightState { nav: boolean; strobe: boolean; beacon: boolean; landing: boolean }

const ROLL_PHASES: ReadonlySet<string> = new Set(['LINE_UP_AND_WAIT', 'CLEARED_FOR_TAKEOFF', 'TAKEOFF_ROLL']);
const COLD_PHASES: ReadonlySet<string> = new Set(['PARKED', 'ARRIVED']);

/**
 * Exterior lights: position lights always on in the dark; red beacon (rotating, ~45% duty) while the engines run; double-flash strobes on
 * the runway and airborne; landing lights from line-up through the takeoff roll, on final and below 10,000 ft AGL.
 */
export function lightState(i: LightInput): LightState {
  const on = i.lightsOn;
  const phaseMs = (i.nowMs + (i.seed % 700)) % 1200;
  return {
    nav: on,
    beacon: on && !COLD_PHASES.has(i.phase) && phaseMs < 540,
    strobe: on && (!i.onGround || ROLL_PHASES.has(i.phase) || i.phase === 'LANDING' || i.phase === 'ROLLOUT') && (phaseMs < 80 || (phaseMs > 160 && phaseMs < 240)),
    landing: on && (ROLL_PHASES.has(i.phase) || FINAL_PHASES.has(i.phase) || (!i.onGround && i.aglFt < 10000)),
  };
}

/** Amber rotating beacon of an airport vehicle: always running (day and night), a 1 s cycle that is on for 55 percent of it. */
export function vehicleBeacon(nowMs: number, seed: number): boolean {
  return ((nowMs + (seed % 500)) % 1000) < 550;
}

export interface Placement {
  /** Scene coordinates (x east, y up, z = -north), origin = point of the aircraft on the ground. */
  x: number;
  y: number;
  z: number;
  /** Rotation about +y so the model's -z nose points along the heading. */
  yawRad: number;
  /** Nose-up positive. */
  pitchRad: number;
}

/**
 * Flight-path-ish pitch from vertical speed and ground speed while airborne, clamped to the believable range of the sim's
 * climbs/descents; zero on the ground. A small nose-up attitude bias keeps a level aircraft from looking nose-down.
 */
export function pitchFromVerticalSpeed(verticalSpeedFpm: number, groundSpeedKt: number, onGround: boolean): number {
  if (onGround) return 0;
  const vMs = verticalSpeedFpm * FT / 60;
  const gMs = Math.max(20, groundSpeedKt) * 0.514444; // floor so a slow aircraft does not pitch to 90 degrees
  const gamma = Math.atan2(vMs, gMs);
  const limit = (20 * Math.PI) / 180;
  return Math.max(-limit, Math.min(limit, gamma + (2 * Math.PI) / 180));
}

export function placeAircraft(ac: Pick<Aircraft, 'onGround' | 'verticalSpeedFpm'>, pose: Pose, fieldElevationFt: number): Placement {
  const y = ac.onGround ? 0 : Math.max(0, (pose.altitudeFt - fieldElevationFt) * FT);
  return {
    x: pose.x,
    y,
    z: -pose.y,
    yawRad: (-pose.headingDeg * Math.PI) / 180,
    pitchRad: pitchFromVerticalSpeed(ac.verticalSpeedFpm, pose.groundSpeedKt, ac.onGround),
  };
}

/**
 * World-space height of a billboard that is `desiredPx` tall on a viewport `viewportPx` tall, at `distance` metres, with a vertical
 * field of view of `fovDeg`. Recomputed every frame, this is what keeps a callsign tag the same size at 500 m and at 20 km.
 */
export function billboardWorldHeight(distance: number, fovDeg: number, viewportPx: number, desiredPx: number): number {
  const visible = 2 * Math.max(1, distance) * Math.tan((fovDeg * Math.PI) / 360);
  return (visible * desiredPx) / Math.max(1, viewportPx);
}

/** Which aircraft get a model/billboard: everything within the radar range (nm) of the tower. */
export function withinRange(dx: number, dy: number, rangeNm: number): boolean {
  return Math.hypot(dx, dy) <= rangeNm * 1852;
}
