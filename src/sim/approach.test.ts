import { describe, expect, it } from 'vitest';
import { ARRIVING, AT_FIX, cmd, find, GA_PARKED, ifrScenario, makeEngine, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import type { SimulationEngine } from './api';
import type { ApproachType, Weather } from './types';
import { createTestAirport } from './__fixtures__/testAirport';
import { glideAltitudeFt } from './flightDynamics';
import { mToNm, nmToM } from './geo';
import { alongCross, findRunwayEnd } from './runways';
import { analyzeProcedure, ceilingFt, matchingProcedures, visualApproachAllowed } from './approach';

const airport = createTestAirport();
const g13 = findRunwayEnd(airport, '13')!;
const ROUTE = ['TARR', 'FX13A', 'FX13B'];

const appr = (cs: string, type: ApproachType, runwayEnd: string) => cmd('APPROACH', cs, { approachType: type, runwayEnd });
const wx = (over: Partial<Weather>): Weather => ({ ...(makeScenario().weather as Weather), ...over });
const dToThreshold = (e: SimulationEngine, cs: string): number => mToNm(-alongCross(g13, find(e, cs).pos).along);

/** Handoff to Tower on final, land, and wait for the rollout. */
function handoffAndLand(e: SimulationEngine, cs: string, rwy: string): void {
  const ac = find(e, cs);
  expect(runUntil(e, () => ac.phase === 'FINAL', 1200)).toBe(true);
  expect(say(e, cmd('CONTACT_FREQUENCY', cs, { frequencyId: 'TWR' }), 'APP').status).toBe('accepted');
  expect(runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'LANDING', 30)).toBe(true);
  expect(say(e, cmd('LAND', cs, { runwayEnd: rwy }), 'TWR').status).toBe('accepted');
  expect(runUntil(e, () => ac.phase === 'ROLLOUT', 600)).toBe(true);
}

describe('procedure analysis (geometry of airport.procedures)', () => {
  it('finds published approaches by type and runway end, ignoring copter / other runways', () => {
    expect(matchingProcedures(airport, 'ILS', '13').map((p) => p.id)).toEqual(['FIX-ILS-OR-LOC-RWY-13']);
    expect(matchingProcedures(airport, 'LOC', '13')).toHaveLength(1);
    expect(matchingProcedures(airport, 'ILS', '22')).toHaveLength(0);
    expect(matchingProcedures(airport, 'RNAV', '22')).toHaveLength(1);
    expect(matchingProcedures(airport, 'RNAV', '04')).toHaveLength(1); // "04" == "4"
    expect(matchingProcedures(airport, 'VOR', '31')).toHaveLength(1);
    expect(matchingProcedures(airport, 'VOR', '13')).toHaveLength(0);
    expect(matchingProcedures(airport, 'VISUAL', '13')).toHaveLength(0);
  });

  it('classifies feeders, the straight-in segment (farthest first) and the FAF; missed approach fixes are dropped', () => {
    const info = analyzeProcedure(airport, matchingProcedures(airport, 'ILS', '13')[0], g13);
    expect(info.feeders).toEqual(['TVO']);
    expect(info.onCourse.map((f) => f.id)).toEqual(['FX13A', 'FX13B']);
    expect(info.faf?.id).toBe('FX13B');
    expect(mToNm(info.faf!.dM)).toBeCloseTo(4.55, 1);
    // RNAV 22 has a course a few degrees off the runway heading: still on course within the tolerance
    const g22 = findRunwayEnd(airport, '22')!;
    const r22 = analyzeProcedure(airport, matchingProcedures(airport, 'RNAV', '22')[0], g22);
    expect(r22.feeders).toEqual(['FX22F']);
    expect(r22.onCourse.map((f) => f.id)).toEqual(['FX22A', 'FX22B', 'FX22C']);
    expect(r22.faf?.id).toBe('FX22C');
  });

  it('visual approach weather: VFR/MVFR, ceiling >= 1000 ft, visibility >= 3 sm', () => {
    expect(visualApproachAllowed(wx({})).ok).toBe(true);
    expect(visualApproachAllowed(wx({ flightCategory: 'IFR' })).ok).toBe(false);
    expect(visualApproachAllowed(wx({ flightCategory: 'MVFR', clouds: [{ cover: 'BKN', baseFtAgl: 1500 }] })).ok).toBe(true);
    expect(visualApproachAllowed(wx({ clouds: [{ cover: 'BKN', baseFtAgl: 800 }] })).ok).toBe(false);
    expect(visualApproachAllowed(wx({ clouds: [{ cover: 'FEW', baseFtAgl: 400 }, { cover: 'SCT', baseFtAgl: 600 }] })).ok).toBe(true); // few/scattered are not a ceiling
    expect(visualApproachAllowed(wx({ visibilitySm: 2 })).ok).toBe(false);
    expect(ceilingFt(wx({ clouds: [{ cover: 'OVC', baseFtAgl: 900 }, { cover: 'BKN', baseFtAgl: 2000 }] }))).toBe(900);
  });
});

describe('APPROACH clearance: validation', () => {
  it('ILS 13 on the route: accepted, read back, the approach fixes become the route', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'training' }) });
    const ac = find(e, 'NKS451');
    run(e, 5);
    const r = say(e, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') {
      expect(r.readback).toBe('Cleared ILS runway one three approach, Spirit four fifty one');
      expect(r.clearance).toMatchObject({ kind: 'APPROACH', approachType: 'ILS', runwayEnd: '13', byPosition: 'APP' });
    }
    expect(ac.nav).toEqual({ fixes: ['FX13A', 'FX13B'], index: 0, mode: 'approach' });
    expect(ac.flightPlan?.arrivalApproach).toEqual({ type: 'ILS', runwayEnd: '13', procedureId: 'FIX-ILS-OR-LOC-RWY-13' });
    expect(ac.pendingRequest).toBeUndefined();
  });

  it('joining at the feeder VOR keeps the feeder in the approach route', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'TVO']), AT_FIX('AAL7', 'TARR', ['TARR', 'FX13A'], '13', {}, 5000, 210)], { mode: 'training' }) });
    expect(say(e, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
    expect(find(e, 'NKS451').nav).toEqual({ fixes: ['TVO', 'FX13A', 'FX13B'], index: 0, mode: 'approach' });
    expect(say(e, appr('AAL7', 'LOC', '13'), 'APP').status).toBe('accepted');
    expect(find(e, 'AAL7').nav).toEqual({ fixes: ['FX13A', 'FX13B'], index: 0, mode: 'approach' });
  });

  it('refuses approaches that are not published for the runway end (no ILS on 4/22, no RNAV 13, no VOR 13)', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE)], { mode: 'training' }) });
    const cases: [ApproachType, string, RegExp][] = [
      ['ILS', '22', /there is no ILS approach to runway two two/],
      ['ILS', '4', /there is no ILS approach to runway four/],
      ['LOC', '22', /there is no localizer approach to runway two two/],
      ['RNAV', '13', /there is no RNAV approach to runway one three/],
      ['VOR', '13', /there is no VOR approach to runway one three/],
    ];
    for (const [type, rwy, pilot] of cases) {
      const r = say(e, appr('NKS451', type, rwy), 'APP');
      expect(r.status, `${type} ${rwy}`).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.reason).toMatch(/No .* approach is published/);
        expect(r.pilotResponse).toMatch(pilot);
      }
    }
    expect(find(e, 'NKS451').nav?.mode).toBe('route'); // untouched
  });

  it('accepts the published ones: RNAV 22, RNAV 4, VOR 31 (aircraft joined on the right route)', () => {
    const e = makeEngine({
      scenario: ifrScenario([
        AT_FIX('NKS22', 'FX22F', ['FX22F', 'FX22A', 'FX22B', 'FX22C'], '22'),
        AT_FIX('NKS04', 'FX04F', ['FX04F', 'FX04A', 'FX04B'], '4'),
        AT_FIX('NKS31', 'FX31A', ['FX31A', 'FX31B'], '31'),
      ], { mode: 'training' }),
    });
    expect(say(e, appr('NKS22', 'RNAV', '22'), 'APP').status).toBe('accepted');
    expect(find(e, 'NKS22').nav?.fixes).toEqual(['FX22A', 'FX22B', 'FX22C']); // already past the feeder
    const r4 = say(e, appr('NKS04', 'RNAV', '4'), 'APP');
    expect(r4.status).toBe('accepted');
    if (r4.status === 'accepted') expect(r4.readback).toBe('Cleared RNAV runway four approach, Spirit zero four');
    const r31 = say(e, appr('NKS31', 'VOR', '31'), 'APP');
    expect(r31.status).toBe('accepted');
    if (r31.status === 'accepted') expect(r31.readback).toMatch(/^Cleared VOR runway three one approach, /);
  });

  it('a route that does not join the procedure is refused (request vectors)', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'TSE'])], { mode: 'training' }) });
    const r = say(e, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.reason).toMatch(/not on a route that joins/);
      expect(r.pilotResponse).toMatch(/request vectors/);
    }
  });

  it('visual approach: accepted in VMC, refused in IMC, low ceiling or low visibility (any mode)', () => {
    const run1 = (weather: Weather, mode: 'training' | 'free_play') => {
      const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE)], { weather, mode }) });
      return say(e, appr('NKS451', 'VISUAL', '13'), 'APP');
    };
    const ok = run1(wx({}), 'training');
    expect(ok.status).toBe('accepted');
    if (ok.status === 'accepted') expect(ok.readback).toBe('Cleared visual approach runway one three, Spirit four fifty one');
    expect(run1(wx({ flightCategory: 'MVFR', clouds: [{ cover: 'BKN', baseFtAgl: 1500 }] }), 'training').status).toBe('accepted');
    for (const mode of ['training', 'free_play'] as const) {
      for (const bad of [wx({ flightCategory: 'IFR', clouds: [{ cover: 'OVC', baseFtAgl: 600 }] }), wx({ clouds: [{ cover: 'BKN', baseFtAgl: 900 }] }), wx({ visibilitySm: 2 })]) {
        const r = run1(bad, mode);
        expect(r.status).toBe('rejected');
        if (r.status === 'rejected') expect(r.pilotResponse).toMatch(/not in visual conditions/);
      }
    }
  });

  it('refuses aircraft that are on the ground, departures, farther than 30 nm, or with no approach type / runway', () => {
    const e = makeEngine({
      scenario: ifrScenario([GA_PARKED('N723EJ', 'GA1', 'APP'), ARRIVING('N5FAR', '13', 35, 'C172', 'APP'), ARRIVING('N5NEAR', '13', 12, 'C172', 'APP')], { mode: 'training' }),
    });
    expect(say(e, appr('N723EJ', 'ILS', '13'), 'APP').status).toBe('rejected');
    const far = say(e, appr('N5FAR', 'ILS', '13'), 'APP');
    expect(far.status).toBe('rejected');
    if (far.status === 'rejected') expect(far.reason).toMatch(/limited to 30 nm/);
    expect(say(e, cmd('APPROACH', 'N5NEAR', { runwayEnd: '13' }), 'APP').status).toBe('clarify'); // no approach type
    expect(say(e, cmd('APPROACH', 'N5NEAR', { approachType: 'ILS', confidence: 0.7 }), 'APP').status).toBe('clarify'); // runway not explicit at low confidence
    // high confidence may infer the assigned runway
    expect(say(e, cmd('APPROACH', 'N5NEAR', { approachType: 'ILS' }), 'APP').status).toBe('accepted');
  });
});

describe('APPROACH clearance: intercept geometry', () => {
  const vectored = (mode: 'training' | 'free_play', hdgMag: number, extra: Parameters<typeof AT_FIX> = ['NKS451', 'TARR', ROUTE]) => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX(...extra)], { mode }) });
    say(e, cmd('HEADING', 'NKS451', { headingDeg: hdgMag }), 'APP');
    return e;
  };

  it('intercept angle above 30 degrees: refused in training, accepted and flagged otherwise', () => {
    // course 118 true; 87 magnetic = 75 true -> 43 degrees
    const t = vectored('training', 87);
    const r = say(t, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.reason).toMatch(/intercept angle too large/);
      expect(r.pilotResponse).toBe('Unable, the intercept angle is too large, Spirit four fifty one');
    }
    const f = vectored('free_play', 87);
    expect(say(f, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
    run(f, 1);
    expect(f.getState().score.communicationErrors).toBe(1);
    expect(f.getState().score.correctClearances).toBe(1); // the HEADING; the improper approach clearance is not counted
    expect(f.getState().events.some((x) => /Improper instruction accepted: Unable: intercept angle too large/.test(x.text))).toBe(true);
  });

  it('inside the final approach fix: refused in training, accepted and flagged otherwise', () => {
    const mk = (mode: 'training' | 'free_play') => {
      const e = makeEngine({ scenario: ifrScenario([ARRIVING('NKS451', '13', 3, 'A320', 'APP')], { mode }) });
      expect(find(e, 'NKS451').phase).toBe('FINAL');
      expect(say(e, cmd('HEADING', 'NKS451', { headingDeg: 130 }), 'APP').status).toBe('accepted');
      return e;
    };
    const t = mk('training');
    const r = say(t, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.reason).toMatch(/inside the final approach fix/);
      expect(r.pilotResponse).toBe("Unable, we're inside the final approach fix, Spirit four fifty one");
    }
    const f = mk('free_play');
    expect(say(f, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
    run(f, 1);
    expect(f.getState().score.communicationErrors).toBe(1);
  });

  it('a heading that does not intercept the course, or intercepts more than 10 nm ahead, is improper', () => {
    // 102 magnetic = 90 true (28 degrees), TARR is 7.4 nm right of the course -> converging, intercept 15 nm ahead -> improper
    const far = vectored('training', 102);
    const r = say(far, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toMatch(/clear the approach when the intercept is within 10 nm/);
    // heading away from the course (south-east side, right of course): 140 magnetic = 128 true -> diverging
    const away = vectored('training', 150);
    const r2 = say(away, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r2.status).toBe('rejected');
    if (r2.status === 'rejected') expect(r2.reason).toMatch(/not on a heading that intercepts/);
  });

  it('a proper vector (30 degrees, intercept 2+ nm outside the approach gate) is accepted in training, captures the course, and lands', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 4000)], { mode: 'training' }) });
    const ac = find(e, 'NKS451');
    run(e, 5);
    expect(say(e, cmd('HEADING', 'NKS451', { headingDeg: 100 }), 'APP').status).toBe('accepted'); // 88 true: 30 degrees to the course
    // clear the approach when the course is about 4 nm away
    expect(runUntil(e, () => Math.abs(alongCross(g13, ac.pos).cross) < nmToM(4.7), 400)).toBe(true);
    const r = say(e, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r.status).toBe('accepted');
    expect(ac.nav?.mode).toBe('vectors'); // still flying the assigned heading until established
    expect(runUntil(e, () => e.getState().events.some((x) => /established on the ILS course runway 13/.test(x.text)), 600)).toBe(true);
    handoffAndLand(e, 'NKS451', '13');
    expect(e.getState().events.some((x) => x.kind === 'GO_AROUND')).toBe(false);
    expect(e.getState().conflicts).toHaveLength(0);
  });

  it('a heading after the approach clearance cancels it (vectored off the approach)', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE)], { mode: 'training' }) });
    const ac = find(e, 'NKS451');
    expect(say(e, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
    expect(ac.nav?.mode).toBe('approach');
    expect(say(e, cmd('HEADING', 'NKS451', { headingDeg: 100 }), 'APP').status).toBe('accepted');
    expect(ac.nav?.mode).toBe('vectors');
    expect(ac.clearances.find((c) => c.kind === 'APPROACH')?.completedAtSec).toBeDefined();
    run(e, 600);
    expect(ac.phase).not.toBe('FINAL'); // never captured: the clearance is gone
  });

  it('legacy aircraft that navigate to the runway on their own (no route, no vectors) accept an approach without geometry', () => {
    const e = makeEngine({ scenario: ifrScenario([ARRIVING('N5NEAR', '13', 12, 'C172', 'APP')], { mode: 'training' }) });
    expect(say(e, appr('N5NEAR', 'ILS', '13'), 'APP').status).toBe('accepted');
    expect(say(e, cmd('APPROACH', 'N5NEAR', { approachType: 'VISUAL', runwayEnd: '13' }), 'APP').status).toBe('accepted');
  });
});

describe('flying approaches to touchdown', () => {
  it('ILS 13 from the feeder route: holds altitude, intercepts the 3 degree path from below, FINAL inside 8.5 nm, handoff, LAND, touchdown, no conflicts', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'training' }) });
    const ac = find(e, 'NKS451');
    run(e, 5);
    expect(say(e, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
    let prevAlt = ac.altitudeFt;
    let finalAtNm = -1;
    let maxGlideErr = 0;
    let sawLevelBeforeGs = false;
    let handed = false;
    let landIssued = false;
    const phases = new Set<string>();
    for (let i = 0; i < 12000 && ac.phase !== 'LANDING'; i++) {
      e.step();
      expect(ac.altitudeFt).toBeLessThanOrEqual(prevAlt + 0.01); // never climbs
      prevAlt = ac.altitudeFt;
      phases.add(ac.phase);
      const d = dToThreshold(e, 'NKS451');
      if (ac.phase === 'APPROACH' && ac.altitudeFt === 3000 && d < 12) sawLevelBeforeGs = true;
      if (ac.phase === 'FINAL' && finalAtNm < 0) finalAtNm = d;
      if (ac.phase === 'FINAL' && d < 6 && d > 1.5) {
        maxGlideErr = Math.max(maxGlideErr, Math.abs(ac.altitudeFt - glideAltitudeFt(g13.elevationFt, nmToM(d))));
      }
      if (!handed && ac.phase === 'FINAL' && d < 7) {
        handed = true;
        expect(say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'TWR' }), 'APP').status).toBe('accepted');
      }
      if (!landIssued && ac.frequencyId === 'TWR' && ac.phase === 'FINAL' && d < 6.5) {
        landIssued = true;
        expect(say(e, cmd('LAND', 'NKS451', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
      }
      expect(e.getState().conflicts).toHaveLength(0);
    }
    expect(phases.has('APPROACH')).toBe(true);
    expect(sawLevelBeforeGs).toBe(true);
    expect(finalAtNm).toBeGreaterThan(5);
    expect(finalAtNm).toBeLessThan(8.5);
    expect(maxGlideErr).toBeLessThan(200);
    run(e, 60);
    expect(['ROLLOUT', 'RUNWAY_EXIT', 'TAXI_TO_PARKING']).toContain(ac.phase); // landed (the exit is now made at the first reachable exit)
    const texts = pilotTexts(e);
    expect(texts).toContain('Atlantic City Approach, Spirit four fifty one, established on the ILS runway one three.');
    expect(texts.some((t) => /^Atlantic City Tower, Spirit four fifty one, \w+ mile final runway one three, full stop\.$/.test(t))).toBe(true);
    expect(e.getState().events.some((x) => x.kind === 'GO_AROUND')).toBe(false);
    expect(e.getState().events.some((x) => /touched down runway 13/.test(x.text))).toBe(true);
    // approach state is cleaned up
    expect(ac.nav).toBeUndefined();
  });

  it('RNAV 22 (course a few degrees off the runway heading) lands too', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS452', 'FX22F', ['FX22F', 'FX22A', 'FX22B', 'FX22C'], '22', {}, 3000, 170)], { mode: 'training', activeRunways: { departing: ['22'], landing: ['22'] } }) });
    const ac = find(e, 'NKS452');
    run(e, 5);
    expect(say(e, appr('NKS452', 'RNAV', '22'), 'APP').status).toBe('accepted');
    handoffAndLand(e, 'NKS452', '22');
    expect(e.getState().events.some((x) => x.kind === 'GO_AROUND')).toBe(false);
    expect(ac.assignedRunwayEnd).toBe('22');
  });

  it('visual approach: the aircraft flies to the runway on its own and lands', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'training' }) });
    run(e, 5);
    expect(say(e, appr('NKS451', 'VISUAL', '13'), 'APP').status).toBe('accepted');
    expect(find(e, 'NKS451').nav).toBeUndefined();
    handoffAndLand(e, 'NKS451', '13');
  });

  it('missed approach without published text (fallback): 2000 ft, runway heading, asks for vectors; Tower hands back to Approach; direct + second approach lands', () => {
    const plain = createTestAirport();
    for (const p of plain.procedures) delete p.missedApproachText; // no published missed approach in the data: the plain go-around
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'training' }), opts: { airport: plain } });
    const ac = find(e, 'NKS451');
    run(e, 5);
    say(e, appr('NKS451', 'ILS', '13'), 'APP');
    expect(runUntil(e, () => ac.phase === 'FINAL', 1000)).toBe(true);
    say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'TWR' }), 'APP');
    // Tower never clears it to land: automatic go-around at the decision point
    expect(runUntil(e, () => ac.phase === 'GO_AROUND', 600)).toBe(true);
    expect(ac.target.altitudeFt).toBe(2000);
    expect(ac.target.headingDeg).toBeCloseTo(g13.headingDeg, 3);
    expect(ac.nav).toBeUndefined();
    expect(pilotTexts(e).some((t) => /going around runway one three, no landing clearance/.test(t))).toBe(true);
    expect(runUntil(e, () => ac.pendingRequest?.text === 'request vectors for another approach', 120)).toBe(true);
    expect(pilotTexts(e).pop()).toBe('Atlantic City Tower, Spirit four fifty one, runway heading, level two thousand, request vectors for another approach.');
    expect(Math.abs(ac.altitudeFt - 2000)).toBeLessThan(25);

    // Tower hands it back to Approach; it checks in "missed approach"
    expect(say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'APP' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'APP' && ac.pendingRequest?.kind === 'APPROACH', 20)).toBe(true);
    expect(pilotTexts(e).pop()).toBe('Atlantic City Approach, Spirit four fifty one, missed approach, two thousand.');

    // vectors back: climb, direct to the feeder, cleared again
    expect(say(e, cmd('ALTITUDE', 'NKS451', { altitudeFt: 3000 }), 'APP').status).toBe('accepted');
    expect(say(e, cmd('DIRECT_FIX', 'NKS451', { fix: 'TVO' }), 'APP').status).toBe('accepted');
    expect(ac.phase).toBe('APPROACH');
    expect(say(e, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
    expect(ac.nav).toEqual({ fixes: ['TVO', 'FX13A', 'FX13B'], index: 0, mode: 'approach' });
    handoffAndLand(e, 'NKS451', '13');
    // second approach: cleared to land this time
    expect(e.getState().events.filter((x) => x.kind === 'GO_AROUND')).toHaveLength(1);
  });

  it('is deterministic: the same approach replays identically', () => {
    const play = () => {
      const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'free_play' }), opts: { readbackErrorRate: 0.08 } });
      run(e, 5);
      say(e, appr('NKS451', 'ILS', '13'), 'APP');
      run(e, 500);
      const s = e.getState();
      return JSON.stringify({ a: s.aircraft, ev: s.events.map((x) => `${x.timeSec}:${x.text}`) });
    };
    expect(play()).toBe(play());
  });
});

describe('APPROACH clearance and separation (radar separation minima, 3 nm in trail at the moment of joining)', () => {
  /** Put an aircraft on the extended 13 centreline `dNm` before the threshold (`crossNm` right of it) on `headingTrue`. */
  const place = (e: SimulationEngine, cs: string, dNm: number, crossNm = 0, headingTrue = g13.headingDeg) => {
    const ac = find(e, cs);
    ac.pos = { x: g13.end.threshold.x - g13.dir.x * nmToM(dNm) + g13.right.x * nmToM(crossNm), y: g13.end.threshold.y - g13.dir.y * nmToM(dNm) + g13.right.y * nmToM(crossNm) };
    ac.headingDeg = headingTrue;
    ac.trackDeg = headingTrue;
    return ac;
  };
  /** Follower over the IF (FX13A, 10.66 nm out) on the route to the FAF; leader established `leaderNm` out (A320 at 160 kt). */
  const overIf = (mode: 'training' | 'free_play', leaderNm: number) =>
    makeEngine({ scenario: ifrScenario([ARRIVING('AAL100', '13', leaderNm, 'A320', 'APP'), AT_FIX('NKS451', 'FX13A', ['FX13A', 'FX13B'], '13', {}, 3000)], { mode }) });

  it('follower over the IF with the leader on 5 nm final (about 5.7 nm apart): accepted', () => {
    const e = overIf('training', 5);
    expect(find(e, 'AAL100').phase).toBe('FINAL');
    const r = say(e, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r.status).toBe('accepted');
    expect(find(e, 'NKS451').nav?.mode).toBe('approach');
    run(e, 1);
    expect(e.getState().score.unsafeInstructions).toBe(0);
  });

  it('follower over the IF with the leader on course 9 nm out (about 1.7 nm ahead): training refuses, citing radar separation minima', () => {
    const e = overIf('training', 9);
    const r = say(e, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.unsafe).toBe(true);
      expect(r.reason).toMatch(/Unsafe clearance not issued/);
      expect(r.reason).toMatch(/AAL100/);
      expect(r.reason).toMatch(/radar separation minima/);
      expect(r.reason).toMatch(/radar separation minimum 3 nm/);
      expect(r.reason).toMatch(/7110\.65 5-5-4/); // paragraph verified in docs/REALISM-VERIFICATION.md
    }
    run(e, 1);
    expect(e.getState().score.unsafeInstructions).toBe(1);
    expect(find(e, 'NKS451').nav?.mode).toBe('route');
  });

  it('other modes accept it, flag UNSAFE_CLEARANCE and score it', () => {
    const e = overIf('free_play', 9);
    expect(say(e, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
    run(e, 1);
    expect(e.getState().score.unsafeInstructions).toBe(1);
    expect(e.getState().conflicts.some((c) => c.kind === 'UNSAFE_CLEARANCE')).toBe(true);
  });

  it('a follower still far from the course is projected to the join point: the leader will have moved on', () => {
    // Follower at TARR (13 nm of track to the IF), leader just inside the IF: by the time it joins the leader is long gone
    const e = makeEngine({ scenario: ifrScenario([ARRIVING('AAL100', '13', 9, 'A320', 'APP'), AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 4000)], { mode: 'training' }) });
    expect(say(e, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
  });

  it('vectored follower joining at 8 nm with the leader on 6 nm final: unsafe', () => {
    const mk = (mode: 'training' | 'free_play') => {
      const e = makeEngine({ scenario: ifrScenario([ARRIVING('AAL100', '13', 6, 'A320', 'APP'), AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode }) });
      // 8.5 nm out, 0.4 nm right of the course, 25 degrees to it -> intercepts about 1 nm later at roughly 7.6 nm
      place(e, 'NKS451', 8.5, 0.4, g13.headingDeg - 25);
      expect(say(e, cmd('HEADING', 'NKS451', { headingDeg: ((g13.headingDeg - 25 + 12) + 360) % 360 }), 'APP').status).toBe('accepted');
      return e;
    };
    const t = mk('training');
    const r = say(t, appr('NKS451', 'ILS', '13'), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.unsafe).toBe(true);
    const f = mk('free_play');
    expect(say(f, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
    run(f, 1);
    expect(f.getState().score.unsafeInstructions).toBe(1);
  });

  it('wake (TBL 5-5-4 on approach): Category I behind an A320 (Category F) needs 4 NM, an A320 behind an A320 only the 3 NM radar minimum', () => {
    const mk = (followerType: string) => {
      // leader A320 on 6.7 nm final (FINAL), follower over the IF (10.66 nm): 3.96 nm apart
      const e = makeEngine({ scenario: ifrScenario([ARRIVING('AAL100', '13', 6.7, 'A320', 'APP'), { ...AT_FIX('NKS451', 'FX13A', ['FX13A', 'FX13B'], '13', {}, 3000), type: followerType }], { mode: 'training' }) });
      return say(e, appr('NKS451', 'ILS', '13'), 'APP');
    };
    expect(mk('A320').status).toBe('accepted'); // 3.96 nm >= 3 nm (F behind F: blank cell)
    const light = mk('C172');
    expect(light.status).toBe('rejected');
    if (light.status === 'rejected') {
      expect(light.unsafe).toBe(true);
      expect(light.reason).toMatch(/wake turbulence separation \(7110\.65 5-5-4, TBL 5-5-4 on approach: Category F leader, Category I follower\) needs 4 NM for NKS451 \(C172\) behind AAL100 \(A320\)/);
    }
  });

  it('wake: Category I behind an A320 is accepted from 4 NM (TBL 5-5-4 F->I), refused at 3.96 NM', () => {
    // leader A320 on 6.3 nm final, follower over the IF (10.66 nm): about 4.3 nm apart
    const e = makeEngine({ scenario: ifrScenario([ARRIVING('AAL100', '13', 6.3, 'A320', 'APP'), { ...AT_FIX('NKS451', 'FX13A', ['FX13A', 'FX13B'], '13', {}, 3000), type: 'C172' }], { mode: 'training' }) });
    expect(say(e, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
  });

  it('wake: a light aircraft AHEAD of an A320 only needs the 3 nm radar minimum from the A320 clearance', () => {
    const e = makeEngine({ scenario: ifrScenario([{ ...ARRIVING('N5LEAD', '13', 6.7, 'C172', 'APP') }, AT_FIX('NKS451', 'FX13A', ['FX13A', 'FX13B'], '13', {}, 3000)], { mode: 'training' }) });
    // A320 follower behind a C172 leader at 3.96 nm: the radar minimum applies
    expect(say(e, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
  });

  it('vectored follower joining at 8 nm with the leader on 3 nm final is fine', () => {
    const e = makeEngine({ scenario: ifrScenario([ARRIVING('AAL100', '13', 3, 'A320', 'APP'), AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'training' }) });
    place(e, 'NKS451', 9.5, 0.4, g13.headingDeg - 25);
    say(e, cmd('HEADING', 'NKS451', { headingDeg: ((g13.headingDeg - 25 + 12) + 360) % 360 }), 'APP');
    expect(say(e, appr('NKS451', 'ILS', '13'), 'APP').status).toBe('accepted');
  });
});
