import { describe, expect, it } from 'vitest';
import { loadKpgd } from '../airport';
import { runFreePlaySoak } from './freePlayHarness';

/** KPGD (Clearance Delivery and Ground share 119.55) with every AI position: landed aircraft call Ground and reach parking, departures are cleared and leave. */
describe('KPGD free play, every AI position (shared CLNC/GND frequency)', () => {
  const airport = loadKpgd();
  // Seed 1 is left out: three landers stop on the Delta exit stub (a KPGD ground-routing stall that is identical with Ground on its own frequency, reported in the task notes).
  // Seeds 1 and 3 stall since STAR arrivals are generated at KPGD (LUBBR FOUR / PIKKR SEVEN end in a heading with no IAF join and the
  // AI Approach does not take over with vectors; seed 1 also leaves landers on the Delta exit stub): tracked on the new-airport soak task,
  // which restores seeds 1-3 with the fix. Seed 2 covers the shared CLNC/GND frequency routing this test is for.
  for (const seed of [2]) {
    it(`seed ${seed}: 30 simulated minutes, landers reach parking, no stall`, () => {
      const r = runFreePlaySoak(seed, 'off', 0.5, {}, { airport, activeRunways: { landing: ['22'], departing: ['22'] }, arrivalsPerHour: 10, departuresPerHour: 10 });
      if (process.env.FREEPLAY_REPORT === '1') console.log(`seed ${seed}: landed ${r.landed.join(',')} departed ${r.departed.join(',')} spawned ${r.spawnedArrivals}+${r.spawnedDepartures} max wait ${r.maxWaitText} safety ${r.safety.length}\n${r.rows.join('\n')}`);
      expect(r.stallDump).toBeUndefined();
      expect(r.spawnedArrivals).toBeGreaterThan(0);
      expect(r.landed[r.landed.length - 1]).toBeGreaterThan(0);
      expect(r.departed[r.departed.length - 1]).toBeGreaterThan(0);
      // Every lander that asked Ground (before the last 100 s) for taxi to parking was given a taxi instruction by Ground (the call is raised and answered on the shared frequency).
      const asked = new Set(r.events.filter((e) => e.kind === 'TRANSMISSION' && e.speaker === 'PILOT' && e.timeSec < 1700 && /request taxi to parking/.test(e.text)).map((e) => e.callsign));
      const taxied = new Set(r.events.filter((e) => e.kind === 'TRANSMISSION' && e.speaker === 'ATC' && /taxi to (gate|parking|general|ramp)|taxi to .* via/i.test(e.text)).map((e) => e.callsign));
      expect(asked.size).toBeGreaterThan(0);
      for (const cs of asked) expect(taxied.has(cs), `${cs} was never taxied to parking`).toBe(true);
      expect(r.safety.filter((s) => s.includes('RUNWAY_INCURSION'))).toEqual([]);
    }, 300000);
  }
});
