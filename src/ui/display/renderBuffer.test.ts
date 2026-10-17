import { describe, expect, it } from 'vitest';
import { createRenderBuffer, interpolatePose, interpolationAlpha } from './renderBuffer';
import { lerpAngleDeg } from '../lib/geom';
import type { Aircraft, SimulationState } from '../../sim/types';

const pose = (x: number, y: number, h: number, alt = 0) => ({ x, y, headingDeg: h, altitudeFt: alt, groundSpeedKt: 10 });

describe('interpolation', () => {
  it('interpolates position linearly', () => {
    const p = interpolatePose(pose(0, 0, 90, 0), pose(10, -20, 90, 1000), 0.25);
    expect(p.x).toBeCloseTo(2.5);
    expect(p.y).toBeCloseTo(-5);
    expect(p.altitudeFt).toBeCloseTo(250);
  });
  it('turns the short way round through north', () => {
    expect(lerpAngleDeg(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(lerpAngleDeg(10, 350, 0.5)).toBeCloseTo(0, 6);
    expect(lerpAngleDeg(90, 180, 0.5)).toBeCloseTo(135);
    expect(interpolatePose(pose(0, 0, 359), pose(0, 0, 1), 0.5).headingDeg).toBeCloseTo(0, 6);
  });
  it('alpha is the time since the last snapshot over the snapshot interval, clamped', () => {
    expect(interpolationAlpha(1050, 1000, 900)).toBeCloseTo(0.5);
    expect(interpolationAlpha(1000, 1000, 900)).toBe(0);
    expect(interpolationAlpha(5000, 1000, 900)).toBe(1);
    expect(interpolationAlpha(990, 1000, 900)).toBe(0);
    // absurd intervals (tab was hidden) are capped so motion never freezes for seconds
    expect(interpolationAlpha(1125, 1000, 0)).toBeCloseTo(0.5);
  });
});

describe('render buffer', () => {
  const ac = (x: number, h = 90): Aircraft => ({ id: 'a1', pos: { x, y: 0 }, headingDeg: h, altitudeFt: 0, groundSpeedKt: 5 }) as unknown as Aircraft;
  const st = (a: Aircraft, tick: number): SimulationState => ({ aircraft: { [a.id]: a }, clock: { tick } }) as unknown as SimulationState;

  it('falls back to live state before two snapshots exist, then moves smoothly between them', () => {
    const buf = createRenderBuffer();
    const a = ac(0);
    expect(buf.sample(a, 0).x).toBe(0);
    buf.capture(st(ac(0), 1), 1000);
    expect(buf.sample(ac(0), 1000).x).toBe(0);
    buf.capture(st(ac(10), 2), 1100);
    const mid = buf.sample(ac(10), 1150).x; // 50 ms into a 100 ms interval
    expect(mid).toBeCloseTo(5);
    expect(buf.sample(ac(10), 1100).x).toBeCloseTo(0);
    expect(buf.sample(ac(10), 1300).x).toBeCloseTo(10);
    expect(buf.lastTick()).toBe(2);
  });

  it('a newly spawned aircraft appears at its spawn pose', () => {
    const buf = createRenderBuffer();
    buf.capture(st(ac(0), 1), 0);
    const fresh = { ...ac(50), id: 'new' } as Aircraft;
    buf.capture({ aircraft: { a1: ac(1), new: fresh }, clock: { tick: 2 } } as unknown as SimulationState, 100);
    expect(buf.sample(fresh, 150).x).toBe(50);
  });
});
