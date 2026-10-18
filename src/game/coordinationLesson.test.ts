/** Training 10 end to end: the player works Ground, an AI controller works Tower, the crossing is coordinated on the landline. */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createAiControllers } from '../ai';
import { createEngine } from '../sim/engine';
import type { Scenario, SimulationState } from '../sim/types';
import { transmitLandline } from '../ui/commands/landline';
import { game } from './game';
import { evaluateCheck, evaluateObjectives } from './objectives';
import { accepted, run, runUntil, say } from './testkit';

const airport = loadKacy();

function setup() {
  const sc = game.buildScenario('train-10-coordination', airport) as Scenario;
  const engine = createEngine({ airport, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, airport) });
  const ai = createAiControllers({ engine, airport, positions: ['TWR'], playerPositions: ['GND'], seed: sc.seed });
  engine.subscribe((s) => ai.update(s));
  const ctrl = game.createTrainingController(sc)!;
  const speak = (text: string) => {
    const r = say(engine, text, 'GND');
    r.commands.forEach((c, i) => {
      const o = r.outcomes[i];
      ctrl.onCommand({ kind: c.kind, status: o.status, reason: o.status === 'rejected' ? o.reason : undefined, callsign: c.callsign });
    });
    ctrl.update(engine.getState());
    return r;
  };
  const until = (pred: (s: SimulationState) => boolean, max: number) => {
    const ok = runUntil(engine, pred, max);
    ctrl.update(engine.getState());
    return ok;
  };
  return { sc, engine, ctrl, speak, until, state: () => engine.getState() };
}

describe('Training 10: crossing coordination with AI Tower', () => {
  it('the scenario: Ground player, AI Tower, 13/31 active, a Cessna that must cross it', () => {
    const { sc } = setup();
    expect(sc.playerPositions).toEqual(['GND']);
    expect(sc.controllerPositions).toEqual(['GND', 'TWR']);
    expect(sc.activeRunways.landing).toContain('13');
    expect(sc.training!.steps.map((s) => s.id)).toEqual(['taxi', 'wait-report', 'ask-tower', 'wait-approval', 'cross', 'wait-cross']);
  });

  it('can be completed: taxi, ask, wait for AI Tower, cross, crossing complete', () => {
    const L = setup();
    L.until((s) => Object.values(s.aircraft)[0]?.pendingRequest?.kind === 'TAXI', 30);
    expect(accepted(L.speak('Cessna six zero delta x-ray, taxi to runway two two via alpha, hold short of runway one three'))).toBe(true);
    expect(L.until((s) => evaluateCheck(s, 'crossing_request:N60DX'), 600)).toBe(true);
    L.until(() => false, 3);
    expect(L.ctrl.current().id).toBe('ask-tower');

    // crossing without the approval is refused, citing 3-1-3, and does not advance the lesson
    const early = L.speak('Cessna six zero delta x-ray, cross runway one three at alpha');
    expect(early.outcomes[0].status).toBe('rejected');
    expect(early.outcomes[0].status === 'rejected' && early.outcomes[0].reason).toMatch(/3-1-3/);
    expect(L.ctrl.current().id).toBe('ask-tower');

    const call = transmitLandline({ engine: L.engine, text: 'Tower, Ground, cross runway one three at alpha with Cessna six zero delta x-ray', source: 'typed', controller: { positions: ['GND'], aiPositions: ['TWR'] } });
    expect(call.summary).toBe('done');
    L.until(() => false, 1);
    expect(L.ctrl.current().id).toBe('wait-approval');
    expect(L.until((s) => evaluateCheck(s, 'coord:CROSS_APPROVED:N60DX'), 60)).toBe(true);
    expect(L.ctrl.current().id).toBe('cross');
    expect(accepted(L.speak('Cessna six zero delta x-ray, cross runway one three at alpha'))).toBe(true);
    expect(L.until((s) => evaluateCheck(s, 'crossed:N60DX:13/31'), 150)).toBe(true);
    run(L.engine, 3);
    expect(L.ctrl.isComplete()).toBe(true);
    expect(evaluateCheck(L.state(), 'coord:CROSS_COMPLETE:N60DX')).toBe(true);
    expect(evaluateObjectives(L.state()).every((o) => o.completed)).toBe(true);
    expect(L.state().score.coordinationErrors ?? 0).toBe(0);
  });
});
