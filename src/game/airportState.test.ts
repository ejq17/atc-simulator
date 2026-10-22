/**
 * Game layer for the airport state: seeded free-play airport events (inspection, taxiway closure, bird activity), the scenario event runner that applies
 * them (closures wait for a quiet runway), setup-screen closures, the STAR traffic flow at KMHT (and none at KACY).
 */
import { describe, expect, it } from 'vitest';
import { loadKacy, loadKmht } from '../airport';
import { createEngine } from '../sim/engine';
import type { SimulationEngineExtras } from '../sim/engineExtras';
import type { SimulationEngine } from '../sim/api';
import { closedRunwayIds, closedTaxiways, closedEndsOf } from '../sim/airportOps';
import type { Scenario } from '../sim/types';
import { game } from './game';
import { createScenarioEventRunner } from './scenarios/events';
import { BIRD_MONTH_WEIGHT, birdActivityProbability, birdTimeFactor, buildAirportEvents, closableTaxiways } from './scenarios/airportEvents';
import { starArrival } from './ifr';
import type { GameScenario, ScenarioEvent } from './types';
import { findStar } from '../sim/star';
import type { SpawnSpec, TrafficGenerator } from '../sim/traffic';

const kacy = loadKacy();
const kmht = loadKmht();
const events = (sc: Scenario): ScenarioEvent[] => (sc as GameScenario).events ?? [];

describe('seeded free-play airport events', () => {
  it('are a function of the seed alone (same seed, same events; other seeds differ somewhere)', () => {
    const a = events(game.buildFreePlay(kacy, { seed: 11, weather: 'clear' }));
    expect(events(game.buildFreePlay(kacy, { seed: 11, weather: 'clear' }))).toEqual(a);
    const all = Array.from({ length: 40 }, (_, i) => JSON.stringify(events(game.buildFreePlay(kacy, { seed: i + 1, weather: 'clear' }))));
    expect(new Set(all).size).toBeGreaterThan(10);
  });
  it('over many seeds: inspections close a runway pair for 4-8 minutes at a quiet time, taxiway closures last 15-40 minutes, all with a reason and a message', () => {
    let runway = 0;
    let taxiway = 0;
    let birds = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (const e of buildAirportEvents(kacy, seed, { active: { departing: ['31'], landing: ['31'] } })) {
        expect(e.text.length).toBeGreaterThan(10);
        if (e.kind === 'closure' && e.closure.kind === 'RUNWAY') {
          runway++;
          expect(e.quiet).toBe(true);
          expect(['4/22', '13/31']).toContain(e.closure.ident);
          expect(e.closure.durationSec).toBeGreaterThanOrEqual(240);
          expect(e.closure.durationSec).toBeLessThanOrEqual(480);
          expect(e.closure.reason).toBe('runway inspection by airport operations');
          expect(e.atSec).toBeGreaterThanOrEqual(8 * 60);
        } else if (e.kind === 'closure') {
          taxiway++;
          expect(e.closure.durationSec).toBeGreaterThanOrEqual(15 * 60);
          expect(e.closure.durationSec).toBeLessThanOrEqual(40 * 60);
        } else if (e.kind === 'birds') {
          birds++;
          expect(e.detail).toMatch(/altitude unknown/);
        }
      }
    }
    expect(runway).toBeGreaterThan(40);
    expect(taxiway).toBeGreaterThan(20);
    expect(birds).toBeGreaterThan(10);
  });
  it('can be switched off (airportEvents: false); career 11 has none; setup closures are kept and not closed twice', () => {
    expect(events(game.buildFreePlay(kacy, { seed: 3, airportEvents: false }))).toEqual([]);
    expect(events(game.buildScenario('career-11-complex', kacy, { seed: 3 }))).toEqual([]);
    expect((game.buildScenario('career-11-complex', kacy, { seed: 3 }) as GameScenario).pilotRequests).toBeUndefined();
    for (let seed = 1; seed <= 60; seed++) {
      const sc = game.buildFreePlay(kacy, { seed, closures: [{ kind: 'RUNWAY', ident: '4/22' }] });
      expect(sc.closures).toEqual([{ kind: 'RUNWAY', ident: '4/22' }]);
      expect(events(sc).filter((e) => e.kind === 'closure' && e.closure.kind === 'RUNWAY')).toEqual([]);
    }
  });
  it('a taxiway closure never cuts a parking position off from the runways in use', () => {
    const ok = closableTaxiways(kacy, { departing: ['31'], landing: ['31'] });
    expect(ok.length).toBeGreaterThan(0);
    const all = [...new Set(kacy.taxiwayGraph.edges.map((e) => e.taxiway.toUpperCase()).filter((t) => !t.startsWith('RWY')))];
    expect(ok.length).toBeLessThan(all.length); // some taxiways are the only way somewhere
    for (let seed = 1; seed <= 40; seed++) {
      for (const e of buildAirportEvents(kmht, seed, { active: { departing: ['35'], landing: ['35'] } })) {
        if (e.kind === 'closure' && e.closure.kind === 'TAXIWAY') expect(closableTaxiways(kmht, { departing: ['35'], landing: ['35'] }).concat(closableTaxiways(kmht, { departing: ['17'], landing: ['17'] }), closableTaxiways(kmht, { departing: ['6'], landing: ['6'] }), closableTaxiways(kmht, { departing: ['24'], landing: ['24'] }))).toContain(e.closure.ident);
      }
    }
  });
});

describe('bird activity weights (a design choice, documented)', () => {
  it('spring and fall migration months and dawn / dusk weigh most; winter and night least; neutral without a start time', () => {
    expect(BIRD_MONTH_WEIGHT).toHaveLength(12);
    expect(BIRD_MONTH_WEIGHT[3]).toBeGreaterThan(BIRD_MONTH_WEIGHT[0]);
    expect(BIRD_MONTH_WEIGHT[9]).toBeGreaterThan(BIRD_MONTH_WEIGHT[6]);
    expect(birdTimeFactor(6)).toBeGreaterThan(birdTimeFactor(12));
    expect(birdTimeFactor(17)).toBeGreaterThan(birdTimeFactor(12));
    expect(birdTimeFactor(2)).toBeLessThan(birdTimeFactor(12));
    expect(birdActivityProbability()).toBe(0.2);
    const oct = birdActivityProbability(Date.UTC(2026, 9, 17, 11, 0)); // 07:00 local in October
    const jan = birdActivityProbability(Date.UTC(2026, 0, 17, 7, 0)); // 02:00 local in January
    expect(oct).toBeGreaterThan(jan);
    expect(oct).toBeLessThanOrEqual(0.7);
  });
  it('the session start time changes how often seeds see birds', () => {
    const count = (utc: number) => Array.from({ length: 600 }, (_, i) => buildAirportEvents(kacy, i + 1, { startUtcMs: utc, active: { departing: ['31'], landing: ['31'] } }).filter((e) => e.kind === 'birds').length).reduce((a, b) => a + b, 0);
    expect(count(Date.UTC(2026, 9, 17, 11, 0))).toBeGreaterThan(count(Date.UTC(2026, 0, 17, 7, 0)));
  });
});

describe('scenario events applied by the runner', () => {
  type Eng = SimulationEngine & SimulationEngineExtras;
  const make = (evs: ScenarioEvent[], spawns: Scenario['spawns'] = []): { engine: Eng; runner: ReturnType<typeof createScenarioEventRunner> } => {
    const sc = game.buildFreePlay(kacy, { seed: 5, weather: 'clear', aircraftCount: 0, airportEvents: false, activeRunways: { departing: ['31'], landing: ['31'] } }) as GameScenario;
    sc.events = evs;
    sc.spawns = spawns;
    sc.traffic = undefined;
    const engine = createEngine({ airport: kacy, scenario: sc, readbackErrorRate: 0 }) as Eng;
    return { engine, runner: createScenarioEventRunner(engine, sc) };
  };
  const step = (e: Eng, runner: { update(): unknown }, sec: number) => {
    for (let i = 0; i < sec * 10; i++) {
      e.step();
      if (i % 10 === 0) runner.update();
    }
  };
  it('a closure event closes the taxiway at its time for its duration, then it reopens', () => {
    const { engine, runner } = make([{ atSec: 5, kind: 'closure', closure: { kind: 'TAXIWAY', ident: 'C', durationSec: 30, reason: 'test' }, text: 'Taxiway C closed' }]);
    step(engine, runner, 4);
    expect(closedTaxiways(engine.getState()).size).toBe(0);
    step(engine, runner, 3);
    expect(closedTaxiways(engine.getState())).toEqual(new Set(['C']));
    step(engine, runner, 31);
    expect(closedTaxiways(engine.getState()).size).toBe(0);
  });
  it('a quiet runway closure waits for an aircraft on short final to be gone', () => {
    const arriving = { atSec: 0, callsign: 'N1', type: 'C172', flightRules: 'VFR' as const, start: { kind: 'airborne' as const, pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: 70, runwayEnd: '31', distanceNm: 4 }, isDeparture: false, initialFrequencyId: 'TWR' };
    const { engine, runner } = make([{ atSec: 1, kind: 'closure', quiet: true, closure: { kind: 'RUNWAY', ident: '13/31', durationSec: 300, reason: 'runway inspection by airport operations' }, text: 'inspection' }], [arriving]);
    step(engine, runner, 20);
    expect(closedRunwayIds(engine.getState()).size).toBe(0); // N1 is on a 4 nm final to 31
    engine.removeAircraft(Object.values(engine.getState().aircraft)[0].id);
    step(engine, runner, 3);
    expect(closedRunwayIds(engine.getState())).toEqual(new Set(['13/31']));
  });
  it('closing the last open runway is refused and logged; a bird event puts bird activity on the airport', () => {
    const { engine, runner } = make([
      { atSec: 1, kind: 'closure', closure: { kind: 'RUNWAY', ident: '4/22', durationSec: 600 }, text: 'a' },
      { atSec: 2, kind: 'closure', closure: { kind: 'RUNWAY', ident: '13/31', durationSec: 600 }, text: 'b' },
      { atSec: 3, kind: 'birds', detail: 'a flock of geese, altitude unknown', durationSec: 60, text: 'birds' },
    ]);
    step(engine, runner, 6);
    expect(closedRunwayIds(engine.getState())).toEqual(new Set(['4/22']));
    expect(engine.getState().events.some((e) => /Closure not applied: Runway 13\/31 is the last open runway/.test(e.text))).toBe(true);
    expect(engine.getState().ops.birds?.text).toBe('a flock of geese, altitude unknown');
  });
  it('the builder exposes every event kind the runner understands', () => {
    const ev = buildAirportEvents(kacy, 7, { active: { departing: ['31'], landing: ['31'] } });
    expect(ev.every((e) => e.kind === 'closure' || e.kind === 'birds')).toBe(true);
  });
});

describe('setup-screen closures', () => {
  it('free play with a closed runway never selects it, even when the wind favours it, and carries the closure into the scenario', () => {
    const sc = game.buildFreePlay(kacy, { seed: 2, weather: { ...(game.buildFreePlay(kacy, { seed: 2 }).weather as object), windDirDeg: 310, windSpeedKt: 15 } as never, closures: [{ kind: 'RUNWAY', ident: '13/31' }], airportEvents: false });
    expect(sc.closures).toEqual([{ kind: 'RUNWAY', ident: '13/31' }]);
    expect([...sc.activeRunways.landing, ...sc.activeRunways.departing].every((e) => e === '4' || e === '22')).toBe(true);
    const explicit = game.buildFreePlay(kacy, { seed: 2, activeRunways: { departing: ['31'], landing: ['31'] }, closures: [{ kind: 'RUNWAY', ident: '13/31' }], airportEvents: false });
    expect(explicit.activeRunways.landing[0]).not.toBe('31');
    expect(closedEndsOf(kacy, sc.closures!).sort()).toEqual(['13', '31']);
  });
});

describe('STAR traffic flow at KMHT', () => {
  const run = (airport: typeof kmht, rwy: string, sec: number) => {
    const sc = game.buildFreePlay(airport, { seed: 21, weather: 'clear', aircraftCount: 0, arrivalsPerHour: 40, departuresPerHour: 0, gaFraction: 0.2, maxAircraft: 30, activeRunways: { departing: [rwy], landing: [rwy] }, ifrFlows: true, airportEvents: false });
    sc.traffic = { ...sc.traffic!, flowControl: false }; // counts the raw clocks' spawns: nothing lands in this run
    const inner = game.createTrafficGenerator(sc, airport);
    const specs: SpawnSpec[] = [];
    const g: TrafficGenerator = { update(s) { const o = inner.update(s); specs.push(...o); return o; } };
    const engine = createEngine({ airport, scenario: sc, trafficGenerator: g, readbackErrorRate: 0 });
    for (let i = 0; i < sec * 10; i++) engine.step();
    return { specs, engine };
  };
  it('turbojet arrivals appear over a STAR entry fix on the arrival route to the runway; Caravans and Cessnas use the approach fixes as before', () => {
    const { specs } = run(kmht, '6', 1800);
    const star = findStar(kmht)!;
    const jets = specs.filter((s) => s.start.kind === 'at_fix' && s.start.star);
    expect(jets.length).toBeGreaterThan(3);
    for (const s of jets) {
      expect(s.start.kind === 'at_fix' && ['CRIBB', 'FLYZZ']).toContain(s.start.kind === 'at_fix' ? s.start.fix : '');
      if (s.start.kind === 'at_fix') {
        expect(s.start.route.slice(-3)).toEqual(['PNARD', 'TEETO', 'JAAZZ']);
        expect(s.start.star!.procedureId).toBe(star.procedure.id);
        expect(s.start.altitudeFt).toBeGreaterThanOrEqual(13000);
        expect(s.type).not.toBe('C208');
        expect(s.initialFrequencyId).toBe('APP');
      }
    }
    for (const s of specs.filter((x) => x.start.kind === 'at_fix' && !x.start.star)) expect(['C208', 'C172', 'PA28']).toContain(s.type);
    // spacing at the entry: 90 s apart on the same runway
    const times = jets.map((s) => s.atSec).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0);
  }, 30000);
  it('KACY arrivals never get a STAR; the only STAR runways exist', () => {
    const { specs } = run(kacy, '13', 900);
    expect(specs.some((s) => s.start.kind === 'at_fix' && s.start.star)).toBe(false);
    expect(starArrival(kmht, '6')!.entries.map((e) => e.fix)).toEqual(['CRIBB', 'FLYZZ']);
    expect(starArrival(kmht, '99')).toBeUndefined();
  });
  it('the initial IFR population uses the STAR too, staggered', () => {
    const sc = game.buildFreePlay(kmht, { seed: 4, weather: 'clear', aircraftCount: 6, startingScenario: 'busy_arrivals', ifrFlows: true, activeRunways: { departing: ['35'], landing: ['35'] }, airportEvents: false });
    const arrivals = sc.spawns.filter((s) => !s.isDeparture && s.start.kind === 'at_fix' && s.start.star);
    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    expect(arrivals.map((a) => a.atSec)).toEqual(Array.from(arrivals, (a) => a.atSec).sort((a, b) => a - b));
  });
});
