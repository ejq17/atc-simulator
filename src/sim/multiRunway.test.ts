/**
 * Multi-runway operations on the synthetic fixture (src/sim/__fixtures__/multiRunwayAirport.ts): parallel runways 4,003 ft apart, a runway
 * (17/35) crossing both of them, a short unrelated runway.
 *
 * Parallel runways: a clearance on one is not held up by traffic on the other when the centrelines are at least 2,500 ft apart. FAA JO 7110.65
 * (faa.gov, read 2026-10-21): 3-9 wake-turbulence departure intervals apply to "the same runway or a parallel runway separated by less than
 * 2,500 feet" and the paragraph also gives intervals for a parallel runway 2,500 ft or more apart only "if projected flight paths will cross";
 * 5-8-3 allows simultaneous same-direction departures from parallel runways at least 2,500 ft apart with 10-15 degrees divergence (not
 * simulated: the simulator does not model the divergence rule); 3-10-4 / 3-9-8 govern INTERSECTING runways (the 17/35 crossings below). The
 * paragraph numbers of the parallel-ARRIVAL rules (simultaneous parallel approaches, chapter 5 section 9) were not read in full.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import { createMultiRunwayAirport } from './__fixtures__/multiRunwayAirport';
import { ARRIVING, cmd, find, HOLDING, makeScenario, run } from './__fixtures__/testHelpers';
import type { ExtendedEngine } from './engineExtras';
import type { CommandOutcome, ScenarioAircraftSpawn } from './types';
import { crossingRunways } from './runways';
import { planDeparture } from '../ai/world';
import { runwayLongEnoughFor } from '../game/world';

const airport = createMultiRunwayAirport();
const V = (e: SimulationEngine) => (e as ExtendedEngine).validateCommand!.bind(e);
/** The clearance would be refused as unsafe. */
const unsafe = (o: CommandOutcome): boolean => o.status === 'rejected' && o.unsafe === true;
const accepted = (o: CommandOutcome): boolean => o.status === 'accepted';

function engineWith(spawns: ScenarioAircraftSpawn[], over: { dep?: string[]; land?: string[] } = {}): SimulationEngine {
  return createEngine({
    airport, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 9, 17, 16, 0, 0),
    scenario: makeScenario({ mode: 'training', controllerPositions: ['TWR', 'GND'], activeRunways: { departing: over.dep ?? ['27L'], landing: over.land ?? ['27R'] }, spawns }),
  });
}

describe('fixture geometry', () => {
  it('has two parallel runways 4,003 ft apart, a runway crossing both, and a short unrelated runway', () => {
    const centre = (id: string) => airport.runways.find((r) => r.id === id)!.ends[0].threshold.y;
    expect(Math.abs(centre('9L/27R') - centre('9R/27L')) / 0.3048).toBeGreaterThan(2500);
    expect(crossingRunways(airport, '17/35').map((r) => r.id).sort()).toEqual(['9L/27R', '9R/27L']);
    expect(crossingRunways(airport, '9L/27R').map((r) => r.id)).toEqual(['17/35']);
    expect(crossingRunways(airport, '6/24')).toEqual([]);
    expect(airport.runways.find((r) => r.id === '6/24')!.lengthFt).toBeLessThan(2500);
  });
});

describe('parallel runways 2,500 ft or more apart do not block each other', () => {
  it('takeoff clearance on 27L is safe with an airliner on 1 nm final to 27R, and the same lander blocks a departure on 27R', () => {
    const e = engineWith([HOLDING('DEP1', 'HSE1', '27L', 'C172'), HOLDING('DEP2', 'HNE1', '27R', 'C172'), ARRIVING('ARR1', '27R', 1, 'A320', 'TWR')]);
    run(e, 2);
    expect(accepted(V(e)(cmd('TAKEOFF', 'DEP1', { runwayEnd: '27L', runwayId: '9R/27L' })))).toBe(true);
    expect(unsafe(V(e)(cmd('TAKEOFF', 'DEP2', { runwayEnd: '27R', runwayId: '9L/27R' })))).toBe(true);
  });
  it('landing clearance on 27R is safe while an aircraft is rolling for takeoff on 27L', () => {
    const e = engineWith([HOLDING('DEP1', 'HSE2', '27L', 'C172'), ARRIVING('ARR1', '27R', 2, 'A320', 'TWR')]);
    run(e, 2);
    e.applyCommand(cmd('TAKEOFF', 'DEP1', { runwayEnd: '27L', runwayId: '9R/27L' }), { position: 'TWR' });
    run(e, 24);
    expect(find(e, 'DEP1').phase).toBe('TAKEOFF_ROLL');
    expect(accepted(V(e)(cmd('LAND', 'ARR1', { runwayEnd: '27R', runwayId: '9L/27R' })))).toBe(true);
  });
});

describe('the controller decides, not the configuration', () => {
  it('a runway that is in the landing list only still accepts a takeoff clearance from the player', () => {
    const e = engineWith([HOLDING('DEP1', 'HNE2', '27R', 'C172')], { dep: ['27L'], land: ['27R'] });
    run(e, 2);
    expect(accepted(V(e)(cmd('TAKEOFF', 'DEP1', { runwayEnd: '27R', runwayId: '9L/27R' })))).toBe(true);
  });
});

describe('every runway-runway intersection is a crossing', () => {
  it('both 17/35 intersections are graph nodes on two runways and the crossing runways are found for each', () => {
    const x = Object.values(airport.taxiwayGraph.nodes).filter((n) => (n.runwayIds?.length ?? 0) >= 2);
    expect(x.map((n) => n.id).sort()).toEqual(['X1', 'X2']);
  });
  it('a takeoff on either parallel is refused while a departure is rolling on 17/35 (the northern and the southern intersection)', () => {
    for (const [hold, end, rid] of [['HNE1', '27R', '9L/27R'], ['HSE1', '27L', '9R/27L']] as const) {
      const e = engineWith([HOLDING('DEP1', hold, end, 'C172'), HOLDING('DEP2', 'A_hE', '17', 'C172')], { dep: [end, '17'] });
      run(e, 2);
      // DEP2 starts on 17/35 southbound at the taxiway A hold; put it on the runway rolling
      const d2 = find(e, 'DEP2');
      d2.pos = { x: 0, y: 900 };
      d2.headingDeg = 180;
      d2.onGround = true;
      d2.phase = 'TAKEOFF_ROLL';
      d2.groundSpeedKt = 60;
      d2.occupyingRunways = ['17/35'];
      const res = V(e)(cmd('TAKEOFF', 'DEP1', { runwayEnd: end, runwayId: rid }));
      expect(unsafe(res), `${end}: ${JSON.stringify(res)}`).toBe(true);
    }
  });
});

describe('departures follow the departing runways and their length', () => {
  it('AI Ground plans a departure to a departing runway only', () => {
    const e = engineWith([{ atSec: 0, callsign: 'N1', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: 'GA1' }, isDeparture: true, initialFrequencyId: 'GND' }]);
    run(e, 1);
    const ac = find(e, 'N1');
    for (const ends of [['27L'], ['27R'], ['9R']]) {
      const plan = planDeparture(airport, ac, ends);
      expect(plan, ends.join()).toBeDefined();
      expect(ends.map((x) => airport.runways.find((r) => r.ends.some((en) => en.id === x))!.id)).toContain(
        airport.taxiwayGraph.nodes[plan!.holdId].runwayId,
      );
    }
    const both = planDeparture(airport, ac, ['27L', '27R']);
    expect(['27L', '27R']).toContain(both!.runwayEnd);
  });
  it('the short runway is too short for an airliner and fine for a light aircraft', () => {
    expect(runwayLongEnoughFor(airport, 'A320', '6')).toBe(false);
    expect(runwayLongEnoughFor(airport, 'A320', '27R')).toBe(true);
    expect(runwayLongEnoughFor(airport, 'C172', '6')).toBe(true);
  });
});
