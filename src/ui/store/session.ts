/**
 * A running simulator session: ONE engine, the rAF loop that advances it, the render buffer the canvases
 * interpolate from, and the voice stack (push-to-talk, pilot TTS). Framework-free so it can be driven and
 * tested without React; `simStore.ts` wraps it for the UI.
 */
import { createEngine } from '../../sim/engine';
import type { SimulationEngine } from '../../sim/api';
import type {
  Atis, ControllerPositionId, Scenario, SimulationState, Weather,
} from '../../sim/types';
import type { ScenarioEventRunner, TrainingController, TrainingStepState } from '../../game';
import { game } from '../../game';
import { sameFrequency } from '../../radio/frequencies';
import { altimeterText, windText } from '../lib/format';
import { atisNeedsUpdate, generateAtis, nextAtisLetter } from '../../weather/atis';
import type { SimulatedAtis } from '../../weather/atis';
import {
  MONITOR_ALL_VOLUME, createBrowserTts, createPilotVoice, createRadioEffects, createTranscriptLog, createVoiceController,
} from '../../voice';
import { createAiControllers } from '../../ai';
import type { AiControllers, AiTransmission } from '../../ai';
import type { SpeechSynthesisProvider, TranscriptLog, TransmissionQueue, VoiceController, VoiceStatusEvent } from '../../voice';
import { createRenderBuffer } from '../display/renderBuffer';
import type { RenderBuffer } from '../display/renderBuffer';
import { controllerFrequencies, transmit } from '../commands/transmit';
import type { ControllerSetup, TransmitResult } from '../commands/transmit';
import { voiceSettings } from './voiceSettings';
import { aiPositionsFor } from '../lib/positions';
import { frequencyForPosition } from '../../radio/frequencies';
import { createStripBoard } from '../strips/stripModel';
import type { StripBoard } from '../strips/stripModel';

export const AIRPORT_CALL_NAME = 'Atlantic City';

export interface SessionHooks {
  /** State changed in a way the React tree should re-read (throttled ~10 Hz, and immediately after commands). */
  onRev(): void;
  onVoiceStatus(e: VoiceStatusEvent): void;
  onPartial(text: string): void;
  onTransmitting(on: boolean): void;
  onTransmitResult(r: TransmitResult): void;
  onTraining(step: TrainingStepState | null): void;
  onAtis(atis: SimulatedAtis): void;
  onScenarioComplete(): void;
  onNotice(level: 'info' | 'warn' | 'error', text: string): void;
  /** The browser really started / stopped speaking a transmission (`who` = callsign or "TWR (AI)"). */
  onSpeaking?(speaking: boolean, who?: string): void;
}

/** One AI-worked position for the Radio panel's "Other positions (AI)" list. */
export interface AiPositionView {
  position: ControllerPositionId;
  mhz?: number;
  /** The controller's own status line (`AiControllers.status()`); empty until it has something to say. */
  text: string;
}

export interface SessionParams {
  engine: SimulationEngine;
  scenario: Scenario;
  controller: ControllerSetup;
  startUtcMs: number;
  atisLetter: string;
  training: TrainingController | null;
  /** Scripted scenario events (wind shift, emergency call); updated once per animation frame. */
  runner?: ScenarioEventRunner;
  hooks: SessionHooks;
  /** Set false in tests / non-browser contexts. */
  enableVoice?: boolean;
  /** Default true: positions in `scenario.controllerPositions` the player does not work are run by AI controllers. False = they stay unstaffed. */
  enableAi?: boolean;
  /** Test seam: replaces `createAiControllers`. */
  createAi?: typeof createAiControllers;
  /** Test seam: replaces the browser speech synthesis provider. */
  tts?: SpeechSynthesisProvider & { isSupported?(): boolean };
  seed?: number;
  /** Provide the pilot-transmission sink; the engine must have been created with `pilotSink`. */
  pilotSink: PilotSink;
}

/** Created before the engine so `onPilotTransmission` can reach the session once it exists. */
export interface PilotSink {
  handler: ((t: { aircraftId: string; callsign: string; text: string; frequencyMhz: number; voiceId: string }) => void) | null;
}

export function createPilotSink(): { sink: PilotSink; onPilotTransmission: NonNullable<Parameters<typeof createEngine>[0]['onPilotTransmission']> } {
  const sink: PilotSink = { handler: null };
  return { sink, onPilotTransmission: (t) => sink.handler?.(t) };
}

export interface Session {
  readonly engine: SimulationEngine;
  readonly buffer: RenderBuffer;
  readonly scenario: Scenario;
  readonly startUtcMs: number;
  readonly voice: VoiceController | null;
  readonly transcript: TranscriptLog;
  /** Flight progress strips (bays, marks, notes). Updated with the state; see `strips/stripModel.ts`. */
  readonly strips: StripBoard;
  atis: SimulatedAtis;
  getController(): ControllerSetup;
  /** Positions an AI controller works right now, with their status lines. */
  aiPositions(): AiPositionView[];
  /** Pilot audio facts for the Radio panel. */
  audioInfo(): { supported: boolean; voices: number };
  setController(setup: ControllerSetup): void;
  submit(text: string, source: 'voice' | 'typed'): TransmitResult;
  setSpeed(speed: number): void;
  getSpeed(): number;
  setWeather(w: Weather): void;
  setActiveRunways(cfg: { departing: string[]; landing: string[] }): void;
  /** Speak the simulated ATIS through the pilot TTS provider. */
  speakAtis(): void;
  stopSpeaking(): void;
  trainingStep(): TrainingStepState | null;
  dispose(): void;
}

/**
 * Approaches in use, derived from the airport's published procedures for each landing runway:
 * ILS where one exists (KACY: 13 and 31 only), else RNAV (GPS), else VOR; visual approaches in VFR.
 * Never names an approach the airport does not publish (docs/BEHAVIOUR-ACCURACY.md W4).
 */
export function approachesInUseFor(state: SimulationState): string[] {
  const out: string[] = [];
  for (const rwy of state.activeRunways.landing) {
    if (state.weather.flightCategory === 'VFR') { out.push(`visual approach runway ${rwy}`); continue; }
    const iaps = state.airport.procedures.filter((p) => p.type === 'IAP' && p.runwayEnd === rwy && !/^(HI-|COPTER)/i.test(p.name));
    const pick = iaps.find((p) => /^ILS/i.test(p.name)) ?? iaps.find((p) => /^RNAV \(GPS\)/i.test(p.name)) ?? iaps.find((p) => /^VOR/i.test(p.name));
    if (!pick) continue;
    const kind = /^ILS/i.test(pick.name) ? 'ILS' : /^RNAV/i.test(pick.name) ? 'RNAV (GPS)' : 'VOR';
    out.push(`${kind} runway ${rwy} approach`);
  }
  return out;
}

export function makeAtis(state: SimulationState, letter: string, startUtcMs: number): SimulatedAtis {
  return generateAtis({
    approachesInUse: approachesInUseFor(state),
    airportName: AIRPORT_CALL_NAME,
    icao: state.airport.icao,
    weather: state.weather,
    variationDeg: state.airport.magneticVariationDeg,
    activeRunways: state.activeRunways,
    letter,
    timeUtc: new Date(startUtcMs + state.clock.timeSec * 1000),
    elevationFt: state.airport.elevationFt,
    issuedAtSec: state.clock.timeSec,
  });
}

/**
 * The engine has no `setAtis`; it reads `state.atis.letter` when pilots check in, so keep that object current.
 * (Documented gap: docs/PROGRESS.md "Known issues".)
 */
export function applyAtisToEngine(state: SimulationState, atis: SimulatedAtis): void {
  const target: Atis = state.atis;
  target.letter = atis.letter;
  target.text = atis.text;
  target.issuedAtSec = atis.issuedAtSec;
  target.activeRunways = { departing: [...atis.activeRunways.departing], landing: [...atis.activeRunways.landing] };
  target.simulated = true;
}

export function startSession(p: SessionParams): Session {
  const { engine, hooks } = p;
  const buffer = createRenderBuffer();
  let controller: ControllerSetup = { positions: [...p.controller.positions], aiPositions: [] };
  let atis = makeAtis(engine.getState(), p.atisLetter, p.startUtcMs);
  engine.setAtis(atis);
  hooks.onAtis(atis);

  // ----- voice -------------------------------------------------------------------------------------------------
  const enableVoice = p.enableVoice ?? typeof window !== 'undefined';
  const tts: SpeechSynthesisProvider & { isSupported?(): boolean } = p.tts ?? createBrowserTts();
  const radio = enableVoice ? createRadioEffects({ enabled: voiceSettings.get().radioEffectsEnabled }) : undefined;
  const transcript = createTranscriptLog(voiceSettings);
  const pilots: TransmissionQueue = createPilotVoice({
    tts, settings: voiceSettings, radio,
    onSpeaking: (on, item) => hooks.onSpeaking?.(on, item.speaker),
  });
  /** Frequencies of the positions the player works. */
  const playerFrequencies = () => controllerFrequencies(engine.getState(), controller);
  const isPlayerFrequency = (mhz: number) => playerFrequencies().some((m) => sameFrequency(m, mhz));
  /** Every frequency of a position in the session (player or AI): what "Monitor all frequencies" lets the player hear. */
  const sessionFrequencies = () => {
    const st = engine.getState();
    const out: number[] = [];
    for (const pos of new Set([...p.scenario.controllerPositions, ...controller.positions])) {
      const f = frequencyForPosition(st.airport, pos);
      if (f && !out.some((m) => sameFrequency(m, f.mhz))) out.push(f.mhz);
    }
    return out;
  };
  /**
   * Which frequencies are audible: the player's own, plus (setting "Monitor all frequencies") every other one in the session.
   * All of them at once: a player working Tower + Ground hears both, not just the one that spoke last.
   */
  const syncMonitored = () => {
    const own = playerFrequencies();
    const list = voiceSettings.get().monitorAll ? [...own, ...sessionFrequencies().filter((m) => !own.some((o) => sameFrequency(o, m)))] : own;
    pilots.setMonitoredFrequencies(list.length ? list : [engine.getState().controllerFrequencyMhz]);
  };
  syncMonitored();
  // "Monitor all frequencies" can be switched at any time (Radio panel, Settings).
  const unsubMonitor = voiceSettings.subscribe(() => syncMonitored());
  const volumeFor = (mhz: number) => (isPlayerFrequency(mhz) ? 1 : MONITOR_ALL_VOLUME);

  p.pilotSink.handler = (t) => {
    // Informational instructions (RADAR_CONTACT) have an empty readback: nothing is said, so nothing is queued or spoken.
    if (!t.text || !t.text.trim()) return;
    const mine = isPlayerFrequency(t.frequencyMhz);
    // Inaudible unless it is on a frequency the player works (or they chose to monitor everything); the engine already logged the text.
    if (!mine && !voiceSettings.get().monitorAll) return;
    transcript.add({ text: `${t.callsign}: ${t.text}`, source: 'pilot' });
    pilots.enqueue({ text: t.text, voiceId: t.voiceId, frequencyMhz: t.frequencyMhz, volume: volumeFor(t.frequencyMhz), speaker: t.callsign });
  };

  // ----- AI controllers ------------------------------------------------------------------------------------------
  const aiEnabled = p.enableAi ?? true;
  const makeAi = p.createAi ?? createAiControllers;
  let ai: AiControllers | null = null;
  let lastAiTick = -1;
  let inAi = false;
  const onAiTransmission = (t: AiTransmission) => {
    const mine = isPlayerFrequency(t.frequencyMhz);
    if (!mine && !voiceSettings.get().monitorAll) return;
    transcript.add({ text: `${t.position} (AI): ${t.text}`, source: 'ai' });
    pilots.enqueue({ text: t.spokenText || t.text, voiceId: t.voiceId, frequencyMhz: t.frequencyMhz, volume: volumeFor(t.frequencyMhz), speaker: `${t.position} (AI)` });
  };
  const buildAi = () => {
    ai?.dispose();
    ai = null;
    const positions = aiEnabled ? aiPositionsFor(p.scenario.controllerPositions, controller.positions) : [];
    controller = { positions: controller.positions, aiPositions: positions };
    if (positions.length === 0) return;
    try {
      ai = makeAi({
        engine, airport: engine.getAirport(), positions, playerPositions: [...controller.positions],
        onTransmission: onAiTransmission, seed: p.seed ?? engine.getState().seed,
      });
      lastAiTick = -1;
    } catch (err) {
      console.error('[ui] AI controllers failed to start', err);
      controller = { positions: controller.positions, aiPositions: [] };
      hooks.onNotice('error', `AI controllers could not start (${err instanceof Error ? err.message : String(err)}); ${positions.join(', ')} stay unstaffed.`);
    }
  };
  buildAi();

  // ----- strips ----------------------------------------------------------------------------------------------------
  const strips = createStripBoard({ startUtcMs: p.startUtcMs });
  strips.update(engine.getState());

  const submit = (text: string, source: 'voice' | 'typed', confidence?: number): TransmitResult => {
    transcript.add({ text, source: source === 'voice' ? 'speech' : 'typed', confidence });
    const r = transmit({ engine, text, source, controller });
    for (const res of r.results) {
      training?.onCommand({
        kind: res.command.kind,
        status: res.outcome.status,
        reason: res.outcome.status === 'rejected' ? res.outcome.reason : undefined,
        callsign: res.command.callsign,
      });
    }
    hooks.onTransmitResult(r);
    hooks.onTraining(training ? training.update(engine.getState()) : null);
    strips.update(engine.getState());
    hooks.onRev();
    return r;
  };

  let voice: VoiceController | null = null;
  let unsubSettings: (() => void) | null = null;
  if (enableVoice) {
    const s = voiceSettings.get();
    voice = createVoiceController({
      providerId: s.providerId,
      ptt: { key: s.pttKey, mode: s.pttMode },
      onTransmission: (text, meta) => submit(text, meta.source === 'typed' ? 'typed' : 'voice', meta.confidence),
    });
    voice.onTransmittingChange((on) => {
      pilots.setControllerTransmitting(on);
      hooks.onTransmitting(on);
    });
    voice.onStatusChange((e) => {
      // A recogniser that errors out or goes idle while the key is "down" would otherwise leave the pilots muted for good.
      if ((e.status === 'idle' || e.status === 'error') && pilots.isControllerTransmitting()) pilots.setControllerTransmitting(false);
      hooks.onVoiceStatus(e);
    });
    voice.onPartial((t) => hooks.onPartial(t));
    void voice.setProvider(s.providerId);
    let lastProvider = s.providerId;
    unsubSettings = voiceSettings.subscribe((next) => {
      voice?.ptt?.setKey(next.pttKey);
      voice?.ptt?.setMode(next.pttMode);
      if (next.providerId !== lastProvider) {
        lastProvider = next.providerId;
        void voice?.setProvider(next.providerId);
      }
    });
  }

  // ----- training ----------------------------------------------------------------------------------------------
  const training = p.training;
  hooks.onTraining(training ? training.update(engine.getState()) : null);

  // ----- loop --------------------------------------------------------------------------------------------------
  let raf = 0;
  let disposed = false;
  let dirty = true;
  let lastBump = 0;
  let lastCompleteCheck = 0;
  let completeNotified = false;
  const unsubEngine = engine.subscribe((st) => {
    dirty = true;
    // Every engine step, after the engine advanced: the AI controllers read the state and act through engine.applyCommand.
    // (Their own commands notify subscribers again within the same tick; the tick guard keeps this from re-entering.)
    if (ai && !inAi && st.clock.tick !== lastAiTick) {
      lastAiTick = st.clock.tick;
      inAi = true;
      try {
        ai.update(st);
      } catch (err) {
        console.error('[ui] AI controller update failed', err);
      } finally {
        inAi = false;
      }
    }
  });
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let last = nowMs();
  buffer.capture(engine.getState(), last);

  const frame = (t: number) => {
    if (disposed) return;
    const wallDelta = Math.min(0.25, Math.max(0, (t - last) / 1000));
    last = t;
    engine.advance(wallDelta);
    const st = engine.getState();
    if (p.runner) {
      for (const ev of p.runner.update()) {
        if (ev.kind === 'weather') {
          // The runner changed the weather: new ATIS if it matters. Runways are NOT changed for the player.
          if (atisNeedsUpdate(atis, st.weather, st.activeRunways)) reissueAtis('weather change');
          const rec = ev.recommendedRunways?.landing[0];
          hooks.onNotice('warn', `${ev.text}${rec ? ` The new wind favours runway ${rec}; change the runway configuration (Runways button) when ready.` : ''}`);
        } else if (ev.kind === 'emergency') {
          hooks.onNotice('warn', `${ev.declaration}: ${ev.text}`);
        } else {
          hooks.onNotice('info', ev.text);
        }
      }
    }
    if (st.clock.tick !== buffer.lastTick()) buffer.capture(st, t);
    if (dirty && t - lastBump >= 100) {
      dirty = false;
      lastBump = t;
      if (training) hooks.onTraining(training.update(st));
      strips.update(st);
      if (!completeNotified && t - lastCompleteCheck > 1000) {
        lastCompleteCheck = t;
        if (game.isScenarioComplete(st)) {
          completeNotified = true;
          hooks.onScenarioComplete();
        }
      }
      hooks.onRev();
    }
    raf = requestAnimationFrame(frame);
  };
  if (typeof requestAnimationFrame !== 'undefined') raf = requestAnimationFrame(frame);

  // ----- weather / ATIS ------------------------------------------------------------------------------------------
  const reissueAtis = (reason: string) => {
    const st = engine.getState();
    atis = makeAtis(st, nextAtisLetter(atis.letter), p.startUtcMs);
    engine.setAtis(atis);
    session.atis = atis;
    engine.logEvent({ kind: 'INFO', text: `ATIS information ${atis.phonetic} is current (${reason}).`, severity: 'info', speaker: 'SYSTEM' });
    hooks.onAtis(atis);
  };

  const session: Session = {
    engine,
    buffer,
    scenario: p.scenario,
    startUtcMs: p.startUtcMs,
    voice,
    transcript,
    strips,
    atis,
    getController: () => controller,
    aiPositions() {
      const st = engine.getState();
      const status = ai?.status() ?? {};
      return (controller.aiPositions ?? []).map((position) => ({ position, mhz: frequencyForPosition(st.airport, position)?.mhz, text: status[position] ?? '' }));
    },
    audioInfo: () => ({ supported: tts.isSupported?.() ?? true, voices: tts.listVoices().length }),
    setController(setup) {
      controller = { positions: [...setup.positions], aiPositions: [] };
      const primary: ControllerPositionId = controller.positions[0] ?? 'TWR';
      engine.setControllerPosition(primary);
      buildAi(); // the positions the player no longer works go to AI, the ones now worked are released
      syncMonitored();
      hooks.onRev();
    },
    submit: (text, source) => submit(text, source),
    setSpeed(speed) {
      engine.setSpeed(speed);
      hooks.onRev();
    },
    getSpeed: () => engine.getState().clock.speed,
    setWeather(w) {
      const st = engine.getState();
      const needs = atisNeedsUpdate(atis, w, st.activeRunways);
      engine.setWeather(w);
      engine.logEvent({
        kind: 'INFO', speaker: 'SYSTEM', severity: 'info',
        text: `Weather: wind ${windText(w, st.airport.magneticVariationDeg)} (magnetic), ${altimeterText(w.altimeterInHg)}, ${w.visibilitySm} SM, ${w.flightCategory}.`,
      });
      if (needs) reissueAtis('weather change');
      hooks.onRev();
    },
    setActiveRunways(cfg) {
      const st = engine.getState();
      const needs = atisNeedsUpdate(atis, st.weather, cfg);
      engine.setActiveRunways(cfg);
      if (needs) reissueAtis('runway change');
      hooks.onRev();
    },
    speakAtis() {
      pilots.clear();
      void tts.speak({ text: atis.spokenText, voiceId: 'atis', rate: voiceSettings.get().ttsRate, volume: voiceSettings.get().ttsVolume });
    },
    stopSpeaking: () => tts.cancel(),
    trainingStep: () => (training ? training.current() : null),
    dispose() {
      disposed = true;
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
      unsubEngine();
      unsubSettings?.();
      unsubMonitor();
      voice?.dispose();
      ai?.dispose();
      ai = null;
      pilots.clear();
      pilots.dispose();
      tts.cancel();
      radio?.dispose();
      p.pilotSink.handler = null;
    },
  };
  return session;
}
