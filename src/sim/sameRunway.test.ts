/** Same-runway separation, JO 7110.65 3-9-6 (departures) / 3-10-3 (arrivals) with the categorical distances. */
import { describe, expect, it } from 'vitest';
import type { SimulationEngine } from './api';
import type { Airport, ScenarioAircraftSpawn } from './types';
import { createEngine } from './engine';
import { ARRIVING, cmd, find, HOLDING, makeEngine, makeScenario, run } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { loadKacy } from '../airport';
import { ftToM, mToFt } from './geo';
import { C172, registerPerformance } from './performance';
import { findRunwayEnd, alongCross } from './runways';
import { srsMinimumFt } from './conflicts';
import { srsCategory } from './performance';

const fixture = createTestAirport();

const DEP = (callsign: string, type: string, rwy = '13'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type, flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 400, headingDeg: 118, speedKt: type === 'A320' ? 170 : 80, runwayEnd: rwy },
});

/** Put an aircraft `alongFt` down runway `end` from its threshold (on the centreline). */
function place(e: SimulationEngine, airport: Airport, cs: string, end: string, alongFt: number): void {
  const g = findRunwayEnd(airport, end)!;
  const ac = find(e, cs);
  ac.pos = { x: g.end.threshold.x + g.dir.x * ftToM(alongFt), y: g.end.threshold.y + g.dir.y * ftToM(alongFt) };
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
}

/** Gap (ft) the TAKEOFF test uses: the preceding aircraft is `gapFt` ahead of the succeeding one's start of roll. */
function takeoffCase(opts: { airport?: Airport; hold?: string; end?: string; succ: string; prec: string; gapFt: number; mode?: 'training' | 'free_play' }) {
  const airport = opts.airport ?? fixture;
  const end = opts.end ?? '13';
  const spawns = [HOLDING('SUCC', opts.hold ?? 'H13', end, opts.succ), DEP('PREC', opts.prec, end)];
  const scenario = makeScenario({ spawns, mode: opts.mode ?? 'training', activeRunways: { departing: [end], landing: [end] } });
  const e = airport === fixture ? makeEngine({ scenario }) : createEngine({ airport, scenario, readbackErrorRate: 0 });
  run(e, 2);
  const startAlong = mToFt(alongCross(findRunwayEnd(airport, end)!, find(e, 'SUCC').pos).along);
  place(e, airport, 'PREC', end, startAlong + opts.gapFt);
  return { e, airport, result: e.applyCommand(cmd('TAKEOFF', 'SUCC', { runwayEnd: end })) };
}

describe('SRS categories and minima (3-9-6 / 3-10-3)', () => {
  it('C172 = I, A320 = III; the distance table', () => {
    registerPerformance({ ...C172, type: 'PA34', category: 'light' });
    expect(srsCategory('C172')).toBe(1);
    expect(srsCategory('A320')).toBe(3);
    expect(srsCategory('PA34')).toBe(2);
    expect(srsCategory('B738')).toBe(3); // unknown jets: all other aircraft
    expect(srsMinimumFt('C172', 'C172')).toBe(3000);
    expect(srsMinimumFt('C172', 'PA34')).toBe(3000); // Category I preceded by Category II
    expect(srsMinimumFt('PA34', 'C172')).toBe(4500); // the succeeding aircraft is Category II
    expect(srsMinimumFt('PA34', 'PA34')).toBe(4500);
    expect(srsMinimumFt('A320', 'C172')).toBe(6000);
    expect(srsMinimumFt('C172', 'A320')).toBe(6000);
    expect(srsMinimumFt('PA34', 'A320')).toBe(6000);
    expect(srsMinimumFt('A320', 'A320')).toBe(6000);
  });
});

describe('takeoff behind an airborne departure (fixture runway 13)', () => {
  it('C172 behind C172: allowed at 3,000 ft, refused inside it', () => {
    expect(takeoffCase({ succ: 'C172', prec: 'C172', gapFt: 3200 }).result.status).toBe('accepted');
    const bad = takeoffCase({ succ: 'C172', prec: 'C172', gapFt: 2800 }).result;
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') {
      expect(bad.unsafe).toBe(true);
      expect(bad.reason).toMatch(/PREC \(category 1\) airborne only \d+ ft ahead.*3-9-6 needs 3000 ft/);
      expect(bad.reason).toMatch(/7110\.65 3-9-6/);
    }
  });

  it('A320 behind C172 at 4,000 ft: refused (6,000 required); allowed at 6,200', () => {
    const bad = takeoffCase({ succ: 'A320', prec: 'C172', gapFt: 4000 }).result;
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') expect(bad.reason).toMatch(/3-9-6 needs 6000 ft/);
    expect(takeoffCase({ succ: 'A320', prec: 'C172', gapFt: 6200 }).result.status).toBe('accepted');
  });

  it('A320 behind A320: allowed at 6,500 ft airborne, refused at 5,500; C172 behind A320 also needs 6,000', () => {
    expect(takeoffCase({ succ: 'A320', prec: 'A320', gapFt: 6500 }).result.status).toBe('accepted');
    expect(takeoffCase({ succ: 'A320', prec: 'A320', gapFt: 5500 }).result.status).toBe('rejected');
    expect(takeoffCase({ succ: 'C172', prec: 'A320', gapFt: 4000 }).result.status).toBe('rejected');
    expect(takeoffCase({ succ: 'C172', prec: 'A320', gapFt: 6100 }).result.status).toBe('accepted');
  });

  it('Category II: a twin behind a single needs 4,500 ft, a single behind a twin only 3,000', () => {
    registerPerformance({ ...C172, type: 'PA34', category: 'light' });
    expect(takeoffCase({ succ: 'PA34', prec: 'C172', gapFt: 4000 }).result.status).toBe('rejected');
    expect(takeoffCase({ succ: 'PA34', prec: 'C172', gapFt: 4700 }).result.status).toBe('accepted');
    expect(takeoffCase({ succ: 'C172', prec: 'PA34', gapFt: 3200 }).result.status).toBe('accepted');
  });

  it('an aircraft that has crossed the runway end or turned away no longer counts; one still on the ground always does', () => {
    const past = takeoffCase({ succ: 'A320', prec: 'A320', gapFt: 100 });
    expect(past.result.status).toBe('rejected'); // 100 ft ahead
    // beyond the runway end
    const e = makeEngine({ scenario: makeScenario({ spawns: [HOLDING('SUCC', 'H13', '13', 'A320'), DEP('PREC', 'A320')], mode: 'training' }) });
    run(e, 2);
    place(e, fixture, 'PREC', '13', mToFt(findRunwayEnd(fixture, '13')!.lengthM) + 500);
    expect(e.applyCommand(cmd('TAKEOFF', 'SUCC', { runwayEnd: '13' })).status).toBe('accepted');
    // turned away: 3,000 ft ahead but 800 m off the centreline
    const t = makeEngine({ scenario: makeScenario({ spawns: [HOLDING('SUCC', 'H13', '13', 'A320'), DEP('PREC', 'A320')], mode: 'training' }) });
    run(t, 2);
    place(t, fixture, 'PREC', '13', 3000);
    const prec = find(t, 'PREC');
    const g = findRunwayEnd(fixture, '13')!;
    prec.pos = { x: prec.pos.x + g.right.x * 800, y: prec.pos.y + g.right.y * 800 };
    expect(t.applyCommand(cmd('TAKEOFF', 'SUCC', { runwayEnd: '13' })).status).toBe('accepted');
    // a rolling departure is "occupied"
    const r = makeEngine({ scenario: makeScenario({ spawns: [HOLDING('SUCC', 'A_h13S', '13', 'A320'), HOLDING('PREC', 'H13', '13', 'C172')], mode: 'training' }) });
    run(r, 2);
    expect(r.applyCommand(cmd('TAKEOFF', 'PREC', { runwayEnd: '13' })).status).toBe('accepted');
    run(r, 8);
    expect(r.applyCommand(cmd('TAKEOFF', 'SUCC', { runwayEnd: '13' })).status).toBe('rejected');
  });

  it('free play accepts and flags it as an unsafe clearance (scored)', () => {
    const { e, result } = takeoffCase({ succ: 'A320', prec: 'C172', gapFt: 4000, mode: 'free_play' });
    expect(result.status).toBe('accepted');
    run(e, 1);
    expect(e.getState().score.unsafeInstructions).toBeGreaterThanOrEqual(1);
    expect(e.getState().conflicts.some((c) => c.kind === 'UNSAFE_CLEARANCE' && /3-9-6/.test(c.text))).toBe(true);
  });

  it('anticipating separation (3-9-5), conservative: an allowed clearance does not raise a surface conflict while the leader climbs out', () => {
    const { e, result } = takeoffCase({ succ: 'C172', prec: 'C172', gapFt: 3400 });
    expect(result.status).toBe('accepted');
    run(e, 40);
    expect(e.getState().events.filter((x) => x.kind === 'CONFLICT' || x.kind === 'RUNWAY_INCURSION')).toHaveLength(0);
    expect(e.getState().conflicts).toHaveLength(0);
  });
});

describe('landing clearance (3-10-3)', () => {
  const landCase = (type: string, prec: { type: string; gapFt: number } | undefined, mode: 'training' | 'free_play' = 'training') => {
    const spawns = [ARRIVING('LAND1', '13', 3, type, 'TWR'), ...(prec ? [DEP('PREC', prec.type)] : [])];
    const e = makeEngine({ scenario: makeScenario({ spawns, mode }) });
    run(e, 1);
    if (prec) place(e, fixture, 'PREC', '13', prec.gapFt);
    return { e, result: e.applyCommand(cmd('LAND', 'LAND1', { runwayEnd: '13' })) };
  };

  it('anticipated: the preceding departure airborne 6,000+ ft down the runway -> allowed; closer -> refused', () => {
    expect(landCase('A320', { type: 'A320', gapFt: 6200 }).result.status).toBe('accepted');
    const bad = landCase('A320', { type: 'A320', gapFt: 5000 }).result;
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') expect(bad.reason).toMatch(/3-10-3 needs 6000 ft/);
    expect(landCase('C172', { type: 'C172', gapFt: 3200 }).result.status).toBe('accepted');
    expect(landCase('C172', { type: 'C172', gapFt: 2500 }).result.status).toBe('rejected');
    expect(landCase('C172', { type: 'A320', gapFt: 4000 }).result.status).toBe('rejected'); // either Category III: 6,000
    expect(landCase('C172', undefined).result.status).toBe('accepted');
  });

  it('refused while a landing/departing aircraft is still on the runway (no distance exception without daylight judgement)', () => {
    const e = makeEngine({ scenario: makeScenario({ spawns: [ARRIVING('LAND1', '13', 3, 'C172', 'TWR'), HOLDING('DEP1', 'H13', '13', 'C172')], mode: 'training' }) });
    run(e, 2);
    expect(e.applyCommand(cmd('TAKEOFF', 'DEP1', { runwayEnd: '13' })).status).toBe('accepted');
    run(e, 4);
    const r = e.applyCommand(cmd('LAND', 'LAND1', { runwayEnd: '13' }));
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toMatch(/cleared for takeoff \/ rolling|occupied/);
  });
});

describe('same-runway separation on real KACY (10,001 ft runway 13)', () => {
  const kacy = loadKacy();
  it('A320 behind C172 at 4,000 ft refused, behind A320 at 6,500 ft allowed (from the Charlie hold)', () => {
    expect(takeoffCase({ airport: kacy, hold: 'HP13-31-C-1', succ: 'A320', prec: 'C172', gapFt: 4000 }).result.status).toBe('rejected');
    expect(takeoffCase({ airport: kacy, hold: 'HP13-31-C-1', succ: 'A320', prec: 'A320', gapFt: 6500 }).result.status).toBe('accepted');
    expect(takeoffCase({ airport: kacy, hold: 'HP13-31-C-1', succ: 'C172', prec: 'C172', gapFt: 3200 }).result.status).toBe('accepted');
  });
});
