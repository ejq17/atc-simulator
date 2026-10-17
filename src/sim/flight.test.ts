import { describe, expect, it } from 'vitest';
import type { Aircraft, FlightPhase, ScenarioAircraftSpawn } from './types';
import { ARRIVING, cmd, find, HOLDING, makeEngine, run, runUntil } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { dist, headingDiff, ktToMps, mToNm } from './geo';
import { alongCross, findRunwayEnd } from './runways';
import { getPerformance } from './performance';

const airport = createTestAirport();

const AIRBORNE_DEP = (callsign: string, type = 'A320'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type, flightRules: 'IFR',
  start: { kind: 'airborne', pos: { x: 0, y: -18000 }, altitudeFt: 2000, headingDeg: 0, speedKt: type === 'A320' ? 190 : 90, runwayEnd: '13' },
  isDeparture: true, initialFrequencyId: 'TWR',
});

describe('takeoff', () => {
  it('HOLDING_SHORT -> LINE_UP -> roll -> airborne, monotonic speed/altitude, no position jumps', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N723EJ', 'H13', '13')] } });
    const ac = find(e, 'N723EJ');
    expect(ac.phase).toBe('HOLDING_SHORT');
    const phaseLog = () => ['HOLDING_SHORT', ...e.getState().events.filter((x) => x.kind === 'PHASE_CHANGE' && x.aircraftId === ac.id).map((x) => (x.data as { to: string }).to)];
    run(e, 5);
    // Cannot take off without a clearance: stays put.
    run(e, 20);
    expect(ac.phase).toBe('HOLDING_SHORT');
    expect(ac.groundSpeedKt).toBe(0);

    expect(e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N723EJ', { runwayEnd: '13' })).status).toBe('accepted');
    expect(ac.phase).toBe('LINE_UP_AND_WAIT');
    expect(runUntil(e, () => !!ac.route === false && ac.groundSpeedKt === 0 && ac.occupyingRunways.includes('13/31'), 60)).toBe(true);
    // lined up, aligned with the runway, and waiting
    const g = findRunwayEnd(airport, '13')!;
    expect(Math.abs(headingDiff(ac.headingDeg, g.headingDeg))).toBeLessThan(1);
    run(e, 5);
    expect(ac.phase).toBe('LINE_UP_AND_WAIT');
    expect(ac.groundSpeedKt).toBe(0);

    expect(e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' })).status).toBe('accepted');
    expect(ac.phase).toBe('CLEARED_FOR_TAKEOFF');
    const dt = e.getState().clock.dtSec;
    let prevPos = { ...ac.pos };
    let prevSpeed = ac.airspeedKt;
    let prevAlt = ac.altitudeFt;
    for (let i = 0; i < 1000; i++) {
      e.step();
      const d = dist(prevPos, ac.pos);
      expect(d).toBeLessThanOrEqual(ktToMps(Math.max(ac.groundSpeedKt, 1)) * dt * 2 + 1e-6);
      expect(ac.airspeedKt).toBeGreaterThanOrEqual(prevSpeed - 1e-9);
      expect(ac.altitudeFt).toBeGreaterThanOrEqual(prevAlt - 1e-9);
      prevPos = { ...ac.pos };
      prevSpeed = ac.airspeedKt;
      prevAlt = ac.altitudeFt;
    }
    expect(phaseLog()).toEqual(['HOLDING_SHORT', 'LINE_UP_AND_WAIT', 'CLEARED_FOR_TAKEOFF', 'TAKEOFF_ROLL', 'INITIAL_CLIMB', 'DEPARTURE']);
    expect(ac.onGround).toBe(false);
    expect(ac.altitudeFt).toBeGreaterThan(700);
    expect(ac.airspeedKt).toBeCloseTo(75, 0);
    // stays on the runway heading while departing
    expect(Math.abs(headingDiff(ac.trackDeg, g.headingDeg))).toBeLessThan(1);
    expect(e.getState().conflicts).toHaveLength(0);
  });

  it('TAKEOFF straight from HOLDING_SHORT lines up and departs without stopping', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N723EJ', 'H13', '13')] } });
    const ac = find(e, 'N723EJ');
    run(e, 3);
    expect(e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' })).status).toBe('accepted');
    expect(runUntil(e, () => !ac.onGround, 120)).toBe(true);
    expect(ac.phase).toBe('INITIAL_CLIMB');
    const g = findRunwayEnd(airport, '13')!;
    // liftoff happened on the runway, past the entry point and before the far end
    const { along } = alongCross(g, ac.pos);
    expect(along).toBeGreaterThan(100);
    expect(along).toBeLessThan(g.lengthM);
  });

  it('the A320 needs far more runway: rolls ~1.1-1.5 km and lifts at 140 kt; refused from an intersection of runway 22 with < 5,000 ft left, accepted from the full length', () => {
    // C_h422N is the intersection of taxiway C with 4/22: 4,668 ft remain from there for a departure on 22; H22 is the full length.
    const e = makeEngine({ scenario: { spawns: [HOLDING('NKS452', 'C_h422N', '22', 'A320'), HOLDING('NKS453', 'H22', '22', 'A320')] } });
    run(e, 3);
    const bad = e.applyCommand(cmd('TAKEOFF', 'NKS452', { runwayEnd: '22' }));
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') expect(bad.reason).toMatch(/Only \d+ ft of runway 22 remain.*needs about 5000 ft/);
    const full = e.applyCommand(cmd('TAKEOFF', 'NKS453', { runwayEnd: '22' }));
    expect(full.status).toBe('accepted');
    const ac = find(e, 'NKS453');
    const g22 = findRunwayEnd(airport, '22')!;
    let startAlong = 0;
    let lift = 0;
    expect(
      runUntil(e, () => {
        if (ac.phase === 'TAKEOFF_ROLL' && startAlong === 0) startAlong = alongCross(g22, ac.pos).along;
        if (!ac.onGround && lift === 0) lift = alongCross(g22, ac.pos).along;
        return !ac.onGround;
      }, 200),
    ).toBe(true);
    expect(ac.airspeedKt).toBeGreaterThanOrEqual(140);
    const rollM = lift - startAlong;
    expect(rollM).toBeGreaterThan(1100);
    expect(rollM).toBeLessThan(1500);
    run(e, 120);
    expect(ac.altitudeFt).toBeGreaterThan(2500);
    expect(ac.airspeedKt).toBeLessThanOrEqual(getPerformance('A320').maxSpeedKt);
  });

  it('refuses TAKEOFF for aircraft that are not at the runway', () => {
    const e = makeEngine({ scenario: { spawns: [{ ...HOLDING('N1', 'H13', '13'), start: { kind: 'parked', parkingId: 'GA1' } }] } });
    run(e, 3);
    const r = e.applyCommand(cmd('TAKEOFF', 'N1', { runwayEnd: '13' }));
    expect(r.status).toBe('rejected');
    expect(find(e, 'N1').phase).not.toBe('CLEARED_FOR_TAKEOFF');
  });

  it('refuses TAKEOFF for a runway end the aircraft is not lined up for', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N2', 'H13', '13')] } });
    run(e, 3);
    e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N2', { runwayEnd: '13' }));
    run(e, 30);
    const r = e.applyCommand(cmd('TAKEOFF', 'N2', { runwayEnd: '31' }));
    expect(r.status).toBe('rejected');
  });
});

describe('airborne control', () => {
  it('HEADING converges using a bank-limited turn (never faster than the turn rate)', () => {
    const e = makeEngine({ scenario: { spawns: [AIRBORNE_DEP('NKS451')] } });
    const ac = find(e, 'NKS451');
    run(e, 2);
    // magnetic 090 -> true 078 with 12W variation
    const out = e.applyCommand(cmd('HEADING', 'NKS451', { headingDeg: 90 }));
    expect(out.status).toBe('accepted');
    const rate = getPerformance('A320').turnRateDegPerSec;
    let prev = ac.headingDeg;
    let maxRate = 0;
    let t = 0;
    for (let i = 0; i < 1200; i++) {
      e.step();
      const d = Math.abs(headingDiff(prev, ac.headingDeg)) / e.getState().clock.dtSec;
      maxRate = Math.max(maxRate, d);
      prev = ac.headingDeg;
      if (Math.abs(headingDiff(ac.headingDeg, 78)) < 0.5 && t === 0) t = e.getState().clock.timeSec;
    }
    expect(maxRate).toBeLessThanOrEqual(rate + 1e-6);
    expect(maxRate).toBeGreaterThan(rate * 0.9);
    expect(t).toBeGreaterThan(0);
    expect(Math.abs(headingDiff(ac.headingDeg, 78))).toBeLessThan(0.5);
    // 78 deg of turn at 2.5 deg/s takes at least ~31 s
    expect(t).toBeGreaterThan(30);
  });

  it('honours the turn direction even when it is the long way round', () => {
    const e = makeEngine({ scenario: { spawns: [AIRBORNE_DEP('NKS451')] } });
    const ac = find(e, 'NKS451');
    e.applyCommand(cmd('HEADING', 'NKS451', { headingDeg: 30, turnDirection: 'left' }));
    let sawLeftOf = false;
    for (let i = 0; i < 600; i++) {
      e.step();
      if (ac.headingDeg > 200 && ac.headingDeg < 300) sawLeftOf = true; // going left from 0 passes through 270
    }
    expect(sawLeftOf).toBe(true);
  });

  it('ALTITUDE converges within climb/descent rate limits; rejects above the service ceiling', () => {
    const e = makeEngine({ scenario: { spawns: [AIRBORNE_DEP('NKS451'), AIRBORNE_DEP('N723EJ', 'C172')] } });
    const a = find(e, 'NKS451');
    const c = find(e, 'N723EJ');
    e.applyCommand(cmd('ALTITUDE', 'NKS451', { altitudeFt: 6000 }));
    e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3500 }));
    let maxA = 0;
    let maxC = 0;
    let prevA = a.altitudeFt;
    let prevC = c.altitudeFt;
    for (let i = 0; i < 2400; i++) {
      e.step();
      maxA = Math.max(maxA, (a.altitudeFt - prevA) * 600);
      maxC = Math.max(maxC, (c.altitudeFt - prevC) * 600);
      prevA = a.altitudeFt;
      prevC = c.altitudeFt;
    }
    expect(a.altitudeFt).toBe(6000);
    expect(c.altitudeFt).toBe(3500);
    expect(maxA).toBeLessThanOrEqual(getPerformance('A320').climbRateFpm + 1);
    expect(maxC).toBeLessThanOrEqual(getPerformance('C172').climbRateFpm + 1);
    expect(maxC).toBeGreaterThan(500);
    const bad = e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 25000 }));
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') expect(bad.reason).toMatch(/service ceiling/);
    const descend = e.applyCommand(cmd('ALTITUDE', 'NKS451', { altitudeFt: 3000 }));
    expect(descend.status).toBe('accepted');
    if (descend.status === 'accepted') expect(descend.readback).toBe('Descend and maintain three thousand, Spirit four fifty one');
    run(e, 150);
    expect(a.altitudeFt).toBe(3000);
  });

  it('SPEED converges and respects min/max limits', () => {
    const e = makeEngine({ scenario: { spawns: [AIRBORNE_DEP('NKS451')] } });
    const a = find(e, 'NKS451');
    expect(e.applyCommand(cmd('SPEED', 'NKS451', { speedKt: 160 })).status).toBe('accepted');
    run(e, 60);
    expect(a.airspeedKt).toBeCloseTo(160, 0);
    expect(e.applyCommand(cmd('SPEED', 'NKS451', { speedKt: 90 })).status).toBe('rejected'); // below A320 minimum
    expect(e.applyCommand(cmd('SPEED', 'NKS451', { speedKt: 300 })).status).toBe('rejected'); // > 250 below 10,000 ft
    expect(e.applyCommand(cmd('HEADING', 'NKS451', { headingDeg: 400 })).status).toBe('rejected');
  });

  it('wind changes ground track and ground speed but not airspeed', () => {
    const windy = {
      source: 'simulated' as const, windDirDeg: 270, windSpeedKt: 30, visibilitySm: 10, clouds: [], temperatureC: 15, dewpointC: 5,
      altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR' as const,
    };
    const e = makeEngine({ scenario: { weather: windy, spawns: [{ ...AIRBORNE_DEP('N723EJ', 'C172') }] } });
    const ac = find(e, 'N723EJ');
    e.applyCommand(cmd('HEADING', 'N723EJ', { headingDeg: 102 })); // true 090 (east), wind from the west = tailwind
    run(e, 60);
    expect(ac.airspeedKt).toBeLessThan(100);
    expect(ac.groundSpeedKt).toBeGreaterThan(ac.airspeedKt + 25);
    e.applyCommand(cmd('HEADING', 'N723EJ', { headingDeg: 192 })); // true 180 (south), wind from the west = crosswind
    run(e, 90);
    // heading south, wind from the west pushes the aircraft east: track is east of (smaller than) the heading
    expect(Math.abs(headingDiff(ac.headingDeg, 180))).toBeLessThan(1); // magnetic 192 with 12 W variation = true 180
    expect(headingDiff(ac.headingDeg, ac.trackDeg)).toBeLessThan(-10);
  });
});

function landingStats(e: ReturnType<typeof makeEngine>, ac: Aircraft, endId: string) {
  const g = findRunwayEnd(airport, endId)!;
  let td: { along: number; cross: number; speed: number } | undefined;
  let maxCrossFinal = 0;
  let exitHold: string | undefined;
  for (let i = 0; i < 9000; i++) {
    e.step();
    if (ac.phase === 'FINAL' || ac.phase === 'LANDING') {
      const { along, cross } = alongCross(g, ac.pos);
      if (along < -1852 / 2 && along > -2000) maxCrossFinal = Math.max(maxCrossFinal, Math.abs(cross));
    }
    if (!td && ac.onGround) {
      const { along, cross } = alongCross(g, ac.pos);
      td = { along, cross, speed: ac.groundSpeedKt };
    }
    if (ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt === 0 && ac.route) {
      exitHold = ac.route.nodeIds[ac.route.nodeIds.length - 1];
      break;
    }
  }
  return { td, maxCrossFinal, exitHold };
}

describe('landing', () => {
  it('LAND clearance leads to touchdown on the correct runway end, rollout and runway exit', () => {
    const e = makeEngine({ scenario: { spawns: [ARRIVING('N723EJ', '13', 5)] } });
    const ac = find(e, 'N723EJ');
    expect(['APPROACH', 'FINAL']).toContain(ac.phase);
    expect(runUntil(e, () => !!ac.pendingRequest, 10)).toBe(true);
    expect(ac.pendingRequest?.kind).toBe('LANDING');
    expect(e.getState().events.find((x) => x.speaker === 'PILOT')?.text).toBe(
      'Atlantic City Tower, Cessna seven two three echo juliet, five miles northwest, inbound for landing with information alpha.',
    );
    const out = e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }));
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Runway one three, cleared to land, Cessna seven two three echo juliet');
    const phases: FlightPhase[] = [];
    const stats = (() => {
      const g = findRunwayEnd(airport, '13')!;
      let td: { along: number; cross: number } | undefined;
      for (let i = 0; i < 9000; i++) {
        e.step();
        if (phases[phases.length - 1] !== ac.phase) phases.push(ac.phase);
        if (!td && ac.onGround) td = alongCross(g, ac.pos);
        if (ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt === 0) break;
      }
      return td;
    })();
    expect(phases.slice(-4)).toEqual(['FINAL', 'LANDING', 'ROLLOUT', 'RUNWAY_EXIT']);
    expect(stats).toBeDefined();
    expect(stats!.along).toBeGreaterThan(150);
    expect(stats!.along).toBeLessThan(700);
    expect(Math.abs(stats!.cross)).toBeLessThan(15);
    expect(ac.onGround).toBe(true);
    expect(ac.groundSpeedKt).toBe(0);
    // clear of the runway: stopped on a holding position node
    const hold = airport.taxiwayGraph.nodes[ac.route!.nodeIds.at(-1)!];
    expect(hold.kind).toBe('holding_position');
    expect(dist(ac.pos, hold.pos)).toBeLessThan(0.5);
    expect(ac.occupyingRunways).toEqual([]);
    run(e, 5);
    expect(e.getState().events.some((x) => x.speaker === 'PILOT' && /clear of runway one three at alpha/.test(x.text))).toBe(true);
    expect(ac.pendingRequest?.kind).toBe('FREQUENCY_CHANGE');
    expect(ac.runwayAuthorizations).toEqual([]);
    expect(e.getState().conflicts).toHaveLength(0);
  });

  it('lands on runway 31 and 4/22 ends symmetrically', () => {
    for (const [end, hdgExpected] of [['31', 298], ['22', 208], ['4', 28]] as const) {
      const e = makeEngine({ scenario: { spawns: [ARRIVING('N723EJ', end, 5)] } });
      const ac = find(e, 'N723EJ');
      run(e, 5);
      e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: end }));
      const s = landingStats(e, ac, end);
      expect(s.td).toBeDefined();
      expect(s.td!.along).toBeGreaterThan(150);
      expect(s.td!.along).toBeLessThan(700);
      expect(Math.abs(s.td!.cross)).toBeLessThan(15);
      expect(Math.abs(headingDiff(ac.headingDeg, hdgExpected))).toBeLessThan(95); // after exit it has turned
      expect(ac.phase).toBe('RUNWAY_EXIT');
    }
  });

  it('the A320 uses a later exit than the C172 (needs more roll distance)', () => {
    const cE = makeEngine({ scenario: { spawns: [ARRIVING('N723EJ', '13', 5)] } });
    const cAc = find(cE, 'N723EJ');
    run(cE, 5);
    cE.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }));
    const c = landingStats(cE, cAc, '13');
    const aE = makeEngine({ scenario: { spawns: [ARRIVING('NKS451', '13', 9, 'A320')] } });
    const aAc = find(aE, 'NKS451');
    run(aE, 5);
    aE.applyCommand(cmd('LAND', 'NKS451', { runwayEnd: '13' }));
    const a = landingStats(aE, aAc, '13');
    expect(c.exitHold).toBeDefined();
    expect(a.exitHold).toBeDefined();
    const g = findRunwayEnd(airport, '13')!;
    const alongOf = (id: string) => alongCross(g, airport.taxiwayGraph.nodes[id].pos).along;
    expect(alongOf(a.exitHold!)).toBeGreaterThan(alongOf(c.exitHold!));
    // A320 touchdown speed ~130 kt, C172 ~55 kt
    expect(a.td!.speed).toBeGreaterThan(110);
    expect(c.td!.speed).toBeLessThan(70);
    expect(a.td!.along).toBeGreaterThan(150);
    expect(a.td!.along).toBeLessThan(900);
  });

  it('tracks the centreline in a crosswind', () => {
    const windy = {
      source: 'simulated' as const, windDirDeg: 40, windSpeedKt: 15, visibilitySm: 10, clouds: [], temperatureC: 15, dewpointC: 5,
      altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR' as const,
    };
    const e = makeEngine({ scenario: { weather: windy, spawns: [ARRIVING('N723EJ', '13', 5)] } });
    const ac = find(e, 'N723EJ');
    run(e, 5);
    e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }));
    const s = landingStats(e, ac, '13');
    expect(s.maxCrossFinal).toBeLessThan(40);
    expect(Math.abs(s.td!.cross)).toBeLessThan(25);
    expect(ac.phase).toBe('RUNWAY_EXIT');
  });

  it('intercepts the final approach course from an offset position', () => {
    const spawn: ScenarioAircraftSpawn = {
      atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR',
      start: { kind: 'airborne', pos: { x: 6000, y: 12000 }, altitudeFt: 3500, headingDeg: 215, speedKt: 190, runwayEnd: '13' },
      isDeparture: false, initialFrequencyId: 'TWR',
    };
    const e = makeEngine({ scenario: { spawns: [spawn] } });
    const ac = find(e, 'NKS451');
    run(e, 1);
    e.applyCommand(cmd('LAND', 'NKS451', { runwayEnd: '13' }));
    const s = landingStats(e, ac, '13');
    expect(s.td).toBeDefined();
    expect(Math.abs(s.td!.cross)).toBeLessThan(25);
    expect(s.td!.along).toBeGreaterThan(100);
    expect(s.td!.along).toBeLessThan(900);
  });
});

describe('go-around', () => {
  it('goes around automatically (and announces it) without a landing clearance at ~0.5 nm / 200 ft AGL', () => {
    const e = makeEngine({ scenario: { spawns: [ARRIVING('N723EJ', '13', 5)] } });
    const ac = find(e, 'N723EJ');
    const g = findRunwayEnd(airport, '13')!;
    let atGoAround: { dNm: number; agl: number } | undefined;
    expect(
      runUntil(e, () => {
        if (ac.phase === 'GO_AROUND' && !atGoAround) {
          atGoAround = { dNm: mToNm(-alongCross(g, ac.pos).along), agl: ac.altitudeFt - airport.elevationFt };
        }
        return ac.phase === 'GO_AROUND';
      }, 400),
    ).toBe(true);
    expect(atGoAround!.dNm).toBeGreaterThan(0.4);
    expect(atGoAround!.dNm).toBeLessThan(0.6);
    expect(atGoAround!.agl).toBeGreaterThan(150);
    expect(atGoAround!.agl).toBeLessThan(260);
    const say2 = () => e.getState().events.some((x) => x.speaker === 'PILOT' && /runway heading, level one thousand six hundred, request another approach/.test(x.text));
    const say = e.getState().events.filter((x) => x.speaker === 'PILOT').map((x) => x.text);
    expect(say.some((t) => /going around runway one three, no landing clearance/.test(t))).toBe(true);
    expect(e.getState().events.some((x) => x.kind === 'GO_AROUND')).toBe(true);
    expect(ac.onGround).toBe(false);
    run(e, 200);
    expect(ac.onGround).toBe(false);
    expect(ac.altitudeFt).toBeGreaterThan(airport.elevationFt + 1000);
    expect(ac.phase).toBe('GO_AROUND');
    expect(say2()).toBe(true);
    // climbing out on the runway heading
    expect(Math.abs(headingDiff(ac.trackDeg, g.headingDeg))).toBeLessThan(3);
  });

  it('GO_AROUND command works on final', () => {
    const e = makeEngine({ scenario: { spawns: [ARRIVING('NKS451', '13', 6, 'A320')] } });
    const ac = find(e, 'NKS451');
    e.applyCommand(cmd('LAND', 'NKS451', { runwayEnd: '13' }));
    expect(runUntil(e, () => ac.phase === 'FINAL', 120)).toBe(true);
    run(e, 20);
    const out = e.applyCommand(cmd('GO_AROUND', 'NKS451'));
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Going around, Spirit four fifty one');
    expect(ac.phase).toBe('GO_AROUND');
    expect(ac.runwayAuthorizations).toEqual([]);
    const alt0 = ac.altitudeFt;
    run(e, 60);
    expect(ac.altitudeFt).toBeGreaterThan(alt0 + 500);
    expect(ac.onGround).toBe(false);
    // and a fresh landing clearance resumes the approach
    expect(e.applyCommand(cmd('LAND', 'NKS451', { runwayEnd: '13' })).status).toBe('accepted');
    expect(ac.phase).toBe('APPROACH');
  });

  it('goes around when the runway is occupied at the decision point even if cleared', () => {
    const e = makeEngine({
      scenario: { mode: 'free_play', spawns: [ARRIVING('N723EJ', '13', 4), HOLDING('N9XX', 'H13', '13')] },
    });
    const ac = find(e, 'N723EJ');
    run(e, 3);
    // Put another aircraft in position (line up and wait) in free play: unsafe but allowed.
    e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N9XX', { runwayEnd: '13' }));
    run(e, 30);
    const r = e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }));
    expect(r.status).toBe('accepted'); // flagged unsafe, executed
    expect(runUntil(e, () => ac.phase === 'GO_AROUND', 400)).toBe(true);
    expect(e.getState().events.some((x) => x.speaker === 'PILOT' && /traffic on the runway/.test(x.text))).toBe(true);
  });
});

describe('traffic pattern and all runway ends', () => {
  for (const [patternLeg, pos] of [['left_downwind', 'left'], ['right_downwind', 'right']] as const) {
    it(`flies a ${pos} pattern: downwind, base, final, landing`, () => {
      const g = findRunwayEnd(airport, '13')!;
      // abeam the threshold on the downwind side, heading downwind
      const offset = (pos === 'left' ? -1 : 1) * 1482;
      const start = { x: g.end.threshold.x + g.dir.x * 600 + g.right.x * offset, y: g.end.threshold.y + g.dir.y * 600 + g.right.y * offset };
      const spawn: ScenarioAircraftSpawn = {
        atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
        start: { kind: 'airborne', pos: start, altitudeFt: 1100, headingDeg: (g.headingDeg + 180) % 360, speedKt: 80, runwayEnd: '13' },
      };
      const e = makeEngine({ scenario: { spawns: [spawn] } });
      const ac = find(e, 'N723EJ');
      run(e, 1);
      expect(e.applyCommand(cmd('ENTER_PATTERN', 'N723EJ', { runwayEnd: '13', patternLeg })).status).toBe('accepted');
      expect(ac.phase).toBe('PATTERN');
      const phases = new Set<string>();
      let maxCross = 0;
      let cleared = false;
      for (let i = 0; i < 9000 && !(ac.onGround && ac.groundSpeedKt === 0); i++) {
        e.step();
        phases.add(ac.phase);
        if (ac.phase === 'FINAL' && !cleared) {
          cleared = true;
          e.applyCommand(cmd('LAND', 'N723EJ', { runwayEnd: '13' }));
        }
        if (ac.phase === 'LANDING') maxCross = Math.max(maxCross, Math.abs(alongCross(g, ac.pos).cross));
        if (ac.phase === 'RUNWAY_EXIT') break;
      }
      expect(phases.has('FINAL')).toBe(true);
      expect(phases.has('GO_AROUND')).toBe(false);
      expect(phases.has('ROLLOUT')).toBe(true);
      expect(maxCross).toBeLessThan(60);
    });
  }
});

describe('every runway end works for takeoff', () => {
  const cases: [string, string, number][] = [['H13', '13', 118], ['H31', '31', 298], ['H4', '4', 28], ['H22', '22', 208]];
  for (const [node, end, hdg] of cases) {
    it(`departs runway ${end}`, () => {
      const e = makeEngine({ scenario: { spawns: [HOLDING('N723EJ', node, end)] } });
      const ac = find(e, 'N723EJ');
      run(e, 3);
      expect(e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: end })).status).toBe('accepted');
      expect(runUntil(e, () => ac.phase === 'DEPARTURE', 120)).toBe(true);
      expect(Math.abs(headingDiff(ac.trackDeg, hdg))).toBeLessThan(1);
      const g = findRunwayEnd(airport, end)!;
      const { cross } = alongCross(g, ac.pos);
      expect(Math.abs(cross)).toBeLessThan(5);
    });
  }
});
