/** Traffic over a published multi-runway configuration (synthetic fixture airport): arrivals use every landing runway, departures only the departing ones. */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../sim/engine';
import type { SpawnSpec, TrafficGenerator } from '../sim/traffic';
import { createMultiRunwayAirport } from '../sim/__fixtures__/multiRunwayAirport';
import { game } from './game';

const airport = createMultiRunwayAirport();

function spawnsFor(active: { landing: string[]; departing: string[] }, seed: number, sec: number): SpawnSpec[] {
  const sc = game.buildFreePlay(airport, { seed, weather: 'clear', aircraftCount: 0, difficulty: 'normal', aircraftTypes: ['C172', 'PA28'], arrivalsPerHour: 40, departuresPerHour: 40, gaFraction: 1, maxAircraft: 14, activeRunways: active });
  sc.traffic = { ...sc.traffic!, flowControl: false };
  const inner = game.createTrafficGenerator(sc, airport);
  const out: SpawnSpec[] = [];
  const wrapped: TrafficGenerator = { update(state) { const s = inner.update(state); out.push(...s); return s; } };
  const e = createEngine({ airport, scenario: sc, trafficGenerator: wrapped });
  for (let i = 0; i < sec * 10; i++) e.step();
  return out;
}

describe('traffic over a multi-runway configuration', () => {
  const active = { landing: ['27R', '27L'], departing: ['27L'] };
  const specs = spawnsFor(active, 7, 1800);
  const arrivals = specs.filter((s) => !s.isDeparture);

  it('spreads arrivals over both landing runways', () => {
    const ends = arrivals.map((s) => (s.start.kind === 'airborne' ? s.start.runwayEnd : undefined));
    expect(arrivals.length).toBeGreaterThan(8);
    expect(ends.filter((e) => e === '27R').length).toBeGreaterThan(2);
    expect(ends.filter((e) => e === '27L').length).toBeGreaterThan(2);
    expect(ends.every((e) => e === '27R' || e === '27L')).toBe(true);
  });
  it('recommends the published configuration for the wind in a free-play scenario', () => {
    const sc = game.buildFreePlay(airport, { seed: 3, weather: { source: 'simulated', windDirDeg: 90, windSpeedKt: 12, visibilitySm: 10, clouds: [], temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR' } });
    expect(sc.activeRunways).toEqual({ landing: ['9L'], departing: ['9R'] });
  });
});
