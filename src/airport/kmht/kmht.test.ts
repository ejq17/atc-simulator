import { describe, expect, it } from 'vitest';
import facility from '../../../data/sources/kmht-facility.json';
import freqSrc from '../../../data/sources/kmht-frequencies.json';
import navSrc from '../../../data/sources/kmht-navaids.json';
import procSrc from '../../../data/sources/kmht-procedures.json';
import { getAirport, listAirports } from '..';
import { facilityCallName, airportCallName } from '../../radio/frequencies';
import { angleDiffDeg, bearingDeg } from '../projection';
import { holdingPositionsForRunway, runwayEntryNodes, runwayExitNodes, findParking } from '../graphUtils';
import { loadKmht } from '.';

const ap = loadKmht();
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

describe('KMHT airport basics (NASR)', () => {
  it('matches the NASR ARP, elevation, variation, tower hours and class', () => {
    expect(ap.icao).toBe('KMHT');
    expect(ap.faaId).toBe('MHT');
    expect(ap.name).toBe('Manchester Boston Regional');
    expect(ap.arp).toEqual({ lat: facility.airport.arp.lat, lon: facility.airport.arp.lon });
    expect(ap.elevationFt).toBe(facility.airport.field_elevation_ft);
    expect(ap.magneticVariationDeg).toBe(-15);
    expect(ap.towerHours).toBe('24');
    expect(ap.airspaceClass).toBe('C');
  });

  it('is registered next to KACY; provenance carries sources and dates', () => {
    expect(getAirport('kmht')).toBe(ap);
    expect(getAirport('MHT')).toBe(ap);
    expect(listAirports()).toContain('KMHT');
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

describe('KMHT runways', () => {
  it('has runways 6/24 and 17/35 with NASR lengths, width and surface', () => {
    expect(ap.runways.map((r) => r.id).sort()).toEqual(['17/35', '6/24']);
    expect(runwayOf('17/35').lengthFt).toBe(9250);
    expect(runwayOf('6/24').lengthFt).toBe(7651);
    for (const r of ap.runways) {
      expect(r.widthFt).toBe(150);
      expect(r.surface).toBe('ASPH');
      expect(r.provenance.effectiveFrom).toBe('2026-10-01');
    }
  });

  it('threshold-to-threshold length is within 0.5% of NASR', () => {
    for (const r of ap.runways) {
      const lenFt = dist(r.ends[0].threshold, r.ends[1].threshold) / FT;
      expect(Math.abs(lenFt - r.lengthFt) / r.lengthFt).toBeLessThan(0.005);
    }
  });

  it('true alignments are 042/222/157/337 within 1 degree, measured from the thresholds', () => {
    const expected: Record<string, number> = { '6': 42, '24': 222, '17': 157, '35': 337 };
    for (const r of ap.runways) {
      const [a, b] = r.ends;
      expect(angleDiffDeg(bearingDeg(b.threshold.x - a.threshold.x, b.threshold.y - a.threshold.y), expected[a.id])).toBeLessThan(1);
      expect(angleDiffDeg(bearingDeg(a.threshold.x - b.threshold.x, a.threshold.y - b.threshold.y), expected[b.id])).toBeLessThan(1);
      expect(a.trueHeadingDeg).toBe(expected[a.id]);
      expect(b.trueHeadingDeg).toBe(expected[b.id]);
    }
  });

  it('charted magnetic headings (diagram) are true + 15 and TDZE comes from NASR', () => {
    expect([endOf('6'), endOf('24'), endOf('17'), endOf('35')].map((e) => e.magneticHeadingDeg)).toEqual([57, 237, 172, 352]);
    const nasr = Object.fromEntries(facility.runways.flatMap((r) => r.ends.map((e) => [String(parseInt(e.id, 10)), e.tdz_elev_ft])));
    for (const e of ['6', '24', '17', '35']) expect(endOf(e).tdzeFt).toBe(nasr[e]);
  });

  it('ILS on 6 (I-MJE 109.95), 17 (I-MNA 109.1) and 35 (I-MHT 109.1); none on 24', () => {
    expect(endOf('6').ils).toMatchObject({ ident: 'I-MJE', frequencyMhz: 109.95 });
    expect(endOf('17').ils).toMatchObject({ ident: 'I-MNA', frequencyMhz: 109.1 });
    expect(endOf('35').ils).toMatchObject({ ident: 'I-MHT', frequencyMhz: 109.1 });
    expect(endOf('24').ils).toBeNull();
  });

  it('displaced thresholds are recorded from NASR (6: 442 ft, 17: 336 ft, 35: 850 ft; 24: none)', () => {
    expect(endOf('6').displacedThresholdFt).toBe(442);
    expect(endOf('17').displacedThresholdFt).toBe(336);
    expect(endOf('35').displacedThresholdFt).toBe(850);
    expect(endOf('24').displacedThresholdFt).toBeUndefined();
  });

  it('polygons contain their thresholds and the runway intersection, not the gates or GA stands', () => {
    for (const r of ap.runways) {
      for (const e of r.ends) expect(inPoly(e.threshold, r.polygon)).toBe(true);
      expect(dist(r.polygon[0], r.polygon[3])).toBeCloseTo(150 * FT, 0);
    }
    const x = g.nodes['RWX-X'];
    expect(x.kind).toBe('runway');
    expect(ap.runways.every((r) => inPoly(x.pos, r.polygon))).toBe(true);
    const stands = ap.parking.filter((p) => p.category === 'ga' || p.category === 'airline' || p.category === 'fbo');
    expect(stands.length).toBeGreaterThan(10);
    for (const p of stands) expect(ap.runways.some((r) => inPoly(p.pos, r.polygon))).toBe(false);
  });
});

describe('KMHT frequencies equal the verified source', () => {
  const f = (id: string) => ap.frequencies.find((x) => x.id === id)!;
  const s = freqSrc.summary_by_function;
  it('VHF values and positions', () => {
    expect([f('ATIS').mhz, f('CLNC').mhz, f('GND').mhz, f('TWR').mhz, f('APP').mhz, f('DEP').mhz]).toEqual([119.55, 135.9, 121.9, 121.3, 124.9, 124.9]);
    expect(f('ATIS').mhz).toBe(parseFloat(s.ATIS.vhf));
    expect(f('CLNC').mhz).toBe(parseFloat(s.clearance_delivery.vhf));
    expect(f('GND').mhz).toBe(parseFloat(s.ground.vhf));
    expect(f('TWR').mhz).toBe(parseFloat(s.tower.vhf));
    expect(f('APP').mhz).toBe(parseFloat(s.approach_departure.vhf));
    expect(['ATIS', 'CLNC', 'GND', 'TWR', 'APP', 'DEP'].map((id) => f(id).position)).toEqual(['ATIS', 'CLNC', 'GND', 'TWR', 'APP', 'DEP']);
    expect(f('TWR').provenance.notes).toContain('239.025');
    expect(f('UNICOM').position).toBe('OTHER');
    expect(f('UNICOM').mhz).toBe(122.95);
  });

  it('the NASR Class C area frequencies are listed but not worked as positions', () => {
    expect(ap.frequencies.filter((x) => x.id.startsWith('CLASS-C')).map((x) => [x.mhz, x.position])).toEqual([[125.05, 'OTHER'], [134.75, 'OTHER']]);
  });

  it('facility call names: Manchester Tower/Ground/Clearance, Boston Approach/Departure', () => {
    expect(airportCallName(ap)).toBe('Manchester');
    expect(facilityCallName(ap, 121.3)).toBe('Manchester Tower');
    expect(facilityCallName(ap, 121.9)).toBe('Manchester Ground');
    expect(facilityCallName(ap, 135.9)).toBe('Manchester Clearance Delivery');
    expect(facilityCallName(ap, 124.9, 'APP')).toBe('Boston Approach');
    expect(facilityCallName(ap, 124.9, 'DEP')).toBe('Boston Departure');
  });
});

describe('KMHT navaids and fixes equal the verified source', () => {
  const nav = (id: string) => ap.navaids.find((n) => n.id === id)!;
  it('the MHT DME (no VOR at the field) and the CON / GDM VOR/DMEs', () => {
    const p = navSrc.primary_navaid;
    expect(nav('MHT')).toMatchObject({ type: 'DME', frequencyMhz: p.freq_mhz, latLon: { lat: p.lat, lon: p.lon } });
    for (const o of navSrc.other_navaids_referenced) {
      expect(nav(o.id)).toMatchObject({ type: o.type, frequencyMhz: o.freq_mhz, latLon: { lat: o.lat, lon: o.lon } });
    }
    expect(nav('CON').frequencyMhz).toBe(112.9);
    expect(nav('GDM').frequencyMhz).toBe(116.95);
  });
  it('26 fixes with NASR coordinates', () => {
    const fixes = ap.navaids.filter((n) => n.type === 'FIX');
    expect(fixes).toHaveLength(26);
    for (const f of navSrc.fixes_named_on_approach_charts) expect(nav(f.id).latLon).toEqual({ lat: f.lat, lon: f.lon });
  });
  it('ILS components (the runway 6 ILS has no DME)', () => {
    for (const s of navSrc.ils_localizers.systems) {
      expect(nav(s.plate_ident)).toMatchObject({ type: 'LOC', frequencyMhz: s.loc_freq_mhz, latLon: { lat: s.localizer_antenna.lat, lon: s.localizer_antenna.lon } });
      expect(nav(`${s.plate_ident}-GS`)).toMatchObject({ frequencyMhz: s.glideslope!.freq_mhz });
      expect(nav(`${s.plate_ident}-DME`)?.type).toBe(s.dme_antenna ? 'DME' : undefined);
    }
  });
});

describe('KMHT procedures', () => {
  it('11 IAP charts + airport diagram + 2 DPs + 1 STAR, URLs from the d-TPP metadata', () => {
    const iaps = ap.procedures.filter((p) => p.type === 'IAP');
    expect(iaps).toHaveLength(11);
    expect(ap.procedures.filter((p) => p.type === 'DIAGRAM')).toHaveLength(1);
    expect(ap.procedures.filter((p) => p.type === 'DP').map((p) => p.name)).toEqual(['MANCHESTER ONE DEPARTURE', 'PPORT FOUR DEPARTURE (RNAV)']);
    expect(ap.procedures.filter((p) => p.type === 'STAR').map((p) => p.name)).toEqual(['ROZZE TWO ARRIVAL (RNAV)', 'ROZZE TWO ARRIVAL (RNAV), CONT.1']);
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

  it('MANCHESTER ONE is the first DP and carries its maintain altitude (3000)', () => {
    const dp = ap.procedures.find((p) => p.type === 'DP')!;
    expect(dp.name).toBe('MANCHESTER ONE DEPARTURE');
    expect(dp.maintainAltitudeFt).toBe(3000);
  });

  it('transcribed approaches carry fixes that resolve to navaids; untranscribed ones are empty, not invented', () => {
    const iap = (name: string) => ap.procedures.find((p) => p.name === name)!;
    expect(iap('ILS OR LOC RWY 35').fixes).toEqual(['PELAN', 'YOULL', 'MNTIN', 'XOHWI', 'CON', 'SHOWZ', 'IHOBB', 'ELEEE']);
    expect(iap('ILS OR LOC RWY 35').missedApproachText).toBe('Climb to 4000 direct CON and hold.');
    expect(iap('RNAV (GPS) Y RWY 17').fixes).toContain('ORDIE');
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) for (const f of p.fixes ?? []) expect(ap.navaids.some((n) => n.id === f), `${p.name} ${f}`).toBe(true);
    expect(iap('RNAV (RNP) Z RWY 35').fixes).toEqual([]);
    expect(iap('ILS OR LOC RWY 06').runwayEnd).toBe('6');
  });
});

describe('KMHT taxiway graph', () => {
  it('names 19 of the 22 identifiers printed on the FAA diagram; A5, C and K2 have no OSM way; D1 is OSM-only', () => {
    const missing = ['A5', 'C', 'K2'];
    for (const id of procSrc.airport_diagram.taxiway_identifiers) {
      if (missing.includes(id)) expect(g.taxiwayPolylines[id], id).toBeUndefined();
      else expect(g.taxiwayPolylines[id]?.length, `polyline ${id}`).toBeGreaterThan(0);
    }
    expect(g.excludedOsmRefs).toEqual(['D1']);
    expect(g.edges.some((e) => e.taxiway === 'D1')).toBe(false);
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
    const xEdges = g.edges.filter((e) => e.from === 'RWX-X' || e.to === 'RWX-X');
    expect(new Set(xEdges.map((e) => e.onRunwayId))).toEqual(new Set(['6/24', '17/35']));
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

describe('KMHT runway holding positions (derived, approximate)', () => {
  const HOLD = 250 * FT;
  for (const r of ['6/24', '17/35']) {
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

describe('KMHT parking', () => {
  const connected = (cat: string) => ap.parking.filter((p) => p.category === cat && p.nodeId && !p.connectorOverLimit);
  it('has 14 airline gates (OSM refs 1-12, 14, 15), GA stands, FBO stands and cargo spots, all connected within 150 m', () => {
    expect(connected('airline').map((p) => p.name).sort()).toEqual(['Gate 1', 'Gate 10', 'Gate 11', 'Gate 12', 'Gate 14', 'Gate 15', 'Gate 2', 'Gate 3', 'Gate 4', 'Gate 5', 'Gate 6', 'Gate 7', 'Gate 8', 'Gate 9']);
    expect(connected('ga').length).toBeGreaterThanOrEqual(8);
    expect(connected('fbo').length).toBeGreaterThanOrEqual(1);
    expect(connected('cargo').length).toBeGreaterThanOrEqual(2);
    for (const p of ap.parking) {
      if (!p.nodeId) continue;
      expect(g.nodes[p.nodeId].kind).toBe('parking');
      expect(dist(g.nodes[p.nodeId].pos, p.pos)).toBeLessThan(0.05);
      expect(p.connectorLengthM ?? 0).toBeLessThanOrEqual(150);
      expect(findParking(ap, p.name).map((x) => x.id)).toContain(p.id);
    }
  });

  it('gates and GA/FBO stands are real OSM nodes; only cargo spots are synthetic (and flagged)', () => {
    for (const p of ap.parking) {
      if (['airline', 'ga', 'fbo'].includes(p.category)) expect(p.source, p.id).toBe('osm');
      if (p.category === 'cargo') expect(p.source).toBe('synthetic');
      if (p.source === 'synthetic') expect(p.approximate).toBe(true);
    }
  });

  it('has apron polygons and buildings for rendering', () => {
    expect(g.aprons.length).toBeGreaterThanOrEqual(8);
    expect(ap.buildings.some((b) => b.kind === 'terminal')).toBe(true);
  });
});

describe('KMHT loader', () => {
  it('returns a shared object by default and a private copy with fresh: true', () => {
    expect(loadKmht()).toBe(loadKmht());
    const copy = loadKmht({ fresh: true });
    expect(copy).not.toBe(ap);
    expect(copy.taxiwayGraph.edges.length).toBe(g.edges.length);
  });
});
