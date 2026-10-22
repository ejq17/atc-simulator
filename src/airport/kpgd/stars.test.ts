/**
 * LUBBR FOUR and PIKKR SEVEN (RNAV) as transcribed for PGD (data/sources/kpgd-procedures.json, d-TPP cycle 2610): legs checked against the NASR
 * fix coordinates, routes against NASR STAR_RTE.csv when the git-ignored download is present. Both charts serve several airports; only the PGD
 * bodies are transcribed and the single published leg is copied to runways 4, 22, 15 and 33 (the charts print no runway for PGD).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKpgd } from '.';
import { airportStars, findStar, starFixSet, starRouteFrom, starRunwayLeg } from '../../sim/star';
import { bearingDeg, dist, mToNm, trueToMagnetic } from '../../sim/geo';
import { findNavFix } from '../../sim/navigation';

const ap = loadKpgd();
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const lubbr = findStar(ap, 'LUBBR4')!;
const pikkr = findStar(ap, 'PIKKR7')!;

describe('KPGD STARs', () => {
  it('two STARs list PGD: LUBBR FOUR (with its continuation page) and PIKKR SEVEN', () => {
    expect(airportStars(ap).map((s) => s.star.ident).sort()).toEqual(['LUBBR4', 'PIKKR7']);
    expect(lubbr.star.spokenName).toBe('LUBBR FOUR');
    expect(pikkr.star.spokenName).toBe('PIKKR SEVEN');
    expect(ap.procedures.filter((p) => p.type === 'STAR')).toHaveLength(3);
  });
  it('transitions end at the common fix; the runway legs of the four runways are the PGD body then a heading', () => {
    expect(lubbr.star.transitions.map((t) => t.name).sort()).toEqual(['KRVUR', 'KYYUU', 'SSPAZ']);
    expect(pikkr.star.transitions.map((t) => t.name).sort()).toEqual(['CODGR', 'PLYER', 'REMIS']);
    for (const t of lubbr.star.transitions) expect(t.fixes.at(-1)).toBe('LUBBR');
    for (const t of pikkr.star.transitions) expect(t.fixes.at(-1)).toBe('PIKKR');
    for (const e of ['4', '22', '15', '33']) {
      expect(starRunwayLeg(lubbr.star, e)).toMatchObject({ fixes: ['LUBBR', 'ZEBON', 'RUNNE', 'BREKR', 'WUDDY', 'LYFIE', 'ROSTY'], thenHeadingMagDeg: 150 });
      expect(starRunwayLeg(pikkr.star, e)).toMatchObject({ fixes: ['PIKKR', 'GUSEC'], thenHeadingMagDeg: 118 });
    }
    expect(starRunwayLeg(lubbr.star, '9')).toBeUndefined();
    expect(lubbr.star.restrictions).toEqual([{ fix: 'ROSTY', atOrAboveFt: 3000, speedKt: 210 }]);
  });
  it('every fix is in the airport data with NASR coordinates', () => {
    for (const s of [lubbr, pikkr]) for (const f of starFixSet(s.star)) expect(findNavFix(ap, f)?.provenance.source, f).toMatch(/NASR/);
  });
  it('printed distances (within 1 NM) and tracks agree with the fix coordinates (LUBBR within 2 degrees of true + 6 W; PIKKR charts 3 degrees less)', () => {
    for (const [s, tol] of [[lubbr, 2], [pikkr, 4]] as const) {
      for (const l of s.star.legs!) {
        const a = findNavFix(ap, l.from)!.pos;
        const b = findNavFix(ap, l.to)!.pos;
        expect(Math.abs(mToNm(dist(a, b)) - l.distanceNm), `${l.from}-${l.to} distance`).toBeLessThanOrEqual(1);
        if (l.trackMagDeg !== undefined) {
          const mag = trueToMagnetic(bearingDeg(a, b), ap.magneticVariationDeg);
          expect(angle(mag, l.trackMagDeg), `${l.from}-${l.to} track ${mag.toFixed(1)}`).toBeLessThanOrEqual(tol);
        }
      }
    }
  });
  it('route building from a transition fix to the end of the leg', () => {
    expect(starRouteFrom(ap, lubbr, 'SSPAZ', '4')!.fixes).toEqual(['SSPAZ', 'BATTN', 'LUBBR', 'ZEBON', 'RUNNE', 'BREKR', 'WUDDY', 'LYFIE', 'ROSTY']);
    expect(starRouteFrom(ap, pikkr, 'REMIS', '33')!.fixes).toEqual(['REMIS', 'CODGR', 'BAGGS', 'PIKKR', 'GUSEC']);
    expect(starRouteFrom(ap, pikkr, 'ZEILR', '4')).toBeUndefined(); // the KAPF/KMKY body is not transcribed
  });
  it('agrees with NASR STAR_RTE.csv (only when the git-ignored NASR download is present)', () => {
    const file = path.resolve(__dirname, '../../../data/sources/raw/nasr_2026-10-01/x_STAR_CSV/STAR_RTE.csv');
    if (!fs.existsSync(file)) return;
    const all = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.split(',').map((c) => c.replace(/"/g, '')));
    const body = (code: string, name: string) => all.filter((r) => r[1] === code && r[4] === name).sort((a, b) => Number(a[7]) - Number(b[7])).map((r) => r[8]);
    expect(body('LUBBR.LUBBR4', 'LUBBR-ROSTY')).toEqual(starRunwayLeg(lubbr.star, '4')!.fixes);
    expect(body('PIKKR.PIKKR7', 'PIKKR-GUSEC')).toEqual(starRunwayLeg(pikkr.star, '4')!.fixes);
    for (const t of lubbr.star.transitions) expect(body('LUBBR.LUBBR4', `${t.name} TRANSITION`)).toEqual(t.fixes);
    for (const t of pikkr.star.transitions) expect(body('PIKKR.PIKKR7', `${t.name} TRANSITION`)).toEqual(t.fixes);
  });
});
