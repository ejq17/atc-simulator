import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { game } from '../../game';
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import { simUtcMs } from '../../sim/solar';
import { createRealtimeClock } from './realtimeClock';

const airport = loadKacy();
const START_UTC = Date.UTC(2026, 9, 17, 12, 0, 0);

function quietEngine() {
  const scenario = game.buildFreePlay(airport, { seed: 4, weather: 'clear', aircraftCount: 0, arrivalsPerHour: 0, departuresPerHour: 0 });
  return createEngine({ airport, scenario, utcStartMs: START_UTC });
}

/** Advance fake time by `ms` and run one frame at the new instant. */
function frameAfter(clock: ReturnType<typeof createRealtimeClock>, ms: number) {
  vi.advanceTimersByTime(ms);
  clock.frame(performance.now());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_UTC);
});
afterEach(() => vi.useRealTimers());

describe('real-time clock (wall-clock sync)', () => {
  it('takes the real current time as the UTC epoch', () => {
    const engine = quietEngine();
    createRealtimeClock({ engine, realTime: true });
    expect(simUtcMs(engine.getState())).toBe(START_UTC);
  });

  it('does not drift over an hour of jittery frames (including 400 ms stalls the old 0.25 s clamp would have dropped)', () => {
    const engine = quietEngine();
    const clock = createRealtimeClock({ engine, realTime: true });
    const t0 = performance.now();
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    while (performance.now() - t0 < 3600 * 1000) {
      const gap = rnd() < 0.002 ? 400 : 8 + Math.floor(rnd() * 25); // 8-32 ms frames, the odd 400 ms hitch
      frameAfter(clock, gap);
    }
    const elapsed = (performance.now() - t0) / 1000;
    expect(Math.abs(engine.getState().clock.timeSec - elapsed)).toBeLessThan(0.11); // within one 0.1 s engine step
    expect(clock.status().mode).toBe('live');
    expect(clock.status().lagSec).toBeLessThan(0.11);
    // The sim's UTC is the real UTC.
    expect(Math.abs(simUtcMs(engine.getState()) - Date.now())).toBeLessThan(120);
  }, 60000);

  it('catches a deficit up gradually (bounded work per frame), then is exactly on time', () => {
    const engine = quietEngine();
    const clock = createRealtimeClock({ engine, realTime: true, maxCatchUpSecPerFrame: 5 });
    vi.advanceTimersByTime(20000); // 20 s with no frames
    clock.frame(performance.now());
    expect(engine.getState().clock.timeSec).toBeCloseTo(5, 0);
    for (let i = 0; i < 3; i++) clock.frame(performance.now());
    expect(engine.getState().clock.timeSec).toBeCloseTo(20, 0);
  });

  it('drops a gap longer than the resync limit instead of replaying it, and says so', () => {
    const engine = quietEngine();
    const gaps: number[] = [];
    const clock = createRealtimeClock({ engine, realTime: true, resyncGapSec: 60, onResync: (g) => gaps.push(g) });
    frameAfter(clock, 1000);
    frameAfter(clock, 10 * 60 * 1000); // backgrounded tab
    expect(gaps).toHaveLength(1);
    expect(engine.getState().clock.timeSec).toBeLessThan(2);
    // UTC stays real after the resync, and old times keep their original UTC.
    expect(Math.abs(simUtcMs(engine.getState()) - Date.now())).toBeLessThan(120);
    expect(clock.utcAt(0.5)).toBe(START_UTC + 500);
    frameAfter(clock, 1000);
    expect(engine.getState().clock.timeSec).toBeCloseTo(2, 0);
  });

  it('pause stops the sim; resume at 1x re-locks and the UTC epoch jumps forward by the pause so UTC stays real', () => {
    const engine = quietEngine();
    const clock = createRealtimeClock({ engine, realTime: true });
    frameAfter(clock, 5000);
    const before = engine.getState().clock.timeSec;
    clock.setSpeed(0);
    expect(clock.status().mode).toBe('paused');
    frameAfter(clock, 30000);
    expect(engine.getState().clock.timeSec).toBe(before);
    clock.setSpeed(1);
    expect(clock.status().mode).toBe('live');
    frameAfter(clock, 2000);
    expect(engine.getState().clock.timeSec).toBeCloseTo(before + 2, 0);
    expect(Math.abs(simUtcMs(engine.getState()) - Date.now())).toBeLessThan(150);
    // A time before the pause still maps to its original wall-clock instant.
    expect(clock.utcAt(1)).toBe(START_UTC + 1000);
  });

  it('2x / 4x is an override: the lock is released (mode sim) and sim time runs at that multiple', () => {
    const engine = quietEngine();
    const clock = createRealtimeClock({ engine, realTime: true });
    frameAfter(clock, 1000);
    clock.setSpeed(4);
    expect(clock.status()).toMatchObject({ mode: 'sim', speed: 4, realTime: true });
    const t = engine.getState().clock.timeSec;
    for (let i = 0; i < 10; i++) frameAfter(clock, 100); // 1 real second in 100 ms frames
    expect(engine.getState().clock.timeSec - t).toBeCloseTo(4, 0);
  });

  it('choosing 1x again re-locks to the wall clock (epoch moved so UTC is real again)', () => {
    const engine = quietEngine();
    const clock = createRealtimeClock({ engine, realTime: true });
    clock.setSpeed(4);
    for (let i = 0; i < 50; i++) frameAfter(clock, 100); // 5 s real -> 20 s sim: UTC is ~15 s ahead of real
    expect(simUtcMs(engine.getState()) - Date.now()).toBeGreaterThan(10000);
    clock.setSpeed(1);
    expect(clock.status().mode).toBe('live');
    expect(Math.abs(simUtcMs(engine.getState()) - Date.now())).toBeLessThan(120);
    const t = engine.getState().clock.timeSec;
    frameAfter(clock, 3000);
    expect(engine.getState().clock.timeSec - t).toBeCloseTo(3, 0);
  });

  it('pausing from 4x and resuming keeps the override (no silent re-lock)', () => {
    const engine = quietEngine();
    const clock = createRealtimeClock({ engine, realTime: true });
    clock.setSpeed(4);
    clock.setSpeed(0);
    clock.setSpeed(4);
    expect(clock.status().mode).toBe('sim');
  });

  it('with realTime off it is the plain frame-delta clock (legacy behaviour): never LIVE, 0.25 s clamp', () => {
    const engine = quietEngine();
    const clock = createRealtimeClock({ engine, realTime: false, startUtcMs: START_UTC });
    frameAfter(clock, 1000); // one 1 s frame: clamped to 0.25 s
    expect(engine.getState().clock.timeSec).toBeCloseTo(0.2, 1);
    expect(clock.status().mode).toBe('sim');
    clock.setSpeed(1);
    expect(clock.status().mode).toBe('sim');
    expect(clock.utcStartMs()).toBe(START_UTC);
  });
});
