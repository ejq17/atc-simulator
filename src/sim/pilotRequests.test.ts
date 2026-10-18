/**
 * Pilot-initiated requests (src/sim/pilotRequests.ts): each is made at its rate when the situation fits, shows as a pending request,
 * and the controller's ordinary answer (or "unable") resolves it.
 */
import { describe, expect, it } from 'vitest';
import type { PilotRealismOverride, PilotRequestCode } from './pilotBehaviour';
import { ARRIVING, AT_FIX, HOLDING, IFR_HOLDING, cmd, find, ifrScenario, makeEngine, pilotTexts, run, runUntil } from './__fixtures__/testHelpers';
import type { Scenario } from './types';
import type { SimulationEngine } from './api';

const QUIET: PilotRealismOverride = {
  digitErrorRate: 0, altitudeErrorRate: 0, noReadbackRate: 0, delayedResponseRate: 0, sayAgainRate: 0, wrongCallsignRate: 0, studentShare: 0, radioDiscipline: false,
  withYouRate: 0, withBravoRate: 0, novemberInitialRate: 0, progressiveTaxiRate: 0,
  responseDelaySec: { airline: [0, 0], ga: [0, 0], student: [0, 0] },
  requests: { RUNWAY_CHANGE: 0, SHORT_APPROACH: 0, OPTION: 0, STRAIGHT_IN: 0, STAY_IN_PATTERN: 0, NEED_MINUTE: 0, SPACING_360: 0, HIGHER: 0, DIRECT_FIX: 0, VISUAL_APPROACH: 0, TAXI_BACK: 0 },
};
/** Engine in which only `code` is requested (rate 1). */
function eng(code: Exclude<PilotRequestCode, 'PROGRESSIVE_TAXI' | 'LOWER'>, spawns: Scenario['spawns'], over: Partial<Scenario> = {}): SimulationEngine {
  return makeEngine({ scenario: { pilotRealism: 'moderate', pilotBehaviour: { noAtisFraction: 0, realism: { ...QUIET, requests: { ...QUIET.requests!, [code]: 1 } } }, spawns, ...over } });
}
const ask = (e: SimulationEngine, cs: string, code: PilotRequestCode, max = 600): boolean =>
  runUntil(e, () => Object.values(e.getState().aircraft).find((x) => x.callsign === cs)?.pendingRequest?.request === code, max);
const pattern = (e: SimulationEngine, cs = 'N723EJ') => e.applyCommand(cmd('ENTER_PATTERN', cs, { patternLeg: 'left_downwind', runwayEnd: '13' }), { position: 'TWR' });
const lastSaid = (e: SimulationEngine, cs = 'N723EJ') => pilotTexts(e, cs).at(-1) ?? '';

describe('requests on arrival', () => {
  it('"request runway ..." is answered with a landing clearance for that runway', () => {
    const e = eng('RUNWAY_CHANGE', [ARRIVING('N723EJ', '13', 12)]);
    expect(ask(e, 'N723EJ', 'RUNWAY_CHANGE')).toBe(true);
    const req = find(e, 'N723EJ').pendingRequest!;
    expect(lastSaid(e)).toMatch(/request runway/);
    expect(req.runwayEnd).toBeDefined();
    expect(req.runwayEnd).not.toBe('13');
    const out = e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: req.runwayEnd }), { position: 'TWR' });
    expect(out.status).toBe('accepted');
    expect(find(e, 'N723EJ').assignedRunwayEnd).toBe(req.runwayEnd);
    expect(find(e, 'N723EJ').pendingRequest).toBeUndefined();
  });
  it('"request straight-in" is answered with a straight-in entry', () => {
    const e = eng('STRAIGHT_IN', [ARRIVING('N723EJ', '13', 12)]);
    expect(ask(e, 'N723EJ', 'STRAIGHT_IN')).toBe(true);
    expect(lastSaid(e)).toContain('request straight-in runway one three');
    expect(e.applyCommand(cmd('ENTER_PATTERN', 'N723EJ', { patternLeg: 'straight_in', runwayEnd: '13' }), { position: 'TWR' }).status).toBe('accepted');
    expect(find(e, 'N723EJ').pendingRequest).toBeUndefined();
  });
  it('is made by light VFR aircraft only, and not at level off', () => {
    const e = eng('STRAIGHT_IN', [{ ...ARRIVING('NKS451', '13', 12, 'A320') }]);
    run(e, 120);
    expect(find(e, 'NKS451').pendingRequest?.request).toBeUndefined();
    const off = makeEngine({ scenario: { pilotRealism: 'off', pilotBehaviour: { realism: { requests: { STRAIGHT_IN: 1 } } }, spawns: [ARRIVING('N723EJ', '13', 12)] } });
    run(off, 120);
    expect(find(off, 'N723EJ').pendingRequest?.request).toBeUndefined();
  });
  it('is made once per aircraft', () => {
    const e = eng('STRAIGHT_IN', [ARRIVING('N723EJ', '13', 12)]);
    expect(ask(e, 'N723EJ', 'STRAIGHT_IN')).toBe(true);
    e.applyCommand(cmd('UNABLE', 'N723EJ'), { position: 'TWR' });
    run(e, 120);
    expect(pilotTexts(e, 'N723EJ').filter((t) => /straight-in/.test(t))).toHaveLength(1);
  });
});

describe('requests in the pattern', () => {
  const inPattern = (code: 'SHORT_APPROACH' | 'OPTION') => {
    const e = eng(code, [ARRIVING('N723EJ', '13', 6)]);
    pattern(e);
    expect(ask(e, 'N723EJ', code)).toBe(true);
    return e;
  };
  it('"request short approach" is answered with a short approach', () => {
    const e = inPattern('SHORT_APPROACH');
    expect(lastSaid(e)).toContain('request short approach');
    expect(e.applyCommand(cmd('PATTERN_INSTRUCTION', 'N723EJ', { destination: 'SHORT_APPROACH' }), { position: 'TWR' }).status).toBe('accepted');
    expect(find(e, 'N723EJ').pendingRequest).toBeUndefined();
  });
  it('"request the option" is answered with a landing clearance for the option', () => {
    const e = inPattern('OPTION');
    expect(lastSaid(e)).toContain('request the option');
    expect(e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13', destination: 'option' }), { position: 'TWR' }).status).toBe('accepted');
  });
  it('"request to stay in the pattern for a few more" after a touch-and-go: another touch-and-go or closed traffic', () => {
    const e = eng('STAY_IN_PATTERN', [ARRIVING('N723EJ', '13', 3)]);
    runUntil(e, () => find(e, 'N723EJ').phase === 'FINAL', 30);
    expect(e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13', destination: 'touch_and_go' }), { position: 'TWR' }).status).toBe('accepted');
    expect(ask(e, 'N723EJ', 'STAY_IN_PATTERN')).toBe(true);
    expect(lastSaid(e)).toContain('request to stay in the pattern for a few more');
    expect(e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13', destination: 'touch_and_go' }), { position: 'TWR' }).status).toBe('accepted');
    expect(find(e, 'N723EJ').pendingRequest).toBeUndefined();
  });
  it('"request a three sixty for spacing" needs a leader close ahead', () => {
    const alone = eng('SPACING_360', [ARRIVING('N723EJ', '13', 6)]);
    pattern(alone);
    run(alone, 240);
    expect(find(alone, 'N723EJ').pendingRequest?.request).not.toBe('SPACING_360');
    const e = eng('SPACING_360', [ARRIVING('N723EJ', '13', 6), ARRIVING('N991KB', '13', 5)]);
    pattern(e);
    pattern(e, 'N991KB');
    const got = ask(e, 'N723EJ', 'SPACING_360', 400) || ask(e, 'N991KB', 'SPACING_360', 1);
    expect(got).toBe(true);
    const who = ['N723EJ', 'N991KB'].find((c) => find(e, c).pendingRequest?.request === 'SPACING_360')!;
    expect(lastSaid(e, who)).toContain('request a three sixty for spacing');
    expect(e.applyCommand(cmd('PATTERN_INSTRUCTION', who, { destination: 'CIRCLE', turnDirection: 'left', turnDegrees: 360 }), { position: 'TWR' }).status).toBe('accepted');
  });
});

describe('requests at the hold', () => {
  it('"we need a minute": unable to the takeoff clearance, ready again later, then it goes', () => {
    const e = eng('NEED_MINUTE', [HOLDING('N723EJ', 'H13', '13')]);
    run(e, 10);
    const out = e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
    expect(out.status).toBe('rejected');
    expect(lastSaid(e)).toMatch(/^Unable, we need a minute/);
    expect(find(e, 'N723EJ').pendingRequest?.request).toBe('NEED_MINUTE');
    // calling again at once changes nothing
    expect(e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' }).status).toBe('rejected');
    expect(find(e, 'N723EJ').phase).toBe('HOLDING_SHORT');
    expect(runUntil(e, () => /ready for departure runway/.test(lastSaid(e)), 120)).toBe(true);
    expect(e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' }).status).toBe('accepted');
    run(e, 5);
    expect(find(e, 'N723EJ').phase).not.toBe('HOLDING_SHORT');
  });
  it('is asked once per aircraft', () => {
    const e = eng('NEED_MINUTE', [HOLDING('N723EJ', 'H13', '13')]);
    run(e, 10);
    e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
    runUntil(e, () => /ready for departure runway/.test(lastSaid(e)), 120);
    e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
    expect(pilotTexts(e, 'N723EJ').filter((t) => /need a minute/.test(t))).toHaveLength(1);
  });
});

describe('requests after departure and for IFR traffic', () => {
  it('"request higher" is answered with an altitude', () => {
    const e = eng('HIGHER', [HOLDING('N723EJ', 'H13', '13')]);
    e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
    expect(ask(e, 'N723EJ', 'HIGHER')).toBe(true);
    expect(lastSaid(e)).toContain('request higher');
    expect(e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 4500 }), { position: 'TWR' }).status).toBe('accepted');
    expect(find(e, 'N723EJ').pendingRequest).toBeUndefined();
    expect(find(e, 'N723EJ').target.altitudeFt).toBe(4500);
  });
  it('"request direct <fix>" names a fix of the filed route and is answered with direct', () => {
    const sp = IFR_HOLDING('NKS451', 'D_h13S', '13', ['TVO', 'TARR']);
    const e = eng('DIRECT_FIX', [sp], ifrScenario([sp]));
    e.applyCommand(cmd('TAKEOFF', 'NKS451', { runwayEnd: '13' }), { position: 'TWR' });
    expect(ask(e, 'NKS451', 'DIRECT_FIX')).toBe(true);
    const fix = find(e, 'NKS451').pendingRequest!.fix!;
    expect(fix).toBe('TARR');
    expect(lastSaid(e, 'NKS451')).toContain('request direct');
    expect(e.applyCommand(cmd('DIRECT_FIX', 'NKS451', { fix }), { position: 'TWR' }).status).toBe('accepted');
    expect(find(e, 'NKS451').pendingRequest).toBeUndefined();
  });
  it('"we have the field in sight, request visual" from an IFR arrival in VMC is answered with a visual approach', () => {
    const sp = AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B']);
    const e = eng('VISUAL_APPROACH', [sp], ifrScenario([sp]));
    expect(ask(e, 'NKS451', 'VISUAL_APPROACH')).toBe(true);
    expect(lastSaid(e, 'NKS451')).toContain('field in sight, request visual approach runway one three');
    const out = e.applyCommand(cmd('APPROACH', 'NKS451', { approachType: 'VISUAL', runwayEnd: '13' }), { position: 'APP' });
    expect(out.status).toBe('accepted');
    expect(find(e, 'NKS451').pendingRequest).toBeUndefined();
  });
  it('and not in IMC', () => {
    const sp = AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B']);
    const e = eng('VISUAL_APPROACH', [sp], ifrScenario([sp], { weather: { source: 'simulated', windDirDeg: 0, windSpeedKt: 0, visibilitySm: 1, clouds: [{ cover: 'OVC', baseFtAgl: 300 }], temperatureC: 10, dewpointC: 9, altimeterInHg: 29.92, phenomena: ['BR'], flightCategory: 'LIFR' } }));
    run(e, 400);
    expect(find(e, 'NKS451').pendingRequest?.request).not.toBe('VISUAL_APPROACH');
  });
});

describe('request taxi back', () => {
  it('after a full stop the pilot asks Ground to taxi back, becomes a departure again, and the taxi instruction works', () => {
    const e = eng('TAXI_BACK', [ARRIVING('N723EJ', '13', 2)]);
    e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
    expect(runUntil(e, () => find(e, 'N723EJ').phase === 'RUNWAY_EXIT' && find(e, 'N723EJ').groundSpeedKt < 0.1, 400)).toBe(true);
    e.applyCommand(cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'GND' }), { position: 'TWR' });
    expect(ask(e, 'N723EJ', 'TAXI_BACK', 300)).toBe(true);
    expect(lastSaid(e)).toContain('request taxi back to runway one three for departure');
    expect(find(e, 'N723EJ').isDeparture).toBe(true);
    const out = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY13', runwayEnd: '13' }), { position: 'GND' });
    expect(out.status).toBe('accepted');
    expect(['TAXIING', 'HOLDING_SHORT']).toContain(find(e, 'N723EJ').phase);
    expect(find(e, 'N723EJ').pendingRequest?.request).not.toBe('TAXI_BACK');
  });
});

describe('the controller says unable', () => {
  it('clears the request and the pilot acknowledges', () => {
    const e = eng('STRAIGHT_IN', [ARRIVING('N723EJ', '13', 12)]);
    expect(ask(e, 'N723EJ', 'STRAIGHT_IN')).toBe(true);
    const out = e.applyCommand(cmd('UNABLE', 'N723EJ'), { position: 'TWR' });
    expect(out.status).toBe('rejected'); // a conversation, no clearance
    expect(find(e, 'N723EJ').pendingRequest).toBeUndefined();
    run(e, 3);
    expect(lastSaid(e)).toMatch(/^Roger, Cessna/);
  });
  it('a refused taxi back puts the aircraft back to an arrival that wants parking', () => {
    const e = eng('TAXI_BACK', [ARRIVING('N723EJ', '13', 2)]);
    e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' });
    runUntil(e, () => find(e, 'N723EJ').phase === 'RUNWAY_EXIT' && find(e, 'N723EJ').groundSpeedKt < 0.1, 400);
    e.applyCommand(cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'GND' }), { position: 'TWR' });
    ask(e, 'N723EJ', 'TAXI_BACK', 300);
    e.applyCommand(cmd('UNABLE', 'N723EJ'), { position: 'GND' });
    expect(find(e, 'N723EJ').isDeparture).toBe(false);
    expect(e.applyCommand(cmd('TAXI_TO_PARKING', 'N723EJ', { destination: 'GA1' }), { position: 'GND' }).status).toBe('accepted');
  });
});

describe('unable at a type limit', () => {
  it('a Cessna cannot fly 200 knots or climb to flight level 240', () => {
    const e = makeEngine({ scenario: { pilotRealism: 'moderate', spawns: [ARRIVING('N723EJ', '13', 10)] } });
    const sp = e.applyCommand(cmd('SPEED', 'N723EJ', { speedKt: 200 }), { position: 'TWR' });
    expect(sp.status).toBe('rejected');
    run(e, 6);
    expect(lastSaid(e)).toMatch(/^Unable, we cannot fly that speed/);
    const al = e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 24000 }), { position: 'TWR' });
    expect(al.status).toBe('rejected');
    run(e, 6);
    expect(lastSaid(e)).toMatch(/^Unable, we cannot reach that altitude/);
  });
});
