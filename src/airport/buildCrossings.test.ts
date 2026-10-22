import { describe, expect, it } from 'vitest';
import { crossingName, crossingNodeId, findRunwayCrossings } from '../../scripts/lib/crossings';

describe('findRunwayCrossings (generic airport build)', () => {
  it('finds no crossing for parallel runways', () => {
    const nodes = new Map([
      ['9L/27R', new Set([1, 2, 3])],
      ['9R/27L', new Set([4, 5, 6])],
    ]);
    expect(findRunwayCrossings(nodes, ['9L/27R', '9R/27L'])).toEqual([]);
  });

  it('finds every shared node, ordered by runway then node, including a three-runway node', () => {
    const nodes = new Map([
      ['4L/22R', new Set([1, 10, 11, 20])],
      ['4R/22L', new Set([2, 12])],
      ['9/27', new Set([3, 10, 12, 30])],
      ['15R/33L', new Set([4, 20, 30])],
      ['14/32', new Set([5, 30])],
    ]);
    const order = ['4L/22R', '4R/22L', '9/27', '15R/33L', '14/32'];
    expect(findRunwayCrossings(nodes, order)).toEqual([
      { node: 10, runwayIds: ['4L/22R', '9/27'] },
      { node: 20, runwayIds: ['4L/22R', '15R/33L'] },
      { node: 12, runwayIds: ['4R/22L', '9/27'] },
      { node: 30, runwayIds: ['9/27', '15R/33L', '14/32'] },
    ]);
  });

  it('builds safe, unique node ids and names', () => {
    expect(crossingNodeId(['4L/22R', '9/27'])).toBe('RWX-4L-22Rx9-27');
    expect(crossingNodeId(['9/27', '15R/33L', '14/32'])).toBe('RWX-9-27x15R-33Lx14-32');
    expect(crossingName(['4L/22R', '9/27'])).toBe('Runway 4L/22R x 9/27 intersection');
  });
});
