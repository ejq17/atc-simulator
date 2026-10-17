import { describe, expect, it } from 'vitest';
import facility from '../../data/sources/kacy-facility.json';
import { angleDiffDeg, bearingDeg, createProjection, magneticToTrue, normalizeDeg, trueToMagnetic } from './projection';

const FT_TO_M = 0.3048;
const arp = { lat: facility.airport.arp.lat, lon: facility.airport.arp.lon };
const proj = createProjection(arp);
const rwy = (id: string) => facility.runways.find((r) => r.id === id)!;
const thr = (runwayId: string, i: number) => {
  const t = rwy(runwayId).ends[i].threshold;
  return { lat: t.lat, lon: t.lon };
};

describe('projection', () => {
  it('maps the ARP to the local origin and round-trips', () => {
    const o = proj.toLocal(arp);
    expect(o.x).toBeCloseTo(0, 9);
    expect(o.y).toBeCloseTo(0, 9);
    const p = { lat: 39.4651, lon: -74.5602 };
    const back = proj.toLatLon(proj.toLocal(p));
    expect(back.lat).toBeCloseTo(p.lat, 9);
    expect(back.lon).toBeCloseTo(p.lon, 9);
  });

  it('x is east and y is north with cos(lat0) longitude scaling', () => {
    const north = proj.toLocal({ lat: arp.lat + 0.001, lon: arp.lon });
    const east = proj.toLocal({ lat: arp.lat, lon: arp.lon + 0.001 });
    expect(north.x).toBeCloseTo(0, 6);
    expect(north.y).toBeGreaterThan(110);
    expect(north.y).toBeLessThan(112);
    expect(east.y).toBeCloseTo(0, 6);
    expect(east.x / north.y).toBeCloseTo(Math.cos((arp.lat * Math.PI) / 180), 2);
  });

  it('runway 13 threshold to 31 threshold is ~10001 ft within 0.5%', () => {
    const a = proj.toLocal(thr('13/31', 0));
    const b = proj.toLocal(thr('13/31', 1));
    const lenM = Math.hypot(a.x - b.x, a.y - b.y);
    const nasrM = rwy('13/31').length_ft * FT_TO_M;
    expect(nasrM).toBeCloseTo(3048.3, 0);
    expect(Math.abs(lenM - nasrM) / nasrM).toBeLessThan(0.005);
  });

  it('runway 04 threshold to 22 threshold is ~6145 ft within 0.5%', () => {
    const a = proj.toLocal(thr('04/22', 0));
    const b = proj.toLocal(thr('04/22', 1));
    const lenM = Math.hypot(a.x - b.x, a.y - b.y);
    const nasrM = rwy('04/22').length_ft * FT_TO_M;
    expect(Math.abs(lenM - nasrM) / nasrM).toBeLessThan(0.005);
  });

  it('local bearings agree with NASR true alignment within 1 degree', () => {
    for (const id of ['04/22', '13/31']) {
      const [e0, e1] = rwy(id).ends;
      const a = proj.toLocal({ lat: e0.threshold.lat, lon: e0.threshold.lon });
      const b = proj.toLocal({ lat: e1.threshold.lat, lon: e1.threshold.lon });
      expect(angleDiffDeg(bearingDeg(b.x - a.x, b.y - a.y), e0.true_alignment_deg!)).toBeLessThan(1);
      expect(angleDiffDeg(bearingDeg(a.x - b.x, a.y - b.y), e1.true_alignment_deg!)).toBeLessThan(1);
    }
  });
});

describe('magnetic variation (east-positive)', () => {
  const var10W = facility.airport.magnetic_variation.hemisphere === 'W' ? -facility.airport.magnetic_variation.deg : facility.airport.magnetic_variation.deg;

  it('KACY NASR variation is 10 W => -10', () => {
    expect(var10W).toBe(-10);
  });

  it('true 118 is magnetic 128 at KACY, and back', () => {
    expect(trueToMagnetic(118, var10W)).toBe(128);
    expect(magneticToTrue(128, var10W)).toBe(118);
    expect(trueToMagnetic(298, var10W)).toBe(308);
  });

  it('wraps around north and handles east variation', () => {
    expect(trueToMagnetic(355, -10)).toBe(5);
    expect(magneticToTrue(5, -10)).toBe(355);
    expect(trueToMagnetic(100, 5)).toBe(95);
    expect(normalizeDeg(-30)).toBe(330);
    expect(normalizeDeg(360)).toBe(0);
    expect(angleDiffDeg(350, 10)).toBe(20);
  });
});
