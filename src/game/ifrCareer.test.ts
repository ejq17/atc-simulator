/** IFR career step 8 and the two IFR lessons, end to end through the real parser and the real engine (ctx.fixes from airport.navaids). */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import type { SimulationEngine } from '../sim/api';
import type { Aircraft, ControllerPositionId, SimulationState } from '../sim/types';
import { game } from './game';
import { evaluateCheck } from './objectives';
import { accepted, run, runUntil, say } from './testkit';

const airport = loadKacy();

function start(id: string) {
  const sc = { ...game.buildScenario(id, airport), pilotRealism: 'off' as const }; // scripted answers: clean pilots
  const engine = createEngine({ airport, scenario: sc, readbackErrorRate: 0, trafficGenerator: game.createTrafficGenerator(sc, airport) });
  return { sc, engine };
}
const ac = (e: SimulationEngine, cs: string): Aircraft | undefined => Object.values(e.getState().aircraft).find((a) => a.callsign === cs);

describe('career 8: IFR traffic, Approach then Tower', () => {
  it('three ILS 13 arrivals from CARYL / VCN are cleared for the approach, handed to Tower and landed', () => {
    const { sc, engine: e } = start('career-08-ifr');
    expect(sc.controllerPositions).toEqual(expect.arrayContaining(['APP', 'TWR']));
    const arrivals = sc.spawns.filter((s) => !s.isDeparture);
    expect(arrivals.map((s) => (s.start.kind === 'at_fix' ? s.start.fix : ''))).toEqual(['CARYL', 'VCN', 'VCN']);
    expect(arrivals.find((s) => s.callsign === 'AAL1672')!.start).toMatchObject({ route: ['VCN', 'CARYL', 'MAYBN'] });
    expect(sc.objectives!.map((o) => o.check)).toEqual(expect.arrayContaining(['approach:NKS244', 'approach:AAL1672', 'approach:NKS377', 'landed:NKS244', 'no_conflicts']));

    // First calls arrive on Approach.
    run(e, 6);
    expect(['NKS244', 'AAL1672'].every((cs) => ac(e, cs)?.pendingRequest?.kind === 'APPROACH')).toBe(true);
    expect(ac(e, 'NKS244')!.frequencyId).toBe('APP');

    // The departure first (the runway is empty and the arrivals are 10+ nm away).
    run(e, 30);
    expect(accepted(say(e, 'Spirit eight ninety, runway one three, cleared for takeoff', 'TWR'))).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'takeoff:NKS890'), 120)).toBe(true);

    const cleared = new Set<string>();
    const toTower = new Set<string>();
    const lands = new Set<string>();
    const names: Record<string, string> = { NKS244: 'Spirit two forty four', AAL1672: 'American sixteen seventy two', NKS377: 'Spirit three seventy seven' };
    let t = 0;
    while (t < 2600 && !game.isScenarioComplete(e.getState())) {
      for (const cs of Object.keys(names)) {
        const a = ac(e, cs);
        if (!a) continue;
        if (!cleared.has(cs) && a.pendingRequest?.kind === 'APPROACH') {
          const r = say(e, `${names[cs]}, descend and maintain two thousand, cleared I-L-S runway one three approach`, 'APP');
          expect(accepted(r), JSON.stringify(r.outcomes)).toBe(true);
          cleared.add(cs);
        } else if (cleared.has(cs) && !toTower.has(cs) && a.pendingRequest?.kind === 'FREQUENCY_CHANGE' && a.frequencyId === 'APP') {
          const r = say(e, `${names[cs]}, contact tower one two zero point three`, 'APP');
          expect(accepted(r), JSON.stringify(r.outcomes)).toBe(true);
          toTower.add(cs);
        } else if (
          toTower.has(cs) && !lands.has(cs) && a.pendingRequest?.kind === 'LANDING' && a.frequencyId === 'TWR' &&
          // Tower clears an arrival only when the runway will be free: nobody that has landed is still on it.
          Object.keys(names).every((o) => o === cs || !evaluateCheck(e.getState(), `landed:${o}`) || evaluateCheck(e.getState(), `vacated:${o}`)) &&
          // ... and no departure is rolling or still low ahead on it (3-10-3).
          Object.values(e.getState().aircraft).every((o) => !o.isDeparture || !['CLEARED_FOR_TAKEOFF', 'TAKEOFF_ROLL', 'INITIAL_CLIMB'].includes(o.phase))
        ) {
          const r = say(e, `${names[cs]}, runway one three, cleared to land`, 'TWR');
          expect(accepted(r), JSON.stringify(r.outcomes)).toBe(true);
          lands.add(cs);
        } else if (lands.has(cs) && a.frequencyId === 'TWR' && a.phase === 'RUNWAY_EXIT' && a.pendingRequest?.kind === 'FREQUENCY_CHANGE') {
          expect(accepted(say(e, `${names[cs]}, contact ground one two one point niner`, 'TWR'))).toBe(true);
        } else if (lands.has(cs) && a.frequencyId === 'GND' && a.pendingRequest?.kind === 'TAXI') {
          const r = say(e, `${names[cs]}, taxi to the gate`, 'GND');
          expect(accepted(r), JSON.stringify(r.outcomes)).toBe(true);
        }
      }
      run(e, 1);
      t++;
    }
    const st = e.getState();
    expect(cleared.size).toBe(3);
    expect(toTower.size).toBe(3);
    expect(lands.size).toBe(3);
    for (const cs of Object.keys(names)) {
      expect(evaluateCheck(st, `approach:${cs}`), `approach ${cs}`).toBe(true);
      expect(evaluateCheck(st, `established:${cs}`), `established ${cs}`).toBe(true);
      expect(evaluateCheck(st, `landed:${cs}`), `landed ${cs}`).toBe(true);
    }
    expect(st.events.some((x) => x.kind === 'GO_AROUND')).toBe(false);
    expect(game.isScenarioComplete(st)).toBe(true);
    const report = game.buildDebrief(st);
    expect(st.events.filter((x) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(x.kind) || (x.kind === 'CONFLICT' && x.severity === 'critical')).map((x) => `${x.timeSec} ${x.kind} ${x.text}`)).toEqual([]);
    expect(report.improvements.filter((x) => /Objective not completed/.test(x))).toEqual([]);
    expect(report.completed).toBe(true);
    expect(['A', 'B', 'C']).toContain(report.grade);
    expect(st.score.unsafeInstructions + st.score.runwayIncursions + st.score.separationViolations).toBe(0);
  });
});

/** Drive a lesson through the real parser/engine and feed every outcome to the controller. */
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
  const until = (pred: (s: SimulationState) => boolean, max: number) => {
    const ok = runUntil(engine, pred, max);
    ctrl.update(engine.getState());
    return ok;
  };
  /** The example transmission printed in the current step's prompt: it must be a valid instruction. */
  const example = (): string => {
    const m = /Example: "([^"]+)"/.exec(ctrl.current().prompt);
    if (!m) throw new Error(`no example in step ${ctrl.current().id}`);
    return m[1];
  };
  return { sc, engine, ctrl, speak, until, example, state: () => engine.getState() as SimulationState };
}

describe('train-08-ifr-clearance', () => {
  it('reads the example clearance, the pilot reads it back and calls Ground, the lesson completes', () => {
    const L = lesson('train-08-ifr-clearance');
    expect(L.sc.controllerPositions).toEqual(['CLNC']);
    expect(L.ctrl.current().id).toBe('wait-call');
    // Reading the clearance before the pilot has called is refused and does not complete the lesson.
    const early = L.speak('Spirit four fifty one, cleared to Philadelphia airport via the Atlantic City Three departure, radar vectors, maintain two thousand', 'CLNC');
    expect(early.outcomes[0].status).toBe('rejected');
    expect(L.until((s) => Object.values(s.aircraft)[0]?.pendingRequest?.kind === 'IFR_CLEARANCE', 40)).toBe(true);
    expect(L.ctrl.current().id).toBe('clearance');
    const step = L.ctrl.current();
    expect(step.reference).toContain('4-2-1');
    expect(step.reference).toContain('4-3-2');
    for (const word of ['clearance limit', 'squawk', 'departure frequency', 'expect']) expect(step.explanation.toLowerCase()).toContain(word);
    const r = L.speak(L.example(), 'CLNC');
    expect(accepted(r), JSON.stringify(r.outcomes)).toBe(true);
    const o = r.outcomes[0];
    expect(o.status === 'accepted' && o.clearance.ifr).toMatchObject({ destination: 'KPHL', departureProcedure: 'ATLANTIC CITY THREE', initialAltitudeFt: 2000, expectAltitudeFt: 10000, departureFrequencyMhz: 124.6, squawk: '4215' });
    expect(L.ctrl.current().id).toBe('wait-ground');
    expect(evaluateCheck(L.state(), 'ifr_clearance:NKS451')).toBe(true);
    expect(L.until((s) => evaluateCheck(s, 'handoff:NKS451'), 60)).toBe(true);
    expect(L.ctrl.isComplete()).toBe(true);
    expect(Object.values(L.state().aircraft)[0].frequencyId).toBe('GND');
    expect(game.isScenarioComplete(L.state())).toBe(true);
    const report = game.buildDebrief(L.state());
    expect(report.completed).toBe(true);
  });

  it('a clearance with a bad squawk code is refused and the lesson explains', () => {
    const L = lesson('train-08-ifr-clearance');
    L.until((s) => Object.values(s.aircraft)[0]?.pendingRequest?.kind === 'IFR_CLEARANCE', 40);
    const bad = L.speak('Spirit four fifty one, cleared to Philadelphia airport via the Atlantic City Three departure, radar vectors, maintain two thousand, squawk one two zero zero', 'CLNC');
    expect(bad.outcomes[0].status).not.toBe('accepted');
    expect(L.ctrl.current().id).toBe('clearance');
    expect(L.ctrl.current().status).toBe('error');
  });
});

describe('train-09-approach', () => {
  it('vector, approach clearance, established, handoff to Tower, using the examples printed in the prompts', () => {
    const L = lesson('train-09-approach');
    expect(L.sc.controllerPositions).toEqual(expect.arrayContaining(['APP', 'TWR']));
    const sp = L.sc.spawns[0];
    expect(sp.start).toMatchObject({ kind: 'at_fix', fix: 'VCN', altitudeFt: 4000 });
    L.until((s) => Object.values(s.aircraft)[0]?.pendingRequest?.kind === 'APPROACH', 20);
    expect(L.ctrl.current().id).toBe('vector');
    expect(L.ctrl.current().reference).toContain('5-9-2');
    expect(L.ctrl.current().explanation).toContain('30 degrees');
    expect(L.ctrl.current().explanation).toContain('MAYBN');
    const v = L.speak(L.example(), 'APP');
    expect(accepted(v), JSON.stringify(v.outcomes)).toBe(true);
    expect(L.ctrl.current().id).toBe('clear');
    expect(L.ctrl.current().reference).toContain('4-8-1');
    const c = L.speak(L.example(), 'APP');
    expect(accepted(c), JSON.stringify(c.outcomes)).toBe(true);
    expect(c.commands.map((x) => x.kind)).toEqual(['ALTITUDE', 'APPROACH']);
    expect(L.ctrl.current().id).toBe('wait-established');
    expect(L.until((s) => evaluateCheck(s, 'established:NKS451'), 400)).toBe(true);
    expect(L.ctrl.current().id).toBe('handoff');
    const h = L.speak(L.example(), 'APP');
    expect(accepted(h), JSON.stringify(h.outcomes)).toBe(true);
    expect(L.ctrl.isComplete()).toBe(true);
    expect(evaluateCheck(L.state(), 'approach:NKS451')).toBe(true);
    expect(L.until((s) => Object.values(s.aircraft)[0]?.frequencyId === 'TWR', 20)).toBe(true);
    expect(game.isScenarioComplete(L.state())).toBe(true);
  });

  it('a steep intercept or a late clearance is refused in training and the lesson says why', () => {
    const L = lesson('train-09-approach');
    L.until((s) => Object.values(s.aircraft)[0]?.pendingRequest?.kind === 'APPROACH', 20);
    // Fly the aircraft the wrong way, then ask for the approach: no way to intercept within 30 degrees.
    const turn = L.speak('Spirit four fifty one, turn left heading three six zero', 'APP');
    expect(accepted(turn)).toBe(true);
    const clr = L.speak('Spirit four fifty one, cleared I-L-S runway one three approach', 'APP');
    expect(clr.outcomes[0].status).toBe('rejected');
    const o = clr.outcomes[0];
    expect(o.status === 'rejected' && /intercept|final approach course/i.test(o.reason)).toBe(true);
    expect(L.ctrl.current().id).toBe('clear');
    expect(L.ctrl.current().status).toBe('error');
    expect(L.ctrl.current().lastFeedback).toMatch(/5-9-1|5-9-4|4-8-1/);
  });
});
