/** Approach gate and final approach course interception, FAA JO 7110.65 5-9-1, 5-9-2 (TBL 5-9-1) and the P/CG APPROACH GATE definition. */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from './engine';
import type { ApproachType, Weather } from './types';
import { ALL_POSITIONS, cmd, find, makeScenario, say } from './__fixtures__/testHelpers';
import { analyzeProcedure, approachGateDM, assessApproach, matchingProcedures } from './approach';
import { courseGeom } from './approach';
import { findRunwayEnd } from './runways';
import { mToNm, nmToM } from './geo';

const kacy = loadKacy();
const wx = (over: Partial<Weather> = {}): Weather => ({ ...(makeScenario().weather as Weather), ...over });

/** Aircraft right of the ILS 13 course, heading `angle` degrees toward it, whose intercept is `dIntNm` from the threshold. */
function setup(opts: { dIntNm: number; angle: number; type?: ApproachType; weather?: Weather; mode?: 'training' | 'free_play' }) {
  const g = findRunwayEnd(kacy, '13')!;
  const type = opts.type ?? 'ILS';
  const info = analyzeProcedure(kacy, matchingProcedures(kacy, type, '13')[0], g);
  const gc = courseGeom(g, info.courseTrue);
  const e = createEngine({
    airport: kacy, readbackErrorRate: 0,
    scenario: makeScenario({
      controllerPositions: ALL_POSITIONS, mode: opts.mode ?? 'training', weather: opts.weather ?? wx(),
      spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP', start: { kind: 'at_fix', fix: 'CARYL', altitudeFt: 4000, speedKt: 170, route: ['CARYL', 'MAYBN'], runwayEnd: '13' } }],
    }),
  });
  const ac = find(e, 'NKS451');
  const crossNm = 2;
  const dNm = opts.dIntNm + crossNm / Math.tan((opts.angle * Math.PI) / 180);
  ac.pos = {
    x: g.end.threshold.x - gc.dir.x * nmToM(dNm) + gc.right.x * nmToM(crossNm),
    y: g.end.threshold.y - gc.dir.y * nmToM(dNm) + gc.right.y * nmToM(crossNm),
  };
  const hdg = info.courseTrue - opts.angle;
  ac.headingDeg = hdg;
  ac.trackDeg = hdg;
  // vectored: the route is suspended by a heading assignment (magnetic = true + 10 at KACY)
  say(e, cmd('HEADING', 'NKS451', { headingDeg: hdg - kacy.magneticVariationDeg }), 'APP');
  return { e, ac, g, type, gateNm: mToNm(approachGateDM(info.faf!.dM)) };
}

const assess = (o: Parameters<typeof setup>[0]) => {
  const s = setup(o);
  return { ...s, a: assessApproach(s.e.getState(), s.ac, s.type, s.g) };
};

describe('approach gate (KACY ILS 13)', () => {
  it('gate = 1 nm outside the FAF, no closer than 5 nm from the threshold: 5.6 nm for ILS 13 (FAF MAYBN 4.55 nm); 5 nm when the FAF is close in', () => {
    const { gateNm } = setup({ dIntNm: 8, angle: 30 });
    expect(gateNm).toBeCloseTo(5.55, 1);
    expect(mToNm(approachGateDM(nmToM(3.1)))).toBe(5);
    expect(mToNm(approachGateDM(nmToM(4.0)))).toBe(5);
    expect(mToNm(approachGateDM(nmToM(6.0)))).toBe(7);
  });

  it('intercept at least 2 nm outside the gate (7.6 nm) at <= 30 degrees: fine', () => {
    for (const a of [15, 20, 30]) {
      const r = assess({ dIntNm: 7.8, angle: a }).a;
      expect(r.kind, `${a} deg`).toBe('ok');
      expect(r.kind === 'ok' && r.geometry, `${a} deg`).toBeUndefined();
    }
  });

  it('more than 30 degrees is too much when the intercept is 2+ nm outside the gate; 20 degrees is the limit closer in', () => {
    const r35 = assess({ dIntNm: 7.8, angle: 35 }).a;
    expect(r35.kind === 'ok' && r35.geometry?.reason).toMatch(/intercept angle too large \(35 deg; maximum 30 when the intercept is 2 nm or more outside the approach gate/);
    // 6.5 nm: 0.95 nm outside the gate -> at most 20 degrees, and only in VMC
    const r25 = assess({ dIntNm: 6.5, angle: 25 }).a;
    expect(r25.kind === 'ok' && r25.geometry?.reason).toMatch(/maximum 20 when it is less than 2 nm outside the approach gate/);
  });

  it('closer than 2 nm outside the gate (but not inside it): only with ceiling >= MVA+500 and 3 sm (approximated by VMC), never for RNAV', () => {
    const vmc = assess({ dIntNm: 6.5, angle: 20 }).a;
    expect(vmc.kind === 'ok' && vmc.geometry).toBeUndefined();
    const imc = assess({ dIntNm: 6.5, angle: 20, weather: wx({ flightCategory: 'IFR', clouds: [{ cover: 'OVC', baseFtAgl: 700 }], visibilitySm: 2 }) }).a;
    expect(imc.kind === 'ok' && imc.geometry?.reason).toMatch(/less than 2 nm outside the approach gate \(5\.6 nm\): vector to intercept at least 2 nm outside the gate, 7\.6 nm for runway 13 \(7110\.65 5-9-1\)/);
    const rnav = assess({ dIntNm: 6.5, angle: 20, type: 'RNAV' }).a;
    expect(rnav.kind === 'ok' && rnav.geometry?.reason).toMatch(/relaxations do not apply to RNAV aircraft/);
  });

  it('the old behaviour (anything >= 4.6 nm accepted) is gone: an intercept at 5.0 nm is inside the gate; inside the FAF is still refused', () => {
    const r5 = assess({ dIntNm: 5.0, angle: 20 }).a;
    expect(r5.kind === 'ok' && r5.geometry?.reason).toMatch(/inside the approach gate \(5\.6 nm\)/);
    const r4 = assess({ dIntNm: 4.0, angle: 20 }).a;
    expect(r4.kind === 'ok' && r4.geometry?.reason).toMatch(/intercept point is inside the final approach fix/);
  });

  it('training refuses it with the controller-visible reason; free play accepts and scores a communication error', () => {
    const t = setup({ dIntNm: 5.0, angle: 20 });
    const r = say(t.e, cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: '13' }), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.reason).toMatch(/approach gate/);
      expect(r.pilotResponse).toBe('Unable, the intercept is inside the approach gate, Spirit four fifty one');
    }
    const f = setup({ dIntNm: 5.0, angle: 20, mode: 'free_play' });
    expect(say(f.e, cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: '13' }), 'APP').status).toBe('accepted');
    f.e.step();
    expect(f.e.getState().score.communicationErrors).toBe(1);
  });

  it('an aircraft already established on the course is not subject to the gate rule', () => {
    const s = setup({ dIntNm: 6.0, angle: 20 });
    // put it on the course heading the course
    const g = s.g;
    const info = analyzeProcedure(kacy, matchingProcedures(kacy, 'ILS', '13')[0], g);
    const gc = courseGeom(g, info.courseTrue);
    s.ac.pos = { x: g.end.threshold.x - gc.dir.x * nmToM(9), y: g.end.threshold.y - gc.dir.y * nmToM(9) };
    s.ac.headingDeg = info.courseTrue;
    s.ac.target.headingDeg = info.courseTrue;
    const a = assessApproach(s.e.getState(), s.ac, 'ILS', s.g);
    expect(a.kind === 'ok' && a.geometry).toBeUndefined();
  });
});
