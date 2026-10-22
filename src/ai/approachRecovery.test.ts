/**
 * A pilot who gives no readback to the approach clearance has not received it (the 20 s window drops it). Approach must correct it while the window is open
 * (JO 7110.65 2-4-3: ensure the readback is correct / received) and, if it was lost, issue a fresh clearance rather than leave the aircraft flying on
 * (soak seed 8, moderate: NKS1337 got no readback to "cleared RNAV runway two two approach" and flew 56 minutes while Approach repeated "direct FLDER").
 */
import { describe, expect, it } from 'vitest';
import { createHarness, IFR_ARR } from './testkit';

describe('approach clearance without a readback (heavy realism)', () => {
  it('is re-issued and the aircraft is established on final, for every seed, including those whose first clearance was lost', () => {
    let lost = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const h = createHarness({
        player: [], ai: ['CLNC', 'GND', 'TWR', 'APP', 'DEP'], mode: 'free_play', activeRunways: { departing: ['13'], landing: ['13'] },
        spawns: [IFR_ARR('NKS1337', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 5000, { atSec: 60 }), IFR_ARR('DAL88', 'CARYL', ['CARYL', 'MAYBN'], '13', 6000, { atSec: 120 })], seed, aiSeed: seed, pilotRealism: 'heavy',
        pilotBehaviour: { realism: { noReadbackRate: 0.5, delayedResponseRate: 0, sayAgainRate: 0, altitudeErrorRate: 0, digitErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, requests: { HIGHER: 1, DIRECT_FIX: 1 } } },
      });
      let est: number | undefined;
      h.runUntil(() => {
        const a = h.find('NKS1337');
        if (a && est === undefined && ['FINAL', 'LANDING', 'ROLLOUT'].includes(a.phase)) est = h.now();
        return est !== undefined;
      }, 1500);
      const dropped = h.events.filter((e) => e.kind === 'READBACK_ERROR' && e.data?.missed).length;
      lost += h.events.some((e) => e.kind === 'INFO' && e.data?.errorKind === 'no_readback') ? 1 : 0;
      expect(est, `seed ${seed}: never established (${dropped} dropped)`).toBeDefined();
    }
    expect(lost).toBeGreaterThan(0);
  });
});

describe('a correction is not held up by a queued pilot call (CORRECTION_PATIENCE_SEC)', () => {
  it('every unacknowledged Approach instruction is repeated within 12 s although other pilots on the frequency queue requests', () => {
    let worst = 0;
    let n = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const h = createHarness({
        player: [], ai: ['CLNC', 'GND', 'TWR', 'APP', 'DEP'], mode: 'free_play', activeRunways: { departing: ['13'], landing: ['13'] },
        spawns: [IFR_ARR('NKS1337', 'CARYL', ['CARYL', 'MAYBN'], '13', 4000), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 5000, { atSec: 20 }), IFR_ARR('DAL88', 'CARYL', ['CARYL', 'MAYBN'], '13', 6000, { atSec: 40 })],
        seed, aiSeed: seed, pilotRealism: 'heavy',
        pilotBehaviour: { realism: { noReadbackRate: 0.5, delayedResponseRate: 0, sayAgainRate: 0, altitudeErrorRate: 0, digitErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, requests: { HIGHER: 1, DIRECT_FIX: 1, VISUAL_APPROACH: 1 } } },
      });
      h.run(500);
      const lost = h.events.filter((e) => e.kind === 'INFO' && e.data?.errorKind === 'no_readback' && e.callsign);
      for (const e of lost) {
        const next = h.events.find((x) => x.kind === 'TRANSMISSION' && x.speaker === 'ATC' && x.callsign === e.callsign && x.timeSec > e.timeSec);
        if (!next) continue;
        n++;
        worst = Math.max(worst, next.timeSec - e.timeSec);
      }
    }
    expect(n).toBeGreaterThan(5);
    expect(worst).toBeLessThanOrEqual(12);
  }, 120_000); // 16 seeded 500 s runs with three arrivals: 40-75 s when several suites share the CPU
});
