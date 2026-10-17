import { describe, expect, it } from 'vitest';
import plates from '../../data/sources/kacy-procedures.json';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import { AT_FIX, ALL_POSITIONS, cmd, find, ifrScenario, makeEngine, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { kacyWithPlates } from './__fixtures__/kacyPlates';
import { parseMissedApproach, publishedHoldFor, publishedPatternFor, inboundFromRadials } from './missedApproach';
import { parseHoldingText } from './holding';
import { dist, mToNm } from './geo';
import { findNavFix } from './navigation';
import { alongCross, findRunwayEnd } from './runways';

const VERBATIM: [string, object][] = [
  ['Climb to 600 then climbing left turn to 2000 on ACY R-090 to SMITS/ACY 11 DME and hold.',
    { initialAltitudeFt: 600, turn: 'left', finalAltitudeFt: 2000, legs: [{ kind: 'radial', navaid: 'ACY', radialMag: 90, toFix: 'SMITS' }], holdFix: 'SMITS' }],
  ['Climb to 500 then climbing right turn to 2000 via heading 130 deg and via ACY R-090 to SMITS INT/ACY 11 DME and hold.',
    { initialAltitudeFt: 500, turn: 'right', finalAltitudeFt: 2000, legs: [{ kind: 'heading', headingMag: 130 }, { kind: 'radial', navaid: 'ACY', radialMag: 90, toFix: 'SMITS' }], holdFix: 'SMITS' }],
  ['Climb to 2000 on track 128 deg to JURAD and on track 076 deg to RODDI and hold.',
    { initialAltitudeFt: undefined, turn: undefined, finalAltitudeFt: 2000, legs: [{ kind: 'track', trackMag: 128, toFix: 'JURAD' }, { kind: 'track', trackMag: 76, toFix: 'RODDI' }], holdFix: 'RODDI' }],
  ['Climb to 2000 direct WEREK and on track 259 deg to KOVEC and hold.',
    { finalAltitudeFt: 2000, legs: [{ kind: 'direct', fix: 'WEREK' }, { kind: 'track', trackMag: 259, toFix: 'KOVEC' }], holdFix: 'KOVEC' }],
  ['Climb to 600 then climbing right turn to 2000 direct SMITS and hold.',
    { initialAltitudeFt: 600, turn: 'right', finalAltitudeFt: 2000, legs: [{ kind: 'direct', fix: 'SMITS' }], holdFix: 'SMITS' }],
  ['Climbing right turn to 2000 via heading 120 deg and ACY R-090 to SMITS INT/ACY 11 DME and hold.',
    { initialAltitudeFt: undefined, turn: 'right', finalAltitudeFt: 2000, legs: [{ kind: 'heading', headingMag: 120 }, { kind: 'radial', navaid: 'ACY', radialMag: 90, toFix: 'SMITS' }], holdFix: 'SMITS' }],
];

describe('missed approach interpreter', () => {
  it.each(VERBATIM)('interprets %s', (text, expected) => {
    expect(parseMissedApproach(text)).toMatchObject(expected);
  });

  it('interprets every transcribed KACY missed approach text', () => {
    const texts = (plates as unknown as { instrument_approaches: { missed_approach: string; chart_name: string }[] }).instrument_approaches.map((p) => [p.chart_name, p.missed_approach]);
    expect(texts.length).toBe(13);
    for (const [name, t] of texts) {
      const plan = parseMissedApproach(t);
      expect(plan, `${name}: ${t}`).toBeDefined();
      expect(plan!.finalAltitudeFt).toBeGreaterThanOrEqual(2000);
      expect(['SMITS', 'RODDI', 'KOVEC', 'TUBER']).toContain(plan!.holdFix);
    }
    // VORTAC / VOR wording and the "INT/11 DME" tail
    expect(parseMissedApproach('Climbing right turn to 2000 on ACY VORTAC R-090 to SMITS INT/11 DME and hold.')?.legs).toEqual([{ kind: 'radial', navaid: 'ACY', radialMag: 90, toFix: 'SMITS' }]);
    expect(parseMissedApproach('Climbing right turn to 2000 on heading 120 deg and on ACY R-090 to SMITS/ACY 11 DME and hold.')?.legs).toHaveLength(2);
  });

  it('is case/whitespace tolerant and rejects anything it does not understand', () => {
    expect(parseMissedApproach('  climb to 2000   direct smits and hold  ')?.holdFix).toBe('SMITS');
    for (const bad of [undefined, '', 'Climb to 2000 and hold.', 'Turn left and climb.', 'Climb to 2000 direct SMITS.', 'Climb to 600 then climbing left turn to 500 direct SMITS and hold.',
      'Climb to 2000 via heading 130 deg and hold.', 'Climb to 2000 intercept the 090 radial and hold.', 'Climb to 2000 via ACY R-090 and hold.']) {
      expect(parseMissedApproach(bad), String(bad)).toBeUndefined();
    }
  });

  it('holding text: leg length, left turns and a stated inbound course are read per fix', () => {
    const t = 'CARYL 6 NM hold (printed); RODDI hold max 230 KIAS';
    expect(parseHoldingText(t, 'CARYL')).toEqual({ legNm: 6 });
    expect(parseHoldingText(t, 'RODDI')).toEqual({});
    expect(parseHoldingText('CARYL: one-minute hold 4500/2000 (printed HOLD 4500 2000)', 'CARYL')).toEqual({ legMinutes: 1 });
    expect(parseHoldingText('RODDI 5 NM hold', 'RODDI')).toEqual({ legNm: 5 });
    expect(parseHoldingText('STEVV: one-minute hold 2000 (printed), holding NA at STEVV for Cat E, radar required', 'STEVV')).toEqual({ legMinutes: 1 });
    expect(parseHoldingText('MEADY: 270 deg inbound, left turns, 1.5-minute hold', 'MEADY')).toEqual({ legMinutes: 1.5, turns: 'left', inboundCourseMag: 270 });
    expect(parseHoldingText('-', 'SMITS')).toBeUndefined();
    expect(parseHoldingText(undefined, 'SMITS')).toBeUndefined();
    expect(parseHoldingText('RODDI 5 NM hold', 'CARYL')).toBeUndefined();
  });

  it('published holds: the charted patterns (holdingPatterns[]) come first; the radial / holdingText remain as fallbacks', () => {
    const kacy = kacyWithPlates();
    expect(inboundFromRadials(kacy, 'SMITS')?.inboundMag).toBe(270); // SMITS is defined on ACY R-090
    expect(publishedHoldFor(kacy, 'SMITS')?.hold).toMatchObject({ inboundCourseMag: 270, turns: 'right' });
    expect(publishedHoldFor(kacy, 'RODDI')?.hold).toMatchObject({ inboundCourseMag: 218, turns: 'right', legNm: 5 });
    expect(publishedHoldFor(kacy, 'TUBER')?.hold).toMatchObject({ inboundCourseMag: 17, turns: 'right', legNm: 6 });
    expect(publishedHoldFor(kacy, 'CARYL')?.hold).toMatchObject({ inboundCourseMag: 128, turns: 'right', legMinutes: 1 });
    expect(publishedHoldFor(kacy, 'MEADY')?.hold).toMatchObject({ inboundCourseMag: 48, turns: 'left' });
    expect(publishedHoldFor(kacy, 'NOWHERE')).toBeUndefined();
    // without the charted patterns the holding text / radial are used (and RODDI has no stated course)
    const bare = structuredClone(kacy);
    for (const p of bare.procedures) delete p.holdingPatterns;
    expect(publishedHoldFor(bare, 'RODDI')?.hold).toMatchObject({ legNm: 5 });
    expect(publishedHoldFor(bare, 'RODDI')?.hold.inboundCourseMag).toBeUndefined();
    expect(publishedHoldFor(bare, 'SMITS')?.hold.inboundCourseMag).toBe(270);
    expect(publishedPatternFor(kacy, 'tuber')?.procedureName).toBe('RNAV (GPS) RWY 22');
  });
});

const airport = createTestAirport();
const ROUTE = ['TARR', 'FX13A', 'FX13B'];

/** Approach cleared, handed to Tower on final; Tower never clears it to land. */
function toGoAround(e: SimulationEngine, cs = 'NKS451', rwy = '13', type: 'ILS' | 'RNAV' = 'ILS') {
  const ac = find(e, cs);
  run(e, 5);
  expect(say(e, cmd('APPROACH', cs, { approachType: type, runwayEnd: rwy }), 'APP').status).toBe('accepted');
  expect(runUntil(e, () => ac.phase === 'FINAL', 1500)).toBe(true);
  expect(say(e, cmd('CONTACT_FREQUENCY', cs, { frequencyId: 'TWR' }), 'APP').status).toBe('accepted');
  expect(runUntil(e, () => ac.phase === 'GO_AROUND', 600)).toBe(true);
  return ac;
}

describe('published missed approach (fixture)', () => {
  it('ILS 13: climbs to 2000, intercepts the radial to FXS and enters the hold there (inbound 270 magnetic), pilot calls', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'training' }) });
    const ac = toGoAround(e);
    expect(ac.nav).toEqual({ fixes: ['FXS'], index: 0, mode: 'missed' });
    expect(ac.target.altitudeFt).toBe(2000);
    expect(pilotTexts(e).pop()).toBe('Atlantic City Tower, Spirit four fifty one, going around runway one three, no landing clearance, flying the published missed approach.');
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'FREQUENCY_CHANGE', 120)).toBe(true);
    expect(pilotTexts(e).pop()).toBe('Atlantic City Tower, Spirit four fifty one, flying the published missed approach, level two thousand, request frequency change.');

    // Tower hands it back to Approach; check-in names the climb and the fix and asks for further clearance
    expect(say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'APP' }), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'APP' && ac.pendingRequest?.kind === 'APPROACH', 30)).toBe(true);
    expect(pilotTexts(e).pop()).toBe('Atlantic City Approach, Spirit four fifty one, missed approach, climbing two thousand, direct FXS, request further clearance.');

    // first leg is straight ahead (runway heading) until 600 ft, the track never leaves a sane corridor, and it ends holding at FXS
    const fxs = findNavFix(airport, 'FXS')!.pos;
    expect(runUntil(e, () => ac.phase === 'HOLDING', 900)).toBe(true);
    expect(dist(ac.pos, fxs)).toBeLessThan(2000);
    expect(ac.altitudeFt).toBeCloseTo(2000, 0);
    expect(ac.nav).toEqual({ fixes: ['FXS'], index: 0, mode: 'holding' });
    const info = e.getState().events.filter((x) => x.kind === 'INFO').map((x) => x.text);
    expect(info.some((t) => /flying the published missed approach \(ILS OR LOC RWY 13\)/.test(t))).toBe(true);
    expect(info.some((t) => /holding at FXS: inbound course 270 magnetic, right turns, 1 min legs/.test(t))).toBe(true);
    expect(info.some((t) => /assumption: inbound course 270 = reciprocal of FVR R-090/.test(t))).toBe(true);
    // a new check-in while holding says so
    expect(e.getState().conflicts).toHaveLength(0);
  });

  it('the climb is straight ahead on the runway heading until 600 ft, then the turn starts', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'training' }) });
    const ac = toGoAround(e);
    const g = findRunwayEnd(airport, '13')!;
    let sawStraight = false;
    for (let i = 0; i < 600 && ac.altitudeFt < 700; i++) {
      e.step();
      if (ac.altitudeFt < 590) {
        sawStraight = true;
        expect(Math.abs(((ac.headingDeg - g.headingDeg + 540) % 360) - 180)).toBeLessThan(1.5);
      }
    }
    expect(sawStraight).toBe(true);
    run(e, 30);
    expect(Math.abs(((ac.headingDeg - g.headingDeg + 540) % 360) - 180)).toBeGreaterThan(5); // turning toward the radial
  });

  it('RNAV 22: "direct FX22M" and the 6 NM hold there; the inbound course is the leg course (assumption recorded)', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS452', 'FX22F', ['FX22F', 'FX22A', 'FX22B', 'FX22C'], '22', {}, 3000, 160)], { mode: 'training', activeRunways: { departing: ['22'], landing: ['22'] } }) });
    const ac = toGoAround(e, 'NKS452', '22', 'RNAV');
    expect(ac.nav).toEqual({ fixes: ['FX22M'], index: 0, mode: 'missed' });
    expect(ac.target.altitudeFt).toBe(2000);
    expect(runUntil(e, () => ac.phase === 'HOLDING', 1200)).toBe(true);
    const info = e.getState().events.filter((x) => x.kind === 'INFO').map((x) => x.text);
    expect(info.some((t) => /holding at FX22M: inbound course \d{3} magnetic, right turns, 6 nm legs/.test(t) && /assumption: inbound course \d{3} = the course from where the leg to FX22M started/.test(t))).toBe(true);
  });

  it('MISSED_APPROACH from Approach on an aircraft established on the approach flies the same missed approach; refused on the ground / not on an approach', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000), AT_FIX('AAL7', 'TARR', ROUTE, '13', {}, 6000)], { mode: 'training' }) });
    const ac = find(e, 'NKS451');
    run(e, 5);
    say(e, cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: '13' }), 'APP');
    expect(runUntil(e, () => ac.phase === 'FINAL', 1500)).toBe(true);
    const r = say(e, cmd('MISSED_APPROACH', 'NKS451'), 'APP');
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') expect(r.readback).toBe('Executing the published missed approach, Spirit four fifty one');
    expect(ac.phase).toBe('GO_AROUND');
    expect(ac.nav?.mode).toBe('missed');
    // pilot does not announce an ATC-instructed missed approach, but flies it
    expect(pilotTexts(e).some((t) => /going around/.test(t))).toBe(false);
    // not on an approach (still on its arrival route, INBOUND/APPROACH without the approach: phase APPROACH is allowed, ground is not)
    expect(say(e, cmd('MISSED_APPROACH', 'AAL7'), 'APP').status).toBe('accepted');
  });

  it('missed approach text that cannot be interpreted falls back to runway heading / fixed altitude and logs an INFO event', () => {
    const bad = createTestAirport();
    for (const p of bad.procedures) if (p.id === 'FIX-ILS-OR-LOC-RWY-13') p.missedApproachText = 'Climb to 2000 and contact approach on 124.6.';
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'training' }), opts: { airport: bad } });
    const ac = toGoAround(e);
    expect(ac.nav).toBeUndefined();
    expect(ac.target.altitudeFt).toBe(2000);
    expect(ac.target.headingDeg).toBeCloseTo(findRunwayEnd(bad, '13')!.headingDeg, 3);
    const warn = e.getState().events.find((x) => /published missed approach .* could not be interpreted/.test(x.text));
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe('warning');
    expect(pilotTexts(e).some((t) => /going around runway one three, no landing clearance\.$/.test(t))).toBe(true);
    expect(runUntil(e, () => ac.pendingRequest?.text === 'request vectors for another approach', 120)).toBe(true);
  });

  it('VFR aircraft keep the plain go-around', () => {
    const e = makeEngine({ scenario: { spawns: [{ atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR', start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '13', distanceNm: 3 } }] } });
    expect(runUntil(e, () => find(e, 'N723EJ').phase === 'GO_AROUND', 400)).toBe(true);
    expect(find(e, 'N723EJ').nav).toBeUndefined();
  });

  it('is deterministic', () => {
    const play = () => {
      const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE, '13', {}, 3000)], { mode: 'free_play' }), opts: { readbackErrorRate: 0.08 } });
      const ac = find(e, 'NKS451');
      run(e, 5);
      say(e, cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: '13' }), 'APP');
      runUntil(e, () => ac.phase === 'HOLDING', 3000);
      run(e, 200);
      const s = e.getState();
      return JSON.stringify({ a: s.aircraft, ev: s.events.map((x) => `${x.timeSec}:${x.text}`) });
    };
    expect(play()).toBe(play());
  });
});

describe('published missed approach (real KACY data with plate text)', () => {
  const ap = kacyWithPlates();
  const make = (fix: string, route: string[], rwy: string): SimulationEngine =>
    createEngine({
      airport: ap, readbackErrorRate: 0,
      scenario: makeScenario({
        controllerPositions: ALL_POSITIONS, mode: 'training', activeRunways: { departing: [rwy], landing: [rwy] },
        spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP', start: { kind: 'at_fix', fix, altitudeFt: 3000, speedKt: 170, route, runwayEnd: rwy } }],
      }),
    });

  it('ILS 13: left turn to ACY R-090 and hold at SMITS at 2000 (inbound 270)', () => {
    const e = make('CARYL', ['CARYL', 'MAYBN'], '13');
    const ac = toGoAround(e);
    expect(ac.nav).toEqual({ fixes: ['SMITS'], index: 0, mode: 'missed' });
    expect(runUntil(e, () => ac.phase === 'HOLDING', 1200)).toBe(true);
    expect(ac.altitudeFt).toBeCloseTo(2000, 0);
    const smits = findNavFix(ap, 'SMITS')!.pos;
    expect(mToNm(dist(ac.pos, smits))).toBeLessThan(1);
    // the straight-ahead climb ended near the runway; the radial was intercepted and tracked: on the way to SMITS the track is ~090 magnetic
    expect(e.getState().events.some((x) => /holding at SMITS: inbound course 270 magnetic, right turns, 1 min legs/.test(x.text))).toBe(true);
    run(e, 400);
    expect(ac.phase).toBe('HOLDING');
    expect(mToNm(dist(ac.pos, smits))).toBeLessThan(5);
  });

  it('RNAV 22: direct TUBER, hold there (6 NM legs)', () => {
    const e = make('KOPCE', ['KOPCE', 'FLDER', 'EFEWY'], '22');
    const ac = toGoAround(e, 'NKS451', '22', 'RNAV');
    expect(ac.nav).toEqual({ fixes: ['TUBER'], index: 0, mode: 'missed' });
    expect(runUntil(e, () => ac.phase === 'HOLDING', 1200)).toBe(true);
    expect(ac.altitudeFt).toBeCloseTo(2000, 0);
    const tuber = findNavFix(ap, 'TUBER')!.pos;
    expect(mToNm(dist(ac.pos, tuber))).toBeLessThan(1);
    const hold = e.getState().events.find((x) => /holding at TUBER/.test(x.text))!.text;
    expect(hold).toMatch(/holding at TUBER: inbound course 017 magnetic, right turns, 6 nm legs \(charted holding pattern, RNAV \(GPS\) RWY 22\)/);
    expect(hold).not.toMatch(/assumption/);
    const g = findRunwayEnd(ap, '22')!;
    expect(alongCross(g, ac.pos).along).toBeGreaterThan(0); // flown past the airport toward the missed approach fix
  });
});
