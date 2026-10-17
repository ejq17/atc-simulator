import { describe, expect, it } from 'vitest';
import { createEngine } from '../../sim/engine';
import { loadKacy } from '../../airport';
import { getPresetWeather } from '../../weather/presets';
import type { Scenario, ScenarioAircraftSpawn } from '../../sim/types';
import { aiPositionOf, aiRefusal, mhzText, transmit } from './transmit';
import type { ControllerSetup } from './transmit';

const airport = loadKacy();

function engineWith(spawns: ScenarioAircraftSpawn[]) {
  const scenario: Scenario = {
    id: 'ai-test', name: 'AI test', description: '', mode: 'free_play', seed: 3, weather: getPresetWeather('clear'),
    activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR', 'GND'], playerPositions: ['GND'], spawns,
  };
  const heard: string[] = [];
  const engine = createEngine({ airport, scenario, readbackErrorRate: 0, onPilotTransmission: (t) => heard.push(`${t.callsign}: ${t.text}`) });
  return { engine, heard };
}

/** An A320 on the 13 final that talks to Tower (120.3), and a Cessna parked on the ramp that talks to Ground (121.9). */
const spawns: ScenarioAircraftSpawn[] = [
  { atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 1500, headingDeg: 118, speedKt: 150, runwayEnd: '13', distanceNm: 6 }, isDeparture: false, initialFrequencyId: 'TWR', initialRequest: 'LANDING' },
  { atSec: 0, callsign: 'N482KB', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: airport.parking[0].id }, isDeparture: true, initialFrequencyId: 'GND', initialRequest: 'TAXI' },
];

const GROUND_ONLY: ControllerSetup = { positions: ['GND'], aiPositions: ['TWR'] };

describe('commands to aircraft that are with an AI controller', () => {
  it('formats frequencies the way a controller says them', () => {
    expect(mhzText(120.3)).toBe('120.3');
    expect(mhzText(127.85)).toBe('127.85');
    expect(mhzText(124.6)).toBe('124.6');
  });

  it('knows which AI position an aircraft is with, but never for a frequency the player works too', () => {
    const { engine } = engineWith(spawns);
    const st = engine.getState();
    const nks = Object.values(st.aircraft).find((a) => a.callsign === 'NKS451')!;
    const n482 = Object.values(st.aircraft).find((a) => a.callsign === 'N482KB')!;
    expect(aiPositionOf(st, GROUND_ONLY, nks)).toEqual({ position: 'TWR', mhz: 120.3 });
    expect(aiPositionOf(st, GROUND_ONLY, n482)).toBeUndefined(); // Ground is the player's
    expect(aiPositionOf(st, { positions: ['GND'] }, nks)).toBeUndefined(); // no AI at all
    // Player works Tower too: the same aircraft is not "with AI".
    expect(aiPositionOf(st, { positions: ['GND', 'TWR'], aiPositions: [] }, nks)).toBeUndefined();
  });

  it('refuses a clearance for an AI-worked aircraft with a clear message, and the engine never sees it', () => {
    const { engine, heard } = engineWith(spawns);
    for (let i = 0; i < 80; i++) engine.step();
    const before = engine.getState().events.filter((e) => e.kind === 'COMMAND_ACCEPTED' || e.kind === 'COMMAND_REJECTED').length;
    const heardBefore = heard.length;
    const r = transmit({ engine, text: 'Spirit four fifty one, runway one three, cleared to land', source: 'typed', controller: GROUND_ONLY });
    expect(r.summary).toBe('rejected');
    expect(r.message).toBe('NKS451 is with AI Tower on 120.3; wait for the handoff.');
    expect(r.aiBlocked).toEqual({ callsign: 'NKS451', position: 'TWR', mhz: 120.3 });
    expect(r.offFrequency).toBe(false);
    expect(r.txMhz).toBeUndefined();
    expect(heard.length).toBe(heardBefore); // no pilot reply
    const st = engine.getState();
    expect(st.events.filter((e) => e.kind === 'COMMAND_ACCEPTED' || e.kind === 'COMMAND_REJECTED').length).toBe(before); // nothing scored
    expect(st.events.at(-1)).toMatchObject({ speaker: 'SYSTEM', severity: 'warning', callsign: 'NKS451', text: 'NKS451 is with AI Tower on 120.3; wait for the handoff.' });
    expect(Object.values(st.aircraft).find((a) => a.callsign === 'NKS451')!.clearances).toHaveLength(0);
  });

  it('aiRefusal names the position the way the radio does', () => {
    expect(aiRefusal('NKS451', 'GND', 121.9)).toBe('NKS451 is with AI Ground on 121.9; wait for the handoff.');
    expect(aiRefusal('AAL1', 'APP', 124.6)).toBe('AAL1 is with AI Approach on 124.6; wait for the handoff.');
  });

  it('still works the aircraft on the player\'s own frequency', () => {
    const { engine, heard } = engineWith(spawns);
    for (let i = 0; i < 120; i++) engine.step(); // the Cessna's taxi request
    const r = transmit({ engine, text: 'Cessna four eight two kilo bravo, hold position', source: 'typed', controller: GROUND_ONLY });
    expect(r.aiBlocked).toBeUndefined();
    expect(r.results[0].outcome.status).not.toBe('clarify');
    void heard;
  });

  it('without AI positions an aircraft on an unstaffed frequency gets the engine\'s own "not on frequency"', () => {
    const { engine } = engineWith(spawns);
    const r = transmit({ engine, text: 'Spirit four fifty one, runway one three, cleared to land', source: 'typed', controller: { positions: ['GND'] } });
    expect(r.aiBlocked).toBeUndefined();
    expect(r.offFrequency).toBe(true);
    expect(r.message).toMatch(/Not on frequency/);
  });
});
