import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { cmd, find, makeScenario, run, runUntil } from './__fixtures__/testHelpers';
import { createEngine } from './engine';
import { assessClearanceSafety } from './conflicts';
import { runwayRun } from './vehicles';
import { getPerformance } from './performance';
import type { ScenarioAircraftSpawn } from './types';

const kacy = loadKacy();

const veh = (callsign: string, parkingId: string, task: 'RUNWAY_INSPECTION' | 'PAVEMENT_INSPECTION' | 'ERRAND' = 'RUNWAY_INSPECTION', runwayId = '13/31'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'VEH', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'GND', start: { kind: 'parked', parkingId }, behavior: { kind: 'vehicle', task, runwayId },
});

function engineWith(spawns: ScenarioAircraftSpawn[], mode: 'free_play' | 'training' = 'training') {
  return createEngine({
    airport: kacy, scenario: makeScenario({ spawns, mode, controllerPositions: ['TWR', 'GND'], playerPositions: ['TWR', 'GND'] }), readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 5, 1, 16),
  });
}

describe('airport vehicle on the taxiway graph', () => {
  it('moves at its own taxi speed, never faster', () => {
    const e = engineWith([veh('APT21', 'FAA-1')]);
    run(e, 2);
    expect(e.applyCommand(cmd('TAXI', 'APT21', { destination: 'RWY13', runwayEnd: '13', route: ['K', 'B'] }), { position: 'GND' }).status).toBe('accepted');
    let maxKt = 0;
    run(e, 40);
    runUntil(e, () => { maxKt = Math.max(maxKt, find(e, 'APT21').groundSpeedKt); return false; }, 60);
    expect(maxKt).toBeGreaterThan(8);
    expect(maxKt).toBeLessThanOrEqual(getPerformance('VEH').taxiSpeedKt + 0.5);
  });

  it('stops at the hold line of a runway it has not been cleared onto (no incursion)', () => {
    const e = engineWith([veh('APT21', 'FAA-1')]);
    run(e, 2);
    e.applyCommand(cmd('TAXI', 'APT21', { destination: 'RWY13', runwayEnd: '13' }), { position: 'GND' });
    run(e, 400);
    const a = find(e, 'APT21');
    expect(a.occupyingRunways).toEqual([]);
    expect(e.getState().events.some((x) => x.kind === 'RUNWAY_INCURSION')).toBe(false);
  });

  it('a vehicle on a runway without a clearance is a runway incursion', () => {
    const e = engineWith([veh('APT21', 'FAA-1')]);
    run(e, 2);
    const a = find(e, 'APT21');
    const rw = kacy.runways.find((r) => r.id === '13/31')!;
    const mid = { x: (rw.ends[0].threshold.x + rw.ends[1].threshold.x) / 2, y: (rw.ends[0].threshold.y + rw.ends[1].threshold.y) / 2 };
    a.pos = mid; // placed on the runway as if it had driven through the hold line
    run(e, 3);
    expect(e.getState().runwayOccupancy['13/31'].occupants).toContain(a.id);
    expect(e.getState().conflicts.some((c) => c.kind === 'RUNWAY_INCURSION' && c.aircraftIds.includes(a.id))).toBe(true);
  });
});

describe('PROCEED onto a runway (JO 7110.65 3-1-3, 3-7-2)', () => {
  function atHold(callsign = 'APT21') {
    const e = engineWith([veh(callsign, 'FAA-1', 'RUNWAY_INSPECTION')]);
    run(e, 2);
    expect(e.applyCommand(cmd('TAXI', callsign, { destination: 'RWY13', runwayEnd: '13', route: ['J', 'B'] }), { position: 'GND' }).status).toBe('accepted');
    const ok = runUntil(e, () => {
      const a = find(e, callsign);
      const node = a.route && a.route.progressIndex < a.route.nodeIds.length && a.groundSpeedKt < 0.1 ? kacy.taxiwayGraph.nodes[a.route.nodeIds[Math.max(0, a.route.progressIndex - 1)]] : undefined;
      // walk across the runways on the way (Ground's crossing clearances), stop at the hold of the inspection runway
      if (node?.kind === 'holding_position' && node.runwayId && node.runwayId !== '13/31') e.applyCommand(cmd('CROSS_RUNWAY', callsign, { crossRunwayId: node.runwayId, runwayId: node.runwayId }), { position: 'GND' });
      return a.phase === 'HOLDING_SHORT' && a.groundSpeedKt < 0.1 && (!a.route || a.route.progressIndex >= a.route.nodeIds.length);
    }, 1200);
    expect(ok).toBe(true);
    expect(e.applyCommand(cmd('CONTACT_FREQUENCY', callsign, { frequencyId: 'TWR' }), { position: 'GND' }).status).toBe('accepted');
    run(e, 15);
    return e;
  }

  it('drives the whole runway from the hold, occupies it, authorises the intersecting runway, and ends beside the runway', () => {
    const e = atHold();
    const out = e.applyCommand(cmd('PROCEED', 'APT21', { runwayEnd: '13', runwayId: '13/31', reportClear: true }), { position: 'TWR' });
    expect(out, JSON.stringify(out)).toMatchObject({ status: 'accepted' });
    const a = find(e, 'APT21');
    expect(a.runwayAuthorizations).toContain('13/31');
    expect(a.runwayAuthorizations).toContain('4/22'); // 3-7-2: may cross the intersecting runway
    let occupied = false;
    let maxAlong = 0;
    const ok = runUntil(e, () => {
      const v = find(e, 'APT21');
      if (v.occupyingRunways.includes('13/31')) occupied = true;
      maxAlong = Math.max(maxAlong, Math.hypot(v.pos.x - kacy.runways[1].ends[0].threshold.x, v.pos.y - kacy.runways[1].ends[0].threshold.y));
      return occupied && v.occupyingRunways.length === 0 && v.groundSpeedKt < 0.1;
    }, 900);
    expect(ok).toBe(true);
    expect(maxAlong).toBeGreaterThan(2500); // most of the 3,050 m runway
    expect(e.getState().events.some((x) => x.kind === 'RUNWAY_INCURSION')).toBe(false);
  });

  it('is refused while an aircraft is on the runway or an arrival is on a 6 nm final', () => {
    const e = atHold();
    const rw = kacy.runways.find((r) => r.id === '13/31')!;
    const g = rw.ends.find((x) => x.id === '13')!;
    // an arrival on 6 nm final
    e.spawnAircraft({ atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 1500, headingDeg: g.trueHeadingDeg, speedKt: 90, runwayEnd: '13', distanceNm: 6 } });
    const c = cmd('PROCEED', 'APT21', { runwayEnd: '13', runwayId: '13/31' });
    const sa = assessClearanceSafety(e.getState(), c);
    expect(sa.safe).toBe(false);
    expect(sa.issues[0].text).toMatch(/landing|pattern/);
    const out = e.applyCommand(c, { position: 'TWR' }); // training mode: refused
    expect(out.status).toBe('rejected');
  });

  it('is refused for a vehicle that is not holding short of that runway, and for an aircraft ("proceed" is the vehicle verb)', () => {
    const e = engineWith([veh('APT21', 'FAA-1'), { atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR', start: { kind: 'parked', parkingId: 'GA-1' } }]);
    run(e, 2);
    expect(e.applyCommand(cmd('PROCEED', 'APT21', { runwayEnd: '13', runwayId: '13/31' }), { position: 'TWR' }).status).toBe('rejected');
    expect(e.applyCommand(cmd('PROCEED', 'N723EJ', { runwayEnd: '13', runwayId: '13/31' }), { position: 'TWR' }).status).toBe('rejected');
  });

  it('works on a closed runway (a vehicle needs a clearance for a closed runway too, 3-7-2 NOTE)', () => {
    const e = atHold();
    expect(e.addClosure?.({ kind: 'RUNWAY', ident: '13/31', reason: 'runway inspection by airport operations' }).ok).toBe(true);
    expect(e.applyCommand(cmd('PROCEED', 'APT21', { runwayEnd: '13', runwayId: '13/31' }), { position: 'TWR' }).status).toBe('accepted');
  });

  it('runwayRun gives a continuous node list from every KACY runway hold to the far exit', () => {
    for (const hold of ['HP13-31-A-1', 'HP13-31-B-2', 'HP4-22-A-2', 'HP4-22-B-1']) {
      const h = kacy.taxiwayGraph.nodes[hold];
      const ends = kacy.runways.find((r) => r.id === h.runwayId)!.ends.map((x) => x.id);
      expect(ends.some((end) => runwayRun(kacy, h, end) !== undefined), hold).toBe(true);
    }
  });
});

describe('pavement inspection tour', () => {
  it('visits taxiways without touching a runway and returns to its parking position', () => {
    const e = engineWith([veh('APT33', 'FAA-2', 'PAVEMENT_INSPECTION')]);
    run(e, 2);
    expect(e.applyCommand(cmd('PROCEED', 'APT33', { destination: 'TAXIWAYS' }), { position: 'GND' }).status).toBe('accepted');
    let onRunway = false;
    const ok = runUntil(e, () => {
      const a = find(e, 'APT33');
      if (a.occupyingRunways.length) onRunway = true;
      return a.phase === 'PARKED' && a.groundSpeedKt === 0 && !a.route;
    }, 1500);
    expect(ok).toBe(true);
    expect(onRunway).toBe(false);
  });
});
