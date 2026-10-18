/** End-to-end flows through the real parser and engine for the trickier career/training steps. */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import type { SimulationEngine } from '../sim/api';
import { game } from './game';
import { evaluateCheck } from './objectives';
import { accepted, run, runUntil, say } from './testkit';

const airport = loadKacy();

function start(id: string): SimulationEngine {
  const sc = game.buildScenario(id, airport);
  return createEngine({ airport, scenario: sc, readbackErrorRate: 0, trafficGenerator: game.createTrafficGenerator(sc, airport) });
}
const ac = (e: SimulationEngine, cs: string) => Object.values(e.getState().aircraft).find((a) => a.callsign === cs)!;

describe('career 2: single takeoff from the GA ramp', () => {
  it('taxi -> hold short -> tower -> takeoff -> airborne', () => {
    const e = start('career-02-single-takeoff');
    expect(runUntil(e, () => ac(e, 'N482KB')?.pendingRequest?.kind === 'TAXI', 30)).toBe(true);
    const t = say(e, 'Cessna four eight two kilo bravo, taxi to runway one three via delta alpha, hold short runway one three');
    expect(accepted(t), JSON.stringify(t.outcomes)).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'holding_short:N482KB'), 400)).toBe(true);
    const h = say(e, 'Cessna four eight two kilo bravo, contact tower one two zero point three');
    expect(accepted(h), JSON.stringify(h.outcomes)).toBe(true);
    run(e, 8);
    const k = say(e, 'Cessna four eight two kilo bravo, runway one three, cleared for takeoff', 'TWR');
    expect(accepted(k), JSON.stringify(k.outcomes)).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'takeoff:N482KB'), 90)).toBe(true);
    expect(game.isScenarioComplete(e.getState())).toBe(true);
  });
});

describe('career 5: runway crossings', () => {
  it('N77RK taxis to 22 via Alpha, stops at 13/31 and crosses on clearance', () => {
    const e = start('career-05-ground-taxi');
    expect(runUntil(e, () => ac(e, 'N77RK')?.pendingRequest?.kind === 'TAXI', 40)).toBe(true);
    const t = say(e, 'Cessna seven seven romeo kilo, taxi to runway two two via alpha, hold short of runway one three');
    expect(accepted(t), JSON.stringify(t.outcomes)).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'crossing_request:N77RK'), 600)).toBe(true);
    const c = say(e, 'Cessna seven seven romeo kilo, cross runway one three at alpha');
    expect(accepted(c), JSON.stringify(c.outcomes)).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'crossed:N77RK:13/31'), 90)).toBe(true);
  });
});

describe('career 6: pattern work', () => {
  it('enter left downwind, then cleared to land', () => {
    const e = start('career-06-pattern');
    run(e, 5);
    const p = say(e, 'Cessna five nine tango bravo, enter left downwind runway one three');
    expect(accepted(p), JSON.stringify(p.outcomes)).toBe(true);
    expect(runUntil(e, () => ac(e, 'N59TB')?.phase === 'FINAL', 600)).toBe(true);
    const l = say(e, 'Cessna five nine tango bravo, runway one three, cleared to land');
    expect(accepted(l), JSON.stringify(l.outcomes)).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'landed:N59TB'), 200)).toBe(true);
  });
});

describe('career 4: three departures', () => {
  it('sequences N412KB and N88PL and is refused when the runway is busy', () => {
    const e = start('career-04-multiple-departures');
    run(e, 6);
    // N88PL (Charlie, downfield) goes first; N412KB must wait: a second takeoff while it rolls is flagged unsafe.
    const a = say(e, 'Cessna eight eight papa lima, runway one three, cleared for takeoff');
    expect(accepted(a), JSON.stringify(a.outcomes)).toBe(true);
    const b = say(e, 'Cessna four one two kilo bravo, runway one three, cleared for takeoff');
    expect(b.outcomes[0].status).toBe('accepted'); // challenge mode accepts, but flags it
    run(e, 0.5);
    expect(e.getState().score.unsafeInstructions).toBeGreaterThan(0);
    const report = game.buildDebrief(e.getState());
    expect(report.improvements.join(' ')).toMatch(/takeoff clearance/);
    expect(report.improvements.join(' ')).toMatch(/3-9-6/);
  });
});

describe('A320 departures from the terminal', () => {
  it('career 4: NKS608 taxis to the full-length hold via Bravo (crossing 4/22), and takes off', () => {
    const e = start('career-04-multiple-departures');
    run(e, 6);
    // Depart the two Cessnas first: N412KB occupies the Bravo hold the Airbus is going to.
    expect(accepted(say(e, 'Cessna four one two kilo bravo, runway one three, cleared for takeoff', 'TWR'))).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'takeoff:N412KB'), 90)).toBe(true);
    expect(accepted(say(e, 'Cessna eight eight papa lima, runway one three, cleared for takeoff'))).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'takeoff:N88PL'), 90)).toBe(true);
    expect(runUntil(e, () => ac(e, 'NKS608')?.pendingRequest?.kind === 'PUSHBACK', 90)).toBe(true);
    expect(accepted(say(e, 'Spirit six oh eight, pushback approved', 'GND'))).toBe(true);
    expect(runUntil(e, () => ac(e, 'NKS608')?.pendingRequest?.kind === 'TAXI', 300)).toBe(true);
    say(e, 'Spirit six oh eight, taxi to runway one three via bravo, hold short of runway four', 'GND');
    expect(ac(e, 'NKS608').route).toBeDefined();
    expect(runUntil(e, (s) => evaluateCheck(s, 'crossing_request:NKS608'), 600)).toBe(true);
    expect(accepted(say(e, 'Spirit six oh eight, cross runway four at bravo'))).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'holding_short:NKS608'), 600)).toBe(true);
    say(e, 'Spirit six oh eight, contact tower one two zero point three');
    run(e, 8);
    const k = say(e, 'Spirit six oh eight, runway one three, cleared for takeoff', 'TWR');
    expect(accepted(k), JSON.stringify(k.outcomes)).toBe(true);
  });
});
