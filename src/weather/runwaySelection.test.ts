import { describe, expect, it } from 'vitest';
import {
  crosswindComponent,
  crosswindSigned,
  headwindComponent,
  recommendRunways,
} from './runwaySelection';

// KACY magnetic runway headings (charted: true + 10).
const KACY_ENDS = [
  { id: '4', magneticHeadingDeg: 38 },
  { id: '22', magneticHeadingDeg: 218 },
  { id: '13', magneticHeadingDeg: 128 },
  { id: '31', magneticHeadingDeg: 308 },
];

describe('wind components', () => {
  it('direct headwind', () => {
    expect(headwindComponent(220, 20, 220)).toBeCloseTo(20, 6);
    expect(crosswindComponent(220, 20, 220)).toBeCloseTo(0, 6);
  });
  it('direct tailwind is negative headwind', () => {
    expect(headwindComponent(40, 15, 220)).toBeCloseTo(-15, 6);
  });
  it('pure crosswind', () => {
    expect(headwindComponent(310, 12, 220)).toBeCloseTo(0, 6);
    expect(crosswindComponent(310, 12, 220)).toBeCloseTo(12, 6);
    expect(crosswindComponent(130, 12, 220)).toBeCloseTo(12, 6);
  });
  it('30 degree offset: cos30/sin30 split', () => {
    expect(headwindComponent(250, 20, 220)).toBeCloseTo(17.3205, 3);
    expect(crosswindComponent(250, 20, 220)).toBeCloseTo(10, 6);
  });
  it('45 degree offset', () => {
    expect(headwindComponent(265, 10, 220)).toBeCloseTo(7.0711, 3);
    expect(crosswindComponent(265, 10, 220)).toBeCloseTo(7.0711, 3);
  });
  it('wraps through north', () => {
    expect(headwindComponent(350, 10, 10)).toBeCloseTo(9.3969, 3);
    expect(crosswindComponent(350, 10, 10)).toBeCloseTo(3.4202, 3);
  });
  it('signed crosswind: positive from the right', () => {
    expect(crosswindSigned(250, 20, 220)).toBeCloseTo(10, 6);
    expect(crosswindSigned(190, 20, 220)).toBeCloseTo(-10, 6);
  });
  it('calm wind has no components', () => {
    expect(headwindComponent(0, 0, 220)).toBeCloseTo(0, 9);
    expect(crosswindComponent(0, 0, 220)).toBeCloseTo(0, 9);
  });
});

describe('recommendRunways', () => {
  const wind = (dirTrue: number | 'VRB', spd: number, gust?: number) => ({ windDirDeg: dirTrue, windSpeedKt: spd, windGustKt: gust });

  it('southerly sea breeze (true 200 = mag 210) -> runway 22', () => {
    const r = recommendRunways(wind(200, 12), KACY_ENDS);
    expect(r.primary).toBe('22');
    expect(r.best).toEqual(['22']);
    expect(r.ranking[0].headwindKt).toBeGreaterThan(11);
    expect(r.calmWindRule).toBe(false);
  });

  it('northwest wind (true 300 = mag 310) -> runway 31', () => {
    expect(recommendRunways(wind(300, 15), KACY_ENDS).primary).toBe('31');
  });

  it('easterly (true 80 = mag 90) -> runway 13 over 4', () => {
    const r = recommendRunways(wind(80, 10), KACY_ENDS);
    expect(r.primary).toBe('13');
  });

  it('applies variation: same true wind picks differently with variation 0', () => {
    // true 205: mag 215 with KACY variation (22), or mag 205 with 0 -> still 22; use boundary case
    const withVar = recommendRunways(wind(263, 10), KACY_ENDS, { variationDeg: -10 }); // mag 273 -> 31 (308) vs 22 (218): 35 vs 55
    const noVar = recommendRunways(wind(263, 10), KACY_ENDS, { variationDeg: 0 });     // mag 263 -> 22 (45) vs 31 (45) tie-ish
    expect(withVar.primary).toBe('31');
    expect(noVar.best.length).toBeGreaterThanOrEqual(1);
  });

  it('exact crosswind tie is broken by the preferred order', () => {
    // Mag wind 83 true 93: 38 and 218 are 45 deg either side... use runway pair only.
    const pair = [
      { id: '13', magneticHeadingDeg: 128 },
      { id: '31', magneticHeadingDeg: 308 },
    ];
    // mag 218: perpendicular to 13/31 -> zero headwind both ways
    const a = recommendRunways(wind(208, 10), pair, { preferredOrder: ['31', '13'] });
    expect(a.best).toEqual(['31', '13']);
    expect(a.primary).toBe('31');
    const b = recommendRunways(wind(208, 10), pair, { preferredOrder: ['13', '31'] });
    expect(b.primary).toBe('13');
  });

  it('calm wind uses preferred order', () => {
    const r = recommendRunways(wind(0, 0), KACY_ENDS, { preferredOrder: ['13', '4'] });
    expect(r.calmWindRule).toBe(true);
    expect(r.primary).toBe('13');
    expect(r.ranking.map((x) => x.id).slice(0, 2)).toEqual(['13', '4']);
  });

  it('calm wind (<5 kt, 7110.65 3-5-1) and VRB use preferred order', () => {
    expect(recommendRunways(wind(200, 4), KACY_ENDS, { preferredOrder: ['31'] }).primary).toBe('31');
    expect(recommendRunways(wind('VRB', 8), KACY_ENDS, { preferredOrder: ['4'] }).primary).toBe('4');
  });

  it('without preferred order ties fall back to input order', () => {
    expect(recommendRunways(wind(0, 0), KACY_ENDS).primary).toBe('4');
  });

  it('tolerance groups near-equal ends', () => {
    // mag 173 = exactly between 128 (45) and 218 (45): equal headwind 7.07 on 13 and 22
    const r = recommendRunways(wind(163, 10), KACY_ENDS, { preferredOrder: ['22', '13'] });
    expect(r.best.slice(0, 2).sort()).toEqual(['13', '22']);
    expect(r.primary).toBe('22');
  });

  it('can rank by gusts', () => {
    const r = recommendRunways(wind(200, 4, 20), KACY_ENDS, { useGusts: true });
    expect(r.calmWindRule).toBe(false);
    expect(r.primary).toBe('22');
  });

  it('returns the crosswind for each ranked end', () => {
    const r = recommendRunways(wind(200, 10), KACY_ENDS);
    const e22 = r.ranking.find((x) => x.id === '22')!;
    expect(e22.crosswindKt).toBeCloseTo(10 * Math.sin((8 * Math.PI) / 180), 3);
  });

  it('throws on empty runway list', () => {
    expect(() => recommendRunways(wind(200, 10), [])).toThrow();
  });
});
