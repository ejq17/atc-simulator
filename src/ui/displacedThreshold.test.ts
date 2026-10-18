/** Displaced thresholds on KMHT in the renderers: Tower markings (threshold bars, arrows, aiming point) and Surface (labels, bar, arrows). */
import { describe, expect, it } from 'vitest';
import { loadKacy, loadKmht } from '../airport';
import { displacedThresholds } from '../sim/runways';
import { FT, runwayAxis, runwayLights, runwayMarkings } from './tower/geometry';
import type { MarkingRect } from './tower/geometry';
import { runwayLabels } from './display/surfaceStatic';
import { drawSurface, DEFAULT_SURFACE_LAYERS } from './display/surfaceRenderer';
import { buildSurfaceStatic } from './display/surfaceStatic';
import { fitBounds } from './display/viewTransform';
import { poseOf } from './display/renderBuffer';
import { createEngine } from '../sim/engine';
import { makeScenario } from '../sim/__fixtures__/testHelpers';

const kmht = loadKmht();
const kacy = loadKacy();

/** Along-axis coordinate (m from the first pavement end) of a marking centre. */
const alongOf = (rw: (typeof kmht.runways)[number], m: MarkingRect): number => {
  const ax = runwayAxis(rw);
  const r = (ax.headingDeg * Math.PI) / 180;
  return (m.c.x - ax.origin.x) * Math.sin(r) + (m.c.y - ax.origin.y) * Math.cos(r);
};

describe('Tower markings at displaced thresholds (runway 6/24: 442 ft at the 6 end)', () => {
  const rw = kmht.runways.find((r) => r.id === '6/24')!;
  const m = runwayMarkings(rw);
  const L = runwayAxis(rw).length;
  const d6 = 442 * FT;

  it('the threshold bars of the 6 end start at the displaced threshold, those of the 24 end at the pavement end', () => {
    const along = m.threshold.map((b) => alongOf(rw, b));
    const near6 = along.filter((a) => a < L / 2);
    const near24 = along.filter((a) => a >= L / 2);
    expect(Math.min(...near6)).toBeCloseTo(d6 + 6 * FT + (150 * FT) / 2, 1); // landing threshold + 6 ft + half the bar length
    expect(Math.max(...near24)).toBeCloseTo(L - (6 * FT + (150 * FT) / 2), 1);
    expect(near6.length).toBe(near24.length);
  });

  it('the displaced area carries arrows (shafts and arrowheads) and nothing else of the centreline', () => {
    expect(m.displaced.length).toBeGreaterThan(3);
    for (const a of m.displaced) expect(alongOf(rw, a)).toBeLessThan(d6);
    for (const c of m.centreline) expect(alongOf(rw, c)).toBeGreaterThan(d6 + 100);
    // arrows point at the landing threshold: shafts run along the axis heading (end 6 lands in the axis direction)
    const shafts = m.displaced.filter((a) => a.length > 10);
    expect(shafts.length).toBeGreaterThan(0);
    for (const s of shafts) expect(Math.abs(((s.headingDeg - runwayAxis(rw).headingDeg + 540) % 360) - 180)).toBeLessThan(1);
  });

  it('the aiming point is 1,000 ft from the landing threshold, not from the pavement end', () => {
    const along = m.aiming.map((a) => alongOf(rw, a)).filter((a) => a < L / 2);
    expect(along.length).toBe(2);
    for (const a of along) expect(a).toBeCloseTo(d6 + 1000 * FT + 22.8, 1);
  });

  it('a runway without a displaced end has no arrows; KACY is unchanged', () => {
    const rw24only = { ...rw, ends: [{ ...rw.ends[0], displacedThresholdFt: undefined }, rw.ends[1]] } as typeof rw;
    expect(runwayMarkings(rw24only).displaced).toEqual([]);
    for (const r of kacy.runways) expect(runwayMarkings(r).displaced).toEqual([]);
  });

  it('threshold lights (green) sit at the landing threshold', () => {
    const lights = runwayLights(rw, { centreline: false, approach: false });
    const green = lights.filter((l) => l.colour === 'green');
    const ax = runwayAxis(rw);
    const r = (ax.headingDeg * Math.PI) / 180;
    const alongs = green.map((l) => (l.pos.x - ax.origin.x) * Math.sin(r) + (l.pos.y - ax.origin.y) * Math.cos(r));
    expect(Math.min(...alongs)).toBeCloseTo(d6 - 1, 1);
    expect(Math.max(...alongs)).toBeCloseTo(L + 1, 1);
  });
});

describe('Surface display', () => {
  it('the runway numbers sit inside the landing threshold', () => {
    const rw = kmht.runways.find((r) => r.id === '17/35')!;
    const labels = runwayLabels(rw);
    const l35 = labels.find((l) => l.endId === '35')!;
    const e35 = rw.ends.find((e) => e.id === '35')!;
    const d = displacedThresholds(rw).find((x) => x.endId === '35')!;
    const fromPavementEnd = Math.hypot(l35.x - e35.threshold.x, l35.y - e35.threshold.y);
    expect(fromPavementEnd).toBeCloseTo(110 + 850 * FT, 0);
    expect(fromPavementEnd).toBeGreaterThan(d.displacedM);
  });

  it('draws the threshold bar and arrows of displaced thresholds: more strokes than the same airport without them', () => {
    const strokes = (airport: typeof kmht): number => {
      const e = createEngine({ airport, scenario: makeScenario({ spawns: [] }), readbackErrorRate: 0 });
      const calls: string[] = [];
      const t: Record<string, unknown> = {};
      const ctx = new Proxy(t, {
        get(o, p: string) {
          if (p === 'measureText') return (s: string) => ({ width: s.length * 6.5 });
          if (p in o) return o[p];
          return () => { calls.push(p); };
        },
        set(o, p: string, v) { o[p] = v; return true; },
      }) as unknown as CanvasRenderingContext2D;
      const v = fitBounds(buildSurfaceStatic(airport).bounds, 1000, 600);
      drawSurface(ctx, { state: e.getState(), nowMs: 0, pose: poseOf }, v, DEFAULT_SURFACE_LAYERS);
      return calls.filter((c) => c === 'stroke').length;
    };
    const stripped = structuredClone(kmht);
    for (const r of stripped.runways) for (const e of r.ends) delete e.displacedThresholdFt;
    expect(strokes(kmht)).toBeGreaterThan(strokes(stripped) + 10); // 3 bars + the arrows of 442 / 336 / 850 ft (1 + 1 + 3 arrows x 3 strokes)
  });
});
