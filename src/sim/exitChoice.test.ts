/**
 * Which runway exit an arrival gets (JO 7110.65 3-10-9; exitChoice.ts, flightDynamics.chooseExit).
 *
 * The report: at KACY the AI Tower turned arrivals "right on Bravo, the complete opposite way from the ramp", or into the planes waiting on the taxiway.
 * The old rule took the first exit the aircraft could make whose hold line was connected to ANY parking position (the Air National Guard ramp
 * included) without a runway crossing, and picked the side of that exit by the distance to the nearest parking of any kind. `legacyChoice` below is that
 * rule, kept in the test so the measurement is repeatable; the tests compare it with the preference rule on the real KACY and KMHT data.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { Aircraft, Airport, ParkingPosition, SimulationState } from './types';
import { loadKacy, loadKmht } from '../airport';
import { ARRIVING, HOLDING, cmd, find, makeScenario, run, runUntil, say } from './__fixtures__/testHelpers';
import { alongCross, findRunwayEnd } from './runways';
import { getPerformance } from './performance';
import { predictRolloutPlan, rolloutExitOptions } from './flightDynamics';
import type { ScoredExit } from './flightDynamics';
import { shortestDistances } from './pathfinding';
import { dist, ktToMps } from './geo';
import { CROSSING_COST_M, EXIT_STUB_M, arrivalParkingTargets, exitBlockage, holdToParking, stubNodes } from './exitChoice';

const kacy = loadKacy();
const kmht = loadKmht();

function world(airport: Airport, rwy: string, spawns = [] as ReturnType<typeof ARRIVING>[]): SimulationEngine {
  return createEngine({ airport, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [rwy], landing: [rwy] }, spawns }) });
}

const TYPES: { type: string; category: ParkingPosition['category'] }[] = [
  { type: 'C172', category: 'ga' },
  { type: 'A320', category: 'airline' },
  // a Caravan (FedEx feeder) sent to the cargo apron by Ground: Tower predicts the GA ramp, as it cannot know (see the landline request for that)
  { type: 'C208', category: 'cargo' },
];

/** A fake arrival of `type` for the pure predictions (no callsign: it is nobody's parking). */
const fake = (type: string): Aircraft => ({ id: 'probe', type, callsign: 'N1PROBE', onGround: false, phase: 'FINAL', isDeparture: false, occupyingRunways: [] } as unknown as Aircraft);

function touchdown(g: NonNullable<ReturnType<typeof findRunwayEnd>>, type: string): { along: number; v: number } {
  const perf = getPerformance(type);
  return { along: g.displacedM + (perf.category === 'light' ? 390 : 490), v: ktToMps(perf.touchdownSpeedKt) };
}

/** The exit the engine used to take: first reachable, hold line connected to some parking without a crossing, side by distance to the nearest of any parking. */
function legacyChoice(airport: Airport, options: ScoredExit[]): ScoredExit | undefined {
  const graph = airport.taxiwayGraph;
  const anyCost = (hold: string): number => {
    const dm = shortestDistances(graph, hold);
    return Math.min(...airport.parking.map((p) => dm.get(p.nodeId) ?? Infinity));
  };
  const byExit = new Map<string, ScoredExit[]>();
  for (const o of options) byExit.set(o.exitNodeId, [...(byExit.get(o.exitNodeId) ?? []), o]);
  const exits = [...byExit.values()].sort((a, b) => a[0].along - b[0].along);
  let firstAny: ScoredExit | undefined;
  for (const holds of exits) {
    const pick = holds.reduce((m, o) => (anyCost(o.holdNodeId) < anyCost(m.holdNodeId) ? o : m));
    if (Number.isFinite(anyCost(pick.holdNodeId))) return pick;
    firstAny ??= pick;
  }
  return firstAny;
}

interface Measure { hold: string; side: string; taxiM: number; crossings: number; cost: number }

function measure(state: SimulationState, o: ScoredExit, targets: ParkingPosition[]): Measure {
  const w = holdToParking(state, o.holdNodeId, targets);
  return { hold: o.holdNodeId, side: o.side, taxiM: Math.round(w.taxiM), crossings: w.crossings, cost: w.taxiM + w.crossings * CROSSING_COST_M };
}

describe('exit choice on the real KACY geometry: the old rule against the preference rule', () => {
  const e = world(kacy, '13');
  const state = e.getState();
  const rows: string[] = [];

  for (const end of ['13', '31', '4', '22']) {
    for (const { type, category } of TYPES) {
      it(`runway ${end}, ${type} to the ${category} apron: the chosen exit is never worse than the old one`, () => {
        const g = findRunwayEnd(kacy, end)!;
        const td = touchdown(g, type);
        const options = rolloutExitOptions(state, fake(type), g, td.along, td.v);
        expect(options.length).toBeGreaterThan(0);
        const parking = kacy.parking.filter((p) => p.category === category);
        const old = legacyChoice(kacy, options)!;
        const best = options[0]; // best-first: what the rule chooses
        const mOld = measure(state, old, parking);
        const mNew = measure(state, best, arrivalParkingTargets(state, fake(type)));
        // the best exit the aircraft could physically make to ITS parking, by taxi distance and crossings
        const cheapest = options.map((o) => measure(state, o, parking)).sort((a, b) => a.cost - b.cost)[0];
        rows.push(`${end} ${type}->${category}: old ${mOld.hold} ${mOld.side} ${mOld.taxiM} m x${mOld.crossings} | new ${mNew.hold} ${mNew.side} ${mNew.taxiM} m x${mNew.crossings} | best reachable ${cheapest.hold} ${cheapest.taxiM} m x${cheapest.crossings}`);
        // never more crossings than the old exit; the old exit is one of the options, so the preference cost can only fall
        expect(mNew.crossings).toBeLessThanOrEqual(Math.max(mOld.crossings, 0) + 0);
        expect(best.score.cost).toBeLessThanOrEqual(options.find((o) => o.holdNodeId === old.holdNodeId)!.score.cost + 1e-6);
      });
    }
  }

  it('reproduction: landing on 22 or 4 the old rule sent the C172 to the wrong side of Bravo (away from the ramp, crossing 4/22 again); now it takes the ramp side', () => {
    for (const [end, oldHold, oldSide, newHold, newSide] of [
      ['22', 'HP4-22-B-1', 'right', 'HP4-22-B-2', 'left'],
      ['4', 'HP4-22-B-1', 'left', 'HP4-22-B-2', 'right'],
    ] as const) {
      const g = findRunwayEnd(kacy, end)!;
      const td = touchdown(g, 'C172');
      const options = rolloutExitOptions(state, fake('C172'), g, td.along, td.v);
      const old = legacyChoice(kacy, options)!;
      expect([old.holdNodeId, old.side]).toEqual([oldHold, oldSide]);
      expect(holdToParking(state, old.holdNodeId, arrivalParkingTargets(state, fake('C172'))).crossings).toBe(1);
      expect([options[0].holdNodeId, options[0].side]).toEqual([newHold, newSide]);
      expect(holdToParking(state, options[0].holdNodeId, arrivalParkingTargets(state, fake('C172'))).crossings).toBe(0);
      // the ramp is east of 4/22: right of runway 4, left of runway 22
      expect(options[0].side).toBe(end === '4' ? 'right' : 'left');
    }
  });

  it('13 and 31 (ramp on the south side): the C172 and the A320 exit on the ramp side, with no crossing where the old rule chose one', () => {
    const g13 = findRunwayEnd(kacy, '13')!;
    const t = touchdown(g13, 'C172');
    const old = legacyChoice(kacy, rolloutExitOptions(state, fake('C172'), g13, t.along, t.v))!;
    expect(old.side).toBe('right'); // south of 13 is its right side: the old rule was on the right side here, with a crossing
    const best = rolloutExitOptions(state, fake('C172'), findRunwayEnd(kacy, '31')!, touchdown(findRunwayEnd(kacy, '31')!, 'C172').along, ktToMps(55))[0];
    expect(best.side).toBe('left'); // south of 31 is its left side
    expect(holdToParking(state, best.holdNodeId, arrivalParkingTargets(state, fake('C172'))).crossings).toBe(0);
  });

  it('prints the table (for docs/BEHAVIOUR-ACCURACY.md T8)', () => {
    // runs after the rows above; the table is the measurement the documentation quotes
    expect(rows.length).toBe(12);
    console.info(`exit choice, old vs new vs best reachable (taxi metres from the hold line to the nearest free spot of the category):\n${rows.join('\n')}`);
  });
});

describe('exit choice on the real KMHT geometry (four runway ends)', () => {
  const e = world(kmht, '35');
  const state = e.getState();
  for (const end of ['6', '24', '17', '35']) {
    for (const { type } of TYPES.slice(0, 2)) {
      it(`runway ${end}, ${type}: the preferred exit is reachable, deterministic, and no costlier than the old one`, () => {
        const g = findRunwayEnd(kmht, end)!;
        const td = touchdown(g, type);
        const a = rolloutExitOptions(state, fake(type), g, td.along, td.v);
        const b = rolloutExitOptions(state, fake(type), g, td.along, td.v);
        expect(a.map((o) => o.holdNodeId)).toEqual(b.map((o) => o.holdNodeId));
        expect(a.length).toBeGreaterThan(0);
        const old = legacyChoice(kmht, a)!;
        expect(a[0].score.cost).toBeLessThanOrEqual(a.find((o) => o.holdNodeId === old.holdNodeId)!.score.cost + 1e-6);
        // the engine's own default plan (what an uninstructed lander flies) is the same exit
        const plan = predictRolloutPlan(state, type, g, td.along, td.v);
        expect(plan.holdNodeId).toBe(a[0].holdNodeId);
      });
    }
  }
  it('the A320 on 35 takes Bravo on the terminal side (left) with no runway crossing, not the other side of the runway', () => {
    const g = findRunwayEnd(kmht, '35')!;
    const td = touchdown(g, 'A320');
    const best = rolloutExitOptions(state, fake('A320'), g, td.along, td.v)[0];
    expect(best.holdNodeId).toBe('HP17-35-B-1');
    expect(best.side).toBe('left');
    expect(holdToParking(state, best.holdNodeId, arrivalParkingTargets(state, fake('A320'))).crossings).toBe(0);
  });
});

describe('an occupied exit is avoided (queue on the taxiway beyond the hold line)', () => {
  /** A C172 on 22 with a departure holding short of 22 at Bravo (HP4-22-B-2): the intersection departure the report describes. */
  const setup = () => world(kacy, '22', [HOLDING('D1', 'HP4-22-B-2', '22', 'C172', 'TWR'), ARRIVING('X1', '22', 3, 'C172', 'TWR')]);

  it('the stub of the ramp-side exit is occupied by the departure; the exit choice takes another', () => {
    const e = setup();
    const state = e.getState();
    const g = findRunwayEnd(kacy, '22')!;
    const lander = find(e, 'X1');
    const way = holdToParking(state, 'HP4-22-B-2', arrivalParkingTargets(state, lander));
    const block = exitBlockage(state, lander.id, way.nodeIds);
    expect(block).toMatchObject({ callsign: 'D1', why: 'stopped' });
    expect(stubNodes(state, way.nodeIds).length).toBeGreaterThan(0);
    const td = touchdown(g, 'C172');
    const options = rolloutExitOptions(state, lander, g, td.along, td.v);
    expect(options.find((o) => o.holdNodeId === 'HP4-22-B-2')!.score.blocked?.callsign).toBe('D1');
    expect(options[0].holdNodeId).not.toBe('HP4-22-B-2');
    expect(options[0].score.blocked).toBeUndefined();
  });

  it('without an instruction the lander rolls to the free exit; told to use the occupied one it stops nose to tail behind the departure on the stub', () => {
    const free = setup();
    const ac = find(free, 'X1');
    free.applyCommand(cmd('LAND', 'X1', { runwayEnd: '22' }));
    expect(runUntil(free, () => ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.1, 600)).toBe(true);
    const freeStop = ac.route!.nodeIds.at(-1);
    expect(freeStop).not.toBe('HP4-22-B-2');
    expect(dist(ac.pos, find(free, 'D1').pos)).toBeGreaterThan(200);

    const forced = setup();
    const ac2 = find(forced, 'X1');
    forced.applyCommand(cmd('LAND', 'X1', { runwayEnd: '22' }));
    expect(say(forced, cmd('EXIT_RUNWAY', 'X1', { exitTaxiway: 'B', turnDirection: 'left' }), 'TWR').status).toBe('accepted');
    expect(runUntil(forced, () => ac2.phase === 'RUNWAY_EXIT' && ac2.groundSpeedKt < 0.1, 600)).toBe(true);
    // the conflict: stopped on the exit short of the departure's hold line, closer than the engine's own spacing
    expect(dist(ac2.pos, find(forced, 'D1').pos)).toBeLessThan(40);
    expect(ac2.route!.nodeIds.at(-1)).toBe('HP4-22-B-2');
    // it never gets past: 120 s later it is still there
    run(forced, 120);
    expect(dist(ac2.pos, find(forced, 'D1').pos)).toBeLessThan(40);
  });

  it('a stub is not "occupied" by an aircraft parked on its stand, nor by one on the runway', () => {
    const e = world(kacy, '22', [ARRIVING('X1', '22', 3, 'C172', 'TWR')]);
    const state = e.getState();
    const way = holdToParking(state, 'HP4-22-B-2', arrivalParkingTargets(state, find(e, 'X1')));
    expect(exitBlockage(state, find(e, 'X1').id, way.nodeIds)).toBeUndefined();
    expect(EXIT_STUB_M).toBe(400);
  });
});

describe('uninstructed landers follow the preference (the engine fallback)', () => {
  for (const [end, hold] of [['22', 'HP4-22-B-2'], ['4', 'HP4-22-B-2']] as const) {
    it(`C172 landing ${end} stops at ${hold} (ramp side of Bravo), with no instruction at all`, () => {
      const e = world(kacy, end, [ARRIVING('X1', end, 3, 'C172', 'TWR')]);
      const ac = find(e, 'X1');
      e.applyCommand(cmd('LAND', 'X1', { runwayEnd: end }));
      expect(runUntil(e, () => ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.1, 600)).toBe(true);
      expect(ac.route!.nodeIds.at(-1)).toBe(hold);
      const g = findRunwayEnd(kacy, end)!;
      expect(alongCross(g, ac.pos).along).toBeGreaterThan(0);
    });
  }
});
