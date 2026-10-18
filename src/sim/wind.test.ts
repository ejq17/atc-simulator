/** Gust model and wind components (src/sim/wind.ts): determinism, bounded excursions, zero without a gust, components, limits. */
import { describe, expect, it } from 'vitest';
import { effectiveComponents, GUST_DIR_DEG_PER_KT, GUST_DIR_MAX_DEG, GUST_LULL_FRACTION, componentsOfVector, exceedsLimits, gustSpreadKt, newGustState, runwayEndWinds, stepGust, windComponents, windVector } from './wind';
import { mpsToKt } from './geo';
import type { Weather } from './types';

const wx = (over: Partial<Weather>): Weather => ({
  source: 'simulated', windDirDeg: 280, windSpeedKt: 12, visibilitySm: 10, clouds: [], temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR', ...over,
});

function series(w: Weather, seed: number, id: string, n: number): { speedKt: number; devDeg: number; devKt: number }[] {
  const g = newGustState(seed, id, w);
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = stepGust(g, w, 0.1);
    out.push({ speedKt: mpsToKt(Math.hypot(v.x, v.y)), devDeg: g.devDeg, devKt: g.devKt });
  }
  return out;
}

describe('gust model', () => {
  it('without a gust (absent, equal to the speed, calm or variable) the wind is exactly the steady wind and no random number is drawn', () => {
    for (const w of [wx({}), wx({ windGustKt: 12 }), wx({ windSpeedKt: 0, windGustKt: 5 }), wx({ windDirDeg: 'VRB', windGustKt: 25 })]) {
      expect(gustSpreadKt(w)).toBe(0);
      const g = newGustState(7, 'A1', w);
      const twin = newGustState(7, 'A1', w);
      for (let i = 0; i < 200; i++) {
        const v = stepGust(g, w, 0.1);
        const s = windVector(w);
        expect(v.x).toBe(s.x);
        expect(v.y).toBe(s.y);
        expect(g.dev).toEqual({ x: 0, y: 0 });
      }
      // the generator is untouched: the next draw equals the twin's next draw
      expect(g.rng()).toBe(twin.rng());
    }
  });

  it('is deterministic per (seed, aircraft id) and independent of other aircraft', () => {
    const w = wx({ windGustKt: 26 });
    const a = series(w, 42, 'AC1', 3000);
    expect(series(w, 42, 'AC1', 3000)).toEqual(a);
    expect(series(w, 42, 'AC2', 3000)).not.toEqual(a);
    expect(series(w, 43, 'AC1', 3000)).not.toEqual(a);
  });

  it('keeps every excursion inside the METAR gust spread: peaks never exceed the gust, lulls stay above mean - 0.5 x spread, direction within 2 sigma', () => {
    const w = wx({ windSpeedKt: 12, windGustKt: 26 });
    const spread = 14;
    const sigma = Math.min(GUST_DIR_MAX_DEG, GUST_DIR_DEG_PER_KT * spread);
    let max = -Infinity, min = Infinity, maxDir = 0;
    for (const id of ['A', 'B', 'C', 'D']) {
      for (const s of series(w, 5, id, 30000)) {
        max = Math.max(max, s.speedKt);
        min = Math.min(min, s.speedKt);
        maxDir = Math.max(maxDir, Math.abs(s.devDeg));
      }
    }
    expect(max).toBeLessThanOrEqual(26 + 1e-6);
    expect(min).toBeGreaterThanOrEqual(12 - GUST_LULL_FRACTION * spread - 1e-6);
    expect(maxDir).toBeLessThanOrEqual(2 * sigma + 1e-6);
    // and the process really uses the range (it is not a constant): reaches at least 80 % of the spread above and some lull
    expect(max).toBeGreaterThan(12 + 0.8 * spread);
    expect(min).toBeLessThan(12 - 0.2 * spread);
  });

  it('is a smooth process: consecutive 0.1 s samples differ by far less than the spread', () => {
    const s = series(wx({ windGustKt: 30 }), 9, 'S', 5000);
    let maxStep = 0;
    for (let i = 1; i < s.length; i++) maxStep = Math.max(maxStep, Math.abs(s[i].speedKt - s[i - 1].speedKt));
    expect(maxStep).toBeLessThan(1.5); // spread 18 kt; first-order filter with a 8 s time constant
  });

  it('a larger gust spread gives larger excursions', () => {
    const sd = (w: Weather) => {
      const s = series(w, 11, 'Z', 20000).map((x) => x.devKt);
      const m = s.reduce((a, b) => a + b, 0) / s.length;
      return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length);
    };
    expect(sd(wx({ windGustKt: 32 }))).toBeGreaterThan(sd(wx({ windGustKt: 18 })) * 1.8);
  });
});

describe('wind components', () => {
  it('headwind, tailwind and crosswind side on a runway heading (TRUE)', () => {
    const head = windComponents(wx({ windDirDeg: 90, windSpeedKt: 10 }), 90);
    expect(head.headwindKt).toBeCloseTo(10);
    expect(head.crosswindKt).toBeCloseTo(0);
    expect(head.crosswindFrom).toBe('none');
    const tail = windComponents(wx({ windDirDeg: 90, windSpeedKt: 10 }), 270);
    expect(tail.headwindKt).toBeCloseTo(-10);
    expect(tail.tailwindKt).toBeCloseTo(10);
    const fromRight = windComponents(wx({ windDirDeg: 90, windSpeedKt: 10 }), 0); // heading north, wind from the east = from the right
    expect(fromRight.crosswindKt).toBeCloseTo(10);
    expect(fromRight.crosswindFrom).toBe('right');
    expect(windComponents(wx({ windDirDeg: 270, windSpeedKt: 10 }), 0).crosswindFrom).toBe('left');
  });

  it('45 degrees off: both components are speed x sin 45; the gust option uses the gust speed', () => {
    const w = wx({ windDirDeg: 45, windSpeedKt: 10, windGustKt: 20 });
    const c = windComponents(w, 0);
    expect(c.headwindKt).toBeCloseTo(7.07, 1);
    expect(c.crosswindKt).toBeCloseTo(7.07, 1);
    expect(windComponents(w, 0, true).crosswindKt).toBeCloseTo(14.14, 1);
    expect(windComponents(wx({ windDirDeg: 45, windSpeedKt: 10 }), 0, true).crosswindKt).toBeCloseTo(7.07, 1);
  });

  it('VRB and calm give zero components; a vector round-trips', () => {
    expect(windComponents(wx({ windDirDeg: 'VRB', windSpeedKt: 8 }), 130).crosswindKt).toBe(0);
    expect(windComponents(wx({ windDirDeg: 200, windSpeedKt: 0 }), 130).headwindKt).toBeCloseTo(0);
    const c = componentsOfVector(windVector(wx({ windDirDeg: 130, windSpeedKt: 15 })), 130);
    expect(c.headwindKt).toBeCloseTo(15);
  });

  it('limits: undefined limits never trigger, defined ones compare the component', () => {
    const c = windComponents(wx({ windDirDeg: 90, windSpeedKt: 20 }), 0);
    expect(exceedsLimits(c, {})).toBeUndefined();
    expect(exceedsLimits(c, { maxCrosswindKt: 15 })).toMatch(/crosswind 20 knots exceeds 15/);
    expect(exceedsLimits(c, { maxCrosswindKt: 20 })).toBeUndefined();
    const t = windComponents(wx({ windDirDeg: 180, windSpeedKt: 12 }), 0);
    expect(exceedsLimits(t, { maxTailwindKt: 10 })).toMatch(/tailwind 12 knots exceeds 10/);
  });

  it('effective component = steady + 0.5 x (gust - steady); the go-around margin is added to the limit', () => {
    const w = wx({ windDirDeg: 45, windSpeedKt: 10, windGustKt: 20 });
    expect(effectiveComponents(w, 0).crosswindKt).toBeCloseTo(10.6, 1); // 7.07 steady, 14.14 gust
    expect(effectiveComponents(wx({ windDirDeg: 45, windSpeedKt: 10 }), 0).crosswindKt).toBeCloseTo(7.07, 1);
    const c = windComponents(wx({ windDirDeg: 90, windSpeedKt: 19 }), 0);
    expect(exceedsLimits(c, { maxCrosswindKt: 15 })).toBeDefined();
    expect(exceedsLimits(c, { maxCrosswindKt: 15 }, 5)).toBeUndefined(); // 19 kt is under 15 + 5
    expect(exceedsLimits(windComponents(wx({ windDirDeg: 90, windSpeedKt: 21 }), 0), { maxCrosswindKt: 15 }, 5)).toBeDefined();
  });

  it('runwayEndWinds lists both components for every end', () => {
    const rows = runwayEndWinds({ runways: [{ ends: [{ id: '13', trueHeadingDeg: 118 }, { id: '31', trueHeadingDeg: 298 }] }] }, wx({ windDirDeg: 118, windSpeedKt: 10, windGustKt: 20 }));
    expect(rows.map((r) => r.id)).toEqual(['13', '31']);
    expect(rows[0].steady.headwindKt).toBeCloseTo(10);
    expect(rows[0].gust.headwindKt).toBeCloseTo(20);
    expect(rows[1].steady.tailwindKt).toBeCloseTo(10);
  });
});
