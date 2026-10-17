/** Session wiring of AI controllers and pilot/AI audio routing (fake AI, fake speech provider). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { game } from '../../game';
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import { MONITOR_ALL_VOLUME } from '../../voice';
import type { SpeakRequest } from '../../voice';
import type { AiControllerOptions, AiControllers, AiTransmission } from '../../ai';
import type { ControllerPositionId } from '../../sim/types';
import { createPilotSink, startSession } from './session';
import type { Session } from './session';
import { voiceSettings } from './voiceSettings';

const airport = loadKacy();
let session: Session | null = null;
afterEach(() => {
  session?.dispose();
  session = null;
  voiceSettings.update({ monitorAll: false, ttsEnabled: true });
});
beforeEach(() => voiceSettings.update({ monitorAll: false, ttsEnabled: true }));

interface FakeAi extends AiControllers { opts: AiControllerOptions; updates: number[]; disposed: boolean; say(t: Partial<AiTransmission>): void; statusText: Record<string, string> }

function build(opts: { scenario?: string; player: ControllerPositionId[]; enableAi?: boolean; ttsVoices?: number }) {
  const scenario = game.buildScenario(opts.scenario ?? 'career-05-ground-taxi', airport, { seed: 3, playerPositions: opts.player });
  const { sink, onPilotTransmission } = createPilotSink();
  const engine = createEngine({ airport, scenario, onPilotTransmission, trafficGenerator: game.createTrafficGenerator(scenario, airport) });
  if (scenario.weather !== 'live') engine.setWeather(scenario.weather);
  const spoken: SpeakRequest[] = [];
  const created: FakeAi[] = [];
  const notices: string[] = [];
  const speaking: Array<[boolean, string | undefined]> = [];
  session = startSession({
    engine, scenario, controller: { positions: opts.player }, startUtcMs: Date.UTC(2026, 9, 17, 12), atisLetter: 'B',
    training: null, pilotSink: sink, enableVoice: false, enableAi: opts.enableAi,
    tts: {
      speak: (r) => { spoken.push(r); r.onStart?.(); r.onEnd?.(); return Promise.resolve(); },
      cancel: () => undefined,
      listVoices: () => Array.from({ length: opts.ttsVoices ?? 3 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, lang: 'en-US', localService: true, isDefault: false })),
    },
    createAi: (o) => {
      const fake: FakeAi = {
        opts: o, updates: [], disposed: false, statusText: { TWR: 'TWR (AI): 1 aircraft, sequencing NKS451 to land' },
        update(st) { this.updates.push(st.clock.tick); },
        positions: () => o.positions,
        status() { return this.statusText; },
        dispose() { this.disposed = true; },
        say(t) { o.onTransmission?.({ position: 'TWR', frequencyMhz: 120.3, text: 'NKS451, runway 13, cleared to land', spokenText: 'Spirit four fifty one, runway one three, cleared to land', callsign: 'NKS451', timeSec: 0, voiceId: 'ai-twr', ...t }); },
      };
      created.push(fake);
      return fake;
    },
    hooks: {
      onRev() {}, onVoiceStatus() {}, onPartial() {}, onTransmitting() {}, onTransmitResult() {}, onTraining() {}, onAtis() {}, onScenarioComplete() {},
      onNotice: (_l, t) => notices.push(t), onSpeaking: (on, who) => speaking.push([on, who]),
    },
  });
  return { engine, scenario, spoken, created, notices, speaking };
}

describe('AI controllers in a session', () => {
  it('creates AI for the scenario positions the player does not work, handing over the player positions', () => {
    const { created, scenario } = build({ player: ['GND'] });
    expect(scenario.controllerPositions).toEqual(['GND', 'TWR']);
    expect(created).toHaveLength(1);
    expect(created[0].opts.positions).toEqual(['TWR']);
    expect(created[0].opts.playerPositions).toEqual(['GND']);
    expect(created[0].opts.seed).toBe(3);
    expect(session!.getController()).toEqual({ positions: ['GND'], aiPositions: ['TWR'] });
  });

  it('creates nothing when the player works every position, or when AI is switched off', () => {
    expect(build({ player: ['GND', 'TWR'] }).created).toHaveLength(0);
    session?.dispose();
    const off = build({ player: ['GND'], enableAi: false });
    expect(off.created).toHaveLength(0);
    expect(session!.getController().aiPositions).toEqual([]);
    expect(session!.aiPositions()).toEqual([]);
  });

  it('updates the AI on every engine step, once per tick, and not when the engine does not advance', () => {
    const { engine, created } = build({ player: ['GND'] });
    for (let i = 0; i < 25; i++) engine.step();
    const ai = created[0];
    expect(ai.updates).toHaveLength(25);
    expect(new Set(ai.updates).size).toBe(25);
    expect(ai.updates).toEqual([...ai.updates].sort((a, b) => a - b));
    engine.setSpeed(0);
    engine.advance(1);
    expect(ai.updates).toHaveLength(25);
  });

  it('does not re-enter the AI when its own command notifies the engine subscribers mid-update', () => {
    const { engine, created } = build({ player: ['GND'] });
    const ai = created[0];
    ai.update = function (st) {
      this.updates.push(st.clock.tick);
      engine.logEvent({ kind: 'INFO', text: 'ai command', severity: 'info', speaker: 'SYSTEM' }); // notifies subscribers
    };
    for (let i = 0; i < 5; i++) engine.step();
    expect(ai.updates).toHaveLength(5);
  });

  it('exposes each AI position with its frequency and status text, and survives an AI that throws', () => {
    const { engine, created } = build({ player: ['GND'] });
    expect(session!.aiPositions()).toEqual([{ position: 'TWR', mhz: 120.3, text: 'TWR (AI): 1 aircraft, sequencing NKS451 to land' }]);
    created[0].update = () => { throw new Error('boom'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => engine.step()).not.toThrow();
    err.mockRestore();
  });

  it('rebuilds the AI when the player changes position, and disposes the old one', () => {
    const { created } = build({ player: ['GND'] });
    session!.setController({ positions: ['TWR'] });
    expect(created[0].disposed).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1].opts.positions).toEqual(['GND']);
    expect(created[1].opts.playerPositions).toEqual(['TWR']);
    session!.setController({ positions: ['GND', 'TWR'] });
    expect(created[1].disposed).toBe(true);
    expect(created).toHaveLength(2); // nothing left for AI
    expect(session!.aiPositions()).toEqual([]);
  });

  it('disposes the AI with the session', () => {
    const { created } = build({ player: ['GND'] });
    session!.dispose();
    expect(created[0].disposed).toBe(true);
    session = null;
  });

  it('reports a failure to create AI as a notice and carries on without it', () => {
    const scenario = game.buildScenario('career-05-ground-taxi', airport, { seed: 3, playerPositions: ['GND'] });
    const { sink, onPilotTransmission } = createPilotSink();
    const engine = createEngine({ airport, scenario, onPilotTransmission });
    const notices: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    session = startSession({
      engine, scenario, controller: { positions: ['GND'] }, startUtcMs: 0, atisLetter: 'A', training: null, pilotSink: sink, enableVoice: false,
      createAi: () => { throw new Error('no AI today'); },
      hooks: { onRev() {}, onVoiceStatus() {}, onPartial() {}, onTransmitting() {}, onTransmitResult() {}, onTraining() {}, onAtis() {}, onScenarioComplete() {}, onNotice: (_l, t) => notices.push(t) },
    });
    err.mockRestore();
    expect(notices[0]).toMatch(/AI controllers could not start.*no AI today/);
    expect(session.getController().aiPositions).toEqual([]);
  });
});

describe('who is audible', () => {
  it('speaks an AI transmission on a frequency the player works (e.g. a shared APP/DEP frequency)', () => {
    const { created, spoken } = build({ player: ['TWR'] });
    created[0]?.say({ frequencyMhz: 120.3 });
    // AI exists only for Ground here; its call on the player's Tower frequency is audible at full volume.
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ text: 'Spirit four fifty one, runway one three, cleared to land', voiceId: 'ai-twr' });
    expect(spoken[0].volume).toBe(1);
  });

  it('does not speak AI traffic on a frequency the player does not work, unless Monitor all is on (then at lower volume)', () => {
    const { created, spoken } = build({ player: ['GND'] });
    created[0].say({ frequencyMhz: 120.3 }); // AI Tower on its own frequency
    expect(spoken).toHaveLength(0);
    voiceSettings.update({ monitorAll: true });
    created[0].say({ frequencyMhz: 120.3 });
    expect(spoken).toHaveLength(1);
    expect(spoken[0].volume).toBeCloseTo(MONITOR_ALL_VOLUME);
    expect(MONITOR_ALL_VOLUME).toBeLessThan(1);
  });

  it('speaks pilots on every frequency the player works at once, and only those', () => {
    const { engine, spoken } = build({ scenario: 'career-02-single-takeoff', player: ['GND', 'TWR'] });
    // Pilot calls come from the scenario itself: run until some pilot has spoken on Ground.
    for (let i = 0; i < 600 && spoken.length === 0; i++) engine.step();
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken[0].volume).toBe(1);
  });

  it('silences pilots on an AI-worked frequency by default, and lets the player hear them at lower volume with Monitor all', () => {
    const quiet = build({ scenario: 'career-05-ground-taxi', player: ['TWR'] }); // Ground is AI: its pilots talk on 121.9
    for (let i = 0; i < 900; i++) quiet.engine.step();
    const pilotsOnGround = quiet.engine.getState().events.filter((e) => e.speaker === 'PILOT' && e.frequencyMhz === 121.9);
    expect(pilotsOnGround.length).toBeGreaterThan(0);
    expect(quiet.spoken).toHaveLength(0);
    session?.dispose();

    voiceSettings.update({ monitorAll: true });
    const loud = build({ scenario: 'career-05-ground-taxi', player: ['TWR'] });
    for (let i = 0; i < 900; i++) loud.engine.step();
    expect(loud.spoken.length).toBeGreaterThan(0);
    expect(loud.spoken[0].volume).toBeCloseTo(MONITOR_ALL_VOLUME);
  });

  it('turns the live "speaking" state on and off with the browser\'s utterance events', () => {
    const { created, speaking } = build({ player: ['TWR'] });
    created[0]?.say({ frequencyMhz: 120.3 });
    expect(speaking).toEqual([[true, 'TWR (AI)'], [false, 'TWR (AI)']]);
  });

  it('Pilot audio off: nothing is spoken at all', () => {
    const { created, spoken } = build({ player: ['TWR'] });
    voiceSettings.update({ ttsEnabled: false });
    created[0]?.say({ frequencyMhz: 120.3 });
    expect(spoken).toHaveLength(0);
  });

  it('reports speech support and the number of voices', () => {
    build({ player: ['TWR'], ttsVoices: 4 });
    expect(session!.audioInfo()).toEqual({ supported: true, voices: 4 });
  });
});
