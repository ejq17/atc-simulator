import { describe, expect, it } from 'vitest';
import { loadKbos, loadKpgd, loadKphl } from './index';
import { pushbackGeometry } from '../sim/pushback';
import { shortestDistances } from '../sim/pathfinding';
import type { Airport } from '../sim/types';

/**
 * Stand lead-ins of the newer airports (new-airport soak): the pushback takes the first graph edge at the stand as the lead-in, so a stand joined to the
 * network by a 0.6 m edge (KBOS B39, B21, B2, A8, ... ended on a taxilane vertex) pushed back 0.6 m and sat in PUSHBACK for an hour (AAL1784 in the KBOS
 * soak). `mergeTinyStandLeadIn` in the KBOS profile gives those stands the connector behind the vertex. Every airline and cargo stand must have a lead-in
 * of more than 3 m and a taxi route to a hold line of every runway that has one.
 */
describe.each<[string, Airport]>([['KBOS', loadKbos()], ['KPGD', loadKpgd()], ['KPHL', loadKphl()]])('%s stands', (_icao, airport) => {
  const g = airport.taxiwayGraph;
  const stands = airport.parking.filter((p) => p.category === 'airline' || p.category === 'cargo');
  it('every airline and cargo stand has a push lead-in of more than 3 m', () => {
    const bad: string[] = [];
    for (const p of stands) {
      const geo = pushbackGeometry(airport, p, { type: 'A320', pos: p.pos, headingDeg: p.headingDeg ?? 0 } as never, {});
      if (!geo || geo.lengthM <= 3) bad.push(`${p.id}:${geo ? geo.lengthM.toFixed(1) : 'none'}`);
    }
    expect(bad).toEqual([]);
  });
  it('every stand reaches a hold line of every runway that has one', () => {
    const holdsByRunway = new Map<string, string[]>();
    for (const n of Object.values(g.nodes)) if (n.kind === 'holding_position' && n.runwayId) holdsByRunway.set(n.runwayId, [...(holdsByRunway.get(n.runwayId) ?? []), n.id]);
    const unreachable: string[] = [];
    for (const p of airport.parking) {
      const dm = shortestDistances(g, p.nodeId, { allowedRunwayIds: airport.runways.map((r) => r.id) });
      for (const [rid, holds] of holdsByRunway) if (!holds.some((h) => dm.has(h))) unreachable.push(`${p.id}->${rid}`);
    }
    expect(unreachable).toEqual([]);
  });
});
