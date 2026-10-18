/** Session wiring of the coordination channel: landline calls (typed, mode, two-position auto-detect), panel answers, AI landline audio, staffing. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { game } from '../../game';
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import type { SpeakRequest } from '../../voice';
import type { AiControllerOptions, AiControllers } from '../../ai';
import type { ControllerPositionId } from '../../sim/types';
import type { LandlineResult } from '../commands/landline';
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

function build(player: ControllerPositionId[]) {
  const scenario = game.buildScenario('career-05-ground-taxi', airport, { seed: 3, playerPositions: player });
  scenario.activeRunways = { departing: ['13', '22'], landing: ['13'] };
  const { sink, onPilotTransmission } = createPilotSink();
  const engine = createEngine({ airport, scenario, onPilotTransmission, trafficGenerator: game.createTrafficGenerator(scenario, airport) });
  const spoken: SpeakRequest[] = [];
  const results: LandlineResult[] = [];
  let aiOpts: AiControllerOptions | undefined;
  session = startSession({
    engine, scenario, controller: { positions: player }, startUtcMs: Date.UTC(2026, 9, 17, 12), atisLetter: 'B',
    training: null, pilotSink: sink, enableVoice: false,
    tts: { speak: (r) => { spoken.push(r); r.onStart?.(); r.onEnd?.(); return Promise.resolve(); }, cancel: () => undefined, listVoices: () => [] },
    createAi: (o) => {
      aiOpts = o;
      const fake: AiControllers = { update() {}, positions: () => o.positions, status: () => ({}), dispose() {} };
      return fake;
    },
    hooks: {
      onRev() {}, onVoiceStatus() {}, onPartial() {}, onTransmitting() {}, onTransmitResult() {}, onTraining() {}, onAtis() {}, onScenarioComplete() {},
      onNotice() {}, onLandlineResult: (r) => results.push(r),
    },
  });
  return { engine, spoken, results, ai: () => aiOpts };
}

/** Any aircraft of the scenario. */
const anyAircraft = (engine: ReturnType<typeof build>['engine']) => Object.values(engine.getState().aircraft)[0];

describe('landline in a session', () => {
  it('a call that starts with two position names is a landline call, not a radio instruction; the request is on the channel', () => {
    const { engine, results } = build(['GND']);
    const ac = anyAircraft(engine);
    const r = session!.submit(`Tower, Ground, request to cross runway one three at alpha with ${ac.spokenCallsign}`, 'typed');
    expect(r.commands).toHaveLength(0);
    expect(r.summary).toBe('accepted');
    expect(r.message).toMatch(/^Landline: /);
    expect(results).toHaveLength(1);
    const req = engine.getState().coordination!.requests[0];
    expect(req).toMatchObject({ topic: 'CROSSING', from: 'GND', to: 'TWR', callsign: ac.callsign, runwayId: '13/31', source: 'player' });
  });

  it('refuses a call from a position the player does not work, and an answer with nothing waiting', () => {
    const { engine } = build(['GND']);
    const ac = anyAircraft(engine);
    expect(session!.submitLandline(`Ground, Tower, cross runway one three at alpha`, 'typed')).toMatchObject({ summary: 'rejected', message: expect.stringMatching(/do not work Tower/) });
    expect(session!.submitLandline(`Tower, Ground, ${ac.spokenCallsign} point out approved`, 'typed').summary).toBe('rejected');
    expect(engine.getState().coordination!.requests).toHaveLength(0);
  });

  it('landline mode sends anything the player says to the landline', () => {
    const { engine } = build(['GND']);
    const ac = anyAircraft(engine);
    expect(session!.getLandlineMode()).toBe(false);
    session!.setLandlineMode(true);
    const r = session!.submit(`Tower, Ground, request to cross runway one three at alpha with ${ac.spokenCallsign}`, 'typed');
    expect(r.commands).toHaveLength(0);
    expect(engine.getState().coordination!.requests).toHaveLength(1);
    session!.setLandlineMode(false);
  });

  it('the panel buttons answer a request waiting for the player (Tower player, AI Ground asks)', () => {
    const { engine } = build(['TWR']);
    const ac = anyAircraft(engine);
    const api = (engine as unknown as { coordination: { request(i: unknown): { id: string } } }).coordination;
    const r = api.request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: ac.id, runwayId: '13/31', point: 'A', source: 'ai' });
    session!.answerRequest(r.id, 'approve');
    const req = engine.getState().coordination!.requests[0];
    expect(req.status).toBe('approved');
    expect(engine.getState().coordination!.messages.at(-1)).toMatchObject({ kind: 'CROSS_APPROVED', source: 'player', from: 'TWR', to: 'GND' });
    session!.rescindRequest(r.id, 'traffic on final');
    expect(engine.getState().coordination!.requests[0].status).toBe('rescinded');
  });

  it('tells the engine who is human and who is AI (an AI position is staffed, an unstaffed one is not)', () => {
    const { engine } = build(['GND']);
    expect(engine.getState().coordination!.human).toEqual(['GND']);
    expect(engine.getState().coordination!.staffed).toEqual(expect.arrayContaining(['GND', 'TWR']));
    session!.dispose();
    const both = build(['GND', 'TWR']);
    expect(both.engine.getState().coordination!.human).toEqual(['GND', 'TWR']);
  });
});

describe('AI landline audio', () => {
  const say = (o: AiControllerOptions | undefined, over: Record<string, unknown> = {}) =>
    o?.onTransmission?.({ position: 'TWR', frequencyMhz: 120.3, text: 'Ground, Tower, cross runway 13 at A', spokenText: 'Ground, Tower, cross runway one three at alpha', callsign: 'N60DX', timeSec: 1, voiceId: 'atc-twr', channel: 'landline', toPosition: 'GND', ...over });

  it('a call for the player is spoken (flagged landline, on the player\'s frequency); a call between two AI positions is not', () => {
    const { spoken, ai } = build(['GND']);
    say(ai());
    expect(spoken.map((s) => s.text)).toEqual(['Ground, Tower, cross runway one three at alpha']);
    say(ai(), { toPosition: 'APP', position: 'DEP' });
    expect(spoken).toHaveLength(1);
  });

  it('"Monitor all" lets the player hear calls between AI positions, quieter', () => {
    const { spoken, ai } = build(['GND']);
    voiceSettings.update({ monitorAll: true });
    say(ai(), { toPosition: 'APP', position: 'DEP' });
    expect(spoken).toHaveLength(1);
    expect(spoken[0].volume).toBeLessThan(1);
  });
});
