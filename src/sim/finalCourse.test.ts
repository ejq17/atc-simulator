/** Final approach course from the procedure geometry (NASR localizer course for ILS/LOC, FAF -> threshold bearing otherwise). */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from './engine';
import { courseGeom, analyzeProcedure, finalCourseTrue } from './approach';
import { ALL_POSITIONS, AT_FIX, cmd, find, ifrScenario, makeEngine, makeScenario, run, runUntil, say } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { bearingDeg, headingDiff, magneticToTrue, mToNm } from './geo';
import { findNavFix } from './navigation';
import { alongCross, findRunwayEnd } from './runways';

const kacy = loadKacy();

describe('final approach course (real KACY)', () => {
  const rows = kacy.procedures
    .filter((p) => p.type === 'IAP' && !!p.runwayEnd && !/COPTER/.test(p.name))
    .map((p) => {
      const g = findRunwayEnd(kacy, p.runwayEnd)!;
      const info = analyzeProcedure(kacy, p, g);
      return { name: p.name, end: g.end.id, runwayHeading: g.headingDeg, course: info.courseTrue, faf: info.faf?.id, g, info };
    });

  it('prints the course of every procedure and checks each against its definition', () => {
    const table = rows.map((r) => `${r.name.padEnd(30)} rwy ${r.end.padStart(2)}  FAF ${(r.faf ?? '-').padEnd(6)} course ${r.course.toFixed(2)} true  (runway ${r.runwayHeading.toFixed(2)}, diff ${headingDiff(r.runwayHeading, r.course).toFixed(2)} deg)`);
    console.info(`final approach courses (TRUE):\n${table.join('\n')}`);
    expect(rows.length).toBe(12);
    for (const r of rows) {
      if (/\b(ILS|LOC)\b/.test(r.name)) {
        // NASR localizer course (magnetic) -> true
        expect(r.course, r.name).toBeCloseTo(magneticToTrue(r.g.end.ils!.courseDeg, kacy.magneticVariationDeg), 6);
      } else {
        // bearing from the FAF to the threshold, computed from the fix positions
        const faf = findNavFix(kacy, r.faf!)!;
        expect(r.course, r.name).toBeCloseTo(bearingDeg(faf.pos, r.g.end.threshold), 6);
      }
    }
  });

  it('ILS 13 and 31 use the NASR localizer courses (127.99 / 308.01 magnetic)', () => {
    const ils13 = rows.find((r) => r.name === 'ILS Z OR LOC Z RWY 13')!;
    const ils31 = rows.find((r) => r.name === 'ILS OR LOC/DME RWY 31')!;
    expect(ils13.course).toBeCloseTo(127.99 - 10, 2);
    expect(ils31.course).toBeCloseTo(308.01 - 10, 2);
  });

  it('RNAV 22 / RNAV 4 / VOR courses differ from the runway heading by exactly what the FAF position implies', () => {
    for (const name of ['RNAV (GPS) RWY 22', 'RNAV (GPS) RWY 04', 'VOR RWY 04', 'VOR RWY 31']) {
      const r = rows.find((x) => x.name === name)!;
      const faf = findNavFix(kacy, r.faf!)!;
      const implied = headingDiff(r.runwayHeading, bearingDeg(faf.pos, r.g.end.threshold));
      expect(headingDiff(r.runwayHeading, r.course), name).toBeCloseTo(implied, 6);
    }
    // the FAF of the VOR approaches is off the runway extension, so their course is not the runway heading
    const vor4 = rows.find((x) => x.name === 'VOR RWY 04')!;
    expect(Math.abs(headingDiff(vor4.runwayHeading, vor4.course))).toBeGreaterThan(3);
    // RNAV 22's FAF (EFEWY) lies on the extended centreline: course == runway heading to well under a tenth of a degree
    const r22 = rows.find((x) => x.name === 'RNAV (GPS) RWY 22')!;
    expect(r22.faf).toBe('EFEWY');
    expect(Math.abs(headingDiff(r22.runwayHeading, r22.course))).toBeLessThan(0.1);
  });

  it('falls back to the runway heading when there is no localizer and no FAF', () => {
    const g = findRunwayEnd(kacy, '22')!;
    expect(finalCourseTrue(kacy, g, undefined, undefined)).toBe(g.headingDeg);
  });
});

describe('the approach is flown on the course', () => {
  it('VOR 04 on real KACY: established on the FAF -> threshold course (not the runway heading)', () => {
    const g = findRunwayEnd(kacy, '4')!;
    const proc = kacy.procedures.find((p) => p.name === 'VOR RWY 04')!;
    const info = analyzeProcedure(kacy, proc, g);
    const gc = courseGeom(g, info.courseTrue);
    expect(Math.abs(headingDiff(g.headingDeg, info.courseTrue))).toBeGreaterThan(3);
    const e = createEngine({
      airport: kacy, readbackErrorRate: 0,
      scenario: makeScenario({
        controllerPositions: ALL_POSITIONS, mode: 'training', activeRunways: { departing: ['4'], landing: ['4'] },
        spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP', start: { kind: 'at_fix', fix: 'CARUM', altitudeFt: 2500, speedKt: 160, route: ['CARUM', 'MEADY'], runwayEnd: '4' } }],
      }),
    });
    const ac = find(e, 'NKS451');
    run(e, 3);
    expect(say(e, cmd('APPROACH', 'NKS451', { approachType: 'VOR', runwayEnd: '4' }), 'APP').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'FINAL', 800)).toBe(true);
    // on FINAL, the lateral error is measured against the procedure course
    run(e, 20);
    expect(Math.abs(alongCross(gc, ac.pos).cross)).toBeLessThan(400);
    const hdgErr = Math.abs(headingDiff(ac.headingDeg, info.courseTrue));
    expect(hdgErr).toBeLessThan(6);
    expect(mToNm(-alongCross(gc, ac.pos).along)).toBeLessThan(8.2);
  });

  it('fixture: an ILS-less runway with the FAF on the extension keeps the runway heading; vector intercepts use the course', () => {
    const fx = createTestAirport();
    const g = findRunwayEnd(fx, '13')!;
    const info = analyzeProcedure(fx, fx.procedures.find((p) => p.id === 'FIX-ILS-OR-LOC-RWY-13')!, g);
    expect(info.courseTrue).toBeCloseTo(g.headingDeg, 3);
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B'], '13', {}, 3000)], { mode: 'training' }) });
    run(e, 5);
    expect(say(e, cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: '13' }), 'APP').status).toBe('accepted');
  });
});
