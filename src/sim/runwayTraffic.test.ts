/**
 * AI-controller gap fixes (engine side): arrivals over the runway, arrival behind an airborne arrival (3-10-3), crossings against
 * intersecting-runway traffic (3-9-8 / 3-10-4), AI vs player scoring and `validateCommand`, READY lane, ground proximity, check-in near
 * the hold, line-up time, runway exits that avoid re-crossings.
 */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { Airport, ScenarioAircraftSpawn } from './types';
import { createTestAirport } from './__fixtures__/testAirport';
import { ARRIVING, cmd, find, GA_PARKED, HOLDING, makeEngine, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import { alongCross, findRunwayEnd } from './runways';
import { ftToM, ktToMps, mToFt } from './geo';
import { predictRolloutPlan } from './flightDynamics';
import { shortestDistances } from './pathfinding';
import { lineUpTimeSec, getPerformance } from './performance';
import { findLeader } from './groundMovement';
import { groundProximityM } from './conflicts';

import type { ExtendedEngine } from './engineExtras';

const fixture = createTestAirport();
/** The dry-run method of the engine object (`engineExtras.ts`). */
const V = (e: SimulationEngine) => (e as ExtendedEngine).validateCommand!.bind(e);
const kacy = loadKacy();
const DAY = Date.UTC(2026, 9, 17, 16, 0, 0);

function kacyEngine(spawns: ScenarioAircraftSpawn[], over: { mode?: 'training' | 'free_play'; dep?: string[]; land?: string[] } = {}): SimulationEngine {
  return createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs: DAY,
    scenario: makeScenario({ mode: over.mode ?? 'training', controllerPositions: ['TWR', 'GND', 'APP', 'DEP', 'CLNC'], activeRunways: { departing: over.dep ?? ['13'], landing: over.land ?? ['13'] }, spawns }),
  });
}

/** Put an aircraft `alongM` down runway `end` (on the centreline). */
function place(e: SimulationEngine, airport: Airport, cs: string, end: string, alongM: number): void {
  const g = findRunwayEnd(airport, end)!;
  const ac = find(e, cs);
  ac.pos = { x: g.end.threshold.x + g.dir.x * alongM, y: g.end.threshold.y + g.dir.y * alongM };
  ac.headingDeg = g.headingDeg;
  ac.trackDeg = g.headingDeg;
}

// ---------------------------------------------------------------------------
describe('1. an arrival in the flare / over the runway blocks line-up and takeoff', () => {
  const setup = (airport: Airport, hold: string, alongM: number, aglFt: number) => {
    const spawns = [HOLDING('DEP1', hold, '13', 'C172'), ARRIVING('ARR1', '13', 3, 'A320', 'TWR')];
    const e = airport === fixture ? makeEngine({ scenario: makeScenario({ spawns, mode: 'training' }) }) : kacyEngine(spawns);
    run(e, 2);
    const arr = find(e, 'ARR1');
    place(e, airport, 'ARR1', '13', alongM);
    arr.altitudeFt = findRunwayEnd(airport, '13')!.elevationFt + aglFt;
    arr.phase = 'LANDING';
    return e;
  };

  for (const [name, airport, hold] of [['fixture', fixture, 'H13'], ['real KACY', kacy, 'HP13-31-C-1']] as const) {
    it(`${name}: TAKEOFF and LINE_UP are refused while the arrival is 250 m past the threshold, 80 ft up (the old 50 m rule let it through)`, () => {
      const e = setup(airport, hold, 250, 80);
      const to = say(e, cmd('TAKEOFF', 'DEP1', { runwayEnd: '13' }), 'TWR');
      expect(to.status).toBe('rejected');
      if (to.status === 'rejected') expect(to.reason).toMatch(/ARR1 is landing over runway/);
      const lu = say(e, cmd('LINE_UP_AND_WAIT', 'DEP1', { runwayEnd: '13' }), 'TWR');
      expect(lu.status).toBe('rejected');
    });
    it(`${name}: with the arrival gone the same takeoff is accepted`, () => {
      const spawns = [HOLDING('DEP1', hold, '13', 'C172')];
      const k = airport === fixture ? makeEngine({ scenario: makeScenario({ spawns, mode: 'training' }) }) : kacyEngine(spawns);
      run(k, 2);
      expect(say(k, cmd('TAKEOFF', 'DEP1', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
    });
  }
});

// ---------------------------------------------------------------------------
describe('2. landing behind a preceding arrival that is still airborne (3-10-3)', () => {
  const two = (airport: Airport, gapNm: number, mode: 'training' | 'free_play', utc = DAY) => {
    const spawns = [ARRIVING('L1', '13', 1.5, 'C172'), ARRIVING('L2', '13', 1.5 + gapNm, 'C172')];
    const scenario = makeScenario({ spawns, mode });
    return airport === fixture ? makeEngine({ scenario, opts: { utcStartMs: utc } }) : kacyEngine(spawns, { mode });
  };
  const clear = (e: SimulationEngine, cs: string) => say(e, cmd('LAND', cs, { runwayEnd: '13' }), 'TWR');

  for (const [name, airport] of [['fixture', fixture], ['real KACY', kacy]] as const) {
    it(`${name}: two C172s ~25 s apart on the same final: the second clearance is refused with the 3-10-3 reason; ~60 s apart is accepted`, () => {
      const close = two(airport, 0.5, 'training');
      expect(clear(close, 'L1').status).toBe('accepted');
      const r = clear(close, 'L2');
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.unsafe).toBe(true);
        expect(r.reason).toMatch(/L1 ahead on the same final lands in \d+ s and is not clear of the runway until about \d+ s/);
        expect(r.reason).toMatch(/3-10-3/);
      }
      const far = two(airport, 1.2, 'training');
      expect(clear(far, 'L1').status).toBe('accepted');
      expect(clear(far, 'L2').status).toBe('accepted');
    });
  }

  it('free play: the too-close clearance is accepted and flagged, then the automatic go-around keeps the runway clear (no collision on rollout)', () => {
    const e = two(fixture, 0.5, 'free_play');
    expect(clear(e, 'L1').status).toBe('accepted');
    expect(clear(e, 'L2').status).toBe('accepted');
    expect(e.getState().events.some((x) => x.kind === 'CONFLICT' && /not clear of the runway/.test(x.text))).toBe(true);
    run(e, 200);
    const ga = e.getState().events.filter((x) => /going around|GO_AROUND/.test(x.text) && x.callsign === 'L2');
    expect(ga.length).toBeGreaterThan(0);
    expect(e.getState().events.some((x) => /traffic on the runway/.test(x.text))).toBe(true);
    // never two aircraft on the runway surface with one moving: no surface conflict was raised
    expect(e.getState().events.filter((x) => x.kind === 'CONFLICT' && (x.data as { alertId?: string }).alertId && (x.data as { alertKind?: string }).alertKind === 'RUNWAY_CONFLICT')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('3. crossing a runway against traffic on the intersecting runway', () => {
  const crossCase = (airport: Airport, type: string) => {
    const spawns: ScenarioAircraftSpawn[] = airport === fixture
      ? [HOLDING('X1', 'B_h422E', '22', 'C172', 'GND'), ARRIVING('L1', '13', 3, type, 'TWR')]
      : [HOLDING('X1', 'HP4-22-B-2', '4', 'C172', 'GND'), ARRIVING('L1', '13', 3, type, 'TWR')];
    const e = airport === fixture
      ? makeEngine({ scenario: makeScenario({ spawns, mode: 'training', controllerPositions: ['TWR', 'GND'] }) })
      : kacyEngine(spawns);
    run(e, 15);
    expect(say(e, cmd('TAXI', 'X1', { destination: 'RWY13', runwayEnd: '13', route: ['B'], holdShort: ['4/22'] }), 'GND').status).toBe('accepted');
    expect(say(e, cmd('LAND', 'L1', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
    return e;
  };
  const check = (e: SimulationEngine) => V(e)(cmd('CROSS_RUNWAY', 'X1', { crossRunwayId: '4/22' }), { position: 'GND' });

  for (const [name, airport] of [['fixture', fixture], ['real KACY', kacy]] as const) {
    it(`${name}: the crossing of 4/22 is refused while a 13 arrival would roll through the intersection inside the crossing window, accepted once it has passed`, () => {
      const e = crossCase(airport, 'A320');
      const l1 = find(e, 'L1');
      let refusedDuringRollout = false;
      let refusedReason = '';
      let acceptedAfter = false;
      for (let i = 0; i < 4000 && !acceptedAfter; i++) {
        e.step();
        if (i % 10) continue;
        const out = check(e);
        if (out.status === 'rejected' && (l1.phase === 'ROLLOUT' || l1.phase === 'LANDING')) {
          refusedDuringRollout = true;
          refusedReason = refusedReason || out.reason;
        }
        if (out.status === 'accepted' && refusedDuringRollout) acceptedAfter = true;
      }
      expect(refusedDuringRollout).toBe(true);
      expect(refusedReason).toMatch(/Crossing clearance|Crossing clearance for X1 over runway 4\/22/);
      expect(acceptedAfter).toBe(true);
    });
  }

  it('no traffic: the same crossing is accepted at once (real KACY)', () => {
    const e = kacyEngine([HOLDING('X1', 'HP4-22-B-2', '4', 'C172', 'GND')]);
    run(e, 15);
    say(e, cmd('TAXI', 'X1', { destination: 'RWY13', runwayEnd: '13', route: ['B'], holdShort: ['4/22'] }), 'GND');
    expect(check(e).status).toBe('accepted');
  });

  it('the reverse: a landing on 13 is refused while an aircraft is cleared across 4/22 and would still be on it when the arrival reaches the intersection', () => {
    const e = kacyEngine([HOLDING('X1', 'HP4-22-B-2', '4', 'C172', 'GND'), ARRIVING('L1', '13', 0.4, 'A320', 'TWR')]);
    run(e, 15);
    say(e, cmd('TAXI', 'X1', { destination: 'RWY13', runwayEnd: '13', route: ['B'], holdShort: ['4/22'] }), 'GND');
    // the crossing is cleared first (no traffic yet near the threshold), then the arrival is cleared
    const l1 = find(e, 'L1');
    l1.pos = { x: l1.pos.x - 5000, y: l1.pos.y + 3000 }; // far away for the moment
    expect(say(e, cmd('CROSS_RUNWAY', 'X1', { crossRunwayId: '4/22' }), 'GND').status).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
describe('4. AI commands are not the player\'s: aiPosition on the events, player-only scoring, validateCommand dry run', () => {
  const arrivalsEngine = () => makeEngine({ scenario: makeScenario({ mode: 'training', controllerPositions: ['TWR', 'GND'], spawns: [ARRIVING('L1', '13', 3, 'C172'), ARRIVING('L2', '13', 8, 'C172')] }) });

  it('COMMAND_ACCEPTED / COMMAND_REJECTED carry aiPosition when the command comes from an AI controller', () => {
    const e = arrivalsEngine();
    const ok = e.applyCommand(cmd('LAND', 'L1', { runwayEnd: '13' }), { position: 'TWR', source: 'ai', aiPosition: 'TWR' });
    expect(ok.status).toBe('accepted');
    const no = e.applyCommand(cmd('TAKEOFF', 'L2', { runwayEnd: '13' }), { position: 'TWR', source: 'ai', aiPosition: 'TWR' });
    expect(no.status).toBe('rejected');
    const events = e.getState().events;
    expect(events.find((x) => x.kind === 'COMMAND_ACCEPTED')?.aiPosition).toBe('TWR');
    expect(events.find((x) => x.kind === 'COMMAND_REJECTED')?.aiPosition).toBe('TWR');
    // the pilot's readback is not tagged
    expect(events.filter((x) => x.speaker === 'PILOT').every((x) => x.aiPosition === undefined)).toBe(true);
  });

  it('scoring counts correct clearances, communication errors and unsafe instructions only for the player', () => {
    const e = arrivalsEngine();
    const card = () => e.getState().score;
    e.applyCommand(cmd('LAND', 'L1', { runwayEnd: '13' }), { position: 'TWR', source: 'ai', aiPosition: 'TWR' });
    e.applyCommand(cmd('TAKEOFF', 'L2', { runwayEnd: '13' }), { position: 'TWR', source: 'ai', aiPosition: 'TWR' }); // communication error if it were the player's
    run(e, 1);
    expect(card().correctClearances).toBe(0);
    expect(card().communicationErrors).toBe(0);
    // the same instructions from the player count
    e.applyCommand(cmd('LAND', 'L2', { runwayEnd: '13' }), { position: 'TWR' });
    e.applyCommand(cmd('TAKEOFF', 'L1', { runwayEnd: '13' }), { position: 'TWR' });
    run(e, 1);
    expect(card().correctClearances).toBe(1);
    expect(card().communicationErrors).toBe(1);
  });

  it('an unsafe AI clearance is refused (training) and not scored against the player; the same one from the player costs 15 points', () => {
    const mk = () => makeEngine({ scenario: makeScenario({ mode: 'training', controllerPositions: ['TWR', 'GND'], spawns: [ARRIVING('L1', '13', 1.5, 'C172'), ARRIVING('L2', '13', 2.0, 'C172')] }) });
    const ai = mk();
    ai.applyCommand(cmd('LAND', 'L1', { runwayEnd: '13' }), { position: 'TWR', source: 'ai', aiPosition: 'TWR' });
    expect(ai.applyCommand(cmd('LAND', 'L2', { runwayEnd: '13' }), { position: 'TWR', source: 'ai', aiPosition: 'TWR' }).status).toBe('rejected');
    run(ai, 1);
    expect(ai.getState().score.unsafeInstructions).toBe(0);
    const pl = mk();
    pl.applyCommand(cmd('LAND', 'L1', { runwayEnd: '13' }), { position: 'TWR' });
    expect(pl.applyCommand(cmd('LAND', 'L2', { runwayEnd: '13' }), { position: 'TWR' }).status).toBe('rejected');
    run(pl, 1);
    expect(pl.getState().score.unsafeInstructions).toBe(1);
  });

  it('validateCommand: same outcome as applyCommand, no events, no readback, no score, no state change, no duplicate-window side effect', () => {
    const e = arrivalsEngine();
    const before = JSON.stringify({ ev: e.getState().events.length, score: e.getState().score, ac: e.getState().aircraft, conflicts: e.getState().conflicts });
    const v = V(e)(cmd('LAND', 'L1', { runwayEnd: '13' }), { position: 'TWR', source: 'ai', aiPosition: 'TWR', transmissionId: 't1' });
    expect(v.status).toBe('accepted');
    if (v.status === 'accepted') {
      expect(v.clearance.id).toBe('dry-run');
      expect(v.readback).toMatch(/cleared to land/);
    }
    const bad = V(e)(cmd('TAKEOFF', 'L2', { runwayEnd: '13' }), { position: 'TWR' });
    expect(bad.status).toBe('rejected');
    expect(JSON.stringify({ ev: e.getState().events.length, score: e.getState().score, ac: e.getState().aircraft, conflicts: e.getState().conflicts })).toBe(before);
    // the real call afterwards is not seen as a duplicate and does execute
    const real = e.applyCommand(cmd('LAND', 'L1', { runwayEnd: '13' }), { position: 'TWR' });
    expect(real.status).toBe('accepted');
    expect(find(e, 'L1').clearances.some((c) => c.kind === 'LAND')).toBe(true);
    expect(e.getState().events.some((x) => x.kind === 'COMMAND_ACCEPTED')).toBe(true);
  });

  it('validateCommand reports an unsafe clearance as rejected+unsafe in training and accepted in free play, without recording an alert', () => {
    const mk = (mode: 'training' | 'free_play') => makeEngine({ scenario: makeScenario({ mode, controllerPositions: ['TWR', 'GND'], spawns: [ARRIVING('L1', '13', 1.5, 'C172'), ARRIVING('L2', '13', 2.0, 'C172')] }) });
    const t = mk('training');
    t.applyCommand(cmd('LAND', 'L1', { runwayEnd: '13' }), { position: 'TWR' });
    const v = V(t)(cmd('LAND', 'L2', { runwayEnd: '13' }), { position: 'TWR' });
    expect(v.status).toBe('rejected');
    if (v.status === 'rejected') expect(v.unsafe).toBe(true);
    expect(t.getState().conflicts).toHaveLength(0);
    expect(t.getState().score.unsafeInstructions).toBe(0);
    const f = mk('free_play');
    f.applyCommand(cmd('LAND', 'L1', { runwayEnd: '13' }), { position: 'TWR' });
    expect(V(f)(cmd('LAND', 'L2', { runwayEnd: '13' }), { position: 'TWR' }).status).toBe('accepted');
    expect(f.getState().score.unsafeInstructions).toBe(0);
  });

  it('aircraft handled: once an AI is active only an aircraft the player instructed counts (DESPAWN byPlayer)', () => {
    const e = makeEngine({ scenario: makeScenario({ mode: 'free_play', controllerPositions: ['TWR', 'GND'], spawns: [GA_PARKED('N1AA', 'GA1', 'GND'), GA_PARKED('N2BB', 'GA2', 'GND')] }) });
    run(e, 5);
    e.applyCommand(cmd('TAXI', 'N1AA', { destination: 'RWY13', runwayEnd: '13', route: ['C'] }), { position: 'GND', source: 'ai', aiPosition: 'GND' });
    e.applyCommand(cmd('TAXI', 'N2BB', { destination: 'RWY13', runwayEnd: '13', route: ['C'] }), { position: 'GND' }); // the player
    e.removeAircraft(find(e, 'N1AA').id);
    e.removeAircraft(find(e, 'N2BB').id);
    expect(e.getState().events.filter((x) => x.kind === 'DESPAWN').map((x) => (x.data as { byPlayer?: boolean }).byPlayer)).toEqual([false, true]);
    // the score counter: a handled despawn counts only when the player gave the aircraft an instruction
    e.logEvent({ kind: 'DESPAWN', text: 'AI aircraft shut down', severity: 'info', speaker: 'SYSTEM', data: { handled: true, byPlayer: false } });
    run(e, 1);
    expect(e.getState().score.aircraftHandled).toBe(0);
    e.logEvent({ kind: 'DESPAWN', text: 'player aircraft shut down', severity: 'info', speaker: 'SYSTEM', data: { handled: true, byPlayer: true } });
    run(e, 1);
    expect(e.getState().score.aircraftHandled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('5/6. ground: READY aircraft are not lane traffic; proximity alerts are relative to the following distance', () => {
  it('a READY aircraft at its parking position does not hold up an aircraft passing on the connector; a moving one ahead does', () => {
    const e = makeEngine({ scenario: makeScenario({ spawns: [GA_PARKED('N1AA', 'GA1', 'GND'), GA_PARKED('N2BB', 'GA2', 'GND')] }) });
    run(e, 3);
    const a = find(e, 'N1AA');
    const b = find(e, 'N2BB');
    a.onGround = true;
    a.groundSpeedKt = 8;
    a.headingDeg = 90;
    a.pos = { x: 0, y: 0 };
    b.pos = { x: 40, y: 0 };
    b.headingDeg = 90;
    // B stands at a parking position, READY for taxi
    e.getState().airport.parking[1].pos = { x: 40, y: 0 };
    b.groundSpeedKt = 0;
    b.phase = 'READY';
    const ctx = { state: e.getState() } as Parameters<typeof findLeader>[0];
    expect(findLeader(ctx, a)).toBeUndefined();
    // the same aircraft moving along the taxiway with a route is traffic
    b.phase = 'TAXIING';
    b.groundSpeedKt = 6;
    b.route = { nodeIds: ['AP'], taxiways: [], stopAtNodeIds: [], progressIndex: 0 };
    expect(findLeader(ctx, a)).toBeDefined();
  });

  it('alert threshold = 0.8 x the following distance (never above 30 m): C172 pair 26 m, A320 pair 30 m', () => {
    const e = makeEngine({ scenario: makeScenario({ spawns: [GA_PARKED('N1AA', 'GA1', 'GND', { type: 'C172' }), GA_PARKED('N2BB', 'GA2', 'GND', { type: 'A320' })] }) });
    const [c, a] = [find(e, 'N1AA'), find(e, 'N2BB')];
    expect(groundProximityM(c, c)).toBeCloseTo(0.8 * (1.5 * 8.3 + 20), 6);
    expect(groundProximityM(c, c)).toBeLessThan(30);
    expect(groundProximityM(a, c)).toBe(30);
  });

  it('a queue of stopped C172s holding short never raises an alert; the same two moving at 28 m do not either (the normal gap is 32 m), at 22 m they do', () => {
    const mk = (gap: number, stopped: boolean) => {
      const e = makeEngine({ scenario: makeScenario({ spawns: [HOLDING('N1AA', 'H13', '13'), HOLDING('N2BB', 'D_h13S', '13')] }) });
      run(e, 2);
      const [a, b] = [find(e, 'N1AA'), find(e, 'N2BB')];
      b.pos = { x: -1200, y: 600 };
      a.pos = { x: b.pos.x + gap * Math.cos((118 * Math.PI) / 180 + Math.PI), y: b.pos.y - gap * Math.sin((118 * Math.PI) / 180 + Math.PI) };
      a.headingDeg = b.headingDeg = 118;
      a.groundSpeedKt = b.groundSpeedKt = stopped ? 0 : 5;
      a.phase = b.phase = stopped ? 'HOLDING_SHORT' : 'TAXIING';
      run(e, 0.2);
      return e.getState().conflicts.filter((c) => c.kind === 'GROUND_PROXIMITY');
    };
    expect(mk(20, true)).toHaveLength(0); // same queue, stopped
    expect(mk(28, false)).toHaveLength(0); // between 26 and 30 m: no longer an alert
    expect(mk(22, false)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('7. check-in on Tower near the hold is the departure call', () => {
  it('real KACY: handed to Tower at the hold -> "holding short runway one three, ready for departure", pending DEPARTURE', () => {
    const e = kacyEngine([HOLDING('N723EJ', 'HP13-31-C-1', '13', 'C172', 'GND')]);
    run(e, 5);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'TWR' }), 'GND').status).toBe('accepted');
    const ac = find(e, 'N723EJ');
    expect(runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'DEPARTURE', 30)).toBe(true);
    const last = pilotTexts(e, 'N723EJ').filter((t) => /Tower/.test(t));
    expect(last[last.length - 1]).toMatch(/^Atlantic City Tower, Cessna seven two three echo juliet, holding short runway one three, ready for departure\.$/);
  });

  it('fixture: still taxiing within 400 m of the hold -> "approaching the hold runway one three, ready for departure"', () => {
    const e = makeEngine({ scenario: makeScenario({ mode: 'free_play', controllerPositions: ['TWR', 'GND'], spawns: [GA_PARKED('N723EJ', 'GA1', 'GND')] }) });
    run(e, 10);
    expect(say(e, cmd('TAXI', 'N723EJ', { destination: 'RWY13', runwayEnd: '13', route: ['A', 'C'] }), 'GND').status).toBe('accepted');
    const ac = find(e, 'N723EJ');
    ac.runwayAuthorizations.push('13/31', '4/22'); // the crossings on the way are cleared
    const hold = fixture.taxiwayGraph.nodes.H13.pos;
    expect(runUntil(e, () => Math.hypot(ac.pos.x - hold.x, ac.pos.y - hold.y) < 300 && Math.hypot(ac.pos.x - hold.x, ac.pos.y - hold.y) > 150, 400)).toBe(true);
    expect(say(e, cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyId: 'TWR' }), 'GND').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'DEPARTURE', 30)).toBe(true);
    const texts = pilotTexts(e, 'N723EJ').filter((t) => /Tower/.test(t));
    expect(texts[texts.length - 1]).toMatch(/approaching the hold runway one three, ready for departure\./);
  });
});

// ---------------------------------------------------------------------------
describe('8. line-up time of a takeoff from the hold', () => {
  it('lineUpTimeSec: floor 10 s (C172) / 17 s (A320), longer for a long path', () => {
    expect(lineUpTimeSec(getPerformance('C172'), 5)).toBe(10);
    expect(lineUpTimeSec(getPerformance('A320'), 5)).toBe(17);
    expect(lineUpTimeSec(getPerformance('A320'), 150)).toBeGreaterThan(17);
    expect(lineUpTimeSec(getPerformance('C172'), 100)).toBeGreaterThan(lineUpTimeSec(getPerformance('C172'), 40));
  });

  it('real KACY: the roll starts 25-30 s after a clearance from the hold (both types), never 2.5 s', () => {
    for (const type of ['C172', 'A320']) {
      const e = kacyEngine([HOLDING('X1', 'HP13-31-C-1', '13', type, 'TWR')], { mode: 'free_play' });
      run(e, 2);
      expect(say(e, cmd('TAKEOFF', 'X1', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
      const t0 = e.getState().clock.timeSec;
      const ac = find(e, 'X1');
      expect(runUntil(e, () => ac.phase === 'TAKEOFF_ROLL', 120)).toBe(true);
      const dt = e.getState().clock.timeSec - t0;
      console.info(`${type} roll starts ${dt.toFixed(1)} s after the clearance from HP13-31-C-1`);
      expect(dt).toBeGreaterThanOrEqual(type === 'A320' ? 17 : 10);
      expect(dt).toBeLessThan(45);
    }
  });

  it('the intersecting-runway estimate includes the line-up: a 13 arrival 25 s from the threshold blocks a takeoff from the hold on 22 (real KACY)', () => {
    const e = kacyEngine([HOLDING('D1', 'HP4-22-A-2', '22', 'C172', 'TWR'), ARRIVING('ARR', '13', 0.45, 'C172', 'TWR')], { dep: ['22'], land: ['13'] });
    expect(say(e, cmd('LAND', 'ARR', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
    run(e, 1);
    const r = say(e, cmd('TAKEOFF', 'D1', { runwayEnd: '22' }), 'TWR');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toMatch(/ARR would cross the threshold of runway 13\/31/);
  });
});

// ---------------------------------------------------------------------------
describe('9. runway exits avoid a re-crossing when they can', () => {
  const st = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({}) }).getState();
  const cost = (airport: Airport, hold: string) => {
    const dm = shortestDistances(airport.taxiwayGraph, hold);
    return Math.min(...airport.parking.map((p) => dm.get(p.nodeId) ?? Infinity));
  };

  it('real KACY: every exit chosen for every runway end / type / touchdown point has a taxi route to parking without crossing a runway', () => {
    for (const rwy of ['4', '22', '13', '31']) for (const type of ['C172', 'A320']) for (const td of [250, 390, 600, 800]) {
      const g = findRunwayEnd(kacy, rwy)!;
      const plan = predictRolloutPlan(st, type, g, td, ktToMps(type === 'C172' ? 55 : 130));
      if (plan.holdNodeId) expect(cost(kacy, plan.holdNodeId), `${type} ${rwy} td ${td}`).toBeLessThan(Infinity);
    }
  });

  it('the first exit that needs a runway re-crossing is skipped for a later one that does not; if none exists the first exit is used (the aircraft stops at the hold and asks to cross)', () => {
    const g = findRunwayEnd(kacy, '22')!;
    const withB = predictRolloutPlan(st, 'C172', g, 390, ktToMps(55));
    expect(withB.exitNodeId).toBe('R4-22-03'); // taxiway B, 2,748 ft
    // cut both Bravo holds off from the rest of the taxiway system (except across the runway): reaching parking from them needs a crossing
    const cutIds = new Set(['HP4-22-B-1', 'HP4-22-B-2']);
    const cut: Airport = { ...kacy, taxiwayGraph: { ...kacy.taxiwayGraph, edges: kacy.taxiwayGraph.edges.filter((ed) => ed.onRunwayId || !(cutIds.has(ed.from) || cutIds.has(ed.to))) } };
    expect(cost(cut, 'HP4-22-B-1')).toBe(Infinity);
    const alt = { ...st, airport: cut };
    const plan = predictRolloutPlan(alt, 'C172', g, 390, ktToMps(55));
    expect(plan.exitNodeId).not.toBe('R4-22-03'); // skipped: Bravo leads onto a hold that needs a runway crossing
    expect(cost(cut, plan.holdNodeId!)).toBeLessThan(Infinity);
    // no parking reachable without a crossing from anywhere: the first exit is kept
    const none = { ...st, airport: { ...kacy, parking: [] } };
    expect(predictRolloutPlan(none, 'C172', g, 390, ktToMps(55)).exitNodeId).toBe('R4-22-03');
    void ftToM; void mToFt; void alongCross;
  });
});
