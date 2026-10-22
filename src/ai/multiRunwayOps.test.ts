/**
 * Multi-runway operations of the AI and the generator on the synthetic fixture (parallel runways 4,003 ft apart, a crossing runway, a short runway): pattern sides,
 * the dependent-parallel stagger for arrivals, the opening population's runway choice and Ground's departure runway choice.
 */
import { describe, expect, it } from 'vitest';
import { createMultiRunwayAirport } from '../sim/__fixtures__/multiRunwayAirport';
import { ARRIVING, HOLDING } from '../sim/__fixtures__/testHelpers';
import { loadKacy } from '../airport';
import { defaultPatternSide, findRunwayEnd, parallelNeighbours } from '../sim/runways';
import { mulberry32 } from '../sim/rng';
import { game } from '../game/game';
import { NOMINAL_APPROACH_JET_KT, NOMINAL_APPROACH_LIGHT_KT, pickArrivalStart } from '../game/placement';
import { landingEndPool } from '../game/arrivalRunways';
import { ALL, cmd, createHarness } from './testkit';
import { dependentMates, dependentPairClear, planDeparture, QUEUE_PENALTY_M } from './world';
import { neededEtaSec, patternSideAt } from './tower';
import { getPerformance } from '../sim/performance';
import type { Aircraft } from '../sim/types';

const airport = createMultiRunwayAirport();
const kacy = loadKacy();

describe('traffic pattern side on parallel runways (AIM 4-3-3)', () => {
  it('the patterns of the pair turn away from each other; a single runway keeps left traffic', () => {
    const side = (id: string) => defaultPatternSide(airport, findRunwayEnd(airport, id)!);
    expect(side('27R')).toBe('right'); // 27L is on its left
    expect(side('27L')).toBe('left');
    expect(side('9L')).toBe('left'); // 9R is on its right
    expect(side('9R')).toBe('right');
    expect(side('35')).toBe('left');
    expect(side('6')).toBe('left');
    for (const r of kacy.runways) for (const e of r.ends) expect(patternSideAt(kacy, e.id)).toBe('left');
  });

  it('the neighbours of 27R are 27L only (17/35 crosses it, 6/24 is not parallel)', () => {
    const near = parallelNeighbours(airport, findRunwayEnd(airport, '27R')!);
    expect(near.map((n) => n.end.end.id)).toEqual(['27L']);
    expect(near[0].lateralFt).toBeCloseTo(-4003, -1);
  });

  it('AI Tower sends a go-around to the right-hand pattern of 27R and to the left-hand pattern of 27L', () => {
    for (const [end, leg] of [['27R', 'right_downwind'], ['27L', 'left_downwind']] as const) {
      const h = createHarness({ airport, player: [], ai: ALL, mode: 'free_play', activeRunways: { departing: ['27L'], landing: ['27R', '27L'] }, readbackErrorRate: 0, spawns: [ARRIVING('N900GA', end, 3, 'C172')] });
      h.runUntil(() => h.outcomes.some((o) => o.cmd.kind === 'LAND' && o.cmd.callsign === 'N900GA'), 200);
      h.say('TWR', cmd('GO_AROUND', 'N900GA'));
      h.run(120);
      const pattern = h.outcomes.find((o) => o.cmd.kind === 'ENTER_PATTERN' && o.cmd.callsign === 'N900GA');
      expect(pattern?.cmd.patternLeg).toBe(leg);
      expect(pattern?.cmd.runwayEnd).toBe(end);
    }
  });
});

describe('dependent parallel finals (JO 7110.65 5-9-6)', () => {
  const g = findRunwayEnd(airport, '27L')!;
  const mate = dependentMates(airport, g)[0];

  it('27L and 27R are dependent mates: 4,003 ft apart, a 1.7 nm diagonal (alert 1.5 nm + 0.2) = 1.57 nm along the course', () => {
    expect(dependentMates(airport, g).map((m) => m.end.end.id)).toEqual(['27R']);
    expect(mate.latFt).toBeCloseTo(4003, -1);
    expect(mate.alongNm).toBeCloseTo(Math.sqrt(1.7 * 1.7 - 0.659 * 0.659), 1);
    expect(dependentMates(airport, findRunwayEnd(airport, '35')!)).toEqual([]);
  });

  it('a faster aircraft behind a slower one on the adjacent final that would pass it is not clear; the same pair the other way round is', () => {
    // along-course positions (nm, threshold 0): the jet 11 nm out, the Cessna 4.5 nm out ahead of it
    expect(dependentPairClear(mate, -11, NOMINAL_APPROACH_JET_KT, -4.5, NOMINAL_APPROACH_LIGHT_KT)).toBe(false);
    expect(dependentPairClear(mate, -4.5, NOMINAL_APPROACH_LIGHT_KT, -11, NOMINAL_APPROACH_JET_KT)).toBe(false);
    // the jet ahead by 2 nm or more and faster stays ahead and the gap opens; the Cessna 7 nm out behind it keeps 7 nm
    expect(dependentPairClear(mate, -4, NOMINAL_APPROACH_JET_KT, -11, NOMINAL_APPROACH_LIGHT_KT)).toBe(true);
    // two aircraft abeam of each other are not
    expect(dependentPairClear(mate, -6, NOMINAL_APPROACH_JET_KT, -6.3, NOMINAL_APPROACH_JET_KT)).toBe(false);
    // same speeds, 2.5 nm apart: kept
    expect(dependentPairClear(mate, -8, NOMINAL_APPROACH_LIGHT_KT, -10.5, NOMINAL_APPROACH_LIGHT_KT)).toBe(true);
  });

  it('a generated arrival for a runway with a dependent mate is placed on the extended centreline, never on a base leg that crosses the neighbour final', () => {
    for (const end of ['27R', '27L']) {
      const e = findRunwayEnd(airport, end)!;
      for (let seed = 1; seed <= 30; seed++) {
        const st = pickArrivalStart(airport, end, 'C172', mulberry32(seed), []);
        expect(st).toBeDefined();
        expect(Math.abs((st!.pos.y - e.end.threshold.y))).toBeLessThan(1); // on the runway axis (east-west)
      }
    }
    // a runway without a mate keeps base-leg starts
    const off = Array.from({ length: 30 }, (_, i) => pickArrivalStart(airport, '35', 'C172', mulberry32(i + 1), [])!).filter((s) => Math.abs(s.pos.x) > 1);
    expect(off.length).toBeGreaterThan(0);
  });

  it('a new jet is not placed behind a slower Cessna on the adjacent final inside the stagger (it would pass it); it is when the Cessna is far behind it', () => {
    const e = findRunwayEnd(airport, '27L')!;
    const cessna = (nm: number) => ({ pos: { x: e.end.threshold.x + nm * 1852, y: 610 }, type: 'C172', runwayEnd: '27R' });
    for (let seed = 1; seed <= 40; seed++) expect(pickArrivalStart(airport, '27L', 'A320', mulberry32(seed), [cessna(6)], { tries: 24 })).toBeUndefined(); // spawn ring 10-12 nm
    expect(pickArrivalStart(airport, '27L', 'A320', mulberry32(1), [cessna(20)], { tries: 24 })).toBeDefined();
  });
});

describe('arrival to departure on a parallel runway: the alert, not the categorical distance (neededEtaSec)', () => {
  it('an arrival on the parallel runway needs less lead than on the same runway, and more than none', () => {
    const h = createHarness({ airport, player: [], ai: ALL, mode: 'free_play', activeRunways: { departing: ['27L'], landing: ['27R'] }, readbackErrorRate: 0, spawns: [HOLDING('N77AA', 'HSE2', '27L', 'C172', 'GND')] });
    const dep = h.find('N77AA') as Aircraft;
    const sameRunway = neededEtaSec(dep, false, 'A320', getPerformance('A320').approachSpeedKt, 0);
    const parallel = neededEtaSec(dep, false, 'A320', getPerformance('A320').approachSpeedKt, 4003 * 0.3048 / 1852);
    expect(parallel).toBeGreaterThan(30);
    expect(parallel).toBeLessThan(sameRunway);
  });
});

describe('the opening population uses the generator\'s runway choice', () => {
  it('an airliner is never given the short runway 24 (2,400 ft) when the landing configuration lists it; a Cessna may be', () => {
    expect(landingEndPool(airport, ['24', '27R'], 'A320', false, false)).toEqual(['27R']);
    expect(landingEndPool(airport, ['24', '27R'], 'C172', true, false)).toEqual(['24', '27R']);
    const sc = game.buildFreePlay(airport, {
      seed: 5, weather: 'clear', aircraftCount: 8, startingScenario: 'busy_arrivals', activeRunways: { departing: ['27L'], landing: ['24', '27R'] }, aircraftTypes: ['A320'],
      specialTraffic: { helicopter: false, military: false, transition: false, training: false, vehicles: false }, airportEvents: false,
    });
    const arrivals = sc.spawns.filter((s) => !s.isDeparture && s.start.kind === 'airborne');
    expect(arrivals.length).toBeGreaterThan(0);
    for (const s of arrivals) expect(s.start.kind === 'airborne' && s.start.runwayEnd).toBe('27R');
  });

  it('the arrivals alternate between the runways that qualify', () => {
    const sc = game.buildFreePlay(airport, {
      seed: 5, weather: 'clear', aircraftCount: 10, startingScenario: 'busy_arrivals', activeRunways: { departing: ['27L'], landing: ['27R', '27L'] }, aircraftTypes: ['C172'],
      specialTraffic: { helicopter: false, military: false, transition: false, training: false, vehicles: false }, airportEvents: false,
    });
    const ends = sc.spawns.filter((s) => !s.isDeparture && s.start.kind === 'airborne').map((s) => (s.start.kind === 'airborne' ? s.start.runwayEnd : ''));
    expect(ends.length).toBeGreaterThan(1);
    expect(new Set(ends)).toEqual(new Set(['27R', '27L']));
    expect(Math.abs(ends.filter((e) => e === '27R').length - ends.filter((e) => e === '27L').length)).toBeLessThanOrEqual(1);
  });
});

describe('Ground picks the departure runway by taxi distance from the stand, balancing the queues', () => {
  const h = createHarness({ airport, player: [], ai: ALL, mode: 'free_play', activeRunways: { departing: ['27L', '9R'], landing: ['27R'] }, readbackErrorRate: 0, spawns: [{ atSec: 0, callsign: 'N41GA', type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId: 'GA1' }, isDeparture: true, initialFrequencyId: 'GND' }] });
  const ac = h.find('N41GA') as Aircraft;

  it('the apron is west of the crossing runway: runway 9R (west ends, no crossing) is nearer than 27L although the configuration lists 27L first', () => {
    expect(planDeparture(airport, ac, ['27L', '9R'])?.runwayEnd).toBe('9R');
    expect(planDeparture(airport, ac, ['9R', '27L'])?.runwayEnd).toBe('9R');
  });

  it('a runway whose queue is much longer than the other\'s is not picked while the other is nearly as close: three departures queued for 9R send the next one to 27L', () => {
    const busy = new Map([['HSW2', 1], ['HSW1', 2]]);
    const plan = planDeparture(airport, ac, ['27L', '9R'], busy);
    expect(plan?.runwayEnd).toBe('27L');
    expect(QUEUE_PENALTY_M).toBeGreaterThan(0);
  });

  it('with equal cost the configuration order decides (a single listed end is the plan)', () => {
    expect(planDeparture(airport, ac, ['27L'])?.runwayEnd).toBe('27L');
    expect(planDeparture(airport, ac, ['9R'])?.runwayEnd).toBe('9R');
  });
});
