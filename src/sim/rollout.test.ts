/** Landing rollout and runway exit (docs/BEHAVIOUR-ACCURACY.md F9): sourced braking, first reachable exit, never stopping in an intersection. */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { Airport } from './types';
import { loadKacy } from '../airport';
import { ARRIVING, cmd, find, makeEngine, makeScenario, pilotTexts } from './__fixtures__/testHelpers';
import { createTestAirport } from './__fixtures__/testAirport';
import { alongCross, findRunwayEnd } from './runways';
import { getPerformance } from './performance';
import { exitSpeedMps } from './flightDynamics';
import { mToFt, mpsToKt } from './geo';

const kacy = loadKacy();

interface Landing { tdAlongFt: number; exitAlongFt: number; clearSec: number; stoppedSec: number; exitKt: number; phase: string; incidents: number; maxBrakeKtPerSec: number }

function land(e: SimulationEngine, airport: Airport, cs: string, rwy: string): Landing {
  const ac = find(e, cs);
  e.applyCommand(cmd('LAND', cs, { runwayEnd: rwy }));
  const g = findRunwayEnd(airport, rwy)!;
  let tTd = -1, tClear = -1, stopped = -1, tdAlong = 0, exitAlong = 0, exitKt = 0, maxBrake = 0;
  let prevV = 0;
  const dt = e.getState().clock.dtSec;
  for (let i = 0; i < 30000 && stopped < 0; i++) {
    e.step();
    const t = e.getState().clock.timeSec;
    if (tTd < 0 && ac.phase === 'ROLLOUT') { tTd = t; tdAlong = alongCross(g, ac.pos).along; prevV = ac.groundSpeedKt; }
    if (tTd >= 0 && ac.phase === 'ROLLOUT') { maxBrake = Math.max(maxBrake, (prevV - ac.groundSpeedKt) / dt); prevV = ac.groundSpeedKt; }
    if (tTd >= 0 && ac.phase === 'RUNWAY_EXIT' && exitAlong === 0) { exitAlong = alongCross(g, ac.pos).along; exitKt = ac.groundSpeedKt; }
    if (tTd >= 0 && tClear < 0 && ac.occupyingRunways.length === 0 && ac.phase !== 'ROLLOUT') tClear = t;
    if (tClear >= 0 && ac.groundSpeedKt < 0.1) stopped = t;
  }
  return {
    tdAlongFt: mToFt(tdAlong), exitAlongFt: mToFt(exitAlong), clearSec: tClear - tTd, stoppedSec: stopped - tTd, exitKt, phase: ac.phase,
    incidents: e.getState().events.filter((x) => x.kind === 'RUNWAY_INCURSION' || x.kind === 'CONFLICT').length, maxBrakeKtPerSec: maxBrake,
  };
}

const kacyLanding = (type: string, rwy: string): { e: SimulationEngine; r: Landing } => {
  const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [rwy], landing: [rwy] }, spawns: [ARRIVING('X1', rwy, 4, type, 'TWR')] }) });
  return { e, r: land(e, kacy, 'X1', rwy) };
};

describe('braking rates', () => {
  it('follow the sourced landing distances: A320 ~6 kt/s, C172 4.4 kt/s', () => {
    expect(getPerformance('A320').decelKtPerSec).toBe(6);
    expect(getPerformance('C172').decelKtPerSec).toBe(4.4);
  });
  it('exit speed: 90 degree exits <= 30 kt, shallow exits faster, always able to stop at the hold line', () => {
    expect(mpsToKt(exitSpeedMps(90, 200))).toBeLessThanOrEqual(30.01);
    expect(mpsToKt(exitSpeedMps(30, 400))).toBeGreaterThan(mpsToKt(exitSpeedMps(90, 400)));
    // 76 m (250 ft) to the hold line: at most ~23 kt so that it can stop there at the taxi braking rate
    expect(mpsToKt(exitSpeedMps(90, 76))).toBeLessThan(25);
  });
});

describe('rollout and exit on real KACY (calm)', () => {
  it('C172 on 13 is clear of the runway within 60 s of touchdown (was 142 s), exiting at C-1 (2,017 ft)', () => {
    const { r } = kacyLanding('C172', '13');
    console.info(`C172 13: ${JSON.stringify(r)}`);
    expect(r.clearSec).toBeLessThan(60);
    expect(r.clearSec).toBeLessThan(30);
    expect(Math.round(r.exitAlongFt)).toBe(2017);
    expect(r.exitKt).toBeLessThan(30);
    expect(r.phase).toBe('RUNWAY_EXIT');
    expect(r.incidents).toBe(0);
  });

  it('A320 on 4 exits at taxiway B (the first exit it can make) instead of stopping on the runway; braking stays within the maximum', () => {
    const { r, e } = kacyLanding('A320', '4');
    console.info(`A320 4: ${JSON.stringify(r)}`);
    expect(Math.round(r.exitAlongFt)).toBe(3397);
    expect(r.exitKt).toBeLessThan(30);
    expect(r.clearSec).toBeLessThan(60);
    expect(r.incidents).toBe(0);
    expect(r.maxBrakeKtPerSec).toBeLessThanOrEqual(6 * 1.4 + 0.3); // never harder than the maximum braking rate
    expect(pilotTexts(e).some((t) => /stopped on runway/.test(t))).toBe(false);
  });

  it.each([['C172', '31'], ['C172', '4'], ['C172', '22'], ['A320', '13'], ['A320', '31'], ['A320', '22']])('%s on %s exits at a taxiway, clear of the runway, no incursion', (type, rwy) => {
    const { r } = kacyLanding(type, rwy);
    console.info(`${type} ${rwy}: ${JSON.stringify(r)}`);
    expect(r.exitAlongFt).toBeGreaterThan(r.tdAlongFt);
    expect(r.exitKt).toBeLessThan(30);
    expect(r.clearSec).toBeLessThan(60);
    expect(r.incidents).toBe(0);
  });

  it('the exit chosen is the first the aircraft can make: the A320 passes no usable exit', () => {
    const { r } = kacyLanding('A320', '13');
    // first exit at or beyond the sourced landing roll: the C-1 exit (2,017 ft) is too soon after touchdown at 6 kt/s, the next is 4,444 ft
    expect(Math.round(r.exitAlongFt)).toBe(4444);
    expect(r.exitAlongFt - r.tdAlongFt).toBeGreaterThan(2500);
  });
});

describe('no exit ahead: stop short of the intersection and ask for taxi instructions', () => {
  it('fixture 13/31 without exits: the C172 stops before the 4/22 hold line (never in the intersection) and calls', () => {
    const ap = createTestAirport();
    // remove every runway-to-hold connection on 13/31 so no exit exists
    const cut = new Set(ap.taxiwayGraph.edges.filter((ed) => !ed.onRunwayId && [ed.from, ed.to].some((n) => ap.taxiwayGraph.nodes[n].kind === 'runway' && ap.taxiwayGraph.nodes[n].runwayId === '13/31')).map((ed) => ed.id));
    ap.taxiwayGraph.edges = ap.taxiwayGraph.edges.filter((ed) => !cut.has(ed.id));
    // also drop the hold nodes' adjacency via on-runway edges
    ap.taxiwayGraph.edges = ap.taxiwayGraph.edges.filter((ed) => !(ed.onRunwayId === '13/31' && [ed.from, ed.to].some((n) => ap.taxiwayGraph.nodes[n].kind === 'holding_position')));
    const e = makeEngine({ scenario: makeScenario({ spawns: [ARRIVING('X1', '13', 4, 'C172', 'TWR')] }), opts: { airport: ap } });
    const ac = find(e, 'X1');
    e.applyCommand(cmd('LAND', 'X1', { runwayEnd: '13' }));
    const g = findRunwayEnd(ap, '13')!;
    for (let i = 0; i < 30000 && !(ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.1); i++) e.step();
    expect(ac.phase).toBe('RUNWAY_EXIT');
    for (let i = 0; i < 100; i++) e.step();
    const stopAlong = alongCross(g, ac.pos).along;
    const interStart = 1000 - 23; // runway 4/22 crosses at s = 1000 m from the 13 threshold, 23 m half width
    expect(stopAlong + 4.2).toBeLessThan(interStart - 40); // nose (C172 half length 4 m) short of the other runway's hold line
    expect(stopAlong).toBeGreaterThan(300); // it did roll out first
    expect(ac.occupyingRunways).not.toContain('4/22');
    expect(pilotTexts(e).some((t) => /stopped on runway one three, unable to exit, request taxi instructions/.test(t))).toBe(true);
    expect(e.getState().events.some((x) => x.kind === 'RUNWAY_INCURSION')).toBe(false);
  });
});
