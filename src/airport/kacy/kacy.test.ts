import { describe, expect, it } from 'vitest';
import facility from '../../../data/sources/kacy-facility.json';
import freqSrc from '../../../data/sources/kacy-frequencies.json';
import navSrc from '../../../data/sources/kacy-navaids.json';
import procSrc from '../../../data/sources/kacy-procedures.json';
import { getAirport, OSM_ATTRIBUTION, listAirports } from '..';
import { angleDiffDeg, bearingDeg } from '../projection';
import { holdingPositionsForRunway, runwayEntryNodes, runwayExitNodes } from '../graphUtils';
import { mvaAltitudeAt, mvaSectorAt } from '../mva';
import { loadKacy } from '.';

const ap = loadKacy();
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

describe('airport basics (NASR)', () => {
  it('matches the NASR ARP, elevation, variation, tower hours and class', () => {
    expect(ap.icao).toBe('KACY');
    expect(ap.faaId).toBe('ACY');
    expect(ap.arp).toEqual({ lat: facility.airport.arp.lat, lon: facility.airport.arp.lon });
    expect(ap.elevationFt).toBe(facility.airport.field_elevation_ft);
    expect(ap.magneticVariationDeg).toBe(-10);
    expect(ap.towerHours).toBe(facility.tower.tower_hours);
    expect(ap.airspaceClass).toBe('C');
  });

  it('has provenance on the airport and the registry returns it', () => {
    expect(ap.provenance.length).toBeGreaterThanOrEqual(5);
    expect(ap.provenance.every((p) => p.source && p.retrievedOn)).toBe(true);
    expect(getAirport('kacy')).toBe(ap);
    expect(getAirport('ACY')).toBe(ap);
    expect(getAirport('KJFK')).toBeUndefined();
    expect(listAirports()).toEqual(['KACY', 'KMHT', 'KPGD']);
    expect(OSM_ATTRIBUTION).toBe('© OpenStreetMap contributors, ODbL 1.0');
    expect(ap.osmAttribution).toBe(OSM_ATTRIBUTION);
    expect(g.provenance.source).toMatch(/OpenStreetMap/);
  });
});

describe('runways', () => {
  it('has runways 4/22 and 13/31 with NASR lengths, width and surface', () => {
    expect(ap.runways.map((r) => r.id).sort()).toEqual(['13/31', '4/22']);
    expect(runwayOf('13/31').lengthFt).toBe(10001);
    expect(runwayOf('4/22').lengthFt).toBe(6145);
    for (const r of ap.runways) {
      expect(r.widthFt).toBe(150);
      expect(r.provenance.effectiveFrom).toBe('2026-10-01');
    }
  });

  it('threshold-to-threshold length is within 0.5% of NASR', () => {
    for (const r of ap.runways) {
      const lenFt = dist(r.ends[0].threshold, r.ends[1].threshold) / FT;
      expect(Math.abs(lenFt - r.lengthFt) / r.lengthFt).toBeLessThan(0.005);
    }
  });

  it('true alignments are 028/208/118/298 within 1 degree, measured from the thresholds', () => {
    const expected: Record<string, number> = { '4': 28, '22': 208, '13': 118, '31': 298 };
    for (const r of ap.runways) {
      const [a, b] = r.ends;
      expect(angleDiffDeg(bearingDeg(b.threshold.x - a.threshold.x, b.threshold.y - a.threshold.y), expected[a.id])).toBeLessThan(1);
      expect(angleDiffDeg(bearingDeg(a.threshold.x - b.threshold.x, a.threshold.y - b.threshold.y), expected[b.id])).toBeLessThan(1);
      expect(a.trueHeadingDeg).toBe(expected[a.id]);
      expect(b.trueHeadingDeg).toBe(expected[b.id]);
    }
  });

  it('charted magnetic headings are true + 10 (038/218/128/308) and TDZE comes from NASR', () => {
    expect([endOf('4'), endOf('22'), endOf('13'), endOf('31')].map((e) => e.magneticHeadingDeg)).toEqual([38, 218, 128, 308]);
    const nasr = Object.fromEntries(facility.runways.flatMap((r) => r.ends.map((e) => [String(parseInt(e.id, 10)), e.tdz_elev_ft])));
    for (const e of ['4', '22', '13', '31']) expect(endOf(e).tdzeFt).toBe(nasr[e]);
  });

  it('ILS exists only on 13 (I-PVO 109.1) and 31 (I-ACY 109.1); none on 04/22', () => {
    expect(endOf('13').ils).toMatchObject({ ident: 'I-PVO', frequencyMhz: 109.1 });
    expect(endOf('31').ils).toMatchObject({ ident: 'I-ACY', frequencyMhz: 109.1 });
    expect(endOf('4').ils).toBeNull();
    expect(endOf('22').ils).toBeNull();
  });

  it('LAHSO data matches NASR / NE2LAHSO', () => {
    expect(endOf('4').lahso?.availableLandingDistanceFt).toBe(procSrc.supporting_charts.lahso_atc_entries['04'].ald_ft);
    expect(endOf('13').lahso?.availableLandingDistanceFt).toBe(procSrc.supporting_charts.lahso_atc_entries['13'].ald_ft);
    expect(endOf('31').lahso?.availableLandingDistanceFt).toBe(procSrc.supporting_charts.lahso_atc_entries['31'].ald_ft);
    expect(endOf('22').lahso).toBeNull();
    expect(endOf('13').lahso?.holdShortOfRunwayId).toBe('4/22');
  });

  it('polygons contain their own thresholds and the runway intersection, not the GA ramp or gates', () => {
    for (const r of ap.runways) {
      for (const e of r.ends) expect(inPoly(e.threshold, r.polygon)).toBe(true);
      const w = dist(r.polygon[0], r.polygon[3]);
      expect(w).toBeCloseTo(150 * FT, 0);
    }
    const hs = ap.hotSpots[0].pos!;
    expect(ap.runways.every((r) => inPoly(hs, r.polygon))).toBe(true);
    const ga = ap.parking.filter((p) => p.category === 'ga' || p.category === 'airline' || p.category === 'fbo');
    expect(ga.length).toBeGreaterThan(10);
    for (const p of ga) expect(ap.runways.some((r) => inPoly(p.pos, r.polygon))).toBe(false);
  });
});

describe('hot spot', () => {
  it('HS 1 sits on the 4/22 x 13/31 centreline intersection', () => {
    expect(ap.hotSpots).toHaveLength(1);
    expect(ap.hotSpots[0].id).toBe('HS 1');
    const [a, b] = runwayOf('13/31').ends.map((e) => e.threshold);
    const [c, d] = runwayOf('4/22').ends.map((e) => e.threshold);
    const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
    const x = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    expect(dist(ap.hotSpots[0].pos!, x)).toBeLessThan(2);
    const node = g.nodes['HS1-X'];
    expect(node.kind).toBe('runway');
    expect(dist(node.pos, x)).toBeLessThan(2);
    expect(ap.hotSpots[0].description).toMatch(/Rwy 13-31 at Twy A and Rwy 04-22 at Twy B/);
  });
});

describe('frequencies equal the verified source', () => {
  const f = (id: string) => ap.frequencies.find((x) => x.id === id)!;
  const s = freqSrc.summary_by_function;
  it('VHF values', () => {
    expect(f('ATIS').mhz).toBe(parseFloat(s.ATIS.vhf));
    expect(f('CLNC').mhz).toBe(parseFloat(s.clearance_delivery.vhf));
    expect(f('GND').mhz).toBe(parseFloat(s.ground.vhf));
    expect(f('TWR').mhz).toBe(parseFloat(s.tower.vhf));
    expect(f('APP').mhz).toBe(parseFloat(s.approach_departure_south.vhf));
    expect(f('DEP').mhz).toBe(parseFloat(s.approach_departure_south.vhf));
    expect(f('APP-N').mhz).toBe(parseFloat(s.approach_departure_north.vhf));
    expect(f('DEP-N').mhz).toBe(parseFloat(s.approach_departure_north.vhf));
    expect([f('ATIS').mhz, f('CLNC').mhz, f('GND').mhz, f('TWR').mhz, f('APP').mhz, f('APP-N').mhz]).toEqual([125.725, 127.85, 121.9, 120.3, 124.6, 134.25]);
  });
  it('approach/departure sector bearings come from NASR (south 130-309 on APP/DEP = 124.6, north 310-129 on APP-N/DEP-N = 134.25)', () => {
    expect(s.approach_departure_south.sectorization_bearings).toBe('130-309');
    expect(s.approach_departure_north.sectorization_bearings).toBe('310-129');
    for (const id of ['APP', 'DEP']) {
      expect(f(id).mhz).toBe(124.6);
      expect(f(id).sectorBearings).toEqual({ fromDeg: 130, toDeg: 309 });
    }
    for (const id of ['APP-N', 'DEP-N']) {
      expect(f(id).mhz).toBe(134.25);
      expect(f(id).sectorBearings).toEqual({ fromDeg: 310, toDeg: 129 });
    }
    for (const id of ['ATIS', 'CLNC', 'GND', 'TWR']) expect(f(id).sectorBearings).toBeUndefined();
  });
  it('positions and UHF notes', () => {
    expect(f('ATIS').position).toBe('ATIS');
    expect(f('CLNC').position).toBe('CLNC');
    expect(f('GND').position).toBe('GND');
    expect(f('TWR').position).toBe('TWR');
    expect(f('APP').position).toBe('APP');
    expect(f('DEP-N').position).toBe('DEP');
    expect(f('TWR').provenance.notes).toContain(s.tower.uhf);
    expect(f('APP').provenance.notes).toContain(s.approach_departure_south.uhf);
    expect(f('APP-N').provenance.notes).toContain(s.approach_departure_north.uhf);
    expect(f('ATIS').provenance.notes).toContain(s.ATIS.uhf);
  });
});

describe('navaids and fixes equal the verified source', () => {
  const nav = (id: string) => ap.navaids.find((n) => n.id === id)!;
  it('ACY VORTAC with restricted status', () => {
    const v = navSrc.vortac_acy;
    expect(nav('ACY')).toMatchObject({ type: 'VORTAC', frequencyMhz: v.freq_mhz, latLon: { lat: v.lat, lon: v.lon } });
    expect(nav('ACY').provenance.notes).toContain('OPERATIONAL RESTRICTED');
    expect((nav('ACY') as unknown as { status: string }).status).toBe('OPERATIONAL RESTRICTED');
  });
  it('VCN, SIE, CYN and the other referenced VORs', () => {
    for (const o of navSrc.other_navaids_referenced_by_kacy_procedures) {
      expect(nav(o.id)).toMatchObject({ type: o.type, frequencyMhz: parseFloat(o.freq_mhz), latLon: { lat: o.lat, lon: o.lon } });
    }
    for (const id of ['VCN', 'SIE', 'CYN']) expect(nav(id)).toBeDefined();
  });
  it('36 fixes with NASR coordinates', () => {
    const fixes = ap.navaids.filter((n) => n.type === 'FIX');
    expect(fixes).toHaveLength(36);
    for (const f of navSrc.fixes_named_on_kacy_approach_charts) expect(nav(f.id).latLon).toEqual({ lat: f.lat, lon: f.lon });
  });
  it('ILS components', () => {
    for (const s of navSrc.ils_localizers_at_kacy.systems) {
      expect(nav(s.plate_ident)).toMatchObject({ type: 'LOC', frequencyMhz: s.loc_freq_mhz, latLon: { lat: s.localizer_antenna.lat, lon: s.localizer_antenna.lon } });
      expect(nav(`${s.plate_ident}-GS`)).toMatchObject({ frequencyMhz: s.glideslope.freq_mhz });
      expect(nav(`${s.plate_ident}-DME`).type).toBe('DME');
    }
  });
});

describe('procedures', () => {
  it('13 IAPs + airport diagram + ATLANTIC CITY THREE DP with verified aeronav URLs', () => {
    const iaps = ap.procedures.filter((p) => p.type === 'IAP');
    expect(iaps).toHaveLength(13);
    expect(ap.procedures.filter((p) => p.type === 'DIAGRAM')).toHaveLength(1);
    const dp = ap.procedures.filter((p) => p.type === 'DP');
    expect(dp).toHaveLength(1);
    expect(dp[0].name).toBe('ATLANTIC CITY THREE DEPARTURE');
    const urls = new Set([
      ...procSrc.instrument_approaches.map((a) => a.pdf.url),
      procSrc.airport_diagram.pdf.url,
      ...procSrc.departure_procedures.map((d) => d.pdf.url),
    ]);
    expect(new Set(ap.procedures.map((p) => p.chartPdfUrl))).toEqual(urls);
    for (const p of ap.procedures) {
      expect(p.chartPdfUrl).toMatch(/^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\/.+\.PDF$/);
      expect(p.provenance.effectiveFrom).toBe('2026-10-01');
    }
    expect(iaps.find((p) => p.name === 'ILS OR LOC/DME RWY 31')?.runwayEnd).toBe('31');
    expect(iaps.find((p) => p.name === 'RNAV (GPS) RWY 04')?.fixes).toContain('FASEN');
  });

  it('IAPs carry the plate transcriptions (missed approach, holding, minima) from the source', () => {
    const iap = (name: string) => ap.procedures.find((p) => p.name === name)!;
    expect(iap('ILS Z OR LOC Z RWY 13').missedApproachText).toMatch(/SMITS/);
    expect(iap('RNAV (GPS) Y RWY 31').missedApproachText).toMatch(/KOVEC/);
    for (const a of procSrc.instrument_approaches) {
      const p = iap(a.chart_name);
      expect(p.missedApproachText, a.chart_name).toBe(a.missed_approach);
      expect(p.minimaText, a.chart_name).toBe(a.minima_summary);
      expect(p.holdingText, a.chart_name).toBe(a.holding === '-' ? undefined : a.holding);
      expect(p.provenance.notes).toMatch(/transcription/);
    }
    expect(iap('ILS Z OR LOC Z RWY 13').holdingText).toMatch(/CARYL/);
  });
});

describe('holding patterns (plate transcriptions)', () => {
  const proc = (name: string) => ap.procedures.find((p) => p.name === name)!;
  const hold = (name: string, fix: string) => proc(name).holdingPatterns!.filter((h) => h.fix === fix);

  it('TUBER on RNAV (GPS) RWY 22: inbound 017 (outbound 197), right turns, 6 NM, missed approach', () => {
    const [h] = hold('RNAV (GPS) RWY 22', 'TUBER');
    expect(h).toMatchObject({ inboundCourseDeg: 17, turns: 'right', legNm: 6, role: 'missed_approach' });
    expect(h.legMinutes).toBeUndefined();
    expect((h as unknown as { outboundCourseDeg: number }).outboundCourseDeg).toBe(197);
  });

  it('SMITS missed-approach hold is inbound 270 (ACY R-090) with right turns on every plate that uses it', () => {
    for (const n of ['ILS Z OR LOC Z RWY 13', 'ILS OR LOC/DME RWY 31', 'HI-ILS Y OR LOC Y RWY 13', 'VOR RWY 04', 'VOR RWY 31', 'HI-VOR OR TACAN RWY 31', 'COPTER ILS OR LOC/DME RWY 13', 'RNAV (GPS) RWY 04']) {
      const h = hold(n, 'SMITS').find((x) => x.inboundCourseDeg === 270);
      expect(h, n).toBeDefined();
      expect(h).toMatchObject({ turns: 'right', role: 'missed_approach' });
    }
    expect(hold('RNAV (GPS) RWY 04', 'SMITS')[0].legNm).toBe(6);
    expect(hold('VOR RWY 31', 'SMITS')[0].legMinutes).toBe(1);
  });

  it('hold-in-lieu and arrival holds, leg lengths and speed limits as printed', () => {
    expect(hold('ILS OR LOC/DME RWY 31', 'STEVV')[0]).toMatchObject({ inboundCourseDeg: 308, turns: 'right', legMinutes: 1, role: 'hold_in_lieu' });
    expect(hold('ILS Z OR LOC Z RWY 13', 'CARYL')[0]).toMatchObject({ inboundCourseDeg: 128, turns: 'right', legMinutes: 1, role: 'hold_in_lieu' });
    expect(hold('RNAV (GPS) Y RWY 13', 'CARYL')[0]).toMatchObject({ inboundCourseDeg: 128, turns: 'right', legNm: 6, role: 'hold_in_lieu' });
    expect(hold('RNAV (GPS) RWY 04', 'JEDOB')[0]).toMatchObject({ inboundCourseDeg: 38, turns: 'right', legNm: 6, role: 'hold_in_lieu' });
    expect(hold('VOR RWY 04', 'MEADY')[0]).toMatchObject({ inboundCourseDeg: 48, turns: 'left', legMinutes: 1, role: 'hold_in_lieu' });
    expect(hold('HI-ILS Y OR LOC Y RWY 13', 'ZAPOM')[0]).toMatchObject({ inboundCourseDeg: 35, turns: 'left', role: 'arrival' });
    expect(hold('RNAV (GPS) Y RWY 13', 'RODDI')[0]).toMatchObject({ inboundCourseDeg: 218, turns: 'right', legNm: 5, maxSpeedKt: 230, role: 'missed_approach' });
    expect(hold('RNAV (RNP) Z RWY 13', 'RODDI')[0]).toMatchObject({ legNm: 5, role: 'missed_approach' });
    expect(hold('RNAV (GPS) Y RWY 31', 'KOVEC')[0]).toMatchObject({ inboundCourseDeg: 38, turns: 'right', legNm: 6, role: 'missed_approach' });
    expect(hold('RNAV (RNP) Z RWY 31', 'KOVEC')).toHaveLength(1);
  });

  it('every IAP has a missed-approach hold; every hold has a leg length and plate provenance', () => {
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) {
      expect(p.holdingPatterns!.some((h) => h.role === 'missed_approach'), p.name).toBe(true);
      for (const h of p.holdingPatterns!) {
        expect(h.legNm !== undefined || h.legMinutes !== undefined, `${p.name} ${h.fix}`).toBe(true);
        expect((h as unknown as { source: string }).source, p.name).toMatch(/transcribed from plate P_.*\.png .* by visual read/);
      }
    }
  });
});

describe('minimum vectoring altitude sectors (FAA MVA product, ACY)', () => {
  const sectors = ap.mvaSectors ?? [];
  const inRing = (p: { x: number; y: number }, ring: { x: number; y: number }[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  it('has sectors A-I, each with >= 3 vertices and an altitude between 1,000 and 10,000 ft', () => {
    expect(sectors.map((s) => (s as { name?: string }).name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    // sector table (also in build-report.md)
    console.table(sectors.map((s) => ({ sector: (s as { name?: string }).name, altitudeFt: s.altitudeFt, vertices: s.polygon.length, holes: ((s as { holes?: unknown[] }).holes ?? []).length })));
    for (const s of sectors) {
      expect(s.polygon.length, s.id).toBeGreaterThanOrEqual(3);
      expect(s.altitudeFt, s.id).toBeGreaterThanOrEqual(1000);
      expect(s.altitudeFt, s.id).toBeLessThanOrEqual(10000);
      expect(s.provenance.url).toMatch(/aeronav\.faa\.gov\/MVA_Charts\/.*ACY_MVA/);
      expect(s.provenance.notes).toMatch(/Effective date not stated/);
    }
  });

  it('the ARP lies inside exactly one sector (hole rings excluded): A at 1600 ft', () => {
    const hits = sectors.filter((s) => inRing({ x: 0, y: 0 }, s.polygon) && !((s as { holes?: { x: number; y: number }[][] }).holes ?? []).some((h) => inRing({ x: 0, y: 0 }, h)));
    expect(hits).toHaveLength(1);
    expect(hits[0].altitudeFt).toBe(1600);
    expect(mvaSectorAt(ap, { x: 0, y: 0 })?.id).toBe('ACY-MVA-A');
    expect(mvaAltitudeAt(ap, { x: 0, y: 0 })).toBe(1600);
  });

  it('every runway threshold and the offshore/outer areas resolve to a published altitude', () => {
    for (const r of ap.runways) for (const e of r.ends) expect(mvaAltitudeAt(ap, e.threshold), `${r.id} ${e.id}`).toBeGreaterThanOrEqual(1000);
    // points ~40 nm out in the various directions are covered by some sector or none, never throw
    for (const [x, y] of [[0, 74000], [74000, 0], [0, -74000], [-74000, 0]]) {
      const a = mvaAltitudeAt(ap, { x, y });
      if (a !== undefined) expect(a).toBeLessThanOrEqual(10000);
    }
  });
});

describe('published fix altitudes (plate transcriptions)', () => {
  const alt = (proc: string, fix: string) => ap.procedures.find((p) => p.name === proc)!.fixAltitudes!.filter((f) => f.fix === fix);

  it('RNAV (GPS) RWY 22: KOPCE 1800, FLDER 1600, EFEWY 1100 (minimums)', () => {
    expect(alt('RNAV (GPS) RWY 22', 'KOPCE')[0].minAltitudeFt).toBe(1800);
    expect(alt('RNAV (GPS) RWY 22', 'FLDER')[0].minAltitudeFt).toBe(1600);
    expect(alt('RNAV (GPS) RWY 22', 'EFEWY')[0].minAltitudeFt).toBe(1100);
  });

  it('ILS Z 13 FAF MAYBN 1600 (GS intercept) with CARYL hold 2000-4500; ILS 31 FAF PRSTY 1700 with STEVV 2000', () => {
    expect(alt('ILS Z OR LOC Z RWY 13', 'MAYBN')[0].minAltitudeFt).toBe(1600);
    expect(alt('ILS Z OR LOC Z RWY 13', 'CARYL')[0]).toMatchObject({ minAltitudeFt: 2000, maxAltitudeFt: 4500 });
    expect(alt('ILS OR LOC/DME RWY 31', 'PRSTY')[0].minAltitudeFt).toBe(1700);
    expect(alt('ILS OR LOC/DME RWY 31', 'STEVV')[0].minAltitudeFt).toBe(2000);
  });

  it('mandatory altitudes and holds are distinguished from minimums', () => {
    expect(alt('HI-ILS Y OR LOC Y RWY 13', 'ACY')[0].mandatoryAltitudeFt).toBe(4000);
    expect(alt('HI-VOR OR TACAN RWY 31', 'ACY')[0].mandatoryAltitudeFt).toBe(4000);
    expect(alt('HI-ILS Y OR LOC Y RWY 13', 'ZAPOM')[0]).toMatchObject({ minAltitudeFt: 14000, maxAltitudeFt: 17500 });
    expect(alt('VOR RWY 04', 'MEADY').map((f) => f.minAltitudeFt)).toEqual([2000, 1700]);
  });

  it('every IAP has fix altitudes with plate provenance', () => {
    for (const p of ap.procedures.filter((x) => x.type === 'IAP')) {
      expect(p.fixAltitudes!.length, p.name).toBeGreaterThan(0);
      for (const f of p.fixAltitudes!) {
        expect(f.minAltitudeFt ?? f.maxAltitudeFt ?? f.mandatoryAltitudeFt, `${p.name} ${f.fix}`).toBeDefined();
        expect(f.note, `${p.name} ${f.fix}`).toMatch(/transcribed from plate P_.*\.png .* by visual read/);
      }
    }
  });
});

describe('taxiway graph', () => {
  it('contains all 12 FAA diagram identifiers (A B C D G H J K L M N P) and not the OSM-only I', () => {
    for (const id of ['A', 'B', 'C', 'D', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P']) {
      expect(g.taxiwayPolylines[id]?.length, `polyline ${id}`).toBeGreaterThan(0);
      expect(g.edges.some((e) => e.taxiway === id), `edge ${id}`).toBe(true);
      expect(nodes.some((n) => n.taxiways.includes(id)), `node ${id}`).toBe(true);
    }
    expect(g.taxiwayPolylines['I']).toBeUndefined();
    expect(g.edges.some((e) => e.taxiway === 'I')).toBe(false);
    expect(g.excludedOsmRefs).toEqual(['I']);
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

  it('runway edges lie on the runways and carry onRunwayId; HS 1 node joins both runways', () => {
    const rwEdges = g.edges.filter((e) => e.kind === 'runway');
    expect(rwEdges.length).toBeGreaterThan(8);
    for (const e of rwEdges) {
      expect(e.onRunwayId).toBeDefined();
      expect(e.taxiway).toBe(`RWY${e.onRunwayId}`);
    }
    const hsEdges = g.edges.filter((e) => e.from === 'HS1-X' || e.to === 'HS1-X');
    expect(new Set(hsEdges.map((e) => e.onRunwayId))).toEqual(new Set(['4/22', '13/31']));
    expect(hsEdges).toHaveLength(4);
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

describe('runway holding positions (derived, approximate)', () => {
  const HOLD = 250 * FT;
  for (const r of ['4/22', '13/31']) {
    it(`runway ${r}: holds sit ~250 ft from the centreline, outside the runway polygon, flagged approximate`, () => {
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
        expect(Math.abs(d - HOLD), h.id).toBeLessThan(1.5);
        expect(inPoly(h.pos, runway.polygon), h.id).toBe(false);
        expect(runway.ends.map((e) => e.id)).toContain(h.protectsRunwayEnd);
      }
    });
  }

  it('protectsRunwayEnd is the end whose threshold is nearest the entry point', () => {
    for (const h of nodes.filter((n) => n.kind === 'holding_position')) {
      const entry = g.nodes[(h as { entryNodeId?: string }).entryNodeId!];
      const runway = runwayOf(h.runwayId!);
      const dists = runway.ends.map((e) => ({ id: e.id, d: dist(entry.pos, e.threshold) })).sort((x, y) => x.d - y.d);
      expect(h.protectsRunwayEnd, h.id).toBe(dists[0].id);
      expect(h.notes).toContain('nearer threshold');
    }
  });

  it('each runway end has at least one holding position within 1000 ft of its threshold', () => {
    for (const r of ap.runways) {
      for (const e of r.ends) {
        const near = holdingPositionsForRunway(ap, r.id).filter((h) => dist(h.pos, e.threshold) <= 1000 * FT);
        expect(near.length, `${r.id} end ${e.id}`).toBeGreaterThanOrEqual(1);
        expect(near.some((h) => h.protectsRunwayEnd === e.id), `${r.id} end ${e.id} protects`).toBe(true);
      }
    }
  });

  it('A and B cross the hot-spot runways with holds on both sides', () => {
    const aCross = holdingPositionsForRunway(ap, '13/31').filter((h) => h.taxiways.includes('A'));
    const bCross = holdingPositionsForRunway(ap, '4/22').filter((h) => h.taxiways.includes('B'));
    expect(aCross.length).toBe(2);
    expect(bCross.length).toBe(2);
  });
});

describe('runway entry / exit ordering', () => {
  it('entry nodes for 13 and 31 are ordered by distance from the threshold; first is the full-length entry', () => {
    for (const end of ['13', '31', '4', '22']) {
      const thr = endOf(end).threshold;
      const entries = runwayEntryNodes(ap, end);
      expect(entries.length).toBeGreaterThanOrEqual(3);
      const ds = entries.map((h) => dist(thr, g.nodes[(h as { entryNodeId?: string }).entryNodeId!].pos));
      expect(ds).toEqual([...ds].sort((x, y) => x - y));
      expect(dist(thr, entries[0].pos)).toBeLessThan(250);
    }
    expect(runwayEntryNodes(ap, '13')[0].taxiways).toEqual(['B']);
    expect(runwayEntryNodes(ap, '31')[0].taxiways).toEqual(['B']);
  });

  it('exits for 13 and 31 are sorted by distance along the runway', () => {
    for (const end of ['13', '31']) {
      const exits = runwayExitNodes(ap, end);
      expect(exits.length).toBeGreaterThanOrEqual(5);
      const ds = exits.map((x) => x.distanceFromThresholdM);
      expect(ds).toEqual([...ds].sort((x, y) => x - y));
      for (const x of exits) {
        expect(x.exitAngleDeg).toBeGreaterThanOrEqual(0);
        expect(x.exitAngleDeg).toBeLessThanOrEqual(180);
        expect(['left', 'right']).toContain(x.side);
      }
    }
    const ex13 = runwayExitNodes(ap, '13');
    const ex31 = runwayExitNodes(ap, '31');
    expect(ex13[0].taxiway).toBe('B');
    expect(ex31[0].taxiway).toBe('B');
    // the same physical node set, mirrored
    expect(new Set(ex13.map((x) => x.node.id))).toEqual(new Set(ex31.map((x) => x.node.id)));
    expect(ex13.map((x) => x.taxiway).slice(0, 3)).toContain('C');
    expect(ex31.map((x) => x.taxiway).slice(0, 3)).toContain('J');
  });
});

describe('parking', () => {
  const connected = (cat: string) => ap.parking.filter((p) => p.category === cat && p.nodeId && !p.connectorOverLimit);
  it('has several airline gates, GA ramp spots and an FBO spot, all connected within 150 m', () => {
    expect(connected('airline').length).toBe(10);
    expect(connected('ga').length).toBeGreaterThanOrEqual(5);
    expect(connected('fbo').length).toBeGreaterThanOrEqual(1);
    for (const p of ap.parking) {
      if (!p.nodeId) continue;
      expect(g.nodes[p.nodeId].kind).toBe('parking');
      expect(dist(g.nodes[p.nodeId].pos, p.pos)).toBeLessThan(0.05);
      expect(p.connectorLengthM ?? 0).toBeLessThanOrEqual(150);
    }
  });

  it('synthetic spots are flagged; gates are real OSM stands', () => {
    for (const p of ap.parking) {
      if (p.category === 'airline') {
        expect(p.source).toBe('osm');
        expect(p.zone).toBe('Terminal');
      }
      if (p.source === 'synthetic') expect(p.approximate).toBe(true);
    }
    expect(ap.parking.filter((p) => p.category === 'airline').map((p) => p.name).sort()).toEqual(['Gate 1', 'Gate 10', 'Gate 2', 'Gate 3', 'Gate 4', 'Gate 5', 'Gate 6', 'Gate 7', 'Gate 8', 'Gate 9']);
    expect(new Set(ap.parking.map((p) => p.category))).toContain('military');
  });

  it('has apron polygons and buildings for rendering', () => {
    expect(g.aprons.length).toBeGreaterThanOrEqual(3);
    expect(ap.buildings.some((b) => b.kind === 'terminal')).toBe(true);
    expect(ap.buildings.some((b) => b.kind === 'hangar')).toBe(true);
  });
});

describe('loader', () => {
  it('returns a shared object by default and a private copy with fresh: true', () => {
    expect(loadKacy()).toBe(loadKacy());
    const copy = loadKacy({ fresh: true });
    expect(copy).not.toBe(ap);
    expect(copy.taxiwayGraph.edges.length).toBe(g.edges.length);
  });
});
