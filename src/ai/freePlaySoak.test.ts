import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { runFreePlaySoak } from './freePlayHarness';

/**
 * Free-play soak at the rates of the "jam after about an hour" report: KACY, every AI position, 10 arrivals + 10 departures per hour,
 * maxAircraft 14, special traffic off, 2 h of sim time. Records, per 10 sim minutes, the aircraft count, phase histogram, landed / departed
 * counts, hold-line queue, open coordination requests and wall-clock ms per sim second, and dumps every aircraft at the first stall.
 * Slow (about a minute per run), so it only runs with FREEPLAY_SOAK=1 (FREEPLAY_SEEDS=1,2 and FREEPLAY_HOURS=2 select the runs;
 * FREEPLAY_REPORT=1 prints the table, FREEPLAY_REPORT_FILE=path appends it to a file).
 */
const enabled = process.env.FREEPLAY_SOAK === '1';
const seeds = (process.env.FREEPLAY_SEEDS ?? '1,2,3,4').split(',').map(Number);
const hours = Number(process.env.FREEPLAY_HOURS ?? 2);
const report = process.env.FREEPLAY_REPORT === '1';
const realisms = (process.env.FREEPLAY_REALISM ?? 'off,moderate').split(',') as ('off' | 'moderate')[];

describe.skipIf(!enabled)('free play at 10 + 10 per hour, 14 aircraft, every AI position', () => {
  for (const realism of realisms) {
    for (const seed of seeds) {
      it(`seed ${seed}, pilot realism ${realism}: flow continues for ${hours} h`, () => {
        const r = runFreePlaySoak(seed, realism, hours);
        if (process.env.FREEPLAY_REPORT_FILE) appendFileSync(process.env.FREEPLAY_REPORT_FILE, `--- seed ${seed} realism ${realism}\n${r.rows.join('\n')}\nmax wait ${r.maxWaitText}\nsafety events ${r.safety.length}\n${r.stallDump ?? ''}\n`);
        if (report || r.stallDump) console.log(`--- seed ${seed} realism ${realism}\n${r.rows.join('\n')}\nmax wait ${r.maxWaitText}\nsafety events ${r.safety.length}\n${r.stallDump ?? ''}`);
        expect(r.stallDump, r.rows.join('\n')).toBeUndefined();
        // Landed and departed counts rise over the run, and nobody waits an hour (the longest wait seen in the 8 runs is about 46 min, a departure whose taxi
        // is held while arrivals use the same lanes: docs/PROGRESS.md "Free-play jam", unresolved items).
        expect(r.landed[r.landed.length - 1]).toBeGreaterThan(r.landed[Math.floor(r.landed.length / 2)]);
        expect(r.departed[r.departed.length - 1]).toBeGreaterThan(r.departed[Math.floor(r.departed.length / 2)]);
        expect(r.maxWaitSec, r.maxWaitText).toBeLessThan(3600);
      }, 900000);
    }
  }
});
