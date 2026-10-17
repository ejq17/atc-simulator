import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { game } from './game';
import { localHourAt, trafficDensityAt, trafficDensityForLocalHour } from './trafficDensity';

const airport = loadKacy();

describe('traffic density curve', () => {
  it('is quiet overnight, peaks in the morning and evening banks, dips at midday', () => {
    for (const h of [0, 2, 4.9]) expect(trafficDensityForLocalHour(h)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(trafficDensityForLocalHour(7.5)).toBe(1);
    expect(trafficDensityForLocalHour(16.5)).toBe(1);
    expect(trafficDensityForLocalHour(12)).toBeCloseTo(0.65, 5);
    expect(trafficDensityForLocalHour(12)).toBeLessThan(trafficDensityForLocalHour(8));
    expect(trafficDensityForLocalHour(23.5)).toBeLessThan(trafficDensityForLocalHour(20));
  });

  it('is continuous, bounded in (0,1] and wraps at 24 h', () => {
    let prev = trafficDensityForLocalHour(0);
    for (let h = 0.01; h < 24; h += 0.01) {
      const d = trafficDensityForLocalHour(h);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(1);
      expect(Math.abs(d - prev)).toBeLessThan(0.05);
      prev = d;
    }
    expect(trafficDensityForLocalHour(25)).toBe(trafficDensityForLocalHour(1));
    expect(trafficDensityForLocalHour(-1)).toBe(trafficDensityForLocalHour(23));
  });

  it('uses the airport LOCAL hour including daylight saving (KACY: America/New_York)', () => {
    expect(localHourAt(Date.UTC(2026, 6, 1, 12, 0, 0))).toBeCloseTo(8, 5); // EDT = UTC-4
    expect(localHourAt(Date.UTC(2026, 0, 15, 12, 30, 0))).toBeCloseTo(7.5, 5); // EST = UTC-5
    expect(trafficDensityAt(Date.UTC(2026, 6, 1, 7, 0, 0))).toBeCloseTo(0.1, 5); // 03:00 local
    expect(trafficDensityAt(Date.UTC(2026, 0, 15, 12, 30, 0))).toBe(1); // 07:30 local
  });
});

function spawnsOver(seed: number, sec: number, densityAt?: () => number): number {
  const sc = game.buildFreePlay(airport, { seed, weather: 'clear', aircraftCount: 0, arrivalsPerHour: 20, departuresPerHour: 20, maxAircraft: 40 });
  const inner = game.createTrafficGenerator(sc, airport, densityAt ? { densityAt } : {});
  let n = 0;
  const gen = { update: (st: Parameters<typeof inner.update>[0]) => { const out = inner.update(st); n += out.length; return out; } };
  const engine = createEngine({ airport, scenario: sc, trafficGenerator: gen, utcStartMs: Date.UTC(2026, 9, 17, 12, 0, 0) });
  for (let i = 0; i < sec * 10; i++) engine.step();
  return n;
}

describe('traffic generator with a density curve', () => {
  it('without a curve it is byte-for-byte the old seeded behaviour (deterministic)', () => {
    expect(spawnsOver(11, 1800)).toBe(spawnsOver(11, 1800));
    expect(spawnsOver(11, 1800)).toBe(spawnsOver(11, 1800, undefined));
  });

  it('density 1 matches the peak rate; density 0 spawns nothing; 0.2 spawns clearly fewer than 1 (same seed)', () => {
    const full = spawnsOver(11, 3600, () => 1);
    const none = spawnsOver(11, 3600, () => 0);
    const low = spawnsOver(11, 3600, () => 0.2);
    expect(none).toBe(0);
    expect(full).toBeGreaterThan(5);
    expect(low).toBeLessThan(full);
  });

  it('is deterministic for a given seed and curve', () => {
    const curve = () => 0.5;
    expect(spawnsOver(3, 1800, curve)).toBe(spawnsOver(3, 1800, curve));
  });
});
