import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { measureBlocked, measureRow, PROTOCOL } from './blockedRate';
import type { BlockedOptions, BlockedRegime } from './blockedRate';
import type { PilotRealismLevel } from '../sim/pilotBehaviour';

/**
 * Blocked-call rate, canonical protocol in `blockedRate.ts` (docs/BEHAVIOUR-ACCURACY.md R9). Slow, so it only runs with BLOCKED_RATE=1.
 * Knobs: BLOCKED_SEEDS=1,2,3  BLOCKED_LEVELS=light,moderate,heavy  BLOCKED_REGIMES=ai,human-twr,unattended  BLOCKED_PAIRS=1 (list the collisions)
 * BLOCKED_FILE=path (append the rows). Set-up variations (they leave the canonical protocol, for the reconciliation in R9):
 * BLOCKED_FLOW=0 (flow control off)  BLOCKED_SPECIAL=1 (special traffic on)  BLOCKED_COUNT=n (starting aircraft)  BLOCKED_MAX=n (maxAircraft)
 * BLOCKED_IFR=0|1 (IFR flows)  BLOCKED_POS=twr-gnd (session lists only TWR + GND)  BLOCKED_START=quiet|mixed|busy_arrivals|busy_departures  BLOCKED_SPAN=s  BLOCKED_DISCARD=s.
 */
const enabled = process.env.BLOCKED_RATE === '1';
const env = process.env;
const seeds = (env.BLOCKED_SEEDS ?? PROTOCOL.seeds.join(',')).split(',').map(Number);
const levels = (env.BLOCKED_LEVELS ?? PROTOCOL.levels.join(',')).split(',') as PilotRealismLevel[];
const regimes = (env.BLOCKED_REGIMES ?? 'ai,human-twr').split(',') as BlockedRegime[];
const vary: Partial<BlockedOptions> = {
  ...(env.BLOCKED_FLOW === '0' ? { flowControl: false } : {}), ...(env.BLOCKED_SPECIAL === '1' ? { specialTraffic: true } : {}),
  ...(env.BLOCKED_COUNT ? { aircraftCount: Number(env.BLOCKED_COUNT) } : {}), ...(env.BLOCKED_MAX ? { maxAircraft: Number(env.BLOCKED_MAX) } : {}),
  ...(env.BLOCKED_START ? { startingScenario: env.BLOCKED_START as BlockedOptions['startingScenario'] } : {}),
  ...(env.BLOCKED_IFR ? { ifrFlows: env.BLOCKED_IFR === '1' } : {}), ...(env.BLOCKED_POS === 'twr-gnd' ? { positions: 'twr-gnd' as const } : {}),
  ...(env.BLOCKED_SPAN ? { spanSec: Number(env.BLOCKED_SPAN) } : {}), ...(env.BLOCKED_DISCARD ? { discardSec: Number(env.BLOCKED_DISCARD) } : {}),
};

describe.skipIf(!enabled)('blocked-call rate', () => {
  for (const level of levels) for (const regime of regimes) {
    it(`${level} ${regime}`, () => {
      const row = measureRow({ level, regime, ...vary }, seeds, `${level} ${regime}`);
      const out = row.line + (env.BLOCKED_PAIRS ? '\n' + row.pairs.join('\n') : '');
      console.log(out);
      if (env.BLOCKED_FILE) appendFileSync(env.BLOCKED_FILE, out + '\n');
    }, 3600000);
  }
});

// Always on (a few seconds): the protocol is deterministic and counts what it says it counts.
describe('blocked-call protocol (short window)', () => {
  const short = { seed: 1, level: 'heavy' as PilotRealismLevel, discardSec: 120, spanSec: 600 };
  for (const regime of ['ai', 'human-twr'] as const) {
    it(`${regime}: same inputs give the same counts, calls are counted`, () => {
      const a = measureBlocked({ ...short, regime });
      const b = measureBlocked({ ...short, regime });
      expect({ ...a, pairs: [] }).toEqual({ ...b, pairs: [] });
      expect(a.keyed).toBe(a.transmitted + a.blocked);
      expect(a.transmitted).toBeGreaterThan(30);
      expect(a.atcCalls).toBeGreaterThan(10);
      expect(a.blocked).toBeGreaterThanOrEqual(2 * a.groups);
    }, 120000);
  }
  it('unattended: nobody answers, so there are no controller calls and only the first calls of the aircraft', () => {
    const a = measureBlocked({ ...short, regime: 'unattended' });
    expect(a.atcCalls).toBe(0);
    expect(a.keyed).toBeLessThan(120);
  }, 120000);
  it('the canonical protocol values', () => {
    expect([PROTOCOL.discardSec, PROTOCOL.spanSec, PROTOCOL.arrivalsPerHour, PROTOCOL.departuresPerHour, PROTOCOL.maxAircraft, PROTOCOL.aircraftCount]).toEqual([300, 7200, 24, 24, 30, 6]);
  });
});
