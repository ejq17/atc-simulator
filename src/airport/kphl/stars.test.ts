/**
 * KPHL BOJID FOUR and PAATS FOUR arrivals (RNAV): the d-TPP transcription in data/sources/kphl-procedures.json, built into the airport object.
 *
 * Every printed leg distance (within 1.5 NM) and magnetic track (within 3 degrees) is checked against the NASR fix coordinates, the runway routes
 * against NASR STAR_RTE.csv (when the git-ignored download is present), and the route building (transition -> runway leg -> approach join fixes).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import procSrc from '../../../data/sources/kphl-procedures.json';
import { loadKphl } from '.';
import { starArrival } from '../../game/ifr';
import { airportStars, findStar, starFixSet, starRouteFrom, starRunwayLeg } from '../../sim/star';
import { bearingDeg, dist, mToNm, trueToMagnetic } from '../../sim/geo';
import { findNavFix } from '../../sim/navigation';

const ap = loadKphl();
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const paats = findStar(ap, 'PAATS4')!;
const bojid = findStar(ap, 'BOJID4')!;

describe('KPHL STAR transcriptions', () => {
  it('two STARs are transcribed (BOJID FOUR, PAATS FOUR); the other four charts are listed only', () => {
    expect(airportStars(ap).map((s) => s.star.ident)).toEqual(['BOJID4', 'PAATS4']);
    expect(findStar(ap)).toBeUndefined(); // more than one: a name is needed
    expect(findStar(ap, 'PAATS FOUR')?.star.ident).toBe('PAATS4');
    expect(findStar(ap, 'BOJID FOUR')?.star.ident).toBe('BOJID4');
    expect(paats.star.spokenName).toBe('PAATS FOUR');
    expect(paats.procedure.chartPdfUrl).toBe('https://aeronav.faa.gov/d-tpp/2610/00320PAATS.PDF');
    expect(bojid.procedure.chartPdfUrl).toBe('https://aeronav.faa.gov/d-tpp/2610/00320BOJID.PDF');
    expect(ap.procedures.filter((p) => p.type === 'STAR' && !p.star).map((p) => p.name)).toEqual(['BUNTS THREE', 'JIIMS FOUR (RNAV)', 'SLATT SIX', 'SPUDS SEVEN (RNAV)']);
  });

  it('carries its provenance and the printed notes; the charts print no crossing restrictions, so none are invented', () => {
    for (const ref of [paats, bojid]) {
      expect(ref.procedure.provenance.source).toMatch(/d-TPP/i);
      expect(ref.star.restrictions).toEqual([]);
      expect(ref.star.notes).toContain('RADAR required.');
      expect(ref.star.notes.some((n) => n.startsWith('RNAV 1'))).toBe(true);
    }
    expect(paats.star.notes).toContain('Jet aircraft only.');
    const src = procSrc.stars[1] as { star: { provenance: string; printed_on_chart: string } };
    expect(src.star.provenance).toMatch(/00320PAATS\.PDF.*00320PAATS_C\.PDF/);
    expect(src.star.printed_on_chart).toMatch(/ESSSO\.PAATS4.*20APR23.*NE-4, 01 OCT 2026 to 29 OCT 2026/);
  });

  it('PAATS FOUR: three transitions ending at ESSSO, seven runway legs from ESSSO through PAATS', () => {
    expect(paats.star.transitions.map((t) => t.name).sort()).toEqual(['BBDOL', 'GORDONSVILLE', 'HYTRA']);
    for (const t of paats.star.transitions) expect(t.fixes.at(-1)).toBe('ESSSO');
    expect(paats.star.runways.map((r) => r.runwayEnd).sort()).toEqual(['17', '26', '27L', '27R', '35', '9L', '9R']);
    for (const r of paats.star.runways) expect(r.fixes.slice(0, 2)).toEqual(['ESSSO', 'PAATS']);
    expect(starRunwayLeg(paats.star, '9L')!.fixes).toEqual(['ESSSO', 'PAATS', 'TRNBL', 'WEVVE', 'ERNYY']);
    expect(starRunwayLeg(paats.star, '27R')!.fixes).toEqual(['ESSSO', 'PAATS', 'RROLL', 'CHPMN', 'PSOUT', 'MKORD']);
    expect(starRunwayLeg(paats.star, '35')!.fixes).toEqual(['ESSSO', 'PAATS', 'TEBEE']);
  });

  it('BOJID FOUR: Johnstown and Philipsburg transitions ending at HAR; runways 9L/9R and 27L/27R only', () => {
    expect(bojid.star.transitions.map((t) => t.name).sort()).toEqual(['JOHNSTOWN', 'PHILIPSBURG']);
    for (const t of bojid.star.transitions) expect(t.fixes.at(-1)).toBe('HAR');
    expect(bojid.star.runways.map((r) => r.runwayEnd).sort()).toEqual(['27L', '27R', '9L', '9R']);
    expect(starRunwayLeg(bojid.star, '27L')!.fixes).toEqual(['HAR', 'LRP', 'TRAGG', 'BUNTS', 'SCOOL', 'BOJID', 'HIFAL', 'EYRIE', 'FERUS']);
    expect(starRunwayLeg(bojid.star, '9R')!.fixes).toEqual(['HAR', 'LRP', 'TRAGG', 'BUNTS', 'SCOOL', 'KYILL', 'EXPRS', 'WHEYY']);
    expect(starRunwayLeg(bojid.star, '17')).toBeUndefined();
  });

  it('every fix is in the airport data with NASR coordinates (fixes) or as a VOR', () => {
    for (const ref of [paats, bojid]) {
      for (const f of starFixSet(ref.star)) {
        const n = findNavFix(ap, f);
        expect(n, f).toBeDefined();
        expect(n!.provenance.source, f).toMatch(/NASR/);
      }
    }
  });

  it('every printed leg distance (within 1.5 NM) and magnetic track (within 3 degrees) agrees with the fix coordinates', () => {
    for (const ref of [paats, bojid]) {
      for (const l of ref.star.legs!) {
        const a = findNavFix(ap, l.from)!.pos;
        const b = findNavFix(ap, l.to)!.pos;
        expect(Math.abs(mToNm(dist(a, b)) - l.distanceNm), `${l.from}-${l.to} distance`).toBeLessThanOrEqual(1.5);
        if (l.trackMagDeg !== undefined) {
          const mag = trueToMagnetic(bearingDeg(a, b), ap.magneticVariationDeg);
          expect(angle(mag, l.trackMagDeg), `${l.from}-${l.to} track ${mag.toFixed(1)}`).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it('the join fixes are fixes of the expected approach plate', () => {
    const plateFixes = (end: string, re: RegExp) => ap.procedures.find((p) => p.type === 'IAP' && p.runwayEnd === end && re.test(p.name))!.fixes!;
    for (const ref of [paats, bojid]) {
      for (const rw of ref.star.runways) {
        const join = rw.joinApproachFixes ?? [];
        expect(join.length, `${ref.star.ident} ${rw.runwayEnd}`).toBeGreaterThan(0);
        const fixes = [...plateFixes(rw.runwayEnd, /^ILS|^RNAV \(GPS\)/), ...plateFixes(rw.runwayEnd, /RNAV/)];
        for (const f of join) expect(fixes, `${ref.star.ident} ${rw.runwayEnd} ${f}`).toContain(f);
      }
    }
  });

  it('route building: from a transition entry or any fix through the runway leg and the approach join', () => {
    expect(starRouteFrom(ap, paats, 'CANNY', '27R')!.fixes).toEqual(['CANNY', 'ESSSO', 'PAATS', 'RROLL', 'CHPMN', 'PSOUT', 'MKORD', 'MRTIN', 'JALTO']);
    expect(starRouteFrom(ap, paats, 'HEDGE', '35')!.fixes).toEqual(['HEDGE', 'CANNY', 'ESSSO', 'PAATS', 'TEBEE', 'JEPUG', 'HARLU']);
    expect(starRouteFrom(ap, paats, 'BBDOL', '9L')!.fixes.slice(0, 3)).toEqual(['BBDOL', 'WNDYB', 'GDZLA']);
    expect(starRouteFrom(ap, bojid, 'LRP', '27L')!.fixes).toEqual(['LRP', 'TRAGG', 'BUNTS', 'SCOOL', 'BOJID', 'HIFAL', 'EYRIE', 'FERUS', 'FESTI', 'TORNE']);
    expect(starRouteFrom(ap, bojid, 'TRAGG', '17')).toBeUndefined();
    expect(starRouteFrom(ap, paats, 'LRP', '27R')).toBeUndefined();
  });

  it('simulator STAR arrivals: entry fixes (sim_entry_fixes) of every STAR that serves the runway end', () => {
    const ent = (end: string) => starArrival(ap, end)!.entries.map((e) => e.fix);
    expect(ent('27R')).toEqual(['TRAGG', 'LRP', 'CANNY', 'HEDGE']);
    expect(ent('35')).toEqual(['CANNY', 'HEDGE']);
    expect(starArrival(ap, '8')).toBeUndefined();
  });

  it('agrees with NASR STAR_RTE.csv (only when the git-ignored NASR download is present)', () => {
    const file = path.resolve(__dirname, '../../../data/sources/raw/nasr_2026-10-01/x_STAR_CSV/STAR_RTE.csv');
    if (!fs.existsSync(file)) return;
    const all = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.split(',').map((c) => c.replace(/"/g, '')));
    const body = (code: string, name: string) => all.filter((r) => r[1] === code && r[4] === name).sort((a, b) => Number(a[7]) - Number(b[7])).map((r) => r[8]);
    expect(body('ESSSO.PAATS4', 'ESSSO-ERNYY')).toEqual(starRunwayLeg(paats.star, '9L')!.fixes);
    expect(body('ESSSO.PAATS4', 'ESSSO-MKORD')).toEqual(starRunwayLeg(paats.star, '27L')!.fixes);
    expect(body('ESSSO.PAATS4', 'ESSSO-TEBEE')).toEqual(starRunwayLeg(paats.star, '17')!.fixes);
    expect(body('HAR.BOJID4', 'HAR-FERUS')).toEqual(starRunwayLeg(bojid.star, '27R')!.fixes);
    expect(body('HAR.BOJID4', 'HAR-WHEYY')).toEqual(starRunwayLeg(bojid.star, '9L')!.fixes);
    for (const t of paats.star.transitions) expect(body('ESSSO.PAATS4', `${t.name} TRANSITION`)).toEqual(t.fixes);
    for (const t of bojid.star.transitions) expect(body('HAR.BOJID4', `${t.name} TRANSITION`)).toEqual(t.fixes);
  });
});
