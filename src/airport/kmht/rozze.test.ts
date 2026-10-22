/**
 * ROZZE TWO ARRIVAL (RNAV) data integrity: the d-TPP transcription in data/sources/kmht-procedures.json, built into the airport object.
 *
 * The chart legs are checked against the NASR fix coordinates (distance within 1 NM, magnetic track within 2 degrees of what is printed), the
 * runway narratives against the restriction table, the entry fixes against the IAP plates, and (when the git-ignored NASR download is present) the
 * route against NASR STAR_RTE.csv. KACY publishes no STAR and has none.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import procSrc from '../../../data/sources/kmht-procedures.json';
import { loadKacy } from '..';
import { loadKmht } from '.';
import { findStar, starFixSet, starProfile, starRouteFrom, starRunwayLeg, airportStars } from '../../sim/star';
import { starArrival } from '../../game/ifr';
import { bearingDeg, dist, mToNm, trueToMagnetic } from '../../sim/geo';
import { findNavFix } from '../../sim/navigation';

const ap = loadKmht();
const ref = findStar(ap)!;
const star = ref.star;
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('ROZZE TWO transcription', () => {
  it('is the one STAR of KMHT, named and numbered as 7110.65 4-7-1 wants (without the parenthesised "RNAV")', () => {
    expect(airportStars(ap)).toHaveLength(1);
    expect(star.ident).toBe('ROZZE2');
    expect(star.spokenName).toBe('ROZZE TWO');
    expect(ref.procedure.name).toBe('ROZZE TWO ARRIVAL (RNAV)');
    expect(ref.procedure.chartPdfUrl).toBe('https://aeronav.faa.gov/d-tpp/2610/00246ROZZE.PDF');
    expect(ap.procedures.filter((p) => p.type === 'STAR')).toHaveLength(2); // chart page + continuation page
  });
  it('carries its provenance: chart names, PDFs, cycle 2610, the printed notes', () => {
    const src = procSrc.stars[0] as { star: { provenance: string; printed_on_chart: string } };
    expect(src.star.provenance).toMatch(/d-TPP cycle 2610/);
    expect(src.star.provenance).toMatch(/00246ROZZE\.PDF/);
    expect(src.star.provenance).toMatch(/00246ROZZE_C\.PDF/);
    expect(src.star.printed_on_chart).toMatch(/ROZZE\.ROZZE2.*17AUG17.*NE-1, 01 OCT 2026 to 29 OCT 2026/);
    expect(star.notes).toEqual(['RADAR required.', 'RNAV 1.', 'DME/DME/IRU or GPS required.', 'Turbojet aircraft only.', 'MUCOW and CRIBB transitions are ATC assigned.']);
    expect(ref.procedure.provenance.source).toMatch(/d-TPP/i);
  });
  it('has the five published transitions, all ending at ROZZE, and the four runway legs starting there', () => {
    expect(star.transitions.map((t) => t.name).sort()).toEqual(['CRIBB', 'MUCOW', 'PONCT', 'QUINZ', 'SMYTH']);
    for (const t of star.transitions) {
      expect(t.fixes[0]).toBe(t.name);
      expect(t.fixes.at(-1)).toBe('ROZZE');
    }
    expect(star.runways.map((r) => r.runwayEnd).sort()).toEqual(['17', '24', '35', '6']);
    for (const r of star.runways) expect(r.fixes[0]).toBe('ROZZE');
    expect(starRunwayLeg(star, '6')!.fixes).toEqual(['ROZZE', 'PNARD', 'TEETO']);
    expect(starRunwayLeg(star, '17')!.fixes).toEqual(['ROZZE', 'NUUKM', 'PURBL']);
    expect(starRunwayLeg(star, '24')!.fixes).toEqual(['ROZZE', 'NUUKM', 'JSTNN']);
    expect(starRunwayLeg(star, '24')!.thenHeadingMagDeg).toBe(57);
    expect(starRunwayLeg(star, '35')!.fixes).toEqual(['ROZZE', 'NUUKM', 'SHOWZ']);
  });
  it('every fix is in the airport data with NASR coordinates', () => {
    for (const f of starFixSet(star)) {
      const n = findNavFix(ap, f);
      expect(n, f).toBeDefined();
      expect(n!.type, f).toBe('FIX');
      expect(n!.provenance.source, f).toMatch(/NASR/);
    }
  });
  it('every printed leg distance (within 1 NM) and magnetic track (within 2 degrees) agrees with the fix coordinates', () => {
    for (const l of star.legs!) {
      const a = findNavFix(ap, l.from)!.pos;
      const b = findNavFix(ap, l.to)!.pos;
      expect(Math.abs(mToNm(dist(a, b)) - l.distanceNm), `${l.from}-${l.to} distance`).toBeLessThanOrEqual(1);
      if (l.trackMagDeg !== undefined) {
        const mag = trueToMagnetic(bearingDeg(a, b), ap.magneticVariationDeg);
        expect(angle(mag, l.trackMagDeg), `${l.from}-${l.to} track ${mag.toFixed(1)}`).toBeLessThanOrEqual(2);
      }
    }
  });
  it('the runway narratives and the restriction table say the same', () => {
    const prof = new Map(starProfile(star).map((r) => [r.fix, r]));
    for (const rw of (procSrc.stars[0] as unknown as { star: { runways: { narrative: string }[] } }).star.runways) {
      for (const m of rw.narrative.matchAll(/cross (\w+) (?:between (\d+) and (\d+)|at (\d+))(?: and at (\d+)K)?/g)) {
        const r = prof.get(m[1])!;
        expect(r, m[1]).toBeDefined();
        if (m[4]) expect(r.mandatoryAltitudeFt, m[1]).toBe(Number(m[4]));
        else {
          expect(r.minAltitudeFt, m[1]).toBe(Number(m[2]));
          expect(r.maxAltitudeFt, m[1]).toBe(Number(m[3]));
        }
        expect(r.speedKt, m[1]).toBe(m[5] ? Number(m[5]) : undefined);
      }
    }
    expect(prof.get('TEETO')).toMatchObject({ mandatoryAltitudeFt: 5000, speedKt: 210 });
    expect(prof.get('PNARD')).toMatchObject({ minAltitudeFt: 7000, maxAltitudeFt: 9000, speedKt: 230 });
    expect(prof.get('QUINZ')).toMatchObject({ minAltitudeFt: 19000, speedKt: 280 });
    expect(prof.get('CRIBB')).toMatchObject({ minAltitudeFt: 13000, maxAltitudeFt: 16000 });
  });
  it('the end of each runway leg is an initial approach fix of the expected approach plate, and the join fixes are on that plate', () => {
    const iap = (end: string) => ap.procedures.find((p) => p.type === 'IAP' && p.runwayEnd === end && p.name.startsWith('ILS'));
    expect(iap('6')!.fixes).toContain('TEETO');
    expect(iap('17')!.fixes).toEqual(expect.arrayContaining(['PURBL', 'LYLAC', 'BLSSM', 'BLUUM']));
    expect(iap('35')!.fixes).toEqual(expect.arrayContaining(['SHOWZ', 'IHOBB', 'ELEEE', 'YOULL']));
    expect(iap('6')!.fixes).toContain('JAAZZ');
    expect(ap.procedures.find((p) => p.type === 'IAP' && p.runwayEnd === '24' && /RNAV/.test(p.name))).toBeDefined(); // the runway 24 STAR ends "then on heading 057" (vectors)
  });
  it('route building: from an entry or any fix of a transition through the runway leg and the approach join', () => {
    expect(starRouteFrom(ap, ref, 'CRIBB', '6')!.fixes).toEqual(['CRIBB', 'MONRC', 'ROZZE', 'PNARD', 'TEETO', 'JAAZZ']);
    expect(starRouteFrom(ap, ref, 'FLYZZ', '17')!.fixes).toEqual(['FLYZZ', 'FYSHR', 'ROZZE', 'NUUKM', 'PURBL', 'LYLAC', 'BLSSM', 'BLUUM']);
    expect(starRouteFrom(ap, ref, 'MUCOW', '35')!.fixes).toEqual(['MUCOW', 'FFATY', 'CRIBB', 'MONRC', 'ROZZE', 'NUUKM', 'SHOWZ', 'IHOBB', 'ELEEE', 'YOULL']);
    expect(starRouteFrom(ap, ref, 'ROZZE', '24')!.fixes).toEqual(['ROZZE', 'NUUKM', 'JSTNN']);
    expect(starRouteFrom(ap, ref, 'TEETO', '6')).toBeDefined(); // a fix on the runway leg
    expect(starRouteFrom(ap, ref, 'PNARD', '17')).toBeUndefined(); // PNARD is only on the runway 6 leg
    expect(starRouteFrom(ap, ref, 'CARYL', '6')).toBeUndefined();
    expect(starRouteFrom(ap, ref, 'CRIBB', '9')).toBeUndefined();
  });
  it('agrees with NASR STAR_RTE.csv (only when the git-ignored NASR download is present)', () => {
    const file = path.resolve(__dirname, '../../../data/sources/raw/nasr_2026-10-01/x_STAR_CSV/STAR_RTE.csv');
    if (!fs.existsSync(file)) return;
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('ROZZE.ROZZE2')).map((l) => l.split(',').map((c) => c.replace(/"/g, '')));
    const body = (name: string) => rows.filter((r) => r[4] === name).sort((a, b) => Number(a[7]) - Number(b[7])).map((r) => r[8]);
    expect(body('ROZZE-TEETO')).toEqual(starRunwayLeg(star, '6')!.fixes);
    expect(body('ROZZE-PURBL')).toEqual(starRunwayLeg(star, '17')!.fixes);
    expect(body('ROZZE-JSTNN')).toEqual(starRunwayLeg(star, '24')!.fixes);
    expect(body('ROZZE-SHOWZ')).toEqual(starRunwayLeg(star, '35')!.fixes);
    for (const t of star.transitions) expect(body(`${t.name} TRANSITION`)).toEqual(t.fixes);
  });
});

describe('KACY has no STAR', () => {
  it('no STAR procedure, no arrival route, no STAR flow', () => {
    const kacy = loadKacy();
    expect(kacy.procedures.filter((p) => p.type === 'STAR')).toHaveLength(0);
    expect(findStar(kacy)).toBeUndefined();
    for (const e of ['13', '31', '4', '22']) expect(starArrival(kacy, e)).toBeUndefined();
  });
});
