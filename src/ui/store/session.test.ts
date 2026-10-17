import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { game, createScenarioEventRunner } from '../../game';
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import { createPilotSink, startSession } from './session';
import type { Session } from './session';

const airport = loadKacy();
let pending: ((t: number) => void) | null = null;
let session: Session | null = null;
const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };

beforeEach(() => {
  pending = null;
  g.requestAnimationFrame = (cb: (t: number) => void) => { pending = cb; return 1; };
  g.cancelAnimationFrame = () => { pending = null; };
});
afterEach(() => { session?.dispose(); session = null; delete g.requestAnimationFrame; delete g.cancelAnimationFrame; });

function build(id: string) {
  const scenario = game.buildScenario(id, airport, { seed: 3 });
  const { sink, onPilotTransmission } = createPilotSink();
  const engine = createEngine({ airport, scenario, onPilotTransmission, trafficGenerator: game.createTrafficGenerator(scenario, airport) });
  if (scenario.weather !== 'live') engine.setWeather(scenario.weather);
  const runner = createScenarioEventRunner(engine, scenario, { onPilotTransmission: (t) => sink.handler?.(t) });
  const notices: { level: string; text: string }[] = [];
  const atis: string[] = [];
  session = startSession({
    engine, scenario, controller: { positions: ['TWR'] }, startUtcMs: Date.UTC(2026, 9, 16, 15, 0, 0), atisLetter: 'B', training: game.createTrainingController(scenario), runner, pilotSink: sink, enableVoice: false,
    hooks: {
      onRev() {}, onVoiceStatus() {}, onPartial() {}, onTransmitting() {}, onTransmitResult() {}, onTraining() {}, onAtis: (a) => atis.push(a.letter),
      onScenarioComplete() {}, onNotice: (level, text) => notices.push({ level, text }),
    },
  });
  return { engine, notices, atis, scenario };
}

const frame = () => pending?.(performance.now() + 20);

describe('session', () => {
  it('generates the initial ATIS with the given letter and writes it into the engine state', () => {
    const { engine, atis } = build('career-01-first-radio');
    expect(atis).toEqual(['B']);
    expect(engine.getState().atis.letter).toBe('B');
    expect(session!.atis.simulated).toBe(true);
    expect(session!.atis.text).toContain('information Bravo');
  });

  it('career 10: the scripted wind shift re-issues the ATIS but does NOT change the active runways', () => {
    const { engine, notices, atis } = build('career-10-runway-change');
    const before = JSON.stringify(engine.getState().activeRunways);
    const windBefore = engine.getState().weather.windDirDeg;
    for (let i = 0; i < 6100; i++) engine.step(); // past 600 s
    frame();
    expect(engine.getState().weather.windDirDeg).not.toBe(windBefore);
    expect(JSON.stringify(engine.getState().activeRunways)).toBe(before);
    expect(atis.length).toBeGreaterThanOrEqual(2); // a new letter was issued
    expect(atis[atis.length - 1]).toBe('C');
    expect(engine.getState().atis.letter).toBe('C');
    expect(notices.some((n) => /runway/i.test(n.text))).toBe(true);
  });

  it('changing runways by hand re-issues the ATIS and keeps pilots on the same engine', () => {
    const { engine, atis } = build('career-01-first-radio');
    session!.setActiveRunways({ departing: ['31'], landing: ['31'] });
    expect(engine.getState().activeRunways.landing).toEqual(['31']);
    expect(atis[atis.length - 1]).toBe('C');
    expect(session!.atis.text).toMatch(/runway 31/i);
  });

  it('scripted pilot calls reach the event log', () => {
    const { engine } = build('career-01-first-radio');
    for (let i = 0; i < 100; i++) engine.step();
    expect(engine.getState().events.some((e) => e.speaker === 'PILOT')).toBe(true);
  });
});
