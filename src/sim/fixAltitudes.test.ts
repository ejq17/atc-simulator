/** Published fix altitudes (InstrumentProcedure.fixAltitudes): the approach descends along the plate profile. */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import { ALL_POSITIONS, AT_FIX, cmd, find, ifrScenario, makeEngine, makeScenario, run, runUntil, say } from './__fixtures__/testHelpers';
import type { ApproachType } from './types';

const kacy = loadKacy();

function crossings(e: SimulationEngine): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ev of e.getState().events) {
    const c = (ev.data as { crossing?: { fix: string; altitudeFt: number } } | undefined)?.crossing;
    if (c) out[c.fix] = c.altitudeFt;
  }
  return out;
}

function flyApproach(e: SimulationEngine, rwy: string, type: ApproachType, nFixes = 3, untilPhase = 'FINAL') {
  const ac = Object.values(e.getState().aircraft)[0];
  run(e, 3);
  expect(say(e, cmd('APPROACH', ac.callsign, { approachType: type, runwayEnd: rwy }), 'APP').status).toBe('accepted');
  expect(runUntil(e, () => ac.phase === untilPhase, 1500)).toBe(true);
  // the last fix (EFEWY) is crossed a little after the final-approach phase starts
  runUntil(e, () => Object.keys(crossings(e)).length >= nFixes, 90);
  return ac;
}

describe('fixture RNAV 22 profile (FX22A min 1800, FX22B 1600, FX22C 1100)', () => {
  it('descends just in time and crosses each fix at the published altitude (+-100 ft), never climbing', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS452', 'FX22F', ['FX22F', 'FX22A', 'FX22B', 'FX22C'], '22', {}, 4000, 160)], { mode: 'training', activeRunways: { departing: ['22'], landing: ['22'] } }) });
    const ac = Object.values(e.getState().aircraft)[0];
    run(e, 3);
    expect(say(e, cmd('APPROACH', 'NKS452', { approachType: 'RNAV', runwayEnd: '22' }), 'APP').status).toBe('accepted');
    let prev = ac.altitudeFt;
    let maxClimb = 0;
    for (let i = 0; i < 12000 && Object.keys(crossings(e)).length < 3; i++) {
      e.step();
      maxClimb = Math.max(maxClimb, ac.altitudeFt - prev);
      prev = ac.altitudeFt;
    }
    expect(maxClimb).toBeLessThan(10); // never climbs (a few feet of overshoot from the vertical-speed controller)
    const c = crossings(e);
    console.info(`fixture RNAV 22 crossings: ${JSON.stringify(c)}`);
    expect(Math.abs(c.FX22A - 1800)).toBeLessThan(100);
    expect(Math.abs(c.FX22B - 1600)).toBeLessThan(100);
    expect(Math.abs(c.FX22C - 1100)).toBeLessThan(100);
  });

  it('a maximum is met by descending to it; a minimum stops the descent', () => {
    // ILS 13 fixture: FX13A "2000 min / 4500 max": an aircraft at 6000 ft over TARR must be at or below 4500 at FX13A
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B'], '13', {}, 6000)], { mode: 'training' }) });
    const ac = Object.values(e.getState().aircraft)[0];
    run(e, 3);
    say(e, cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: '13' }), 'APP');
    runUntil(e, () => ac.phase === 'FINAL', 1500);
    expect(crossings(e).FX13A).toBeLessThanOrEqual(4500 + 100);
    expect(crossings(e).FX13A).toBeGreaterThanOrEqual(2000 - 100);
  });
});

describe('real KACY RNAV 22: KOPCE 1800, FLDER 1600, EFEWY 1100 (plate minimum altitudes)', () => {
  const make = (route: string[], fix: string, alt: number): SimulationEngine =>
    createEngine({
      airport: kacy, readbackErrorRate: 0,
      scenario: makeScenario({
        controllerPositions: ALL_POSITIONS, mode: 'training', activeRunways: { departing: ['22'], landing: ['22'] },
        spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP', start: { kind: 'at_fix', fix, altitudeFt: alt, speedKt: 170, route, runwayEnd: '22' } }],
      }),
    });

  it.skipIf(!kacy.procedures.find((p) => p.name === 'RNAV (GPS) RWY 22')?.fixAltitudes)('crosses KOPCE / FLDER / EFEWY within 100 ft of the published values, and the glidepath is intercepted at the FAF altitude', () => {
    const e = make(['PIDVE', 'KOPCE', 'FLDER', 'EFEWY'], 'PIDVE', 4000);
    flyApproach(e, '22', 'RNAV');
    const c = crossings(e);
    console.info(`KACY RNAV 22 crossings: ${JSON.stringify(c)}`);
    expect(Math.abs(c.KOPCE - 1800)).toBeLessThan(100);
    expect(Math.abs(c.FLDER - 1600)).toBeLessThan(100);
    expect(Math.abs(c.EFEWY - 1100)).toBeLessThan(100);
  });

  it.skipIf(!kacy.procedures.find((p) => p.name === 'RNAV (GPS) RWY 22')?.fixAltitudes)('from KOPCE at 3000 ft: FLDER 1600, EFEWY 1100; lands', () => {
    const e = make(['KOPCE', 'FLDER', 'EFEWY'], 'KOPCE', 3000);
    const ac = flyApproach(e, '22', 'RNAV', 2); // spawned over KOPCE: FLDER and EFEWY are the crossings
    const c = crossings(e);
    expect(Math.abs(c.FLDER - 1600)).toBeLessThan(100);
    expect(Math.abs(c.EFEWY - 1100)).toBeLessThan(100);
    say(e, cmd('CONTACT_FREQUENCY', ac.callsign, { frequencyId: 'TWR' }), 'APP');
    runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'LANDING', 30);
    expect(say(e, cmd('LAND', ac.callsign, { runwayEnd: '22' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT' || ac.phase === 'RUNWAY_EXIT', 600)).toBe(true);
    expect(e.getState().events.some((x) => x.kind === 'GO_AROUND')).toBe(false);
  });
});
void find;
