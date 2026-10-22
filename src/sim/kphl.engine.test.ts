/**
 * Engine smoke test on the real KPHL dataset (four runways, runway-runway crossing, parallel runways): an A320 is taxied from a terminal
 * gate to the runway 27L hold across the 9L/27R runway (every runway crossing is cleared one at a time) and flown out; an A320 lands on 27R and
 * taxis to a gate; a departure and an arrival on the two parallel runways do not interfere. No incursion or conflict.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { loadKphl } from '../airport';
import { cmd, find, has, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import type { ScenarioAircraftSpawn } from './types';

const kphl = loadKphl();

const PARKED = (callsign: string, parkingId: string, type = 'A320'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type, flightRules: 'IFR', start: { kind: 'parked', parkingId }, isDeparture: true, initialFrequencyId: 'GND',
});
const ARR = (callsign: string, runwayEnd: string, distanceNm: number, type = 'A320'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type, flightRules: 'IFR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 150, runwayEnd, distanceNm },
  isDeparture: false, initialFrequencyId: 'TWR',
});

function setup(spawns: ScenarioAircraftSpawn[], dep = ['27L'], land = ['27R']) {
  return createEngine({
    airport: kphl,
    readbackErrorRate: 0,
    scenario: makeScenario({ activeRunways: { departing: dep, landing: land }, controllerPositions: ['TWR', 'GND'], spawns }),
  });
}

/** Taxi to the runway end hold, clearing every runway crossing on the way (the first hold on the route is the 9L/27R crossing). */
function taxiToHold(e: ReturnType<typeof setup>, cs: string, runwayEnd: string): number {
  const ac = find(e, cs);
  expect(say(e, cmd('TAXI', cs, { runwayEnd }), 'GND').status).toBe('accepted');
  let crossings = 0;
  for (let guard = 0; guard < 6; guard++) {
    expect(runUntil(e, () => ac.phase === 'HOLDING_SHORT', 1500)).toBe(true);
    if (ac.pendingRequest?.kind !== 'CROSSING' && !runUntil(e, () => ac.pendingRequest?.kind === 'CROSSING' || ac.route === undefined, 5)) break;
    if (ac.pendingRequest?.kind !== 'CROSSING') break;
    const runwayId = (ac.pendingRequest as { runwayId?: string }).runwayId ?? '9L/27R';
    expect(say(e, cmd('CROSS_RUNWAY', cs, { crossRunwayId: runwayId }), 'GND').status).toBe('accepted');
    crossings++;
    expect(runUntil(e, () => ac.phase === 'TAXIING', 30)).toBe(true);
  }
  return crossings;
}

describe('KPHL engine smoke', () => {
  it('departure: A320 from a terminal gate crosses 9L/27R, holds short of 27L, takes off and climbs out', () => {
    const e = setup([PARKED('AAL212', 'GATE-B5')]);
    const ac = find(e, 'AAL212');
    const crossings = taxiToHold(e, 'AAL212', '27L');
    expect(crossings).toBeGreaterThanOrEqual(1);
    expect(ac.route!.nodeIds.at(-1)).toMatch(/^HP9R-27L-/);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'AAL212', { frequencyId: 'TWR' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'DEPARTURE', 60)).toBe(true);
    expect(pilotTexts(e, 'AAL212').some((t) => t.startsWith('Philadelphia Tower, American two twelve, holding short runway two seven left, ready for departure'))).toBe(true);
    expect(say(e, cmd('TAKEOFF', 'AAL212', { runwayEnd: '27L' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'TAKEOFF_ROLL', 120)).toBe(true);
    expect(runUntil(e, () => ac.phase === 'DEPARTURE' && ac.altitudeFt > e.getState().airport.elevationFt + 500, 300)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });

  it('arrival: A320 cleared to land on 27R rolls out, exits and taxis to a gate', () => {
    const e = setup([ARR('NKS451', '27R', 6)]);
    const ac = find(e, 'NKS451');
    expect(say(e, cmd('LAND', 'NKS451', { runwayEnd: '27R' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'ROLLOUT', 900)).toBe(true);
    expect(runUntil(e, () => ac.phase === 'RUNWAY_EXIT', 240)).toBe(true);
    expect(runUntil(e, () => ac.occupyingRunways.length === 0 && ac.groundSpeedKt < 0.5, 300)).toBe(true);
    expect(runUntil(e, () => pilotTexts(e, 'NKS451').some((t) => t.startsWith('Philadelphia Tower, Spirit four fifty one, clear of runway two seven right at ')), 60)).toBe(true);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'GND' }), 'TWR').status).toBe('accepted');
    run(e, 30);
    expect(say(e, cmd('TAXI', 'NKS451', { destination: 'GATE-C20' }), 'GND').status).toBe('accepted');
    // the exit chosen by the engine may be on the south side: the runway just vacated is then crossed back (a Ground clearance per crossing)
    for (let guard = 0; guard < 6 && has(e, 'NKS451') && ac.phase !== 'PARKED'; guard++) {
      runUntil(e, () => ac.phase === 'PARKED' || ac.pendingRequest?.kind === 'CROSSING', 1500);
      if (ac.pendingRequest?.kind === 'CROSSING') {
        expect(say(e, cmd('CROSS_RUNWAY', 'NKS451', { crossRunwayId: '9L/27R' }), 'GND').status).toBe('accepted');
        expect(runUntil(e, () => ac.phase === 'TAXI_TO_PARKING' && ac.pendingRequest === undefined, 60)).toBe(true);
      }
    }
    expect(ac.phase === 'PARKED' || !has(e, 'NKS451')).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });

  it('the two parallel runways work independently: an arrival on 27R lands while a departure rolls on 27L', () => {
    const dep: ScenarioAircraftSpawn = { atSec: 0, callsign: 'AAL330', type: 'A320', flightRules: 'IFR', start: { kind: 'holding_short', nodeId: '', runwayEnd: '27L' }, isDeparture: true, initialFrequencyId: 'TWR' };
    const hold = Object.values(kphl.taxiwayGraph.nodes).find((n) => n.kind === 'holding_position' && n.id.startsWith('HP9R-27L-') && (n as { protectsRunwayEnd?: string }).protectsRunwayEnd === '27L');
    expect(hold).toBeDefined();
    dep.start = { kind: 'holding_short', nodeId: hold!.id, runwayEnd: '27L' };
    const e = setup([dep, { ...ARR('NKS451', '27R', 7), atSec: 0 }]);
    const d = find(e, 'AAL330');
    const a = find(e, 'NKS451');
    expect(say(e, cmd('TAKEOFF', 'AAL330', { runwayEnd: '27L' }), 'TWR').status).toBe('accepted');
    expect(say(e, cmd('LAND', 'NKS451', { runwayEnd: '27R' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => d.phase === 'TAKEOFF_ROLL' || d.phase === 'DEPARTURE', 120)).toBe(true);
    expect(runUntil(e, () => a.phase === 'ROLLOUT', 900)).toBe(true);
    expect(runUntil(e, () => a.phase === 'RUNWAY_EXIT' && a.occupyingRunways.length === 0, 400)).toBe(true);
    expect(e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT')).toEqual([]);
  });
});

describe('KPHL in the UI layer', () => {
  it('the ATIS names the airport from the data', async () => {
    const { makeAtis } = await import('../ui/store/session');
    const e = setup([]);
    const st = e.getState();
    const atis = makeAtis(st, 'A', Date.UTC(2026, 9, 21, 14, 0, 0));
    expect(atis.text).toMatch(/^Philadelphia (International )?[Aa]irport information alpha/i);
    expect(atis.text).not.toMatch(/Atlantic City|Manchester/);
    expect(atis.simulatedLabel).toMatch(/KPHL/);
  });
});
