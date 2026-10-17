/**
 * Pure aircraft helpers for the Tower view: class by type, a low-poly part list (boxes and cylinders, no three.js), the
 * world placement/orientation of an aircraft, and the scale that keeps a callsign billboard a constant size on screen.
 */
import type { Aircraft } from '../../sim/types';
import { getPerformance } from '../../sim/performance';
import type { Pose } from '../display/renderBuffer';
import { FT } from './geometry';

export type AircraftClass = 'airliner' | 'bizjet' | 'ga';

/** ICAO type designators of business jets the sim may use; others are classed by length (see classifyAircraft). */
const BIZJET = /^(C25[A-Z0-9]?|C5[0-9]{2}[A-Z]?|C6[0-9]{2}[A-Z]?|C7[0-9]{2}|LJ[0-9]{2}|GLF[0-9]|GL[0-9]T|FA[0-9][0-9X]|F2TH|F900|H25[A-C]|E50P|E55P|PRM1|CL[0-9]{2}|SF50|ASTR|G[0-9]{3})$/;

export function classifyAircraft(type: string): AircraftClass {
  const perf = getPerformance(type);
  if (BIZJET.test(type)) return 'bizjet';
  if (perf.category === 'light' || perf.lengthM < 14) return 'ga';
  return perf.lengthM < 22 && !/^(A3|B7|E1|E7|CRJ|DH8|AT7)/.test(type) ? 'bizjet' : 'airliner';
}

export interface ModelDims { lengthM: number; wingspanM: number; heightM: number; cls: AircraftClass }

export function aircraftDims(type: string): ModelDims {
  const cls = classifyAircraft(type);
  const lengthM = getPerformance(type).lengthM;
  const ratio = cls === 'airliner' ? 0.95 : cls === 'bizjet' ? 0.85 : 1.3; // A320 35.8/37.6, Citation ~0.9, C172 11/8.3
  const heightM = lengthM * (cls === 'airliner' ? 0.32 : cls === 'bizjet' ? 0.3 : 0.33);
  return { lengthM, wingspanM: lengthM * ratio, heightM, cls };
}

export interface ModelPart {
  shape: 'box' | 'cylinder';
  /** Box: width (x), height (y), depth (z). Cylinder: radius, length (along z), unused. */
  size: [number, number, number];
  /** Centre, relative to the aircraft origin (on the ground under the centre of the fuselage), nose toward -z. */
  pos: [number, number, number];
  colour: 'body' | 'wing' | 'accent' | 'dark';
  /** Pitch of the part about x in radians (swept wings are done with boxes only, so this is only used for the tail fin lean). */
  rotX?: number;
}

/** Low-poly part list for a class, dimensioned from the aircraft's length. Pure: the renderer maps it to meshes. */
export function aircraftParts(type: string): ModelPart[] {
  const d = aircraftDims(type);
  const L = d.lengthM;
  const b = d.wingspanM;
  if (d.cls === 'ga') {
    const fr = L * 0.11;
    const belly = L * 0.17; // ground clearance of the fuselage axis
    return [
      { shape: 'cylinder', size: [fr, L * 0.95, 0], pos: [0, belly + fr, 0], colour: 'body' },
      { shape: 'box', size: [b, 0.09, L * 0.17], pos: [0, belly + fr * 2.1, -L * 0.1], colour: 'wing' }, // high wing
      { shape: 'box', size: [L * 0.38, 0.07, L * 0.1], pos: [0, belly + fr * 1.2, L * 0.43], colour: 'wing' }, // tailplane
      { shape: 'box', size: [0.07, L * 0.2, L * 0.12], pos: [0, belly + fr * 1.2 + L * 0.1, L * 0.42], colour: 'accent' }, // fin
      { shape: 'box', size: [0.15, belly, 0.15], pos: [0, belly / 2, -L * 0.28], colour: 'dark' }, // nose gear
      { shape: 'box', size: [L * 0.32, 0.15, 0.15], pos: [0, belly * 0.1, -L * 0.05], colour: 'dark' }, // main gear
      { shape: 'box', size: [0.03, fr * 1.9, fr * 1.9], pos: [0, belly + fr, -L * 0.5], colour: 'dark' }, // prop disc
    ];
  }
  const r = L * (d.cls === 'airliner' ? 0.052 : 0.065);
  const belly = d.cls === 'airliner' ? L * 0.1 : L * 0.1;
  const parts: ModelPart[] = [
    { shape: 'cylinder', size: [r, L * 0.96, 0], pos: [0, belly + r, 0], colour: 'body' },
    { shape: 'box', size: [b, 0.18, L * (d.cls === 'airliner' ? 0.17 : 0.15)], pos: [0, belly + r * 0.5, L * 0.04], colour: 'wing' },
    { shape: 'box', size: [b * 0.34, 0.12, L * 0.09], pos: [0, belly + r * 1.9, L * 0.42], colour: 'wing' },
    { shape: 'box', size: [0.15, L * 0.18, L * 0.14], pos: [0, belly + r * 1.9 + L * 0.09, L * 0.41], colour: 'accent' },
    { shape: 'box', size: [r * 0.5, belly, r * 0.5], pos: [0, belly / 2, -L * 0.3], colour: 'dark' },
    { shape: 'box', size: [r * 2.2, belly, r * 0.6], pos: [0, belly / 2, L * 0.05], colour: 'dark' },
  ];
  if (d.cls === 'airliner') {
    for (const side of [-1, 1]) parts.push({ shape: 'cylinder', size: [r * 0.55, L * 0.12, 0], pos: [side * b * 0.17, belly + r * 0.1, -L * 0.04], colour: 'dark' });
  } else {
    for (const side of [-1, 1]) parts.push({ shape: 'cylinder', size: [r * 0.5, L * 0.14, 0], pos: [side * r * 1.5, belly + r * 1.3, L * 0.33], colour: 'dark' });
  }
  return parts;
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
