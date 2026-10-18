/**
 * Engine smoke test on the real KMHT dataset (second airport): a GA departure is taxied from its OSM stand to the runway 35
 * full-length hold and flown out; an A320 arrival lands on 35, exits and taxis to a terminal gate. Both run to completion with no
 * incursion or conflict, so nothing in the engine, pathfinding or ground logic is silently KACY-only.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadKmht } from '../airport';
import { ARRIVING, GA_PARKED, cmd, find, has, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import type { ScenarioAircraftSpawn } from './types';

const kmht = loadKmht();

function setup(spawns: ScenarioAircraftSpawn[], rwy = '35') {
  return createEngine({
    airport: kmht,
    readbackErrorRate: 0,
    scenario: makeScenario({ activeRunways: { departing: [rwy], landing: [rwy] }, controllerPositions: ['TWR', 'GND'], spawns }),
  });
}

/** Taxi a parked aircraft to the runway 35 hold: it stops short of 17/35 at foxtrot (the FBO ramp is east of the runway), is cleared across, and holds at the A1 end. */
function taxiToHold35(e: ReturnType<typeof setup>, cs: string): void {
  const ac = find(e, cs);
  expect(say(e, cmd('TAXI', cs, { runwayEnd: '35' }), 'GND').status).toBe('accepted');
  expect(ac.route!.nodeIds.at(-1)).toMatch(/^HP17-35-A[12]-1$/);
  expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 1200)).toBe(true);
  expect(runUntil(e, () => ac.pendingRequest?.kind === 'CROSSING', 60)).toBe(true);
  expect(pilotTexts(e, cs).some((t) => /holding short of runway one seven at foxtrot/.test(t))).toBe(true);
  expect(say(e, cmd('CROSS_RUNWAY', cs, { crossRunwayId: '17/35' }), 'GND').status).toBe('accepted');
  expect(runUntil(e, () => ac.phase === 'TAXIING', 30)).toBe(true);
  expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 900)).toBe(true);
}

describe('KMHT engine smoke', () => {
  it('departure: taxi from a GA stand across 17/35 to the runway 35 hold, takeoff, climb-out', () => {
    const e = setup([GA_PARKED('N723EJ', 'GA-1', 'GND')]);
    const ac = find(e, 'N723EJ');
    taxiToHold35(e, 'N723EJ');
    expect(say(e, cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'TWR' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'DEPARTURE', 60)).toBe(true);
    expect(pilotTexts(e, 'N723EJ').some((t) => t.startsWith('Manchester Tower, Cessna seven two three echo juliet, holding short runway three five, ready for departure'))).toBe(true);
    expect(say(e, cmd('TAKEOFF', 'N723EJ', { runwayEnd: '35' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'TAKEOFF_ROLL', 120)).toBe(true);
    expect(runUntil(e, () => ac.phase === 'DEPARTURE' && ac.altitudeFt > e.getState().airport.elevationFt + 500, 240)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });

  it('arrival: A320 cleared to land on 35 rolls out, exits (taxiway Bravo) and taxis to the GA ramp', () => {
    const e = setup([ARRIVING('NKS451', '35', 6, 'A320', 'TWR')]);
    const ac = find(e, 'NKS451');
    expect(say(e, cmd('LAND', 'NKS451', { runwayEnd: '35' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 900)).toBe(true);
    expect(runUntil(e, () => ac.phase === 'RUNWAY_EXIT', 240)).toBe(true);
    expect(runUntil(e, () => ac.occupyingRunways.length === 0 && ac.groundSpeedKt < 0.5, 300)).toBe(true);
    expect(runUntil(e, () => pilotTexts(e, 'NKS451').some((t) => t.startsWith('Manchester Tower, Spirit four fifty one, clear of runway three five at bravo')), 60)).toBe(true);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'GND' }), 'TWR').status).toBe('accepted');
    run(e, 30);
    expect(say(e, cmd('TAXI', 'NKS451', { destination: 'FBO-1' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'PARKED' || !has(e, 'NKS451'), 1500)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });

  it('one session: the departure is airborne before the arrival, which then lands on the same runway', () => {
    const arrival: ScenarioAircraftSpawn = { ...ARRIVING('NKS451', '35', 10, 'A320', 'TWR'), atSec: 330 };
    const e = setup([GA_PARKED('N723EJ', 'GA-1', 'GND'), arrival]);
    const dep = find(e, 'N723EJ');
    taxiToHold35(e, 'N723EJ');
    say(e, cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'TWR' }), 'GND');
    runUntil(e, () => dep.frequencyId === 'TWR' && dep.pendingRequest?.kind === 'DEPARTURE', 60);
    expect(say(e, cmd('TAKEOFF', 'N723EJ', { runwayEnd: '35' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => dep.altitudeFt > e.getState().airport.elevationFt + 300, 300)).toBe(true);
    expect(runUntil(e, () => has(e, 'NKS451'), 1200)).toBe(true);
    const arr = find(e, 'NKS451');
    expect(say(e, cmd('LAND', 'NKS451', { runwayEnd: '35' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => arr.phase === 'ROLLOUT', 900)).toBe(true);
    expect(runUntil(e, () => arr.phase === 'RUNWAY_EXIT' && arr.occupyingRunways.length === 0, 400)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION')).toEqual([]);
  });
});

describe('KMHT in the UI layer', () => {
  it('the ATIS names the airport from the data and the approaches the airport publishes', async () => {
    const { makeAtis, approachesInUseFor } = await import('../ui/store/session');
    const e = setup([]);
    const st = e.getState();
    st.weather = { ...st.weather, flightCategory: 'IFR', visibilitySm: 2, clouds: [{ cover: 'OVC', baseFtAgl: 600 }] };
    expect(approachesInUseFor(st)).toEqual(['ILS runway 35 approach']);
    const atis = makeAtis(st, 'A', Date.UTC(2026, 9, 17, 14, 0, 0));
    expect(atis.text).toMatch(/^Manchester Airport information alpha/i);
    expect(atis.text).not.toMatch(/Atlantic City/);
    expect(atis.simulatedLabel).toMatch(/KMHT/);
    expect(atis.text).toMatch(/ILS runway 35 approach in use/i);
  });
});

describe('KMHT: "taxi to runway 35 via hotel" from the GA ramp', () => {
  const taxi35H = cmd('TAXI', 'N12XS', { runwayEnd: '35', runwayId: '17/35', destination: 'RWY35', route: ['H'] });

  it('plans a hold of runway 35 and reads back runway three five', () => {
    const e = setup([GA_PARKED('N12XS', 'GA-2', 'GND')]);
    const ac = find(e, 'N12XS');
    expect(say(e, taxi35H, 'GND').status).toBe('accepted');
    expect(say(e, cmd('HOLD_SHORT', 'N12XS', { holdShort: ['35'] }), 'GND').status).toBe('accepted');
    expect(pilotTexts(e, 'N12XS')[0]).toMatch(/^Runway three five, taxi via hotel/);
    expect(ac.route!.nodeIds.at(-1)).toMatch(/^HP17-35-/);
  });

  it('a wrong runway in the readback is the seeded readback error (hidden event + pending flag), not a planning fault', () => {
    // With errorRate 1 the pilot garbles the runway; the plan itself still goes to runway 35 and the mistake is flagged for correction.
    const e = createEngine({
      airport: kmht,
      readbackErrorRate: 1,
      scenario: makeScenario({ activeRunways: { departing: ['35'], landing: ['35'] }, controllerPositions: ['TWR', 'GND'], spawns: [GA_PARKED('N12XS', 'GA-2', 'GND')] }),
    });
    const ac = find(e, 'N12XS');
    expect(say(e, taxi35H, 'GND').status).toBe('accepted');
    expect(ac.route!.nodeIds.at(-1)).toMatch(/^HP17-35-/);
    expect(ac.assignedRunwayEnd).toBe('35');
    expect(ac.flags.readbackErrorPending).toBe(true);
    expect(e.getState().events.some((x) => x.data?.readbackError && /instead of runway 35/.test(x.text))).toBe(true);
  });

  it('a HOLD_SHORT from the same transmission keeps the misread TAXI pending; re-issuing the TAXI clears it', () => {
    const e = createEngine({
      airport: kmht,
      readbackErrorRate: 1,
      scenario: makeScenario({ activeRunways: { departing: ['35'], landing: ['35'] }, controllerPositions: ['TWR', 'GND'], spawns: [GA_PARKED('N12XS', 'GA-2', 'GND')] }),
    });
    const ac = find(e, 'N12XS');
    expect(say(e, taxi35H, 'GND').status).toBe('accepted');
    expect(ac.flags.readbackErrorPending).toBe(true);
    const taxiClr = ac.flags.readbackErrorClearanceId;
    expect(say(e, cmd('HOLD_SHORT', 'N12XS', { holdShort: ['35'] }), 'GND').status).toBe('accepted');
    // HOLD_SHORT readbacks never garble the runway, so the pending error is still the TAXI's
    expect(ac.flags.readbackErrorPending).toBe(true);
    expect(ac.flags.readbackErrorClearanceId).toBe(taxiClr);
    // re-issue the TAXI correctly (same params): the correction clears the pending error
    const again = say(e, taxi35H, 'GND');
    expect(again.status).toBe('accepted');
    expect(ac.flags.readbackErrorPending).toBe(false);
    expect(ac.flags.readbackErrorClearanceId).toBeUndefined();
  });
});
