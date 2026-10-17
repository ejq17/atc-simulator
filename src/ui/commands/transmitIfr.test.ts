import { describe, expect, it } from 'vitest';
import { createEngine } from '../../sim/engine';
import type { SimulationEngine } from '../../sim/api';
import type { Scenario, ScenarioAircraftSpawn } from '../../sim/types';
import { loadKacy } from '../../airport';
import { getPresetWeather } from '../../weather/presets';
import { POSITION_CHOICES } from '../lib/positions';
import { buildParseContext, fixList, positionFor, transmit } from './transmit';
import type { ControllerSetup } from './transmit';

const airport = loadKacy();
const ALL: ControllerSetup = { positions: POSITION_CHOICES.ALL };

interface Heard { callsign: string; text: string; frequencyMhz: number }

function engineWith(spawns: ScenarioAircraftSpawn[]) {
  const scenario: Scenario = {
    id: 'ui-ifr', name: 'UI IFR', description: 'scripted', mode: 'training', seed: 5, weather: getPresetWeather('clear'),
    activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['CLNC', 'GND', 'TWR', 'APP', 'DEP'], spawns,
  };
  const heard: Heard[] = [];
  const engine = createEngine({ airport, scenario, readbackErrorRate: 0, onPilotTransmission: (t) => heard.push({ callsign: t.callsign, text: t.text, frequencyMhz: t.frequencyMhz }) });
  return { engine, heard };
}

const arrival: ScenarioAircraftSpawn = {
  atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP', initialRequest: 'APPROACH',
  start: { kind: 'at_fix', fix: 'VCN', altitudeFt: 5000, speedKt: 190, route: ['VCN', 'CARYL', 'MAYBN'], runwayEnd: '13' },
  flightPlan: { flightRules: 'IFR', origin: 'KPHL', destination: 'KACY', cruiseAltitudeFt: 5000, route: ['VCN', 'CARYL', 'MAYBN'] },
};
const departure: ScenarioAircraftSpawn = {
  atSec: 0, callsign: 'NKS608', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'CLNC', initialRequest: 'IFR_CLEARANCE',
  start: { kind: 'parked', parkingId: airport.parking.find((p) => p.category === 'airline')?.id ?? airport.parking[0].id },
  flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: ['ACY'] },
};

function runSec(engine: SimulationEngine, sec: number) {
  const n = Math.round(sec / engine.getState().clock.dtSec);
  for (let i = 0; i < n; i++) engine.step();
}

describe('IFR positions and fixes through the transmit pipeline', () => {
  it('passes every fix and navaid (not ILS/LOC/DME) with names to the parser', () => {
    const { engine } = engineWith([arrival]);
    const fixes = fixList(engine.getState());
    expect(fixes.find((f) => f.id === 'CARYL')).toBeDefined();
    expect(fixes.find((f) => f.id === 'VCN')?.name).toBe('CEDAR LAKE');
    expect(fixes.some((f) => f.id.startsWith('I-'))).toBe(false);
    expect(buildParseContext(engine.getState()).fixes).toHaveLength(fixes.length);
  });

  it('All positions: each aircraft is addressed on its own frequency (APP/DEP share 124.6)', () => {
    const { engine } = engineWith([arrival, departure]);
    runSec(engine, 20);
    const st = engine.getState();
    const by = (cs: string) => Object.values(st.aircraft).find((a) => a.callsign === cs)!;
    expect(positionFor(st, ALL, by('NKS451'))).toBe('APP');
    expect(positionFor(st, ALL, by('NKS608'))).toBe('CLNC');
  });

  it('an approach clearance on Approach is accepted and read back; direct Cedar Lake resolves to VCN', () => {
    const { engine, heard } = engineWith([arrival]);
    runSec(engine, 8);
    const r = transmit({ engine, text: 'Spirit four fifty one, cleared ILS runway one three approach', source: 'typed', controller: ALL });
    expect(r.results[0].command.kind).toBe('APPROACH');
    expect(r.results[0].position).toBe('APP');
    expect(r.summary).toBe('accepted');
    expect(r.txMhz).toBe(124.6);
    expect(heard.at(-1)?.text).toMatch(/^Cleared ILS runway one three approach/);
    const d = transmit({ engine, text: 'Spirit four fifty one, proceed direct Cedar Lake', source: 'typed', controller: ALL });
    expect(d.commands[0].kind).toBe('DIRECT_FIX');
    expect(d.commands[0].fix).toBe('VCN');
  });

  it('the IFR clearance goes out on Clearance Delivery and the readback names the departure and squawk', () => {
    const { engine, heard } = engineWith([departure]);
    runSec(engine, 10);
    const r = transmit({
      engine, source: 'typed', controller: ALL,
      text: 'Spirit six oh eight, cleared to Philadelphia airport via the Atlantic City Three departure, maintain two thousand, expect one zero thousand, departure frequency one two four point six, squawk four two one five',
    });
    expect(r.results[0].command.kind).toBe('IFR_CLEARANCE');
    expect(r.results[0].position).toBe('CLNC');
    expect(r.summary).toBe('accepted');
    const text = heard.at(-1)!.text;
    expect(text).toMatch(/Atlantic City Three departure/i);
    expect(text).toMatch(/squawk/i);
  });

  it('an aircraft on a frequency the player does not work is flagged as off-frequency', () => {
    const { engine } = engineWith([arrival]);
    runSec(engine, 8);
    const r = transmit({ engine, text: 'Spirit four fifty one, cleared ILS runway one three approach', source: 'typed', controller: { positions: ['TWR', 'GND'] } });
    expect(r.summary).toBe('rejected');
    expect(r.offFrequency).toBe(true);
    expect(r.message).toMatch(/Not on frequency/);
  });

  it('radar contact is accepted with an empty readback and the pilot says nothing', () => {
    const { engine, heard } = engineWith([arrival]);
    runSec(engine, 8);
    const before = heard.length;
    const r = transmit({ engine, text: 'Spirit four fifty one, radar contact', source: 'typed', controller: ALL });
    expect(r.results[0].command.kind).toBe('RADAR_CONTACT');
    const out = r.results[0].outcome;
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('');
    expect(heard.slice(before).every((h) => h.text.trim().length > 0)).toBe(true);
    expect(engine.getState().events.some((e) => e.speaker === 'ATC' && /radar contact/i.test(e.text))).toBe(true);
  });
});
