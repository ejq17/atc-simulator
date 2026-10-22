import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadKacy, runwayEntryNodes } from '../../airport';
import { createEngine } from '../../sim/engine';
import { getPresetWeather } from '../../weather/presets';
import type { Scenario, ParsedCommand } from '../../sim/types';
import { game } from '../../game';
import type { LlmParser } from '../../commands/llm/client';
import { LlmParseError } from '../../commands/llm/client';
import type { LlmParseRequest, LlmParseResponse } from '../../commands/llm/contract';
import type { TransmitResult } from '../commands/transmit';
import { voiceSettings } from './voiceSettings';
import { createPilotSink, startSession } from './session';
import type { Session } from './session';

const airport = loadKacy();
let session: Session | null = null;
const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
beforeEach(() => {
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => undefined;
  voiceSettings.update({ interpreterEnabled: true });
});
afterEach(() => { session?.dispose(); session = null; delete g.requestAnimationFrame; delete g.cancelAnimationFrame; voiceSettings.reset(); });

const nodeId = (e: unknown) => (e as { node?: { id: string }; id?: string }).node?.id ?? (e as { id: string }).id;
const CLEAR = 'Cessna seven two three echo juliet, runway one three, cleared for takeoff';
const VAGUE = 'Cessna seven two three echo juliet, whenever you like go ahead and zoom off';
const TAKEOFF_13 = { kind: 'TAKEOFF' as const, callsign: 'N723EJ', runwayEnd: '13', runwayId: '13/31' };

function build(interpreter: LlmParser | null) {
  const hold13 = nodeId(runwayEntryNodes(airport, '13')[0]);
  const scenario: Scenario = {
    id: 'interp-test', name: 'Interpreter test', description: 'scripted', mode: 'training', seed: 5, weather: getPresetWeather('clear'),
    activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR'],
    spawns: [{ atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: hold13, runwayEnd: '13' }, isDeparture: true, initialFrequencyId: 'TWR', initialRequest: 'DEPARTURE' }],
  };
  const { sink, onPilotTransmission } = createPilotSink();
  const heard: string[] = [];
  const engine = createEngine({ airport, scenario, readbackErrorRate: 0, onPilotTransmission: (t) => { heard.push(t.text); sink.handler?.(t); } });
  const results: TransmitResult[] = [];
  session = startSession({
    engine, scenario, controller: { positions: ['TWR'] }, startUtcMs: Date.UTC(2026, 9, 16, 15, 0, 0), atisLetter: 'B', training: game.createTrainingController(scenario),
    pilotSink: sink, enableVoice: false, enableAi: false, interpreter,
    hooks: {
      onRev() {}, onVoiceStatus() {}, onPartial() {}, onTransmitting() {}, onTransmitResult: (r) => results.push(r), onTraining() {}, onAtis() {}, onScenarioComplete() {}, onNotice() {},
    },
  });
  void onPilotTransmission;
  for (let i = 0; i < 80; i++) engine.step(); // the pilot's first call
  const executed = (): ParsedCommand[] => results.flatMap((r) => r.results.map((x) => x.command));
  return { engine, heard, results, executed };
}

function fake(answer: () => Promise<LlmParseResponse>) {
  const calls: LlmParseRequest[] = [];
  const parser: LlmParser = { parse: (req) => { calls.push(req); return answer(); } };
  return { parser, calls };
}
const ok = (commands: LlmParseResponse['commands']): Promise<LlmParseResponse> => Promise.resolve({ commands, model: 'fake', latencyMs: 3 });
const flush = () => new Promise((r) => setTimeout(r, 0));
const events = (engine: ReturnType<typeof build>['engine']) => engine.getState().events.map((e) => e.text);

describe('session phrase interpreter fallback', () => {
  it('a clear instruction never calls the interpreter and returns the real result synchronously', async () => {
    const { parser, calls } = fake(() => ok([]));
    const { results } = build(parser);
    const r = session!.submit(CLEAR, 'typed');
    expect(r.summary).toBe('accepted');
    await flush();
    expect(calls).toHaveLength(0);
    expect(results).toHaveLength(1);
  });

  it('an unparseable phrasing calls the interpreter once; the command runs once with interpretedBy llm', async () => {
    const { parser, calls } = fake(() => ok([TAKEOFF_13]));
    const { engine, heard, results, executed } = build(parser);
    const spokenBefore = heard.length;
    const r = session!.submit(VAGUE, 'typed');
    expect(r).toMatchObject({ summary: 'empty', message: 'Interpreting…' });
    expect(events(engine).some((t) => /phrase interpreter/i.test(t))).toBe(true);
    expect(heard.length).toBe(spokenBefore); // nothing executed yet
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe(VAGUE);
    expect(calls[0].context.runwayEnds).toContain('13');
    expect(results.map((x) => x.summary)).toEqual(['empty', 'accepted']);
    expect(results[1].message).toMatch(/^Issued: takeoff N723EJ \(phrase interpreter, \d+\.\d s\)$/);
    expect(executed()).toHaveLength(1);
    expect(executed()[0].interpretedBy).toBe('llm');
    expect(heard.length).toBe(spokenBefore + 1); // exactly one readback
  });

  it('an interpreter failure falls back to the grammar result: one clarification, no second pilot answer', async () => {
    const { parser, calls } = fake(() => Promise.reject(new LlmParseError('UPSTREAM_ERROR', 'boom')));
    const { engine, heard, results } = build(parser);
    const spokenBefore = heard.length;
    session!.submit(VAGUE, 'typed');
    await flush();
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(2);
    expect(results[1].commands.every((c) => c.interpretedBy !== 'llm')).toBe(true);
    expect(results[1].results.filter((x) => x.outcome.status === 'accepted')).toHaveLength(0);
    expect(heard.length - spokenBefore).toBeLessThanOrEqual(1); // at most the grammar's own say-again
    expect(events(engine).filter((t) => /Phrase interpreter unavailable/.test(t))).toHaveLength(1);
  });

  it('503 not configured: logs the reason and stops trying for the rest of the session', async () => {
    const { parser, calls } = fake(() => Promise.reject(new LlmParseError('LLM_NOT_CONFIGURED', 'no key', 503)));
    const { engine } = build(parser);
    session!.submit(VAGUE, 'typed');
    await flush();
    expect(events(engine).some((t) => /not configured on the local backend/.test(t))).toBe(true);
    session!.submit('Spirit four fifty one, mumble mumble', 'typed');
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('a timeout is reported briefly and the grammar result is used', async () => {
    const { parser } = fake(() => Promise.reject(new LlmParseError('TIMEOUT', 'slow')));
    const { engine, results } = build(parser);
    session!.submit(VAGUE, 'typed');
    await flush();
    expect(events(engine).some((t) => /took too long/.test(t))).toBe(true);
    expect(results).toHaveLength(2);
  });

  it('a model answer that names an unknown aircraft is dropped and the grammar result is kept', async () => {
    const { parser } = fake(() => ok([{ ...TAKEOFF_13, callsign: 'N11111' }]));
    const { results, executed } = build(parser);
    session!.submit(VAGUE, 'typed');
    await flush();
    expect(results).toHaveLength(2);
    expect(executed().some((c) => c.interpretedBy === 'llm')).toBe(false);
  });

  it('a malformed model answer falls back to the grammar result instead of losing the transmission', async () => {
    const { parser } = fake(() => Promise.resolve({ commands: [{ kind: 'TAKEOFF', callsign: 12345 }], model: 'fake', latencyMs: 1 } as unknown as LlmParseResponse));
    const { engine, results } = build(parser);
    session!.submit(VAGUE, 'typed');
    await flush();
    expect(results).toHaveLength(2);
    expect(results[1].message).not.toBe('Interpreting…');
    expect(events(engine).some((t) => /Phrase interpreter unavailable \(unusable answer/.test(t))).toBe(true);
  });

  it('a parser that throws synchronously is handled like a rejection', async () => {
    const parser: LlmParser = { parse: () => { throw new Error('sync boom'); } };
    const { engine, results } = build(parser);
    expect(() => session!.submit(VAGUE, 'typed')).not.toThrow();
    await flush();
    expect(results).toHaveLength(2);
    expect(events(engine).some((t) => /sync boom/.test(t))).toBe(true);
  });

  it('a session disposed while the request is in flight executes nothing', async () => {
    let release!: (r: LlmParseResponse) => void;
    const { parser } = fake(() => new Promise<LlmParseResponse>((r) => { release = r; }));
    const { heard, results } = build(parser);
    const spokenBefore = heard.length;
    session!.submit(VAGUE, 'typed');
    await flush(); // the request is now in flight
    session!.dispose();
    release({ commands: [TAKEOFF_13], model: 'fake', latencyMs: 1 });
    await flush();
    expect(results).toHaveLength(1); // only the provisional result
    expect(heard.length).toBe(spokenBefore);
  });

  it('with the setting off the interpreter is never called', async () => {
    voiceSettings.update({ interpreterEnabled: false });
    const { parser, calls } = fake(() => ok([TAKEOFF_13]));
    const { results } = build(parser);
    const r = session!.submit(VAGUE, 'typed');
    expect(r.message).not.toBe('Interpreting…');
    await flush();
    expect(calls).toHaveLength(0);
    expect(results).toHaveLength(1);
  });

  it('landline calls never use the interpreter', async () => {
    const { parser, calls } = fake(() => ok([]));
    build(parser);
    session!.submitLandline('Ground, Tower, something unintelligible', 'typed');
    session!.submit('Tower, Ground, request to cross runway one three at alpha with Cessna seven two three echo juliet', 'typed');
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('no interpreter (null) behaves as before', async () => {
    const { results } = build(null);
    const r = session!.submit(VAGUE, 'typed');
    expect(r.message).not.toBe('Interpreting…');
    expect(results).toHaveLength(1);
  });
});
