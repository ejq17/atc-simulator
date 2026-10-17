import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import type { ControllerPositionId, Scenario, SimulationState } from '../sim/types';
import { game } from './game';
import type { TrainingController } from './index';
import { evaluateCheck } from './objectives';
import { REFERENCES } from './references';
import { listScenarioSummaries } from './scenarios';
import { accepted, run, runUntil, say } from './testkit';
import type { TrainingStepSpec } from './types';

const airport = loadKacy();
const trainingIds = listScenarioSummaries().filter((s) => s.mode === 'training').map((s) => s.id);

function fakeState(over: Partial<SimulationState> = {}): SimulationState {
  return { events: [], aircraft: {}, score: { aircraftHandled: 0, runwayIncursions: 0, unsafeInstructions: 0, separationViolations: 0 }, activeRunways: { departing: [], landing: [] }, ...over } as unknown as SimulationState;
}

describe('training content', () => {
  it('has at least 6 scenarios, each with verified references, explanations and prompts', () => {
    expect(trainingIds.length).toBeGreaterThanOrEqual(6);
    const known = new Set(Object.values(REFERENCES).map((r) => r.para));
    for (const id of trainingIds) {
      const sc = game.buildScenario(id, airport) as Scenario;
      expect(sc.mode).toBe('training');
      const steps = sc.training!.steps as TrainingStepSpec[];
      expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
      for (const st of steps) {
        expect(st.prompt.length).toBeGreaterThan(20);
        expect(st.explanation.length).toBeGreaterThan(40);
        expect(st.expectCommand || st.check, `${id}/${st.id} needs a completion rule`).toBeTruthy();
        if (st.reference) for (const m of st.reference.matchAll(/(\d+-\d+-\d+)/g)) expect(known.has(m[1]), `${id}/${st.id} cites unverified ${m[1]}`).toBe(true);
        if (st.callsign) expect(sc.spawns.some((s) => s.callsign === st.callsign)).toBe(true);
      }
    }
  });

  it('covers the required topics', () => {
    const text = trainingIds.map((id) => JSON.stringify(game.buildScenario(id, airport).training)).join(' ').toLowerCase();
    for (const topic of ['phraseology', 'readback', 'hold', 'sequenc', 'mistakes', 'callsign']) expect(text).toContain(topic);
    expect(text).toContain('readback of all runway holding instructions');
    const descriptions = listScenarioSummaries().filter((s) => s.mode === 'training').map((s) => s.description.toLowerCase()).join(' ');
    for (const topic of ['phraseology', 'clearance requirements', 'runway safety', 'communication procedures', 'sequencing', 'common mistakes']) expect(descriptions).toContain(topic);
  });
});

describe('training controller transitions', () => {
  const sc = game.buildScenario('train-01-phraseology', airport);
  const mk = (): TrainingController => game.createTrainingController(sc)!;

  it('returns null for scenarios without training steps', () => {
    expect(game.createTrainingController(game.buildScenario('career-01-first-radio', airport))).toBeNull();
  });

  it('starts on step 0 and only advances on the expected accepted command for the expected callsign', () => {
    const c = mk();
    const s0 = c.update(fakeState());
    expect(s0).toMatchObject({ index: 0, total: 3, id: 'line-up', status: 'active' });
    expect(s0.reference).toContain('3-9-4');
    expect(s0.prompt).toContain('Example:');
    expect(s0.explanation).toContain('Common mistakes');

    c.onCommand({ kind: 'TAKEOFF', status: 'accepted', callsign: 'N723EJ' });
    expect(c.current().index).toBe(0);
    expect(c.current().lastFeedback).toMatch(/asks for something else/);

    c.onCommand({ kind: 'LINE_UP_AND_WAIT', status: 'accepted', callsign: 'N999ZZ' });
    expect(c.current().index).toBe(0);
    expect(c.current().lastFeedback).toMatch(/wrong aircraft/);

    c.onCommand({ kind: 'LINE_UP_AND_WAIT', status: 'accepted', callsign: 'N723EJ' });
    expect(c.current()).toMatchObject({ index: 1, id: 'takeoff', status: 'active' });
    expect(c.current().lastFeedback).toMatch(/^Correct\./);
    expect(c.isComplete()).toBe(false);
  });

  it('turns rejected / clarify outcomes into an error with the explanation', () => {
    const c = mk();
    c.onCommand({ kind: 'LINE_UP_AND_WAIT', status: 'rejected', reason: 'Not on frequency', callsign: 'N723EJ' });
    let cur = c.current();
    expect(cur.status).toBe('error');
    expect(cur.lastFeedback).toContain('Not on frequency');
    expect(cur.lastFeedback).toContain('Why it matters');
    expect(cur.lastFeedback).toContain('7110.65 3-9-4');
    expect(cur.index).toBe(0);
    c.onCommand({ kind: 'LINE_UP_AND_WAIT', status: 'clarify', reason: 'missing runway', callsign: 'N723EJ' });
    cur = c.current();
    expect(cur.status).toBe('error');
    expect(cur.lastFeedback).toMatch(/could not act/);
    // Recovery
    c.onCommand({ kind: 'LINE_UP_AND_WAIT', status: 'accepted', callsign: 'N723EJ' });
    expect(c.current()).toMatchObject({ index: 1, status: 'active' });
    // Unrelated rejection does not flag an error on the new step.
    c.onCommand({ kind: 'HEADING', status: 'rejected', reason: 'on the ground', callsign: 'N555ZZ' });
    expect(c.current().status).toBe('active');
    // Duplicate-command rejections are ignored.
    c.onCommand({ kind: 'TAKEOFF', status: 'rejected', reason: 'Duplicate command ignored: identical TAKEOFF was issued 1.0 s ago.', callsign: 'N723EJ' });
    expect(c.current().status).toBe('active');
  });

  it('completes through the last step and reports completion with the disclaimer', () => {
    const c = mk();
    c.onCommand({ kind: 'LINE_UP_AND_WAIT', status: 'accepted', callsign: 'N723EJ' });
    c.onCommand({ kind: 'TAKEOFF', status: 'accepted', callsign: 'N723EJ' });
    c.onCommand({ kind: 'CONTACT_FREQUENCY', status: 'accepted', callsign: 'N723EJ' });
    expect(c.isComplete()).toBe(true);
    const cur = c.current();
    expect(cur).toMatchObject({ id: 'complete', status: 'done', index: 3, total: 3 });
    expect(cur.explanation).toContain('NOT air traffic control training');
    c.onCommand({ kind: 'TAKEOFF', status: 'accepted', callsign: 'N723EJ' }); // ignored
    expect(c.isComplete()).toBe(true);
  });

  it('advances through wait steps and skips steps whose condition already holds (state predicate)', () => {
    const c = game.createTrainingController(game.buildScenario('train-03-runway-safety', airport))!;
    c.onCommand({ kind: 'LAND', status: 'accepted', callsign: 'NKS451' });
    expect(c.current().id).toBe('wait-clear');
    expect(c.update(fakeState()).id).toBe('wait-clear'); // nothing has happened yet
    const events = [
      { id: 'e0', timeSec: 90, kind: 'INFO', callsign: 'NKS451', text: '', severity: 'info', data: { runwayEnd: '13', alongM: 400 } },
      { id: 'e1', timeSec: 91, kind: 'RUNWAY_ENTERED', callsign: 'NKS451', text: '', severity: 'info', data: { runwayId: '13/31' } },
      { id: 'e2', timeSec: 100, kind: 'RUNWAY_EXITED', callsign: 'NKS451', text: '', severity: 'info', data: { runwayId: '13/31' } },
      { id: 'e3', timeSec: 105, kind: 'COMMAND_ACCEPTED', callsign: 'NKS451', text: '', severity: 'info', data: { kind: 'CONTACT_FREQUENCY' } },
    ];
    const s = c.update(fakeState({ events, airport } as unknown as Partial<SimulationState>));
    // wait-clear (vacated) passes, and the handoff already happened, so the controller lands on the takeoff step.
    expect(s.id).toBe('takeoff');
  });
});

/** Drive a whole lesson through the real parser/engine and feed every outcome to the controller. */
function lesson(id: string) {
  const sc = game.buildScenario(id, airport);
  const engine = createEngine({ airport, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, airport) });
  const ctrl = game.createTrainingController(sc)!;
  const speak = (text: string, position?: ControllerPositionId) => {
    const r = say(engine, text, position);
    r.commands.forEach((c, i) => {
      const o = r.outcomes[i];
      ctrl.onCommand({ kind: c.kind, status: o.status, reason: o.status === 'rejected' ? o.reason : o.status === 'clarify' ? o.question : undefined, callsign: c.callsign });
    });
    ctrl.update(engine.getState());
    return r;
  };
  const step = (secs: number) => {
    run(engine, secs);
    ctrl.update(engine.getState());
  };
  const until = (pred: (s: SimulationState) => boolean, max: number) => {
    const ok = runUntil(engine, pred, max);
    ctrl.update(engine.getState());
    return ok;
  };
  return { engine, ctrl, speak, step, until, state: () => engine.getState() as SimulationState };
}

describe('every training lesson can be completed in the real engine', () => {
  it('train-01 phraseology', () => {
    const L = lesson('train-01-phraseology');
    L.step(8);
    expect(L.ctrl.current().id).toBe('line-up');
    expect(accepted(L.speak('Cessna seven two three echo juliet, runway one three, line up and wait', 'TWR'))).toBe(true);
    expect(L.ctrl.current().id).toBe('takeoff');
    L.step(6);
    expect(accepted(L.speak('Cessna seven two three echo juliet, runway one three, cleared for takeoff'))).toBe(true);
    L.until((s) => evaluateCheck(s, 'takeoff:N723EJ'), 90);
    L.step(5);
    expect(L.ctrl.current().id).toBe('handoff');
    expect(accepted(L.speak('Cessna seven two three echo juliet, contact departure one two four point six'))).toBe(true);
    expect(L.ctrl.isComplete()).toBe(true);
  });

  it('train-02 taxi', () => {
    const L = lesson('train-02-taxi');
    L.until((s) => Object.values(s.aircraft)[0]?.pendingRequest?.kind === 'TAXI', 30);
    expect(accepted(L.speak('Cessna four eight two kilo bravo, taxi to runway one three via delta alpha, hold short runway one three', 'GND'))).toBe(true);
    expect(L.ctrl.current().id).toBe('wait-hold');
    expect(L.until((s) => evaluateCheck(s, 'holding_short:N482KB'), 400)).toBe(true);
    expect(L.ctrl.current().id).toBe('to-tower');
    expect(accepted(L.speak('Cessna four eight two kilo bravo, contact tower one two zero point three'))).toBe(true);
    L.step(8);
    expect(accepted(L.speak('Cessna four eight two kilo bravo, runway one three, cleared for takeoff', 'TWR'))).toBe(true);
    expect(L.ctrl.isComplete()).toBe(true);
  });

  it('train-03 runway safety (takeoff clearance is refused while the arrival is on short final)', () => {
    const L = lesson('train-03-runway-safety');
    L.step(8);
    expect(accepted(L.speak('Spirit four fifty one, runway one three, cleared to land'))).toBe(true);
    expect(L.ctrl.current().id).toBe('wait-clear');
    // Try to depart the Cessna once the Airbus is inside 2 nm: refused, the controller explains.
    L.until((s) => {
      const a = Object.values(s.aircraft).find((x) => x.callsign === 'NKS451');
      return !!a && Math.hypot(a.pos.x - s.airport.runways[1].ends[0].threshold.x, a.pos.y - s.airport.runways[1].ends[0].threshold.y) < 3000;
    }, 400);
    const bad = L.speak('Cessna seven two three echo juliet, runway one three, cleared for takeoff');
    expect(bad.outcomes[0].status).toBe('rejected');
    expect(L.ctrl.current().id).toBe('wait-clear');
    expect(L.ctrl.current().lastFeedback ?? '').not.toBe('');
    expect(L.until((s) => evaluateCheck(s, 'vacated:NKS451'), 200)).toBe(true);
    expect(L.ctrl.current().id).toBe('to-ground');
    L.step(4);
    expect(accepted(L.speak('Spirit four fifty one, contact ground one two one point niner'))).toBe(true);
    expect(L.ctrl.current().id).toBe('takeoff');
    expect(accepted(L.speak('Cessna seven two three echo juliet, runway one three, cleared for takeoff'))).toBe(true);
    expect(L.ctrl.isComplete()).toBe(true);
  });

  it('train-04 crossing with hold-short readback', () => {
    const L = lesson('train-04-crossing');
    L.until((s) => Object.values(s.aircraft)[0]?.pendingRequest?.kind === 'TAXI', 30);
    expect(accepted(L.speak('Cessna six zero delta x-ray, taxi to runway two two via alpha, hold short of runway one three', 'GND'))).toBe(true);
    expect(L.until((s) => evaluateCheck(s, 'crossing_request:N60DX'), 600)).toBe(true);
    expect(L.ctrl.current().id).toBe('cross');
    expect(accepted(L.speak('Cessna six zero delta x-ray, cross runway one three at alpha'))).toBe(true);
    expect(L.until((s) => evaluateCheck(s, 'crossed:N60DX:13/31'), 120)).toBe(true);
    expect(L.ctrl.isComplete()).toBe(true);
  });

  it('train-05 sequencing', () => {
    const L = lesson('train-05-sequencing');
    L.step(6);
    expect(accepted(L.speak('Cessna seven two three echo juliet, runway one three, cleared to land'))).toBe(true);
    expect(accepted(L.speak('Spirit four fifty one, reduce speed to one four zero'))).toBe(true);
    expect(L.ctrl.current().id).toBe('wait-lead');
    expect(L.until((s) => evaluateCheck(s, 'vacated:N723EJ'), 300)).toBe(true);
    expect(L.ctrl.current().id).toBe('follow');
    expect(accepted(L.speak('Spirit four fifty one, runway one three, cleared to land'))).toBe(true);
    expect(L.ctrl.isComplete()).toBe(true);
  });

  it('train-06 pattern', () => {
    const L = lesson('train-06-pattern');
    L.step(5);
    expect(accepted(L.speak('Cessna five nine tango bravo, enter left downwind runway one three'))).toBe(true);
    expect(L.until((s) => Object.values(s.aircraft)[0]?.phase === 'FINAL', 600)).toBe(true);
    expect(accepted(L.speak('Cessna five nine tango bravo, runway one three, cleared to land'))).toBe(true);
    expect(L.until((s) => evaluateCheck(s, 'vacated:N59TB'), 300)).toBe(true);
    L.step(4);
    expect(accepted(L.speak('Cessna five nine tango bravo, contact ground one two one point niner'))).toBe(true);
    expect(L.ctrl.isComplete()).toBe(true);
  });

  it('train-07 go-around', () => {
    const L = lesson('train-07-go-around');
    L.step(6);
    expect(accepted(L.speak('Cessna seven two three echo juliet, runway one three, line up and wait', 'TWR'))).toBe(true);
    L.step(3);
    expect(L.ctrl.current().id).toBe('go-around');
    // Clearing the Airbus to land with the Cessna in position is refused in training mode.
    const bad = L.speak('Spirit four fifty one, runway one three, cleared to land');
    expect(bad.outcomes[0].status).toBe('rejected');
    expect(L.ctrl.current().status).toBe('error');
    expect(accepted(L.speak('Spirit four fifty one, go around'))).toBe(true);
    expect(L.ctrl.current().id).toBe('takeoff');
    expect(accepted(L.speak('Cessna seven two three echo juliet, runway one three, cleared for takeoff'))).toBe(true);
    expect(L.ctrl.isComplete()).toBe(true);
  });
});
