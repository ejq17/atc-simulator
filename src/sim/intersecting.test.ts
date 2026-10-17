/** Intersecting runways (JO 7110.65 3-9-8, 3-10-4) and wake turbulence for intersection departures (3-9-7). */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { Airport } from './types';
import { loadKacy } from '../airport';
import { ARRIVING, cmd, find, HOLDING, makeEngine, makeScenario, run, runUntil } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { alongCross, findRunwayEnd, runwayIntersection } from './runways';
import { INTERSECTION_WAKE_INTERVAL_SEC } from './conflicts';
import { ftToM, mToFt } from './geo';

const fixture = createTestAirport();
const kacy = loadKacy();

const DEP = (cs: string, type: string, rwy: string) => ({
  atSec: 0, callsign: cs, type, flightRules: 'VFR' as const, isDeparture: true, initialFrequencyId: 'TWR',
  start: { kind: 'airborne' as const, pos: { x: 0, y: 0 }, altitudeFt: 400, headingDeg: 0, speedKt: 80, runwayEnd: rwy },
});

function place(e: SimulationEngine, ap: Airport, cs: string, end: string, alongM: number): void {
  const g = findRunwayEnd(ap, end)!;
  const ac = find(e, cs);
  ac.pos = { x: g.end.threshold.x + g.dir.x * alongM, y: g.end.threshold.y + g.dir.y * alongM };
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
}

describe('runway intersection geometry', () => {
  it('the centrelines of 13/31 and 4/22 cross at the fixture origin; 4/22 and 13/31 cross on KACY', () => {
    const p = runwayIntersection(fixture.runways[0], fixture.runways[1])!;
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1);
    const k = runwayIntersection(kacy.runways[0], kacy.runways[1]);
    expect(k).toBeDefined();
  });
});

describe('departure on 22 vs traffic on 13/31 (fixture)', () => {
  const dep22 = (extra: object[], mode: 'training' | 'free_play' = 'training') => {
    const e = makeEngine({ scenario: makeScenario({ mode, spawns: [HOLDING('DEP1', 'H22', '22', 'C172'), ...(extra as never[])] }) });
    run(e, 2);
    return e;
  };
  const takeoff = (e: SimulationEngine) => e.applyCommand(cmd('TAKEOFF', 'DEP1', { runwayEnd: '22' }));

  it('a preceding departure on 13 that has not passed the intersection blocks; one that has passed it (even before it was 200 ft) does not', () => {
    const e1 = dep22([DEP('PREC', 'C172', '13')]);
    place(e1, fixture, 'PREC', '13', 1000 - 300); // 300 m short of the intersection (s = 1000 m from the 13 threshold), 400 ft AGL
    const r1 = takeoff(e1);
    expect(r1.status).toBe('rejected');
    if (r1.status === 'rejected') expect(r1.reason).toMatch(/before PREC departing runway 13\/31 has passed the intersection \(\d+ ft short of it\)/);
    const e2 = dep22([DEP('PREC', 'C172', '13')]);
    place(e2, fixture, 'PREC', '13', 1000 + 200);
    expect(takeoff(e2).status).toBe('accepted');
    // 1,079 ft short of the intersection and above 200 ft: still blocked (the old rule released it)
    const e3 = dep22([DEP('PREC', 'C172', '13')]);
    place(e3, fixture, 'PREC', '13', 1000 - ftToM(1079));
    find(e3, 'PREC').altitudeFt = 75 + 300;
    expect(takeoff(e3).status).toBe('rejected');
  });

  it('a preceding arrival still rolling out before the intersection blocks; once it has passed the intersection it does not', () => {
    const rolling = (alongM: number) => {
      const e = dep22([ARRIVING('ARR', '13', 3, 'C172', 'TWR')]);
      const ac = find(e, 'ARR');
      e.applyCommand(cmd('LAND', 'ARR', { runwayEnd: '13' }));
      ac.onGround = true;
      ac.phase = 'ROLLOUT';
      ac.groundSpeedKt = 30;
      ac.occupyingRunways = ['13/31'];
      place(e, fixture, 'ARR', '13', alongM);
      return e;
    };
    const before = takeoff(rolling(800));
    expect(before.status).toBe('rejected');
    if (before.status === 'rejected') expect(before.reason).toMatch(/still rolling out on runway 13\/31/);
    expect(takeoff(rolling(1200)).status).toBe('accepted');
  });

  it('an arrival still 1-5 nm out on 13 is not by itself unsafe: only if it would reach its threshold before the departure clears the intersection', () => {
    const at = (nm: number) => {
      const e = dep22([ARRIVING('ARR', '13', nm, 'A320', 'TWR')]);
      return takeoff(e);
    };
    expect(at(5).status).toBe('accepted');
    expect(at(4).status).toBe('accepted'); // ~90 s to the threshold; from the hold the C172 needs ~30 s to line up plus ~40 s of roll to pass the intersection
    expect(at(3).status).toBe('rejected'); // ~67 s to the threshold: now refused, the line-up time is part of the departure's occupancy
    const close = at(1);
    expect(close.status).toBe('rejected');
    if (close.status === 'rejected') expect(close.reason).toMatch(/ARR would cross the threshold of runway 13\/31 in \d+ s, before the departure passes the intersection/);
  });
});

describe('arrival on 13 vs departure on 22 (3-10-4, fixture)', () => {
  it('unsafe only if the arrival would cross its threshold before the departure passes the intersection', () => {
    const mk = (nm: number, depCleared: boolean) => {
      const e = makeEngine({ scenario: makeScenario({ mode: 'training', spawns: [ARRIVING('ARR', '13', nm, 'C172', 'TWR'), HOLDING('DEP1', 'H22', '22', 'C172')] }) });
      if (depCleared) find(e, 'DEP1').phase = 'CLEARED_FOR_TAKEOFF'; // cleared, about to roll from the hold
      return e.applyCommand(cmd('LAND', 'ARR', { runwayEnd: '13' }));
    };
    expect(mk(6, false).status).toBe('accepted'); // departure still in position at the hold, arrival far
    // departure rolling, passes the intersection in ~40 s; the arrival is 0.4 nm from the threshold (~20 s)
    const bad = mk(0.4, true);
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') expect(bad.reason).toMatch(/it would cross the threshold of runway 13\/31 in \d+ s, before DEP1 departing runway 4\/22 passes the intersection/);
  });
});

describe('real KACY: A320 departing 22 from the full length', () => {
  it('arrival 3 nm out on 13: fine; 1 nm out: refused', () => {
    const mk = (nm: number) => {
      const e = createEngine({
        airport: kacy, readbackErrorRate: 0,
        scenario: makeScenario({ mode: 'training', activeRunways: { departing: ['22'], landing: ['13'] }, spawns: [HOLDING('NKS1', 'HP4-22-A-2', '22', 'A320'), ARRIVING('ARR', '13', nm, 'A320', 'TWR')] }),
      });
      run(e, 3);
      return e.applyCommand(cmd('TAKEOFF', 'NKS1', { runwayEnd: '22' }));
    };
    expect(mk(3).status).toBe('accepted');
    expect(mk(1).status).toBe('rejected');
  });
});

describe('3-9-7 wake turbulence for an intersection departure (C172 behind an A320 on the same runway)', () => {
  /** A320 departs 13 from the end; the C172 waits at the D intersection (4,900 ft down the runway). */
  const setup = () => {
    const e = makeEngine({ scenario: makeScenario({ mode: 'training', spawns: [HOLDING('A320X', 'H13', '13', 'A320'), HOLDING('C172X', 'D_h13S', '13', 'C172')] }) });
    run(e, 2);
    expect(e.applyCommand(cmd('TAKEOFF', 'A320X', { runwayEnd: '13' })).status).toBe('accepted');
    expect(runUntil(e, () => !find(e, 'A320X').onGround, 120)).toBe(true);
    return { e, tOff: e.getState().clock.timeSec };
  };

  it('refused until 3 minutes after the preceding aircraft took off ("hold for wake turbulence"), then accepted', () => {
    const { e, tOff } = setup();
    run(e, 40);
    const early = e.applyCommand(cmd('TAKEOFF', 'C172X', { runwayEnd: '13' }));
    expect(early.status).toBe('rejected');
    if (early.status === 'rejected') {
      expect(early.unsafe).toBe(true);
      expect(early.reason).toMatch(/Category I\) from an intersection \(\d+ ft from the runway end\).*hold for wake turbulence, 3 minutes required/);
      expect(early.reason).toMatch(/3-9-7/);
    }
    // 2.5 s roll delay: clearance at 177.5 s after takeoff is the first that satisfies "start roll at least 3 minutes after"
    run(e, tOff + INTERSECTION_WAKE_INTERVAL_SEC - ROLL - e.getState().clock.timeSec + 0.2);
    expect(e.applyCommand(cmd('TAKEOFF', 'C172X', { runwayEnd: '13' })).status).toBe('accepted');
  });

  it('does not apply to a full-length departure (3-9-6 has no time interval behind a Large aircraft)', () => {
    const full = makeEngine({ scenario: makeScenario({ mode: 'training', spawns: [HOLDING('A320X', 'H13', '13', 'A320'), HOLDING('C172X', 'H13', '13', 'C172')] }) });
    run(full, 2);
    const g = findRunwayEnd(fixture, '13')!;
    // the C172 is at the runway end too (alongside) and the A320 is far down the runway, airborne
    const a = find(full, 'A320X');
    a.onGround = false;
    a.phase = 'DEPARTURE';
    a.altitudeFt = 600;
    a.pos = { x: g.end.threshold.x + g.dir.x * ftToM(9000), y: g.end.threshold.y + g.dir.y * ftToM(9000) };
    full.getState().events.push({ id: 'ev-x', timeSec: 0, kind: 'INFO', aircraftId: a.id, callsign: 'A320X', text: 'airborne', severity: 'info', speaker: 'SYSTEM', data: { airborne: true, runwayEnd: '13', runwayId: '13/31' } });
    expect(mToFt(alongCross(g, find(full, 'C172X').pos).along)).toBeLessThan(500);
    expect(full.applyCommand(cmd('TAKEOFF', 'C172X', { runwayEnd: '13' })).status).toBe('accepted');
  });
});
const ROLL = 2.5;
