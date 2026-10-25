import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { loadKbos, loadKpgd, loadKphl } from '../airport';
import type { Airport } from '../sim/types';
import { profileFor } from '../game/airportProfile';
import { runFreePlaySoak } from './freePlayHarness';

/**
 * Traffic mix of the all-AI soak runs at the new airports (the same matrix as newAirportSoak.test.ts: every published KBOS and KPHL configuration, KPGD seeds 1-4),
 * counted from the aircraft the generator and the opening population created: GA (the profile's GA types) against airline flights, arrivals and departures, and
 * the touch-and-go / option circuits flown. Only with FREEPLAY_SOAK=1 (about the wall time of newAirportSoak); FREEPLAY_HOURS (default 2) and FREEPLAY_REPORT_FILE=path
 * (appends the table row) as there. Bar: the GA share of what was created stays within what the profile's `gaFraction` allows, and airports with no pattern
 * work fly no circuits.
 */
const enabled = process.env.FREEPLAY_SOAK === '1';
const hours = Number(process.env.FREEPLAY_HOURS ?? 2);

interface Mix { ga: number; airline: number; gaArr: number; gaDep: number; airArr: number; airDep: number; circuits: number; landed: number; departed: number }

function mix(label: string, airport: Airport, seed: number, active?: { landing: string[]; departing: string[] }): Mix {
  const gaTypes = new Set(profileFor(airport.icao).gaTypes.map(([t]) => t));
  const seen = new Map<string, { ga: boolean; dep: boolean }>();
  const r = runFreePlaySoak(seed, 'moderate', hours, {
    perSecond: (engine) => {
      for (const a of Object.values(engine.getState().aircraft)) if (!seen.has(a.id)) seen.set(a.id, { ga: gaTypes.has(a.type), dep: a.isDeparture });
    },
  }, { airport, ...(active ? { activeRunways: active } : {}) });
  const all = [...seen.values()];
  const m: Mix = {
    ga: all.filter((a) => a.ga).length, airline: all.filter((a) => !a.ga).length,
    gaArr: all.filter((a) => a.ga && !a.dep).length, gaDep: all.filter((a) => a.ga && a.dep).length,
    airArr: all.filter((a) => !a.ga && !a.dep).length, airDep: all.filter((a) => !a.ga && a.dep).length,
    circuits: r.events.filter((e) => /touch and go: rolling|cleared for the touch-and-go|stay in the pattern/.test(e.text)).length,
    landed: r.landed.at(-1) ?? 0, departed: r.departed.at(-1) ?? 0,
  };
  const row = `| ${label} | ${m.ga} | ${m.airline} | ${m.gaArr}/${m.gaDep} | ${m.airArr}/${m.airDep} | ${m.circuits} | ${m.landed} | ${m.departed} |`;
  if (process.env.FREEPLAY_REPORT_FILE) appendFileSync(process.env.FREEPLAY_REPORT_FILE, `${row}\n`);
  if (process.env.FREEPLAY_REPORT === '1') console.log(`| run | GA created | airline created | GA arr/dep | airline arr/dep | circuits | landed | departed |\n${row}`);
  return m;
}

function check(airport: Airport, m: Mix): void {
  const total = m.ga + m.airline;
  expect(total).toBeGreaterThan(10);
  const gaShare = profileFor(airport.icao).defaults.gaFraction;
  // 99.9 % binomial bound on the GA share of `total` flights, plus the opening population's rounding
  const bound = gaShare + 3.3 * Math.sqrt((gaShare * (1 - gaShare)) / total) + 0.05;
  expect(m.ga / total, `${m.ga} of ${total} created aircraft are GA`).toBeLessThan(bound);
  if (!profileFor(airport.icao).defaults.patternWork) expect(m.circuits).toBe(0);
}

describe.skipIf(!enabled)('traffic mix of the new-airport soak runs', () => {
  const kbos = loadKbos();
  for (const c of kbos.runwayConfigurations ?? []) {
    it(`KBOS ${c.id}: ${hours} h`, () => check(kbos, mix(`KBOS ${c.id}`, kbos, 1, { landing: c.landing, departing: c.departing })), 1800000);
  }
  const kphl = loadKphl();
  for (const c of kphl.runwayConfigurations ?? []) {
    for (const seed of [1, 2]) it(`KPHL ${c.id} seed ${seed}: ${hours} h`, () => check(kphl, mix(`KPHL ${c.id} s${seed}`, kphl, seed, { landing: c.landing, departing: c.departing })), 1800000);
  }
  const kpgd = loadKpgd();
  for (const seed of (process.env.FREEPLAY_SEEDS ?? '1,2,3,4').split(',').map(Number)) {
    it(`KPGD seed ${seed}: ${hours} h`, () => check(kpgd, mix(`KPGD s${seed}`, kpgd, seed)), 1800000);
  }
});
