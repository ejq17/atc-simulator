import { describe, expect, it } from 'vitest';
import { loadKacy } from './kacy';
import {
  edgesBetween,
  edgesOfNode,
  holdingPositionsForRunway,
  nearestNode,
  nodesForTaxiway,
  normalizeRunwayEnd,
  normalizeRunwayId,
  runwayEntryNodes,
  runwayExitNodes,
} from './graphUtils';

const ap = loadKacy();
const g = ap.taxiwayGraph;

describe('graphUtils', () => {
  it('normalises runway identifiers', () => {
    expect(normalizeRunwayEnd('04')).toBe('4');
    expect(normalizeRunwayEnd('RWY 13')).toBe('13');
    expect(normalizeRunwayId('04/22')).toBe('4/22');
    expect(normalizeRunwayId('RWY13-31')).toBe('13/31');
  });

  it('nearestNode finds the nearest node, optionally by kind', () => {
    const thr13 = ap.runways[1].ends[0].threshold;
    expect(nearestNode(g, thr13)?.id).toBe('THR13');
    expect(nearestNode(g, thr13, 'holding_position')?.kind).toBe('holding_position');
    expect(nearestNode(ap, { x: 100000, y: 100000 }, ['parking'])?.kind).toBe('parking');
    expect(nearestNode(g, thr13, (n) => n.taxiways.includes('C'))?.taxiways).toContain('C');
    expect(nearestNode(g, thr13, 'apron')?.kind).toBe('apron');
  });

  it('nodesForTaxiway returns the nodes of an identifier', () => {
    const a = nodesForTaxiway(g, 'A');
    expect(a.length).toBeGreaterThan(20);
    expect(a.every((n) => n.taxiways.includes('A'))).toBe(true);
    expect(nodesForTaxiway(g, 'a')).toEqual(a);
    expect(nodesForTaxiway(g, 'Z')).toEqual([]);
  });

  it('holdingPositionsForRunway accepts any runway id spelling', () => {
    expect(holdingPositionsForRunway(g, '13/31')).toEqual(holdingPositionsForRunway(g, 'RWY13-31'));
    expect(holdingPositionsForRunway(g, '04/22')).toEqual(holdingPositionsForRunway(g, '4/22'));
    expect(holdingPositionsForRunway(g, '4/22').length + holdingPositionsForRunway(g, '13/31').length).toBe(Object.values(g.nodes).filter((n) => n.kind === 'holding_position').length);
    expect(holdingPositionsForRunway(g, '9/27')).toEqual([]);
  });

  it('edgesBetween / edgesOfNode', () => {
    const e = g.edges[10];
    expect(edgesBetween(g, e.from, e.to)).toContain(e);
    expect(edgesBetween(g, e.to, e.from)).toContain(e);
    expect(edgesBetween(g, 'THR13', 'THR31')).toEqual([]);
    expect(edgesOfNode(g, 'HS1-X')).toHaveLength(4);
  });

  it('entry/exit helpers also work on a bare graph (threshold nodes)', () => {
    expect(runwayEntryNodes(g, '13').map((n) => n.id)).toEqual(runwayEntryNodes(ap, '13').map((n) => n.id));
    expect(runwayExitNodes(g, '31').map((x) => x.node.id)).toEqual(runwayExitNodes(ap, '31').map((x) => x.node.id));
    expect(() => runwayEntryNodes(g, '99')).toThrow();
  });

  it('exit angle: B end connectors are near-perpendicular, J/H leave at an acute angle on the correct side', () => {
    const ex = runwayExitNodes(ap, '31');
    for (const x of ex) {
      expect(x.edge.onRunwayId).toBeUndefined();
      expect(x.node.kind).toBe('runway');
      expect(x.distanceFromThresholdM).toBeGreaterThan(0);
    }
    const j = ex.find((x) => x.taxiway === 'J')!;
    expect(j.exitAngleDeg).toBeGreaterThan(0);
    // J and H are on the terminal (south-west) side of 13/31; landing 31 (heading 298) the south-west is the left side
    expect(j.side).toBe('left');
  });
});
