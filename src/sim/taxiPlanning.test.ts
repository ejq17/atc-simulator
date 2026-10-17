/**
 * Taxi planning on the real KACY layout: full-length holds by default, taxiway destinations, hold short of a taxiway,
 * "continue taxiing", and a usable subset of an impossible via order. Regressions from a real session where "taxi to runway 31"
 * sent aircraft to the hotel intersection and "hold short of bravo" was refused.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadKacy } from '../airport';
import { GA_PARKED, IFR_HOLDING, cmd, find, makeScenario, run, runUntil, say } from './__fixtures__/testHelpers';
import { pickRunwayHold, runwayRemainingM } from './holdSelection';
import { findRunwayEnd } from './runways';
import type { ScenarioAircraftSpawn } from './types';

const kacy = loadKacy();
const graph = kacy.taxiwayGraph;

function setup(spawns: ScenarioAircraftSpawn[], dep = '31') {
  return createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [dep], landing: [dep] }, controllerPositions: ['TWR', 'GND'], spawns }) });
}
const a320 = (cs: string, gate: string) => GA_PARKED(cs, gate, 'GND', { type: 'A320', flightRules: 'IFR' });
const rb = (o: { status: string; readback?: string }) => (o.status === 'accepted' ? (o as { readback?: string }).readback ?? '' : '');
const pilot = (e: ReturnType<typeof setup>, cs: string) => e.getState().events.filter((x) => x.speaker === 'PILOT' && x.callsign === cs).map((x) => x.text);

describe('full length by default (7110.65 3-7-2: an intersection departure is requested, never assumed)', () => {
  it('"taxi to runway 31" from the terminal ends at bravo (full length), not at hotel', () => {
    const e = setup([a320('D1', 'GATE-2')]);
    const d1 = find(e, 'D1');
    expect(say(e, cmd('TAXI', 'D1', { runwayEnd: '31' }), 'GND').status).toBe('accepted');
    expect(d1.route!.nodeIds.at(-1)).toBe('HP13-31-B-2');
  });
  it('"taxi to runway 4" ends at alpha (6,100 ft), not delta (4,829 ft: too short for an A320)', () => {
    const e = setup([a320('D1', 'GATE-9')], '4');
    const d1 = find(e, 'D1');
    expect(say(e, cmd('TAXI', 'D1', { runwayEnd: '4' }), 'GND').status).toBe('accepted');
    expect(d1.route!.nodeIds.at(-1)).toBe('HP4-22-A-1');
  });
  it('a route ending on an intersection taxiway is an intersection departure there ("runway 31 via hotel")', () => {
    const e = setup([a320('D1', 'GATE-2')]);
    const d1 = find(e, 'D1');
    expect(say(e, cmd('TAXI', 'D1', { runwayEnd: '31', route: ['H'] }), 'GND').status).toBe('accepted');
    expect(d1.route!.nodeIds.at(-1)).toBe('HP13-31-H-1');
  });
  it('an intersection with too little runway for the type is accepted but flagged, and the pilot asks for full length at the hold', () => {
    const e = setup([a320('D1', 'GATE-9')], '4');
    const d1 = find(e, 'D1');
    const o = say(e, cmd('TAXI', 'D1', { runwayEnd: '4', route: ['D'] }), 'GND');
    expect(o.status).toBe('accepted');
    expect(d1.route!.nodeIds.at(-1)).toBe('HP4-22-D-1');
    expect(e.getState().events.some((x) => x.data?.improper && /full length/.test(x.text))).toBe(true);
    runUntil(e, () => d1.phase === 'HOLDING_SHORT', 900);
    run(e, 6);
    expect(pilot(e, 'D1').at(-1)).toMatch(/holding short runway four at delta, unable intersection departure, request full length/);
    expect(d1.pendingRequest?.kind).toBe('TAXI');
  });
  it('pickRunwayHold: ties within 30 m go to the shorter taxi, otherwise the most runway wins', () => {
    const g = findRunwayEnd(kacy, '31')!;
    const r = pickRunwayHold(kacy, 'PK-GATE-2', g, []);
    expect(r.pick?.hold.id).toBe('HP13-31-B-2');
    expect(runwayRemainingM(g, graph.nodes['HP13-31-B-2'])).toBeGreaterThan(runwayRemainingM(g, graph.nodes['HP13-31-H-1']));
  });
});

describe('hold short of a taxiway and continue', () => {
  it('"hold short of papa" stops the aircraft at the papa intersection with a pilot call; "continue taxiing" resumes to the hold', () => {
    const e = setup([a320('D1', 'GATE-2')]);
    const d1 = find(e, 'D1');
    expect(say(e, cmd('TAXI', 'D1', { runwayEnd: '31', route: ['L', 'P', 'B'] }), 'GND').status).toBe('accepted');
    const o = say(e, cmd('HOLD_SHORT', 'D1', { holdShort: ['P'] }), 'GND');
    expect(o.status).toBe('accepted');
    expect(rb(o)).toMatch(/Hold short of papa/);
    expect(runUntil(e, () => d1.groundSpeedKt < 0.1 && d1.route!.progressIndex > 5, 900)).toBe(true);
    const at = graph.nodes[d1.route!.nodeIds[d1.route!.progressIndex - 1]];
    expect(at.taxiways).toContain('P');
    expect(d1.phase).toBe('TAXIING');
    run(e, 3);
    expect(pilot(e, 'D1').at(-1)).toMatch(/holding short of papa/);
    const before = e.getState().clock.timeSec;
    run(e, 30);
    expect(d1.groundSpeedKt).toBeLessThan(0.1); // it stays
    const c = say(e, cmd('TAXI', 'D1', { destination: 'CONTINUE' }), 'GND');
    expect(c.status).toBe('accepted');
    expect(rb(c)).toMatch(/Runway three one, taxi/);
    expect(runUntil(e, () => d1.phase === 'HOLDING_SHORT', 900)).toBe(true);
    expect(d1.route!.nodeIds.at(-1)).toBe('HP13-31-B-2');
    expect(e.getState().clock.timeSec).toBeGreaterThan(before);
  });
  it('a hold short named in the taxi instruction itself ("taxi to runway 31 via L P B, hold short of bravo") stops at bravo', () => {
    const e = setup([a320('D1', 'GATE-2')]);
    const d1 = find(e, 'D1');
    const o = say(e, cmd('TAXI', 'D1', { runwayEnd: '31', route: ['L', 'P', 'B'], holdShort: ['B'] }), 'GND');
    expect(o.status).toBe('accepted');
    expect(rb(o)).toMatch(/hold short of bravo/i);
    expect(runUntil(e, () => d1.groundSpeedKt < 0.1 && d1.route!.progressIndex > 5, 900)).toBe(true);
    expect(graph.nodes[d1.route!.nodeIds[d1.route!.progressIndex - 1]].taxiways).toContain('B');
    expect(d1.phase).toBe('TAXIING');
  });
  it('a hold short of a taxiway the route never reaches is refused', () => {
    const e = setup([a320('D1', 'GATE-2')]);
    say(e, cmd('TAXI', 'D1', { runwayEnd: '31', route: ['L', 'P', 'B'] }), 'GND');
    const o = say(e, cmd('HOLD_SHORT', 'D1', { holdShort: ['C'] }), 'GND');
    expect(o.status).toBe('rejected');
    expect(o.status === 'rejected' ? o.pilotResponse : '').toMatch(/doesn't cross charlie/);
  });
});

describe('taxiway destinations and via order', () => {
  it('"taxi to kilo via bravo" taxis to the nearest point of kilo and stops there', () => {
    const e = setup([a320('D1', 'GATE-2')]);
    const d1 = find(e, 'D1');
    const o = say(e, cmd('TAXI', 'D1', { destination: 'TWYK', route: ['B'] }), 'GND');
    expect(o.status).toBe('accepted');
    expect(rb(o)).toMatch(/Taxi to kilo via bravo/);
    expect(graph.nodes[d1.route!.nodeIds.at(-1)!].taxiways).toContain('K');
    expect(runUntil(e, () => !d1.route || d1.route.progressIndex >= d1.route.nodeIds.length, 900)).toBe(true);
    expect(d1.phase).toBe('TAXIING');
    expect(d1.groundSpeedKt).toBeLessThan(0.1);
  });
  it('"runway 31 via bravo kilo" (kilo only branches off at the hold) is flown via bravo, read back as flown and flagged', () => {
    const e = setup([a320('D1', 'GATE-2')]);
    const d1 = find(e, 'D1');
    const o = say(e, cmd('TAXI', 'D1', { runwayEnd: '31', route: ['B', 'K'] }), 'GND');
    expect(o.status).toBe('accepted');
    expect(rb(o)).toMatch(/taxi via bravo, /);
    expect(rb(o)).not.toMatch(/kilo/);
    expect(d1.route!.nodeIds.at(-1)).toBe('HP13-31-B-2');
    expect(e.getState().events.some((x) => x.data?.improper && /not usable in that order/.test(x.text))).toBe(true);
  });
  it('an aircraft holding short of runway 4 can be re-taxied to runway 31 (runway change) and goes back to TAXIING', () => {
    const e = setup([IFR_HOLDING('D2', 'HP4-22-D-1', '4', ['TVO'], 'GND')]);
    const d2 = find(e, 'D2');
    expect(d2.phase).toBe('HOLDING_SHORT');
    expect(say(e, cmd('TAXI', 'D2', { runwayEnd: '31', route: ['B'] }), 'GND').status).toBe('accepted');
    expect(d2.phase).toBe('TAXIING');
    expect(runUntil(e, () => d2.phase === 'HOLDING_SHORT', 900)).toBe(true);
    expect(d2.route!.nodeIds.at(-1)).toBe('HP13-31-B-2');
  });
});
