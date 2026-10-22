/**
 * Positions that share a frequency (KPGD Clearance Delivery and Ground, 119.55). A radio call is routed by the position the aircraft needs
 * (radio/frequencies.ts aircraftPosition), not by the first row of the airport data that owns the frequency, so both orders of the rows work.
 */
import { describe, expect, it } from 'vitest';
import { aircraftPosition, positionsOnFrequency } from '../radio/frequencies';
import type { Aircraft, Airport } from '../sim/types';
import { positionFor, aiPositionOf } from '../ui/commands/transmit';
import { createHarness, IFR_ARR, IFR_DEP, kacy } from './testkit';

/** KACY with Ground moved onto the Clearance Delivery frequency; `gndFirst` swaps the order of the two rows. */
function sharedAirport(gndFirst: boolean): Airport {
  const clnc = kacy.frequencies.find((f) => f.position === 'CLNC')!;
  const gnd = { ...kacy.frequencies.find((f) => f.position === 'GND')!, mhz: clnc.mhz };
  const rest = kacy.frequencies.filter((f) => f.position !== 'CLNC' && f.position !== 'GND');
  return { ...kacy, frequencies: [...(gndFirst ? [gnd, clnc] : [clnc, gnd]), ...rest] };
}

const acOf = (over: Partial<Aircraft>, airport: Airport): Aircraft => ({
  frequencyMhz: airport.frequencies.find((f) => f.position === 'CLNC')!.mhz, onGround: true, isDeparture: false, phase: 'ROLLOUT', ...over,
} as Aircraft);

describe.each([[false], [true]])('CLNC and GND share a frequency (GND listed first: %s)', (gndFirst) => {
  const airport = sharedAirport(gndFirst);

  it('routes a call by the position the aircraft needs', () => {
    expect(positionsOnFrequency(airport, airport.frequencies.find((f) => f.position === 'CLNC')!.mhz).sort()).toEqual(['CLNC', 'GND']);
    const ifr = { flightRules: 'IFR' } as Aircraft['flightPlan'];
    expect(aircraftPosition(airport, acOf({ phase: 'PARKED', isDeparture: true, flightPlan: ifr }, airport))).toBe('CLNC');
    expect(aircraftPosition(airport, acOf({ phase: 'PARKED', isDeparture: true, flightPlan: { ...ifr!, ifrClearance: {} } as Aircraft['flightPlan'] }, airport))).toBe('GND');
    expect(aircraftPosition(airport, acOf({ phase: 'RUNWAY_EXIT' }, airport))).toBe('GND');
    expect(aircraftPosition(airport, acOf({ phase: 'ROLLOUT', frequencyId: 'GND' }, airport))).toBe('GND');
    expect(aircraftPosition(airport, acOf({ phase: 'TAXI_TO_PARKING' }, airport))).toBe('GND');
  });

  it('a player working both (or either) of them transmits as the position the aircraft needs; an AI one is named the same way', () => {
    const state = { airport, controllerPosition: 'GND' } as never;
    const landed = acOf({ phase: 'RUNWAY_EXIT' }, airport);
    const parked = acOf({ phase: 'PARKED', isDeparture: true, flightPlan: { flightRules: 'IFR' } as Aircraft['flightPlan'] }, airport);
    expect(positionFor(state, { positions: ['CLNC', 'GND'] }, landed)).toBe('GND');
    expect(positionFor(state, { positions: ['CLNC', 'GND'] }, parked)).toBe('CLNC');
    expect(positionFor(state, { positions: ['GND', 'CLNC'] }, parked)).toBe('CLNC');
    expect(aiPositionOf(state, { positions: ['TWR'], aiPositions: ['CLNC', 'GND'] }, landed)?.position).toBe('GND');
    expect(aiPositionOf(state, { positions: ['TWR'], aiPositions: ['CLNC', 'GND'] }, parked)?.position).toBe('CLNC');
    expect(aiPositionOf(state, { positions: ['GND'], aiPositions: ['CLNC'] }, parked)).toBeUndefined(); // the player hears the shared frequency
  });

  it('AI Clearance and AI Ground each answer their own calls: the IFR departure is cleared, taxis and departs; the landed arrival is taxied to parking', () => {
    const h = createHarness({
      airport, player: [],
      spawns: [IFR_DEP('NKS451', 'GATE-1'), IFR_ARR('AAL212', 'CARYL', ['CARYL', 'MAYBN'], '13', 3000, { atSec: 100 })],
    });
    h.runUntil(() => h.now() > 300 && Object.values(h.engine.getState().aircraft).length === 0, 3000);
    expect(h.atc('CLNC').some((e) => /cleared to/i.test(e.text))).toBe(true);
    expect(h.pilotTexts('NKS451').join('\n')).toMatch(/Ground/);
    expect(h.pilotTexts('AAL212').join('\n')).toMatch(/request taxi to parking/);
    expect(h.atc('GND').some((e) => /AAL212|American two twelve/i.test(e.text) || e.callsign === 'AAL212')).toBe(true);
    expect(Object.values(h.engine.getState().aircraft)).toHaveLength(0);
    expect(h.atc('GND').some((e) => /taxi to gate/i.test(e.text) && e.callsign === 'AAL212')).toBe(true);
  });
});
