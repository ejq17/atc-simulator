/**
 * Hold-short readbacks (JO 7110.65 2-4-3, 3-7-2; AIM 4-3-18), route-less taxi instructions (3-7-2) and wrong-taxiway readbacks, on the real KACY layout.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadKacy } from '../airport';
import { cmd, find, FIXTURE_GROUND, makeScenario, run, runUntil, say } from './__fixtures__/testHelpers';
import type { GameMode, ScenarioAircraftSpawn } from './types';
import type { GroundBehaviour } from './pilotBehaviour';

const kacy = loadKacy();
const a320 = (cs: string, gate: string): ScenarioAircraftSpawn => ({
  atSec: 0, callsign: cs, type: 'A320', flightRules: 'VFR', start: { kind: 'parked', parkingId: gate }, isDeparture: true, initialFrequencyId: 'GND',
});
function setup(ground: Partial<GroundBehaviour> = {}, o: { mode?: GameMode; readbackErrorRate?: number; spawns?: ScenarioAircraftSpawn[] } = {}) {
  return createEngine({
    airport: kacy, readbackErrorRate: o.readbackErrorRate ?? 0,
    scenario: makeScenario({
      mode: o.mode ?? 'free_play', activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR', 'GND'],
      spawns: o.spawns ?? [a320('NKS451', 'GATE-1')], pilotBehaviour: { ground: { ...FIXTURE_GROUND, ...ground } },
    }),
  });
}
const TAXI13 = { destination: 'RWY13', runwayEnd: '13', route: ['B'], holdShort: ['4/22'] };
const pilotLines = (e: ReturnType<typeof setup>, cs = 'NKS451') => e.getState().events.filter((x) => x.speaker === 'PILOT' && x.callsign === cs).map((x) => x.text);

describe('hold-short readback requirement (2-4-3, 3-7-2, AIM 4-3-18, KACY diagram note)', () => {
  it('a pilot who reads the hold short back is not held up: the readback contains it', () => {
    const e = setup({ holdShortOmitFraction: 0 });
    run(e, 5);
    const o = say(e, cmd('TAXI', 'NKS451', TAXI13), 'GND');
    expect(o.status === 'accepted' ? o.readback : '').toBe('Runway one three, taxi via bravo, hold short of runway four, Spirit four fifty one');
    expect(find(e, 'NKS451').route?.unreadStopNodeIds).toBeUndefined();
  });

  it('an omitted hold-short readback stops the aircraft at the first hold line, the pilot asks again, and the controller is charged after the grace interval', () => {
    const e = setup({ holdShortOmitFraction: 1 });
    const ac = find(e, 'NKS451');
    run(e, 5);
    const o = say(e, cmd('TAXI', 'NKS451', TAXI13), 'GND');
    expect(o.status === 'accepted' ? o.readback : '').toBe('Runway one three, taxi via bravo, Spirit four fifty one'); // hold short left out
    const unread = ac.route!.unreadStopNodeIds!;
    expect(unread.length).toBeGreaterThan(0);
    const firstHold = ac.route!.nodeIds.find((id) => kacy.taxiwayGraph.nodes[id].kind === 'holding_position')!;
    expect(unread).toContain(firstHold);
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT' && ac.groundSpeedKt === 0, 600)).toBe(true);
    // it never went beyond the first hold line
    expect(ac.route!.progressIndex).toBeLessThanOrEqual(ac.route!.nodeIds.indexOf(firstHold) + 1);
    run(e, 3);
    expect(pilotLines(e).some((t) => /say again hold short instructions/.test(t))).toBe(true);
    // 20 s after the clearance with no readback obtained: a communication error scored with the 2-4-3 reference
    run(e, 25);
    const ev = e.getState().events.find((x) => x.data?.holdShortReadback && x.data?.commError);
    expect(ev?.text).toMatch(/2-4-3/);
    expect(e.getState().score.communicationErrors).toBe(1);
    run(e, 60);
    expect(e.getState().score.communicationErrors).toBe(1); // charged once
    expect(ac.groundSpeedKt).toBe(0); // still waiting
  });

  it('"read back hold instructions" gets the readback and releases the aircraft; no error if it is asked for in time', () => {
    const e = setup({ holdShortOmitFraction: 1 });
    const ac = find(e, 'NKS451');
    run(e, 5);
    say(e, cmd('TAXI', 'NKS451', TAXI13), 'GND');
    run(e, 4);
    const o = say(e, cmd('READ_BACK_HOLD', 'NKS451'), 'GND');
    expect(o.status).toBe('accepted');
    expect(o.status === 'accepted' ? o.readback : '').toBe('Hold short of runway four, Spirit four fifty one');
    expect(ac.route!.unreadStopNodeIds).toBeUndefined();
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'CROSSING', 600)).toBe(true);
    expect(pilotLines(e).some((t) => /say again hold short/.test(t))).toBe(false);
    run(e, 40);
    expect(e.getState().score.communicationErrors).toBe(0);
  });

  it('a plain re-issue of the hold short ("hold short of runway four") also counts as the readback', () => {
    const e = setup({ holdShortOmitFraction: 1 });
    const ac = find(e, 'NKS451');
    run(e, 5);
    say(e, cmd('TAXI', 'NKS451', TAXI13), 'GND');
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT' && ac.groundSpeedKt === 0, 600)).toBe(true);
    run(e, 3);
    const o = say(e, cmd('HOLD_SHORT', 'NKS451', { holdShort: ['4/22'] }), 'GND');
    expect(o.status === 'accepted' ? o.readback : '').toBe('Hold short of runway four, Spirit four fifty one');
    expect(ac.route!.unreadStopNodeIds).toBeUndefined();
    expect(e.getState().events.some((x) => x.data?.holdShortReadback && x.data?.corrected)).toBe(true);
  });

  it('training mode (readbackErrorRate 0) has no omissions unless the scenario asks for them', () => {
    const e = setup({}, { mode: 'training' });
    run(e, 5);
    const o = say(e, cmd('TAXI', 'NKS451', TAXI13), 'GND');
    expect(o.status === 'accepted' ? o.readback : '').toMatch(/hold short of runway four/);
  });

});

describe('wrong taxiway in the route readback', () => {
  it('is a readback error the controller must correct; the aircraft still flies the clearance', () => {
    const e = setup({ taxiwayErrorShare: 1 }, { readbackErrorRate: 1, spawns: [{ atSec: 0, callsign: 'N1AA', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: 'GA-1' }, isDeparture: true, initialFrequencyId: 'GND' }] });
    run(e, 5);
    const c = cmd('TAXI', 'N1AA', { destination: 'GA-2', route: ['L'] });
    const o = say(e, c, 'GND');
    expect(o.status).toBe('accepted');
    const hidden = e.getState().events.find((x) => /misread back/.test(x.text));
    expect(hidden?.text).toMatch(/misread back: via .* instead of via lima/);
    expect(o.status === 'accepted' ? o.readback : '').not.toMatch(/via lima/);
    // re-issuing the instruction corrects it
    run(e, 6);
    const again = say(e, c, 'GND');
    expect(again.status).toBe('accepted');
    expect(again.status === 'accepted' ? again.readback : '').toMatch(/via lima/);
    expect(e.getState().events.some((x) => x.kind === 'READBACK_ERROR' && x.data?.corrected)).toBe(true);
  });
});

describe('route-less taxi instructions (3-7-2 (a) and (b))', () => {
  const routeless = { destination: 'RWY13', runwayEnd: '13' };
  it('free play: accepted, flagged and scored as a phraseology error with the reference', () => {
    const e = setup();
    run(e, 5);
    const o = say(e, cmd('TAXI', 'NKS451', routeless), 'GND');
    expect(o.status).toBe('accepted');
    expect(find(e, 'NKS451').route).toBeDefined();
    const flag = e.getState().events.find((x) => x.data?.improper);
    expect(flag?.text).toMatch(/no route.*3-7-2.*specific route/);
    run(e, 1);
    expect(e.getState().score.communicationErrors).toBe(1);
    expect(e.getState().score.correctClearances).toBe(0);
  });

  it('a routed instruction is not flagged', () => {
    const e = setup();
    run(e, 5);
    say(e, cmd('TAXI', 'NKS451', { ...routeless, route: ['B'] }), 'GND');
    run(e, 1);
    expect(e.getState().score.communicationErrors).toBe(0);
    expect(e.getState().score.correctClearances).toBe(1);
  });

  it('training: refused with the explanation; the pilot asks "say route"', () => {
    const e = setup({}, { mode: 'training' });
    run(e, 5);
    const o = say(e, cmd('TAXI', 'NKS451', routeless), 'GND');
    expect(o.status).toBe('rejected');
    expect(o.status === 'rejected' ? o.reason : '').toMatch(/training mode.*3-7-2/);
    expect(o.status === 'rejected' ? o.pilotResponse : '').toBe('Runway one three, say route, Spirit four fifty one');
    expect(find(e, 'NKS451').route).toBeUndefined();
  });

  it('an unfamiliar pilot (seeded) asks "say route" in free play too and waits; the routed instruction then works', () => {
    const e = setup({ unfamiliarFraction: 1 });
    run(e, 5);
    const o = say(e, cmd('TAXI', 'NKS451', routeless), 'GND');
    expect(o.status).toBe('rejected');
    expect(o.status === 'rejected' ? o.pilotResponse : '').toMatch(/say route/);
    run(e, 1);
    expect(e.getState().score.communicationErrors).toBe(1);
    expect(say(e, cmd('TAXI', 'NKS451', { ...routeless, route: ['B'] }), 'GND').status).toBe('accepted');
  });

  it('taxi to parking without a route is allowed (3-7-2 example "Taxi to the hangar")', () => {
    const e = setup({}, { spawns: [{ atSec: 0, callsign: 'N1AA', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: 'GA-1' }, isDeparture: true, initialFrequencyId: 'GND' }] });
    run(e, 5);
    expect(say(e, cmd('TAXI', 'N1AA', { destination: 'GA-2' }), 'GND').status).toBe('accepted');
    expect(e.getState().score.communicationErrors).toBe(0);
  });
});

describe('progressive taxi (3-7-2, AIM 4-3-18)', () => {
  it('an unfamiliar pilot asks for it in the ready call', () => {
    const e = setup({ unfamiliarFraction: 1 });
    run(e, 12);
    const ac = find(e, 'NKS451');
    expect(ac.pendingRequest?.progressive).toBe(true);
    expect(pilotLines(e).at(-1)).toMatch(/ready to taxi, VFR to .*, request progressive taxi\.$/);
  });

});
