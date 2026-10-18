import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { cmd, find, makeScenario, runUntil } from './__fixtures__/testHelpers';
import { createEngine } from './engine';
import { followingDistanceM } from './conflicts';
import { getPerformance, isMilitaryType, patternAltitudeFt, wakeRecatCategory, srsCategory } from './performance';
import { mToNm } from './geo';
import { alongCross, findRunwayEnd } from './runways';
import { OVERHEAD_SPEED_KT } from './special';
import { createTrafficKit } from './__fixtures__/specialKit';
import type { Aircraft } from './types';

const kacy = loadKacy();

describe('F-16C data and categories', () => {
  it('RECAT G (JO 7110.126A TBL A-1 lists F16 in the Lower Large column), SRS category III, military, 49 ft 5 in', () => {
    expect(wakeRecatCategory('F16')).toBe('G');
    expect(srsCategory('F16')).toBe(3);
    expect(srsCategory('H65')).toBe(1); // all helicopters are category I (JO 7110.65 3-9-6 NOTE)
    expect(isMilitaryType('F16')).toBe(true);
    expect(getPerformance('F16').lengthM).toBeCloseTo(15.06, 1);
    expect(getPerformance('F16').serviceCeilingFt).toBe(50000);
  });
  it('turbine pattern altitude 1,500 ft AGL (AIM 4-3-3), helicopters 500 ft AGL', () => {
    expect(patternAltitudeFt(getPerformance('F16'), kacy.elevationFt)).toBeCloseTo(kacy.elevationFt + 1500, 5);
    expect(patternAltitudeFt(getPerformance('H65'), kacy.elevationFt)).toBeCloseTo(kacy.elevationFt + 500, 5);
  });
});

describe('formation flight (JO 7110.65 2-1-13: controlled as a single aircraft)', () => {
  it('a flight of two keeps a wider spacing than a single ship', () => {
    const single = { type: 'F16' } as Aircraft;
    const pair = { type: 'F16', formation: { size: 2 } } as Aircraft;
    const cess = { type: 'C172' } as Aircraft;
    expect(followingDistanceM(pair, cess)).toBeGreaterThan(followingDistanceM(single, cess));
    expect(followingDistanceM(pair, cess)).toBeCloseTo(1.5 * 2 * 15.06 + 20, 1);
  });
});

describe('overhead maneuver geometry', () => {
  it('flies the initial at pattern altitude and no more than 200 kt inside 4 nm, breaks over mid-runway into a left downwind at pattern altitude', () => {
    const kit = createTrafficKit();
    const e = createEngine({
      airport: kacy, scenario: makeScenario({ spawns: [kit.overhead('ANG24681')], controllerPositions: ['TWR', 'GND'], playerPositions: ['TWR', 'GND'] }), readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 5, 1, 16),
    });
    const g = findRunwayEnd(kacy, '13')!;
    const tpa = patternAltitudeFt(getPerformance('F16'), kacy.elevationFt);
    let initialSeen = false;
    let maxKtInside4 = 0;
    let breakAlong = -1;
    let downwindAlt = 0;
    let downwindSeen = false;
    let ranBreakCmd = false;
    runUntil(e, () => {
      const a = find(e, 'ANG24681');
      const t = e.getState().clock.timeSec;
      if (t > 5 && !ranBreakCmd) {
        ranBreakCmd = true;
        e.applyCommand(cmd('OVERHEAD', 'ANG24681', { runwayEnd: '13', runwayId: '13/31', altitudeFt: Math.round(tpa / 100) * 100, destination: 'INITIAL' }), { position: 'TWR' });
      }
      const { along, cross } = alongCross(g, a.pos);
      if (a.flags.overhead === 'INITIAL') {
        initialSeen = true;
        if (mToNm(-along) < 4) maxKtInside4 = Math.max(maxKtInside4, a.airspeedKt);
        expect(Math.abs(a.altitudeFt - Math.round(tpa / 100) * 100)).toBeLessThan(60);
      }
      if (a.flags.overhead === 'BROKE' && breakAlong < 0) breakAlong = along;
      if (a.phase === 'PATTERN' && a.flags.overhead === 'BROKE' && cross < -800 && Math.abs(a.headingDeg - ((g.headingDeg + 180) % 360)) < 20) {
        downwindSeen = true;
        downwindAlt = a.altitudeFt;
      }
      return downwindSeen;
    }, 900);
    expect(initialSeen).toBe(true);
    expect(maxKtInside4).toBeLessThanOrEqual(OVERHEAD_SPEED_KT + 5);
    expect(Math.abs(breakAlong - g.lengthM / 2)).toBeLessThan(400); // the break is over the middle of the runway
    expect(downwindSeen).toBe(true);
    expect(Math.abs(downwindAlt - tpa)).toBeLessThan(250);
  });
});
