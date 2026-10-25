/**
 * Arrivals to intersecting runways (JO 7110.65 3-10-4), `crossing.ts`: the passing time the AI plans with is the engine's, the sequence keeps a pattern aircraft
 * out of the passing window of an arrival on the crossing runway, and Tower does not line up a second departure on a runway that intersects one already in use.
 */
import { describe, expect, it } from 'vitest';
import { loadKbos } from '../airport';
import { assessClearanceSafety } from '../sim/conflicts';
import { alongCross, findRunwayEnd, runwayIntersection } from '../sim/runways';
import { ktToMps } from '../sim/geo';
import { getPerformance } from '../sim/performance';
import { cmd, createHarness, kacy } from './testkit';
import type { Harness } from './testkit';
import { CROSSING_MARGIN_SEC, INTERSECTION_PASS_MARGIN_M, crossingPairClear, intersectionPassSec } from './crossing';
import { sequenceDownwind } from './sequence';
import type { ScenarioAircraftSpawn } from '../sim/types';

const kbos = loadKbos();
const g27 = findRunwayEnd(kbos, '27')!;
const g22l = findRunwayEnd(kbos, '22L')!;

const arrival = (callsign: string, runwayEnd: string, type = 'C172'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 1500, headingDeg: 0, speedKt: 60, runwayEnd, distanceNm: 8 },
});

/** Put the aircraft on the final of `g` `distM` metres from the threshold at 60 kt, level (the engine's 3-10-4 check reads distance and ground speed). */
function onFinal(h: Harness, callsign: string, g: typeof g27, distM: number): void {
  const ac = h.find(callsign)!;
  ac.pos = { x: g.landingThreshold.x - g.dir.x * distM, y: g.landingThreshold.y - g.dir.y * distM };
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
  ac.groundSpeedKt = 60;
  ac.airspeedKt = 60;
  ac.phase = 'FINAL'; // (the engine's 3-10-4 check looks at arrivals on final or cleared to land)
}

describe('the passing time of an arrival at the intersection of two runways', () => {
  it('is the engine figure: the intersection distance plus 60 m at half the touchdown speed', () => {
    const P = runwayIntersection(g27.runway, g22l.runway)!;
    const sInt = alongCross(g27, P).along;
    const expected = (sInt + INTERSECTION_PASS_MARGIN_M) / (0.5 * ktToMps(getPerformance('C172').touchdownSpeedKt));
    expect(intersectionPassSec(kbos, 'C172', g27, '4R/22L')).toBeCloseTo(expected, 6);
    expect(intersectionPassSec(kbos, 'C172', g27, '4R/22L')!).toBeGreaterThan(100); // 27 meets 22L far down the runway: more than the 80 s of the same-runway rule
    expect(intersectionPassSec(kbos, 'C172', g27, '4L/22R')).toBeUndefined(); // these two do not cross
  });

  it('agrees with the engine landing check: the second arrival is refused inside the passing time and accepted beyond it (plus the AI margin)', () => {
    const h = createHarness({ airport: kbos, player: [], ai: [], spawns: [arrival('N27A', '27'), arrival('N22B', '22L')], activeRunways: { departing: ['22L'], landing: ['22L', '27'] } });
    const passA = intersectionPassSec(kbos, 'C172', g27, '4R/22L')!;
    const passB = intersectionPassSec(kbos, 'C172', g22l, '9/27')!;
    const vMps = ktToMps(60);
    onFinal(h, 'N27A', g27, 4000);
    const tA = 4000 / vMps;
    const check = (deltaSec: number): { engineSafe: boolean; aiClear: boolean } => {
      const tB = tA + passA + deltaSec;
      onFinal(h, 'N22B', g22l, tB * vMps);
      const state = h.engine.getState();
      const engineSafe = !assessClearanceSafety(state, cmd('LAND', 'N22B', { runwayEnd: '22L' })).issues.some((i) => /3-10-4/.test(i.text));
      return { engineSafe, aiClear: crossingPairClear(tA, passA, tB, passB) };
    };
    expect(check(-5)).toEqual({ engineSafe: false, aiClear: false });
    expect(check(2)).toEqual({ engineSafe: true, aiClear: false }); // the engine accepts it, the AI keeps its margin
    expect(check(CROSSING_MARGIN_SEC + 2)).toEqual({ engineSafe: true, aiClear: true });
  });
});

describe('the landing sequence keeps a pattern aircraft out of the passing window of an arrival on the crossing runway', () => {
  const patternOn27 = (): ScenarioAircraftSpawn => {
    const left = { x: -g27.right.x, y: -g27.right.y };
    const pos = { x: g27.end.threshold.x + g27.dir.x * 200 + left.x * 1482, y: g27.end.threshold.y + g27.dir.y * 200 + left.y * 1482 };
    return { atSec: 0, callsign: 'N1PA', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos, altitudeFt: 1000, headingDeg: (g27.headingDeg + 180) % 360, speedKt: 75, runwayEnd: '27' } };
  };
  const setup = (withCrossing: boolean): Harness => {
    const h = createHarness({
      airport: kbos, player: [], ai: [], spawns: [patternOn27(), ...(withCrossing ? [arrival('N22B', '22L')] : [])], activeRunways: { departing: ['22L'], landing: ['22L', '27'] },
    });
    h.say('TWR', cmd('ENTER_PATTERN', 'N1PA', { runwayEnd: '27', patternLeg: 'left_downwind', turnDirection: 'left' }));
    h.run(1);
    return h;
  };

  it('with nothing on 22L the aircraft turns base where it normally does', () => {
    const h = setup(false);
    const d = sequenceDownwind(h.engine.getState(), g27, []);
    expect(d.map((x) => x.action)).toEqual(['ok']);
  });

  it('with an arrival on 22L that would cross its threshold just before the pattern aircraft would cross 27\'s, the aircraft is delayed (extend, 360)', () => {
    const h = setup(true);
    const ac = h.find('N1PA')!;
    // the pattern aircraft's normal threshold time is about 150 s from here; put the 22L arrival 60 s ahead of that, inside its passing window
    onFinal(h, 'N22B', g22l, 90 * ktToMps(60));
    const before = sequenceDownwind(h.engine.getState(), g27, []);
    expect(before).toHaveLength(1);
    expect(before[0].ac.id).toBe(ac.id);
    expect(before[0].action).not.toBe('ok');
  });
});

describe('Tower does not line up a second departure on a runway that intersects one in use', () => {
  it('two departures at the holds of KACY 13 and 22: never both in position, both leave', () => {
    const h = createHarness({
      player: [], activeRunways: { departing: ['13', '22'], landing: ['13'] }, seed: 7,
      spawns: [
        { atSec: 0, callsign: 'N1AA', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP13-31-B-1', runwayEnd: '13' } },
        { atSec: 0, callsign: 'N2BB', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'holding_short', nodeId: 'HP4-22-A-2', runwayEnd: '22' } },
      ],
    });
    let both = 0;
    h.run(420, () => {
      const lined = Object.values(h.engine.getState().aircraft).filter((a) => a.isDeparture && a.onGround && (a.phase === 'LINE_UP_AND_WAIT' || a.phase === 'CLEARED_FOR_TAKEOFF' || a.phase === 'TAKEOFF_ROLL'));
      if (lined.length > 1) both++;
    });
    expect(both).toBe(0);
    for (const c of ['N1AA', 'N2BB']) expect(h.find(c)?.onGround === false || h.find(c) === undefined).toBe(true);
    expect(kacy.runways.length).toBeGreaterThan(1);
  }, 120_000);
});
