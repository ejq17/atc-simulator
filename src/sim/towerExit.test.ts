/** Runway exit and after-landing instructions (JO 7110.65 3-10-9): exit choice honoured when physically possible, "unable" otherwise, hold short of an intersecting runway. */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import { loadKacy } from '../airport';
import { ARRIVING, cmd, find, makeScenario, pilotTexts, runUntil, say } from './__fixtures__/testHelpers';
import { alongCross, findRunwayEnd } from './runways';
import { mToFt } from './geo';

const kacy = loadKacy();

function landing(type: string, rwy: string, distanceNm = 4): { e: SimulationEngine; cs: string } {
  const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [rwy], landing: [rwy] }, spawns: [ARRIVING('X1', rwy, distanceNm, type, 'TWR')] }) });
  return { e, cs: 'X1' };
}

const exitCmd = (f: Parameters<typeof cmd>[2]) => cmd('EXIT_RUNWAY', 'X1', f);

/** Run until the aircraft leaves the runway (RUNWAY_EXIT) or stops; returns where along the landing runway it exited. */
function exitAlongFt(e: SimulationEngine, rwy: string): { alongFt: number; touched: string[] } {
  const ac = find(e, 'X1');
  const g = findRunwayEnd(kacy, rwy)!;
  const touched = new Set<string>();
  let alongFt = -1;
  runUntil(e, () => {
    for (const r of ac.occupyingRunways) touched.add(r);
    if (alongFt < 0 && ac.phase === 'RUNWAY_EXIT') alongFt = mToFt(alongCross(g, ac.pos).along);
    return ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.1;
  }, 900);
  return { alongFt, touched: [...touched] };
}

describe('exit instruction honoured', () => {
  it('on final: a C172 landing on 13 told "turn right at Alpha" exits at A (4,444 ft) instead of C (2,017 ft)', () => {
    const { e } = landing('C172', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    const out = say(e, exitCmd({ exitTaxiway: 'A', turnDirection: 'right' }), 'TWR');
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Turn right at alpha, x-ray one');
    const r = exitAlongFt(e, '13');
    expect(Math.round(r.alongFt)).toBe(4444);
    expect(find(e, 'X1').route?.nodeIds.at(-1)).toMatch(/A/);
  });

  it('during the rollout: the plan is replaced while rolling', () => {
    const { e } = landing('C172', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    const ac = find(e, 'X1');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 400)).toBe(true);
    expect(say(e, exitCmd({ exitTaxiway: 'A', turnDirection: 'right' }), 'TWR').status).toBe('accepted');
    expect(Math.round(exitAlongFt(e, '13').alongFt)).toBe(4444);
  });

  it('"continue to the end" takes the last exit of the runway', () => {
    const { e } = landing('C172', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    expect(say(e, exitCmd({ destination: 'END' }), 'TWR').status).toBe('accepted');
    expect(Math.round(exitAlongFt(e, '13').alongFt)).toBe(7801);
  });

  it('"turn left next taxiway": the first exit on the left that can be made (C has only a right-hand connector, so A)', () => {
    const { e } = landing('C172', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    expect(say(e, exitCmd({ turnDirection: 'left', destination: 'NEXT' }), 'TWR').status).toBe('accepted');
    const r = exitAlongFt(e, '13');
    expect(Math.round(r.alongFt)).toBe(4444);
  });

  it('combined with "contact Ground": the frequency changes only after the aircraft is clear of the runway', () => {
    const { e } = landing('C172', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    const ac = find(e, 'X1');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 400)).toBe(true);
    expect(say(e, exitCmd({ exitTaxiway: 'C', turnDirection: 'right' }), 'TWR').status).toBe('accepted');
    expect(say(e, cmd('CONTACT_FREQUENCY', 'X1', { frequencyId: 'GND' }), 'TWR').status).toBe('accepted');
    for (let i = 0; i < 100; i++) e.step(); // ten seconds later the aircraft is still rolling out on the Tower frequency
    expect(ac.phase === 'ROLLOUT' ? ac.frequencyId : 'TWR').toBe('TWR');
    expect(runUntil(e, () => ac.frequencyId === 'GND', 200)).toBe(true);
    expect(ac.occupyingRunways).toEqual([]);
    expect(ac.phase).not.toBe('ROLLOUT');
  });
});

describe('exit instruction refused or not possible', () => {
  it('a taxiway that does not leave the runway: unable, no change', () => {
    const { e } = landing('C172', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    const out = say(e, exitCmd({ exitTaxiway: 'K', turnDirection: 'left' }), 'TWR');
    expect(out.status).toBe('rejected');
    expect(pilotTexts(e).at(-1)).toMatch(/^Unable, we don't see taxiway kilo off this runway/);
    expect(Math.round(exitAlongFt(e, '13').alongFt)).toBe(2017);
  });

  it('the wrong side: "turn left at Charlie" when C only leaves to the right is refused', () => {
    const { e } = landing('C172', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    expect(say(e, exitCmd({ exitTaxiway: 'C', turnDirection: 'left' }), 'TWR').status).toBe('rejected');
  });

  it('an A320 rolling out fast cannot make a nearby exit it has already passed or cannot slow for: "unable" at once', () => {
    const { e } = landing('A320', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    const ac = find(e, 'X1');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 400)).toBe(true);
    const out = say(e, exitCmd({ exitTaxiway: 'C', turnDirection: 'right' }), 'TWR');
    expect(out.status).toBe('rejected');
    expect(pilotTexts(e).at(-1)).toMatch(/^Unable, we're too fast to make charlie/);
  });

  it('given on final, an exit the A320 cannot make is declined on touchdown: "unable Charlie, will exit at Alpha", and it exits where it can', () => {
    const { e } = landing('A320', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    expect(say(e, exitCmd({ exitTaxiway: 'C', turnDirection: 'right' }), 'TWR').status).toBe('accepted');
    const r = exitAlongFt(e, '13');
    expect(r.alongFt).toBeGreaterThan(4000);
    expect(pilotTexts(e).some((t) => /unable charlie, will exit at alpha/.test(t))).toBe(true);
  });
});

describe('hold short of an intersecting runway after landing (3-10-9, 3-10-4)', () => {
  it('without the instruction an A320 landing on 13 rolls through the intersection with 4/22 to exit at A (baseline)', () => {
    const { e } = landing('A320', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    const r = exitAlongFt(e, '13');
    expect(r.touched).toContain('4/22');
  });

  it('"hold short of runway 4" given on final: the aircraft stops before the intersecting runway and never enters it', () => {
    const { e } = landing('A320', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    const out = say(e, cmd('HOLD_SHORT', 'X1', { holdShort: ['RWY4'], runwayEnd: '4', runwayId: '4/22' }), 'TWR');
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Hold short of runway four, x-ray one');
    const r = exitAlongFt(e, '13');
    expect(r.touched).not.toContain('4/22');
    const ac = find(e, 'X1');
    const g = findRunwayEnd(kacy, '13')!;
    expect(mToFt(alongCross(g, ac.pos).along)).toBeLessThan(3942 - 100);
  });

  it('given during the rollout, when the maximum braking can no longer stop it short, the pilot is unable', () => {
    const { e } = landing('A320', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    const ac = find(e, 'X1');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 400)).toBe(true);
    expect(say(e, cmd('HOLD_SHORT', 'X1', { holdShort: ['RWY4'], runwayEnd: '4', runwayId: '4/22' }), 'TWR').status).toBe('rejected');
    expect(pilotTexts(e).at(-1)).toMatch(/^Unable, we can't hold short of runway four/);
  });

  it('an aircraft that cannot stop short of the runway (A320 on 22: the intersection with 13/31 is 650 ft past its touchdown point) says "unable"', () => {
    const { e } = landing('A320', '22');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '22' }));
    const out = say(e, cmd('HOLD_SHORT', 'X1', { holdShort: ['RWY13'], runwayEnd: '13', runwayId: '13/31' }), 'TWR');
    expect(out.status).toBe('rejected');
    expect(pilotTexts(e).at(-1)).toMatch(/^Unable, we can't hold short of runway one three/);
  });

  it('a C172 that exits at C before the intersection is not affected', () => {
    const { e } = landing('C172', '13');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    say(e, cmd('HOLD_SHORT', 'X1', { holdShort: ['RWY4'], runwayEnd: '4', runwayId: '4/22' }), 'TWR');
    expect(Math.round(exitAlongFt(e, '13').alongFt)).toBe(2017);
  });
});
