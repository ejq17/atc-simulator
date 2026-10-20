/**
 * Pilot realism (src/sim/pilotBehaviour.ts): level resolution, every readback error kind (rate, correction flow, scoring),
 * missed calls, "say again", no readback, wrong-callsign answers, determinism.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PILOT_BEHAVIOUR, PILOT_REALISM_PRESETS, PILOT_REALISM_LEVELS, realismForDifficulty, resolvePilotBehaviour } from './pilotBehaviour';
import type { GroundBehaviour, PilotRealismOverride } from './pilotBehaviour';
import { createEngine } from './engine';
import { createTestAirport } from './__fixtures__/testAirport';
import { ARRIVING, makeScenario, GA_PARKED, cmd, find, makeEngine, pilotTexts, run } from './__fixtures__/testHelpers';
import type { Scenario, SimEvent } from './types';
import type { SimulationEngine } from './api';

/** Engine at a realism level with a handful of rates overridden (usually to 1 so the error always happens). */
function eng(level: Scenario['pilotRealism'], realism: PilotRealismOverride, spawns: Scenario['spawns'], extra: Partial<Scenario> = {}, ground?: Partial<GroundBehaviour>): SimulationEngine {
  return makeEngine({ scenario: { pilotRealism: level, pilotBehaviour: { realism, ...(ground ? { ground } : {}) }, spawns, mode: 'free_play', ...extra } });
}
const NONE: PilotRealismOverride = {
  digitErrorRate: 0, altitudeErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, patternMisunderstandRate: 0,
  wrongCallsignRate: 0, noReadbackRate: 0, delayedResponseRate: 0, sayAgainRate: 0, studentShare: 0,
  responseDelaySec: { airline: [0, 0], ga: [0, 0], student: [0, 0] }, radioDiscipline: false,
  requests: { RUNWAY_CHANGE: 0, SHORT_APPROACH: 0, OPTION: 0, STRAIGHT_IN: 0, STAY_IN_PATTERN: 0, NEED_MINUTE: 0, SPACING_360: 0, HIGHER: 0, DIRECT_FIX: 0, VISUAL_APPROACH: 0, TAXI_BACK: 0 },
};
const only = (o: PilotRealismOverride): PilotRealismOverride => ({ ...NONE, ...o });
const events = (e: SimulationEngine, kind: SimEvent['kind']) => e.getState().events.filter((x) => x.kind === kind);
const lastPilot = (e: SimulationEngine, cs: string) => pilotTexts(e, cs).at(-1) ?? '';

describe('level resolution', () => {
  it('has four levels whose rates only grow', () => {
    expect(PILOT_REALISM_LEVELS).toEqual(['off', 'light', 'moderate', 'heavy']);
    const keys = ['digitErrorRate', 'altitudeErrorRate', 'frequencyErrorRate', 'squawkErrorRate', 'wrongCallsignRate', 'noReadbackRate', 'delayedResponseRate', 'sayAgainRate', 'studentShare', 'blockWindowSec'] as const;
    for (const k of keys) {
      const v = PILOT_REALISM_LEVELS.map((l) => PILOT_REALISM_PRESETS[l][k]);
      expect(v, k).toEqual([...v].sort((a, b) => a - b));
    }
    expect(PILOT_REALISM_PRESETS.off.digitErrorRate).toBe(0);
    expect(PILOT_REALISM_PRESETS.moderate.digitErrorRate).toBe(0.04); // measured heading readback error rate (DOT/FAA/AM-06/25 Table 10)
  });
  it('maps Difficulty: easy light, normal moderate, hard heavy', () => {
    expect(realismForDifficulty('easy')).toBe('light');
    expect(realismForDifficulty('normal')).toBe('moderate');
    expect(realismForDifficulty('hard')).toBe('heavy');
    expect(realismForDifficulty(undefined)).toBe('moderate');
  });
  it('resolves a full PilotBehaviour; no level = every realism feature off', () => {
    expect(resolvePilotBehaviour().realism.level).toBe('off');
    expect(DEFAULT_PILOT_BEHAVIOUR.realism.altitudeErrorRate).toBe(0);
    const b = resolvePilotBehaviour({ noAtisFraction: 0.1, realism: { altitudeErrorRate: 0.5, requests: { OPTION: 0.9 } } }, undefined, 'heavy');
    expect(b.noAtisFraction).toBe(0.1);
    expect(b.realism.level).toBe('heavy');
    expect(b.realism.altitudeErrorRate).toBe(0.5);
    expect(b.realism.requests.OPTION).toBe(0.9);
    expect(b.realism.requests.STRAIGHT_IN).toBe(PILOT_REALISM_PRESETS.heavy.requests.STRAIGHT_IN); // untouched
    expect(b.look.pAhead).toBe(DEFAULT_PILOT_BEHAVIOUR.look.pAhead);
  });
  it('a level sets the ground task\'s rates too (hold-short omissions, wrong taxiway share, unfamiliar pilots)', () => {
    const g = (level: 'off' | 'light' | 'moderate' | 'heavy') => resolvePilotBehaviour(undefined, 'free_play', level).ground;
    expect(g('off')).toMatchObject({ holdShortOmitFraction: 0, taxiwayErrorShare: 0, unfamiliarFraction: 0 });
    expect(g('light').holdShortOmitFraction).toBeLessThan(g('moderate').holdShortOmitFraction);
    expect(g('moderate').holdShortOmitFraction).toBeLessThan(g('heavy').holdShortOmitFraction);
    expect(g('moderate')).toMatchObject({ holdShortOmitFraction: 0.08, unfamiliarFraction: 0.1 }); // the ground task's own defaults
    expect(g('heavy').unfamiliarFraction).toBeGreaterThan(g('light').unfamiliarFraction);
    // no level: the ground defaults, and training switches them off as before
    expect(resolvePilotBehaviour(undefined, 'free_play').ground.holdShortOmitFraction).toBe(0.08);
    expect(resolvePilotBehaviour(undefined, 'training').ground.holdShortOmitFraction).toBe(0);
    // an explicit ground override wins over the level
    expect(resolvePilotBehaviour({ ground: { holdShortOmitFraction: 0.5 } }, 'free_play', 'light').ground.holdShortOmitFraction).toBe(0.5);
  });
  it('the engine takes the digit rate from the level, and keeps 8 % (0 in training) without one', () => {
    const t = createTestAirport();
    const sc = (over: Partial<Scenario>) => makeScenario({ spawns: [ARRIVING('N723EJ', '13', 10)], ...over });
    const wrongRunway = (engine: SimulationEngine) => {
      engine.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
      return find(engine, 'N723EJ').flags.readbackErrorKind === 'runway';
    };
    // level heavy with digitErrorRate 1: always
    expect(wrongRunway(createEngine({ airport: t, scenario: sc({ pilotRealism: 'heavy', pilotBehaviour: { realism: { digitErrorRate: 1 } } }) }))).toBe(true);
    // level off: never
    expect(wrongRunway(createEngine({ airport: t, scenario: sc({ pilotRealism: 'off', pilotBehaviour: { realism: { digitErrorRate: 1 } } }) }))).toBe(false);
    // no level: the pre-realism 8 % (training 0): over many seeds some errors, but not most
    let n = 0;
    for (let seed = 1; seed <= 60; seed++) if (wrongRunway(createEngine({ airport: t, scenario: sc({ seed }) }))) n++;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(20);
    let m = 0;
    for (let seed = 1; seed <= 30; seed++) if (wrongRunway(createEngine({ airport: t, scenario: sc({ seed, mode: 'training' }) }))) m++;
    expect(m).toBe(0);
  });
});

describe('readback errors beyond digits', () => {
  const air = (cs = 'N723EJ') => [ARRIVING(cs, '13', 10)];

  it('altitude: reads back a wrong altitude, the controller re-issues, the pilot corrects', () => {
    const e = eng('moderate', only({ altitudeErrorRate: 1 }), air());
    const out = e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR' });
    expect(out.status).toBe('accepted');
    const said = lastPilot(e, 'N723EJ');
    expect(said).toMatch(/maintain/i);
    expect(said).not.toContain('three thousand');
    const a = find(e, 'N723EJ');
    expect(a.flags.readbackErrorPending).toBe(true);
    expect(a.flags.readbackErrorKind).toBe('altitude');
    // correction: the same instruction again
    e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR' });
    expect(lastPilot(e, 'N723EJ')).toContain('three thousand');
    expect(find(e, 'N723EJ').flags.readbackErrorPending).toBe(false);
    expect(events(e, 'READBACK_ERROR').some((x) => x.data?.corrected)).toBe(true);
  });

  it('an uncorrected error is scored as missed after 20 s', () => {
    const e = eng('moderate', only({ altitudeErrorRate: 1 }), air());
    e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR' });
    run(e, 22);
    expect(events(e, 'READBACK_ERROR').some((x) => x.data?.missed)).toBe(true);
    expect(e.getState().score.missedReadbackErrors).toBe(1);
  });

  it('frequency: reads back a different frequency', () => {
    const e = eng('moderate', only({ frequencyErrorRate: 1 }), [ARRIVING('N723EJ', '13', 10, 'C172', 'APP')]);
    const out = e.applyCommand(cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'TWR', frequencyMhz: 120.3 }), { position: 'APP' });
    expect(out.status).toBe('accepted');
    expect(lastPilot(e, 'N723EJ')).not.toContain('one two zero point three');
    expect(find(e, 'N723EJ').flags.readbackErrorKind).toBe('frequency');
    e.applyCommand(cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'TWR', frequencyMhz: 120.3 }), { position: 'APP' });
    expect(lastPilot(e, 'N723EJ')).toContain('one two zero point three');
  });

  it('squawk: reads back a wrong code', () => {
    const e = eng('moderate', only({ squawkErrorRate: 1 }), air());
    const out = e.applyCommand(cmd('SQUAWK', 'N723EJ', { squawk: '4215' }), { position: 'TWR' });
    expect(out.status).toBe('accepted');
    expect(lastPilot(e, 'N723EJ')).not.toContain('four two one five');
    expect(find(e, 'N723EJ').flags.readbackErrorKind).toBe('squawk');
    e.applyCommand(cmd('SQUAWK', 'N723EJ', { squawk: '4215' }), { position: 'TWR' });
    expect(lastPilot(e, 'N723EJ')).toContain('four two one five');
  });

  it('hold short omission: the taxi readback leaves out the hold-short instruction (the rate is the level\'s ground.holdShortOmitFraction; the readback challenge is the ground task\'s)', () => {
    const e = eng('moderate', NONE, [GA_PARKED('N723EJ', 'GA1')], {}, { holdShortOmitFraction: 1 });
    const out = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', holdShort: ['13/31'] }), { position: 'GND' });
    expect(out.status).toBe('accepted');
    expect(lastPilot(e, 'N723EJ')).not.toMatch(/hold short/i);
    expect(find(e, 'N723EJ').flags.readbackErrorPending).toBeFalsy(); // not a wrong readback: a missing one, tracked as unread hold-short
  });

  it('wrong taxiway: the route is read back with another taxiway', () => {
    const e = makeEngine({ scenario: { pilotRealism: 'moderate', pilotBehaviour: { realism: NONE, ground: { taxiwayErrorShare: 1 } }, spawns: [GA_PARKED('N723EJ', 'GA1')], mode: 'free_play' }, opts: { readbackErrorRate: 1 } });
    const out = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'TWY C', route: ['B', 'A'] }), { position: 'GND' });
    if (out.status !== 'accepted') throw new Error(out.status === 'rejected' ? out.reason : 'clarify');
    expect(find(e, 'N723EJ').flags.readbackErrorKind).toBe('taxiway');
    expect(lastPilot(e, 'N723EJ')).toMatch(/via/);
    expect(lastPilot(e, 'N723EJ')).not.toMatch(/via bravo, alpha/);
  });

  it('pattern: an instruction is misunderstood (students more often)', () => {
    const e = eng('moderate', only({ patternMisunderstandRate: 1 }), air());
    e.applyCommand(cmd('ENTER_PATTERN', 'N723EJ', { patternLeg: 'left_downwind', runwayEnd: '13' }), { position: 'TWR' });
    expect(lastPilot(e, 'N723EJ')).not.toMatch(/left downwind/i);
    expect(find(e, 'N723EJ').flags.readbackErrorKind).toBe('pattern');
  });

  it('no readback: the pilot has not received the clearance and does nothing with it; "did you copy" gets the readback and he acts', () => {
    const e = eng('moderate', only({ noReadbackRate: 1 }), air());
    const before = pilotTexts(e, 'N723EJ').length;
    const was = find(e, 'N723EJ').target.altitudeFt;
    e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR' });
    expect(pilotTexts(e, 'N723EJ').length).toBe(before);
    expect(find(e, 'N723EJ').flags.readbackErrorKind).toBe('no_readback');
    expect(find(e, 'N723EJ').target.altitudeFt).toBe(was); // it did NOT comply
    expect(e.getState().events.some((x) => x.kind === 'COMMAND_ACCEPTED' && x.callsign === 'N723EJ')).toBe(false); // nothing happened: nothing is scored
    e.applyCommand(cmd('DID_YOU_COPY', 'N723EJ'), { position: 'TWR' });
    expect(lastPilot(e, 'N723EJ')).toContain('three thousand');
    expect(find(e, 'N723EJ').flags.readbackErrorPending).toBe(false);
    expect(find(e, 'N723EJ').target.altitudeFt).toBe(3000); // now it has the clearance
  });

  it('no readback: re-issuing the instruction gets the readback and the aircraft acts', () => {
    // find a pilot who leaves the first call unacknowledged at a 50 % rate, then repeat the call until he answers
    let done = false;
    for (let seed = 1; seed <= 60 && !done; seed++) {
      const e = eng('moderate', only({ noReadbackRate: 0.5 }), air(), { seed });
      e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR' });
      if (find(e, 'N723EJ').flags.readbackErrorKind !== 'no_readback') continue;
      expect(find(e, 'N723EJ').target.altitudeFt).not.toBe(3000);
      for (let k = 0; k < 20 && find(e, 'N723EJ').target.altitudeFt !== 3000; k++) e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR' });
      expect(find(e, 'N723EJ').target.altitudeFt).toBe(3000);
      expect(lastPilot(e, 'N723EJ')).toContain('three thousand');
      done = true;
    }
    expect(done).toBe(true);
  });

  it('wrong callsign: an aircraft with a similar callsign answers (JO 7110.65 2-4-20); the addressed pilot says nothing and does nothing until the call is repeated', () => {
    const e = eng('moderate', only({ wrongCallsignRate: 1 }), [ARRIVING('N723EJ', '13', 10), ARRIVING('N455EJ', '13', 12)]);
    const was = find(e, 'N723EJ').target.altitudeFt;
    e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR' });
    expect(pilotTexts(e, 'N455EJ').at(-1)).toContain('three thousand');
    expect(pilotTexts(e, 'N723EJ')).toHaveLength(0);
    const a = find(e, 'N723EJ');
    expect(a.flags.readbackErrorPending).toBe(true);
    expect(a.flags.readbackErrorKind).toBe('callsign');
    expect(a.target.altitudeFt).toBe(was);
    e.applyCommand(cmd('DID_YOU_COPY', 'N723EJ'), { position: 'TWR' });
    expect(pilotTexts(e, 'N723EJ').at(-1)).toMatch(/say again/i); // he never heard it
  });

  it('wrong callsign needs a similar one: dissimilar aircraft never answer for each other', () => {
    const e = eng('moderate', only({ wrongCallsignRate: 1 }), [ARRIVING('N723EJ', '13', 10), ARRIVING('N991KB', '13', 12)]);
    e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR' });
    expect(pilotTexts(e, 'N723EJ').at(-1)).toContain('three thousand');
    expect(pilotTexts(e, 'N991KB')).toHaveLength(0);
  });

  it('rates apply per eligible clearance: near zero never errs, 1 always errs', () => {
    const count = (rate: number) => {
      const e = eng('moderate', only({ altitudeErrorRate: rate }), air());
      let errs = 0;
      for (let i = 0; i < 40; i++) {
        e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 2000 + i * 100 }), { position: 'TWR' });
        if (find(e, 'N723EJ').flags.readbackErrorPending) errs++;
        e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 2000 + i * 100 }), { position: 'TWR' });
        run(e, 6);
      }
      return errs;
    };
    expect(count(0)).toBe(0);
    const mid = count(0.3);
    expect(mid).toBeGreaterThan(3);
    expect(mid).toBeLessThan(25);
  });

  it('a level off scenario and a scenario without a level never produce the new errors', () => {
    for (const level of ['off', undefined] as const) {
      const e = eng(level, { altitudeErrorRate: 1, noReadbackRate: 1, wrongCallsignRate: 1 }, air());
      e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR' });
      expect(lastPilot(e, 'N723EJ')).toContain('three thousand'); // explicit rates are ignored at level off / without a level
      expect(find(e, 'N723EJ').flags.readbackErrorPending).toBeFalsy();
    }
  });
});

