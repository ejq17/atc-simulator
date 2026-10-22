/**
 * Engine smoke test on the real EGLL dataset (first non-US, parallel-runway airport; no runway crossing in the graph): an airliner is
 * taxied from a Terminal 5 stand to the runway 27R hold and flown out; an A320 lands on 27L (ILS) and taxis to a stand; the published
 * runway configurations are selected by wind.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadEgll } from '../airport';
import { cmd, find, has, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import type { ScenarioAircraftSpawn } from './types';
import { selectRunwayConfiguration } from '../weather/runwayConfigurations';

const egll = loadEgll();

const airlinerParked = (callsign: string, parkingId: string): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'A320', flightRules: 'IFR', start: { kind: 'parked', parkingId }, isDeparture: true, initialFrequencyId: 'GND',
});
const arriving = (callsign: string, runwayEnd: string, distanceNm: number): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'A320', flightRules: 'IFR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 160, runwayEnd, distanceNm }, isDeparture: false, initialFrequencyId: 'TWR',
});

function setup(spawns: ScenarioAircraftSpawn[], landing = ['27L'], departing = ['27R']) {
  return createEngine({
    airport: egll,
    readbackErrorRate: 0,
    scenario: makeScenario({ activeRunways: { departing, landing }, controllerPositions: ['TWR', 'GND'], spawns }),
  });
}

describe('EGLL engine smoke', () => {
  it('departure: taxi from a Terminal 5 stand to the 27R hold, takeoff, climb-out', () => {
    const e = setup([airlinerParked('BAW123', 'STAND-501')]);
    const ac = find(e, 'BAW123');
    expect(say(e, cmd('TAXI', 'BAW123', { runwayEnd: '27R' }), 'GND').status).toBe('accepted');
    expect(ac.route!.nodeIds.at(-1)).toMatch(/^HP9L-27R-/);
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 1800)).toBe(true);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'BAW123', { frequencyId: 'TWR' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'DEPARTURE', 90)).toBe(true);
    expect(pilotTexts(e, 'BAW123').some((t) => t.startsWith('Heathrow Tower, Speedbird'))).toBe(true);
    expect(say(e, cmd('TAKEOFF', 'BAW123', { runwayEnd: '27R' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'DEPARTURE' && ac.altitudeFt > egll.elevationFt + 500, 300)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });

  it('arrival: A320 cleared to land on 27L, the displaced-free end, exits and taxis to a stand', () => {
    const e = setup([arriving('BAW456', '27L', 6)]);
    const ac = find(e, 'BAW456');
    expect(say(e, cmd('LAND', 'BAW456', { runwayEnd: '27L' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 900)).toBe(true);
    expect(runUntil(e, () => ac.phase === 'RUNWAY_EXIT' && ac.occupyingRunways.length === 0, 300)).toBe(true);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'BAW456', { frequencyId: 'GND' }), 'TWR').status).toBe('accepted');
    run(e, 30);
    expect(say(e, cmd('TAXI', 'BAW456', { destination: 'STAND-501' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'PARKED' || !has(e, 'BAW456'), 2400)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });

  it('segregated mode: a departure on 27R and an arrival on 27L run at the same time without a safety event', () => {
    const arrival: ScenarioAircraftSpawn = { ...arriving('BAW456', '27L', 8), atSec: 900 };
    const e = setup([airlinerParked('BAW123', 'STAND-501'), arrival]);
    const dep = find(e, 'BAW123');
    say(e, cmd('TAXI', 'BAW123', { runwayEnd: '27R' }), 'GND');
    expect(runUntil(e, () => dep.phase === 'HOLDING_SHORT', 1800)).toBe(true);
    say(e, cmd('CONTACT_FREQUENCY', 'BAW123', { frequencyId: 'TWR' }), 'GND');
    runUntil(e, () => dep.frequencyId === 'TWR' && dep.pendingRequest?.kind === 'DEPARTURE', 90);
    say(e, cmd('TAKEOFF', 'BAW123', { runwayEnd: '27R' }), 'TWR');
    expect(runUntil(e, () => has(e, 'BAW456'), 2400)).toBe(true);
    expect(dep.phase === 'TAKEOFF_ROLL' || dep.phase === 'INITIAL_CLIMB' || dep.phase === 'DEPARTURE' || dep.phase === 'CLEARED_FOR_TAKEOFF').toBe(true);
    const arr = find(e, 'BAW456');
    const landing = say(e, cmd('LAND', 'BAW456', { runwayEnd: '27L' }), 'TWR');
    expect(landing, JSON.stringify(landing)).toMatchObject({ status: 'accepted' });
    expect(runUntil(e, () => arr.phase === 'ROLLOUT', 900)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION')).toEqual([]);
  });
});

describe('EGLL runway configuration selection (AD 2.20 para 6: 27 preferred up to 5 kt tailwind)', () => {
  const sel = (dir: number, kt: number) => selectRunwayConfiguration(egll.runwayConfigurations, { windDirDeg: dir, windSpeedKt: kt }, egll)!.config;
  it('westerly wind: a 27 configuration with one runway landing and the other departing', () => {
    const c = sel(250, 12);
    expect(c.id).toMatch(/^W-ALT-27/);
    expect(c.landing).toHaveLength(1);
    expect(c.departing).toHaveLength(1);
    expect(c.landing[0]).not.toBe(c.departing[0]);
  });
  it('easterly wind: landing 9L, departing 9R (northern runway cannot depart eastbound by day, operator page)', () => {
    expect(sel(90, 15)).toMatchObject({ id: 'E-SEG-09L', landing: ['9L'], departing: ['9R'] });
  });
  it('calm: the first configuration (27R landing)', () => {
    expect(sel(0, 0).id).toBe('W-ALT-27R');
  });
});

describe('EGLL in the UI layer', () => {
  it('the ATIS is a UK ATIS: Heathrow, QNH in hPa, visibility in metres, the ILS in use', async () => {
    const { makeAtis, approachesInUseFor } = await import('../ui/store/session');
    const e = setup([]);
    const st = e.getState();
    st.weather = { ...st.weather, flightCategory: 'IFR', visibilitySm: 1.2, clouds: [{ cover: 'OVC', baseFtAgl: 400 }], altimeterInHg: 29.74 };
    expect(approachesInUseFor(st)).toEqual(expect.arrayContaining([expect.stringMatching(/^ILS runway (27L|27R) approach/)]));
    const atis = makeAtis(st, 'B', Date.UTC(2026, 9, 21, 10, 0, 0));
    expect(atis.text).toMatch(/^Heathrow information bravo/i);
    expect(atis.text).toMatch(/QNH 1007/);
    expect(atis.text).toMatch(/Visibility 1900 metres/);
    expect(atis.text).not.toMatch(/Altimeter|Atlantic City|hold short/);
  });
});
