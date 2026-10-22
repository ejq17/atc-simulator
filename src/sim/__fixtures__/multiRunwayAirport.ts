/**
 * SYNTHETIC multi-runway fixture airport (not real data). Four runways, local metres, x east, y north, magnetic variation 0:
 *
 *   9L/27R   y = +610, x -1500..+1500 (9,843 ft)   parallel pair, centrelines 1,220 m = 4,003 ft apart
 *   9R/27L   y = -610, x -1500..+1500 (9,843 ft)
 *   17/35    x = 0,    y +1000..-1000 (6,562 ft)   crosses BOTH parallels (two runway-runway crossings, X1 north and X2 south)
 *   6/24     short unrelated runway far south-west (2,400 ft), disconnected from the taxi network
 *
 * Taxiway A runs east-west at y = 0 between the parallels and crosses 17/35 at its midpoint; connectors leave A at x = -1400, -700, +700,
 * +1400 to hold lines 60 m from each parallel centreline. The apron and the stands are south of A at x about -300.
 * Runway configurations (list order = operator preference): W-SEG land 27R / depart 27L, E-SEG land 9L / depart 9R, W-DUAL land 27R+27L /
 * depart 27L, N-ALL land+depart 35.
 */
import type { Airport, DataProvenance, LatLon, Runway, RunwayConfiguration, RunwayEnd, TaxiEdge, TaxiNode, TaxiNodeKind, Vec2 } from '../types';
import { deg2rad, dist } from '../geo';

const prov: DataProvenance = { source: 'FIXTURE: synthetic test data (not real airport data)', retrievedOn: '2025-01-01', approximate: true, notes: 'Used only by automated tests.' };
const ARP: LatLon = { lat: 40, lon: -75 };
const toLatLon = (p: Vec2): LatLon => ({ lat: ARP.lat + p.y / 111320, lon: ARP.lon + p.x / (111320 * Math.cos(deg2rad(ARP.lat))) });

function makeEnd(id: string, pos: Vec2, hdg: number): RunwayEnd {
  return { id, threshold: pos, thresholdLatLon: toLatLon(pos), trueHeadingDeg: hdg, magneticHeadingDeg: hdg, tdzeFt: 100, ils: null };
}
function makeRunway(id: string, a: RunwayEnd, b: RunwayEnd, widthM = 45.72): Runway {
  const len = dist(a.threshold, b.threshold);
  const u = { x: (b.threshold.x - a.threshold.x) / len, y: (b.threshold.y - a.threshold.y) / len };
  const n = { x: -u.y * (widthM / 2), y: u.x * (widthM / 2) };
  const polygon = [
    { x: a.threshold.x + n.x, y: a.threshold.y + n.y }, { x: b.threshold.x + n.x, y: b.threshold.y + n.y },
    { x: b.threshold.x - n.x, y: b.threshold.y - n.y }, { x: a.threshold.x - n.x, y: a.threshold.y - n.y },
  ];
  return { id, ends: [a, b], lengthFt: len / 0.3048, widthFt: widthM / 0.3048, surface: 'ASPH', polygon };
}

export const MULTI_CONFIGS: RunwayConfiguration[] = [
  { id: 'W-SEG', name: 'West flow, segregated', landing: ['27R'], departing: ['27L'], notes: 'FIXTURE', provenance: prov },
  { id: 'E-SEG', name: 'East flow, segregated', landing: ['9L'], departing: ['9R'], notes: 'FIXTURE', provenance: prov },
  { id: 'W-DUAL', name: 'West flow, dual arrivals', landing: ['27R', '27L'], departing: ['27L'], notes: 'FIXTURE', provenance: prov },
  { id: 'N-ALL', name: 'North flow', landing: ['35'], departing: ['35'], notes: 'FIXTURE', provenance: prov },
];

export function createMultiRunwayAirport(): Airport {
  const nodes: Record<string, TaxiNode> = {};
  const edges: TaxiEdge[] = [];
  const node = (id: string, kind: TaxiNodeKind, x: number, y: number, taxiways: string[], extra: Partial<TaxiNode> = {}) => {
    const pos = { x, y };
    nodes[id] = { id, kind, pos, latLon: toLatLon(pos), taxiways, ...extra };
  };
  let n = 0;
  const link = (a: string, b: string, taxiway: string, extra: Partial<TaxiEdge> = {}) => {
    edges.push({ id: `e${++n}`, from: a, to: b, taxiway, lengthM: dist(nodes[a].pos, nodes[b].pos), ...extra });
  };

  const NORTH = '9L/27R';
  const SOUTH = '9R/27L';
  const XS = [-1400, -700, 700, 1400];
  const cols: Record<number, string> = { [-1400]: 'W2', [-700]: 'W1', 700: 'E1', 1400: 'E2' };
  // taxiway A nodes
  for (const x of XS) node(`A${cols[x]}`, 'intersection', x, 0, ['A', cols[x]]);
  node('A_300', 'intersection', -300, 0, ['A']);
  node('A_hW', 'holding_position', -60, 0, ['A'], { runwayId: '17/35' });
  node('A_X', 'runway', 0, 0, ['A'], { runwayId: '17/35' });
  node('A_hE', 'holding_position', 60, 0, ['A'], { runwayId: '17/35' });
  // apron and stands
  node('AP', 'apron', -300, -200, ['RAMP']);
  node('GATE-1', 'parking', -360, -260, ['RAMP'], { name: 'Gate 1' });
  node('GATE-2', 'parking', -300, -260, ['RAMP'], { name: 'Gate 2' });
  node('GA1', 'parking', -240, -260, ['RAMP'], { name: 'GA Ramp 1' });
  link('GATE-1', 'AP', 'RAMP'); link('GATE-2', 'AP', 'RAMP'); link('GA1', 'AP', 'RAMP'); link('AP', 'A_300', 'RAMP');
  // connectors, hold lines and runway entry nodes for both parallels
  const runwayNodes: Record<string, string[]> = { [NORTH]: [], [SOUTH]: [] };
  for (const [rid, y, sgn, tag] of [[NORTH, 610, 1, 'N'], [SOUTH, -610, -1, 'S']] as const) {
    for (const x of XS) {
      const col = cols[x];
      const end = rid === NORTH ? (x < 0 ? '9L' : '27R') : (x < 0 ? '9R' : '27L');
      node(`H${tag}${col}`, 'holding_position', x, y - sgn * 60, [col], { runwayId: rid, protectsRunwayEnd: end });
      node(`R${tag}${col}`, 'runway', x, y, [col], { runwayId: rid });
      link(`A${col}`, `H${tag}${col}`, col);
      link(`H${tag}${col}`, `R${tag}${col}`, col, { onRunwayId: rid });
      runwayNodes[rid].push(`R${tag}${col}`);
    }
  }
  // threshold nodes and the centreline edges of the parallels (the 17/35 crossing node X1 / X2 is on both centrelines)
  node('X1', 'runway', 0, 610, [], { runwayId: NORTH, runwayIds: [NORTH, '17/35'] });
  node('X2', 'runway', 0, -610, [], { runwayId: SOUTH, runwayIds: [SOUTH, '17/35'] });
  for (const [rid, y, tag, x1] of [[NORTH, 610, 'N', 'X1'], [SOUTH, -610, 'S', 'X2']] as const) {
    node(`T${tag}W`, 'runway', -1500, y, [], { runwayId: rid });
    node(`T${tag}E`, 'runway', 1500, y, [], { runwayId: rid });
    const seq = [`T${tag}W`, `R${tag}W2`, `R${tag}W1`, x1, `R${tag}E1`, `R${tag}E2`, `T${tag}E`];
    for (let i = 0; i + 1 < seq.length; i++) link(seq[i], seq[i + 1], `RWY${rid}`, { onRunwayId: rid });
  }
  // taxiway A
  const aSeq = ['AW2', 'AW1', 'A_300', 'A_hW', 'A_X', 'A_hE', 'AE1', 'AE2'];
  for (let i = 0; i + 1 < aSeq.length; i++) link(aSeq[i], aSeq[i + 1], 'A', aSeq[i] === 'A_hW' || aSeq[i] === 'A_X' ? { onRunwayId: '17/35' } : {});
  // 17/35 centreline
  node('T17', 'runway', 0, 1000, [], { runwayId: '17/35' });
  node('T35', 'runway', 0, -1000, [], { runwayId: '17/35' });
  for (const [a, b] of [['T17', 'X1'], ['X1', 'A_X'], ['A_X', 'X2'], ['X2', 'T35']]) link(a, b, 'RWY17/35', { onRunwayId: '17/35' });
  // short unrelated runway (no taxiway)
  node('T6', 'runway', -3200, -2000, [], { runwayId: '6/24' });
  node('T24', 'runway', -2581, -1613, [], { runwayId: '6/24' });
  link('T6', 'T24', 'RWY6/24', { onRunwayId: '6/24' });
  node('HW6', 'holding_position', -3240, -1950, ['W'], { runwayId: '6/24', protectsRunwayEnd: '6' });
  link('AW2', 'HW6', 'W');
  link('HW6', 'T6', 'W', { onRunwayId: '6/24' });

  const ends = {
    '9L': makeEnd('9L', { x: -1500, y: 610 }, 90), '27R': makeEnd('27R', { x: 1500, y: 610 }, 270),
    '9R': makeEnd('9R', { x: -1500, y: -610 }, 90), '27L': makeEnd('27L', { x: 1500, y: -610 }, 270),
    '17': makeEnd('17', { x: 0, y: 1000 }, 180), '35': makeEnd('35', { x: 0, y: -1000 }, 0),
    '6': makeEnd('6', { x: -3200, y: -2000 }, 58), '24': makeEnd('24', { x: -2581, y: -1613 }, 238),
  };
  const park = (id: string, name: string, category: 'airline' | 'ga') => ({ id, name, nodeId: id, pos: nodes[id].pos, category, headingDeg: 0 });
  return {
    icao: 'KMUL', faaId: 'MUL', name: 'Multi Runway (FIXTURE)', arp: ARP, elevationFt: 100, magneticVariationDeg: 0,
    runways: [makeRunway('9L/27R', ends['9L'], ends['27R']), makeRunway('9R/27L', ends['9R'], ends['27L']), makeRunway('17/35', ends['17'], ends['35']), makeRunway('6/24', ends['6'], ends['24'], 23)],
    taxiwayGraph: { nodes, edges, taxiwayPolylines: {}, aprons: [], provenance: prov },
    parking: [park('GATE-1', 'Gate 1', 'airline'), park('GATE-2', 'Gate 2', 'airline'), park('GA1', 'GA Ramp 1', 'ga')],
    frequencies: [
      { id: 'CLNC', name: 'Multi Clearance', mhz: 127.85, position: 'CLNC', provenance: prov },
      { id: 'GND', name: 'Multi Ground', mhz: 121.9, position: 'GND', provenance: prov },
      { id: 'TWR', name: 'Multi Tower', mhz: 120.3, position: 'TWR', provenance: prov },
      { id: 'APP', name: 'Multi Approach', mhz: 124.6, position: 'APP', provenance: prov },
      { id: 'DEP', name: 'Multi Departure', mhz: 124.6, position: 'DEP', provenance: prov },
    ],
    navaids: [], procedures: [], hotSpots: [], airspaceClass: 'D', timeZone: 'Europe/London', runwayConfigurations: MULTI_CONFIGS, provenance: [prov],
  };
}
