import { describe, expect, it } from 'vitest';
import {
  bearingDeg, cardinal, closestPointOnSegment, distancePointToSegment, ftToM, headingDiff, headingToVec, ktToMps, magneticToTrue, mToFt,
  mToNm, mpsToKt, nmToM, normHeading, normSigned, pointInPolygon, polygonsOverlap, trueToMagnetic, vecToHeading,
} from './geo';
import { mulberry32 } from './rng';

describe('geo', () => {
  it('normalises headings', () => {
    expect(normHeading(-10)).toBe(350);
    expect(normHeading(370)).toBe(10);
    expect(normHeading(360)).toBe(0);
    expect(normSigned(190)).toBe(-170);
    expect(normSigned(-190)).toBe(170);
  });

  it('computes the shortest signed turn', () => {
    expect(headingDiff(350, 10)).toBe(20);
    expect(headingDiff(10, 350)).toBe(-20);
    expect(headingDiff(90, 270)).toBe(180);
    expect(headingDiff(0, 359)).toBe(-1);
  });

  it('converts heading <-> vector and bearings', () => {
    const v = headingToVec(90);
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(0);
    expect(vecToHeading({ x: 0, y: -1 })).toBeCloseTo(180);
    expect(bearingDeg({ x: 0, y: 0 }, { x: 100, y: 100 })).toBeCloseTo(45);
    expect(bearingDeg({ x: 0, y: 0 }, { x: -50, y: 0 })).toBeCloseTo(270);
    expect(cardinal(225)).toBe('southwest');
    expect(cardinal(359)).toBe('north');
  });

  it('converts units', () => {
    expect(nmToM(1)).toBe(1852);
    expect(mToNm(3704)).toBeCloseTo(2);
    expect(mToFt(ftToM(1000))).toBeCloseTo(1000);
    expect(mpsToKt(ktToMps(120))).toBeCloseTo(120);
    expect(ktToMps(1)).toBeCloseTo(0.514444, 5);
  });

  it('converts true <-> magnetic with east-positive variation', () => {
    // 12 W variation (-12): magnetic = true + 12
    expect(trueToMagnetic(118, -12)).toBe(130);
    expect(magneticToTrue(130, -12)).toBe(118);
    expect(trueToMagnetic(5, -12)).toBe(17);
    expect(magneticToTrue(355, 10)).toBe(5); // wraps
  });

  it('tests point in polygon', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 5 }, sq)).toBe(false);
  });

  it('computes point-to-segment distances', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distancePointToSegment({ x: 5, y: 3 }, a, b)).toBeCloseTo(3);
    expect(distancePointToSegment({ x: -4, y: 3 }, a, b)).toBeCloseTo(5);
    expect(closestPointOnSegment({ x: 12, y: 1 }, a, b)).toEqual({ x: 10, y: 0 });
  });

  it('detects overlapping polygons (crossing runways)', () => {
    const a = [{ x: -100, y: -10 }, { x: 100, y: -10 }, { x: 100, y: 10 }, { x: -100, y: 10 }];
    const b = [{ x: -10, y: -100 }, { x: 10, y: -100 }, { x: 10, y: 100 }, { x: -10, y: 100 }];
    const c = [{ x: 200, y: 200 }, { x: 210, y: 200 }, { x: 210, y: 210 }, { x: 200, y: 210 }];
    expect(polygonsOverlap(a, b)).toBe(true);
    expect(polygonsOverlap(a, c)).toBe(false);
  });
});

describe('rng', () => {
  it('is deterministic per seed and in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const sa = Array.from({ length: 50 }, () => a());
    const sb = Array.from({ length: 50 }, () => b());
    const sc = Array.from({ length: 50 }, () => c());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
