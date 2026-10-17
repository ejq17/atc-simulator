/**
 * SYNTHETIC fixture airport for engine tests. It is "roughly like" KACY (two
 * perpendicular crossing runways 13/31 and 4/22, parallel/connector taxiways A-D)
 * but is NOT real data. Everything here, including the radio frequencies, is
 * placeholder test data and must never be shown to a user as KACY information.
 *
 * Layout (runway frame: s along 13->31, t along 4->22, both in metres from the
 * runway intersection X at (0,0)):
 *
 *   22 end  A_N ---H22--R22                          t=+1100
 *            |
 *   B  AP --A_J-----B_h--B_r422--B_h------BD            t=+400   (apron A_J..AP, GA ramp parking)
 *            |        |            |        |
 *   13/31 R13-A_r13---------X---------D_r13---------R31 t=0
 *            |        |            |        |
 *   C  C_W---AC-----C_h--C_r422--C_h------CD----C_E     t=-250
 *            |
 *   4 end   A_S ---H4---R4                           t=-680
 */
import type { Airport, DataProvenance, InstrumentProcedure, LatLon, NavigationAid, Runway, RunwayEnd, TaxiEdge, TaxiNode, TaxiNodeKind, Vec2 } from '../types';
import { deg2rad, dist, headingToVec } from '../geo';

const prov: DataProvenance = {
  source: 'FIXTURE: synthetic test data (not real airport data)',
  retrievedOn: '2025-01-01',
  approximate: true,
  notes: 'Used only by automated tests.',
};

const ARP: LatLon = { lat: 39.45, lon: -74.57 };
export const FIXTURE_MAG_VAR = -12; // 12 degrees west

const toLatLon = (p: Vec2): LatLon => ({
  lat: ARP.lat + p.y / 111320,
  lon: ARP.lon + p.x / (111320 * Math.cos(deg2rad(ARP.lat))),
});

const U13 = headingToVec(118); // +s
const U4 = headingToVec(28); // +t
/** Position from runway-frame coordinates. */
export const P = (s: number, t: number): Vec2 => ({ x: s * U13.x + t * U4.x, y: s * U13.y + t * U4.y });

function makeEnd(id: string, s: number, t: number, trueHdg: number): RunwayEnd {
  const pos = P(s, t);
  return {
    id,
    threshold: pos,
    thresholdLatLon: toLatLon(pos),
    trueHeadingDeg: trueHdg,
    magneticHeadingDeg: (trueHdg - FIXTURE_MAG_VAR + 360) % 360,
    tdzeFt: 75,
    ils: null,
  };
}

function makeRunway(id: string, a: RunwayEnd, b: RunwayEnd, widthM = 45.72): Runway {
  const dir = { x: b.threshold.x - a.threshold.x, y: b.threshold.y - a.threshold.y };
  const len = Math.hypot(dir.x, dir.y);
  const u = { x: dir.x / len, y: dir.y / len };
  const n = { x: -u.y * (widthM / 2), y: u.x * (widthM / 2) };
  const polygon = [
    { x: a.threshold.x + n.x, y: a.threshold.y + n.y },
    { x: b.threshold.x + n.x, y: b.threshold.y + n.y },
    { x: b.threshold.x - n.x, y: b.threshold.y - n.y },
    { x: a.threshold.x - n.x, y: a.threshold.y - n.y },
  ];
  return { id, ends: [a, b], lengthFt: len / 0.3048, widthFt: widthM / 0.3048, surface: 'ASPH', polygon };
}

export const FIXTURE_PARKING_IDS = ['GA1', 'GA2', 'GA3'] as const;

/** Point `dNm` before the threshold of `end` on its extended centreline (negative = past the threshold), `crossNm` to the right of the course. */
function onFinal(end: RunwayEnd, dNm: number, crossNm = 0): Vec2 {
  const dir = headingToVec(end.trueHeadingDeg);
  const right = { x: dir.y, y: -dir.x };
  return {
    x: end.threshold.x - dir.x * dNm * 1852 + right.x * crossNm * 1852,
    y: end.threshold.y - dir.y * dNm * 1852 + right.y * crossNm * 1852,
  };
}

/** SYNTHETIC fixes and procedures with the same shape as the real KACY data (IF/IAF -> FAF -> missed approach). Not real. */
function fixtureNav(r13: RunwayEnd, r31: RunwayEnd, r4: RunwayEnd, r22: RunwayEnd): { navaids: NavigationAid[]; procedures: InstrumentProcedure[] } {
  const navaids: NavigationAid[] = [];
  const add = (id: string, pos: Vec2, type: NavigationAid['type'] = 'FIX', name?: string) =>
    navaids.push({ id, type, name, pos, latLon: toLatLon(pos), provenance: prov, ...(type === 'VOR/DME' ? { frequencyMhz: 115.2 } : {}) });
  // ILS / LOC 13: feeder VOR -> IF -> FAF; missed approach fix past the airport
  add('TVO', onFinal(r13, 17.5, 4.3), 'VOR/DME', 'TESTVILLE');
  add('FX13A', onFinal(r13, 10.66));
  add('FX13B', onFinal(r13, 4.55));
  add('FX13M', onFinal(r13, -8.05));
  add('TARR', onFinal(r13, 24, 8)); // arrival fix NW of the airport
  // RNAV 22: course offset a few degrees from the runway heading, like the real one
  add('FX22F', onFinal(r22, 8.36, 7.54));
  add('FX22A', onFinal(r22, 8.88, 1.55));
  add('FX22B', onFinal(r22, 5.11, 0.54));
  add('FX22C', onFinal(r22, 3.08, 0));
  add('FX22M', onFinal(r22, -9.1, 4.45));
  // RNAV 4
  add('FX04F', onFinal(r4, 13, -9.96));
  add('FX04A', onFinal(r4, 12.99));
  add('FX04B', onFinal(r4, 5.0));
  add('FX04C', onFinal(r4, 1.3));
  // VOR 31
  add('FX31A', onFinal(r31, 10.13, 1.01));
  add('FX31B', onFinal(r31, 4.16, 0.4));
  // en-route VOR southeast
  add('TSE', { x: 12000, y: -42000 }, 'VOR', 'TEST SEA');
  const iap = (id: string, name: string, runwayEnd: string, fixes: string[]): InstrumentProcedure => ({ id, name, type: 'IAP', runwayEnd, chartPdfUrl: '', fixes, provenance: prov });
  const procedures: InstrumentProcedure[] = [
    iap('FIX-ILS-OR-LOC-RWY-13', 'ILS OR LOC RWY 13', '13', ['TVO', 'FX13A', 'FX13B', 'FX13M']),
    iap('FIX-RNAV-GPS-RWY-22', 'RNAV (GPS) RWY 22', '22', ['FX22F', 'FX22A', 'FX22B', 'FX22C', 'FX22M']),
    iap('FIX-RNAV-GPS-RWY-04', 'RNAV (GPS) RWY 04', '4', ['FX04F', 'FX04A', 'FX04B', 'FX04C']),
    iap('FIX-VOR-RWY-31', 'VOR RWY 31', '31', ['FX31A', 'FX31B']),
    { id: 'FIX-ATLANTIC-CITY-THREE', name: 'ATLANTIC CITY THREE DEPARTURE', type: 'DP', chartPdfUrl: '', provenance: prov },
  ];
  return { navaids, procedures };
}

export function createTestAirport(): Airport {
  const nodes: Record<string, TaxiNode> = {};
  const edges: TaxiEdge[] = [];
  const node = (
    id: string,
    kind: TaxiNodeKind,
    s: number,
    t: number,
    taxiways: string[],
    extra: Partial<TaxiNode> = {},
  ) => {
    const pos = P(s, t);
    nodes[id] = { id, kind, pos, latLon: toLatLon(pos), taxiways, ...extra };
  };
  let edgeN = 0;
  const link = (a: string, b: string, taxiway: string, extra: Partial<TaxiEdge> = {}) => {
    edges.push({ id: `e${++edgeN}`, from: a, to: b, taxiway, lengthM: dist(nodes[a].pos, nodes[b].pos), ...extra });
  };

  // Parking + apron
  node('GA1', 'parking', -540, 470, ['RAMP'], { name: 'GA Ramp 1' });
  node('GA2', 'parking', -480, 490, ['RAMP'], { name: 'GA Ramp 2' });
  node('GA3', 'parking', -420, 470, ['RAMP'], { name: 'GA Ramp 3' });
  node('GATE-1', 'parking', -620, 380, ['RAMP'], { name: 'Gate 1' });
  node('GATE-2', 'parking', -620, 320, ['RAMP'], { name: 'Gate 2' });
  node('FBO-1', 'parking', -340, 470, ['RAMP'], { name: 'FBO Ramp 1' });
  node('AP', 'apron', -480, 400, ['RAMP', 'B']);

  // Taxiway A (s = -200)
  node('A_S', 'taxiway', -200, -680, ['A']);
  node('AC', 'intersection', -200, -250, ['A', 'C']);
  node('A_h13S', 'holding_position', -200, -60, ['A'], { runwayId: '13/31' });
  node('A_r13', 'runway', -200, 0, ['A'], { runwayId: '13/31' });
  node('A_h13N', 'holding_position', -200, 60, ['A'], { runwayId: '13/31' });
  node('A_J', 'intersection', -200, 400, ['A', 'B']);
  node('A_N', 'taxiway', -200, 1100, ['A']);
  // End stubs (named A) to the 4 and 22 thresholds
  node('H4', 'holding_position', -70, -680, ['A'], { runwayId: '4/22', protectsRunwayEnd: '4' });
  node('R4', 'runway', 0, -680, ['A'], { runwayId: '4/22' });
  node('H22', 'holding_position', -70, 1100, ['A'], { runwayId: '4/22', protectsRunwayEnd: '22' });
  node('R22', 'runway', 0, 1100, ['A'], { runwayId: '4/22' });

  // Taxiway C (t = -250)
  node('C_W', 'taxiway', -950, -250, ['C']);
  node('H13', 'holding_position', -950, -60, ['C'], { runwayId: '13/31', protectsRunwayEnd: '13' });
  node('R13', 'runway', -950, 0, ['C'], { runwayId: '13/31' });
  node('C_h422S', 'holding_position', -60, -250, ['C'], { runwayId: '4/22' });
  node('C_r422', 'runway', 0, -250, ['C'], { runwayId: '4/22' });
  node('C_h422N', 'holding_position', 60, -250, ['C'], { runwayId: '4/22' });
  node('CD', 'intersection', 500, -250, ['C', 'D']);
  node('C_E', 'taxiway', 1990, -250, ['C']);
  node('H31', 'holding_position', 1990, -60, ['C'], { runwayId: '13/31', protectsRunwayEnd: '31' });
  node('R31', 'runway', 1990, 0, ['C'], { runwayId: '13/31' });

  // Taxiway D (s = 500)
  node('D_h13S', 'holding_position', 500, -60, ['D'], { runwayId: '13/31' });
  node('D_r13', 'runway', 500, 0, ['D'], { runwayId: '13/31' });
  node('D_h13N', 'holding_position', 500, 60, ['D'], { runwayId: '13/31' });
  node('BD', 'intersection', 500, 400, ['B', 'D']);

  // Taxiway B (t = +400)
  node('B_h422W', 'holding_position', -60, 400, ['B'], { runwayId: '4/22' });
  node('B_r422', 'runway', 0, 400, ['B'], { runwayId: '4/22' });
  node('B_h422E', 'holding_position', 60, 400, ['B'], { runwayId: '4/22' });
  node('X', 'runway', 0, 0, [], { runwayId: '13/31' });

  // Ramp
  link('GA1', 'AP', 'RAMP');
  link('GA2', 'AP', 'RAMP');
  link('GA3', 'AP', 'RAMP');
  link('GATE-1', 'AP', 'RAMP');
  link('GATE-2', 'AP', 'RAMP');
  link('FBO-1', 'AP', 'RAMP');
  link('AP', 'A_J', 'B');
  // A
  link('A_S', 'AC', 'A');
  link('AC', 'A_h13S', 'A');
  link('A_h13S', 'A_r13', 'A', { onRunwayId: '13/31' });
  link('A_r13', 'A_h13N', 'A', { onRunwayId: '13/31' });
  link('A_h13N', 'A_J', 'A');
  link('A_J', 'A_N', 'A');
  link('A_S', 'H4', 'A');
  link('H4', 'R4', 'A', { onRunwayId: '4/22' });
  link('A_N', 'H22', 'A');
  link('H22', 'R22', 'A', { onRunwayId: '4/22' });
  // B
  link('A_J', 'B_h422W', 'B');
  link('B_h422W', 'B_r422', 'B', { onRunwayId: '4/22' });
  link('B_r422', 'B_h422E', 'B', { onRunwayId: '4/22' });
  link('B_h422E', 'BD', 'B');
  // C
  link('C_W', 'AC', 'C');
  link('C_W', 'H13', 'C');
  link('H13', 'R13', 'C', { onRunwayId: '13/31' });
  link('AC', 'C_h422S', 'C');
  link('C_h422S', 'C_r422', 'C', { onRunwayId: '4/22' });
  link('C_r422', 'C_h422N', 'C', { onRunwayId: '4/22' });
  link('C_h422N', 'CD', 'C');
  link('CD', 'C_E', 'C');
  link('C_E', 'H31', 'C');
  link('H31', 'R31', 'C', { onRunwayId: '13/31' });
  // D
  link('CD', 'D_h13S', 'D');
  link('D_h13S', 'D_r13', 'D', { onRunwayId: '13/31' });
  link('D_r13', 'D_h13N', 'D', { onRunwayId: '13/31' });
  link('D_h13N', 'BD', 'D');
  // Runway centrelines (runway travel / back-taxi)
  link('R13', 'A_r13', 'RWY13/31', { onRunwayId: '13/31' });
  link('A_r13', 'X', 'RWY13/31', { onRunwayId: '13/31' });
  link('X', 'D_r13', 'RWY13/31', { onRunwayId: '13/31' });
  link('D_r13', 'R31', 'RWY13/31', { onRunwayId: '13/31' });
  link('R4', 'C_r422', 'RWY4/22', { onRunwayId: '4/22' });
  link('C_r422', 'X', 'RWY4/22', { onRunwayId: '4/22' });
  link('X', 'B_r422', 'RWY4/22', { onRunwayId: '4/22' });
  link('B_r422', 'R22', 'RWY4/22', { onRunwayId: '4/22' });

  const r13 = makeEnd('13', -1000, 0, 118);
  const r31 = makeEnd('31', 2048, 0, 298);
  const r4 = makeEnd('4', 0, -700, 28);
  const r22 = makeEnd('22', 0, 1173, 208);
  const nav = fixtureNav(r13, r31, r4, r22);

  return {
    icao: 'KTST',
    faaId: 'TST',
    name: 'Atlantic City International (FIXTURE)',
    arp: ARP,
    elevationFt: 75,
    magneticVariationDeg: FIXTURE_MAG_VAR,
    runways: [makeRunway('13/31', r13, r31), makeRunway('4/22', r4, r22)],
    taxiwayGraph: {
      nodes,
      edges,
      taxiwayPolylines: {},
      aprons: [],
      provenance: prov,
    },
    parking: [
      { id: 'GA1', name: 'GA Ramp 1', nodeId: 'GA1', pos: nodes.GA1.pos, category: 'ga', headingDeg: 200 },
      { id: 'GA2', name: 'GA Ramp 2', nodeId: 'GA2', pos: nodes.GA2.pos, category: 'ga', headingDeg: 200 },
      { id: 'GA3', name: 'GA Ramp 3', nodeId: 'GA3', pos: nodes.GA3.pos, category: 'ga', headingDeg: 200 },
      { id: 'GATE-1', name: 'Gate 1', nodeId: 'GATE-1', pos: nodes['GATE-1'].pos, category: 'airline', headingDeg: 200 },
      { id: 'GATE-2', name: 'Gate 2', nodeId: 'GATE-2', pos: nodes['GATE-2'].pos, category: 'airline', headingDeg: 200 },
      { id: 'FBO-1', name: 'FBO Ramp 1', nodeId: 'FBO-1', pos: nodes['FBO-1'].pos, category: 'fbo', headingDeg: 200 },
    ],
    // FIXTURE-ONLY PLACEHOLDER frequencies. Not real KACY values.
    frequencies: [
      { id: 'CLNC', name: 'Atlantic City Clearance Delivery', mhz: 127.85, position: 'CLNC', provenance: prov }, // placeholder
      { id: 'GND', name: 'Atlantic City Ground', mhz: 121.9, position: 'GND', provenance: prov }, // placeholder
      { id: 'TWR', name: 'Atlantic City Tower', mhz: 120.3, position: 'TWR', provenance: prov }, // placeholder
      { id: 'APP', name: 'Atlantic City Approach', mhz: 124.6, position: 'APP', provenance: prov }, // placeholder
      { id: 'DEP', name: 'Atlantic City Departure', mhz: 124.6, position: 'DEP', provenance: prov }, // placeholder (shares the Approach frequency, like KACY)
    ],
    navaids: nav.navaids,
    procedures: nav.procedures,
    hotSpots: [],
    airspaceClass: 'D',
    provenance: [prov],
  };
}
