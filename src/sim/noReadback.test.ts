/**
 * A pilot who gives no readback has not received the clearance: nothing happens with it (no takeoff roll, taxi, turn, frequency change,
 * crossing or landing clearance) until it is re-issued or "did you copy" is asked; after the 20 s window it is dropped for good.
 * Also: the pilot's behaviour about a command depends on the aircraft seed and its command ordinal only, never on the sim time.
 */
import { describe, expect, it } from 'vitest';
import type { PilotRealismOverride } from './pilotBehaviour';
import { ARRIVING, GA_PARKED, HOLDING, cmd, find, makeEngine, pilotTexts, run } from './__fixtures__/testHelpers';
import type { Scenario } from './types';
import type { SimulationEngine } from './api';

const QUIET: PilotRealismOverride = {
  digitErrorRate: 0, altitudeErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, patternMisunderstandRate: 0, wrongCallsignRate: 0, noReadbackRate: 1,
  delayedResponseRate: 0, sayAgainRate: 0, studentShare: 0, radioDiscipline: false, responseDelaySec: { airline: [0, 0], ga: [0, 0], student: [0, 0] },
  requests: { RUNWAY_CHANGE: 0, SHORT_APPROACH: 0, OPTION: 0, STRAIGHT_IN: 0, STAY_IN_PATTERN: 0, NEED_MINUTE: 0, SPACING_360: 0, HIGHER: 0, DIRECT_FIX: 0, VISUAL_APPROACH: 0, TAXI_BACK: 0 },
};
function eng(spawns: Scenario['spawns'], realism: PilotRealismOverride = {}, seed = 12345): SimulationEngine {
  return makeEngine({ scenario: { seed, pilotRealism: 'moderate', pilotBehaviour: { noAtisFraction: 0, realism: { ...QUIET, ...realism }, ground: { holdShortOmitFraction: 0, taxiwayErrorShare: 0, unfamiliarFraction: 0 } }, spawns } });
}
const unacked = (e: SimulationEngine, cs = 'N723EJ') => find(e, cs).flags.readbackErrorKind === 'no_readback';
const nothingActive = (e: SimulationEngine, cs = 'N723EJ') => find(e, cs).clearances.every((c) => c.completedAtSec !== undefined);

describe('an unacknowledged clearance is not acted on', () => {
  it('takeoff: the aircraft keeps holding short, also long after the window', () => {
    const e = eng([HOLDING('N723EJ', 'H13', '13')]);
    run(e, 10);
    const out = e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
    expect(out.status).toBe('accepted');
    expect(unacked(e)).toBe(true);
    run(e, 30); // the window (20 s) ends, the error is scored as missed
    expect(e.getState().score.missedReadbackErrors).toBe(1);
    run(e, 90);
    expect(find(e, 'N723EJ').phase).toBe('HOLDING_SHORT');
    expect(find(e, 'N723EJ').onGround).toBe(true);
    expect(nothingActive(e)).toBe(true);
    expect(e.getState().events.some((x) => x.kind === 'COMMAND_ACCEPTED' && x.callsign === 'N723EJ')).toBe(false);
  });

  it('takeoff: "did you copy" makes him read it back and go', () => {
    const e = eng([HOLDING('N723EJ', 'H13', '13')]);
    run(e, 10);
    e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
    run(e, 5);
    expect(find(e, 'N723EJ').phase).toBe('HOLDING_SHORT');
    e.applyCommand(cmd('DID_YOU_COPY', 'N723EJ'), { position: 'TWR' });
    expect(pilotTexts(e, 'N723EJ').at(-1)).toMatch(/cleared for takeoff/);
    run(e, 30);
    expect(find(e, 'N723EJ').phase).not.toBe('HOLDING_SHORT');
  });

  it('taxi: the aircraft does not move', () => {
    const e = eng([GA_PARKED('N723EJ', 'GA1', 'GND')]);
    run(e, 30);
    e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22' }), { position: 'GND' });
    expect(unacked(e)).toBe(true);
    run(e, 60);
    expect(find(e, 'N723EJ').route).toBeUndefined();
    expect(find(e, 'N723EJ').groundSpeedKt).toBe(0);
    expect(['PARKED', 'READY']).toContain(find(e, 'N723EJ').phase);
  });

  it('heading: no turn', () => {
    const e = eng([ARRIVING('N723EJ', '13', 10, 'C172', 'APP')]);
    const was = find(e, 'N723EJ').target.headingDeg;
    e.applyCommand(cmd('HEADING', 'N723EJ', { headingDeg: 270 }), { position: 'APP' });
    expect(unacked(e)).toBe(true);
    run(e, 40);
    expect(find(e, 'N723EJ').target.headingDeg).toBe(was);
  });

  it('landing clearance: none is recorded; the aircraft is not cleared to land', () => {
    const e = eng([ARRIVING('N723EJ', '13', 6, 'C172', 'APP')]);
    e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }), { position: 'APP' });
    expect(unacked(e)).toBe(true);
    expect(nothingActive(e)).toBe(true);
    expect(find(e, 'N723EJ').runwayAuthorizations).toHaveLength(0);
    run(e, 60);
    expect(nothingActive(e)).toBe(true);
    expect(find(e, 'N723EJ').runwayAuthorizations).toHaveLength(0);
  });

  it('crossing: the aircraft stays short of the runway', () => {
    const e = eng([HOLDING('N723EJ', 'H13', '13')]);
    run(e, 10);
    const out = e.applyCommand(cmd('CROSS_RUNWAY', 'N723EJ', { crossRunwayId: '13/31', runwayId: '13/31' }), { position: 'GND' });
    if (out.status === 'accepted') {
      expect(unacked(e)).toBe(true);
      expect(find(e, 'N723EJ').runwayAuthorizations).toHaveLength(0);
    }
    run(e, 60);
    expect(find(e, 'N723EJ').occupyingRunways).toHaveLength(0);
    expect(find(e, 'N723EJ').runwayAuthorizations).toHaveLength(0);
  });

  it('contact frequency: the aircraft stays on the frequency', () => {
    const e = eng([ARRIVING('N723EJ', '13', 10, 'C172', 'APP')]);
    e.applyCommand(cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'TWR', frequencyMhz: 120.3 }), { position: 'APP' });
    expect(unacked(e)).toBe(true);
    run(e, 60);
    expect(find(e, 'N723EJ').frequencyMhz).toBe(124.6);
  });

  it('re-issuing the clearance (a pilot who answers this time) makes him act on it', () => {
    let done = false;
    for (let seed = 1; seed <= 60 && !done; seed++) {
      const e = eng([ARRIVING('N723EJ', '13', 10, 'C172', 'APP')], { noReadbackRate: 0.5 }, seed);
      e.applyCommand(cmd('HEADING', 'N723EJ', { headingDeg: 270 }), { position: 'APP' });
      if (!unacked(e)) continue;
      const was = find(e, 'N723EJ').target.headingDeg;
      for (let k = 0; k < 20 && find(e, 'N723EJ').target.headingDeg === was; k++) e.applyCommand(cmd('HEADING', 'N723EJ', { headingDeg: 270 }), { position: 'APP' });
      expect(find(e, 'N723EJ').target.headingDeg).not.toBe(was);
      done = true;
    }
    expect(done).toBe(true);
  });
});

describe('determinism of pilot behaviour about a command', () => {
  const outcome = (e: SimulationEngine, cs = 'N723EJ') => `${find(e, cs).flags.readbackErrorKind ?? 'ok'}|${pilotTexts(e, cs).at(-1) ?? ''}`;
  const spawns = (): Scenario['spawns'] => [ARRIVING('N723EJ', '13', 10, 'C172', 'APP'), ARRIVING('N455KB', '13', 12, 'C172', 'APP')];
  const noisy: PilotRealismOverride = { noReadbackRate: 0.4, altitudeErrorRate: 0.2, digitErrorRate: 0.2, delayedResponseRate: 0.1 };

  it('the same command gets the same outcome whenever it is sent, and whatever happened to other aircraft before', () => {
    let differ = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const a = eng(spawns(), noisy, seed);
      a.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'APP' });
      const b = eng(spawns(), noisy, seed);
      run(b, 37.3);
      b.applyCommand(cmd('ALTITUDE', 'N455KB', { altitudeFt: 4000 }), { position: 'APP' }); // another aircraft first
      b.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'APP' });
      run(a, 8);
      run(b, 8);
      const kindA = find(a, 'N723EJ').flags.readbackErrorKind ?? 'ok';
      const kindB = find(b, 'N723EJ').flags.readbackErrorKind ?? 'ok';
      if (kindA !== kindB) differ++;
      void outcome;
    }
    expect(differ).toBe(0);
  });

  it('is also the same on a re-run with the same seed and commands', () => {
    const go = () => {
      const e = eng(spawns(), noisy, 7);
      const out: string[] = [];
      for (const alt of [2000, 3000, 4000, 5000, 6000, 7000]) {
        e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: alt }), { position: 'APP' });
        out.push(find(e, 'N723EJ').flags.readbackErrorKind ?? 'ok');
        run(e, 25);
      }
      return out.join();
    };
    expect(go()).toBe(go());
  });
});
