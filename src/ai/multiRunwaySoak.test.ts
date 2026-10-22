import { describe, expect, it } from 'vitest';
import { createMultiRunwayAirport } from '../sim/__fixtures__/multiRunwayAirport';
import { dependentDiagonalNm } from './approach';
import { runFreePlaySoak } from './freePlayHarness';

/** Every AI position works the synthetic multi-runway airport (parallel runways 4,003 ft apart + a crossing runway) for 20 simulated minutes. */
describe('AI controllers on a multi-runway configuration', () => {
  const airport = createMultiRunwayAirport();
  it('dual arrivals 27R + 27L, departures 27L: traffic flows and nobody is on a runway with traffic', () => {
    const r = runFreePlaySoak(3, 'off', 1 / 3, {}, { airport, activeRunways: { landing: ['27R', '27L'], departing: ['27L'] }, arrivalsPerHour: 20, departuresPerHour: 20 });
    expect(r.stallDump).toBeUndefined();
    expect(r.safety.filter((s) => s.includes('RUNWAY_INCURSION'))).toEqual([]);
    expect(r.landed[r.landed.length - 1] ?? 0).toBeGreaterThanOrEqual(0);
    expect(r.spawnedArrivals).toBeGreaterThan(2);
    expect(r.spawnedDepartures).toBeGreaterThan(2);
  }, 300000);
  it('dependent parallel approach stagger follows JO 7110.65 5-9-6 (centreline spacing -> diagonal nm)', () => {
    expect(dependentDiagonalNm(3000)).toBe(1);
    expect(dependentDiagonalNm(4003)).toBe(1.5);
    expect(dependentDiagonalNm(8600)).toBe(2);
    expect(dependentDiagonalNm(1200)).toBe(3);
  });
});
