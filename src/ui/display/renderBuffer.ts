/**
 * Smooth-motion buffer. The engine steps at 10 Hz of sim time while the canvas draws at display rate,
 * so renderers draw the aircraft at a pose interpolated between the last two engine snapshots.
 *
 * Usage: the session calls `capture()` whenever `clock.tick` advanced; renderers call `sample()` each frame
 * with the current wall-clock time. Rendering is therefore one snapshot interval behind the engine
 * (typically <= 100 ms), which is the standard price for jitter-free motion.
 */
import type { Aircraft, SimulationState } from '../../sim/types';
import { lerp, lerpAngleDeg } from '../lib/geom';

export interface Pose {
  x: number;
  y: number;
  headingDeg: number;
  altitudeFt: number;
  groundSpeedKt: number;
}

export const poseOf = (a: Aircraft): Pose => ({
  x: a.pos.x, y: a.pos.y, headingDeg: a.headingDeg, altitudeFt: a.altitudeFt, groundSpeedKt: a.groundSpeedKt,
});

export function interpolatePose(a: Pose, b: Pose, t: number): Pose {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    headingDeg: lerpAngleDeg(a.headingDeg, b.headingDeg, t),
    altitudeFt: lerp(a.altitudeFt, b.altitudeFt, t),
    groundSpeedKt: lerp(a.groundSpeedKt, b.groundSpeedKt, t),
  };
}

/** Fraction (0..1) of the way from the previous to the current snapshot. */
export function interpolationAlpha(nowMs: number, currMs: number, prevMs: number, minIntervalMs = 16, maxIntervalMs = 250): number {
  const interval = Math.min(maxIntervalMs, Math.max(minIntervalMs, currMs - prevMs));
  return Math.min(1, Math.max(0, (nowMs - currMs) / interval));
}

export interface RenderBuffer {
  capture(state: SimulationState, nowMs: number): void;
  /** Interpolated pose; falls back to the live aircraft state when it is not buffered yet. */
  sample(ac: Aircraft, nowMs: number): Pose;
  /** Drop everything (new session). */
  reset(): void;
  lastTick(): number;
}

export function createRenderBuffer(): RenderBuffer {
  let prev = new Map<string, Pose>();
  let curr = new Map<string, Pose>();
  let prevMs = 0;
  let currMs = 0;
  let tick = -1;
  return {
    capture(state, nowMs) {
      prev = curr;
      prevMs = currMs;
      curr = new Map();
      for (const ac of Object.values(state.aircraft)) curr.set(ac.id, poseOf(ac));
      currMs = nowMs;
      tick = state.clock.tick;
    },
    sample(ac, nowMs) {
      const c = curr.get(ac.id);
      if (!c) return poseOf(ac);
      const p = prev.get(ac.id);
      if (!p) return c;
      return interpolatePose(p, c, interpolationAlpha(nowMs, currMs, prevMs));
    },
    reset() {
      prev = new Map();
      curr = new Map();
      tick = -1;
    },
    lastTick: () => tick,
  };
}
