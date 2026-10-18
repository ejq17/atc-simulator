/**
 * Gaps found in a real KACY session (runway 31 for everything, player on Ground, AI on Tower and, with Approach closed, Approach / Departure):
 * a fast departure released behind a slow one (7110.65 3-9-6 / 5-8-3), approach spacing judged at the clearance instead of at the leader's
 * threshold (5-5-4 / 3-10-3), and a go-around re-cleared to land while still climbing out.
 */
import { describe, expect, it } from 'vitest';
import { ftToM, mToNm } from '../sim/geo';
import { alongCross, findRunwayEnd } from '../sim/runways';
import { createEngine } from '../sim/engine';
import { createAiControllers } from './index';
import type { Aircraft, Scenario, ScenarioAircraftSpawn } from '../sim/types';
import { cmd, createHarness, IFR_ARR, kacy } from './testkit';
import type { Harness } from './testkit';
import { assignedEnd, distToThresholdNm } from './world';

const g13 = findRunwayEnd(kacy, '13')!;

/** An airborne departure (placed on the runway 13 centreline extension once the engine exists). */
function leaderDeparture(callsign: string, type: string): ScenarioAircraftSpawn {
  return {
    atSec: 0, callsign, type, flightRules: 'VFR', isDeparture: true, initialFrequencyId: 'TWR',
    start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 500, headingDeg: g13.headingDeg, speedKt: type === 'A320' ? 175 : 80, runwayEnd: '13' },
    flightPlan: { flightRules: 'VFR', origin: 'KACY', destination: 'KILM', cruiseAltitudeFt: 3500, route: [] },
  };
}

function waiting(callsign: string, type: string): ScenarioAircraftSpawn {
  return {
    atSec: 0, callsign, type, flightRules: type === 'A320' ? 'IFR' : 'VFR', isDeparture: true, initialFrequencyId: 'TWR',
    start: { kind: 'holding_short', nodeId: 'HP13-31-B-1', runwayEnd: '13' },
    ...(type === 'A320' ? { flightPlan: { flightRules: 'IFR' as const, origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: ['VCN'] } } : {}),
  };
}

function place(h: Harness, cs: string, alongNm: number): void {
  const ac = h.find(cs)!;
  ac.pos = { x: g13.end.threshold.x + g13.dir.x * ftToM(alongNm * 6076.12), y: g13.end.threshold.y + g13.dir.y * ftToM(alongNm * 6076.12) };
  ac.headingDeg = g13.headingDeg;
  ac.trackDeg = g13.headingDeg;
}

/** Departure behind a departure: leader placed `leaderNm` down the runway extension, follower waiting at the hold, Tower AI only. */
function departures(leaderType: string, followerType: string, leaderNm: number) {
  const h = createHarness({
    player: ['GND'], ai: ['TWR', 'DEP'], mode: 'free_play',
    spawns: [leaderDeparture('LEAD1', leaderType), waiting('FOLL1', followerType)],
  });
  h.run(1);
  place(h, 'LEAD1', leaderNm);
  const takeoffAt = () => h.atc('TWR').find((e) => e.callsign === 'FOLL1' && /cleared for takeoff/.test(e.text))?.timeSec;
  return { h, takeoffAt };
}

describe('departure behind a slower departure on the same track (3-9-6 / 5-8-3)', () => {
  it('A320 behind a C172 2 nm out: Tower withholds the takeoff clearance until the A320 cannot close inside 3 nm', () => {
    const { h, takeoffAt } = departures('C172', 'A320', 2);
    h.run(60);
    expect(takeoffAt()).toBeUndefined();
    expect(h.runUntil(() => takeoffAt() !== undefined, 900)).toBe(true);
    // released only when the C172 was far enough along that the A320 cannot catch it inside 3 nm within 10 nm of the field
    const lead = h.find('LEAD1')!;
    expect(mToNm(alongCross(g13, lead.pos).along)).toBeGreaterThan(5);
    h.run(400);
    expect(h.events.filter((e) => e.kind === 'CONFLICT' && /Near-miss/.test(e.text))).toEqual([]);
  }, 60_000);

  it('A320 ahead of a C172, and two C172s: released on today\'s rules (no extra wait)', () => {
    for (const [lead, foll] of [['A320', 'C172'], ['C172', 'C172']] as const) {
      const { h, takeoffAt } = departures(lead, foll, 2);
      expect(h.runUntil(() => takeoffAt() !== undefined, 120)).toBe(true);
    }
  }, 60_000);
});

/** Two arrivals to 13: the leader on a 6 nm final (C172 at 90 kt or A320), the follower an A320 over LEBVE (about 12 nm out). */
function arrivals(leaderType: 'C172' | 'A320') {
  const leader: ScenarioAircraftSpawn = {
    atSec: 0, callsign: 'LEAD1', type: leaderType, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
    start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: leaderType === 'A320' ? 150 : 90, runwayEnd: '13', distanceNm: 6 },
    flightPlan: { flightRules: 'VFR', origin: 'KMIV', destination: 'KACY', cruiseAltitudeFt: 3000, route: [] },
  };
  return createHarness({ player: ['GND'], spawns: [leader, IFR_ARR('AAL615', 'LEBVE', ['LEBVE', 'CARYL', 'MAYBN'], '13', 4000)] });
}
const approachTexts = (h: Harness) => h.atc('APP').filter((e) => e.callsign === 'AAL615').map((e) => e.text);

describe('approach spacing is judged at the leader\'s threshold crossing (5-5-4 / 3-10-3)', () => {
  it('C172 at 6 nm, A320 at 12 nm: speed reduced and no approach clearance until the C172 is nearly down', () => {
    const h = arrivals('C172');
    let clearedLeaderNm: number | undefined;
    h.runUntil(() => {
      const t = approachTexts(h);
      if (t.some((x) => /cleared ILS/.test(x)) && clearedLeaderNm === undefined) {
        const lead = h.find('LEAD1');
        clearedLeaderNm = lead && !lead.onGround ? distToThresholdNm(lead, assignedEnd(kacy, lead)!) : 0;
      }
      return clearedLeaderNm !== undefined;
    }, 900);
    const t = approachTexts(h);
    expect(t.some((x) => /reduce speed to one (six|four) zero/.test(x))).toBe(true);
    expect(clearedLeaderNm).toBeDefined();
    // the A320 is cleared only when the C172 is close to the threshold (the projected gap there is >= 5 nm), not at the 6 nm it started from
    expect(clearedLeaderNm!).toBeLessThan(4);
    h.run(900);
    expect(h.events.filter((e) => e.kind === 'CONFLICT' && /Near-miss/.test(e.text))).toEqual([]);
  }, 60_000);

  it('two A320s 6 nm apart: cleared at once, no speed reduction, no hold', () => {
    const h = arrivals('A320');
    // the leader (150 kt, 6 nm) and the follower (about 12 nm) are 6 nm apart: today's clearance
    h.run(40);
    const t = approachTexts(h);
    expect(t.some((x) => /cleared ILS/.test(x))).toBe(true);
    expect(t.some((x) => /hold at|reduce speed/.test(x))).toBe(false);
  }, 60_000);
});

describe('tower sends a follower around early, before the near-miss alert', () => {
  it('A320 4 nm out, C172 on the same final 2.5 nm out (1.5 nm in trail): go around at 3-4 nm', () => {
    const mk = (cs: string, type: string, nm: number, kt: number): ScenarioAircraftSpawn => ({
      atSec: 0, callsign: cs, type, flightRules: 'VFR', isDeparture: false, initialFrequencyId: 'TWR',
      start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: kt, runwayEnd: '13', distanceNm: nm },
      flightPlan: { flightRules: 'VFR', origin: 'KMIV', destination: 'KACY', cruiseAltitudeFt: 3000, route: [] },
    });
    const h = createHarness({ player: ['GND'], spawns: [mk('LEAD1', 'C172', 2.5, 75), mk('FOLL1', 'A320', 4.0, 150)] });
    let dAtGoAround: number | undefined;
    h.runUntil(() => {
      if (dAtGoAround === undefined && h.atc('TWR').some((e) => e.callsign === 'FOLL1' && /go around/i.test(e.text))) {
        const f = h.find('FOLL1') as Aircraft;
        dAtGoAround = distToThresholdNm(f, g13);
      }
      return dAtGoAround !== undefined;
    }, 120);
    expect(dAtGoAround).toBeDefined();
    expect(dAtGoAround!).toBeGreaterThan(1.5);
    h.run(60);
    expect(h.events.filter((e) => e.kind === 'CONFLICT' && /Near-miss/.test(e.text))).toEqual([]);
  }, 60_000);
});

describe('a go-around is never re-cleared to land while it is still on the missed approach', () => {
  it('go around, direct fix 8 s later, a landing clearance 16 s after the go-around: refused; the AI waits for the approach to be re-cleared', () => {
    const arrival: ScenarioAircraftSpawn = {
      atSec: 0, callsign: 'AAL615', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'TWR',
      start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 150, runwayEnd: '13', distanceNm: 5 },
      flightPlan: { flightRules: 'IFR', origin: 'KPHL', destination: 'KACY', cruiseAltitudeFt: 10000, route: ['ACY'] },
    };
    const scenario: Scenario = {
      id: 'ga-seq', name: 'go-around', description: 'IFR go-around, Tower and Ground only', mode: 'free_play', seed: 7,
      weather: { source: 'simulated', windDirDeg: 130, windSpeedKt: 4, visibilitySm: 10, clouds: [{ cover: 'SCT', baseFtAgl: 5000 }], temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR' },
      activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR', 'GND'], playerPositions: ['GND'], spawns: [arrival],
    };
    const engine = createEngine({ airport: kacy, scenario, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 5, 1, 16, 0, 0) });
    const ai = createAiControllers({ engine, airport: kacy, positions: ['TWR'], playerPositions: ['GND'], seed: 7 });
    engine.subscribe((s) => ai.update(s));
    const n = Math.round(1 / engine.getState().clock.dtSec);
    const step = (sec: number) => { for (let s = 0; s < sec; s++) for (let i = 0; i < n; i++) engine.step(); };
    const ac = () => Object.values(engine.getState().aircraft).find((a) => a.callsign === 'AAL615')!;
    const until = (pred: () => boolean, max: number) => { for (let s = 0; s < max && !pred(); s++) step(1); return pred(); };
    expect(until(() => ac().phase === 'FINAL', 300)).toBe(true);
    // the tower must not have given a landing clearance yet for the test to be about the re-clearance
    engine.applyCommand(cmd('GO_AROUND', 'AAL615'), { position: 'TWR' });
    const tGa = engine.getState().clock.timeSec;
    expect(ac().phase).toBe('GO_AROUND');
    step(8);
    engine.applyCommand(cmd('DIRECT_FIX', 'AAL615', { fix: 'ACY' }), { position: 'TWR' });
    step(8);
    const landNow = engine.applyCommand(cmd('LAND', 'AAL615', { runwayEnd: '13' }), { position: 'TWR' });
    expect(landNow.status).toBe('rejected');
    if (landNow.status === 'rejected') expect(landNow.reason).toMatch(/missed approach/);
    expect(until(() => ac().onGround, 1500)).toBe(true);
    const ev = engine.getState().events;
    // no "unstable approach" go-around, and the AI landing clearance came only after the approach was cleared again
    expect(ev.filter((e) => e.kind === 'GO_AROUND' && /unstable/.test(e.text))).toEqual([]);
    const ai2 = ev.filter((e) => e.kind === 'TRANSMISSION' && e.speaker === 'ATC' && e.aiPosition === 'TWR' && e.timeSec > tGa);
    const landIdx = ai2.findIndex((e) => /cleared to land/.test(e.text));
    const apprIdx = ai2.findIndex((e) => /cleared (ILS|RNAV|VOR|visual)/i.test(e.text));
    expect(landIdx).toBeGreaterThanOrEqual(0);
    expect(apprIdx).toBeGreaterThanOrEqual(0);
    expect(apprIdx).toBeLessThan(landIdx);
  }, 120_000);
});
