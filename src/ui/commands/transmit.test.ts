import { beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../../sim/engine';
import type { SimulationEngine } from '../../sim/api';
import type { Scenario, ScenarioAircraftSpawn } from '../../sim/types';
import { loadKacy, runwayEntryNodes } from '../../airport';
import { buildParseContext, controllerFrequencies, parseForTransmit, positionFor, taxiwayNames, transmit } from './transmit';
import type { ParseResult } from '../../sim/types';
import type { ControllerSetup } from './transmit';
import { getPresetWeather } from '../../weather/presets';

const airport = loadKacy();
const nodeId = (e: unknown) => (e as { node?: { id: string }; id?: string }).node?.id ?? (e as { id: string }).id;

interface Heard { callsign: string; text: string; frequencyMhz: number }

function scripted(extra: ScenarioAircraftSpawn[] = []): { engine: SimulationEngine; heard: Heard[] } {
  const hold13 = nodeId(runwayEntryNodes(airport, '13')[0]);
  const scenario: Scenario = {
    id: 'ui-test', name: 'UI test', description: 'scripted', mode: 'training', seed: 5, weather: getPresetWeather('clear'),
    activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR', 'GND'],
    spawns: [
      { atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: hold13, runwayEnd: '13' }, isDeparture: true, initialFrequencyId: 'TWR', initialRequest: 'DEPARTURE' },
      ...extra,
    ],
  };
  const heard: Heard[] = [];
  const engine = createEngine({ airport, scenario, readbackErrorRate: 0, onPilotTransmission: (t) => heard.push({ callsign: t.callsign, text: t.text, frequencyMhz: t.frequencyMhz }) });
  return { engine, heard };
}

const TWR: ControllerSetup = { positions: ['TWR'] };
const BOTH: ControllerSetup = { positions: ['TWR', 'GND'] };

function runSec(engine: SimulationEngine, sec: number) {
  const n = Math.round(sec / engine.getState().clock.dtSec);
  for (let i = 0; i < n; i++) engine.step();
}

describe('transmit pipeline', () => {
  let engine: SimulationEngine;
  let heard: Heard[];
  beforeEach(() => ({ engine, heard } = scripted()));

  it('applies an accepted clearance to the real engine and the aircraft departs', () => {
    runSec(engine, 8); // let the first pilot call happen
    const before = engine.getState().events.length;
    const r = transmit({ engine, text: 'Cessna seven two three echo juliet, runway one three, cleared for takeoff', source: 'typed', controller: TWR });
    expect(r.summary).toBe('accepted');
    expect(r.results).toHaveLength(1);
    expect(r.results[0].outcome.status).toBe('accepted');
    expect(r.results[0].command.kind).toBe('TAKEOFF');
    expect(engine.getState().events.length).toBeGreaterThan(before);
    runSec(engine, 90);
    const ac = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'N723EJ')!;
    expect(['TAKEOFF_ROLL', 'INITIAL_CLIMB', 'DEPARTURE']).toContain(ac.phase);
    expect(ac.onGround).toBe(false);
  });

  it('logs the ATC call once and lets the engine speak the readback exactly once', () => {
    runSec(engine, 8);
    const spoken = heard.length;
    transmit({ engine, text: 'Cessna seven two three echo juliet, runway one three, cleared for takeoff', source: 'typed', controller: TWR });
    const readbacks = heard.slice(spoken);
    expect(readbacks).toHaveLength(1);
    expect(readbacks[0].text).toBe('Runway one three, cleared for takeoff, Cessna seven two three echo juliet');
    const atc = engine.getState().events.filter((e) => e.kind === 'TRANSMISSION' && e.speaker === 'ATC');
    expect(atc).toHaveLength(1);
  });

  it('asks for clarification when no callsign is given and does not speak or change anything', () => {
    runSec(engine, 8);
    const spoken = heard.length;
    const r = transmit({ engine, text: 'runway one three, cleared for takeoff', source: 'voice', controller: TWR });
    expect(r.summary).toBe('clarify');
    expect(r.clarification).toMatch(/callsign/i);
    expect(heard.length).toBe(spoken); // no aircraft to speak for an unresolved callsign
    expect(engine.getState().events.some((e) => e.kind === 'CLARIFICATION')).toBe(true);
    const ac = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'N723EJ')!;
    expect(ac.phase).toBe('HOLDING_SHORT');
  });

  it('a clarification for a known aircraft is spoken by the engine only (no duplicate from the UI)', () => {
    runSec(engine, 8);
    const spoken = heard.length;
    const r = transmit({ engine, text: 'Cessna seven two three echo juliet, cleared for takeoff', source: 'typed', controller: TWR });
    // Either accepted with an inferred runway or a clarification: in both cases at most one pilot call results.
    expect(heard.length - spoken).toBeLessThanOrEqual(1);
    if (r.summary === 'clarify') expect(heard.slice(spoken).every((h) => h.callsign === 'N723EJ')).toBe(true);
  });

  it('applies several commands in one transmission in order', () => {
    runSec(engine, 8);
    transmit({ engine, text: 'Cessna seven two three echo juliet, runway one three, cleared for takeoff', source: 'typed', controller: TWR });
    runSec(engine, 70);
    const r = transmit({ engine, text: 'Cessna seven two three echo juliet, turn left heading two seven zero, climb and maintain three thousand', source: 'typed', controller: TWR });
    expect(r.results.map((x) => x.command.kind)).toEqual(['HEADING', 'ALTITUDE']);
    expect(r.results.every((x) => x.outcome.status === 'accepted')).toBe(true);
    const ac = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'N723EJ')!;
    expect(ac.target.altitudeFt).toBe(3000);
    expect(ac.target.headingDeg).toBeDefined();
    // One ATC transmission event for the whole call.
    const atc = engine.getState().events.filter((e) => e.speaker === 'ATC' && /heading/i.test(e.text));
    expect(atc).toHaveLength(1);
  });

  it('stops at the first clarification but keeps what was already applied', () => {
    runSec(engine, 8);
    transmit({ engine, text: 'Cessna seven two three echo juliet, runway one three, cleared for takeoff', source: 'typed', controller: TWR });
    runSec(engine, 70);
    const r = transmit({ engine, text: 'Cessna seven two three echo juliet, turn left heading two seven zero, climb and maintain, contact approach', source: 'typed', controller: TWR });
    expect(r.commands.length).toBeGreaterThanOrEqual(2);
    expect(r.results[0].outcome.status).toBe('accepted');
    expect(r.results[1].outcome.status).toBe('clarify');
    expect(r.results).toHaveLength(2); // nothing after the clarification was applied
    expect(r.summary).toBe('clarify');
    expect(r.clarification).toMatch(/altitude/i);
  });

  it('rejects an instruction for an aircraft that is not on the controller frequency, with an explanation', () => {
    ({ engine, heard } = scripted([
      { atSec: 0, callsign: 'N482KB', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: airport.parking[0].id }, isDeparture: true, initialFrequencyId: 'GND' },
    ]));
    runSec(engine, 8);
    const r = transmit({ engine, text: 'Cessna four eight two kilo bravo, hold position', source: 'typed', controller: TWR });
    expect(r.summary).toBe('rejected');
    expect(r.message).toMatch(/Not on frequency/);
    expect(engine.getState().events.some((e) => e.kind === 'COMMAND_REJECTED')).toBe(true);
  });

  it('rejects clearing a parked aircraft for takeoff', () => {
    ({ engine, heard } = scripted([
      { atSec: 0, callsign: 'N482KB', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: airport.parking[0].id }, isDeparture: true, initialFrequencyId: 'TWR' },
    ]));
    runSec(engine, 8);
    const r = transmit({ engine, text: 'Cessna four eight two kilo bravo, runway one three, cleared for takeoff', source: 'typed', controller: TWR });
    expect(r.summary).toBe('rejected');
    const ac = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'N482KB')!;
    expect(['PARKED', 'READY']).toContain(ac.phase);
  });

  it('combined Tower + Ground sends each call on the addressed aircraft frequency', () => {
    ({ engine, heard } = scripted([
      { atSec: 0, callsign: 'N482KB', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: airport.parking[0].id }, isDeparture: true, initialFrequencyId: 'GND' },
    ]));
    runSec(engine, 8);
    const gndAc = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'N482KB')!;
    expect(positionFor(engine.getState(), BOTH, gndAc)).toBe('GND');
    const twrAc = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'N723EJ')!;
    expect(positionFor(engine.getState(), BOTH, twrAc)).toBe('TWR');
    const r = transmit({ engine, text: 'Cessna four eight two kilo bravo, hold position', source: 'typed', controller: BOTH });
    expect(r.results[0].position).toBe('GND');
    expect(r.summary).not.toBe('rejected');
  });

  it('prefers the on-frequency aircraft when a callsign suffix is ambiguous', () => {
    ({ engine, heard } = scripted([
      { atSec: 0, callsign: 'N993EJ', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: airport.parking[0].id }, isDeparture: true, initialFrequencyId: 'GND' },
    ]));
    runSec(engine, 8);
    const r = transmit({ engine, text: 'three echo juliet, hold position', source: 'typed', controller: TWR });
    expect(r.commands[0].callsign).toBe('N723EJ');
  });

  it('ignores empty input', () => {
    const r = transmit({ engine, text: '   ', source: 'typed', controller: TWR });
    expect(r.summary).toBe('empty');
    expect(r.results).toHaveLength(0);
  });
});

describe('parse context helpers', () => {
  it('lists runway ends, named taxiways and frequencies from the airport', () => {
    const { engine } = scripted();
    const ctx = buildParseContext(engine.getState());
    expect(ctx.runwayEnds.sort()).toEqual(['13', '22', '31', '4']);
    expect(ctx.taxiways).toContain('A');
    expect(ctx.taxiways).not.toContain('UNNAMED');
    expect(ctx.frequencies.find((f) => f.id === 'TWR')?.mhz).toBe(120.3);
    expect(taxiwayNames(engine.getState()).length).toBeGreaterThan(5);
  });

  it('takes controller frequencies from airport data, never constants', () => {
    const { engine } = scripted();
    expect(controllerFrequencies(engine.getState(), BOTH)).toEqual([120.3, 121.9]);
    expect(controllerFrequencies(engine.getState(), { positions: ['CLNC'] })).toEqual([127.85]);
  });
});

describe('parsed override and parseForTransmit', () => {
  const SAY = 'Cessna seven two three echo juliet, runway one three, cleared for takeoff';

  it('parseForTransmit returns the local parse and the context it was made with', () => {
    const { engine } = scripted();
    const { parsed, ctx } = parseForTransmit(engine, SAY, TWR);
    expect(parsed.commands[0]).toMatchObject({ kind: 'TAKEOFF', callsign: 'N723EJ' });
    expect(ctx.aircraft.map((a) => a.callsign)).toContain('N723EJ');
    expect(ctx.runwayEnds).toContain('13');
  });

  it('transmit executes a supplied parse instead of parsing the text, and says where it came from', () => {
    const { engine } = scripted();
    runSec(engine, 8);
    const supplied: ParseResult = {
      commands: [{ kind: 'TAKEOFF', callsign: 'N723EJ', runwayEnd: '13', runwayId: '13/31', confidence: 0.9, rawText: 'blah', normalizedText: 'blah', issues: [], interpretedBy: 'llm' }],
      callsign: 'N723EJ', rawText: 'blah', normalizedText: 'blah',
    };
    const r = transmit({ engine, text: 'blah blah unintelligible', source: 'typed', controller: TWR, parsed: supplied, interpreterNote: 'phrase interpreter, 1.2 s' });
    expect(r.summary).toBe('accepted');
    expect(r.commands[0].interpretedBy).toBe('llm');
    expect(r.message).toBe('Issued: takeoff N723EJ (phrase interpreter, 1.2 s)');
  });

  it('the grammar path is unchanged: no note, no interpretedBy', () => {
    const { engine } = scripted();
    runSec(engine, 8);
    const r = transmit({ engine, text: SAY, source: 'typed', controller: TWR, interpreterNote: 'phrase interpreter, 1.2 s' });
    expect(r.message).toBe('Issued: takeoff N723EJ');
    expect(r.commands[0].interpretedBy).toBeUndefined();
  });

  it('an empty supplied parse still ends in the "no instruction" clarification', () => {
    const { engine } = scripted();
    const r = transmit({ engine, text: 'mumble', source: 'typed', controller: TWR, parsed: { commands: [], callsign: null, rawText: 'mumble', normalizedText: 'mumble' } });
    expect(r.summary).toBe('clarify');
  });
});
