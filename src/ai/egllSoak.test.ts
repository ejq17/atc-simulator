import { describe, expect, it } from 'vitest';
import { loadEgll } from '../airport';
import { runFreePlaySoak } from './freePlayHarness';

/** Every AI position works EGLL (land 27L, depart 27R) for 10 simulated minutes with the Heathrow traffic profile (BA, Virgin, ... no GA). */
describe('AI controllers at EGLL, segregated mode', () => {
  const airport = loadEgll();
  it('traffic flows without a runway incursion or an unsafe clearance', () => {
    const r = runFreePlaySoak(1, 'off', 1 / 6, {}, { airport, activeRunways: { landing: ['27L'], departing: ['27R'] }, arrivalsPerHour: 24, departuresPerHour: 24 });
    expect(r.stallDump).toBeUndefined();
    expect(r.safety.filter((s) => s.includes('RUNWAY_INCURSION'))).toEqual([]);
    expect(r.spawnedArrivals).toBeGreaterThanOrEqual(2);
    expect(r.spawnedDepartures).toBeGreaterThanOrEqual(2);
  }, 600000);
});
