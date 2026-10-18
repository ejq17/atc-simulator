import { describe, expect, it } from 'vitest';
import { createTestAirport } from './__fixtures__/testAirport';
import { loadKmht } from '../airport';
import {
  findTaxiRoute, holdingPositionsAlong, nearestNode, runwayCrossingsAlong, runwayNodesAlong, validateRoute,
} from './pathfinding';

const airport = createTestAirport();
const g = airport.taxiwayGraph;
const ALL = airport.runways.map((r) => r.id);

describe('pathfinding', () => {
  it('finds a route that honours the ordered via list', () => {
    const r = findTaxiRoute(g, 'GA1', 'H22', { via: ['A'], allowedRunwayIds: ALL });
    expect(r.route).not.toBeNull();
    expect(r.route!.nodeIds[0]).toBe('GA1');
    expect(r.route!.nodeIds.at(-1)).toBe('H22');
    expect(r.route!.taxiways).toEqual(['RAMP', 'B', 'A']);
    const v = validateRoute(g, r.route!, ['A']);
    expect(v.valid).toBe(true);
  });

  it('honours via ORDER (B then D reaches the 31 side; D then B is impossible)', () => {
    const ok = findTaxiRoute(g, 'GA1', 'C_E', { via: ['B', 'D', 'C'], allowedRunwayIds: ALL });
    expect(ok.route).not.toBeNull();
    const t = ok.route!.taxiways.filter((x) => ['B', 'D', 'C'].includes(x));
    expect(t.indexOf('B')).toBeLessThan(t.indexOf('D'));
    expect(t.indexOf('D')).toBeLessThan(t.lastIndexOf('C'));
    // From the apron the first named taxiway must come first: D before B cannot be satisfied toward C_E without reusing B.
    const bad = findTaxiRoute(g, 'GA1', 'H22', { via: ['A', 'D'], allowedRunwayIds: ALL });
    expect(bad.route).toBeNull();
    expect(bad.reason).toMatch(/order|using taxiway/i);
  });

  it('rejects impossible and unknown via taxiways with a reason', () => {
    const unknown = findTaxiRoute(g, 'GA1', 'H22', { via: ['Z'] });
    expect(unknown.route).toBeNull();
    expect(unknown.reason).toMatch(/does not exist/);
    const impossible = findTaxiRoute(g, 'GA1', 'H22', { via: ['D', 'A', 'D'], allowedRunwayIds: ALL });
    expect(impossible.route).toBeNull();
    expect(impossible.reason).toBeTruthy();
  });

  it('avoids runway edges unless allowed', () => {
    const noCross = findTaxiRoute(g, 'GA1', 'H4', { via: ['A'] });
    expect(noCross.route).toBeNull();
    expect(noCross.reason).toMatch(/runway 13\/31/);
    const cross = findTaxiRoute(g, 'GA1', 'H4', { via: ['A'], allowedRunwayIds: ['13/31'] });
    expect(cross.route).not.toBeNull();
    expect(cross.route!.runwayCrossings).toEqual(['13/31']);
    // never travels along runway centrelines unless the runway is named in via
    expect(cross.route!.taxiways.some((t) => t.startsWith('RWY'))).toBe(false);
    const free = findTaxiRoute(g, 'GA1', 'H4', { avoidRunways: false });
    expect(free.route).not.toBeNull();
  });

  it('exposes holding positions and runway nodes along a route', () => {
    const r = findTaxiRoute(g, 'GA1', 'H4', { via: ['A'], allowedRunwayIds: ALL }).route!;
    expect(holdingPositionsAlong(g, r.nodeIds).map((n) => n.id)).toEqual(['A_h13N', 'A_h13S', 'H4']);
    expect(runwayNodesAlong(g, r.nodeIds).map((n) => n.id)).toEqual(['A_r13']);
    expect(runwayCrossingsAlong(g, r.nodeIds)).toEqual(['13/31']);
  });

  it('validates explicit routes', () => {
    expect(validateRoute(g, ['GA1', 'AP', 'A_J']).valid).toBe(true);
    const bad = validateRoute(g, ['GA1', 'A_J']);
    expect(bad.valid).toBe(false);
    expect(bad.reason).toMatch(/not connected/);
    expect(validateRoute(g, ['GA1', 'AP', 'A_J', 'A_N'], ['B', 'A']).valid).toBe(true);
    expect(validateRoute(g, ['GA1', 'AP', 'A_J', 'A_N'], ['A', 'B']).valid).toBe(false);
  });

  it('finds the nearest node to a position', () => {
    const near = nearestNode(g, { x: g.nodes.GA2.pos.x + 3, y: g.nodes.GA2.pos.y - 2 });
    expect(near?.id).toBe('GA2');
    expect(nearestNode(g, g.nodes.H22.pos, { kinds: ['parking'] })?.kind).toBe('parking');
    expect(nearestNode(g, { x: 1e6, y: 1e6 }, { maxDistM: 100 })).toBeUndefined();
  });
});

import { checkAirportForSim } from './airportCheck';

describe('airport data contract check', () => {
  it('accepts the fixture airport and flags missing data', () => {
    const ok = checkAirportForSim(airport);
    expect(ok.errors).toEqual([]);
    const broken = createTestAirport();
    broken.parking = [];
    broken.frequencies = [];
    broken.runways[0].polygon = [];
    const bad = checkAirportForSim(broken);
    expect(bad.errors.join('\n')).toMatch(/Runway 13\/31 has no polygon/);
    expect(bad.errors.join('\n')).toMatch(/No parking/);
    expect(bad.warnings.join('\n')).toMatch(/No GND frequency/);
  });
});

describe('pathfinding on KMHT: via routes never U-turn onto the named taxiway', () => {
  const kmht = loadKmht();
  const kg = kmht.taxiwayGraph;
  const kAll = kmht.runways.map((r) => r.id);
  const gate = kmht.parking.find((p) => p.id === 'GATE-1')!.nodeId;
  const edgeOf = (id: string) => kg.edges.find((e) => e.id === id)!;

  for (const start of ['HP17-35-B-1', 'HP17-35-B-2']) {
    it(`${start} to GATE-1 via H, E, N flies B, H, E ... N and never revisits a node`, () => {
      const r = findTaxiRoute(kg, start, gate, { via: ['H', 'E', 'N'], avoidRunways: true, allowedRunwayIds: kAll });
      expect(r.reason).toBeUndefined();
      const t = r.route!.taxiways;
      expect(t.slice(0, 2)).toEqual(['B', 'H']);
      expect(t.indexOf('E')).toBeGreaterThan(t.indexOf('H'));
      expect(t.indexOf('N')).toBeGreaterThan(t.indexOf('E'));
      expect(new Set(r.route!.nodeIds).size).toBe(r.route!.nodeIds.length);
    });
    it(`${start} to GATE-1 via H alone really travels along H`, () => {
      const r = findTaxiRoute(kg, start, gate, { via: ['H'], avoidRunways: true, allowedRunwayIds: kAll });
      expect(r.reason).toBeUndefined();
      expect(r.route!.taxiways.slice(0, 2)).toEqual(['B', 'H']);
      expect(r.route!.edgeIds.filter((id) => edgeOf(id).taxiway === 'H').length).toBeGreaterThan(1);
    });
  }

  it('a genuinely impossible via order is still rejected with a reason', () => {
    // M is the apron road at the terminal end of the route; H lies behind us, so "M then H" cannot be flown without a U-turn.
    const r = findTaxiRoute(kg, 'HP17-35-B-1', gate, { via: ['M', 'H'], avoidRunways: true, allowedRunwayIds: kAll });
    expect(r.route).toBeNull();
    expect(r.reason).toMatch(/.+/);
  });
});
