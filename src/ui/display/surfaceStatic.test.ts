import { describe, expect, it } from 'vitest';
import { loadKacy } from '../../airport';
import { buildSurfaceStatic, holdMarks, placeTaxiwayLabels, runwayLabels, uprightAngleDeg } from './surfaceStatic';
import type { Vec2 } from '../../sim/types';

const airport = loadKacy();

describe('upright text angles', () => {
  it('never leaves text upside down', () => {
    for (let a = -360; a <= 360; a += 7) {
      const u = uprightAngleDeg(a);
      expect(u).toBeGreaterThan(-90);
      expect(u).toBeLessThanOrEqual(90);
    }
    expect(uprightAngleDeg(180)).toBeCloseTo(0);
    expect(uprightAngleDeg(135)).toBeCloseTo(-45);
    expect(uprightAngleDeg(-135)).toBeCloseTo(45);
  });
});

describe('taxiway label placement', () => {
  const line = (n: number): Vec2[] => [{ x: 0, y: 0 }, { x: n, y: 0 }];

  it('places roughly one label per 400 m along a long taxiway, rotated to the line', () => {
    const labels = placeTaxiwayLabels({ A: [line(1600)] }, { intervalM: 400 });
    expect(labels).toHaveLength(4);
    expect(labels.every((l) => l.name === 'A' && Math.abs(l.angleDeg) < 1e-9)).toBe(true);
    expect(labels.map((l) => Math.round(l.x))).toEqual([200, 600, 1000, 1400]);
  });

  it('rotates labels to follow a diagonal line (kept upright)', () => {
    const [l] = placeTaxiwayLabels({ B: [[{ x: 0, y: 0 }, { x: 100, y: 100 }]] });
    expect(l.angleDeg).toBeCloseTo(45);
    const [r] = placeTaxiwayLabels({ B: [[{ x: 100, y: 100 }, { x: 0, y: 0 }]] });
    expect(r.angleDeg).toBeCloseTo(45); // reversed digitising direction gives the same readable angle
  });

  it('never labels UNNAMED lanes and skips tiny stubs', () => {
    const labels = placeTaxiwayLabels({ UNNAMED: [line(800)], C: [line(10)] });
    expect(labels).toHaveLength(0);
  });

  it('de-duplicates: same-name labels are spaced, and no two labels crowd each other', () => {
    const labels = placeTaxiwayLabels({ A: [line(300), [{ x: 0, y: 5 }, { x: 300, y: 5 }]] }, { sameNameSpacingM: 160, anySpacingM: 45 });
    expect(labels).toHaveLength(1);
  });

  it('labels the named KACY taxiways, each at least once, never UNNAMED', () => {
    const st = buildSurfaceStatic(airport);
    const named = Object.keys(airport.taxiwayGraph.taxiwayPolylines).filter((n) => n !== 'UNNAMED');
    const got = new Set(st.taxiLabels.map((l) => l.name));
    expect(got.has('UNNAMED')).toBe(false);
    for (const n of ['A', 'B', 'D', 'J']) expect(got.has(n)).toBe(true);
    expect(st.taxiLabels.length).toBeGreaterThanOrEqual(Math.min(named.length, 8));
    for (let i = 0; i < st.taxiLabels.length; i++) for (let j = i + 1; j < st.taxiLabels.length; j++) {
      const a = st.taxiLabels[i];
      const b = st.taxiLabels[j];
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(45 - 1e-6);
    }
  });
});

describe('runway numbers', () => {
  it('puts each number at its own threshold, inside the runway', () => {
    const rw = airport.runways.find((r) => r.id === '13/31')!;
    const labels = runwayLabels(rw);
    const l13 = labels.find((l) => l.text === '13')!;
    const l31 = labels.find((l) => l.text === '31')!;
    const t13 = rw.ends.find((e) => e.id === '13')!.threshold;
    const t31 = rw.ends.find((e) => e.id === '31')!.threshold;
    expect(Math.hypot(l13.x - t13.x, l13.y - t13.y)).toBeLessThan(Math.hypot(l13.x - t31.x, l13.y - t31.y));
    expect(Math.hypot(l31.x - t31.x, l31.y - t31.y)).toBeLessThan(Math.hypot(l31.x - t13.x, l31.y - t13.y));
    expect(Math.hypot(l13.x - t13.x, l13.y - t13.y)).toBeCloseTo(110, 3);
    // Runway 13/31 runs WNW-ESE: heading 118 true => line angle (CCW from east) is about -28 deg.
    expect(l13.angleDeg).toBeCloseTo(-28, 0);
    expect(l31.angleDeg).toBeCloseTo(-28, 0);
    expect(l13.headingDeg).toBe(118);
    expect(l31.headingDeg).toBe(298);
  });

  it('labels all four ends', () => {
    const st = buildSurfaceStatic(airport);
    expect(st.runwayLabels.map((l) => l.text).sort()).toEqual(['13', '22', '31', '4']);
  });
});

describe('hold-short marks', () => {
  it('has one per holding-position node, ticks parallel to their runway and labels on the taxiway side', () => {
    const marks = holdMarks(airport);
    const nodes = Object.values(airport.taxiwayGraph.nodes).filter((n) => n.kind === 'holding_position');
    expect(marks).toHaveLength(nodes.length);
    expect(marks.length).toBeGreaterThanOrEqual(12);
    for (const m of marks) {
      const rw = airport.runways.find((r) => r.id === m.runwayId)!;
      const a = rw.ends[0].threshold;
      const b = rw.ends[1].threshold;
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      expect(Math.abs(m.dir.x * (b.x - a.x) / L + m.dir.y * (b.y - a.y) / L)).toBeCloseTo(1, 6);
      // `away` points from the runway centreline toward the node
      const cross = (m.pos.x - a.x) * -m.dir.y + (m.pos.y - a.y) * m.dir.x;
      expect(cross * (m.away.x * -m.dir.y + m.away.y * m.dir.x)).toBeGreaterThan(0);
    }
  });

  it('knows parking and HS 1', () => {
    const st = buildSurfaceStatic(airport);
    expect(st.parking.length).toBe(airport.parking.length);
    expect(st.hs1).toBeDefined();
  });
});
