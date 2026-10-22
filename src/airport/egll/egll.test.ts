import { describe, expect, it } from 'vitest';
import facility from '../../../data/sources/egll-facility.json';
import freqSrc from '../../../data/sources/egll-frequencies.json';
import navSrc from '../../../data/sources/egll-navaids.json';
import procSrc from '../../../data/sources/egll-procedures.json';
import standsSrc from '../../../data/sources/egll-stands.json';
import { getAirport, listAirports } from '..';
import { chartsByCategory, cycleFor, isLinkOnly, listCharts } from '../../charts/chartIndex';
import { airportCallName, facilityCallName } from '../../radio/frequencies';
import { loadEgll } from '.';

const ap = loadEgll();
const g = ap.taxiwayGraph;
const NM = 1852;
const FT = 0.3048;

/** AIP degrees-minutes-seconds ("512839.00N", "0002905.97W") -> decimal degrees (the rule used to write the data files). */
function dms(s: string): number {
  const h = s.slice(-1);
  const v = s.slice(0, -1);
  const deg = h === 'N' || h === 'S' ? Number(v.slice(0, 2)) : Number(v.slice(0, 3));
  const rest = h === 'N' || h === 'S' ? v.slice(2) : v.slice(3);
  const x = deg + Number(rest.slice(0, 2)) / 60 + Number(rest.slice(2)) / 3600;
  return h === 'S' || h === 'W' ? -x : x;
}
const walk = (o: unknown, f: (x: Record<string, unknown>) => void): void => {
  if (Array.isArray(o)) o.forEach((x) => walk(x, f));
  else if (o && typeof o === 'object') {
    f(o as Record<string, unknown>);
    Object.values(o).forEach((x) => walk(x, f));
  }
};
const distNm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
  const R = 3440.065;
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const brg = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
  const r = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(r(b.lon - a.lon)) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

describe('EGLL basics (UK AIP AD 2.2)', () => {
  it('matches the AIP ARP, elevation, variation, hours, airspace, zone and units', () => {
    expect(ap.icao).toBe('EGLL');
    expect(ap.faaId).toBe('LHR');
    expect(ap.name).toBe('Heathrow');
    expect(ap.arp.lat).toBeCloseTo(dms('512839N'), 6);
    expect(ap.arp.lon).toBeCloseTo(dms('0002741W'), 6);
    expect(ap.elevationFt).toBe(83);
    expect(ap.magneticVariationDeg).toBe(1.23);
    expect(ap.towerHours).toBe('H24');
    expect(ap.airspaceClass).toBe('D');
    expect(ap.timeZone).toBe('Europe/London');
    expect(ap.altimeterUnit).toBe('hPa');
  });
  it('is registered; provenance names the UK AIP, not NASR', () => {
    expect(getAirport('egll')).toBe(ap);
    expect(listAirports()).toContain('EGLL');
    expect(ap.provenance.every((p) => p.source && p.retrievedOn)).toBe(true);
    expect(ap.provenance.some((p) => /UK AIP/.test(p.source))).toBe(true);
    expect(ap.provenance.some((p) => /NASR|d-TPP/.test(p.source))).toBe(false);
    expect(facility._provenance.retrieved).toBe('2026-10-21');
    expect(facility._provenance.airac_cycle).toBe('AIRAC 10/2026');
  });
  it('decimal coordinates in the data files equal the AIP DMS strings next to them', () => {
    let checked = 0;
    for (const file of [facility, navSrc, procSrc]) {
      walk(file, (x) => {
        if (typeof x.lat_dms === 'string' && typeof x.lon_dms === 'string' && typeof x.lat === 'number' && typeof x.lon === 'number') {
          expect(x.lat).toBeCloseTo(dms(x.lat_dms), 7);
          expect(x.lon).toBeCloseTo(dms(x.lon_dms), 7);
          checked++;
        }
      });
    }
    expect(checked).toBeGreaterThan(60);
  });
});

describe('EGLL runways (AD 2.12, 2.13, 2.19)', () => {
  const end = (id: string) => ap.runways.flatMap((r) => r.ends).find((e) => e.id === id)!;
  it('two parallel runways, no crossing node anywhere in the graph', () => {
    expect(ap.runways.map((r) => r.id)).toEqual(['9L/27R', '9R/27L']);
    expect(ap.runways[0].lengthFt).toBeCloseTo(3901 / FT, 0);
    expect(ap.runways[1].lengthFt).toBeCloseTo(3658 / FT, 0);
    for (const r of ap.runways) expect(r.widthFt).toBeCloseTo(50 / FT, 0);
    expect(Object.values(g.nodes).filter((n) => (n.runwayIds?.length ?? 0) >= 2)).toEqual([]);
    expect(Object.keys(g.nodes).some((id) => id.startsWith('RWX'))).toBe(false);
  });
  it('true bearings, charted magnetic headings, declared distances and displaced thresholds', () => {
    expect([end('9L').trueHeadingDeg, end('27R').trueHeadingDeg, end('9R').trueHeadingDeg, end('27L').trueHeadingDeg]).toEqual([89.67, 269.71, 89.68, 269.72]);
    expect([end('9L').magneticHeadingDeg, end('9R').magneticHeadingDeg, end('27L').magneticHeadingDeg, end('27R').magneticHeadingDeg]).toEqual([88, 88, 268, 268]);
    expect(end('9L').declaredDistancesFt?.lda).toBeCloseTo(3592 / FT, 0);
    expect(end('9R').declaredDistancesFt?.lda).toBeCloseTo(3350 / FT, 0);
    expect(end('27R').declaredDistancesFt?.toda).toBeCloseTo(3960 / FT, 0);
    expect(end('9L').displacedThresholdFt).toBeCloseTo(309 / FT, 0);
    expect(end('9R').displacedThresholdFt).toBeCloseTo(308 / FT, 0);
    expect(end('27L').displacedThresholdFt).toBeUndefined();
  });
  it('the AIP landing thresholds are where the build puts them: distance between them equals the 09 LDA', () => {
    const r1 = facility.runways[0];
    const a = r1.ends[0].displaced_threshold;
    const b = r1.ends[1].threshold;
    // spherical distance (mean radius) is 0.3 % short of the ellipsoidal one at this latitude: 15 m tolerance
    expect(Math.abs(distNm(a as { lat: number; lon: number }, b) * NM - 3592)).toBeLessThan(15);
    const r2 = facility.runways[1];
    expect(Math.abs(distNm(r2.ends[0].displaced_threshold as { lat: number; lon: number }, r2.ends[1].threshold) * NM - 3350)).toBeLessThan(15);
  });
  it('ILS: idents, frequencies, glidepath, derived course', () => {
    expect(end('9L').ils).toMatchObject({ ident: 'I-AA', frequencyMhz: 110.3, glideslopeDeg: 3 });
    expect(end('27R').ils).toMatchObject({ ident: 'I-RR', frequencyMhz: 110.3 });
    expect(end('9R').ils).toMatchObject({ ident: 'I-BB', frequencyMhz: 109.5 });
    expect(end('27L').ils).toMatchObject({ ident: 'I-LL', frequencyMhz: 109.5 });
    expect(end('27L').ils!.courseDeg).toBeCloseTo(269.72 - 1.23, 1);
  });
  it('derived ILS fixes: D7.5 and D4 agree with the LON DME distances printed on the plates (within 0.1 NM)', () => {
    const lon = navSrc.primary_navaid;
    const fix = (id: string) => navSrc.fixes_named_on_approach_charts.find((f) => f.id === id)!;
    for (const [id, printed] of [['AAFAP', 8.2], ['BBFAP', 8.2], ['LLFAP', 8.8], ['RRFAP', 8.8]] as const) {
      expect(Math.abs(distNm(lon, fix(id)) - printed)).toBeLessThan(0.1);
    }
  });
});

describe('EGLL runway configurations (AD 2.20 para 6, operator alternation programme)', () => {
  it('three configurations naming real ends; westerly ones carry the 5 kt tailwind limit', () => {
    const ids = ap.runways.flatMap((r) => r.ends.map((e) => e.id));
    expect(ap.runwayConfigurations?.map((c) => c.id)).toEqual(['W-ALT-27R', 'W-ALT-27L', 'E-SEG-09L']);
    for (const c of ap.runwayConfigurations!) for (const e of [...c.landing, ...c.departing]) expect(ids).toContain(e);
    expect(ap.runwayConfigurations![0]).toMatchObject({ landing: ['27R'], departing: ['27L'], maxTailwindKt: 5 });
    expect(ap.runwayConfigurations![2]).toMatchObject({ landing: ['9L'], departing: ['9R'] });
    expect(ap.runwayConfigurations!.every((c) => c.provenance.source && c.provenance.retrievedOn)).toBe(true);
  });
  it('alternation programme rule agrees with the 2026 table (week of 2026-10-19: 27R lands until 15:00)', () => {
    const rule = facility.alternation_programme_2026.week_of_retrieval;
    expect(rule).toEqual({ week_commencing: '2026-10-19', landings_06_15: '27R', landings_15_last: '27L' });
    const weeks = Math.round((Date.UTC(2026, 9, 19) - Date.UTC(2026, 0, 5)) / (7 * 86400000));
    expect(weeks % 2).toBe(1);
  });
});

describe('EGLL frequencies (AD 2.18) and radio calls', () => {
  const f = (id: string) => ap.frequencies.find((x) => x.id === id)!;
  it('exact values and published call signs', () => {
    expect(f('TWR').mhz).toBe(118.505);
    expect(f('GND').mhz).toBe(121.705);
    expect(f('CLNC').mhz).toBe(121.98);
    expect(f('APP').mhz).toBe(119.73);
    expect(f('ATIS').mhz).toBe(128.08);
    expect(freqSrc.summary_by_function.tower.alternates_mhz).toEqual([118.705, 124.48]);
    expect(airportCallName(ap)).toBe('Heathrow');
    expect(facilityCallName(ap, 119.73, 'APP')).toBe('Heathrow Director');
    expect(facilityCallName(ap, 121.98, 'CLNC')).toBe('Heathrow Delivery');
    expect(facilityCallName(ap, 118.505, 'TWR')).toBe('Heathrow Tower');
    expect(facilityCallName(ap, 134.125, 'DEP')).toBe('London Control');
  });
});

describe('EGLL procedures', () => {
  it('18 STARs, 24 SIDs capped at 6000 ft, 4 ILS plates with the glidepath and missed approach', () => {
    expect(ap.procedures.filter((p) => p.type === 'STAR')).toHaveLength(18);
    const dps = ap.procedures.filter((p) => p.type === 'DP');
    expect(dps).toHaveLength(24);
    expect(dps.every((d) => d.maintainAltitudeFt === 6000)).toBe(true);
    const ils = ap.procedures.filter((p) => p.type === 'IAP' && p.name.startsWith('ILS'));
    expect(ils.map((p) => p.runwayEnd).sort()).toEqual(['27L', '27R', '9L', '9R']);
    for (const p of ils) {
      expect(p.glidepath).toMatchObject({ kind: 'GS', angleDeg: 3 });
      expect(p.missedApproach?.finalAltitudeFt).toBeDefined();
      expect(p.fixes!.length).toBeGreaterThanOrEqual(3);
    }
    expect(ils.find((p) => p.runwayEnd === '27L')!.glidepath!.tchFt).toBe(56);
  });
  it('STAR legs: printed distance and magnetic track agree with the coordinates (1 NM, 2 degrees)', () => {
    const pos = (id: string) => {
      const n = [...navSrc.fixes_named_on_approach_charts, ...navSrc.other_navaids_referenced].find((x) => x.id === id)!;
      return { lat: n.lat, lon: n.lon };
    };
    let legs = 0;
    for (const s of procSrc.stars) {
      for (const l of s.star.legs) {
        const a = pos(l.from);
        const b = pos(l.to);
        expect(Math.abs(distNm(a, b) - l.distance_nm), `${s.star.ident} ${l.from}-${l.to}`).toBeLessThan(1);
        if (l.track_mag_deg !== null) {
          const d = Math.abs(((brg(a, b) - 1.23 - l.track_mag_deg + 540) % 360) - 180);
          expect(d, `${s.star.ident} ${l.from}-${l.to}`).toBeLessThan(2.5);
        }
        legs++;
      }
    }
    expect(legs).toBeGreaterThan(40);
  });
  it('every STAR ends at a terminal holding fix with the minimum holding level and 220 kt', () => {
    for (const p of ap.procedures.filter((x) => x.type === 'STAR')) {
      const st = p.star!;
      const last = st.transitions[0].fixes.at(-1)!;
      expect(['OCK', 'BIG', 'LAM', 'BNN']).toContain(last);
      expect(st.restrictions.find((r) => r.fix === last)).toMatchObject({ atOrAboveFt: 7000, speedKt: 220 });
      expect(st.runways.map((r) => r.runwayEnd).sort()).toEqual(['27L', '27R', '9L', '9R']);
    }
  });
});

describe('EGLL charts are link only (NATS copyright)', () => {
  it('official UK AIP URLs, isOfficialFaa false, never bundled', () => {
    expect(isLinkOnly('EGLL')).toBe(true);
    expect(isLinkOnly('KACY')).toBe(false);
    const all = listCharts('EGLL');
    expect(all.length).toBeGreaterThan(25); // aerodrome chart + 12 approach charts + 6 SID pages + 12 STAR pages (the hot spot chart is the aerodrome chart)
    for (const c of all) {
      expect(c.isOfficialFaa).toBe(false);
      expect(c.authority).toBe('UK AIP');
      expect(c.linkOnly).toBe(true);
      expect(c.pdfUrl).toMatch(/^https:\/\/www\.aurora\.nats\.co\.uk\/htmlAIP\/Publications\/2026-10-01-AIRAC\/graphics\/\d+\.pdf$/);
    }
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(chartsByCategory('DIAGRAM', 'EGLL')[0].name).toBe('AERODROME CHART - ICAO');
    expect(cycleFor('EGLL').label).toMatch(/UK AIP AIRAC 10\/2026, effective 2026-10-01 to 2026-10-29/);
    expect(listCharts('KACY').every((c) => c.isOfficialFaa && !c.linkOnly)).toBe(true);
  });
});

describe('EGLL taxiways, stands, hot spots', () => {
  it('names the 18 main taxiways and the numbered exits it can', () => {
    const named = new Set(g.edges.map((e) => e.taxiway).filter(Boolean));
    for (const t of 'ABCDEFGHKLMRSTVWYZ') expect(named.has(t), t).toBe(true);
    for (const t of ['A1', 'A13', 'N1', 'N11', 'S1', 'S11']) expect(named.has(t), t).toBe(true);
  });
  it('stands: terminals 2-5 and the cargo area, all numbers on the AIP stand charts', () => {
    const onChart = new Set(Object.values(standsSrc.charts).flatMap((c) => c.stand_numbers));
    expect(ap.parking.length).toBeGreaterThan(150);
    for (const p of ap.parking) {
      expect(p.id).toMatch(/^STAND-\d{3}$/);
      expect(onChart.has(p.id.slice(6))).toBe(true);
    }
    const zones = new Set(ap.parking.map((p) => p.zone));
    for (const z of ['Terminal 5', 'Terminal 3']) expect(zones.has(z)).toBe(true);
    expect(ap.parking.filter((p) => p.category === 'cargo').length).toBeGreaterThan(5);
    expect(ap.parking.filter((p) => p.category === 'ga' || p.category === 'fbo')).toHaveLength(0);
    expect(ap.parking.every((p) => p.nodeId && g.nodes[p.nodeId])).toBe(true);
  });
  it('hot spots HS1-HS5 are carried from the aerodrome chart', () => {
    expect(ap.hotSpots).toHaveLength(1);
    expect(ap.hotSpots[0].description).toMatch(/HS1\/HS2.*HS3.*HS4.*HS5/s);
  });
});
