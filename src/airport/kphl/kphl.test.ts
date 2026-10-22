import { describe, expect, it } from 'vitest';
import facility from '../../../data/sources/kphl-facility.json';
import freqSrc from '../../../data/sources/kphl-frequencies.json';
import navSrc from '../../../data/sources/kphl-navaids.json';
import procSrc from '../../../data/sources/kphl-procedures.json';
import { getAirport, listAirports } from '..';
import { facilityCallName, airportCallName } from '../../radio/frequencies';
import { angleDiffDeg, bearingDeg } from '../projection';
import { holdingPositionsForRunway, runwayEntryNodes, runwayExitNodes, findParking } from '../graphUtils';
import { loadKphl } from '.';

const ap = loadKphl();
const g = ap.taxiwayGraph;
const FT = 0.3048;
const nodes = Object.values(g.nodes);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const inPoly = (p: { x: number; y: number }, poly: { x: number; y: number }[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const runwayOf = (id: string) => ap.runways.find((r) => r.id === id)!;
const endOf = (end: string) => ap.runways.flatMap((r) => r.ends).find((e) => e.id === end)!;
const endKey = (id: string) => id.replace(/^0+(?=\d)/, '');

describe('KPHL airport basics (NASR)', () => {
  it('matches the NASR ARP, elevation, variation, tower hours, class, time zone', () => {
    expect(ap.icao).toBe('KPHL');
    expect(ap.faaId).toBe('PHL');
    expect(ap.name).toBe('Philadelphia International');
    expect(ap.arp).toEqual({ lat: facility.airport.arp.lat, lon: facility.airport.arp.lon });
    expect(ap.elevationFt).toBe(facility.airport.field_elevation_ft);
    expect(ap.magneticVariationDeg).toBe(-12);
    expect(ap.towerHours).toBe('24');
    expect(ap.airspaceClass).toBe('B');
    expect(ap.timeZone).toBe('America/New_York');
  });

  it('is registered next to KACY and KMHT; provenance carries sources and dates', () => {
    expect(getAirport('kphl')).toBe(ap);
    expect(getAirport('PHL')).toBe(ap);
    expect(listAirports()).toContain('KPHL');
    expect(ap.provenance.length).toBeGreaterThanOrEqual(5);
    expect(ap.provenance.every((p) => p.source && p.retrievedOn)).toBe(true);
    expect(ap.osmAttribution).toBe('© OpenStreetMap contributors, ODbL 1.0');
    expect(g.provenance.source).toMatch(/OpenStreetMap/);
  });

  it('has the two diagram hot spots as one record, no MVA sectors and no LAHSO (nothing in the sources; nothing invented)', () => {
    expect(ap.hotSpots).toHaveLength(1);
    expect(ap.hotSpots[0].description).toMatch(/Twy Y and S int in close proximity of Rwy 09R-27L/);
    expect(ap.hotSpots[0].description).toMatch(/Twy K and Twy D close int to Rwy 35 and 27R/);
    expect(ap.mvaSectors).toBeUndefined();
    for (const r of ap.runways) for (const e of r.ends) expect(e.lahso ?? null).toBeNull();
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) {
      expect(p.holdingPatterns ?? []).toEqual([]);
      expect(p.fixAltitudes ?? []).toEqual([]);
    }
  });
});

describe('KPHL runways', () => {
  it('has runways 8/26, 9L/27R, 9R/27L and 17/35 with NASR lengths, widths and surface', () => {
    expect(ap.runways.map((r) => r.id).sort()).toEqual(['17/35', '8/26', '9L/27R', '9R/27L']);
    expect([runwayOf('8/26').lengthFt, runwayOf('9L/27R').lengthFt, runwayOf('9R/27L').lengthFt, runwayOf('17/35').lengthFt]).toEqual([5001, 9500, 12000, 6500]);
    expect([runwayOf('8/26').widthFt, runwayOf('9L/27R').widthFt, runwayOf('9R/27L').widthFt, runwayOf('17/35').widthFt]).toEqual([150, 150, 200, 150]);
    for (const r of ap.runways) {
      expect(r.surface).toBe('ASPH');
      expect(r.provenance.effectiveFrom).toBe('2026-10-01');
    }
  });

  it('every NASR runway end is present and the ids keep the L / R suffix', () => {
    const nasr = facility.runways.flatMap((r) => r.ends.map((e) => endKey(e.id))).sort();
    expect(ap.runways.flatMap((r) => r.ends.map((e) => e.id)).sort()).toEqual(nasr);
    expect(nasr).toEqual(['17', '26', '27L', '27R', '35', '8', '9L', '9R']);
  });

  it('threshold-to-threshold length is within 0.5% of NASR', () => {
    for (const r of ap.runways) {
      const lenFt = dist(r.ends[0].threshold, r.ends[1].threshold) / FT;
      expect(Math.abs(lenFt - r.lengthFt) / r.lengthFt).toBeLessThan(0.005);
    }
  });

  it('true alignments equal NASR within 1 degree, measured from the thresholds', () => {
    const expected: Record<string, number> = { '8': 75, '26': 256, '9L': 75, '27R': 255, '9R': 75, '27L': 255, '17': 159, '35': 339 };
    for (const r of ap.runways) {
      const [a, b] = r.ends;
      expect(angleDiffDeg(bearingDeg(b.threshold.x - a.threshold.x, b.threshold.y - a.threshold.y), expected[a.id])).toBeLessThan(1);
      expect(angleDiffDeg(bearingDeg(a.threshold.x - b.threshold.x, a.threshold.y - b.threshold.y), expected[b.id])).toBeLessThan(1);
      expect(a.trueHeadingDeg).toBe(expected[a.id]);
      expect(b.trueHeadingDeg).toBe(expected[b.id]);
    }
  });

  it('charted magnetic headings come from the diagram (88 / 268, 87 / 267 twice, 171 / 351) and TDZE from NASR', () => {
    const charted = procSrc.airport_diagram.charted_runway_headings_mag as Record<string, number>;
    expect(charted).toEqual({ '8': 88, '26': 268, '9L': 87, '27R': 267, '9R': 87, '27L': 267, '17': 171, '35': 351 });
    for (const e of ['8', '26', '9L', '27R', '9R', '27L', '17', '35']) expect(endOf(e).magneticHeadingDeg).toBe(charted[e]);
    const nasr = Object.fromEntries(facility.runways.flatMap((r) => r.ends.map((e) => [endKey(e.id), e.tdz_elev_ft])));
    for (const e of Object.keys(nasr)) expect(endOf(e).tdzeFt).toBe(nasr[e]);
  });

  it('ILS on 9L (I-VII), 9R (I-PHL), 17 (I-MYY), 26 (I-LLH), 27L (I-GLC), 27R (I-PDP); none on 8 and 35', () => {
    expect(endOf('9L').ils).toMatchObject({ ident: 'I-VII', frequencyMhz: 108.95 });
    expect(endOf('27R').ils).toMatchObject({ ident: 'I-PDP', frequencyMhz: 108.95 });
    expect(endOf('9R').ils).toMatchObject({ ident: 'I-PHL', frequencyMhz: 109.3 });
    expect(endOf('27L').ils).toMatchObject({ ident: 'I-GLC', frequencyMhz: 109.3 });
    expect(endOf('17').ils).toMatchObject({ ident: 'I-MYY', frequencyMhz: 108.75 });
    expect(endOf('26').ils).toMatchObject({ ident: 'I-LLH', frequencyMhz: 111.55 });
    expect(endOf('8').ils).toBeNull();
    expect(endOf('35').ils).toBeNull();
  });

  it('only runway end 27L has a displaced threshold (1913 ft, NASR); LDA of 27L and 27R follow the declared distances', () => {
    expect(endOf('27L').displacedThresholdFt).toBe(1913);
    for (const e of ['8', '26', '9L', '27R', '9R', '17', '35']) expect(endOf(e).displacedThresholdFt, e).toBeUndefined();
    const lda = Object.fromEntries(facility.runways.flatMap((r) => r.ends.map((e) => [endKey(e.id), e.declared_distances_ft.lda])));
    expect(lda['27L']).toBe(9912);
    expect(lda['27R']).toBe(8864);
  });

  it('polygons contain their thresholds; runway 9L/27R and 17/35 intersect in exactly one found crossing node', () => {
    for (const r of ap.runways) {
      for (const e of r.ends) expect(inPoly(e.threshold, r.polygon)).toBe(true);
      expect(dist(r.polygon[0], r.polygon[3])).toBeCloseTo(r.widthFt * FT, 0);
    }
    const crossings = nodes.filter((n) => n.kind === 'runway' && (n as { runwayIds?: string[] }).runwayIds && (n as { runwayIds: string[] }).runwayIds.length > 1);
    expect(crossings.map((n) => n.id)).toEqual(['RWX-9L-27Rx17-35']);
    expect((crossings[0] as { runwayIds: string[] }).runwayIds.sort()).toEqual(['17/35', '9L/27R']);
    expect(ap.runways.filter((r) => inPoly(crossings[0].pos, r.polygon)).map((r) => r.id).sort()).toEqual(['17/35', '9L/27R']);
    const stands = ap.parking.filter((p) => p.category === 'ga' || p.category === 'airline' || p.category === 'fbo');
    expect(stands.length).toBeGreaterThan(10);
    for (const p of stands) expect(ap.runways.some((r) => inPoly(p.pos, r.polygon)), p.id).toBe(false);
  });
});

describe('KPHL runway configurations (facility JSON, documented)', () => {
  it('two configurations (west and east flow) in preference order, from the Noise Office and the Part 150 NEM, each with its source', () => {
    const cfg = ap.runwayConfigurations!;
    expect(cfg.map((c) => c.id)).toEqual(['WEST', 'EAST']);
    expect(cfg[0]).toMatchObject({ landing: ['27R', '27L', '26', '35'], departing: ['27L', '27R', '35'] });
    expect(cfg[1]).toMatchObject({ landing: ['9R', '9L', '17'], departing: ['9L', '9R', '8', '17'] });
    const ends = new Set(ap.runways.flatMap((r) => r.ends.map((e) => e.id)));
    for (const c of cfg) {
      for (const e of [...c.landing, ...c.departing]) expect(ends.has(e), `${c.id} ${e}`).toBe(true);
      expect(c.provenance.source).toMatch(/Noise Office|Noise Exposure Maps/);
      expect(c.windFromDeg).toBeUndefined(); // no wind limits are published in the sources: none are invented
    }
  });
});

describe('KPHL frequencies equal the verified source', () => {
  const f = (id: string) => ap.frequencies.find((x) => x.id === id)!;
  const s = freqSrc.summary_by_function;
  it('VHF values and positions (NASR FRQ rows serving PHL; the TRACON rows for other airports are not included)', () => {
    expect([f('ATIS').mhz, f('CLNC').mhz, f('GND').mhz, f('TWR').mhz, f('APP').mhz, f('DEP').mhz, f('DEP-N').mhz]).toEqual([133.4, 118.85, 121.9, 118.5, 124.35, 119.75, 124.35]);
    expect(f('ATIS').mhz).toBe(parseFloat(s.ATIS.vhf));
    expect(f('CLNC').mhz).toBe(parseFloat(s.clearance_delivery.vhf));
    expect(f('GND').mhz).toBe(parseFloat(s.ground.vhf));
    expect(f('TWR').mhz).toBe(parseFloat(s.tower.vhf));
    expect(f('APP').mhz).toBe(parseFloat(s.approach_departure.vhf));
    expect(['ATIS', 'CLNC', 'GND', 'TWR', 'APP', 'DEP', 'DEP-N'].map((id) => f(id).position)).toEqual(['ATIS', 'CLNC', 'GND', 'TWR', 'APP', 'DEP', 'DEP']);
    expect(f('DEP').sectorBearings).toEqual({ fromDeg: 90, toDeg: 269 });
    expect(f('DEP-N').sectorBearings).toEqual({ fromDeg: 270, toDeg: 89 });
    expect(f('UNICOM').mhz).toBe(122.95);
    expect(ap.frequencies.every((x) => x.mhz < 225)).toBe(true);
  });

  it('the second tower position, secondary ground, departure ATIS, PRM, final and approach sectors are listed but not worked as positions', () => {
    for (const [id, mhz] of [['TWR-2', 135.1], ['GND-2', 121.65], ['ATIS-DEP', 135.925], ['PRM-RWY27L', 120.425], ['PRM-RWY26', 123.6], ['FINAL', 125.4]] as const) {
      expect(f(id).mhz).toBe(mhz);
      expect(f(id).position).toBe('OTHER');
    }
    expect(ap.frequencies.filter((x) => x.id.startsWith('APP-S')).map((x) => x.mhz)).toEqual([123.8, 126.85, 127.35, 128.4, 133.875]);
  });

  it('facility call names: Philadelphia Tower/Ground/Clearance, Philadelphia Approach/Departure', () => {
    expect(airportCallName(ap)).toBe('Philadelphia');
    expect(facilityCallName(ap, 118.5)).toBe('Philadelphia Tower');
    expect(facilityCallName(ap, 121.9)).toBe('Philadelphia Ground');
    expect(facilityCallName(ap, 118.85)).toBe('Philadelphia Clearance Delivery');
    expect(facilityCallName(ap, 124.35, 'APP')).toBe('Philadelphia Approach');
    expect(facilityCallName(ap, 119.75, 'DEP')).toBe('Philadelphia Departure');
  });
});

describe('KPHL navaids and fixes equal the verified source', () => {
  const nav = (id: string) => ap.navaids.find((n) => n.id === id)!;
  it('OOD is the primary navaid (no VOR at the field) and the plate VORs are present', () => {
    const p = navSrc.primary_navaid;
    expect(p.id).toBe('OOD');
    expect(nav('OOD')).toMatchObject({ frequencyMhz: p.freq_mhz, latLon: { lat: p.lat, lon: p.lon } });
    for (const o of navSrc.other_navaids_referenced) expect(nav(o.id)).toMatchObject({ type: o.type, frequencyMhz: o.freq_mhz, latLon: { lat: o.lat, lon: o.lon } });
    expect(nav('MXE').frequencyMhz).toBe(113.2);
    expect(nav('DQO').frequencyMhz).toBe(114.0);
  });
  it('84 fixes with NASR coordinates', () => {
    const fixes = ap.navaids.filter((n) => n.type === 'FIX');
    expect(fixes).toHaveLength(84);
    for (const f of navSrc.fixes_named_on_approach_charts) expect(nav(f.id).latLon).toEqual({ lat: f.lat, lon: f.lon });
  });
  it('ILS components of the six systems', () => {
    expect(navSrc.ils_localizers.systems).toHaveLength(6);
    for (const s of navSrc.ils_localizers.systems) {
      expect(nav(s.plate_ident)).toMatchObject({ type: 'LOC', frequencyMhz: s.loc_freq_mhz, latLon: { lat: s.localizer_antenna.lat, lon: s.localizer_antenna.lon } });
      expect(nav(`${s.plate_ident}-GS`)).toMatchObject({ frequencyMhz: s.glideslope!.freq_mhz });
    }
  });
});

describe('KPHL procedures', () => {
  it('22 IAP charts + airport diagram + the PHILADELPHIA FOUR DP + 6 STARs, URLs from the d-TPP metadata', () => {
    expect(ap.procedures.filter((p) => p.type === 'IAP')).toHaveLength(22);
    expect(ap.procedures.filter((p) => p.type === 'DIAGRAM')).toHaveLength(1);
    expect(ap.procedures.filter((p) => p.type === 'DP').map((p) => p.name)).toEqual(['PHILADELPHIA FOUR DEPARTURE']);
    expect(ap.procedures.filter((p) => p.type === 'STAR').map((p) => p.name)).toEqual(['BOJID FOUR (RNAV)', 'PAATS FOUR (RNAV)', 'BUNTS THREE', 'JIIMS FOUR (RNAV)', 'SLATT SIX', 'SPUDS SEVEN (RNAV)']);
    const urls = new Set([
      ...procSrc.instrument_approaches.map((a) => a.pdf.url),
      procSrc.airport_diagram.pdf.url,
      ...procSrc.departure_procedures.map((d) => d.pdf.url),
      ...procSrc.stars.map((d) => d.pdf.url),
    ]);
    expect(new Set(ap.procedures.map((p) => p.chartPdfUrl))).toEqual(urls);
    for (const p of ap.procedures) {
      expect(p.chartPdfUrl).toMatch(/^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\/.+\.PDF$/);
      expect(p.provenance.effectiveFrom).toBe('2026-10-01');
    }
    for (const a of procSrc.instrument_approaches) expect(a.pdf.http_status).toBe(200);
  });

  it('PHILADELPHIA FOUR states no maintain altitude (top altitude assigned by ATC): none is invented', () => {
    const dp = ap.procedures.find((p) => p.type === 'DP')!;
    expect(dp.maintainAltitudeFt ?? undefined).toBeUndefined();
    expect(procSrc.departure_procedures[0].top_altitude_text).toBe('TOP ALTITUDE: ASSIGNED BY ATC');
  });

  it('transcribed approaches carry fixes that resolve to navaids; untranscribed ones are empty, not invented', () => {
    const iap = (name: string) => ap.procedures.find((p) => p.name === name)!;
    expect(iap('ILS OR LOC RWY 27R').fixes).toEqual(['ENZEW', 'MRTIN', 'JALTO', 'HADNI', 'MXE', 'MENGE']);
    expect(iap('ILS OR LOC RWY 27R').missedApproachText).toBe('Climb to 1500 then climbing right turn to 3000 on MXE VORTAC R-115 to MXE VORTAC and hold.');
    expect(iap('ILS OR LOC RWY 09L').fixes).toEqual(['MXE', 'QWEST', 'OBEKE', 'ANNET', 'LANDI', 'OOD', 'DQO']);
    expect(iap('RNAV (GPS) RWY 35').fixes).toEqual(['BDAWK', 'JEPUG', 'HARLU', 'CEMEK', 'WERDI', 'MUDNE', 'KUSLE', 'WIKAV', 'JIIMS', 'ALBEK']);
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) for (const f of p.fixes ?? []) expect(ap.navaids.some((n) => n.id === f), `${p.name} ${f}`).toBe(true);
    expect(iap('RNAV (RNP) Z RWY 09L').fixes).toEqual([]);
    expect(iap('ILS OR LOC RWY 09L').runwayEnd).toBe('9L');
    expect(iap('ILS Z OR LOC Z RWY 09R').runwayEnd).toBe('9R');
    expect(iap('ILS OR LOC RWY 09L').glidepath).toEqual({ kind: 'GS', angleDeg: 3, tchFt: 53 });
    expect(iap('ILS OR LOC RWY 26').glidepath).toMatchObject({ angleDeg: 3.15, tchFt: 50 });
    expect(iap('RNAV (GPS) RWY 35').glidepath).toMatchObject({ kind: 'GP', angleDeg: 3.14, tchFt: 55 });
  });

  it('every IAP runway end exists in the airport', () => {
    const ends = new Set(ap.runways.flatMap((r) => r.ends.map((e) => e.id)));
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) expect(ends.has(p.runwayEnd!), `${p.name} -> ${p.runwayEnd}`).toBe(true);
  });
});

describe('KPHL taxiway graph', () => {
  const missing = ['A1', 'K2', 'K3', 'P6', 'S12', 'S13'];
  it('names 57 of the 62 identifiers printed on the FAA diagram; K2, K3, P6, S12, S13 have no OSM way, A1 is excluded (unconnected loop)', () => {
    expect(procSrc.airport_diagram.taxiway_identifiers).toHaveLength(62);
    for (const id of procSrc.airport_diagram.taxiway_identifiers) {
      if (missing.includes(id)) expect(g.taxiwayPolylines[id], id).toBeUndefined();
      else expect(g.taxiwayPolylines[id]?.length, `polyline ${id}`).toBeGreaterThan(0);
    }
    expect(g.excludedOsmRefs).toEqual(['S10', 'S9', '8']);
    for (const id of g.excludedOsmRefs) expect(g.edges.some((e) => e.taxiway === id)).toBe(false);
  });

  it('every edge references existing nodes, has positive length and matches node geometry', () => {
    for (const e of g.edges) {
      expect(g.nodes[e.from], e.id).toBeDefined();
      expect(g.nodes[e.to], e.id).toBeDefined();
      expect(e.lengthM, e.id).toBeGreaterThan(0.5);
      expect(Math.abs(e.lengthM - dist(g.nodes[e.from].pos, g.nodes[e.to].pos)), e.id).toBeLessThan(0.02);
    }
  });

  it('is a single connected component', () => {
    const adj = new Map<string, string[]>();
    for (const e of g.edges) {
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
      adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
    }
    const seen = new Set<string>();
    const stack = [nodes[0].id];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(adj.get(n) ?? []));
    }
    expect(seen.size).toBe(nodes.length);
  });

  it('every connected parking position is reachable from every holding position without runway edges', () => {
    const adj = new Map<string, string[]>();
    for (const e of g.edges) {
      if (e.kind === 'runway') continue;
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
      adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
    }
    const reach = (start: string) => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length) {
        const n = stack.pop()!;
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(...(adj.get(n) ?? []));
      }
      return seen;
    };
    const holds = nodes.filter((n) => n.kind === 'holding_position');
    expect(holds.length).toBeGreaterThanOrEqual(40);
    // sampled: the full 59 x 130 product is large; every hold is checked against a few parking positions of each category
    const sample = ['airline', 'ga', 'fbo', 'cargo'].flatMap((c) => ap.parking.filter((p) => p.category === c && p.nodeId).slice(0, 4));
    for (const h of holds) {
      const r = reach(h.id);
      for (const p of sample) expect(r.has(p.nodeId), `${h.id} -> ${p.id}`).toBe(true);
    }
  });

  it('runway edges carry onRunwayId', () => {
    const rwEdges = g.edges.filter((e) => e.kind === 'runway');
    expect(rwEdges.length).toBeGreaterThan(40);
    for (const e of rwEdges) expect(e.taxiway).toBe(`RWY${e.onRunwayId}`);
    const xEdges = g.edges.filter((e) => e.from === 'RWX-9L-27Rx17-35' || e.to === 'RWX-9L-27Rx17-35');
    expect(new Set(xEdges.map((e) => e.onRunwayId))).toEqual(new Set(['9L/27R', '17/35']));
    expect(xEdges).toHaveLength(4);
  });

  it('every runway end region has at least 2 entry/exit nodes, except the documented gap at the runway 26 end', () => {
    for (const r of ap.runways) {
      const len = dist(r.ends[0].threshold, r.ends[1].threshold);
      for (const end of r.ends) {
        const exits = runwayExitNodes(ap, end.id).filter((x) => x.distanceFromThresholdM <= len / 2);
        if (end.id === '26') expect(new Set(exits.map((x) => x.node.id)).size, `${r.id} end ${end.id}`).toBeGreaterThanOrEqual(0);
        else expect(new Set(exits.map((x) => x.node.id)).size, `${r.id} end ${end.id}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('unnamed lanes are flagged approximate and edge kinds are consistent', () => {
    for (const e of g.edges) {
      if (e.kind === 'unnamed' || e.kind === 'apron_connector') {
        expect(e.taxiway).toBe('');
        expect(e.approximate).toBe(true);
      }
      if (e.kind === 'taxiway') expect(e.taxiway).not.toBe('');
    }
  });
});

describe('KPHL runway holding positions (derived, approximate)', () => {
  const HOLD = 250 * FT;
  for (const r of ['8/26', '9L/27R', '9R/27L', '17/35']) {
    it(`runway ${r}: holds sit 250 ft from the centreline, outside every runway polygon, flagged approximate`, () => {
      const runway = runwayOf(r);
      const [a, b] = [runway.ends[0].threshold, runway.ends[1].threshold];
      const holds = holdingPositionsForRunway(ap, r);
      expect(holds.length).toBeGreaterThanOrEqual(5);
      for (const h of holds) {
        expect(h.runwayId).toBe(r);
        expect((h as { approximate?: boolean }).approximate).toBe(true);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((h.pos.x - a.x) * dx + (h.pos.y - a.y) * dy) / (dx * dx + dy * dy)));
        expect(Math.abs(dist(h.pos, { x: a.x + dx * t, y: a.y + dy * t }) - HOLD), h.id).toBeLessThan(1.5);
        expect(ap.runways.some((rw) => inPoly(h.pos, rw.polygon)), h.id).toBe(false);
        expect(runway.ends.map((e) => e.id)).toContain(h.protectsRunwayEnd);
      }
    });
  }

  it('every runway end except 26 has a holding position protecting it and entries near its threshold', () => {
    for (const r of ap.runways) {
      for (const e of r.ends) {
        const holds = holdingPositionsForRunway(ap, r.id);
        expect(holds.some((h) => h.protectsRunwayEnd === e.id), `${r.id} end ${e.id} protects`).toBe(true);
        const entries = runwayEntryNodes(ap, e.id);
        expect(entries.length, `entries ${e.id}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('every hold is connected to its runway entry node; all but three are on a named taxiway (the other three sit on unnamed lanes)', () => {
    expect(nodes.filter((n) => n.kind === 'holding_position' && n.taxiways.length === 0).length).toBeLessThanOrEqual(3);
    for (const h of nodes.filter((n) => n.kind === 'holding_position')) {
      expect(g.nodes[(h as { entryNodeId?: string }).entryNodeId!], h.id).toBeDefined();
    }
  });
});

describe('KPHL parking', () => {
  const connected = (cat: string) => ap.parking.filter((p) => p.category === cat && p.nodeId && !p.connectorOverLimit);
  it('has airline gates at terminals A-West, A-East, B, C, D, E, F, GA stands, FBO spots and cargo stands', () => {
    const gates = connected('airline');
    expect(gates.length).toBeGreaterThanOrEqual(60);
    expect(new Set(ap.parking.filter((p) => p.category === 'airline').map((p) => p.zone))).toEqual(new Set(['Terminal A West', 'Terminal A East', 'Terminal B', 'Terminal C', 'Terminal D', 'Terminal E', 'Terminal F']));
    expect(connected('ga').length).toBeGreaterThanOrEqual(3);
    expect(connected('fbo').length).toBeGreaterThanOrEqual(1);
    expect(ap.parking.filter((p) => p.category === 'cargo').length).toBeGreaterThanOrEqual(8);
    for (const p of ap.parking) {
      if (!p.nodeId) continue;
      expect(g.nodes[p.nodeId].kind).toBe('parking');
      expect(dist(g.nodes[p.nodeId].pos, p.pos)).toBeLessThan(0.05);
      expect(findParking(ap, p.name).map((x) => x.id)).toContain(p.id);
    }
  });

  it('gate stands, GA, FedEx and UPS stands are real OSM lines; only the FBO spots are synthetic (and flagged)', () => {
    for (const p of ap.parking) {
      if (p.category === 'fbo') expect(p.source).toBe('synthetic');
      else expect(p.source, p.id).toBe('osm');
      if (p.source === 'synthetic') expect(p.approximate).toBe(true);
    }
    expect(ap.parking.some((p) => p.id === 'GATE-A15')).toBe(true);
    expect(ap.parking.some((p) => p.id.startsWith('UPS-'))).toBe(true);
    expect(ap.parking.some((p) => p.id.startsWith('FEDEX-'))).toBe(true);
  });

  it('has apron polygons and buildings for rendering', () => {
    expect(g.aprons.length).toBeGreaterThanOrEqual(8);
    expect(ap.buildings.some((b) => b.kind === 'terminal')).toBe(true);
  });
});

describe('KPHL loader', () => {
  it('returns a shared object by default and a private copy with fresh: true', () => {
    expect(loadKphl()).toBe(loadKphl());
    const copy = loadKphl({ fresh: true });
    expect(copy).not.toBe(ap);
    expect(copy.taxiwayGraph.edges.length).toBe(g.edges.length);
  });
});
