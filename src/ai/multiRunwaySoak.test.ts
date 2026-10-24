import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { loadEgll } from '../airport';
import { createMultiRunwayAirport } from '../sim/__fixtures__/multiRunwayAirport';
import { dependentDiagonalNm } from './approach';
import { runFreePlaySoak } from './freePlayHarness';
import type { SoakResult } from './freePlayHarness';

/**
 * Every AI position works the synthetic multi-runway airport (parallel runways 4,003 ft apart + a crossing runway) at 20 arrivals + 20 departures per hour.
 * The quick smoke runs always; the 30-minute runs of seeds 1 to 4 in the two configurations (dual arrivals 27R + 27L, departures 27L; segregated, arrivals 27R,
 * departures 27L) run with FREEPLAY_SOAK=1 (about 90 s in all; FREEPLAY_MULTI_SEEDS=1,2 selects seeds, FREEPLAY_REPORT_FILE=path appends the per-seed numbers). The bar: no airborne near-miss alert (1.5 nm and 500 ft)
 * and no runway incursion, no stall, traffic in and out. Before the departure projection (`airbornePath.ts`), the stagger of the VFR arrivals and the parallel pattern
 * sides, the same runs raised 3 to 16 near-miss alerts each.
 */
const airport = createMultiRunwayAirport();
const DUAL = { landing: ['27R', '27L'], departing: ['27L'] };
const SEGREGATED = { landing: ['27R'], departing: ['27L'] };
const full = process.env.FREEPLAY_SOAK === '1';
const seeds = (process.env.FREEPLAY_MULTI_SEEDS ?? '1,2,3,4').split(',').map(Number);

const run = (seed: number, config: typeof DUAL, hours: number): SoakResult =>
  runFreePlaySoak(seed, 'off', hours, {}, { airport, activeRunways: config, arrivalsPerHour: 20, departuresPerHour: 20 });

function expectClean(r: SoakResult): void {
  expect(r.stallDump).toBeUndefined();
  expect(r.airborneAlerts).toEqual([]);
  expect(r.incursions).toEqual([]);
  expect(r.spawnedArrivals).toBeGreaterThan(2);
  expect(r.spawnedDepartures).toBeGreaterThan(2);
  expect(r.landed[r.landed.length - 1] ?? 0).toBeGreaterThan(0);
}

describe('AI controllers on a multi-runway configuration', () => {
  it('smoke, dual arrivals 27R + 27L, departures 27L, seed 2, 20 minutes at 20 + 20 per hour: no near-miss alert, no incursion, traffic flows', () => {
    const r = run(2, DUAL, 1 / 3);
    expectClean(r);
    expect(r.departed[r.departed.length - 1] ?? 0).toBeGreaterThan(0);
  }, 300000);

  it('dependent parallel approach stagger follows JO 7110.65 5-9-6 (centreline spacing -> diagonal nm)', () => {
    expect(dependentDiagonalNm(3000)).toBe(1);
    expect(dependentDiagonalNm(4003)).toBe(1.5);
    expect(dependentDiagonalNm(8600)).toBe(2);
    expect(dependentDiagonalNm(1200)).toBe(3);
  });

  describe.skipIf(!full)('London Heathrow (two parallels 3,000 ft apart), segregated mode, 30 minutes at 20 + 20 per hour (FREEPLAY_SOAK=1)', () => {
    for (const [name, config] of [['W-ALT-27R', { landing: ['27R'], departing: ['27L'] }], ['E-SEG-09L', { landing: ['9L'], departing: ['9R'] }]] as [string, { landing: string[]; departing: string[] }][]) {
      for (const seed of [1, 2]) {
        it(`${name}, seed ${seed}: zero airborne near-miss alerts and zero runway incursions`, () => {
          const r = runFreePlaySoak(seed, 'off', 0.5, {}, { airport: loadEgll(), activeRunways: config, arrivalsPerHour: 20, departuresPerHour: 20 });
          if (process.env.FREEPLAY_REPORT_FILE) appendFileSync(process.env.FREEPLAY_REPORT_FILE, `EGLL ${name} seed ${seed}: spawned ${r.spawnedArrivals}+${r.spawnedDepartures} landed ${r.landed.at(-1)} departed ${r.departed.at(-1)} go-arounds ${r.goArounds} airborne alerts ${r.airborneAlerts.length} incursions ${r.incursions.length}\n${r.airborneAlerts.concat(r.incursions).join('\n')}\n`);
          expect(r.airborneAlerts).toEqual([]);
          expect(r.incursions).toEqual([]);
        }, 600000);
      }
    }
  });

  describe.skipIf(!full)('30 minutes at 20 + 20 per hour (FREEPLAY_SOAK=1)', () => {
    for (const [name, config] of [['dual arrivals', DUAL], ['segregated', SEGREGATED]] as const) {
      for (const seed of seeds) {
        it(`${name}, seed ${seed}: zero airborne near-miss alerts and zero runway incursions`, () => {
          const r = run(seed, config, 0.5);
          if (process.env.FREEPLAY_REPORT_FILE) appendFileSync(process.env.FREEPLAY_REPORT_FILE, `multi-runway ${name} seed ${seed}: spawned ${r.spawnedArrivals}+${r.spawnedDepartures} landed ${r.landed.at(-1)} departed ${r.departed.at(-1)} go-arounds ${r.goArounds} airborne alerts ${r.airborneAlerts.length} incursions ${r.incursions.length} max wait ${r.maxWaitText}\n`);
          expectClean(r);
        }, 600000);
      }
    }
  });
});
