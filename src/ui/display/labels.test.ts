import { describe, expect, it } from 'vitest';
import { nearestWithin, placeLabels, rectsOverlap } from './labels';
import type { LabelRequest } from './labels';

describe('label placement', () => {
  it('never overlaps two labels for nearby aircraft', () => {
    const reqs: LabelRequest[] = [
      { id: 'a', x: 100, y: 100, w: 90, h: 32 },
      { id: 'b', x: 112, y: 104, w: 90, h: 32 },
      { id: 'c', x: 106, y: 96, w: 90, h: 32 },
    ];
    const placed = placeLabels(reqs);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(rectsOverlap(placed[i], placed[j])).toBe(false);
  });
  it('gives the first request the preferred (north-east) slot', () => {
    const [p] = placeLabels([{ id: 'sel', x: 200, y: 200, w: 80, h: 30 }]);
    expect(p.x).toBeGreaterThan(200);
    expect(p.y + p.h).toBeLessThan(200);
  });
  it('keeps labels inside the canvas when possible', () => {
    const [p] = placeLabels([{ id: 'edge', x: 20, y: 10, w: 90, h: 30 }], [], 16, { width: 400, height: 300 });
    expect(p.y).toBeGreaterThanOrEqual(2);
    expect(p.x).toBeGreaterThanOrEqual(2);
  });
  it('avoids supplied rectangles', () => {
    const [p] = placeLabels([{ id: 'a', x: 100, y: 100, w: 60, h: 20 }], [{ x: 110, y: 64, w: 100, h: 40 }]);
    expect(rectsOverlap(p, { x: 110, y: 64, w: 100, h: 40 })).toBe(false);
  });
});

describe('hit testing', () => {
  const items = [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 40, y: 10 }];
  it('picks the nearest item inside the radius', () => {
    expect(nearestWithin(items, 14, 12, 16)).toBe('a');
    expect(nearestWithin(items, 36, 8, 16)).toBe('b');
    expect(nearestWithin(items, 25, 10, 16)).toBe('a'); // tie goes to the first
  });
  it('returns undefined when nothing is close', () => {
    expect(nearestWithin(items, 200, 200, 16)).toBeUndefined();
  });
});
