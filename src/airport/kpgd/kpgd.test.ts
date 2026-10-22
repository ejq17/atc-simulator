import { describe, expect, it } from 'vitest';
import facility from '../../../data/sources/kpgd-facility.json';
import freqSrc from '../../../data/sources/kpgd-frequencies.json';
import navSrc from '../../../data/sources/kpgd-navaids.json';
import procSrc from '../../../data/sources/kpgd-procedures.json';
import { getAirport, listAirports } from '..';
import { facilityCallName, airportCallName } from '../../radio/frequencies';
import { angleDiffDeg, bearingDeg } from '../projection';
import { holdingPositionsForRunway, runwayEntryNodes, runwayExitNodes, findParking } from '../graphUtils';
import { loadKpgd } from '.';
import { parseMissedApproach } from '../../sim/missedApproach';

const ap = loadKpgd();
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

describe('KPGD airport basics (NASR)', () => {
  it('matches the NASR ARP, elevation, variation, tower hours and class', () => {
    expect(ap.icao).toBe('KPGD');
    expect(ap.faaId).toBe('PGD');
    expect(ap.name).toBe('Punta Gorda');
    expect(ap.arp).toEqual({ lat: facility.airport.arp.lat, lon: facility.airport.arp.lon });
    expect(ap.elevationFt).toBe(facility.airport.field_elevation_ft);
    expect(ap.magneticVariationDeg).toBe(-6);
    expect(ap.towerHours).toBe('0600-2100'); // NASR TWR_HRS; the simulator does not close the tower outside these hours
    expect(ap.airspaceClass).toBe('D');
    expect(ap.timeZone).toBe('America/New_York');
  });

  it('is registered next to KACY; provenance carries sources and dates', () => {
    expect(getAirport('kpgd')).toBe(ap);
    expect(getAirport('PGD')).toBe(ap);
    expect(listAirports()).toContain('KPGD');
    expect(ap.provenance.length).toBeGreaterThanOrEqual(5);
    expect(ap.provenance.every((p) => p.source && p.retrievedOn)).toBe(true);
    expect(ap.osmAttribution).toBe('© OpenStreetMap contributors, ODbL 1.0');
    expect(g.provenance.source).toMatch(/OpenStreetMap/);
  });

  it('has no hot spot, no MVA sectors and no LAHSO (nothing in the sources; nothing invented)', () => {
    expect(ap.hotSpots).toEqual([]);
    expect(ap.mvaSectors).toBeUndefined();
    for (const r of ap.runways) for (const e of r.ends) expect(e.lahso ?? null).toBeNull();
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) {
      expect(p.holdingPatterns ?? []).toEqual([]);
      expect(p.fixAltitudes ?? []).toEqual([]);
    }
  });
});

describe('KPGD runways', () => {
  it('has runways 4/22 and 15/33 with NASR lengths, width and surface; 09/27 is deliberately not built', () => {
    expect(ap.runways.map((r) => r.id).sort()).toEqual(['15/33', '4/22']);
    expect(runwayOf('4/22').lengthFt).toBe(7193);
    expect(runwayOf('15/33').lengthFt).toBe(6286);
    for (const r of ap.runways) {
      expect(r.widthFt).toBe(150);
      expect(r.surface).toBe('ASPH');
      expect(r.provenance.effectiveFrom).toBe('2026-10-01');
    }
    expect(facility.runways.map((r) => r.id)).toContain('09/27'); // in NASR, left out of the sim (profile.excludeRunways)
  });

  it('threshold-to-threshold length is within 0.5% of NASR', () => {
    for (const r of ap.runways) {
      const lenFt = dist(r.ends[0].threshold, r.ends[1].threshold) / FT;
      expect(Math.abs(lenFt - r.lengthFt) / r.lengthFt).toBeLessThan(0.005);
    }
  });

  it('true alignments are 029/209/149/329 within 1 degree, measured from the thresholds', () => {
    const expected: Record<string, number> = { '4': 29, '22': 209, '15': 149, '33': 329 };
    for (const r of ap.runways) {
      const [a, b] = r.ends;
      expect(angleDiffDeg(bearingDeg(b.threshold.x - a.threshold.x, b.threshold.y - a.threshold.y), expected[a.id])).toBeLessThan(1);
      expect(angleDiffDeg(bearingDeg(a.threshold.x - b.threshold.x, a.threshold.y - b.threshold.y), expected[b.id])).toBeLessThan(1);
      expect(a.trueHeadingDeg).toBe(expected[a.id]);
      expect(b.trueHeadingDeg).toBe(expected[b.id]);
    }
  });

  it('charted magnetic headings (diagram) are true + 6 and TDZE comes from NASR', () => {
    expect([endOf('4'), endOf('22'), endOf('15'), endOf('33')].map((e) => e.magneticHeadingDeg)).toEqual([35, 215, 155, 335]);
    const nasr = Object.fromEntries(facility.runways.flatMap((r) => r.ends.map((e) => [String(parseInt(e.id, 10)), e.tdz_elev_ft])));
    for (const e of ['4', '22', '15', '33']) expect(endOf(e).tdzeFt).toBe(nasr[e]);
  });

  it('ILS on 4 only (I-PGD 109.75)', () => {
    expect(endOf('4').ils).toMatchObject({ ident: 'I-PGD', frequencyMhz: 109.75 });
    for (const e of ['22', '15', '33']) expect(endOf(e).ils).toBeNull();
  });

  it('runway 15 has a 271 ft displaced threshold; no other end has one', () => {
    expect(endOf('15').displacedThresholdFt).toBe(271);
    for (const e of ['4', '22', '33']) expect(endOf(e).displacedThresholdFt).toBeUndefined();
  });

  it('polygons contain their thresholds and the runway intersection, not the gates or GA stands', () => {
    for (const r of ap.runways) {
      for (const e of r.ends) expect(inPoly(e.threshold, r.polygon)).toBe(true);
      expect(dist(r.polygon[0], r.polygon[3])).toBeCloseTo(150 * FT, 0);
    }
    const x = g.nodes['RWX-4-22x15-33'];
    expect(x.kind).toBe('runway');
    expect(ap.runways.every((r) => inPoly(x.pos, r.polygon))).toBe(true);
    const stands = ap.parking.filter((p) => p.category === 'ga' || p.category === 'airline' || p.category === 'fbo');
    expect(stands.length).toBeGreaterThan(10);
    for (const p of stands) expect(ap.runways.some((r) => inPoly(p.pos, r.polygon))).toBe(false);
  });
});

describe('KPGD frequencies equal the verified source', () => {
  const f = (id: string) => ap.frequencies.find((x) => x.id === id)!;
  const s = freqSrc.summary_by_function;
  it('VHF values and positions (clearance delivery and ground share 119.55)', () => {
    expect([f('ATIS').mhz, f('CLNC').mhz, f('GND').mhz, f('TWR').mhz, f('APP').mhz, f('DEP').mhz]).toEqual([135.675, 119.55, 119.55, 121.0, 127.05, 127.05]);
    expect(f('ATIS').mhz).toBe(parseFloat(s.ATIS.vhf));
    expect(f('CLNC').mhz).toBe(parseFloat(s.clearance_delivery.vhf));
    expect(f('GND').mhz).toBe(parseFloat(s.ground.vhf));
    expect(f('TWR').mhz).toBe(parseFloat(s.tower.vhf));
    expect(f('APP').mhz).toBe(parseFloat(s.approach_departure.vhf));
    expect(['ATIS', 'CLNC', 'GND', 'TWR', 'APP', 'DEP'].map((id) => f(id).position)).toEqual(['ATIS', 'CLNC', 'GND', 'TWR', 'APP', 'DEP']);
    expect(f('APP').provenance.notes).toContain('306.2');
    expect(f('UNICOM').position).toBe('OTHER');
    expect(f('UNICOM').mhz).toBe(122.975);
  });

  it('the NASR altitude-stratum, Miami Center and Tampa rows are listed but not worked as positions', () => {
    expect(['PIKKR-HIGH', 'ZMA-RCAG', 'TPA-LUBBR'].map((id) => [f(id).mhz, f(id).position])).toEqual([[134.425, 'OTHER'], [134.75, 'OTHER'], [119.65, 'OTHER']]);
  });

  it('facility call names: Punta Gorda Tower/Ground/Clearance, Fort Myers Approach/Departure', () => {
    expect(airportCallName(ap)).toBe('Punta Gorda');
    expect(facilityCallName(ap, 121.0)).toBe('Punta Gorda Tower');
    expect(facilityCallName(ap, 135.675)).toBe('Punta Gorda ATIS');
    expect(facilityCallName(ap, 127.05, 'APP')).toBe('Fort Myers Approach');
    expect(facilityCallName(ap, 127.05, 'DEP')).toBe('Fort Myers Departure');
  });
});

describe('KPGD navaids and fixes equal the verified source', () => {
  const nav = (id: string) => ap.navaids.find((n) => n.id === id)!;
  it('the Lee County VORTAC (RSW) used by the plates (there is no navaid at the field)', () => {
    const p = navSrc.primary_navaid;
    expect(nav('RSW')).toMatchObject({ type: 'VORTAC', frequencyMhz: p.freq_mhz, latLon: { lat: p.lat, lon: p.lon } });
    expect(nav('RSW').frequencyMhz).toBe(114.15);
  });
  it('45 fixes with NASR coordinates (plates and the two STARs)', () => {
    const fixes = ap.navaids.filter((n) => n.type === 'FIX');
    expect(fixes).toHaveLength(45);
    for (const f of navSrc.fixes_named_on_approach_charts) expect(nav(f.id).latLon).toEqual({ lat: f.lat, lon: f.lon });
  });
  it('ILS components of runway 4 (I-PGD, LOC/DME channel 34Y)', () => {
    for (const s of navSrc.ils_localizers.systems) {
      expect(nav(s.plate_ident)).toMatchObject({ type: 'LOC', frequencyMhz: s.loc_freq_mhz, latLon: { lat: s.localizer_antenna.lat, lon: s.localizer_antenna.lon } });
      expect(nav(`${s.plate_ident}-GS`)).toMatchObject({ frequencyMhz: s.glideslope!.freq_mhz });
      expect(nav(`${s.plate_ident}-DME`)?.type).toBe('DME');
    }
  });
  it('plate DME distances of the ILS 4 fixes (ZEPIG 11.4, CISTS 6.2, ISOXE 2.6) agree with the NASR ILS DME antenna', () => {
    const dme = nav('I-PGD-DME').pos;
    for (const [fix, nm] of [['ZEPIG', 11.4], ['CISTS', 6.2], ['ISOXE', 2.6]] as const) {
      expect(Math.abs(dist(nav(fix).pos, dme) / 1852 - nm), fix).toBeLessThan(0.15);
    }
  });
});

describe('KPGD procedures', () => {
  it('5 IAP charts + airport diagram + 3 STAR pages and no DP, URLs from the d-TPP metadata', () => {
    const iaps = ap.procedures.filter((p) => p.type === 'IAP');
    expect(iaps.map((p) => p.name).sort()).toEqual(['ILS OR LOC RWY 04', 'RNAV (GPS) RWY 04', 'RNAV (GPS) RWY 15', 'RNAV (GPS) RWY 22', 'RNAV (GPS) RWY 33']);
    expect(ap.procedures.filter((p) => p.type === 'DIAGRAM')).toHaveLength(1);
    expect(ap.procedures.filter((p) => p.type === 'DP')).toEqual([]);
    expect(ap.procedures.filter((p) => p.type === 'STAR').map((p) => p.name)).toEqual(['LUBBR FOUR (RNAV)', 'LUBBR FOUR (RNAV), CONT.1', 'PIKKR SEVEN (RNAV)']);
    const urls = new Set([...procSrc.instrument_approaches.map((a) => a.pdf.url), procSrc.airport_diagram.pdf.url, ...procSrc.stars.map((d) => d.pdf.url)]);
    expect(new Set(ap.procedures.map((p) => p.chartPdfUrl))).toEqual(urls);
    for (const p of ap.procedures) {
      expect(p.chartPdfUrl).toMatch(/^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\/.+\.PDF$/);
      expect(p.provenance.effectiveFrom).toBe('2026-10-01');
    }
    for (const a of procSrc.instrument_approaches) expect(a.pdf.http_status).toBe(200);
  });

  it('transcribed approaches: fixes resolve to navaids, route order, missed approaches parse, glidepaths from the plates', () => {
    const iap = (name: string) => ap.procedures.find((p) => p.name === name)!;
    expect(iap('ILS OR LOC RWY 04').fixes).toEqual(['RSW', 'ZEPIG', 'CISTS', 'ISOXE', 'DOGLE', 'JOCKS', 'VIOLA']);
    expect(iap('RNAV (GPS) RWY 04').fixes).toEqual(['ZEGIS', 'BULOW', 'CISTS', 'YENCU', 'DOGLE', 'JOCKS', 'CUPAV']);
    expect(iap('RNAV (GPS) RWY 15').missedApproachText).toBe('Climb to 2500 direct DODIK and on track 203 deg to OWGAF and hold.');
    expect(iap('RNAV (GPS) RWY 22').missedApproachText).toBe('Climb to 2000 direct BULOW and hold.');
    expect(iap('RNAV (GPS) RWY 33').fixes).toContain('FARBI');
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) {
      for (const f of p.fixes ?? []) expect(ap.navaids.some((n) => n.id === f), `${p.name} ${f}`).toBe(true);
      expect(parseMissedApproach(p.missedApproachText), p.name).toBeDefined();
    }
    const gp = (name: string) => iap(name).glidepath;
    expect([gp('ILS OR LOC RWY 04'), gp('RNAV (GPS) RWY 04'), gp('RNAV (GPS) RWY 15'), gp('RNAV (GPS) RWY 22'), gp('RNAV (GPS) RWY 33')].map((x) => x?.tchFt)).toEqual([50, 50, 47, 40, 48]);
    expect(iap('RNAV (GPS) RWY 15').missedApproach?.finalAltitudeFt).toBe(2500);
  });

  it('no DP: departures use the default initial altitude', () => {
    expect(procSrc.departure_procedures).toEqual([]);
    expect(procSrc.sids).toEqual([]);
  });
});

describe('KPGD taxiway graph', () => {
  it('names 12 of the 18 identifiers printed on the FAA diagram; A1, A3, A4, G1, G2 and G3 have no OSM way', () => {
    const missing = ['A1', 'A3', 'A4', 'G1', 'G2', 'G3'];
    for (const id of procSrc.airport_diagram.taxiway_identifiers) {
      if (missing.includes(id)) expect(g.taxiwayPolylines[id], id).toBeUndefined();
      else expect(g.taxiwayPolylines[id]?.length, `polyline ${id}`).toBeGreaterThan(0);
    }
    expect(g.excludedOsmRefs ?? []).toEqual([]);
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

  it('every parking position is reachable from every holding position without runway edges', () => {
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
    expect(holds.length).toBeGreaterThanOrEqual(8);
    for (const h of holds) {
      const r = reach(h.id);
      for (const p of ap.parking) if (p.nodeId) expect(r.has(p.nodeId), `${h.id} -> ${p.id}`).toBe(true);
    }
  });

  it('runway edges carry onRunwayId and the crossing node joins both runways', () => {
    const rwEdges = g.edges.filter((e) => e.kind === 'runway');
    expect(rwEdges.length).toBeGreaterThan(8);
    for (const e of rwEdges) expect(e.taxiway).toBe(`RWY${e.onRunwayId}`);
    const xEdges = g.edges.filter((e) => e.from === 'RWX-4-22x15-33' || e.to === 'RWX-4-22x15-33');
    expect(new Set(xEdges.map((e) => e.onRunwayId))).toEqual(new Set(['4/22', '15/33']));
    expect(xEdges).toHaveLength(4);
  });

  it('every runway end region has at least 2 entry/exit nodes', () => {
    for (const r of ap.runways) {
      const len = dist(r.ends[0].threshold, r.ends[1].threshold);
      for (const end of r.ends) {
        const exits = runwayExitNodes(ap, end.id).filter((x) => x.distanceFromThresholdM <= len / 2);
        expect(new Set(exits.map((x) => x.node.id)).size, `${r.id} end ${end.id}`).toBeGreaterThanOrEqual(2);
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

describe('KPGD runway holding positions (derived, approximate)', () => {
  const HOLD = 250 * FT;
  for (const r of ['4/22', '15/33']) {
    it(`runway ${r}: holds sit 250 ft from the centreline, outside every runway polygon, flagged approximate`, () => {
      const runway = runwayOf(r);
      const [a, b] = [runway.ends[0].threshold, runway.ends[1].threshold];
      const holds = holdingPositionsForRunway(ap, r);
      expect(holds.length).toBeGreaterThanOrEqual(4);
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

  it('every runway end has a holding position protecting it, and a full-length entry near its threshold', () => {
    for (const r of ap.runways) {
      for (const e of r.ends) {
        const holds = holdingPositionsForRunway(ap, r.id);
        expect(holds.some((h) => h.protectsRunwayEnd === e.id), `${r.id} end ${e.id} protects`).toBe(true);
        const entries = runwayEntryNodes(ap, e.id);
        expect(entries.length, `entries ${e.id}`).toBeGreaterThanOrEqual(2);
        const entryPos = g.nodes[(entries[0] as { entryNodeId?: string }).entryNodeId!].pos;
        expect(dist(entryPos, e.threshold), `first entry of ${e.id}`).toBeLessThan(700);
      }
    }
  });

  it('every hold names the taxiway it is on and is connected to its runway entry node', () => {
    for (const h of nodes.filter((n) => n.kind === 'holding_position')) {
      expect(h.taxiways.length, h.id).toBeGreaterThan(0);
      expect(g.nodes[(h as { entryNodeId?: string }).entryNodeId!], h.id).toBeDefined();
    }
  });
});

describe('KPGD parking', () => {
  const connected = (cat: string) => ap.parking.filter((p) => p.category === cat && p.nodeId && !p.connectorOverLimit);
  it('has 10 airline stands (OSM refs 1-10), GA and FBO stands, no cargo spots, all connected within 150 m', () => {
    expect(connected('airline').map((p) => p.name).sort()).toEqual(['Gate 1', 'Gate 10', 'Gate 2', 'Gate 3', 'Gate 4', 'Gate 5', 'Gate 6', 'Gate 7', 'Gate 8', 'Gate 9']);
    expect(connected('ga').length).toBeGreaterThanOrEqual(3);
    expect(connected('fbo').length).toBeGreaterThanOrEqual(1);
    expect(ap.parking.some((p) => p.category === 'cargo')).toBe(false);
    for (const p of ap.parking) {
      if (!p.nodeId) continue;
      expect(g.nodes[p.nodeId].kind).toBe('parking');
      expect(dist(g.nodes[p.nodeId].pos, p.pos)).toBeLessThan(0.05);
      expect(p.connectorLengthM ?? 0).toBeLessThanOrEqual(150);
      expect(findParking(ap, p.name).map((x) => x.id)).toContain(p.id);
    }
  });

  it('airline gates and the three south-ramp GA stands are real OSM ways; the FBO and north-ramp spots are synthetic (and flagged)', () => {
    for (const p of ap.parking) {
      if (p.category === 'airline') expect(p.source, p.id).toBe('osm');
      if (p.category === 'fbo') expect(p.source).toBe('synthetic');
      if (p.source === 'synthetic') expect(p.approximate).toBe(true);
    }
    expect(ap.parking.filter((p) => p.category === 'ga' && p.source === 'osm')).toHaveLength(3);
  });

  it('has apron polygons and buildings for rendering', () => {
    expect(g.aprons.length).toBeGreaterThanOrEqual(2);
    expect(ap.buildings.some((b) => b.kind === 'terminal')).toBe(true);
  });
});

describe('KPGD loader', () => {
  it('returns a shared object by default and a private copy with fresh: true', () => {
    expect(loadKpgd()).toBe(loadKpgd());
    const copy = loadKpgd({ fresh: true });
    expect(copy).not.toBe(ap);
    expect(copy.taxiwayGraph.edges.length).toBe(g.edges.length);
  });
});
