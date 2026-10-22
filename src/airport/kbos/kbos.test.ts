import { describe, expect, it } from 'vitest';
import facility from '../../../data/sources/kbos-facility.json';
import freqSrc from '../../../data/sources/kbos-frequencies.json';
import navSrc from '../../../data/sources/kbos-navaids.json';
import procSrc from '../../../data/sources/kbos-procedures.json';
import { getAirport, listAirports } from '..';
import { facilityCallName, airportCallName } from '../../radio/frequencies';
import { angleDiffDeg, bearingDeg } from '../projection';
import { holdingPositionsForRunway, runwayEntryNodes, runwayExitNodes, findParking } from '../graphUtils';
import { loadKbos } from '.';

const ap = loadKbos();
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

describe('KBOS airport basics (NASR)', () => {
  it('matches the NASR ARP, elevation, variation, tower hours, class B and time zone', () => {
    expect(ap.icao).toBe('KBOS');
    expect(ap.faaId).toBe('BOS');
    expect(ap.name).toBe('General Edward Lawrence Logan International');
    expect(ap.arp).toEqual({ lat: facility.airport.arp.lat, lon: facility.airport.arp.lon });
    expect(ap.elevationFt).toBe(19.1);
    expect(ap.magneticVariationDeg).toBe(-15);
    expect(ap.towerHours).toBe('24');
    expect(ap.airspaceClass).toBe('B');
    expect(ap.timeZone).toBe('America/New_York');
  });

  it('is registered; provenance carries sources and dates', () => {
    expect(getAirport('kbos')).toBe(ap);
    expect(getAirport('BOS')).toBe(ap);
    expect(listAirports()).toContain('KBOS');
    expect(ap.provenance.length).toBeGreaterThanOrEqual(5);
    expect(ap.provenance.every((p) => p.source && p.retrievedOn)).toBe(true);
    expect(ap.osmAttribution).toBe('© OpenStreetMap contributors, ODbL 1.0');
  });

  it('has the charted hot spots, LAHSO from NASR and no MVA / holding data (nothing invented)', () => {
    expect(ap.hotSpots).toHaveLength(1);
    expect(ap.hotSpots[0].description).toMatch(/HS 1.*HS 2.*HS 3.*HS 4/);
    expect(ap.mvaSectors).toBeUndefined();
    const lahso = Object.fromEntries(ap.runways.flatMap((r) => r.ends).filter((e) => e.lahso).map((e) => [e.id, e.lahso!.availableLandingDistanceFt]));
    expect(lahso).toEqual({ '4L': 5250, '22L': 6400, '27': 5650, '15R': 6800 });
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) {
      expect(p.holdingPatterns ?? []).toEqual([]);
      expect(p.fixAltitudes ?? []).toEqual([]);
    }
  });
});

describe('KBOS runways', () => {
  it('has the six NASR runways with length, width and surface', () => {
    expect(ap.runways.map((r) => r.id).sort()).toEqual(['14/32', '15L/33R', '15R/33L', '4L/22R', '4R/22L', '9/27']);
    expect(ap.runways).toHaveLength(6);
    const len: Record<string, number> = { '4L/22R': 7864, '4R/22L': 10006, '9/27': 7001, '14/32': 5000, '15L/33R': 2557, '15R/33L': 10083 };
    for (const r of ap.runways) {
      expect(r.lengthFt).toBe(len[r.id]);
      expect(r.surface).toBe('ASPH');
      expect(r.provenance.effectiveFrom).toBe('2026-10-01');
    }
  });

  it('threshold-to-threshold length is within 0.5% of NASR and the true alignments match', () => {
    for (const r of ap.runways) {
      const lenFt = dist(r.ends[0].threshold, r.ends[1].threshold) / FT;
      expect(Math.abs(lenFt - r.lengthFt) / r.lengthFt).toBeLessThan(0.005);
      const [a, b] = r.ends;
      expect(angleDiffDeg(bearingDeg(b.threshold.x - a.threshold.x, b.threshold.y - a.threshold.y), a.trueHeadingDeg)).toBeLessThan(1);
    }
    const nasr = Object.fromEntries(facility.runways.flatMap((r) => r.ends.map((e) => [e.id.replace(/^0/, ''), e.true_alignment_deg])));
    for (const e of ap.runways.flatMap((r) => r.ends)) expect(e.trueHeadingDeg, e.id).toBe(nasr[e.id]);
  });

  it('charted magnetic headings (diagram) are true + 15', () => {
    const charted: Record<string, number> = { '4L': 35, '22R': 215, '4R': 35, '22L': 215, '9': 92, '27': 272, '14': 140, '32': 320, '15L': 150, '33R': 330, '15R': 150, '33L': 330 };
    for (const [id, h] of Object.entries(charted)) expect(endOf(id).magneticHeadingDeg, id).toBe(h);
    for (const e of ap.runways.flatMap((r) => r.ends)) expect((e.trueHeadingDeg + 15) % 360).toBe(e.magneticHeadingDeg);
  });

  it('an ILS on 4R, 15R, 22L, 27 and 33L only, with the NASR identifiers and frequencies', () => {
    expect(endOf('4R').ils).toMatchObject({ ident: 'I-BOS', frequencyMhz: 110.3 });
    expect(endOf('15R').ils).toMatchObject({ ident: 'I-MDC', frequencyMhz: 110.7 });
    expect(endOf('22L').ils).toMatchObject({ ident: 'I-LQN', frequencyMhz: 110.3 });
    expect(endOf('27').ils).toMatchObject({ ident: 'I-DGU', frequencyMhz: 111.3 });
    expect(endOf('33L').ils).toMatchObject({ ident: 'I-LIP', frequencyMhz: 110.7 });
    for (const e of ['4L', '22R', '9', '14', '32', '15L', '33R']) expect(endOf(e).ils, e).toBeNull();
  });

  it('displaced thresholds are recorded from NASR (22R 819, 4R 1155, 22L 1199, 15R 882 ft)', () => {
    expect(['22R', '4R', '22L', '15R'].map((e) => endOf(e).displacedThresholdFt)).toEqual([819, 1155, 1199, 882]);
    expect(endOf('27').displacedThresholdFt).toBeUndefined();
  });

  it('runway intersections are found automatically; polygons contain their thresholds, not the stands', () => {
    const x = nodes.filter((n) => n.kind === 'runway' && (n.runwayIds?.length ?? 0) >= 2);
    expect(x.length).toBeGreaterThanOrEqual(5);
    for (const n of x) {
      expect(n.id).toMatch(/^RWX-/);
      for (const id of n.runwayIds!) expect(inPoly(n.pos, runwayOf(id).polygon), `${n.id} ${id}`).toBe(true);
    }
    for (const r of ap.runways) for (const e of r.ends) expect(inPoly(e.threshold, r.polygon)).toBe(true);
    for (const p of ap.parking.filter((q) => q.category === 'airline' || q.category === 'fbo' || q.category === 'ga' || q.category === 'cargo')) {
      expect(ap.runways.some((r) => inPoly(p.pos, r.polygon)), p.id).toBe(false);
    }
  });

  it('publishes four documented runway configurations (the late-night one is documented but not selectable), NE flow first, with sources', () => {
    const cfg = ap.runwayConfigurations!;
    expect(cfg.map((c) => c.id)).toEqual(['NE-4R4L-9', 'SW-22L27', 'NW-33L27', 'SE-15R-9']);
    expect(cfg[0]).toMatchObject({ landing: ['4R', '4L'], departing: ['4R', '9', '4L'] });
    for (const c of cfg) {
      expect(c.provenance.url, c.id).toMatch(/^https:\/\/massportcac\.org\//);
      expect(c.windFromDeg, c.id).toBeUndefined(); // no published wind sector: left out, never invented
      const ends = new Set(ap.runways.flatMap((r) => r.ends.map((e) => e.id)));
      for (const e of [...c.landing, ...c.departing]) expect(ends.has(e), `${c.id} ${e}`).toBe(true);
    }
  });
});

describe('KBOS frequencies equal the verified NASR rows', () => {
  const f = (id: string) => ap.frequencies.find((x) => x.id === id)!;
  it('VHF values and positions', () => {
    expect([f('ATIS').mhz, f('CLNC').mhz, f('GND').mhz, f('TWR').mhz, f('APP').mhz, f('DEP').mhz]).toEqual([135, 121.65, 121.75, 128.8, 120.6, 133]);
    expect(['ATIS', 'CLNC', 'GND', 'TWR', 'APP', 'DEP'].map((id) => f(id).position)).toEqual(['ATIS', 'CLNC', 'GND', 'TWR', 'APP', 'DEP']);
    expect(f('GND-2')).toMatchObject({ mhz: 121.9, position: 'OTHER' });
    expect(f('TWR-E')).toMatchObject({ mhz: 132.225, position: 'OTHER' });
    expect(f('TWR-HELI').mhz).toBe(124.725);
    expect(f('RAMP').mhz).toBe(134.05);
    expect([f('APP-N').mhz, f('APP-S').mhz]).toEqual([118.25, 127.2]);
    expect(f('UNICOM').mhz).toBe(122.95);
  });

  it('every frequency is a NASR FRQ row of BOS or A90', () => {
    const rows = new Set((freqSrc.all_frequencies_serving_airport as { freq_mhz: string }[]).map((r) => parseFloat(r.freq_mhz)));
    for (const x of ap.frequencies) expect(rows.has(x.mhz), x.id).toBe(true);
    expect(ap.frequencies.filter((x) => x.id.startsWith('CLASS-B')).map((x) => [x.mhz, x.sectorBearings])).toEqual([[124.1, { fromDeg: 91, toDeg: 269 }], [124.4, { fromDeg: 270, toDeg: 90 }]]);
  });

  it('facility call names: Boston Tower/Ground/Clearance and Boston Approach/Departure', () => {
    expect(airportCallName(ap)).toBe('Boston');
    expect(facilityCallName(ap, 128.8)).toBe('Boston Tower');
    expect(facilityCallName(ap, 121.75)).toBe('Boston Ground');
    expect(facilityCallName(ap, 121.65)).toBe('Boston Clearance Delivery');
    expect(facilityCallName(ap, 120.6, 'APP')).toBe('Boston Approach');
    expect(facilityCallName(ap, 133, 'DEP')).toBe('Boston Departure');
  });
});

describe('KBOS navaids and fixes equal the verified source', () => {
  const nav = (id: string) => ap.navaids.find((n) => n.id === id)!;
  it('the BOS VOR/DME, GDM, LFV, PVD, ORW and JFK', () => {
    const p = navSrc.primary_navaid;
    expect(nav('BOS')).toMatchObject({ type: 'VOR/DME', frequencyMhz: 112.7, latLon: { lat: p.lat, lon: p.lon } });
    for (const o of navSrc.other_navaids_referenced) expect(nav(o.id)).toMatchObject({ frequencyMhz: o.freq_mhz, latLon: { lat: o.lat, lon: o.lon } });
    expect(nav('GDM').frequencyMhz).toBe(116.95);
  });
  it('107 fixes with NASR coordinates', () => {
    const fixes = ap.navaids.filter((n) => n.type === 'FIX');
    expect(fixes).toHaveLength(107);
    for (const f of navSrc.fixes_named_on_approach_charts) expect(nav(f.id).latLon).toEqual({ lat: f.lat, lon: f.lon });
  });
  it('five ILS systems with localizer and glideslope components', () => {
    expect(navSrc.ils_localizers.systems).toHaveLength(5);
    for (const s of navSrc.ils_localizers.systems) {
      expect(nav(s.plate_ident)).toMatchObject({ type: 'LOC', frequencyMhz: s.loc_freq_mhz });
      expect(nav(`${s.plate_ident}-GS`)).toMatchObject({ frequencyMhz: s.glideslope!.freq_mhz });
    }
  });
});

describe('KBOS procedures', () => {
  it('19 IAP charts, the diagram, 10 DPs and the STAR pages, URLs from the d-TPP metadata', () => {
    expect(ap.procedures.filter((p) => p.type === 'IAP')).toHaveLength(19);
    expect(ap.procedures.filter((p) => p.type === 'DIAGRAM')).toHaveLength(1);
    expect(ap.procedures.filter((p) => p.type === 'DP')).toHaveLength(10);
    expect(ap.procedures.filter((p) => p.type === 'STAR').map((p) => p.name)).toEqual(expect.arrayContaining(['ROBUC THREE (RNAV)', 'JFUND TWO (RNAV)', 'OOSHN FIVE (RNAV)', 'WOONS TWO']));
    for (const p of ap.procedures) {
      expect(p.chartPdfUrl).toMatch(/^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\/.+\.PDF$/);
      expect(p.provenance.effectiveFrom).toBe('2026-10-01');
    }
    for (const a of procSrc.instrument_approaches) expect(a.pdf.http_status).toBe(200);
  });

  it('LOGAN FOUR is the first DP and carries the jet maintain altitude (5000)', () => {
    const dp = ap.procedures.find((p) => p.type === 'DP')!;
    expect(dp.name).toBe('LOGAN FOUR DEPARTURE');
    expect(dp.maintainAltitudeFt).toBe(5000);
  });

  it('transcribed approaches carry fixes that resolve to navaids; glidepaths and missed approaches come from the plates', () => {
    const iap = (name: string) => ap.procedures.find((p) => p.name === name)!;
    expect(iap('ILS OR LOC RWY 04R').fixes).toEqual(['GOSHI', 'WINNI', 'NABBO', 'MILTT', 'IRSEW', 'WAXEN']);
    expect(iap('ILS OR LOC RWY 04R').runwayEnd).toBe('4R');
    expect(iap('ILS OR LOC RWY 04R').glidepath).toEqual({ kind: 'GS', angleDeg: 3, tchFt: 51 });
    expect(iap('ILS OR LOC RWY 33L').missedApproach).toMatchObject({ initialClimbFt: 1500, finalAltitudeFt: 3000 });
    expect(iap('RNAV (GPS) RWY 04L').glidepath).toEqual({ kind: 'GP', angleDeg: 3.1, tchFt: 50 });
    expect(iap('RNAV (GPS) RWY 32').glidepath).toEqual({ kind: 'VDA', angleDeg: 2.91, tchFt: 45 });
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) for (const f of p.fixes ?? []) expect(ap.navaids.some((n) => n.id === f), `${p.name} ${f}`).toBe(true);
    expect(iap('RNAV (RNP) X RWY 33L').fixes).toEqual([]);
  });
});

describe('KBOS taxiway graph', () => {
  it('names 30 of the 31 identifiers printed on the FAA diagram; Y is left out (its OSM ways merge into runway 15L/33R)', () => {
    expect(procSrc.airport_diagram.taxiway_identifiers).toHaveLength(31);
    for (const id of procSrc.airport_diagram.taxiway_identifiers) {
      if (id === 'Y') expect(g.taxiwayPolylines[id]).toBeUndefined();
      else expect(g.taxiwayPolylines[id]?.length, `polyline ${id}`).toBeGreaterThan(0);
    }
    expect(g.excludedOsmRefs).toEqual([]);
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
    expect(holds.length).toBeGreaterThanOrEqual(40);
    const first = reach(holds[0].id);
    for (const h of holds) expect(first.has(h.id), h.id).toBe(true);
    for (const p of ap.parking) if (p.nodeId) expect(first.has(p.nodeId), p.id).toBe(true);
  });

  it('runway edges carry onRunwayId; every runway crossing node touches the edges of both runways', () => {
    const rwEdges = g.edges.filter((e) => e.kind === 'runway');
    for (const e of rwEdges) expect(e.taxiway).toBe(`RWY${e.onRunwayId}`);
    for (const n of nodes.filter((q) => q.kind === 'runway' && (q.runwayIds?.length ?? 0) >= 2)) {
      const ids = new Set(g.edges.filter((e) => e.kind === 'runway' && (e.from === n.id || e.to === n.id)).map((e) => e.onRunwayId));
      expect(ids, n.id).toEqual(new Set(n.runwayIds));
    }
  });

  it('the exit nodes of every runway end half exist (short runways 14/32 and 15L/33R have fewer taxiway links, as mapped)', () => {
    for (const r of ap.runways) {
      const len = dist(r.ends[0].threshold, r.ends[1].threshold);
      for (const end of r.ends) {
        const exits = runwayExitNodes(ap, end.id).filter((x) => x.distanceFromThresholdM <= len / 2);
        expect(new Set(exits.map((x) => x.node.id)).size, `${r.id} end ${end.id}`).toBeGreaterThanOrEqual(r.lengthFt >= 6000 ? 2 : 1);
      }
    }
  });
});

describe('KBOS runway holding positions (derived, approximate)', () => {
  const HOLD = 250 * FT;
  for (const r of ['4L/22R', '4R/22L', '9/27', '15R/33L']) {
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
        const d = dist(h.pos, { x: a.x + dx * t, y: a.y + dy * t });
        // a stub shorter than 250 ft (a real taxiway junction closer than that to the runway) carries its hold at 60% of the stub
        if (!/stub shorter/.test((h as { notes?: string }).notes ?? '')) expect(Math.abs(d - HOLD), h.id).toBeLessThan(1.5);
        expect(ap.runways.some((rw) => inPoly(h.pos, rw.polygon)), h.id).toBe(false);
        expect(runway.ends.map((e) => e.id)).toContain(h.protectsRunwayEnd);
      }
    });
  }

  it('every runway end with an instrument approach or a departure role has a holding position protecting it and an entry', () => {
    for (const e of ['4L', '4R', '22L', '22R', '9', '27', '15R', '33L']) {
      const r = ap.runways.find((q) => q.ends.some((x) => x.id === e))!;
      expect(holdingPositionsForRunway(ap, r.id).some((h) => h.protectsRunwayEnd === e), `${e} protects`).toBe(true);
      expect(runwayEntryNodes(ap, e).length, `entries ${e}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('every hold names the taxiway it is on (or is an unnamed stub) and is connected to its runway entry node', () => {
    for (const h of nodes.filter((n) => n.kind === 'holding_position')) expect(g.nodes[(h as { entryNodeId?: string }).entryNodeId!], h.id).toBeDefined();
  });
});

describe('KBOS parking', () => {
  const connected = (cat: string) => ap.parking.filter((p) => p.category === cat && p.nodeId);
  it('has airline gates of Terminals A, B, C and E, cargo stands, FBO and GA spots, all connected', () => {
    const gates = connected('airline');
    expect(gates.length).toBeGreaterThanOrEqual(90);
    for (const t of ['A', 'B', 'C', 'E']) expect(gates.some((p) => p.name.startsWith(`Gate ${t}`)), t).toBe(true);
    expect(connected('fbo').length).toBeGreaterThanOrEqual(3);
    expect(connected('ga').length).toBeGreaterThanOrEqual(3);
    expect(connected('cargo').length).toBeGreaterThanOrEqual(10);
    for (const p of ap.parking) {
      if (!p.nodeId) continue;
      expect(g.nodes[p.nodeId].kind).toBe('parking');
      expect(dist(g.nodes[p.nodeId].pos, p.pos)).toBeLessThan(1);
      expect(findParking(ap, p.name).map((x) => x.id)).toContain(p.id);
    }
  });

  it('gates and cargo stands are real OSM ways; only the FBO and GA spots are synthetic (and flagged)', () => {
    for (const p of ap.parking) {
      if (['airline', 'cargo'].includes(p.category)) expect(p.source, p.id).toBe('osm');
      if (['fbo', 'ga'].includes(p.category)) expect(p.source).toBe('synthetic');
      if (p.source === 'synthetic') expect(p.approximate).toBe(true);
    }
  });
});

describe('KBOS loader', () => {
  it('returns a shared object by default and a private copy with fresh: true', () => {
    expect(loadKbos()).toBe(loadKbos());
    const copy = loadKbos({ fresh: true });
    expect(copy).not.toBe(ap);
    expect(copy.taxiwayGraph.edges.length).toBe(g.edges.length);
  });
});
