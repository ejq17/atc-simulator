/**
 * Engine smoke test on the real KPGD dataset (third airport, two crossing runways 4/22 and 15/33): a GA departure is taxied from its stand
 * to a runway 22 hold and flown out; an A320 arrival lands on 22 (RNAV only), exits and taxis to a gate. No incursion or conflict.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadKpgd } from '../airport';
import { ARRIVING, GA_PARKED, cmd, find, has, makeScenario, pilotTexts, runUntil, say } from './__fixtures__/testHelpers';
import type { ScenarioAircraftSpawn } from './types';

const kpgd = loadKpgd();

function setup(spawns: ScenarioAircraftSpawn[], rwy = '22') {
  return createEngine({
    airport: kpgd,
    readbackErrorRate: 0,
    scenario: makeScenario({ activeRunways: { departing: [rwy], landing: [rwy] }, controllerPositions: ['TWR', 'GND'], spawns }),
  });
}

describe('KPGD engine smoke', () => {
  it('departure: taxi from a GA stand to a runway 22 hold, takeoff, climb-out', () => {
    const e = setup([GA_PARKED('N723EJ', 'GA-1', 'GND')]);
    const ac = find(e, 'N723EJ');
    expect(say(e, cmd('TAXI', 'N723EJ', { runwayEnd: '22' }), 'GND').status).toBe('accepted');
    expect(ac.route!.nodeIds.at(-1)).toMatch(/^HP4-22-/);
    // the route may cross runway 15/33 (taxiway A or C): answer each crossing request until the aircraft holds short of runway 22
    for (let n = 0; n < 6; n++) {
      expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 1500)).toBe(true);
      if (!runUntil(e, () => ac.pendingRequest?.kind === 'CROSSING', 60)) break; // no crossing request: this is the final hold
      expect(say(e, cmd('CROSS_RUNWAY', 'N723EJ', { crossRunwayId: '15/33' }), 'GND').status).toBe('accepted');
      expect(runUntil(e, () => ac.phase === 'TAXIING', 30)).toBe(true);
    }
    expect(ac.phase).toBe('HOLDING_SHORT');
    expect(say(e, cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'TWR' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'DEPARTURE', 60)).toBe(true);
    expect(pilotTexts(e, 'N723EJ').some((t) => t.startsWith('Punta Gorda Tower, Cessna seven two three echo juliet, holding short runway two two, ready for departure'))).toBe(true);
    expect(say(e, cmd('TAKEOFF', 'N723EJ', { runwayEnd: '22' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'TAKEOFF_ROLL', 120)).toBe(true);
    expect(runUntil(e, () => ac.phase === 'DEPARTURE' && ac.altitudeFt > e.getState().airport.elevationFt + 500, 240)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });

  it('arrival: A320 cleared to land on 22 rolls out, exits and taxis to a gate', () => {
    const e = setup([ARRIVING('AAY451', '22', 6, 'A320', 'TWR')]);
    const ac = find(e, 'AAY451');
    expect(say(e, cmd('LAND', 'AAY451', { runwayEnd: '22' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 900)).toBe(true);
    expect(runUntil(e, () => ac.phase === 'RUNWAY_EXIT', 300)).toBe(true);
    expect(runUntil(e, () => ac.occupyingRunways.length === 0 && ac.groundSpeedKt < 0.5, 400)).toBe(true);
    expect(runUntil(e, () => pilotTexts(e, 'AAY451').some((t) => t.startsWith('Punta Gorda Tower, Allegiant four fifty one, clear of runway two two')), 60)).toBe(true);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'AAY451', { frequencyId: 'GND' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'GND', 60)).toBe(true);
    expect(say(e, cmd('TAXI', 'AAY451', { destination: 'GATE-1' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'PARKED' || !has(e, 'AAY451'), 2500)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });
});

describe('KPGD in the UI layer', () => {
  it('the ATIS names the airport from the data and the approaches the airport publishes (ILS 4 only)', async () => {
    const { makeAtis, approachesInUseFor } = await import('../ui/store/session');
    const e = setup([], '4');
    const st = e.getState();
    st.weather = { ...st.weather, flightCategory: 'IFR', visibilitySm: 2, clouds: [{ cover: 'OVC', baseFtAgl: 600 }] };
    expect(approachesInUseFor(st)).toEqual(['ILS runway 4 approach']);
    const atis = makeAtis(st, 'A', Date.UTC(2026, 9, 21, 14, 0, 0));
    expect(atis.text).toMatch(/^Punta Gorda Airport information alpha/i);
    expect(atis.text).not.toMatch(/Atlantic City/);
    expect(atis.simulatedLabel).toMatch(/KPGD/);
  });
});
