/**
 * ROBUC THREE and JFUND TWO (data/sources/kbos-procedures.json) built into the airport object: structure, restrictions, and the printed
 * leg distances / magnetic tracks against the NASR fix coordinates. When the git-ignored NASR download is present the fix sequences are
 * also compared with STAR_RTE.csv.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKbos } from '.';
import { airportStars, findStar, starFixSet, starRouteFrom, starRunwayLeg } from '../../sim/star';
import { starArrival } from '../../game/ifr';
import { bearingDeg, dist, mToNm, trueToMagnetic } from '../../sim/geo';
import { findNavFix } from '../../sim/navigation';

const ap = loadKbos();
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const robuc = findStar(ap, 'ROBUC3')!;
const jfund = findStar(ap, 'JFUND2')!;

describe('KBOS STARs', () => {
  it('two transcribed STARs, found by ident or spoken name', () => {
    expect(airportStars(ap).map((s) => s.star.ident)).toEqual(['ROBUC3', 'JFUND2']);
    expect(findStar(ap, 'ROBUC THREE')).toEqual(robuc);
    expect(findStar(ap)).toBeUndefined(); // several STARs: an ident is required
    expect(robuc.procedure.chartPdfUrl).toBe('https://aeronav.faa.gov/d-tpp/2610/00058ROBUC.PDF');
    expect(jfund.star.notes).toContain('Turbojet aircraft only.');
  });

  it('transitions end at the common fix; every runway leg starts there and every end with a leg is a landing runway', () => {
    expect(robuc.star.transitions.map((t) => t.name)).toEqual(['KENNEDY', 'MERIT', 'RUIZE']);
    expect(jfund.star.transitions.map((t) => t.name)).toEqual(['ONDEC', 'PONCT', 'WHATE']);
    for (const t of robuc.star.transitions) expect(t.fixes.at(-1)).toBe('ROBUC');
    for (const t of jfund.star.transitions) expect(t.fixes.at(-1)).toBe('JFUND');
    for (const [r, common] of [[robuc, 'ROBUC'], [jfund, 'JFUND']] as const) {
      expect(r.star.runways.map((x) => x.runwayEnd).sort()).toEqual(['15R', '22L', '22R', '27', '32', '33L', '4L', '4R']);
      for (const leg of r.star.runways) expect(leg.fixes[0]).toBe(common);
    }
    expect(starRunwayLeg(robuc.star, '4R')!.fixes).toEqual(['ROBUC', 'PROVI', 'JOODY', 'SOFEE', 'ERNEI', 'GOSHI']);
    expect(starRunwayLeg(jfund.star, '15R')!.fixes).toEqual(['JFUND', 'BADCA', 'WACHU', 'SSAAM', 'AADMS']);
  });

  it('every fix is in the airport data with NASR coordinates', () => {
    for (const r of [robuc, jfund]) {
      for (const f of starFixSet(r.star)) {
        const n = findNavFix(ap, f);
        expect(n, f).toBeDefined();
        expect(n!.provenance.source, f).toMatch(/NASR/);
      }
    }
  });

  it('every leg distance (within 1.5 NM) and magnetic track (within 3 degrees) agrees with the fix coordinates', () => {
    for (const r of [robuc, jfund]) {
      expect(r.star.legs!.length).toBeGreaterThan(20);
      for (const l of r.star.legs!) {
        const a = findNavFix(ap, l.from)!.pos;
        const b = findNavFix(ap, l.to)!.pos;
        expect(Math.abs(mToNm(dist(a, b)) - l.distanceNm), `${l.from}-${l.to} distance`).toBeLessThanOrEqual(1.5);
        const mag = trueToMagnetic(bearingDeg(a, b), ap.magneticVariationDeg);
        expect(angle(mag, l.trackMagDeg!), `${l.from}-${l.to} track ${mag.toFixed(1)}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('restrictions equal the route-description narratives', () => {
    const src = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../data/sources/kbos-procedures.json'), 'utf8'));
    for (const st of src.stars.filter((s: { star?: unknown }) => s.star)) {
      const prof = new Map<string, { at_ft?: number; at_or_above_ft?: number; at_or_below_ft?: number; speed_kt?: number }>(st.star.restrictions.map((x: { fix: string }) => [x.fix, x]));
      for (const rw of st.star.runways) {
        for (const m of (rw.narrative as string).matchAll(/cross (\w+) (?:between (\d+) and (\d+)|at (\d+))(?: and at (\d+)K)?/g)) {
          const r = prof.get(m[1])!;
          expect(r, m[1]).toBeDefined();
          if (m[4]) expect(r.at_ft, m[1]).toBe(Number(m[4]));
          else {
            expect(r.at_or_above_ft, m[1]).toBe(Number(m[2]));
            expect(r.at_or_below_ft, m[1]).toBe(Number(m[3]));
          }
          expect(r.speed_kt, m[1]).toBe(m[5] ? Number(m[5]) : undefined);
        }
      }
    }
  });

  it('route building and the simulator entry fixes (several STARs serve one runway end)', () => {
    expect(starRouteFrom(ap, robuc, 'RUIZE', '4R')!.fixes).toEqual(['RUIZE', 'AWLIN', 'BANKI', 'ROBUC', 'PROVI', 'JOODY', 'SOFEE', 'ERNEI', 'GOSHI', 'WINNI', 'NABBO', 'MILTT']);
    expect(starRouteFrom(ap, robuc, 'PROVI', '22L')!.fixes.at(-1)).toBe('TAALE');
    expect(starRouteFrom(ap, jfund, 'WHATE', '15R')!.fixes).toEqual(['WHATE', 'ONDEC', 'JFUND', 'BADCA', 'WACHU', 'SSAAM', 'AADMS', 'SWIGG', 'WOBUR', 'MALDY']);
    const sa = starArrival(ap, '4R')!;
    expect(sa.entries.map((e) => [e.ref?.star.ident, e.fix])).toEqual([['ROBUC3', 'PROVI'], ['ROBUC3', 'JOODY'], ['JFUND2', 'JFUND'], ['JFUND2', 'AUTUM']]);
    for (const e of sa.entries) expect(e.route.length).toBeGreaterThan(3);
    expect(starArrival(ap, '9')).toBeUndefined();
    expect(starArrival(ap, '14')).toBeUndefined();
  });

  it('agrees with NASR STAR_RTE.csv (only when the git-ignored NASR download is present)', () => {
    const file = path.resolve(__dirname, '../../../data/sources/raw/nasr_2026-10-01/x_STAR_CSV/STAR_RTE.csv');
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => [...l.matchAll(/"([^"]*)"|([^,]+)/g)].map((m) => m[1] ?? m[2]));
    for (const [code, r] of [['ROBUC.ROBUC3', robuc], ['JFUND.JFUND2', jfund]] as const) {
      const rows = lines.filter((l) => l[1] === code);
      const body = (name: string) => rows.filter((x) => x[4] === name).sort((a, b) => Number(a[7]) - Number(b[7])).map((x) => x[8]);
      for (const t of r.star.transitions) {
        const nasr = body(`${t.name} TRANSITION`);
        expect(t.fixes.filter((f) => f !== 'JFK'), t.name).toEqual(nasr.filter((f) => f !== 'JFK'));
      }
      for (const leg of r.star.runways) {
        const bodies = [...new Set(rows.filter((x) => x[3] === 'BODY' && x[12]?.split(', ').some((a) => a.replace(/^BOS\/0?/, '') === leg.runwayEnd)).map((x) => x[4]))];
        expect(bodies.length, leg.runwayEnd).toBeGreaterThan(0);
        expect(bodies.some((b) => JSON.stringify(body(b)) === JSON.stringify(leg.fixes)), `${code} ${leg.runwayEnd}`).toBe(true);
      }
    }
  });
});
