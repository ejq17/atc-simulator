import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { cmd, find, makeScenario, run, runUntil } from './__fixtures__/testHelpers';
import { createEngine } from './engine';
import { clearBearingFrom, AIR_TAXI_AGL_FT } from './rotorcraft';
import { getPerformance } from './performance';
import { dist, headingToVec } from './geo';
import type { ScenarioAircraftSpawn } from './types';

const kacy = loadKacy();
const elev = kacy.elevationFt;

const padSpawn = (callsign: string, parkingId: string, freq = 'GND'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'H65', flightRules: 'VFR', isDeparture: true, initialFrequencyId: freq, start: { kind: 'parked', parkingId },
  behavior: { kind: 'helicopter', padId: parkingId, mission: 'DEPARTURE' },
});

function engineWith(spawn: ScenarioAircraftSpawn) {
  return createEngine({
    airport: kacy, scenario: makeScenario({ spawns: [spawn], controllerPositions: ['TWR', 'GND'], playerPositions: ['TWR', 'GND'] }), readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 5, 1, 16),
  });
}

describe('MH-65 performance data', () => {
  it('uses the sourced figures: 148 kt cruise, 175 kt maximum, 44 ft 5 in, rotorcraft, hover / air taxi limits of JO 7110.65 3-11-1', () => {
    const p = getPerformance('H65');
    expect(p.cruiseSpeedKt).toBe(148);
    expect(p.maxSpeedKt).toBe(175);
    expect(p.lengthM).toBeCloseTo(13.54, 1);
    expect(p.craft).toBe('rotorcraft');
    expect(p.rotorcraft!.hoverTaxiMaxKt).toBe(20);
    expect(AIR_TAXI_AGL_FT).toBeLessThan(100);
  });
});

describe('air taxi and hover taxi geometry on the KACY helipads', () => {
  const dest = kacy.parking.find((p) => p.id === 'GA-1')!;
  const start = kacy.parking.find((p) => p.id === 'USCG-1')!;

  it('air taxi: lifted below 100 ft AGL, faster than 20 kt on a long route, hold lines respected, settles on the destination', () => {
    const e = engineWith(padSpawn('CGD61330', 'USCG-1'));
    run(e, 3);
    const out = e.applyCommand(cmd('AIR_TAXI', 'CGD61330', { destination: dest.id, taxiMode: 'air' }), { position: 'GND' });
    expect(out.status).toBe('accepted');
    let maxKt = 0;
    let maxAgl = 0;
    let onGroundWhileMoving = false;
    const ok = runUntil(e, () => {
      const a = find(e, 'CGD61330');
      maxKt = Math.max(maxKt, a.groundSpeedKt);
      maxAgl = Math.max(maxAgl, a.altitudeFt - elev);
      if (a.groundSpeedKt > 5 && a.altitudeFt - elev < 5) onGroundWhileMoving = true;
      // crossing a runway needs a crossing clearance, as for an aeroplane
      const stopped = a.route && a.groundSpeedKt < 0.2 && a.phase === 'HOLDING_SHORT';
      if (stopped) e.applyCommand(cmd('CROSS_RUNWAY', 'CGD61330', { crossRunwayId: a.route!.stopAtNodeIds.length ? kacy.taxiwayGraph.nodes[a.route!.stopAtNodeIds[0]].runwayId : undefined }), { position: 'GND' });
      return a.groundSpeedKt === 0 && !a.route && dist(a.pos, dest.pos) < 3 && Math.abs(a.altitudeFt - elev) < 0.5;
    }, 900);
    expect(ok).toBe(true);
    expect(maxKt).toBeGreaterThan(20); // air taxi "at airspeeds above 20 knots"
    expect(maxKt).toBeLessThan(40);
    expect(maxAgl).toBeLessThanOrEqual(AIR_TAXI_AGL_FT + 0.5);
    expect(maxAgl).toBeLessThan(100); // "normally below 100 feet AGL"
    expect(onGroundWhileMoving).toBe(false);
    expect(dist(start.pos, dest.pos)).toBeGreaterThan(500);
  });

  it('hover taxi: stays in ground effect (15 ft) and below 20 kt', () => {
    const e = engineWith(padSpawn('CGD61331', 'USCG-1'));
    run(e, 3);
    const dest2 = kacy.parking.find((p) => p.id === 'USCG-4')!;
    expect(e.applyCommand(cmd('AIR_TAXI', 'CGD61331', { destination: dest2.id, taxiMode: 'hover' }), { position: 'GND' }).status).toBe('accepted');
    let maxKt = 0;
    let maxAgl = 0;
    runUntil(e, () => {
      const a = find(e, 'CGD61331');
      maxKt = Math.max(maxKt, a.groundSpeedKt);
      maxAgl = Math.max(maxAgl, a.altitudeFt - elev);
      return a.groundSpeedKt === 0 && !a.route && dist(a.pos, dest2.pos) < 3;
    }, 300);
    expect(maxKt).toBeLessThan(20); // hover taxi "normally below 20 knots"
    expect(maxKt).toBeGreaterThan(3);
    expect(maxAgl).toBeCloseTo(getPerformance('H65').rotorcraft!.hoverAglFt, 0);
  });

  it('wheeled ground taxi keeps the helicopter on the surface', () => {
    const e = engineWith(padSpawn('CGD61332', 'USCG-1'));
    run(e, 3);
    e.applyCommand(cmd('TAXI_TO_PARKING', 'CGD61332', { destination: 'USCG-3' }), { position: 'GND' });
    let maxAgl = 0;
    runUntil(e, () => {
      const a = find(e, 'CGD61332');
      maxAgl = Math.max(maxAgl, a.altitudeFt - elev);
      return a.groundSpeedKt === 0 && !a.route && dist(a.pos, kacy.parking.find((p) => p.id === 'USCG-3')!.pos) < 3;
    }, 300);
    expect(maxAgl).toBeLessThan(0.5);
  });
});

describe('helicopter takeoff from present position and landing at a helipad', () => {
  it('lifts to a hover, turns on the spot to the departure heading, then climbs away', () => {
    const e = engineWith(padSpawn('CGD61333', 'USCG-2', 'TWR'));
    run(e, 5);
    expect(e.applyCommand(cmd('TAKEOFF', 'CGD61333', { headingDeg: 180, turnDirection: 'right' }), { position: 'TWR' }).status).toBe('accepted');
    const a0 = find(e, 'CGD61333');
    const pos0 = { ...a0.pos };
    let hoverSeen = false;
    let movedWhileHover = 0;
    runUntil(e, () => {
      const a = find(e, 'CGD61333');
      if (a.phase === 'CLEARED_FOR_TAKEOFF' && a.altitudeFt - elev > 14.9) {
        hoverSeen = true;
        movedWhileHover = Math.max(movedWhileHover, dist(a.pos, pos0));
      }
      return a.phase === 'DEPARTURE';
    }, 120);
    const a = find(e, 'CGD61333');
    expect(hoverSeen).toBe(true);
    expect(movedWhileHover).toBeLessThan(0.5); // no translation in the hover
    expect(a.phase).toBe('DEPARTURE');
    expect(a.altitudeFt - elev).toBeGreaterThanOrEqual(400);
    // magnetic 180 -> true 180 + variation; the track points roughly south
    const d = headingToVec(a.trackDeg);
    expect(d.y).toBeLessThan(0);
  });

  it('descends to the pad on a shallow path and lands within 1 m of it', () => {
    const pad = kacy.parking.find((p) => p.id === 'USCG-3')!;
    const spawn: ScenarioAircraftSpawn = {
      atSec: 0, callsign: 'CGD61334', type: 'H65', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
      start: { kind: 'airborne', pos: { x: pad.pos.x + 800, y: pad.pos.y - 4000 }, altitudeFt: 800, headingDeg: 0, speedKt: 90 },
      behavior: { kind: 'helicopter', padId: 'USCG-3', mission: 'ARRIVAL' },
    };
    const e = engineWith(spawn);
    run(e, 2);
    expect(e.applyCommand(cmd('LAND', 'CGD61334', { destination: 'USCG-3' }), { position: 'TWR' }).status).toBe('accepted');
    let maxDescentFpm = 0;
    const ok = runUntil(e, () => {
      const a = Object.values(e.getState().aircraft).find((x) => x.callsign === 'CGD61334');
      if (!a) return true;
      maxDescentFpm = Math.max(maxDescentFpm, -a.verticalSpeedFpm);
      return a.phase === 'ARRIVED';
    }, 400);
    expect(ok).toBe(true);
    const a = find(e, 'CGD61334');
    expect(a.onGround).toBe(true);
    expect(dist(a.pos, pad.pos)).toBeLessThan(1);
    expect(maxDescentFpm).toBeLessThanOrEqual(getPerformance('H65').descentRateFpm + 50);
  });
});

describe('hover in the air', () => {
  it('"hold position" brings an inbound helicopter to a hover at its altitude; a later landing clearance still lands it on the pad', () => {
    const pad = kacy.parking.find((p) => p.id === 'USCG-4')!;
    const spawn: ScenarioAircraftSpawn = {
      atSec: 0, callsign: 'CGD61335', type: 'H65', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
      start: { kind: 'airborne', pos: { x: pad.pos.x + 300, y: pad.pos.y - 2500 }, altitudeFt: 600, headingDeg: 0, speedKt: 100 },
      behavior: { kind: 'helicopter', padId: 'USCG-4', mission: 'ARRIVAL' },
    };
    const e = engineWith(spawn);
    run(e, 5);
    expect(e.applyCommand(cmd('HOLD_POSITION', 'CGD61335'), { position: 'TWR' }).status).toBe('accepted');
    run(e, 45);
    const a = find(e, 'CGD61335');
    expect(a.airspeedKt).toBeLessThan(0.5);
    expect(a.altitudeFt).toBeGreaterThan(590);
    const p0 = { ...a.pos };
    run(e, 10);
    expect(dist(find(e, 'CGD61335').pos, p0)).toBeLessThan(0.5); // stays put
    expect(e.applyCommand(cmd('LAND', 'CGD61335', { destination: 'USCG-4' }), { position: 'TWR' }).status).toBe('accepted');
    expect(runUntil(e, () => find(e, 'CGD61335').phase === 'ARRIVED', 400)).toBe(true);
    expect(dist(find(e, 'CGD61335').pos, pad.pos)).toBeLessThan(1);
  });
});

describe('avoiding the flow of fixed-wing traffic (AIM 4-3-17)', () => {
  it('finds a departure / arrival bearing from each KACY helipad that crosses no extended runway centreline', () => {
    for (const id of ['USCG-1', 'USCG-2', 'USCG-3', 'USCG-4']) {
      const pad = kacy.parking.find((p) => p.id === id)!;
      const brg = clearBearingFrom(kacy, pad.pos, 180);
      expect(brg, id).toBeDefined();
    }
  });
});
