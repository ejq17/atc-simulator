import { describe, expect, it } from 'vitest';
import type { ScenarioAircraftSpawn } from './types';
import { cmd, find, GA_PARKED, makeEngine, run } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { resolveParkingQuery } from './parkingResolver';

const airport = createTestAirport();
const A320_AT = (callsign: string, parkingId: string): ScenarioAircraftSpawn => GA_PARKED(callsign, parkingId, 'GND', { type: 'A320', flightRules: 'IFR' });
const taxiPark = (e: ReturnType<typeof makeEngine>, callsign: string, f: Parameters<typeof cmd>[2] = {}) =>
  e.applyCommand(cmd('TAXI_TO_PARKING', callsign, f), { position: 'GND' });
const destOf = (o: ReturnType<typeof taxiPark>) => (o.status === 'accepted' ? o.clearance.destination : undefined);

describe('parking resolution', () => {
  it('resolves exact ids, ids without punctuation, names and category keywords (case-insensitive)', () => {
    const k = (q?: string) => resolveParkingQuery(airport, q);
    expect(k('ga2')).toMatchObject({ kind: 'spot', parking: { id: 'GA2' } });
    expect(k('GATE1')).toMatchObject({ kind: 'spot', parking: { id: 'GATE-1' } });
    expect(k('gate-2')).toMatchObject({ kind: 'spot', parking: { id: 'GATE-2' } });
    expect(k('Gate 2')).toMatchObject({ kind: 'spot', parking: { id: 'GATE-2' } });
    expect(k('fbo ramp 1')).toMatchObject({ kind: 'spot', parking: { id: 'FBO-1' } });
    expect(k('GATE')).toEqual({ kind: 'category', category: 'airline' });
    expect(k('terminal')).toEqual({ kind: 'category', category: 'airline' });
    expect(k('RAMP')).toEqual({ kind: 'category', category: 'ga' });
    expect(k('GA')).toEqual({ kind: 'category', category: 'ga' });
    expect(k('general aviation')).toEqual({ kind: 'category', category: 'ga' });
    expect(k('FBO')).toEqual({ kind: 'category', category: 'fbo' });
    expect(k('CARGO')).toEqual({ kind: 'category', category: 'cargo' });
    expect(k('FAA')).toEqual({ kind: 'category', category: 'cargo' });
    expect(k('ANG')).toEqual({ kind: 'category', category: 'military' });
    expect(k('MILITARY')).toEqual({ kind: 'category', category: 'military' });
    expect(k('PARKING')).toEqual({ kind: 'default' });
    expect(k(undefined)).toEqual({ kind: 'default' });
    expect(k('GATE9')).toEqual({ kind: 'unknown' });
    expect(k('RWY22')).toEqual({ kind: 'unknown' });
  });
});

describe('taxi to parking destinations', () => {
  it('matches by id, by id without hyphen, and by name; stores the chosen id and reads it back naturally', () => {
    const e = makeEngine({ scenario: { spawns: [A320_AT('NKS451', 'GA3'), GA_PARKED('N723EJ', 'GA1')] } });
    run(e, 10);
    const byId = taxiPark(e, 'N723EJ', { destination: 'ga2' });
    expect(destOf(byId)).toBe('GA2');
    if (byId.status === 'accepted') expect(byId.readback).toBe('Taxi to the ramp, Cessna seven two three echo juliet');
    expect(find(e, 'N723EJ').route?.nodeIds.at(-1)).toBe('GA2');

    const noHyphen = taxiPark(e, 'NKS451', { destination: 'GATE1' });
    expect(destOf(noHyphen)).toBe('GATE-1');
    if (noHyphen.status === 'accepted') expect(noHyphen.readback).toBe('Taxi to gate one, Spirit four fifty one');
    expect(find(e, 'NKS451').route?.nodeIds.at(-1)).toBe('GATE-1');

    const byName = taxiPark(e, 'NKS451', { destination: 'Gate 2', route: undefined });
    expect(destOf(byName)).toBe('GATE-2');
    run(e, 6); // outside the duplicate window
    const fbo = taxiPark(e, 'N723EJ', { destination: 'FBO Ramp 1' });
    expect(destOf(fbo)).toBe('FBO-1');
  });

  it('with only a category or no destination, picks the nearest free spot of the right category for the aircraft', () => {
    const e = makeEngine({ scenario: { spawns: [A320_AT('NKS451', 'GA3'), GA_PARKED('N723EJ', 'GA1')] } });
    run(e, 10);
    // Airline aircraft, no destination -> airline gate (nearest by taxi route).
    const jet = taxiPark(e, 'NKS451');
    expect(destOf(jet)).toBe('GATE-1');
    // "taxi to parking" for a GA aircraft stays in its own category.
    const ga = taxiPark(e, 'N723EJ', { destination: 'PARKING' });
    expect(airport.parking.find((p) => p.id === destOf(ga))?.category).toBe('ga');
    // An explicit category wins over the natural one.
    run(e, 6);
    const gaToGate = taxiPark(e, 'N723EJ', { destination: 'GATE' });
    expect(airport.parking.find((p) => p.id === destOf(gaToGate))?.category).toBe('airline');
    expect(destOf(gaToGate)).toBe('GATE-2'); // GATE-1 is already taken by NKS451's clearance
    run(e, 6);
    const fbo = taxiPark(e, 'N723EJ', { destination: 'FBO' });
    expect(destOf(fbo)).toBe('FBO-1');
    if (fbo.status === 'accepted') expect(fbo.readback).toBe('Taxi to the ramp, Cessna seven two three echo juliet');
  });

  it('prefers the category the aircraft spawned in', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED('N723EJ', 'FBO-1')] } });
    run(e, 10);
    // FBO-1 is where it started (and is not occupied by anyone else): "taxi to parking" returns it there.
    expect(destOf(taxiPark(e, 'N723EJ'))).toBe('FBO-1');
  });

  it('never chooses a spot occupied by another aircraft', () => {
    const e = makeEngine({ scenario: { spawns: [A320_AT('NKS451', 'GA3'), A320_AT('NKS452', 'GATE-1')] } });
    run(e, 10);
    const o = taxiPark(e, 'NKS451');
    expect(destOf(o)).toBe('GATE-2'); // GATE-1 holds NKS452
    // Asking for the occupied gate by name is refused with the reason.
    const explicit = taxiPark(e, 'NKS451', { destination: 'GATE1' });
    expect(explicit.status).toBe('rejected');
    if (explicit.status === 'rejected') expect(explicit.reason).toMatch(/GATE-1 is occupied by NKS452/);
  });

  it('a second aircraft sent to "a gate" does not get the spot already assigned to the first', () => {
    const e = makeEngine({ scenario: { spawns: [A320_AT('NKS451', 'GA1'), A320_AT('NKS452', 'GA2')] } });
    run(e, 10);
    expect(destOf(taxiPark(e, 'NKS451', { destination: 'GATE' }))).toBe('GATE-1');
    expect(destOf(taxiPark(e, 'NKS452', { destination: 'GATE' }))).toBe('GATE-2');
  });

  it('rejects when every spot of the requested category is taken', () => {
    const e = makeEngine({ scenario: { spawns: [A320_AT('NKS451', 'GATE-1'), A320_AT('NKS452', 'GATE-2'), GA_PARKED('N723EJ', 'GA1')] } });
    run(e, 10);
    const out = taxiPark(e, 'N723EJ', { destination: 'GATE' });
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.reason).toMatch(/No unoccupied airline parking/);
  });

  it('still rejects unknown destinations with a clear reason', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED('N723EJ', 'GA1')] } });
    run(e, 10);
    for (const dest of ['Narnia', 'GATE9']) {
      const out = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: dest }), { position: 'GND' });
      expect(out.status).toBe('rejected');
      if (out.status === 'rejected') {
        expect(out.reason).toContain(`Unknown taxi destination "${dest}"`);
        expect(out.pilotResponse).toMatch(/^Unable,/);
      }
    }
    expect(find(e, 'N723EJ').route).toBeUndefined();
    // runway destinations are unaffected
    expect(e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22', route: ['A'] }), { position: 'GND' }).status).toBe('accepted');
  });
});
