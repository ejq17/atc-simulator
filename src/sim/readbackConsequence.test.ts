/**
 * An uncorrected readback error is flown (commandExecutor.flyMisread / planMisread): when the 20 s correction window ends without a
 * correction the aircraft does what it read back; time-critical instructions are flown as read back at once. Pilot realism on only.
 */
import { describe, expect, it } from 'vitest';
import type { PilotRealismOverride } from './pilotBehaviour';
import { ARRIVING, GA_PARKED, HOLDING, cmd, find, makeEngine, run } from './__fixtures__/testHelpers';
import type { Scenario } from './types';
import type { SimulationEngine } from './api';

const CLEAN: PilotRealismOverride = {
  digitErrorRate: 0, altitudeErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, patternMisunderstandRate: 0, wrongCallsignRate: 0, noReadbackRate: 0,
  delayedResponseRate: 0, sayAgainRate: 0, studentShare: 0, radioDiscipline: false, responseDelaySec: { airline: [0, 0], ga: [0, 0], student: [0, 0] },
  requests: { RUNWAY_CHANGE: 0, SHORT_APPROACH: 0, OPTION: 0, STRAIGHT_IN: 0, STAY_IN_PATTERN: 0, NEED_MINUTE: 0, SPACING_360: 0, HIGHER: 0, DIRECT_FIX: 0, VISUAL_APPROACH: 0, TAXI_BACK: 0 },
};
function eng(realism: PilotRealismOverride, spawns: Scenario['spawns'], over: { level?: Scenario['pilotRealism']; digit?: number; ground?: Record<string, number> } = {}): SimulationEngine {
  return makeEngine({
    scenario: { pilotRealism: over.level ?? 'moderate', pilotBehaviour: { noAtisFraction: 0, realism: { ...CLEAN, ...realism }, ground: { holdShortOmitFraction: 0, taxiwayErrorShare: 0, unfamiliarFraction: 0, ...over.ground } }, spawns },
    opts: { readbackErrorRate: over.digit ?? 0 },
  });
}
const flown = (e: SimulationEngine) => e.getState().events.filter((x) => x.data?.flownReadbackError);
const A = () => [ARRIVING('N723EJ', '13', 10, 'C172', 'APP')];

describe('uncorrected readback errors are flown after the 20 s window', () => {
  it('heading: the aircraft turns to the heading it read back', () => {
    const e = eng({}, A(), { digit: 1 });
    e.applyCommand(cmd('HEADING', 'N723EJ', { headingDeg: 270 }), { position: 'APP' });
    const right = find(e, 'N723EJ').target.headingDeg;
    run(e, 15);
    expect(find(e, 'N723EJ').target.headingDeg).toBe(right); // still the controller's heading inside the window
    run(e, 10);
    const now = find(e, 'N723EJ').target.headingDeg;
    expect(Math.abs((((now! - right!) % 360) + 540) % 360 - 180)).toBeCloseTo(10, 0); // 10 degrees off
    expect(flown(e)).toHaveLength(1);
    expect(e.getState().score.missedReadbackErrors).toBe(1);
  });

  it('corrected inside the window: nothing is flown wrong', () => {
    const e = eng({}, A(), { digit: 1 });
    e.applyCommand(cmd('HEADING', 'N723EJ', { headingDeg: 270 }), { position: 'APP' });
    const right = find(e, 'N723EJ').target.headingDeg;
    run(e, 8);
    e.applyCommand(cmd('HEADING', 'N723EJ', { headingDeg: 270 }), { position: 'APP' });
    run(e, 30);
    expect(find(e, 'N723EJ').target.headingDeg).toBe(right);
    expect(flown(e)).toHaveLength(0);
  });

  it('altitude: climbs or descends to the altitude it read back', () => {
    const e = eng({ altitudeErrorRate: 1 }, A());
    e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'APP' });
    expect(find(e, 'N723EJ').target.altitudeFt).toBe(3000);
    run(e, 22);
    const t = find(e, 'N723EJ').target.altitudeFt!;
    expect(t).not.toBe(3000);
    expect(Math.abs(t - 3000) % 1000).toBe(0);
    expect(flown(e)[0].data?.errorKind).toBe('altitude');
  });

  it('frequency: the aircraft switches to the frequency it read back, is lost, and finds its way back', () => {
    const e = eng({ frequencyErrorRate: 1 }, A());
    e.applyCommand(cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'TWR', frequencyMhz: 120.3 }), { position: 'APP' });
    run(e, 15);
    expect(find(e, 'N723EJ').frequencyMhz).toBe(124.6); // waits for the confirmation
    run(e, 10);
    const f = find(e, 'N723EJ').frequencyMhz;
    expect(f).not.toBe(124.6);
    expect(f).not.toBe(120.3);
    run(e, 130);
    expect(find(e, 'N723EJ').frequencyMhz).toBe(120.3);
    expect(e.getState().events.some((x) => x.data?.returnedFromWrongFrequency)).toBe(true);
  });

  it('squawk: the transponder shows the code it read back', () => {
    const e = eng({ squawkErrorRate: 1 }, A());
    e.applyCommand(cmd('SQUAWK', 'N723EJ', { squawk: '4215' }), { position: 'APP' });
    run(e, 22);
    const code = find(e, 'N723EJ').squawk;
    expect(code).toBeDefined();
    expect(code).not.toBe('4215');
    expect(code).toMatch(/^[0-7]{4}$/);
  });

  it('taxi to the wrong runway (digit error): taxis to the runway it read back', () => {
    const e = eng({}, [GA_PARKED('N723EJ', 'GA1', 'GND')], { digit: 1 });
    const out = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22' }), { position: 'GND' });
    expect(out.status).toBe('accepted');
    const rec = find(e, 'N723EJ').flags.readbackErrorKind;
    expect(rec).toBe('runway');
    expect(find(e, 'N723EJ').assignedRunwayEnd).toBe('22');
    run(e, 22);
    const end = find(e, 'N723EJ').assignedRunwayEnd;
    expect(end).not.toBe('22');
    expect(find(e, 'N723EJ').clearances[0].runwayEnd).toBe(end);
    expect(flown(e)).toHaveLength(1);
  });

  it('wrong taxiway in the route: taxis along the route it read back', () => {
    const e = eng({}, [GA_PARKED('N723EJ', 'GA1', 'GND')], { digit: 1, ground: { taxiwayErrorShare: 1 } });
    const out = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'TWY C', route: ['B', 'A'] }), { position: 'GND' });
    if (out.status !== 'accepted') throw new Error(JSON.stringify(out));
    expect(find(e, 'N723EJ').flags.readbackErrorKind).toBe('taxiway');
    run(e, 22);
    expect(find(e, 'N723EJ').clearances[0].route).not.toEqual(['B', 'A']);
    expect(flown(e).length + e.getState().events.filter((x) => /could not fly what it read back/.test(x.text)).length).toBe(1);
  });

  it('pattern: enters the leg it understood', () => {
    const e = eng({ patternMisunderstandRate: 1 }, [ARRIVING('N723EJ', '13', 6)]);
    e.applyCommand(cmd('ENTER_PATTERN', 'N723EJ', { patternLeg: 'left_downwind', runwayEnd: '13' }), { position: 'TWR' });
    run(e, 22);
    expect(find(e, 'N723EJ').clearances[0].patternLeg).not.toBe('left_downwind');
  });

  it('wrong runway for a landing clearance: lands on the runway it read back at once; the correction restores the right one', () => {
    const e = eng({}, A(), { digit: 1 });
    const out = e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }), { position: 'APP' });
    expect(out.status).toBe('accepted');
    expect(find(e, 'N723EJ').flags.readbackErrorKind).toBe('runway');
    const wrong = find(e, 'N723EJ').assignedRunwayEnd;
    expect(wrong).not.toBe('13');
    e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }), { position: 'APP' });
    expect(find(e, 'N723EJ').assignedRunwayEnd).toBe('13');
    expect(find(e, 'N723EJ').flags.readbackErrorPending).toBe(false);
  });

  it('a takeoff clearance read back with another runway: the pilot cannot take off there and queries; nothing moves', () => {
    const e = eng({}, [HOLDING('N723EJ', 'H13', '13', 'C172', 'TWR')], { digit: 1 });
    const out = e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
    expect(out.status).toBe('rejected');
    run(e, 10);
    expect(find(e, 'N723EJ').phase).toBe('HOLDING_SHORT');
  });

  it('wrong callsign: the aircraft that answered flies the clearance meant for the other one', () => {
    const e = eng({ wrongCallsignRate: 1 }, [ARRIVING('N723EJ', '13', 10, 'C172', 'APP'), ARRIVING('N455EJ', '13', 12, 'C172', 'APP')]);
    e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'APP' });
    expect(find(e, 'N455EJ').target.altitudeFt).not.toBe(3000);
    run(e, 22);
    expect(find(e, 'N455EJ').target.altitudeFt).toBe(3000);
    expect(flown(e)[0].data?.otherCallsign).toBe('N455EJ');
  });

  it('no consequence without pilot realism (training lessons, scenarios with no level)', () => {
    for (const level of ['off', undefined] as const) {
      const e = makeEngine({ scenario: { pilotRealism: level, spawns: A() }, opts: { readbackErrorRate: 1 } });
      e.applyCommand(cmd('HEADING', 'N723EJ', { headingDeg: 270 }), { position: 'APP' });
      const right = find(e, 'N723EJ').target.headingDeg;
      run(e, 30);
      expect(find(e, 'N723EJ').target.headingDeg).toBe(right);
      expect(flown(e)).toHaveLength(0);
    }
  });
});
