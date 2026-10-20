/**
 * The first 1.3 h of free-play soak seed 12 (KACY, 10 + 10 per hour, 14 aircraft, normal difficulty): an A320 inbound over KOPCE (NKS1027) among a stream of light
 * aircraft. On 9e926d2 it flew "direct FLDER" at 1,800 ft for 36 minutes (a phantom runway window of the circling jet kept the pattern aircraft extending downwind,
 * the light aircraft on the final left no hole for it) and one Cessna went around 7 times (soak seed 6) or 5 (seed 12). JO 7110.65 3-8-1 (sequencing, "extend
 * downwind", "360"), 3-10-3 (same runway separation), 3-10-6 (anticipating separation): spacing is made before the final, a go-around is the last action.
 */
import { describe, expect, it } from 'vitest';
import { runFreePlaySoak } from './freePlayHarness';

/** The jet waits no longer than this in the approach phase without landing (s): a documented bound of this test, 9e926d2 gave 2,240 s. */
const JET_APPROACH_BOUND_SEC = 1500;

describe('soak seed 12: a jet among light traffic', () => {
  for (const realism of ['off', 'moderate'] as const) {
    it(`pilot realism ${realism}: the A320 is not held in the approach phase for more than ${JET_APPROACH_BOUND_SEC} s and no aircraft goes around more than 4 times`, () => {
      const r = runFreePlaySoak(12, realism, 1.3);
      const jetWait = r.longWaits.map((w) => /^(\S+) APPROACH (\d+)s/.exec(w)).filter((m): m is RegExpExecArray => !!m && m[1] === 'NKS1027').map((m) => Number(m[2]));
      expect(Math.max(0, ...jetWait), r.longWaits.slice(0, 6).join('; ')).toBeLessThan(JET_APPROACH_BOUND_SEC);
      expect(r.maxGoArounds.count, `${r.maxGoArounds.callsign}`).toBeLessThanOrEqual(4);
      expect(r.stallDump).toBeUndefined();
    }, 300000);
  }
});
