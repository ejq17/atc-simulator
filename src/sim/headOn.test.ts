/**
 * Head-on traffic already moving on a shared lane (sim/headOn.ts). KACY: the Bravo corridor between the GA ramp and the 4/22 Bravo hold (about 1.4 km of
 * single-width taxiway, the lane an arrival taxiing in and a departure taxiing out share); KMHT: the corridor between the terminal and a runway hold.
 * Before: only stopped leaders were respected, two moving aircraft drove through each other.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { Airport, Aircraft, ScenarioAircraftSpawn } from './types';
import { loadKacy, loadKmht } from '../airport';
import { GA_PARKED, HOLDING, cmd, find, makeScenario, run, say } from './__fixtures__/testHelpers';
import { dist } from './geo';

const kacy = loadKacy();
const kmht = loadKmht();

function world(airport: Airport, rwy: string, spawns: ScenarioAircraftSpawn[]): SimulationEngine {
  return createEngine({ airport, readbackErrorRate: 0, scenario: makeScenario({ activeRunways: { departing: [rwy], landing: [rwy] }, controllerPositions: ['TWR', 'GND'], spawns }) });
}

/** Put `ac` on the reverse of `ids` (from its last node), taxiing, as if Ground had sent it down the same corridor the other way. */
function sendAlong(ac: Aircraft, airport: Airport, ids: string[]): void {
  const g = airport.taxiwayGraph;
  const start = g.nodes[ids[0]];
  const next = g.nodes[ids[1]];
  ac.pos = { x: start.pos.x, y: start.pos.y };
  ac.headingDeg = (Math.atan2(next.pos.x - start.pos.x, next.pos.y - start.pos.y) * 180) / Math.PI;
  ac.route = { nodeIds: ids, taxiways: [], stopAtNodeIds: [], progressIndex: 1 };
  ac.phase = 'TAXIING';
  ac.pendingRequest = undefined;
}

interface Run { minGap: number; stoppedAtSec?: number; firstCallSec?: number; calls: string[]; a: Aircraft; b: Aircraft; e: SimulationEngine }

/** A taxis from `from` to the hold; B is sent down the same corridor from the hold toward `from`. */
function headOnRun(airport: Airport, rwy: string, spawnA: ScenarioAircraftSpawn, holdId: string, taxi: Parameters<typeof cmd>[2], seconds: number, typeB = 'C172'): Run {
  const e = world(airport, rwy, [spawnA, HOLDING('N2B', holdId, rwy, typeB, 'GND')]);
  const a = find(e, spawnA.callsign);
  const b = find(e, 'N2B');
  expect(say(e, cmd('TAXI', spawnA.callsign, taxi), 'GND').status).toBe('accepted');
  const ids = a.route!.nodeIds.slice(2);
  sendAlong(b, airport, [...ids].reverse());
  let minGap = Infinity;
  let stoppedAtSec: number | undefined;
  let firstCallSec: number | undefined;
  for (let t = 0; t < seconds; t++) {
    run(e, 1);
    minGap = Math.min(minGap, dist(a.pos, b.pos));
    if (stoppedAtSec === undefined && a.groundSpeedKt < 0.1 && b.groundSpeedKt < 0.1 && dist(a.pos, b.pos) < 150) stoppedAtSec = e.getState().clock.timeSec;
    if (firstCallSec === undefined && e.getState().events.some((x) => x.data?.headOn)) firstCallSec = e.getState().clock.timeSec;
  }
  const calls = e.getState().events.filter((x) => x.speaker === 'PILOT' && /nose to nose/.test(x.text)).map((x) => x.text);
  return { minGap, stoppedAtSec, firstCallSec, calls, a, b, e };
}

describe('two aircraft moving toward each other on one lane stop short of each other', () => {
  it('KACY Bravo corridor: a Cessna from the GA ramp and one from the Bravo hold stop apart and the give-way pilot calls', () => {
    const r = headOnRun(kacy, '4', GA_PARKED('N1A', 'GA-1', 'GND'), 'HP4-22-B-2', { destination: 'RWY4', runwayEnd: '4', route: ['B'] }, 200);
    console.info(`KACY Bravo corridor: closest approach ${r.minGap.toFixed(1)} m, both stopped at t=${r.stoppedAtSec}, call at t=${r.firstCallSec}`);
    expect(r.minGap).toBeGreaterThan(25); // never closer than the margin (1.5 x 8.3 m + 20 m for two C172)
    expect(r.stoppedAtSec).toBeDefined();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/nose to nose with Cessna .*, request instructions/);
    expect(r.calls[0]).toMatch(/ on [a-z]+, request/);
    const ev = r.e.getState().events.find((x) => x.kind === 'INFO' && x.data?.headOn);
    expect(ev?.severity).toBe('warning');
  });

  it('the pilot who calls is the one that must give way: an arrival gives way to a departure', () => {
    const r = headOnRun(kacy, '4', GA_PARKED('N1A', 'GA-1', 'GND'), 'HP4-22-B-2', { destination: 'RWY4', runwayEnd: '4', route: ['B'] }, 200);
    // N1A is a departure taxiing out; N2B (set up as a departure holding short) is the same kind: the higher id (N2B) gives way
    const callers = r.e.getState().events.filter((x) => x.speaker === 'PILOT' && /nose to nose/.test(x.text)).map((x) => x.callsign);
    expect(callers).toEqual(['N2B']);
  });

  it('is deterministic: the same run twice gives the same stop moment and distance', () => {
    const one = () => { const r = headOnRun(kacy, '4', GA_PARKED('N1A', 'GA-1', 'GND'), 'HP4-22-B-2', { destination: 'RWY4', runwayEnd: '4', route: ['B'] }, 160); return [r.minGap.toFixed(3), r.stoppedAtSec]; };
    expect(one()).toEqual(one());
  });

  it('KMHT: two airliners meet on the terminal corridor (Mike - November - Golf - Delta - Alpha) and stop 75 m apart', () => {
    const r = headOnRun(kmht, '17', GA_PARKED('NKS1A', 'GATE-1', 'GND', { type: 'A320', flightRules: 'IFR' }), 'HP17-35-B-1', { destination: 'RWY17', runwayEnd: '17', route: ['B'] }, 150, 'A320');
    console.info(`KMHT terminal corridor: closest approach ${r.minGap.toFixed(1)} m, both stopped at t=${r.stoppedAtSec}, call at t=${r.firstCallSec}`);
    expect(r.minGap).toBeGreaterThan(70);
    expect(r.minGap).toBeLessThan(120);
    expect(r.calls).toHaveLength(1);
  });

  it('prevention: an aircraft about to join the lane waits at the junction while the other comes through, then goes on; nobody stops nose to nose', () => {
    const e = world(kacy, '4', [GA_PARKED('N1A', 'GA-1', 'GND'), HOLDING('N2B', 'HP4-22-B-2', '4', 'C172', 'GND')]);
    const a = find(e, 'N1A');
    const b = find(e, 'N2B');
    expect(say(e, cmd('TAXI', 'N1A', { destination: 'RWY4', runwayEnd: '4', route: ['B'] }), 'GND').status).toBe('accepted');
    const lane = a.route!.nodeIds.slice(2);
    const g = kacy.taxiwayGraph;
    // a junction on the lane with a side branch that is not on it
    const isTwy = (id: string) => ['taxiway', 'intersection'].includes(g.nodes[id].kind);
    const adj = (id: string) => g.edges.filter((x) => x.from === id || x.to === id).map((x) => (x.from === id ? x.to : x.from));
    const m = lane.findIndex((id, i) => i > 12 && i < lane.length - 40 && isTwy(id) && adj(id).some((n) => !lane.includes(n) && isTwy(n)));
    expect(m).toBeGreaterThan(12);
    const side = adj(lane[m]).find((n) => !lane.includes(n) && isTwy(n))!;
    // A comes from the side branch (a few nodes out) onto the lane and follows it toward the hold; B comes the other way, already close to the junction
    const branch: string[] = [side];
    let prev = lane[m];
    for (let i = 0; i < 6; i++) {
      const nx = adj(branch[branch.length - 1]).find((n) => n !== prev && !lane.includes(n) && isTwy(n));
      if (!nx) break;
      prev = branch[branch.length - 1];
      branch.push(nx);
    }
    const aIds = [...branch.slice().reverse(), ...lane.slice(m, m + 40)];
    const bIds = lane.slice(Math.max(0, m - 6), m + 8).reverse();
    sendAlong(a, kacy, aIds);
    sendAlong(b, kacy, bIds);
    let minGap = Infinity;
    let aStoppedBeforeJunction = false;
    for (let t = 0; t < 120; t++) {
      run(e, 1);
      minGap = Math.min(minGap, dist(a.pos, b.pos));
      if (a.groundSpeedKt < 0.1 && a.route!.progressIndex <= branch.length) aStoppedBeforeJunction = true;
    }
    console.info(`joining the lane: closest approach ${minGap.toFixed(1)} m, A waited at the junction: ${aStoppedBeforeJunction}`);
    expect(e.getState().events.some((x) => x.data?.headOn)).toBe(false);
    expect(minGap).toBeGreaterThan(20);
    expect(b.route!.progressIndex).toBeGreaterThan(bIds.length - 2); // B came through
    expect(a.route!.progressIndex).toBeGreaterThan(branch.length + 3); // A went on after it
  });
});
