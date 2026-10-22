/**
 * The runway configuration is changed in the middle of a session (the weather drawer, a wind shift): the AI positions follow it. Ground routes the departures that have not
 * reached their hold line to a runway now in use; the Tower never clears a takeoff on a runway that left the configuration (it sends the aircraft back to Ground) and sends
 * the arrivals that are not established on final to a landing runway now in use. Synthetic multi-runway fixture.
 */
import { describe, expect, it } from 'vitest';
import { createMultiRunwayAirport } from '../sim/__fixtures__/multiRunwayAirport';
import { ALL, createHarness } from './testkit';
import type { ScenarioAircraftSpawn } from '../sim/types';

const airport = createMultiRunwayAirport();
const WEST = { departing: ['27L'], landing: ['27R'] };
const EAST = { departing: ['9R'], landing: ['9L'] };

const gaDeparture = (callsign: string, parkingId: string, frequency = 'GND'): ScenarioAircraftSpawn =>
  ({ atSec: 0, callsign, type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId }, isDeparture: true, initialFrequencyId: frequency });

const takeoffs = (h: ReturnType<typeof createHarness>, callsign: string) => h.outcomes.filter((o) => o.cmd.kind === 'TAKEOFF' && o.cmd.callsign === callsign);

describe('runway configuration changed while a departure taxis', () => {
  const h = createHarness({ airport, player: [], ai: ALL, mode: 'free_play', activeRunways: WEST, readbackErrorRate: 0, spawns: [gaDeparture('N411AB', 'GA1')] });
  const before = h.runUntil(() => h.find('N411AB')?.phase === 'TAXIING' && h.find('N411AB')?.assignedRunwayEnd === '27L', 400);
  const at = h.now();
  h.engine.setActiveRunways(EAST);
  h.run(500);

  it('was taxiing to the old departure runway, on its way, when the configuration changed', () => {
    expect(before).toBe(true);
    expect(at).toBeGreaterThan(0);
  });

  it('Ground gives a new taxi instruction to the new departure runway and the aircraft follows it', () => {
    const reroute = h.outcomes.find((o) => o.timeSec > at && o.position === 'GND' && o.cmd.kind === 'TAXI' && o.cmd.callsign === 'N411AB');
    expect(reroute?.out.status).toBe('accepted');
    expect(reroute?.cmd.runwayEnd).toBe('9R');
    const ac = h.find('N411AB');
    expect(ac === undefined || ac.assignedRunwayEnd === '9R').toBe(true);
    expect(h.atc('GND').some((e) => e.timeSec > at && /runway niner right/.test(e.text))).toBe(true);
  });

  it('the Tower never clears it on the runway that left the configuration; it departs from the new one', () => {
    expect(takeoffs(h, 'N411AB').filter((o) => o.out.status === 'accepted').map((o) => o.cmd.runwayEnd)).toEqual(['9R']);
    expect(h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION', 'CONFLICT'].includes(e.kind))).toEqual([]);
  });
});

describe('runway configuration changed while a departure waits at the hold line of the old runway', () => {
  const h = createHarness({
    airport, player: [], ai: ALL, mode: 'free_play', activeRunways: WEST, readbackErrorRate: 0,
    spawns: [{ atSec: 0, callsign: 'N722CD', type: 'C172', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: 'HSE2', runwayEnd: '27L' }, isDeparture: true, initialFrequencyId: 'TWR', initialRequest: 'DEPARTURE' }],
  });
  // The aircraft is cleared at once in the old configuration if we let it: change the configuration before the Tower's first reaction.
  h.engine.setActiveRunways(EAST);
  h.run(700);

  it('the Tower does not clear it on 27L: it sends the aircraft back to Ground', () => {
    expect(takeoffs(h, 'N722CD').filter((o) => o.cmd.runwayEnd === '27L')).toEqual([]);
    expect(h.outcomes.some((o) => o.position === 'TWR' && o.cmd.kind === 'CONTACT_FREQUENCY' && o.cmd.callsign === 'N722CD')).toBe(true);
  });

  it('Ground routes it to the new departure runway and it takes off from there', () => {
    const reroute = h.outcomes.find((o) => o.position === 'GND' && o.cmd.kind === 'TAXI' && o.cmd.callsign === 'N722CD');
    expect(reroute?.cmd.runwayEnd).toBe('9R');
    expect(takeoffs(h, 'N722CD').filter((o) => o.out.status === 'accepted').map((o) => o.cmd.runwayEnd)).toEqual(['9R']);
  });
});

describe('runway configuration changed while an arrival is inbound', () => {
  const arrival: ScenarioAircraftSpawn = {
    atSec: 0, callsign: 'N533EF', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', initialRequest: 'LANDING',
    start: { kind: 'airborne', pos: { x: 14000, y: 610 }, altitudeFt: 2500, headingDeg: 270, speedKt: 90, runwayEnd: '27R' },
  };
  const h = createHarness({ airport, player: [], ai: ALL, mode: 'free_play', activeRunways: WEST, readbackErrorRate: 0, spawns: [arrival] });
  h.run(20);
  const at = h.now();
  h.engine.setActiveRunways(EAST);
  h.run(900);

  it('is sent to the new landing runway (a straight-in) and is never cleared to land on the old one after the change', () => {
    const lands = h.outcomes.filter((o) => o.cmd.kind === 'LAND' && o.cmd.callsign === 'N533EF' && o.timeSec > at);
    expect(lands.length).toBeGreaterThan(0);
    expect(new Set(lands.map((o) => o.cmd.runwayEnd))).toEqual(new Set(['9L']));
    expect(h.outcomes.find((o) => o.timeSec > at && o.cmd.kind === 'ENTER_PATTERN' && o.cmd.callsign === 'N533EF')?.cmd.runwayEnd).toBe('9L');
    expect(h.atc('TWR').some((e) => e.timeSec > at && /straight-in runway niner left/.test(e.text))).toBe(true);
  });
});
