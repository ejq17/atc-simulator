import { describe, expect, it } from 'vitest';
import { boundsOf, clampScale, fitBounds, MAX_SCALE, MIN_SCALE, panBy, screenToWorld, visibleBounds, worldToScreen, zoomAt } from './viewTransform';
import type { View } from './viewTransform';

const view: View = { cx: 100, cy: -50, scale: 0.5, width: 800, height: 600 };

describe('world <-> screen', () => {
  it('puts the view centre at the canvas centre', () => {
    expect(worldToScreen(view, { x: 100, y: -50 })).toEqual({ x: 400, y: 300 });
  });
  it('is north-up: larger y (north) is higher on screen (smaller screen y)', () => {
    const a = worldToScreen(view, { x: 100, y: -50 });
    const n = worldToScreen(view, { x: 100, y: 50 });
    const e = worldToScreen(view, { x: 200, y: -50 });
    expect(n.y).toBeLessThan(a.y);
    expect(e.x).toBeGreaterThan(a.x);
    expect(a.y - n.y).toBeCloseTo(50); // 100 m * 0.5 px/m
  });
  it('round-trips', () => {
    for (const p of [{ x: 0, y: 0 }, { x: -1200, y: 740 }, { x: 1500, y: -690 }]) {
      const back = screenToWorld(view, worldToScreen(view, p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });
});

describe('zoom and pan', () => {
  it('keeps the world point under the cursor fixed while zooming', () => {
    const anchor = { x: 650, y: 120 };
    const before = screenToWorld(view, anchor);
    const z = zoomAt(view, 2.5, anchor);
    expect(z.scale).toBeCloseTo(1.25);
    const after = screenToWorld(z, anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
  it('clamps to the supported 0.05..8 px/m range', () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(zoomAt(view, 1e6).scale).toBe(8);
    expect(zoomAt(view, 1e-6).scale).toBe(0.05);
  });
  it('dragging right moves the map right (the view centre moves west)', () => {
    const p = panBy(view, 50, 0);
    expect(p.cx).toBeLessThan(view.cx);
    const down = panBy(view, 0, 40);
    expect(down.cy).toBeGreaterThan(view.cy); // dragging down reveals more north
  });
});

describe('fit and culling', () => {
  it('fits bounds inside the canvas', () => {
    const b = boundsOf([{ x: -1500, y: -900 }, { x: 1600, y: 800 }]);
    const v = fitBounds(b, 1000, 600, 0.05);
    const tl = worldToScreen(v, { x: b.minX, y: b.maxY });
    const br = worldToScreen(v, { x: b.maxX, y: b.minY });
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(1000);
    expect(br.y).toBeLessThanOrEqual(600);
  });
  it('visibleBounds covers the canvas', () => {
    const b = visibleBounds(view);
    expect(b.minX).toBeCloseTo(100 - 400 / 0.5);
    expect(b.maxY).toBeCloseTo(-50 + 300 / 0.5);
  });
});
