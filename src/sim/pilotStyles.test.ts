/**
 * Callsign conventions and pilot styles in the engine's pilot calls: "November" on initial contact, abbreviation after the controller
 * did it (AIM 4-2-4), "student pilot", progressive taxi, airline "with you" / "with Bravo".
 */
import { describe, expect, it } from 'vitest';
import type { PilotRealismOverride } from './pilotBehaviour';
import { GA_PARKED, HOLDING, AT_FIX, cmd, find, ifrScenario, makeEngine, pilotTexts, runUntil } from './__fixtures__/testHelpers';
import type { Scenario, ScenarioAircraftSpawn } from './types';
import type { SimulationEngine } from './api';

const BASE: PilotRealismOverride = {
  digitErrorRate: 0, altitudeErrorRate: 0, noReadbackRate: 0, delayedResponseRate: 0, sayAgainRate: 0, wrongCallsignRate: 0, studentShare: 0,
  withYouRate: 0, withBravoRate: 0, novemberInitialRate: 0, progressiveTaxiRate: 0, radioDiscipline: false,
  responseDelaySec: { airline: [0, 0], ga: [0, 0], student: [0, 0] },
  requests: { RUNWAY_CHANGE: 0, SHORT_APPROACH: 0, OPTION: 0, STRAIGHT_IN: 0, STAY_IN_PATTERN: 0, NEED_MINUTE: 0, SPACING_360: 0, HIGHER: 0, DIRECT_FIX: 0, VISUAL_APPROACH: 0, TAXI_BACK: 0 },
};
function eng(realism: PilotRealismOverride, spawns: ScenarioAircraftSpawn[], over: Partial<Scenario> = {}): SimulationEngine {
  return makeEngine({ scenario: { pilotRealism: 'moderate', pilotBehaviour: { noAtisFraction: 0, realism: { ...BASE, ...realism } }, spawns, ...over } });
}
const firstCall = (e: SimulationEngine, cs: string): string => {
  runUntil(e, () => pilotTexts(e, cs).length > 0, 30);
  return pilotTexts(e, cs)[0] ?? '';
};

describe('GA callsign on initial contact', () => {
  it('says the type word by default and "November" at the November rate (7110.65 2-4-20, AIM 4-2-4)', () => {
    expect(firstCall(eng({}, [GA_PARKED('N723EJ')]), 'N723EJ')).toContain('Cessna seven two three echo juliet');
    const t = firstCall(eng({ novemberInitialRate: 1 }, [GA_PARKED('N723EJ')]), 'N723EJ');
    expect(t).toContain('November seven two three echo juliet');
    expect(t).not.toContain('Cessna');
  });
  it('airline callsigns stay in group form', () => {
    const e = eng({ novemberInitialRate: 1 }, [AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B'])], ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B'])]));
    expect(firstCall(e, 'NKS451')).toContain('Spirit four fifty one');
  });
});

describe('abbreviated callsign after the controller used it (AIM 4-2-4)', () => {
  const ground = () => eng({ abbreviateAfterController: true }, [GA_PARKED('N723EJ')]);
  const taxi = (abbreviated: boolean) => cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', ...(abbreviated ? { callsignAbbreviated: true } : {}) });

  it('the pilot uses the full callsign until the controller abbreviates', () => {
    const e = ground();
    firstCall(e, 'N723EJ');
    e.applyCommand(taxi(false), { position: 'GND' });
    expect(pilotTexts(e, 'N723EJ').at(-1)).toMatch(/Cessna seven two three echo juliet$/);
  });
  it('and the abbreviation afterwards, never on the initial contact', () => {
    const e = ground();
    expect(firstCall(e, 'N723EJ')).toContain('Cessna seven two three echo juliet');
    e.applyCommand(taxi(true), { position: 'GND' });
    expect(pilotTexts(e, 'N723EJ').at(-1)).toMatch(/Cessna three echo juliet$/);
    expect(pilotTexts(e, 'N723EJ').at(-1)).not.toContain('seven two');
  });
  it('but never when a similar callsign is on the frequency', () => {
    const e = eng({ abbreviateAfterController: true }, [GA_PARKED('N723EJ'), GA_PARKED('N455EJ', 'GA2')]);
    firstCall(e, 'N723EJ');
    e.applyCommand(taxi(true), { position: 'GND' });
    expect(pilotTexts(e, 'N723EJ').at(-1)).toContain('seven two three echo juliet');
  });
  it('the switch can be turned off', () => {
    const e = eng({ abbreviateAfterController: false }, [GA_PARKED('N723EJ')]);
    firstCall(e, 'N723EJ');
    e.applyCommand(taxi(true), { position: 'GND' });
    expect(pilotTexts(e, 'N723EJ').at(-1)).toContain('seven two three echo juliet');
  });
});

describe('student pilots', () => {
  it('a seeded share of light VFR aircraft are students; airliners and IFR never; none at share 0', () => {
    const count = (share: number, spawn: (n: number) => ScenarioAircraftSpawn) => {
      let n = 0;
      for (let i = 1; i <= 100; i++) {
        const e = eng({ studentShare: share }, [spawn(i)], { seed: i });
        if (find(e, `N${i}AA`).student) n++;
      }
      return n;
    };
    expect(count(0, (i) => GA_PARKED(`N${i}AA`))).toBe(0);
    const some = count(0.3, (i) => GA_PARKED(`N${i}AA`));
    expect(some).toBeGreaterThan(10);
    expect(some).toBeLessThan(55);
    const e = eng({ studentShare: 1 }, [AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B'])], ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B'])]));
    expect(find(e, 'NKS451').student).toBeUndefined();
  });
  it('a lesson can force a student on any aircraft', () => {
    const e = eng({ studentShare: 0 }, [{ ...GA_PARKED('N723EJ'), student: true }]);
    expect(find(e, 'N723EJ').student).toBe(true);
  });
  it('says "student pilot" on the initial contact only (AIM 4-2-4)', () => {
    const e = eng({}, [{ ...GA_PARKED('N723EJ'), student: true }]);
    expect(firstCall(e, 'N723EJ')).toMatch(/echo juliet, student pilot,/);
    e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22' }), { position: 'GND' });
    expect(pilotTexts(e, 'N723EJ').at(-1)).not.toMatch(/student/);
  });
  it('asks for progressive taxi at the rate, as a pending request the controller can answer with a taxi instruction', () => {
    const e = eng({ progressiveTaxiRate: 1 }, [{ ...GA_PARKED('N723EJ'), student: true }]);
    expect(firstCall(e, 'N723EJ')).toContain('request progressive taxi');
    expect(find(e, 'N723EJ').pendingRequest?.progressive).toBe(true);
    expect(find(e, 'N723EJ').pendingRequest?.kind).toBe('TAXI');
    expect(e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22' }), { position: 'GND' }).status).toBe('accepted');
    expect(find(e, 'N723EJ').pendingRequest).toBeUndefined();
    const plain = eng({ progressiveTaxiRate: 1 }, [GA_PARKED('N723EJ')]);
    expect(firstCall(plain, 'N723EJ')).not.toContain('progressive');
  });
});

describe('airline crews', () => {
  const fix = [AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B'])];
  const call = (r: PilotRealismOverride) => firstCall(eng(r, fix, ifrScenario(fix)), 'NKS451');
  it('"with you" is non-standard but common: at the rate only, on check-ins', () => {
    expect(call({ withYouRate: 1 })).toContain('Spirit four fifty one, with you');
    expect(call({ withYouRate: 0 })).not.toContain('with you');
  });
  it('"with Bravo" shortens "information Bravo"', () => {
    const t = call({ withBravoRate: 1 });
    expect(t).toMatch(/, with alpha\.$/); // the simulated ATIS is information alpha
    expect(t).not.toContain('information');
    expect(call({})).toContain('information alpha');
  });
  it('is not used by GA pilots', () => {
    expect(firstCall(eng({ withYouRate: 1 }, [HOLDING('N723EJ', 'H13', '13')]), 'N723EJ')).not.toContain('with you');
  });
});

