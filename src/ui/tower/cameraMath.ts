/**
 * Pure camera math for the Tower view. Yaw is a TRUE bearing in degrees clockwise from north (the same convention as every heading
 * in the sim); pitch is degrees above the horizon. The scene frame is x = east, y = up, z = -north (see geometry.ts).
 */
import type { Runway, Vec2 } from '../../sim/types';
import { toScene } from './geometry';

export const FOV_MIN = 4;
export const FOV_MAX = 90;
export const FOV_DEFAULT = 60;
export const FOV_BINOCULARS = 7;
export const PITCH_MIN = -45;
export const PITCH_MAX = 80;

export interface CamState { yawDeg: number; pitchDeg: number; fovDeg: number; binoculars: boolean; savedFovDeg: number }

export const norm360 = (d: number) => ((d % 360) + 360) % 360;
export const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function initialCam(yawDeg = 0): CamState {
  return { yawDeg: norm360(yawDeg), pitchDeg: -3, fovDeg: FOV_DEFAULT, binoculars: false, savedFovDeg: FOV_DEFAULT };
}

/** Unit view direction in scene coordinates. */
export function lookDirection(yawDeg: number, pitchDeg: number): [number, number, number] {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
}

/** Scene-space point `dist` ahead of `eye` along the current view (for `camera.lookAt`). */
export function lookAtPoint(eye: [number, number, number], yawDeg: number, pitchDeg: number, dist = 100): [number, number, number] {
  const d = lookDirection(yawDeg, pitchDeg);
  return [eye[0] + d[0] * dist, eye[1] + d[1] * dist, eye[2] + d[2] * dist];
}

/** True bearing (deg) and elevation (deg) from the eye (sim x/y metres, eye height above the field) to a target (sim x/y, height above the field). */
export function bearingAndElevation(eye: Vec2, eyeH: number, target: Vec2, targetH: number): { bearingDeg: number; elevationDeg: number; distance: number } {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const ground = Math.hypot(dx, dy);
  return {
    bearingDeg: norm360((Math.atan2(dx, dy) * 180) / Math.PI),
    elevationDeg: (Math.atan2(targetH - eyeH, Math.max(1, ground)) * 180) / Math.PI,
    distance: Math.hypot(ground, targetH - eyeH),
  };
}

/** Drag: moving the pointer right swings the view right (grabbing the world), scaled by the field of view so zoomed-in drags stay fine. */
export function applyDrag(cam: CamState, dxPx: number, dyPx: number, viewportHeightPx: number): CamState {
  const degPerPx = cam.fovDeg / Math.max(1, viewportHeightPx);
  return { ...cam, yawDeg: norm360(cam.yawDeg - dxPx * degPerPx), pitchDeg: clampNum(cam.pitchDeg + dyPx * degPerPx, PITCH_MIN, PITCH_MAX) };
}

/** Wheel / +- zoom changes the field of view; `factor` > 1 zooms in. Leaves binocular mode (an explicit zoom overrides it). */
export function applyZoom(cam: CamState, factor: number): CamState {
  const fov = clampNum(cam.fovDeg / factor, FOV_MIN, FOV_MAX);
  return { ...cam, fovDeg: fov, binoculars: false, savedFovDeg: fov };
}

export function toggleBinoculars(cam: CamState): CamState {
  return cam.binoculars
    ? { ...cam, binoculars: false, fovDeg: cam.savedFovDeg }
    : { ...cam, binoculars: true, savedFovDeg: cam.fovDeg, fovDeg: FOV_BINOCULARS };
}

export interface RunwayEndTarget { id: string; runwayId: string; threshold: Vec2 }

export function runwayEndTargets(runways: readonly Runway[]): RunwayEndTarget[] {
  return runways.flatMap((r) => r.ends.map((e) => ({ id: e.id, runwayId: r.id, threshold: e.threshold })));
}

/** Point the camera at a runway threshold, slightly below the horizon (the pavement), at the standard field of view. */
export function snapToPoint(cam: CamState, eye: Vec2, eyeH: number, target: Vec2): CamState {
  const t = bearingAndElevation(eye, eyeH, target, 0);
  return { ...cam, yawDeg: t.bearingDeg, pitchDeg: clampNum(t.elevationDeg + 1.5, PITCH_MIN, PITCH_MAX) };
}

/** Shortest signed angular difference b - a in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  const d = norm360(b - a);
  return d > 180 ? d - 360 : d;
}

/** Ease toward a target view (used by follow mode). `k` in (0,1] is the fraction of the remaining error closed this frame. */
export function followStep(cam: CamState, targetYawDeg: number, targetPitchDeg: number, k: number): CamState {
  return {
    ...cam,
    yawDeg: norm360(cam.yawDeg + angleDiff(cam.yawDeg, targetYawDeg) * k),
    pitchDeg: clampNum(cam.pitchDeg + (targetPitchDeg - cam.pitchDeg) * k, PITCH_MIN, PITCH_MAX),
  };
}

export interface CompassTick { deg: number; label: string; major: boolean; xFrac: number }

/**
 * Ticks for the heading strip across the top of the view: every 5 degrees (labels every 10, cardinal letters at 90s), positioned as a fraction
 * (0..1) of the strip width given the horizontal field of view. `headingDeg` is the centre of the strip (magnetic if `variationDeg` is passed).
 */
export function compassTicks(centreDeg: number, hFovDeg: number): CompassTick[] {
  const half = hFovDeg / 2;
  const start = Math.ceil((centreDeg - half) / 5) * 5;
  const out: CompassTick[] = [];
  for (let d = start; d <= centreDeg + half; d += 5) {
    const deg = norm360(d);
    const major = deg % 10 === 0;
    const card = ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[deg];
    out.push({ deg, label: card ?? (major ? String(Math.round(deg / 10)).padStart(2, '0') : ''), major, xFrac: 0.5 + (d - centreDeg) / hFovDeg });
  }
  return out;
}

/** Horizontal FOV from the vertical FOV and aspect ratio. */
export function horizontalFov(vFovDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((vFovDeg * Math.PI) / 360) * aspect) * 180) / Math.PI;
}

/** True bearing -> magnetic (`variationDeg` east-positive, like Airport.magneticVariationDeg). */
export function toMagnetic(trueDeg: number, variationDeg: number): number {
  return norm360(trueDeg - variationDeg);
}

export function eyeScene(eye: Vec2, eyeH: number): [number, number, number] {
  return toScene(eye, eyeH);
}
