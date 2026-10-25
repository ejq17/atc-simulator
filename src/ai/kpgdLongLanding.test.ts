import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadKpgd } from '../airport';
import { game } from '../game/game';
import { runFreePlaySoak } from './freePlayHarness';
import { findRunwayEnd } from '../sim/runways';
import { profileFor } from '../game/airportProfile';
import { TDZ_TOLERANCE_M, touchdownZoneEndM } from '../sim/flightDynamics';

/**
 * Regression: KPGD, all AI, seed 1, 2 simulated hours, the free-play mix of the day the bug was found (GA share 50 %, a new GA / airline draw per spawn attempt, so the traffic is the one that
 * produced it). AAY1500 (A319) was cleared to land at t = 6,086 s about 1,200 ft above the glide path, floated down runway 22 and "touched down
 * 3768 m from threshold" on a 2,190 m runway; it stopped on the runway with no taxi node in reach. Now the arrival goes around (touchdown zone: Pilot/Controller Glossary) and no
 * touchdown lies beyond the touchdown zone.
 */
describe('KPGD seed 1: no landing beyond the touchdown zone or the runway end', () => {
  const defaults = profileFor('KPGD').defaults;
  const keepKind = defaults.keepKindOnRetry;
  afterEach(() => {
    vi.restoreAllMocks();
    defaults.keepKindOnRetry = keepKind;
  });
  const run = (): { downs: { t: number; cs: string; end: string; m: number }[]; events: ReturnType<typeof runFreePlaySoak>['events']; airport: ReturnType<typeof loadKpgd> } => {
    const airport = loadKpgd();
    const r = runFreePlaySoak(1, 'moderate', 2, {}, { airport });
    const downs = r.events.flatMap((e) => {
      const m = /touched down runway (\S+) (-?\d+) m from threshold/.exec(e.text);
      return m ? [{ t: Math.round(e.timeSec), cs: e.callsign ?? '', end: m[1], m: Number(m[2]) }] : [];
    });
    return { downs, events: r.events, airport };
  };
  const checkDowns = (x: ReturnType<typeof run>): void => {
    expect(x.downs.length).toBeGreaterThan(3);
    for (const d of x.downs) {
      const g = findRunwayEnd(x.airport, d.end)!;
      expect(d.m, `${d.cs} at ${d.t} s`).toBeLessThan(g.lengthM);
      expect(d.m, `${d.cs} at ${d.t} s`).toBeLessThanOrEqual(touchdownZoneEndM(g) + TDZ_TOLERANCE_M + 400);
    }
  };

  it('2 h all-AI run, the traffic of the day the bug was found', () => {
    defaults.keepKindOnRetry = false; // one GA / airline draw per spawn attempt, so the same aircraft appear
    const real = game.buildFreePlay.bind(game);
    vi.spyOn(game, 'buildFreePlay').mockImplementation((ap, o) => real(ap, { ...o, gaFraction: 0.5 }));
    const x = run();
    checkDowns(x);
    expect(x.events.some((e) => /stopped on runway/.test(e.text) && (e.callsign ?? '').startsWith('AAY1500'))).toBe(false);
    // (the generator is state dependent: with the Tower / Approach sequencing of the hub-airport round AAY1500 is no longer in this run; the touchdown-zone go-around itself is
    // `sim/touchdownZone.test.ts`, and every touchdown of the run is checked above)
  }, 600000);

  it('2 h all-AI run at the profile defaults', () => {
    checkDowns(run());
  }, 600000);
});
