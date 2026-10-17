import { describe, expect, it } from 'vitest';
import type { SimulationEngine } from './api';
import type { HoldingInstruction, Weather } from './types';
import { ALL_POSITIONS, AT_FIX, cmd, find, GA_PARKED, ifrScenario, makeEngine, makeScenario, run, runUntil, say } from './__fixtures__/testHelpers';
import { createEngine } from './engine';
import { createTestAirport, FIXTURE_MAG_VAR } from './__fixtures__/testAirport';
import { kacyWithPlates } from './__fixtures__/kacyPlates';
import { buildReadback } from '../radio/readback';
import { dist, headingDiff, headingToVec, mToNm, nmToM, normHeading } from './geo';
import { holdEntryFor } from './holding';
import { findNavFix } from './navigation';

const airport = createTestAirport();
const TVO = findNavFix(airport, 'TVO')!.pos;
const hold = (over: Partial<HoldingInstruction> = {}): HoldingInstruction => ({ fix: 'TVO', turns: 'right', asPublished: false, ...over });
const holdCmd = (h: Partial<HoldingInstruction>) => cmd('HOLD_AT_FIX', 'NKS451', { hold: h });

function engineHolding(h: Partial<HoldingInstruction>, over: { alt?: number } = {}): SimulationEngine {
  const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'TVO'], '13', {}, over.alt ?? 4000)], { mode: 'training' }) });
  run(e, 3);
  expect(say(e, holdCmd(h), 'APP').status).toBe('accepted');
  return e;
}

/** Fly `sec` seconds; returns the sampled positions and the contiguous outbound intervals (heading within 3 degrees of the outbound heading). */
function sample(e: SimulationEngine, sec: number, outboundTrue: number) {
  const ac = find(e, 'NKS451');
  const dt = e.getState().clock.dtSec;
  const intervals: { sec: number; nm: number }[] = [];
  let cur: { sec: number; nm: number } | undefined;
  let maxD = 0;
  const crossRight: number[] = [];
  const inbound = normHeading(outboundTrue + 180);
  const c = headingToVec(inbound);
  for (let i = 0; i < sec / dt; i++) {
    e.step();
    if (ac.phase !== 'HOLDING') continue;
    maxD = Math.max(maxD, mToNm(dist(ac.pos, TVO)));
    const on = Math.abs(headingDiff(ac.trackDeg, outboundTrue)) < 3;
    if (on) {
      cur = cur ?? { sec: 0, nm: 0 };
      cur.sec += dt;
      cur.nm += (ac.groundSpeedKt * dt) / 3600;
      crossRight.push((ac.pos.x - TVO.x) * c.y - (ac.pos.y - TVO.y) * c.x);
    } else if (cur) {
      intervals.push(cur);
      cur = undefined;
    }
  }
  return { intervals: intervals.filter((i) => i.sec > 20), maxD, crossRight };
}

describe('holding pattern', () => {
  it('right turns, one-minute legs: timed outbound legs, racetrack on the right of the inbound course, bounded around the fix', () => {
    const e = engineHolding(hold({ inboundCourseDeg: 300, legMinutes: 1 }));
    const ac = find(e, 'NKS451');
    expect(ac.phase).toBe('HOLDING');
    expect(ac.nav).toEqual({ fixes: ['TVO'], index: 0, mode: 'holding' });
    const outboundTrue = normHeading(300 + FIXTURE_MAG_VAR + 180);
    // fly to the fix, then several laps
    expect(runUntil(e, () => mToNm(dist(ac.pos, TVO)) < 0.5, 900)).toBe(true);
    const { intervals, maxD, crossRight } = sample(e, 900, outboundTrue);
    expect(intervals.length).toBeGreaterThanOrEqual(3);
    for (const i of intervals) {
      expect(i.sec).toBeGreaterThan(55);
      expect(i.sec).toBeLessThan(75); // one minute from wings level (plus the little turn-in the 3 degree window misses)
    }
    // a jet at hold speed: 1 min ~ 2.8 nm; the whole racetrack (legs + two 180 degree turns) stays within ~4.5 nm of the fix
    expect(maxD).toBeLessThan(4.8);
    expect(maxD).toBeGreaterThan(2);
    // right turns: the outbound leg is offset to the RIGHT of the inbound course by about a turn diameter (~2 nm)
    const meanCross = crossRight.reduce((a, b) => a + b, 0) / crossRight.length;
    expect(mToNm(meanCross)).toBeGreaterThan(1.2);
    expect(mToNm(meanCross)).toBeLessThan(3.2);
    expect(ac.altitudeFt).toBeCloseTo(4000, 0);
    expect(ac.airspeedKt).toBeCloseTo(170, 0);
    expect(e.getState().conflicts).toHaveLength(0);
  });

  it('left turns put the pattern on the left; nm-based legs are that long', () => {
    const e = engineHolding(hold({ inboundCourseDeg: 300, turns: 'left', legNm: 3 }));
    const ac = find(e, 'NKS451');
    const outboundTrue = normHeading(300 + FIXTURE_MAG_VAR + 180);
    expect(runUntil(e, () => mToNm(dist(ac.pos, TVO)) < 0.5, 900)).toBe(true);
    const { intervals, crossRight } = sample(e, 900, outboundTrue);
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    for (const i of intervals) {
      expect(i.nm).toBeGreaterThan(2.7);
      expect(i.nm).toBeLessThan(3.4);
    }
    const meanCross = crossRight.reduce((a, b) => a + b, 0) / crossRight.length;
    expect(mToNm(meanCross)).toBeLessThan(-0.9);
  });

  it('above 14,000 ft the default leg is 1.5 minutes; light aircraft hold at 90 kt', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'TVO'], '13', {}, 15000)], { mode: 'training' }) });
    run(e, 2);
    say(e, holdCmd(hold({ inboundCourseDeg: 300 })), 'APP');
    const ac = find(e, 'NKS451');
    const outboundTrue = normHeading(300 + FIXTURE_MAG_VAR + 180);
    expect(runUntil(e, () => mToNm(dist(ac.pos, TVO)) < 0.5, 1200)).toBe(true);
    const { intervals } = sample(e, 900, outboundTrue);
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    for (const i of intervals) expect(i.sec).toBeGreaterThan(85);
  });

  it('stays until cleared out: DIRECT_FIX, HEADING and APPROACH end the hold and put the arrival back on APPROACH', () => {
    for (const action of ['direct', 'heading', 'approach'] as const) {
      const e = engineHolding(hold({ inboundCourseDeg: 300 }));
      const ac = find(e, 'NKS451');
      run(e, 600);
      expect(ac.phase).toBe('HOLDING');
      const cmdOut =
        action === 'direct' ? cmd('DIRECT_FIX', 'NKS451', { fix: 'FX13A' })
          : action === 'heading' ? cmd('HEADING', 'NKS451', { headingDeg: 150 })
            : cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: '13' });
      expect(say(e, cmdOut, 'APP').status, action).toBe('accepted');
      expect(ac.phase, action).toBe('APPROACH');
      expect(ac.nav?.mode, action).toBe(action === 'direct' ? 'direct' : action === 'heading' ? 'vectors' : 'approach');
      run(e, 30);
      expect(ac.phase).not.toBe('HOLDING');
    }
  });

  it('RESUME_OWN_NAVIGATION also leaves the hold', () => {
    const e = engineHolding(hold({ inboundCourseDeg: 300 }));
    const ac = find(e, 'NKS451');
    run(e, 300);
    // the route TARR -> TVO: TVO was never sequenced (the hold took over), so it is resumed
    const r = say(e, cmd('RESUME_OWN_NAVIGATION', 'NKS451'), 'APP');
    expect(r.status).toBe('accepted');
    expect(ac.phase).toBe('APPROACH');
    expect(ac.nav?.mode).toBe('route');
  });

  it('a new hold replaces the old one', () => {
    const e = engineHolding(hold({ inboundCourseDeg: 300 }));
    expect(say(e, holdCmd(hold({ fix: 'FX13A', inboundCourseDeg: 118 })), 'APP').status).toBe('accepted');
    expect(find(e, 'NKS451').nav).toEqual({ fixes: ['FX13A'], index: 0, mode: 'holding' });
  });
});

describe('published holds', () => {
  it('"as published" uses the holding text for the leg and a radial definition for the inbound course', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A'], '13', {}, 4000)], { mode: 'training' }) });
    run(e, 3);
    // FX13A: "one-minute hold" in the ILS holding text, no inbound course transcribed -> assumption recorded
    expect(say(e, holdCmd({ fix: 'FX13A', asPublished: true, turns: 'right' }), 'APP').status).toBe('accepted');
    const info = e.getState().events.filter((x) => x.kind === 'INFO').map((x) => x.text);
    expect(info.some((t) => /holding at FX13A: inbound course \d{3} magnetic, right turns, 1 min legs \(published/.test(t) && /assumption: inbound course \d{3} = the course/.test(t))).toBe(true);
  });

  it('a fix defined on a radial gets that radial\'s reciprocal as the inbound course without any assumption', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A'], '13', {}, 4000)], { mode: 'training' }) });
    run(e, 3);
    expect(say(e, holdCmd({ fix: 'FXS', asPublished: true, turns: 'right' }), 'APP').status).toBe('accepted');
    const t = e.getState().events.filter((x) => x.kind === 'INFO').map((x) => x.text).find((x) => /holding at FXS/.test(x))!;
    expect(t).toMatch(/inbound course 270 magnetic/);
    expect(t).not.toMatch(/assumption/);
  });

  it('real KACY charted patterns (holdingPatterns[]): CARYL 128 one-minute, SMITS 270, RODDI 218 with 5 NM legs, no assumptions', () => {
    const kacy = kacyWithPlates();
    const events = (fix: string) => {
      const e = createEngine({
        airport: kacy, readbackErrorRate: 0,
        scenario: makeScenario({
          controllerPositions: ALL_POSITIONS, mode: 'training',
          spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP', start: { kind: 'at_fix', fix: 'CARYL', altitudeFt: 4000, speedKt: 170, route: ['CARYL', 'MAYBN'], runwayEnd: '13' } }],
        }),
      });
      run(e, 3);
      expect(say(e, holdCmd({ fix, asPublished: true, turns: 'right' }), 'APP').status).toBe('accepted');
      return e.getState().events.filter((x) => x.kind === 'INFO').map((x) => x.text).find((x) => new RegExp(`holding at ${fix}`).test(x))!;
    };
    const caryl = events('CARYL');
    expect(caryl).toMatch(/inbound course 128 magnetic, right turns, 1 min legs \(published \(ILS Z OR LOC Z RWY 13 holding pattern\)\)/);
    expect(caryl).not.toMatch(/assumption/);
    const smits = events('SMITS');
    expect(smits).toMatch(/inbound course 270 magnetic, right turns, 1 min legs/);
    expect(smits).not.toMatch(/assumption/);
    const roddi = events('RODDI');
    expect(roddi).toMatch(/inbound course 218 magnetic, right turns, 5 nm legs/);
    expect(roddi).not.toMatch(/assumption/);
  });
});

describe('HOLD_AT_FIX validation', () => {
  it('needs an airborne aircraft that is not established on final, and a known fix', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'TVO'], '13', {}, 3000), GA_PARKED('N723EJ', 'GA1', 'APP')], { mode: 'training' }) });
    const ac = find(e, 'NKS451');
    const bad = say(e, holdCmd({ fix: 'NOWHERE', turns: 'right', asPublished: true }), 'APP');
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') expect(bad.pilotResponse).toBe("Unable, we don't have that fix, Spirit four fifty one");
    expect(say(e, cmd('HOLD_AT_FIX', 'N723EJ', { hold: hold() }), 'APP').status).toBe('rejected'); // on the ground
    expect(say(e, cmd('HOLD_AT_FIX', 'NKS451'), 'APP').status).toBe('clarify'); // no fix
    say(e, cmd('APPROACH', 'NKS451', { approachType: 'VISUAL', runwayEnd: '13' }), 'APP');
    expect(runUntil(e, () => ac.phase === 'FINAL', 1500)).toBe(true);
    const r = say(e, holdCmd(hold()), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toMatch(/cannot enter a hold/);
  });

  it('EFC is optional and only changes the readback', () => {
    const e = engineHolding(hold({ inboundCourseDeg: 270, efcZulu: '1245' }));
    expect(find(e, 'NKS451').phase).toBe('HOLDING');
  });
});

describe('HOLD_AT_FIX readbacks', () => {
  const ac = { ...find(makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'TVO'])]) }), 'NKS451') };
  const rb = (h: HoldingInstruction) => buildReadback(ac, { id: 'c', kind: 'HOLD_AT_FIX', issuedAtSec: 0, byPosition: 'APP', hold: h }, { airport }).text;

  it('full instruction: side of the fix, radial, turns, legs, EFC, callsign last', () => {
    expect(rb({ fix: 'FXS', inboundCourseDeg: 270, turns: 'right', legMinutes: 1, asPublished: false, efcZulu: '1245' })).toBe(
      'Hold east of FXS on the zero niner zero radial, right turns, one minute legs, expect further clearance one two four five, Spirit four fifty one',
    );
    expect(rb({ fix: 'TVO', inboundCourseDeg: 120, turns: 'left', legNm: 5, asPublished: false })).toBe(
      'Hold northwest of Testville on the three zero zero radial, left turns, five mile legs, Spirit four fifty one',
    );
  });

  it('as published; and without a course', () => {
    expect(rb({ fix: 'FXS', turns: 'right', asPublished: true })).toBe('Hold at FXS as published, Spirit four fifty one');
    expect(rb({ fix: 'TVO', turns: 'right', asPublished: true, efcZulu: '0930' })).toBe('Hold at Testville as published, expect further clearance zero niner three zero, Spirit four fifty one');
    expect(rb({ fix: 'TVO', turns: 'right', asPublished: false, legMinutes: 1.5 })).toBe('Hold at Testville, right turns, one and a half minute legs, Spirit four fifty one');
  });
});

describe('holding is deterministic', () => {
  it('identical state after the same run', () => {
    const play = () => {
      const e = engineHolding(hold({ inboundCourseDeg: 300 }));
      run(e, 700);
      const s = e.getState();
      return JSON.stringify({ a: s.aircraft, ev: s.events.map((x) => x.text) });
    };
    expect(play()).toBe(play());
  });
});


describe('AIM 5-3-8 holding entries (fixture fix TVO, inbound course 000 magnetic)', () => {
  const INBOUND_MAG = 0;
  const inboundTrue = normHeading(INBOUND_MAG + FIXTURE_MAG_VAR);
  const cases: { name: string; turns: 'left' | 'right'; rel: number; entry: 'direct' | 'teardrop' | 'parallel' }[] = [
    { name: 'right, flying the inbound course', turns: 'right', rel: 0, entry: 'direct' },
    { name: 'right, 60 left of the course (inside the direct sector)', turns: 'right', rel: -60, entry: 'direct' },
    { name: 'right, 100 right of the course (parallel sector)', turns: 'right', rel: 100, entry: 'parallel' },
    { name: 'right, 130 right (parallel sector)', turns: 'right', rel: 130, entry: 'parallel' },
    { name: 'right, 150 left (teardrop sector)', turns: 'right', rel: -150, entry: 'teardrop' },
    { name: 'right, 120 left (teardrop sector)', turns: 'right', rel: -120, entry: 'teardrop' },
    { name: 'left, flying the inbound course', turns: 'left', rel: 0, entry: 'direct' },
    { name: 'left, 130 left (mirrored parallel)', turns: 'left', rel: -130, entry: 'parallel' },
    { name: 'left, 150 right (mirrored teardrop)', turns: 'left', rel: 150, entry: 'teardrop' },
  ];

  it('sector boundaries', () => {
    expect(holdEntryFor(0, 0, 'right')).toBe('direct');
    expect(holdEntryFor(0, 69, 'right')).toBe('direct');
    expect(holdEntryFor(0, 71, 'right')).toBe('parallel');
    expect(holdEntryFor(0, 178, 'right')).toBe('direct'); // already outbound
    expect(holdEntryFor(0, 250, 'right')).toBe('teardrop'); // -110: the 70 degree line on the holding side
    expect(holdEntryFor(0, 249, 'right')).toBe('teardrop');
    expect(holdEntryFor(0, 251, 'right')).toBe('direct'); // -109
    expect(holdEntryFor(0, 291, 'right')).toBe('direct');
    expect(holdEntryFor(0, 290, 'left')).toBe('parallel'); // mirrored: -70 for a left hold
    expect(holdEntryFor(0, 110, 'left')).toBe('teardrop');
    expect(holdEntryFor(90, 90 + 130, 'right')).toBe('parallel'); // relative to the course, not north
  });

  it.each(cases)('$name -> $entry entry: established inbound on the course within 6 minutes, never > 6 nm from the fix', ({ turns, rel, entry }) => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'TVO'], '13', {}, 4000)], { mode: 'training' }) });
    const ac = find(e, 'NKS451');
    const heading = normHeading(inboundTrue + rel);
    const v = headingToVec(heading);
    ac.pos = { x: TVO.x - v.x * nmToM(8), y: TVO.y - v.y * nmToM(8) };
    ac.headingDeg = heading;
    ac.trackDeg = heading;
    ac.airspeedKt = 170;
    ac.groundSpeedKt = 170;
    ac.target.speedKt = 170;
    expect(say(e, holdCmd(hold({ inboundCourseDeg: INBOUND_MAG, turns, legMinutes: 1 })), 'APP').status).toBe('accepted');

    let tArrive: number | undefined;
    let tInbound: number | undefined;
    let maxD = 0;
    const dt = e.getState().clock.dtSec;
    for (let i = 0; i < 900 / dt; i++) {
      e.step();
      const t = e.getState().clock.timeSec;
      const d = mToNm(dist(ac.pos, TVO));
      if (tArrive === undefined && d < 0.5) tArrive = t;
      if (tArrive !== undefined) {
        maxD = Math.max(maxD, d);
        if (tInbound === undefined && d < 0.6 && Math.abs(headingDiff(ac.trackDeg, inboundTrue)) < 10 && (entry === 'direct' || t - tArrive > 20)) tInbound = t;
        if (tInbound !== undefined && t - tArrive > 400) break;
      }
    }
    expect(tArrive).toBeDefined();
    expect(maxD).toBeLessThan(6);
    expect(tInbound, 'crossed the fix inbound on the inbound course').toBeDefined();
    expect(tInbound! - tArrive!).toBeLessThan(360);
    const info = e.getState().events.filter((x) => x.kind === 'INFO' && /entry \(track/.test(x.text)).map((x) => x.text);
    expect(info).toHaveLength(1);
    expect(info[0]).toMatch(new RegExp(`over TVO: ${entry} entry .*${turns} turns; AIM 5-3-8`));
    expect(ac.phase).toBe('HOLDING');
  });

  it('teardrop: the outbound leg is 30 degrees off the outbound course toward the holding side; parallel turns toward the holding side', () => {
    const run1 = (rel: number) => {
      const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'TVO'], '13', {}, 4000)], { mode: 'training' }) });
      const ac = find(e, 'NKS451');
      const heading = normHeading(inboundTrue + rel);
      const v = headingToVec(heading);
      ac.pos = { x: TVO.x - v.x * nmToM(4), y: TVO.y - v.y * nmToM(4) };
      ac.headingDeg = heading;
      ac.trackDeg = heading;
      say(e, holdCmd(hold({ inboundCourseDeg: INBOUND_MAG, turns: 'right', legMinutes: 1 })), 'APP');
      return { e, ac };
    };
    // teardrop: on the outbound leg the track is outbound - 30 (holding side = east of a northbound inbound course)
    const td = run1(-150);
    const outbound = normHeading(inboundTrue + 180);
    let seen = 0;
    for (let i = 0; i < 4000; i++) {
      td.e.step();
      if (td.ac.phase === 'HOLDING' && Math.abs(headingDiff(td.ac.headingDeg, outbound - 30)) < 2 && mToNm(dist(td.ac.pos, TVO)) < 4) seen++;
    }
    expect(seen).toBeGreaterThan(200); // ~1 minute of flying the 30 degree teardrop leg
    // parallel: after the outbound leg the aircraft turns toward the holding side (left for a right-turn hold): the heading passes through east
    const pa = run1(130);
    let passedHoldingSide = false;
    for (let i = 0; i < 5000; i++) {
      pa.e.step();
      if (Math.abs(headingDiff(pa.ac.headingDeg, normHeading(inboundTrue + 90))) < 3 && mToNm(dist(pa.ac.pos, TVO)) < 5 && pa.e.getState().clock.timeSec > 120) passedHoldingSide = true;
    }
    expect(passedHoldingSide).toBe(true);
  });
});

describe('wind: the inbound leg tracks the course, not the heading', () => {
  it('30 kt crosswind: the heading is crabbed into the wind (> 5 deg) while the track stays on the inbound course', () => {
    const base = makeScenario().weather as Weather;
    const e = makeEngine({
      scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'TVO'], '13', {}, 4000)], { mode: 'training', weather: { ...base, windDirDeg: 90, windSpeedKt: 30 } }),
    });
    const ac = find(e, 'NKS451');
    const inboundTrue = normHeading(0 + FIXTURE_MAG_VAR);
    const c = headingToVec(inboundTrue);
    const right = { x: c.y, y: -c.x };
    const v = headingToVec(inboundTrue);
    ac.pos = { x: TVO.x - v.x * nmToM(8), y: TVO.y - v.y * nmToM(8) };
    ac.headingDeg = inboundTrue;
    ac.trackDeg = inboundTrue;
    ac.airspeedKt = 170;
    ac.groundSpeedKt = 170;
    ac.target.speedKt = 170;
    say(e, holdCmd(hold({ inboundCourseDeg: 0, turns: 'right', legMinutes: 1 })), 'APP');
    const crab: number[] = [];
    const crossings: number[] = [];
    let prevAlong = -8;
    for (let i = 0; i < 12000; i++) {
      e.step();
      const t = e.getState().clock.timeSec;
      const rel = { x: ac.pos.x - TVO.x, y: ac.pos.y - TVO.y };
      const along = mToNm(rel.x * c.x + rel.y * c.y);
      const cross = mToNm(rel.x * right.x + rel.y * right.y);
      // on the way in: the nose is crabbed into the wind while the TRACK stays on the course
      if (t > 20 && t < 140) {
        expect(Math.abs(cross)).toBeLessThan(0.1);
        crab.push(headingDiff(ac.trackDeg, ac.headingDeg));
      }
      // every later pass over the fix inbound is on the course despite the wind pushing the racetrack off it
      if (t > 300 && prevAlong < 0 && along >= 0 && Math.abs(headingDiff(ac.trackDeg, inboundTrue)) < 25) crossings.push(cross);
      prevAlong = along;
    }
    const median = [...crab].sort((a, b) => a - b)[Math.floor(crab.length / 2)];
    expect(median).toBeGreaterThan(8); // wind from the east pushes west: nose east of the track (asin(29/170) = 9.8 deg)
    expect(median).toBeLessThan(12);
    expect(crossings.length).toBeGreaterThanOrEqual(2);
    for (const x of crossings) expect(Math.abs(x)).toBeLessThan(0.3);
  });
});
