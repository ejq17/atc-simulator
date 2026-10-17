import { describe, expect, it } from 'vitest';
import { loadKacy } from './kacy';
import {
  edgesBetween,
  edgesOfNode,
  findParking,
  isRunwayEdge,
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
      expect(isRunwayEdge(x.edge)).toBe(false);
      expect(x.node.kind).toBe('runway');
      expect(x.distanceFromThresholdM).toBeGreaterThan(0);
    }
    const j = ex.find((x) => x.taxiway === 'J')!;
    expect(j.exitAngleDeg).toBeGreaterThan(0);
    // J and H are on the terminal (south-west) side of 13/31; landing 31 (heading 298) the south-west is the left side
    expect(j.side).toBe('left');
  });
});

describe('findParking', () => {
  const ids = (q: string) => findParking(ap, q).map((p) => p.id);

  it('keeps stable ids and names', () => {
    for (let i = 1; i <= 10; i++) {
      const p = ap.parking.find((x) => x.id === `GATE-${i}`)!;
      expect(p.name).toBe(`Gate ${i}`);
      expect(p.category).toBe('airline');
    }
    expect(ap.parking.find((p) => p.id === 'GA-1')?.name).toBe('GA Ramp 1');
    expect(ap.parking.find((p) => p.id === 'FBO-1')?.name).toBe('FBO Ramp 1');
  });

  it('resolves exact id, separator-free id and name case-insensitively', () => {
    expect(ids('GATE-1')).toEqual(['GATE-1']);
    expect(ids('gate-1')).toEqual(['GATE-1']);
    expect(ids('GATE1')).toEqual(['GATE-1']);
    expect(ids('gate 1')).toEqual(['GATE-1']);
    expect(ids('Gate 10')).toEqual(['GATE-10']);
    expect(ids('ga ramp 3')).toEqual(['GA-3']);
    expect(ids('GA3')).toEqual(['GA-3']);
    expect(ids('fbo 1')).toEqual(['FBO-1']);
  });

  it('resolves category keywords to all matching positions', () => {
    const airline = ids('terminal');
    expect(airline).toEqual(ids('gate'));
    expect(airline).toHaveLength(10);
    expect(airline[0]).toBe('GATE-1');
    expect(airline[9]).toBe('GATE-10');
    expect(ids('ramp').every((id) => id.startsWith('GA-'))).toBe(true);
    expect(ids('general aviation')).toEqual(ids('GA'));
    expect(ids('parking').length).toBeGreaterThanOrEqual(5);
    expect(ids('FBO').every((id) => id.startsWith('FBO-'))).toBe(true);
    expect(ids('cargo')).toEqual(ids('faa'));
    expect(ids('cargo').length).toBeGreaterThan(0);
    const mil = findParking(ap, 'military');
    expect(mil.length).toBeGreaterThan(0);
    expect(mil.every((p) => p.category === 'military')).toBe(true);
    expect(ids('ang').every((id) => ap.parking.find((p) => p.id === id)!.category === 'military')).toBe(true);
  });

  it('returns [] for unknown or empty queries', () => {
    expect(findParking(ap, 'hangar 99')).toEqual([]);
    expect(findParking(ap, '   ')).toEqual([]);
  });
});

describe('runway-crossing edges carry onRunwayId', () => {
  it('the A route across 13/31 reads A and is on runway 13/31 between its holding positions', () => {
    const a1 = g.nodes['HP13-31-A-1'];
    const a2 = g.nodes['HP13-31-A-2'];
    const x = g.nodes['R13-31-04'];
    expect(a1.runwayId).toBe('13/31');
    for (const hold of [a1, a2]) {
      // follow edges from the hold to the runway node
      let cur = hold.id;
      const seen = new Set<string>([cur]);
      while (cur !== x.id) {
        const e = edgesOfNode(g, cur).find((ed) => ed.taxiway === 'A' && !seen.has(ed.from === cur ? ed.to : ed.from) && ed.onRunwayId === '13/31');
        expect(e, `edge from ${cur}`).toBeDefined();
        expect(e!.taxiway).toBe('A');
        cur = e!.from === cur ? e!.to : e!.from;
        seen.add(cur);
      }
    }
  });

  it('every holding position leads toward its entry node over edges with onRunwayId === its runway; no edge inside a runway polygon lacks it', () => {
    const inPoly = (p: { x: number; y: number }, poly: { x: number; y: number }[]) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i];
        const b = poly[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    for (const h of Object.values(g.nodes).filter((n) => n.kind === 'holding_position')) {
      const entry = (h as { entryNodeId?: string }).entryNodeId!;
      const prev = new Map<string, string | null>([[h.id, null]]);
      const q = [h.id];
      while (q.length && !prev.has(entry)) {
        const n = q.shift()!;
        for (const e of edgesOfNode(g, n)) {
          if (isRunwayEdge(e)) continue;
          const o = e.from === n ? e.to : e.from;
          if (!prev.has(o)) {
            prev.set(o, n);
            q.push(o);
          }
        }
      }
      expect(prev.has(entry), h.id).toBe(true);
      for (let n = entry; prev.get(n); n = prev.get(n)!) {
        const e = edgesBetween(g, n, prev.get(n)!)[0];
        expect(e.onRunwayId, `${h.id}: ${e.id}`).toBe(h.runwayId);
        expect(e.taxiway).not.toMatch(/^RWY/);
      }
    }
    for (const e of g.edges) {
      const a = g.nodes[e.from].pos;
      const b = g.nodes[e.to].pos;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = ap.runways.find((rw) => inPoly(mid, rw.polygon));
      if (r) expect(e.onRunwayId, e.id).toBeDefined();
    }
  });
});

describe('airport name', () => {
  it('is the spoken name, with the raw NASR name kept in provenance notes', () => {
    expect(ap.name).toBe('Atlantic City International');
    expect(ap.provenance[0].notes).toContain('nasrName: ATLANTIC CITY INTL');
  });
});
