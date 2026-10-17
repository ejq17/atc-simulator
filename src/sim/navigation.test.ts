import { describe, expect, it } from 'vitest';
import { AT_FIX, ARRIVING, cmd, find, ifrScenario, makeEngine, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import { createTestAirport, FIXTURE_MAG_VAR } from './__fixtures__/testAirport';
import { bearingToFixMag, bearingToFixTrue, distanceToFixNm, findNavFix, turnLeadM } from './navigation';
import { getPerformance } from './performance';
import { bearingDeg, dist, headingDiff, ktToMps, mToNm, nmToM, trueToMagnetic } from './geo';

const airport = createTestAirport();
const ROUTE = ['TARR', 'FX13A', 'FX13B'];
const spawnAt = (over = {}, alt = 5000, speed = 210, route = ROUTE) => ifrScenario([AT_FIX('NKS451', route[0], route, '13', over, alt, speed)]);

describe('fix lookup and navigation helpers', () => {
  it('resolves fixes by identifier and by navaid name, and ignores ILS/LOC/DME components', () => {
    expect(findNavFix(airport, 'tvo')?.id).toBe('TVO');
    expect(findNavFix(airport, 'Testville')?.id).toBe('TVO');
    expect(findNavFix(airport, 'TEST SEA VOR')?.id).toBe('TSE');
    expect(findNavFix(airport, 'NOPE')).toBeUndefined();
  });

  it('distanceToFixNm / bearingToFixMag use the local frame and the magnetic variation', () => {
    const tvo = findNavFix(airport, 'TVO')!;
    const from = { x: 0, y: 0 };
    expect(distanceToFixNm(airport, from, 'TVO')).toBeCloseTo(mToNm(dist(from, tvo.pos)), 6);
    const brgTrue = bearingDeg(from, tvo.pos);
    expect(bearingToFixTrue(airport, from, 'TVO')).toBeCloseTo(brgTrue, 6);
    expect(bearingToFixMag(airport, from, 'TVO')).toBeCloseTo(trueToMagnetic(brgTrue, FIXTURE_MAG_VAR), 6);
    // west variation: magnetic = true + 12
    expect(headingDiff(brgTrue + 12, bearingToFixMag(airport, from, 'TVO')!)).toBeCloseTo(0, 6);
    expect(distanceToFixNm(airport, from, 'NOPE')).toBeUndefined();
  });

  it('turn anticipation: at least 0.3 nm, grows with the turn angle and with speed', () => {
    const perf = getPerformance('A320');
    const slow = { airspeedKt: 120 };
    const fast = { airspeedKt: 250 };
    expect(turnLeadM(fast, perf, 0)).toBeCloseTo(nmToM(0.3), 6);
    expect(turnLeadM(fast, perf, 10)).toBeGreaterThanOrEqual(nmToM(0.3));
    expect(turnLeadM(fast, perf, 90)).toBeGreaterThan(turnLeadM(fast, perf, 45));
    expect(turnLeadM(fast, perf, 90)).toBeGreaterThan(turnLeadM(slow, perf, 90));
    // R = V / omega: 250 kt at 2.5 deg/s -> about 2.9 km; a 90 degree turn starts one radius out
    expect(turnLeadM(fast, perf, 90)).toBeGreaterThan(2800);
    expect(turnLeadM(fast, perf, 90)).toBeLessThan(3000);
  });
});

describe('arrival spawned at a fix', () => {
  it('starts over the fix, pointed at the next fix, INBOUND on Approach with a flight plan and a squawk', () => {
    const e = makeEngine({ scenario: spawnAt() });
    const ac = find(e, 'NKS451');
    const tarr = findNavFix(airport, 'TARR')!;
    expect(ac.pos).toEqual(tarr.pos);
    expect(ac.phase).toBe('INBOUND');
    expect(ac.onGround).toBe(false);
    expect(ac.frequencyId).toBe('APP');
    expect(ac.frequencyMhz).toBe(124.6);
    expect(ac.altitudeFt).toBe(5000);
    expect(ac.airspeedKt).toBe(210);
    expect(headingDiff(ac.headingDeg, bearingDeg(ac.pos, findNavFix(airport, 'FX13A')!.pos))).toBeCloseTo(0, 6);
    expect(ac.nav).toEqual({ fixes: ROUTE, index: 1, mode: 'route' });
    expect(ac.flightPlan).toMatchObject({ flightRules: 'IFR', destination: 'KTST', route: ROUTE, cruiseAltitudeFt: 5000 });
    expect(ac.squawk).toMatch(/^[0-7]{4}$/);
    expect(['0000', '1200', '7500', '7600', '7700']).not.toContain(ac.squawk);
    expect(ac.radarIdentified).toBe(false);
    expect(ac.assignedRunwayEnd).toBe('13');
  });

  it('uses the flight plan of the spec, and prepends the spawn fix when the route does not start with it', () => {
    const fp = { flightRules: 'IFR' as const, origin: 'KPHL', destination: 'KTST', cruiseAltitudeFt: 11000, route: ['FX13A', 'FX13B'], squawk: '4321' };
    const spec = { ...AT_FIX('NKS451', 'TARR', ['FX13A', 'FX13B']), flightPlan: fp };
    const e = makeEngine({ scenario: ifrScenario([spec]) });
    const ac = find(e, 'NKS451');
    expect(ac.nav).toEqual({ fixes: ['TARR', 'FX13A', 'FX13B'], index: 1, mode: 'route' });
    expect(ac.flightPlan).toMatchObject({ origin: 'KPHL', cruiseAltitudeFt: 11000, squawk: '4321' });
    expect(ac.squawk).toBe('4321');
    expect(ac.origin).toBe('KPHL');
  });

  it('rejects an unknown spawn fix', () => {
    expect(() => makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'NOWHERE', ['NOWHERE', 'FX13A'])]) })).toThrow(/Unknown fix/);
  });

  it('checks in with Approach: callsign, altitude, ATIS information, pending request APPROACH', () => {
    const e = makeEngine({ scenario: spawnAt() });
    const ac = find(e, 'NKS451');
    expect(runUntil(e, () => ac.pendingRequest?.kind === 'APPROACH', 10)).toBe(true);
    expect(pilotTexts(e)).toEqual(['Atlantic City Approach, Spirit four fifty one, level five thousand, information alpha.']);
    expect(ac.pendingRequest?.text).toMatch(/checking in/);
    // no standard "inbound for landing" call on top of the check-in
    run(e, 30);
    expect(pilotTexts(e)).toHaveLength(1);
  });

  it('only hears its own frequency: Tower cannot talk to an aircraft on Approach', () => {
    const e = makeEngine({ scenario: spawnAt() });
    const r = say(e, cmd('HEADING', 'NKS451', { headingDeg: 100 }), 'TWR');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toMatch(/Not on frequency/);
    expect(say(e, cmd('HEADING', 'NKS451', { headingDeg: 100 }), 'APP').status).toBe('accepted');
  });
});

describe('flying a route of fixes', () => {
  it('passes every fix in order within 0.5 nm, no position jumps, then holds the last heading', () => {
    const e = makeEngine({ scenario: spawnAt() });
    const ac = find(e, 'NKS451');
    const dt = e.getState().clock.dtSec;
    const closest: Record<string, number> = { FX13A: Infinity, FX13B: Infinity };
    const order: number[] = [];
    let prev = { ...ac.pos };
    let exhaustedAt = -1;
    for (let i = 0; i < 9000 && exhaustedAt < 0; i++) {
      e.step();
      const step = dist(prev, ac.pos);
      expect(step).toBeLessThanOrEqual(ktToMps(Math.max(ac.groundSpeedKt, 1)) * dt * 1.05 + 1e-6);
      prev = { ...ac.pos };
      for (const id of Object.keys(closest)) closest[id] = Math.min(closest[id], mToNm(dist(ac.pos, findNavFix(airport, id)!.pos)));
      const idx = ac.nav?.index ?? 3;
      if (order[order.length - 1] !== idx) order.push(idx);
      if (!ac.nav) exhaustedAt = i;
    }
    expect(exhaustedAt).toBeGreaterThan(0);
    expect(order).toEqual([1, 2, 3]); // sequenced one fix at a time, in order
    expect(closest.FX13A).toBeLessThan(0.5);
    expect(closest.FX13B).toBeLessThan(0.5);
    // route exhausted: holds the last heading (the course leg FX13A -> FX13B is the runway heading)
    const hdg = ac.headingDeg;
    run(e, 30);
    expect(Math.abs(headingDiff(ac.headingDeg, hdg))).toBeLessThan(0.5);
    expect(e.getState().events.some((x) => /reached the end of its route/.test(x.text))).toBe(true);
  });

  it('turns toward the fix with a bank-limited turn rate (no instant heading changes)', () => {
    const e = makeEngine({ scenario: spawnAt({}, 5000, 210, ['TARR', 'TVO', 'FX13B']) });
    const ac = find(e, 'NKS451');
    const rate = getPerformance('A320').turnRateDegPerSec;
    let prev = ac.headingDeg;
    for (let i = 0; i < 6000; i++) {
      e.step();
      expect(Math.abs(headingDiff(prev, ac.headingDeg))).toBeLessThanOrEqual(rate * e.getState().clock.dtSec + 1e-6);
      prev = ac.headingDeg;
    }
  });

  it('is deterministic: identical state after the same run', () => {
    const run1 = () => {
      const e = makeEngine({ scenario: spawnAt(), opts: { readbackErrorRate: 0.08 } });
      run(e, 300);
      const s = e.getState();
      return JSON.stringify({ a: s.aircraft, ev: s.events.map((x) => x.text) });
    };
    expect(run1()).toBe(run1());
  });
});

describe('vectors, DIRECT_FIX and RESUME_OWN_NAVIGATION', () => {
  it('HEADING suspends the route (kept), DIRECT_FIX re-engages it at a fix, RESUME returns to the route', () => {
    const e = makeEngine({ scenario: spawnAt() });
    const ac = find(e, 'NKS451');
    run(e, 5);
    const hdg = say(e, cmd('HEADING', 'NKS451', { headingDeg: 150 }), 'APP');
    expect(hdg.status).toBe('accepted');
    expect(ac.nav).toEqual({ fixes: ROUTE, index: 1, mode: 'vectors' });
    run(e, 60);
    // true heading = magnetic - 12 deg (west variation): 150 magnetic -> 138 true
    expect(Math.abs(headingDiff(ac.headingDeg, 138))).toBeLessThan(0.5);
    expect(ac.nav?.mode).toBe('vectors');

    const direct = say(e, cmd('DIRECT_FIX', 'NKS451', { fix: 'FX13B' }), 'APP');
    expect(direct.status).toBe('accepted');
    if (direct.status === 'accepted') {
      expect(direct.readback).toBe('Direct FX13B, Spirit four fifty one');
      expect(direct.clearance.fix).toBe('FX13B');
    }
    expect(ac.nav).toEqual({ fixes: ROUTE, index: 2, mode: 'direct' }); // FX13B is on the route: the route is kept
    run(e, 20);
    const want = bearingDeg(ac.pos, findNavFix(airport, 'FX13B')!.pos);
    expect(Math.abs(headingDiff(ac.headingDeg, want))).toBeLessThan(3);

    // vectors again, then resume
    expect(say(e, cmd('HEADING', 'NKS451', { headingDeg: 200 }), 'APP').status).toBe('accepted');
    expect(ac.nav?.mode).toBe('vectors');
    const resume = say(e, cmd('RESUME_OWN_NAVIGATION', 'NKS451'), 'APP');
    expect(resume.status).toBe('accepted');
    if (resume.status === 'accepted') expect(resume.readback).toBe('Resuming own navigation, Spirit four fifty one');
    expect(ac.nav).toEqual({ fixes: ROUTE, index: 2, mode: 'direct' });
    run(e, 10);
    const w2 = bearingDeg(ac.pos, findNavFix(airport, 'FX13B')!.pos);
    expect(Math.abs(headingDiff(ac.headingDeg, w2))).toBeLessThan(10);
  });

  it('DIRECT_FIX to a fix that is not on the route flies just that fix; the navaid name is spoken back', () => {
    const e = makeEngine({ scenario: spawnAt() });
    const ac = find(e, 'NKS451');
    const r = say(e, cmd('DIRECT_FIX', 'NKS451', { fix: 'Testville' }), 'APP');
    expect(r.status).toBe('accepted');
    if (r.status === 'accepted') {
      expect(r.clearance.fix).toBe('TVO');
      expect(r.readback).toBe('Direct Testville, Spirit four fifty one');
    }
    expect(ac.nav).toEqual({ fixes: ['TVO'], index: 0, mode: 'direct' });
    // a RESUME afterwards returns to the filed route (nearest fix ahead)
    expect(say(e, cmd('RESUME_OWN_NAVIGATION', 'NKS451'), 'APP').status).toBe('accepted');
    expect(ac.nav).toEqual({ fixes: ROUTE, index: 1, mode: 'route' });
  });

  it('rejects an unknown fix, and DIRECT_FIX / RESUME for aircraft that cannot comply', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ROUTE), { ...ARRIVING('N723EJ', '13', 12, 'C172', 'APP') }]) });
    const bad = say(e, cmd('DIRECT_FIX', 'NKS451', { fix: 'NOWHERE' }), 'APP');
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') expect(bad.pilotResponse).toBe("Unable, we don't have that fix, Spirit four fifty one");
    // a VFR arrival without a route has nothing to resume
    const none = say(e, cmd('RESUME_OWN_NAVIGATION', 'N723EJ'), 'APP');
    expect(none.status).toBe('rejected');
    if (none.status === 'rejected') expect(none.reason).toMatch(/no route/);
  });

  it('missing fix entity asks for clarification', () => {
    const e = makeEngine({ scenario: spawnAt() });
    expect(say(e, cmd('DIRECT_FIX', 'NKS451'), 'APP').status).toBe('clarify');
  });

  it('a route fix reached while on vectors is not sequenced (the route waits for RESUME)', () => {
    const e = makeEngine({ scenario: spawnAt() });
    const ac = find(e, 'NKS451');
    say(e, cmd('HEADING', 'NKS451', { headingDeg: 99 }), 'APP'); // magnetic 99 -> true 87: straight at FX13A
    run(e, 400);
    expect(ac.nav?.mode).toBe('vectors');
    expect(ac.nav?.index).toBe(1);
  });
});
