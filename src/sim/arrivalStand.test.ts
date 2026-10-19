/**
 * An arrival's own parking stand (parkingResolver.refreshArrivalStands): assigned while inbound, used by the exit prediction (exitChoice.arrivalParkingTargets)
 * and by AI Ground's taxi-in (ai/world.planParking), re-resolved when the stand is taken.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { Airport, ParkingPosition } from './types';
import { loadKacy } from '../airport';
import { ARRIVING, GA_PARKED, cmd, find, makeScenario, run } from './__fixtures__/testHelpers';
import { CROSSING_COST_M, arrivalParkingTargets, holdToParking } from './exitChoice';
import { findRunwayEnd } from './runways';
import { rolloutExitOptions } from './flightDynamics';
import { getPerformance } from './performance';
import { ktToMps } from './geo';
import { planParking } from '../ai/world';

const kacy = loadKacy();

function world(airport: Airport, rwy: string, spawns: ReturnType<typeof ARRIVING>[]): SimulationEngine {
  return createEngine({ airport, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [rwy], landing: [rwy] }, spawns }) });
}
const standOf = (e: SimulationEngine, cs: string): ParkingPosition | undefined => {
  const id = find(e, cs).assignedStand?.parkingId;
  return kacy.parking.find((p) => p.id === id);
};

describe('an arrival is bound for a stand of its category', () => {
  it('a Caravan on a cargo flight is bound for the cargo apron, and the exit prediction and Ground use that stand', () => {
    const e = world(kacy, '13', [{ ...ARRIVING('WIG123', '13', 6, 'C208'), parkingCategory: 'cargo' }]);
    run(e, 2);
    const stand = standOf(e, 'WIG123')!;
    expect(stand.category).toBe('cargo');
    expect(arrivalParkingTargets(e.getState(), find(e, 'WIG123')).map((p) => p.id)).toEqual([stand.id]);
    // without the intent the same Caravan is bound for the GA ramp (the type's natural category)
    const ga = world(kacy, '13', [ARRIVING('N723EJ', '13', 6, 'C208')]);
    run(ga, 2);
    expect(['ga', 'fbo']).toContain(standOf(ga, 'N723EJ')!.category);
  });

  it('an A320 is bound for a gate on every KACY runway end: the one with the shortest taxi from the nearest exit it can make', () => {
    for (const end of ['13', '31', '4', '22']) {
      const e = world(kacy, end, [ARRIVING('NKS451', end, 6, 'A320')]);
      run(e, 2);
      const st = e.getState();
      const stand = standOf(e, 'NKS451')!;
      expect(stand.category).toBe('airline');
      const g = findRunwayEnd(kacy, end)!;
      const holds = [...new Set(rolloutExitOptions(st, { ...find(e, 'NKS451'), assignedStand: undefined }, g, g.displacedM + 490, ktToMps(getPerformance('A320').touchdownSpeedKt)).map((o) => o.holdNodeId))];
      const cost = (p: ParkingPosition) => Math.min(...holds.map((h) => { const w = holdToParking(st, h, [p]); return w.taxiM + w.crossings * CROSSING_COST_M; }));
      for (const other of kacy.parking.filter((p) => p.category === 'airline')) expect(cost(stand)).toBeLessThanOrEqual(cost(other) + 1e-6);
      expect(arrivalParkingTargets(st, find(e, 'NKS451')).map((p) => p.id)).toEqual([stand.id]);
    }
  });

  it('two arrivals are not bound for the same stand', () => {
    const e = world(kacy, '13', [ARRIVING('NKS451', '13', 6, 'A320'), ARRIVING('NKS452', '13', 9, 'A320')]);
    run(e, 2);
    expect(standOf(e, 'NKS451')!.id).not.toBe(standOf(e, 'NKS452')!.id);
  });

  it('a stand that something else takes is re-resolved', () => {
    const e = world(kacy, '13', [ARRIVING('NKS451', '13', 6, 'A320')]);
    run(e, 2);
    const first = standOf(e, 'NKS451')!;
    const st = e.getState();
    // another aircraft stands on that stand
    const blocker = Object.values(st.aircraft).find((a) => a.callsign === 'NKS451')!;
    expect(blocker.assignedStand?.parkingId).toBe(first.id);
    const e2 = world(kacy, '13', [ARRIVING('NKS451', '13', 6, 'A320'), GA_PARKED('N723EJ', first.id, 'GND', { isDeparture: false })]);
    run(e2, 2);
    const second = standOf(e2, 'NKS451')!;
    expect(second.id).not.toBe(first.id);
    expect(second.category).toBe('airline');
  });

  it('AI Ground taxis the landed arrival to its stand', () => {
    const e = world(kacy, '13', [ARRIVING('NKS451', '13', 2, 'A320')]);
    e.applyCommand(cmd('LAND', 'NKS451', { runwayEnd: '13' }), { position: 'TWR' });
    for (let t = 0; t < 400 && find(e, 'NKS451').phase !== 'RUNWAY_EXIT'; t++) run(e, 1);
    const ac = find(e, 'NKS451');
    expect(ac.phase).toBe('RUNWAY_EXIT');
    const plan = planParking(e.getState(), ac)!;
    expect(plan.spot.id).toBe(ac.assignedStand!.parkingId);
  });
});
