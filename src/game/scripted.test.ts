import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { game } from './game';
import { evaluateCheck } from './objectives';
import { accepted, run, runUntil, say } from './testkit';

const airport = loadKacy();

function start(id: string) {
  const sc = game.buildScenario(id, airport);
  return createEngine({ airport, scenario: sc, readbackErrorRate: 0, trafficGenerator: game.createTrafficGenerator(sc, airport) });
}

describe('career step 1 (scripted through the real parser)', () => {
  it('a takeoff clearance completes the objective and the scenario', () => {
    const engine = start('career-01-first-radio');
    run(engine, 8);
    const ac = Object.values(engine.getState().aircraft)[0];
    expect(ac.pendingRequest?.kind).toBe('DEPARTURE');
    expect(game.isScenarioComplete(engine.getState())).toBe(false);
    const r = say(engine, 'Cessna seven two three echo juliet, runway one three, cleared for takeoff');
    expect(accepted(r), JSON.stringify(r.outcomes)).toBe(true);
    expect(evaluateCheck(engine.getState(), 'cmd:TAKEOFF:N723EJ')).toBe(true);
    expect(game.isScenarioComplete(engine.getState())).toBe(true);
    runUntil(engine, (s) => s.aircraft[ac.id]?.phase === 'DEPARTURE', 120);
    const report = game.buildDebrief(engine.getState());
    expect(report.completed).toBe(true);
    expect(['A', 'B', 'C']).toContain(report.grade);
    expect(report.objectives.every((o) => o.completed)).toBe(true);
  });
});

describe('career step 3 (scripted through the real parser)', () => {
  it('clear to land, then hand off to ground completes all objectives', () => {
    const engine = start('career-03-single-landing');
    run(engine, 8);
    expect(Object.values(engine.getState().aircraft)[0].pendingRequest?.kind).toBe('LANDING');
    const r = say(engine, 'Spirit four fifty one, runway one three, cleared to land');
    expect(accepted(r), JSON.stringify(r.outcomes)).toBe(true);
    expect(runUntil(engine, (s) => evaluateCheck(s, 'landed:NKS451'), 400)).toBe(true);
    expect(game.isScenarioComplete(engine.getState())).toBe(false);
    // The pilot calls clear of the runway on Tower frequency; hand it to Ground.
    expect(runUntil(engine, (s) => Object.values(s.aircraft)[0]?.phase === 'RUNWAY_EXIT' && Object.values(s.aircraft)[0].groundSpeedKt < 0.2, 120)).toBe(true);
    run(engine, 4);
    const h = say(engine, 'Spirit four fifty one, contact ground one two one point niner');
    expect(accepted(h), JSON.stringify(h.outcomes)).toBe(true);
    expect(runUntil(engine, (s) => evaluateCheck(s, 'handoff:NKS451'), 30)).toBe(true);
    const st = engine.getState();
    expect(game.isScenarioComplete(st)).toBe(true);
    const report = game.buildDebrief(st);
    expect(report.completed).toBe(true);
    expect(report.grade).not.toBe('F');
    expect(report.objectives.map((o) => o.completed)).toEqual([true, true, true, true]);
    expect(report.timeline.some((t) => t.kind === 'HANDOFF')).toBe(true);
  });
});
