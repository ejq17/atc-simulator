import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { newScoreCard } from '../sim/scoring';
import type { Scenario, ScoreCard, SimEvent, SimulationState, Weather } from '../sim/types';
import { getPresetWeather } from '../weather/presets';
import { CAREER_STORAGE_KEY, careerStepOf } from './career';
import { gradeFor } from './debrief';
import { createScenarioEventRunner, game, scenarioWeatherSchedule } from './game';
import type { DebriefReport } from './index';
import { allObjectivesDone, evaluateCheck, evaluateObjectives, isKnownCheck } from './objectives';
import { listScenarioSummaries } from './scenarios';
import { accepted, run, runUntil, say } from './testkit';
import { NM } from './world';
import { findRunwayEnd } from '../sim/runways';

const airport = loadKacy();

// ---------------------------------------------------------------------------
// Free play builder
// ---------------------------------------------------------------------------
describe('buildFreePlay', () => {
  it('uses sane defaults', () => {
    const fp = game.buildFreePlay(airport, {});
    expect(fp.mode).toBe('free_play');
    expect(fp.traffic?.enabled).toBe(true);
    expect(fp.activeRunways.landing.length).toBe(1);
    expect(fp.spawns.length).toBe(4);
    expect(fp.durationSec).toBeUndefined();
  });

  it('honours seed, determinism and different seeds', () => {
    const a = game.buildFreePlay(airport, { seed: 42 });
    const b = game.buildFreePlay(airport, { seed: 42 });
    const c = game.buildFreePlay(airport, { seed: 43 });
    expect(a).toEqual(b);
    expect(a.seed).toBe(42);
    expect(JSON.stringify(a.spawns)).not.toEqual(JSON.stringify(c.spawns));
  });

  it('resolves weather: preset id, object, live, random', () => {
    expect(game.buildFreePlay(airport, { weather: 'imc' }).weather).toEqual(getPresetWeather('imc'));
    const custom: Weather = { ...getPresetWeather('clear'), windDirDeg: 300, windSpeedKt: 15 };
    expect(game.buildFreePlay(airport, { weather: custom }).weather).toEqual(custom);
    expect(game.buildFreePlay(airport, { weather: 'live' }).weather).toBe('live');
    const r1 = game.buildFreePlay(airport, { weather: 'random', seed: 9 }).weather;
    const r2 = game.buildFreePlay(airport, { weather: 'random', seed: 9 }).weather;
    expect(r1).toEqual(r2);
    expect((r1 as Weather).source).toBe('simulated');
    expect(game.buildFreePlay(airport, { weather: 'no-such-preset' }).weather).toEqual(getPresetWeather('clear'));
  });

  it('recommends runways from the wind (ends the types can depart from) unless told otherwise', () => {
    const nw: Weather = { ...getPresetWeather('clear'), windDirDeg: 290, windSpeedKt: 15 };
    expect(game.buildFreePlay(airport, { weather: nw }).activeRunways).toEqual({ departing: ['31'], landing: ['31'] });
    const se: Weather = { ...getPresetWeather('clear'), windDirDeg: 110, windSpeedKt: 15 };
    expect(game.buildFreePlay(airport, { weather: se }).activeRunways).toEqual({ departing: ['13'], landing: ['13'] });
    // A south-west wind favours runway 22. An A320 (5,000 ft takeoff distance) can depart 22 (6,145 ft) from full length, so the wind decides for jets too.
    const sw: Weather = { ...getPresetWeather('clear'), windDirDeg: 200, windSpeedKt: 18 };
    expect(game.buildFreePlay(airport, { weather: sw }).activeRunways).toEqual({ departing: ['22'], landing: ['22'] });
    expect(game.buildFreePlay(airport, { weather: sw, aircraftTypes: ['C172'] }).activeRunways.landing).toEqual(['22']);
    // Operator preference for the longer 13/31 pair when the headwinds tie (within 1 kt) or the wind is calm - not a capability limit.
    const calm: Weather = { ...getPresetWeather('clear'), windDirDeg: 0, windSpeedKt: 2 };
    expect(game.buildFreePlay(airport, { weather: calm }).activeRunways).toEqual({ departing: ['13'], landing: ['13'] });
    const tie: Weather = { ...getPresetWeather('clear'), windDirDeg: 165, windSpeedKt: 10 }; // true 165 = magnetic 175: equal headwind on 13 (128) and 22 (218)
    expect(game.buildFreePlay(airport, { weather: tie }).activeRunways).toEqual({ departing: ['13'], landing: ['13'] });
    const fixed = game.buildFreePlay(airport, { weather: nw, activeRunways: { departing: ['22'], landing: ['13'] } });
    expect(fixed.activeRunways).toEqual({ departing: ['22'], landing: ['13'] });
  });

  it('honours aircraftCount, mix, types, rates, GA fraction, max aircraft and difficulty', () => {
    const fp = game.buildFreePlay(airport, { seed: 5, aircraftCount: 8, startingScenario: 'busy_departures', maxAircraft: 12, difficulty: 'hard', gaFraction: 0.25, arrivalsPerHour: 7, departuresPerHour: 21 });
    expect(fp.spawns.length).toBe(8);
    expect(fp.spawns.filter((s) => s.isDeparture).length).toBeGreaterThan(fp.spawns.filter((s) => !s.isDeparture).length);
    expect(fp.traffic).toEqual({ enabled: true, arrivalsPerHour: 7, departuresPerHour: 21, gaFraction: 0.25, maxAircraft: 12 });
    expect((fp as { difficulty?: string }).difficulty).toBe('hard');
    expect(fp.id).toBe('free-play-busy-departures');

    expect(game.buildFreePlay(airport, { aircraftCount: 50, maxAircraft: 5 }).spawns.length).toBeLessThanOrEqual(5);
    expect(game.buildFreePlay(airport, { aircraftCount: 0 }).spawns).toEqual([]);

    const easy = game.buildFreePlay(airport, { difficulty: 'easy' }).traffic!;
    const hard = game.buildFreePlay(airport, { difficulty: 'hard' }).traffic!;
    expect(hard.maxAircraft).toBeGreaterThan(easy.maxAircraft);
    expect(hard.arrivalsPerHour + hard.departuresPerHour).toBeGreaterThan(easy.arrivalsPerHour + easy.departuresPerHour);

    const ga = game.buildFreePlay(airport, { aircraftTypes: ['C172'], aircraftCount: 6, seed: 2 });
    expect(ga.spawns.every((s) => s.type === 'C172')).toBe(true);
    expect(ga.traffic?.gaFraction).toBe(1);
    const jets = game.buildFreePlay(airport, { aircraftTypes: ['A320'], aircraftCount: 6, seed: 2 });
    expect(jets.spawns.every((s) => s.type === 'A320')).toBe(true);
    expect(jets.traffic?.gaFraction).toBe(0);

    const quiet = game.buildFreePlay(airport, { startingScenario: 'quiet' });
    expect(quiet.spawns.length).toBeLessThan(game.buildFreePlay(airport, { startingScenario: 'busy_arrivals' }).spawns.length);
  });

  it('initial aircraft do not conflict at spawn: distinct parking, arrivals >= 3 nm apart, 120 s clean run', () => {
    for (const startingScenario of ['quiet', 'busy_departures', 'busy_arrivals', 'mixed'] as const) {
      for (let seed = 1; seed <= 4; seed++) {
        const fp = game.buildFreePlay(airport, { seed, startingScenario, aircraftCount: 9, maxAircraft: 14, weather: seed % 2 ? 'clear' : 'light-crosswinds' });
        const parked = fp.spawns.filter((s) => s.start.kind === 'parked').map((s) => (s.start as { parkingId: string }).parkingId);
        expect(new Set(parked).size).toBe(parked.length);
        const arr = fp.spawns.filter((s) => s.start.kind === 'airborne');
        const pos = arr.map((s) => {
          const st = s.start as Extract<Scenario['spawns'][number]['start'], { kind: 'airborne' }>;
          if (st.distanceNm !== undefined) {
            const g = findRunwayEnd(airport, st.runwayEnd)!;
            return { x: g.end.threshold.x - g.dir.x * st.distanceNm * NM, y: g.end.threshold.y - g.dir.y * st.distanceNm * NM };
          }
          return st.pos;
        });
        for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) expect(Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y) / NM).toBeGreaterThanOrEqual(3);
        const calls = fp.spawns.map((s) => s.callsign);
        expect(new Set(calls).size).toBe(calls.length);
        const engine = createEngine({ airport, scenario: fp, trafficGenerator: game.createTrafficGenerator(fp, airport) });
        for (let i = 0; i < 1200; i++) engine.step();
        const bad = engine.getState().events.filter((e) => ['CONFLICT', 'RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(e.kind));
        expect(bad.map((e) => e.text), `${startingScenario}/${seed}`).toEqual([]);
      }
    }
  });

  it('buildScenario("free-play-*") passes options through', () => {
    const s = game.buildScenario('free-play-quiet', airport, { seed: 77, difficulty: 'easy' });
    expect(s.id).toBe('free-play-quiet');
    expect(s.seed).toBe(77);
    expect(s.traffic!.maxAircraft).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Long runs do not throw
// ---------------------------------------------------------------------------
describe('catalogue robustness', () => {
  it('every scenario survives 10 simulated minutes without commands', () => {
    for (const sum of listScenarioSummaries()) {
      const sc = game.buildScenario(sum.id, airport, { seed: 3 });
      const engine = createEngine({ airport, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, airport) });
      const runner = createScenarioEventRunner(engine, sc);
      for (let i = 0; i < 6000; i++) {
        engine.step();
        if (i % 10 === 0) runner.update();
      }
      expect(engine.getState().clock.timeSec).toBeCloseTo(600, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------
function makeState(events: Partial<SimEvent>[], over: { score?: Partial<ScoreCard>; scenario?: Partial<Scenario>; aircraft?: SimulationState['aircraft']; active?: { departing: string[]; landing: string[] } } = {}): SimulationState {
  return {
    airport,
    events: events.map((e, i) => ({ id: `ev-${i}`, timeSec: i, severity: 'info', text: '', ...e })) as SimEvent[],
    aircraft: over.aircraft ?? {},
    score: { ...newScoreCard(), ...over.score },
    scenario: { id: 'x', name: 'x', mode: 'career', ...over.scenario } as Scenario,
    activeRunways: over.active ?? { departing: ['13'], landing: ['13'] },
    clock: { timeSec: 100, dtSec: 0.1, speed: 1, tick: 0 },
  } as unknown as SimulationState;
}

describe('objective predicates', () => {
  it('cmd:KIND:CS counts only accepted, safe, non-correction commands', () => {
    const ok = makeState([{ kind: 'COMMAND_ACCEPTED', callsign: 'N723EJ', data: { kind: 'TAKEOFF' } }]);
    expect(evaluateCheck(ok, 'cmd:TAKEOFF:N723EJ')).toBe(true);
    expect(evaluateCheck(ok, 'cmd:TAKEOFF:N999ZZ')).toBe(false);
    expect(evaluateCheck(ok, 'cmd:LAND:N723EJ')).toBe(false);
    expect(evaluateCheck(makeState([{ kind: 'COMMAND_ACCEPTED', callsign: 'N723EJ', data: { kind: 'TAKEOFF', unsafe: true } }]), 'cmd:TAKEOFF:N723EJ')).toBe(false);
    expect(evaluateCheck(makeState([{ kind: 'COMMAND_REJECTED', callsign: 'N723EJ', data: { kind: 'TAKEOFF' } }]), 'cmd:TAKEOFF:N723EJ')).toBe(false);
    expect(evaluateCheck(makeState([{ kind: 'COMMAND_ACCEPTED', callsign: 'n723ej', data: { kind: 'TAKEOFF' } }]), 'cmd:takeoff:n723ej')).toBe(true);
  });

  it('takeoff, landed, vacated, parked, taxied, handoff, go_around', () => {
    const ev = [
      { kind: 'PHASE_CHANGE', callsign: 'A1', data: { to: 'INITIAL_CLIMB' } },
      { kind: 'PHASE_CHANGE', callsign: 'B2', data: { to: 'ROLLOUT' } },
      { kind: 'INFO', callsign: 'B2', data: { runwayEnd: '13', alongM: 300 } },
      { kind: 'RUNWAY_ENTERED', callsign: 'B2', data: { runwayId: '4/22' } },
      { kind: 'RUNWAY_EXITED', callsign: 'B2', data: { runwayId: '4/22' } },
      { kind: 'PHASE_CHANGE', callsign: 'C3', data: { to: 'TAXIING' } },
      { kind: 'HANDOFF', callsign: 'D4' },
      { kind: 'GO_AROUND', callsign: 'E5' },
      { kind: 'PHASE_CHANGE', callsign: 'F6', data: { to: 'ARRIVED' } },
    ] as Partial<SimEvent>[];
    const s = makeState(ev);
    expect(evaluateCheck(s, 'takeoff:A1')).toBe(true);
    expect(evaluateCheck(s, 'takeoff:B2')).toBe(false);
    expect(evaluateCheck(s, 'landed:B2')).toBe(true);
    // B2 only crossed the intersecting runway while rolling out: it has NOT vacated the landing runway.
    expect(evaluateCheck(s, 'vacated:B2')).toBe(false);
    const s2 = makeState([...ev, { kind: 'RUNWAY_ENTERED', callsign: 'B2', data: { runwayId: '13/31' } }, { kind: 'RUNWAY_EXITED', callsign: 'B2', data: { runwayId: '13/31' } }] as Partial<SimEvent>[]);
    expect(evaluateCheck(s2, 'vacated:B2')).toBe(true); // touchdown was on 13/31 and it has now left 13/31
    expect(evaluateCheck(s, 'taxied:C3')).toBe(true);
    expect(evaluateCheck(s, 'handoff:D4')).toBe(true);
    expect(evaluateCheck(s, 'go_around:E5')).toBe(true);
    expect(evaluateCheck(s, 'parked:F6')).toBe(true);
    expect(evaluateCheck(s, 'parked:A1')).toBe(false);
  });

  it('crossed:CS:RWY needs entry and exit of that runway', () => {
    const entered = makeState([{ kind: 'RUNWAY_ENTERED', callsign: 'N77RK', data: { runwayId: '13/31' } }]);
    expect(evaluateCheck(entered, 'crossed:N77RK:13/31')).toBe(false);
    const both = makeState([{ kind: 'RUNWAY_ENTERED', callsign: 'N77RK', data: { runwayId: '13/31' } }, { kind: 'RUNWAY_EXITED', callsign: 'N77RK', data: { runwayId: '13/31' } }]);
    expect(evaluateCheck(both, 'crossed:N77RK:13/31')).toBe(true);
    expect(evaluateCheck(both, 'crossed:N77RK:4/22')).toBe(false);
  });

  it('holding_short and crossing_request come from pilot calls', () => {
    const s = makeState([
      { kind: 'TRANSMISSION', speaker: 'PILOT', callsign: 'N1', text: 'Atlantic City Tower, Cessna one, holding short runway one three, ready for departure.', data: { request: 'DEPARTURE' } },
      { kind: 'TRANSMISSION', speaker: 'PILOT', callsign: 'N2', text: 'Atlantic City Ground, Cessna two, holding short of runway one three at alpha.', data: { request: 'CROSSING' } },
      { kind: 'TRANSMISSION', speaker: 'PILOT', callsign: 'N3', text: 'Ground, Cessna three, clear of runway one three.', data: { request: 'FREQUENCY_CHANGE' } },
    ]);
    expect(evaluateCheck(s, 'holding_short:N1')).toBe(true);
    expect(evaluateCheck(s, 'holding_short:N2')).toBe(false);
    expect(evaluateCheck(s, 'crossing_request:N2')).toBe(true);
    expect(evaluateCheck(s, 'holding_short:N3')).toBe(false);
  });

  it('landed_before orders two aircraft', () => {
    const s = makeState([{ kind: 'PHASE_CHANGE', callsign: 'E', timeSec: 50, data: { to: 'ROLLOUT' } }, { kind: 'PHASE_CHANGE', callsign: 'X', timeSec: 90, data: { to: 'ROLLOUT' } }]);
    s.events[0].timeSec = 50;
    s.events[1].timeSec = 90;
    expect(evaluateCheck(s, 'landed_before:E:X')).toBe(true);
    expect(evaluateCheck(s, 'landed_before:X:E')).toBe(false);
    expect(evaluateCheck(s, 'landed_before:E:NEVER')).toBe(true);
    expect(evaluateCheck(s, 'landed_before:NEVER:E')).toBe(false);
  });

  it('score based checks', () => {
    const s = makeState([], { score: { aircraftHandled: 3, score: 88, runwayIncursions: 0, unsafeInstructions: 1, separationViolations: 0 } });
    expect(evaluateCheck(s, 'handled:>=3')).toBe(true);
    expect(evaluateCheck(s, 'handled:>=4')).toBe(false);
    expect(evaluateCheck(s, 'handled:3')).toBe(true);
    expect(evaluateCheck(s, 'handled:2')).toBe(false);
    expect(evaluateCheck(s, 'score:>=85')).toBe(true);
    expect(evaluateCheck(s, 'score:>=90')).toBe(false);
    expect(evaluateCheck(s, 'no_incursions')).toBe(true);
    expect(evaluateCheck(s, 'no_unsafe')).toBe(false);
    expect(evaluateCheck(s, 'no_separation')).toBe(true);
    expect(evaluateCheck(s, 'no_conflicts')).toBe(false);
    expect(evaluateCheck(s, 'always')).toBe(true);
    expect(evaluateCheck(s, 'bogus:thing')).toBe(false);
    expect(isKnownCheck('bogus')).toBe(false);
    expect(isKnownCheck('handled:>=3')).toBe(true);
  });

  it('active_runway needs the end in both lists', () => {
    expect(evaluateCheck(makeState([], { active: { departing: ['31'], landing: ['31'] } }), 'active_runway:31')).toBe(true);
    expect(evaluateCheck(makeState([], { active: { departing: ['13'], landing: ['31'] } }), 'active_runway:31')).toBe(false);
  });

  it('every check string used by the catalogue is a known predicate', () => {
    for (const sum of listScenarioSummaries()) {
      const sc = game.buildScenario(sum.id, airport);
      for (const o of sc.objectives ?? []) expect(isKnownCheck(o.check), `${sum.id}: ${o.check}`).toBe(true);
      for (const st of (sc.training?.steps ?? []) as { check?: string }[]) if (st.check) expect(isKnownCheck(st.check), `${sum.id}: ${st.check}`).toBe(true);
    }
  });

  it('allObjectivesDone ignores scenarios that only have guard objectives and needs every objective', () => {
    const guards = { objectives: [{ id: 'a', text: 'a', check: 'no_incursions' }] };
    expect(allObjectivesDone(makeState([], { scenario: guards }))).toBe(false);
    const two = { objectives: [{ id: 'a', text: 'a', check: 'no_incursions' }, { id: 'b', text: 'b', check: 'cmd:LAND:X1' }] };
    expect(allObjectivesDone(makeState([], { scenario: two }))).toBe(false);
    expect(allObjectivesDone(makeState([{ kind: 'COMMAND_ACCEPTED', callsign: 'X1', data: { kind: 'LAND' } }], { scenario: two }))).toBe(true);
    expect(allObjectivesDone(makeState([{ kind: 'COMMAND_ACCEPTED', callsign: 'X1', data: { kind: 'LAND' } }], { scenario: two, score: { runwayIncursions: 1 } }))).toBe(false);
    expect(evaluateObjectives(makeState([], { scenario: two })).map((o) => o.completed)).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// Debrief
// ---------------------------------------------------------------------------
describe('buildDebrief', () => {
  const sc = { id: 'career-04-multiple-departures', name: '4. Multiple departures', mode: 'career' } as Scenario;

  it('grades by score and caps at C after a runway incursion', () => {
    expect(gradeFor(95)).toBe('A');
    expect(gradeFor(90)).toBe('A');
    expect(gradeFor(89.9)).toBe('B');
    expect(gradeFor(80)).toBe('B');
    expect(gradeFor(79)).toBe('C');
    expect(gradeFor(70)).toBe('C');
    expect(gradeFor(69)).toBe('D');
    expect(gradeFor(60)).toBe('D');
    expect(gradeFor(59)).toBe('F');
    expect(gradeFor(100, 1)).toBe('C');
    expect(gradeFor(85, 2)).toBe('C');
    expect(gradeFor(65, 1)).toBe('D');
    expect(gradeFor(10, 1)).toBe('F');
    const s = makeState([], { scenario: sc, score: { score: 95, runwayIncursions: 1 } });
    const r = game.buildDebrief(s);
    expect(r.grade).toBe('C');
    expect(r.summary).toMatch(/caps the grade at C/);
  });

  it('writes concrete improvements from counters and events', () => {
    const events: Partial<SimEvent>[] = [
      { kind: 'CONFLICT', callsign: 'N88PL', timeSec: 40, severity: 'critical', text: 'Unsafe clearance issued: Takeoff clearance for N88PL on runway 13/31 while it is occupied by N412KB', data: { alertKind: 'UNSAFE_CLEARANCE' } },
      { kind: 'CONFLICT', callsign: 'N88PL', timeSec: 45, severity: 'critical', text: 'Unsafe clearance issued: Takeoff clearance for N88PL while N412KB is cleared for takeoff / rolling on runway 13/31', data: { alertKind: 'UNSAFE_CLEARANCE' } },
      { kind: 'CONFLICT', callsign: 'NKS1', timeSec: 90, severity: 'critical', text: 'Unsafe clearance issued: Landing clearance for NKS1 on runway 13/31 while it is occupied by N412KB', data: { alertKind: 'UNSAFE_CLEARANCE' } },
      { kind: 'RUNWAY_INCURSION', callsign: 'N301AC', timeSec: 100, severity: 'critical', text: 'N301AC is on runway 4/22 without a clearance' },
      { kind: 'SEPARATION_VIOLATION', callsign: 'NKS1', timeSec: 120, severity: 'warning', text: 'NKS1 and N48KT: 1.2 nm, 100 ft' },
      { kind: 'READBACK_ERROR', callsign: 'N1', timeSec: 130, severity: 'warning', text: 'Missed readback error from N1: said "runway two two", should be "runway one three"', data: { missed: true } },
      { kind: 'COMMAND_REJECTED', callsign: 'N1', timeSec: 140, severity: 'warning', text: 'Not on frequency: N1 is on 121.900', data: { commError: true } },
      { kind: 'CLARIFICATION', timeSec: 150, severity: 'info', text: 'No callsign recognised. Say the aircraft callsign.', data: { commError: true } },
      { kind: 'GO_AROUND', callsign: 'NKS2', timeSec: 160, severity: 'warning', text: 'NKS2 going around: no landing clearance' },
    ];
    const score: Partial<ScoreCard> = { score: 20, unsafeInstructions: 3, runwayIncursions: 1, separationViolations: 1, missedReadbackErrors: 1, communicationErrors: 2, aircraftHandled: 2, correctClearances: 4, averageWaitSec: 95, totalDelaySec: 80 };
    const s = makeState(events, { scenario: { ...sc, objectives: [{ id: 'o1', text: 'N412KB takes off', check: 'takeoff:N412KB' }] }, score });
    const r = game.buildDebrief(s);
    const text = r.improvements.join('\n');
    expect(r.grade).toBe('F');
    expect(text).toMatch(/You issued 2 takeoff clearances while the runway was occupied/);
    expect(text).toMatch(/3-9-6 Same Runway Separation/);
    expect(text).toMatch(/1 landing clearance/);
    expect(text).toMatch(/3-10-5 Landing Clearance/);
    expect(text).toMatch(/1 runway incursion \(N301AC\)/);
    expect(text).toMatch(/3-7-2 Taxi and Ground Movement Operations/);
    expect(text).toMatch(/readback of all runway holding instructions/);
    expect(text).toMatch(/1 loss of separation/);
    expect(text).toMatch(/1 incorrect readback went uncorrected/);
    expect(text).toMatch(/2-4-3 Pilot Acknowledgment\/Read Back/);
    expect(text).toMatch(/2 communication errors/);
    expect(text).toMatch(/another frequency/);
    expect(text).toMatch(/NKS2 had to go around/);
    expect(text).toMatch(/waited 95 s on average/);
    expect(text).toMatch(/Objective not completed: N412KB takes off/);
    expect(r.objectives).toEqual([{ id: 'o1', text: 'N412KB takes off', completed: false }]);
    expect(r.completed).toBe(false);
    // timeline keeps the important moments, in order
    expect(r.timeline.length).toBe(events.length);
    expect(r.timeline.map((t) => t.timeSec)).toEqual(r.timeline.map((t) => t.timeSec).sort((a, b) => a - b));
    expect(r.timeline.find((t) => t.kind === 'RUNWAY_INCURSION')).toMatchObject({ severity: 'critical', callsign: 'N301AC' });
  });

  it('is positive, and filters/offsets by startedAtSec', () => {
    const events: Partial<SimEvent>[] = [
      { kind: 'TRANSMISSION', timeSec: 5, text: 'x', speaker: 'ATC' },
      { kind: 'COMMAND_ACCEPTED', timeSec: 50, callsign: 'A', text: 'A: TAKEOFF', data: { kind: 'TAKEOFF', scored: true } },
      { kind: 'COMMAND_ACCEPTED', timeSec: 70, callsign: 'B', text: 'B: LAND', data: { kind: 'LAND', scored: true } },
      { kind: 'HANDOFF', timeSec: 80, callsign: 'B', text: 'B changed to 121.900' },
    ];
    const s = makeState(events, { scenario: sc, score: { score: 100, aircraftHandled: 1, correctClearances: 2 } });
    s.events.forEach((e, i) => (e.timeSec = [5, 50, 70, 80][i]));
    const r = game.buildDebrief(s, 60);
    expect(r.durationSec).toBe(40);
    expect(r.timeline.map((t) => [t.timeSec, t.kind])).toEqual([[10, 'COMMAND_ACCEPTED'], [20, 'HANDOFF']]);
    expect(r.improvements[0]).toMatch(/No safety issues/);
    expect(r.grade).toBe('A');
    expect(r.summary).toMatch(/grade A/);
    expect(r.scenarioId).toBe(sc.id);
  });

  it('flags a completed training lesson with the disclaimer', () => {
    const s = makeState([], { scenario: { id: 'train-01-phraseology', name: 'T1', mode: 'training' } });
    expect(game.buildDebrief(s).summary).toMatch(/NOT air traffic control training/);
  });

  it('builds a real report from an engine session (unsafe takeoff really recorded)', () => {
    const scn = game.buildScenario('career-04-multiple-departures', airport);
    const e = createEngine({ airport, scenario: scn, readbackErrorRate: 0 });
    run(e, 6);
    expect(accepted(say(e, 'Cessna eight eight papa lima, runway one three, cleared for takeoff'))).toBe(true);
    say(e, 'Cessna four one two kilo bravo, runway one three, cleared for takeoff');
    run(e, 30);
    const r = game.buildDebrief(e.getState());
    expect(r.score.unsafeInstructions).toBeGreaterThanOrEqual(1);
    expect(r.improvements.join(' ')).toMatch(/You issued \d+ takeoff clearances? while the runway was occupied/);
    expect(r.timeline.some((t) => t.kind === 'CONFLICT')).toBe(true);
    expect(r.objectives).toHaveLength(5);
    expect(r.completed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Career persistence
// ---------------------------------------------------------------------------
class FakeStorage {
  data = new Map<string, string>();
  fail = false;
  getItem(k: string): string | null {
    if (this.fail) throw new Error('blocked');
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.fail) throw new Error('quota');
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

function report(over: Omit<Partial<DebriefReport>, 'score'> & { score?: Partial<ScoreCard> } = {}): DebriefReport {
  const { score, ...rest } = over;
  return {
    scenarioId: 'career-01-first-radio', scenarioName: 'x', durationSec: 60, score: { ...newScoreCard(), score: 92, ...score }, grade: 'A',
    summary: '', improvements: [], timeline: [], objectives: [], completed: true, ...rest,
  };
}

describe('career persistence', () => {
  const g = globalThis as { localStorage?: unknown };
  let store: FakeStorage;
  beforeEach(() => {
    store = new FakeStorage();
    g.localStorage = store;
  });
  afterEach(() => {
    delete g.localStorage;
  });

  it('starts fresh', () => {
    expect(game.loadCareerProgress()).toEqual({ completedSteps: [], bestScores: {}, unlockedStep: 1 });
  });

  it('unlocks the next step on a completed C-or-better result and persists under kacy.career', () => {
    const p = game.saveCareerResult('career-01-first-radio', report());
    expect(p).toEqual({ completedSteps: [1], bestScores: { 'career-01-first-radio': 92 }, unlockedStep: 2 });
    expect(JSON.parse(store.data.get(CAREER_STORAGE_KEY)!)).toEqual(p);
    expect(CAREER_STORAGE_KEY).toBe('kacy.career');
    expect(game.loadCareerProgress()).toEqual(p);
  });

  it('does not unlock for D/F, incomplete runs, training or free play; keeps best score', () => {
    game.saveCareerResult('career-02-single-takeoff', report({ grade: 'D', score: { score: 65 } }));
    expect(game.loadCareerProgress()).toMatchObject({ completedSteps: [], unlockedStep: 1, bestScores: { 'career-02-single-takeoff': 65 } });
    game.saveCareerResult('career-02-single-takeoff', report({ grade: 'A', completed: false, score: { score: 50 } }));
    expect(game.loadCareerProgress().completedSteps).toEqual([]);
    game.saveCareerResult('train-01-phraseology', report({ score: { score: 40 } }));
    game.saveCareerResult('free-play', report({ score: { score: 40 } }));
    expect(game.loadCareerProgress().completedSteps).toEqual([]);
    expect(game.loadCareerProgress().unlockedStep).toBe(1);
    game.saveCareerResult('career-02-single-takeoff', report({ grade: 'C', score: { score: 71 } }));
    game.saveCareerResult('career-02-single-takeoff', report({ grade: 'C', score: { score: 60 } }));
    const p = game.loadCareerProgress();
    expect(p.bestScores['career-02-single-takeoff']).toBe(71);
    expect(p.completedSteps).toEqual([2]);
    expect(p.unlockedStep).toBe(3);
  });

  it('never unlocks beyond step 12 and never moves backwards', () => {
    game.saveCareerResult('career-12-emergency', report());
    expect(game.loadCareerProgress()).toMatchObject({ completedSteps: [12], unlockedStep: 12 });
    game.saveCareerResult('career-01-first-radio', report());
    expect(game.loadCareerProgress().unlockedStep).toBe(12);
    expect(careerStepOf('career-07-arrivals-departures')).toBe(7);
    expect(careerStepOf('free-play')).toBeUndefined();
  });

  it('survives corrupt data and blocked storage', () => {
    store.data.set(CAREER_STORAGE_KEY, '{not json');
    expect(game.loadCareerProgress()).toEqual({ completedSteps: [], bestScores: {}, unlockedStep: 1 });
    store.data.set(CAREER_STORAGE_KEY, JSON.stringify({ completedSteps: [3, 3, 99, 'x'], bestScores: { a: 5, b: 'x' }, unlockedStep: 'nope' }));
    expect(game.loadCareerProgress()).toEqual({ completedSteps: [3], bestScores: { a: 5 }, unlockedStep: 4 });
    store.fail = true;
    expect(() => game.loadCareerProgress()).not.toThrow();
    expect(() => game.saveCareerResult('career-01-first-radio', report())).not.toThrow();
  });
});

describe('career without localStorage (Node)', () => {
  it('works in memory', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => game.loadCareerProgress()).not.toThrow();
    const p = game.saveCareerResult('career-03-single-landing', report());
    expect(p.completedSteps).toContain(3);
    expect(game.loadCareerProgress().completedSteps).toContain(3);
  });
});

// ---------------------------------------------------------------------------
// isScenarioComplete
// ---------------------------------------------------------------------------
describe('isScenarioComplete', () => {
  it('true when objectives are done, or duration elapsed, or engine flagged it', () => {
    const objs = { objectives: [{ id: 'a', text: 'a', check: 'cmd:LAND:X1' }], durationSec: 600 };
    expect(game.isScenarioComplete(makeState([], { scenario: objs }))).toBe(false);
    expect(game.isScenarioComplete(makeState([{ kind: 'COMMAND_ACCEPTED', callsign: 'X1', data: { kind: 'LAND' } }], { scenario: objs }))).toBe(true);
    const s = makeState([], { scenario: objs });
    s.clock.timeSec = 600;
    expect(game.isScenarioComplete(s)).toBe(true);
    expect(game.isScenarioComplete(makeState([], { scenario: { mode: 'career' }, score: { scenarioCompleted: true } }))).toBe(true);
    expect(game.isScenarioComplete(makeState([], { scenario: { mode: 'free_play' }, score: { scenarioCompleted: true } }))).toBe(false);
    expect(game.isScenarioComplete(makeState([], { scenario: { mode: 'free_play' } }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario events: weather schedule and the emergency
// ---------------------------------------------------------------------------
describe('scenario events', () => {
  it('exposes the career 10 wind shift as a weather schedule', () => {
    const sc = game.buildScenario('career-10-runway-change', airport);
    const sched = scenarioWeatherSchedule(sc);
    expect(sched).toHaveLength(1);
    expect(sched[0].atSec).toBe(600);
    expect(sched[0].weather.windDirDeg).toBe(300);
    expect(sched[0].recommendedRunways).toEqual({ departing: ['31'], landing: ['31'] });
    expect(scenarioWeatherSchedule(game.buildScenario('career-03-single-landing', airport))).toEqual([]);
    // initial weather favours 13, new weather favours 31 (magnetic = true + 10)
    const w0 = sc.weather as Weather;
    expect(w0.windDirDeg).toBe(130);
  });

  it('the runner applies the wind shift at its time; the player then switches runways', () => {
    const sc = game.buildScenario('career-10-runway-change', airport);
    const engine = createEngine({ airport, scenario: sc, readbackErrorRate: 0 });
    const applied: string[] = [];
    const runner = createScenarioEventRunner(engine, sc, { onEvent: (e) => applied.push(e.kind) });
    expect(runner.pending).toBe(2);
    for (let i = 0; i < 5500; i++) {
      engine.step();
      runner.update();
    }
    expect(engine.getState().clock.timeSec).toBeLessThan(600);
    expect(applied).toEqual(['message']);
    expect(engine.getState().weather.windDirDeg).toBe(130);
    for (let i = 0; i < 600; i++) {
      engine.step();
      runner.update();
    }
    expect(applied).toEqual(['message', 'weather']);
    expect(runner.pending).toBe(0);
    expect(engine.getState().weather.windDirDeg).toBe(300);
    expect(engine.getState().events.some((e) => e.kind === 'SCENARIO' && e.data?.weatherChange === true)).toBe(true);
    expect(evaluateCheck(engine.getState(), 'active_runway:31')).toBe(false);
    engine.setActiveRunways({ departing: ['31'], landing: ['31'] });
    expect(evaluateCheck(engine.getState(), 'active_runway:31')).toBe(true);
    // The runway 31 traffic is there: an arrival on the 31 final and a departure at the 31 hold.
    for (let i = 0; i < 1000; i++) engine.step();
    const st = engine.getState();
    const cs = Object.values(st.aircraft).map((a) => a.callsign);
    expect(cs).toContain('N90LE');
    expect(st.events.some((e) => e.kind === 'SPAWN' && e.callsign === 'AAL1004')).toBe(true);
  });

  it('career 12: the emergency is declared by the event system and can be resolved', () => {
    const sc = game.buildScenario('career-12-emergency', airport);
    const engine = createEngine({ airport, scenario: sc, readbackErrorRate: 0 });
    const spoken: string[] = [];
    const runner = createScenarioEventRunner(engine, sc, { onPilotTransmission: (t) => spoken.push(`${t.callsign}: ${t.text}`) });
    const tick = (sec: number): void => {
      for (let i = 0; i < sec * 10; i++) {
        engine.step();
        runner.update();
      }
    };
    tick(18);
    const before = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'NKS1180')!;
    expect(before.flags.emergency).toBeFalsy();
    tick(6);
    const nks = Object.values(engine.getState().aircraft).find((a) => a.callsign === 'NKS1180')!;
    expect(nks.flags.emergency).toBe(true);
    expect(nks.pendingRequest?.text).toMatch(/^PAN-PAN/);
    expect(spoken.some((t) => t.startsWith('NKS1180: Pan-pan, pan-pan, pan-pan'))).toBe(true);
    expect(engine.getState().events.some((e) => e.kind === 'TRANSMISSION' && e.speaker === 'PILOT' && e.data?.emergency === true)).toBe(true);
    expect(runner.pending).toBe(0);

    // Priority handling: send the other airliner around, give the emergency aircraft the landing clearance.
    expect(accepted(say(engine, 'American fifteen ninety, go around', 'TWR'))).toBe(true);
    expect(accepted(say(engine, 'Spirit eleven eighty, runway one three, cleared to land'))).toBe(true);
    expect(runUntil(engine, (s) => evaluateCheck(s, 'landed:NKS1180'), 420)).toBe(true);
    const st = engine.getState();
    expect(evaluateCheck(st, 'landed_before:NKS1180:AAL1590')).toBe(true);
    expect(evaluateCheck(st, 'landed_before:NKS1180:N305SP')).toBe(true);
    expect(evaluateCheck(st, 'cmd:LAND:NKS1180')).toBe(true);
    expect(game.buildDebrief(st).objectives.filter((o) => o.completed).length).toBeGreaterThanOrEqual(3);
  });
});
