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
import { atisNeedsUpdate, atisUpdateReasons, generateAtis, nextAtisLetter } from '../../weather/atis';
import { closedRunwayEnds } from '../../sim/airportOps';
import { runwayChangeForWind } from './runwayConfig';
import { buildAtisOps } from '../../weather/atisOps';
import { atisSlot, hourlyAtisAdvance, hourlySlotApplies } from '../../weather/atisCycle';
import { M_PER_NM } from '../../sim/geo';
import { createRealtimeClock } from './realtimeClock';
import type { ClockStatus } from './realtimeClock';
import type { SimulatedAtis } from '../../weather/atis';
import {
  MONITOR_ALL_VOLUME, createBrowserTts, createEngineTts, createPilotVoice, createSessionNeuralTts, getSharedNeuralSynth, createRadioEffects, createTranscriptLog, createVoiceController,
} from '../../voice';
import { createAiControllers } from '../../ai';
import type { AiControllers, AiTransmission } from '../../ai';
import type { SpeechSynthesisProvider, TranscriptLog, TransmissionQueue, VoiceController, VoiceStatusEvent } from '../../voice';
import { createRenderBuffer } from '../display/renderBuffer';
import type { RenderBuffer } from '../display/renderBuffer';
import { controllerFrequencies, nextTransmissionId, parseForTransmit, transmit } from '../commands/transmit';
import { isStaticHosting } from '../../hosting';
import { createLlmParser, LlmParseError } from '../../commands/llm/client';
import type { LlmParser } from '../../commands/llm/client';
import { adoptLlmCommands, mergeResults, needsInterpreter } from '../../commands/llm/fallback';
import { looksLikeLandline, transmitLandline } from '../commands/landline';
import type { LandlineResult } from '../commands/landline';
import type { CoordAnswer } from '../../sim/coordination';
import type { SimulationEngineExtras } from '../../sim/engineExtras';
import type { ControllerSetup, TransmitResult } from '../commands/transmit';
import { voiceSettings } from './voiceSettings';
import { aiPositionsFor } from '../lib/positions';
import { airportCallName, frequencyForPosition } from '../../radio/frequencies';
import { createStripBoard } from '../strips/stripModel';
import type { StripBoard } from '../strips/stripModel';



export interface SessionHooks {
  /** State changed in a way the React tree should re-read (throttled ~10 Hz, and immediately after commands). */
  onRev(): void;
  onVoiceStatus(e: VoiceStatusEvent): void;
  onPartial(text: string): void;
  onTransmitting(on: boolean): void;
  onTransmitResult(r: TransmitResult): void;
  /** The result of a landline call (typed, or by voice with the landline key / mode). */
  onLandlineResult?(r: LandlineResult): void;
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
  /** Real UTC ms of scenario time 0. In real-time mode the clock owns the epoch from here on (see `realtimeClock.ts`). */
  startUtcMs: number;
  atisLetter: string;
  /**
   * Real-time mode: sim time follows the wall clock (LIVE) until the user picks 2x/4x, and the ATIS letter advances on the real hourly cycle.
   * Default false (the engine runs at the speed buttons' multiple of the frame delta, as the tests expect).
   */
  realTime?: boolean;
  /** Test seams for the clock: monotonic ms (default performance.now) and real UTC ms (default Date.now). */
  now?: () => number;
  wallUtcMs?: () => number;
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
  /**
   * Phrase interpreter fallback (src/commands/llm): asked only when the rule grammar is unsure about a radio call and the
   * "Phrase interpreter" setting is on. Default: the HTTP client for the local backend in a browser (null when statically hosted
   * or outside a browser, so tests never touch the network). Pass `null` to disable, or a fake in tests.
   */
  interpreter?: LlmParser | null;
  /** Provide the pilot-transmission sink; the engine must have been created with `pilotSink`. */
  pilotSink: PilotSink;
}

/** Created before the engine so `onPilotTransmission` can reach the session once it exists. */
export interface PilotSink {
  handler: ((t: { aircraftId: string; callsign: string; text: string; frequencyMhz: number; voiceId: string; blocked?: boolean }) => void) | null;
}

export function createPilotSink(): { sink: PilotSink; onPilotTransmission: NonNullable<Parameters<typeof createEngine>[0]['onPilotTransmission']> } {
  const sink: PilotSink = { handler: null };
  return { sink, onPilotTransmission: (t) => sink.handler?.(t) };
}

export interface Session {
  readonly engine: SimulationEngine;
  readonly buffer: RenderBuffer;
  readonly scenario: Scenario;
  /** UTC ms of scenario time 0 (first epoch segment). Prefer `utcAt` for display. */
  readonly startUtcMs: number;
  /** UTC ms of a sim time (handles the epoch moving when real-time mode re-locks after a pause or 2x/4x). */
  utcAt(simSec: number): number;
  /** LIVE / SIM / paused, for the top bar. */
  clockStatus(): ClockStatus;
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
  /**
   * Radio transmission. Returns the real result synchronously, except when the phrase interpreter is consulted: then it returns a
   * provisional `{ summary: 'empty', message: 'Interpreting…' }` and the real result follows through `hooks.onTransmitResult`.
   */
  submit(text: string, source: 'voice' | 'typed'): TransmitResult;
  /** A landline call to another position ("Tower, Ground, cross runway ..."): parsed as coordination phraseology. */
  submitLandline(text: string, source: 'voice' | 'typed'): LandlineResult;
  /** Landline mode: spoken / typed transmissions are landline calls (calls that start with two position names always are). */
  getLandlineMode(): boolean;
  setLandlineMode(on: boolean): void;
  /** The panel buttons: answer a request waiting for one of the player's positions. `afterAircraftId`: "behind the landing ...". */
  answerRequest(requestId: string, answer: CoordAnswer, o?: { afterAircraftId?: string; reason?: string }): void;
  /** The panel button: take an approval back. */
  rescindRequest(requestId: string, reason?: string): void;
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

export function makeAtis(state: SimulationState, letter: string, startUtcMs: number | ((simSec: number) => number)): SimulatedAtis {
  const utcMs = typeof startUtcMs === 'function' ? startUtcMs(state.clock.timeSec) : startUtcMs + state.clock.timeSec * 1000;
  return generateAtis({
    ops: buildAtisOps(state, utcMs),
    approachesInUse: approachesInUseFor(state),
    airportName: airportCallName(state.airport),
    icao: state.airport.icao,
    weather: state.weather,
    variationDeg: state.airport.magneticVariationDeg,
    activeRunways: state.activeRunways,
    letter,
    timeUtc: new Date(utcMs),
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
  const realTime = p.realTime ?? false;
  const clock = createRealtimeClock({
    engine, realTime, now: p.now, wallUtcMs: p.wallUtcMs, startUtcMs: p.startUtcMs,
    onResync: (gap) => hooks.onNotice('warn', `The simulation fell ${Math.round(gap)} s behind the real clock (tab in the background?) and was re-synchronised; that time was skipped.`),
  });
  const utcAt = (sec: number) => clock.utcAt(sec);
  let atis = makeAtis(engine.getState(), p.atisLetter, utcAt);
  engine.setAtis(atis);
  hooks.onAtis(atis);

  // ----- voice -------------------------------------------------------------------------------------------------
  const enableVoice = p.enableVoice ?? typeof window !== 'undefined';
  const radio = enableVoice ? createRadioEffects({ enabled: voiceSettings.get().radioEffectsEnabled }) : undefined;
  // Pilot voice engine (Settings): browser speech, or the on-device neural voice played through the radio chain. A provider
  // passed in by a test is used as is. The neural voice falls back to the browser voice by itself.
  let tts: SpeechSynthesisProvider & { isSupported?(): boolean };
  let unsubTtsEngine: (() => void) | null = null;
  if (p.tts) {
    tts = p.tts;
  } else {
    const browser = createBrowserTts();
    if (enableVoice) {
      const neural = createSessionNeuralTts(browser, radio);
      const warm = () => {
        if (voiceSettings.get().ttsEngine === 'neural') void getSharedNeuralSynth().ensureLoaded().catch(() => undefined);
      };
      warm();
      unsubTtsEngine = voiceSettings.subscribe(warm);
      tts = { ...createEngineTts({ browser, neural, getEngine: () => voiceSettings.get().ttsEngine }), isSupported: () => browser.isSupported() };
    } else {
      tts = browser;
    }
  }
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

  /** How far the transmitting aircraft is from the airport reference point (local metres are relative to it), nautical miles. */
  const aircraftDistanceNm = (aircraftId: string): number | undefined => {
    const ac = engine.getState().aircraft[aircraftId];
    return ac ? Math.hypot(ac.pos.x, ac.pos.y) / M_PER_NM : undefined;
  };

  p.pilotSink.handler = (t) => {
    // Informational instructions (RADAR_CONTACT) have an empty readback: nothing is said, so nothing is queued or spoken.
    if (!t.text || !t.text.trim()) return;
    const mine = isPlayerFrequency(t.frequencyMhz);
    // Inaudible unless it is on a frequency the player works (or they chose to monitor everything); the engine already logged the text.
    if (!mine && !voiceSettings.get().monitorAll) return;
    if (t.blocked) {
      // Decided by the engine (RADIO_BLOCKED): two pilots keyed up together. Text log "[blocked]", the voice layer plays a squeal.
      transcript.add({ text: '[blocked]', source: 'pilot' });
      pilots.enqueue({ text: '[blocked]', voiceId: t.voiceId, frequencyMhz: t.frequencyMhz, volume: volumeFor(t.frequencyMhz), speaker: '[blocked]', callsign: t.callsign, kind: 'blocked' });
      return;
    }
    transcript.add({ text: `${t.callsign}: ${t.text}`, source: 'pilot' });
    pilots.enqueue({
      text: t.text, voiceId: t.voiceId, frequencyMhz: t.frequencyMhz, volume: volumeFor(t.frequencyMhz), speaker: t.callsign,
      callsign: t.callsign, distanceNm: aircraftDistanceNm(t.aircraftId),
    });
  };

  // ----- AI controllers ------------------------------------------------------------------------------------------
  const aiEnabled = p.enableAi ?? true;
  const makeAi = p.createAi ?? createAiControllers;
  let ai: AiControllers | null = null;
  let lastAiTick = -1;
  let inAi = false;
  const onAiTransmission = (t: AiTransmission) => {
    if (t.channel === 'landline') {
      // A call between positions: audible when it is for a position the player works (or "Monitor all"), through the landline ring.
      const forMe = !!t.toPosition && controller.positions.includes(t.toPosition);
      if (!forMe && !voiceSettings.get().monitorAll) return;
      transcript.add({ text: `${t.position} (AI) > ${t.toPosition}: ${t.text}`, source: 'ai' });
      const own = playerFrequencies();
      pilots.enqueue({
        text: t.spokenText || t.text, voiceId: t.voiceId, frequencyMhz: own[0] ?? engine.getState().controllerFrequencyMhz, volume: forMe ? 1 : MONITOR_ALL_VOLUME,
        speaker: `${t.position} (AI)`, channel: 'landline', priority: 1,
      });
      return;
    }
    const mine = isPlayerFrequency(t.frequencyMhz);
    if (!mine && !voiceSettings.get().monitorAll) return;
    transcript.add({ text: `${t.position} (AI): ${t.text}`, source: 'ai' });
    // A controller's station is a strong, clean transmitter: one stable voice per position, no distance fading.
    pilots.enqueue({
      text: t.spokenText || t.text, voiceId: t.voiceId, frequencyMhz: t.frequencyMhz, volume: volumeFor(t.frequencyMhz), speaker: `${t.position} (AI)`,
      callsign: t.position, speakerKind: 'controller',
    });
  };
  const buildAi = () => {
    ai?.dispose();
    ai = null;
    const positions = aiEnabled ? aiPositionsFor(p.scenario.controllerPositions, controller.positions) : [];
    controller = { positions: controller.positions, aiPositions: positions };
    // Who works what decides which coordination rules apply; createAiControllers sets it itself when an AI exists.
    (engine as SimulationEngine & SimulationEngineExtras).coordination?.setStaffing([...controller.positions], positions);
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
  const strips = createStripBoard({ startUtcMs: utcAt });
  strips.update(engine.getState());

  let landlineMode = false;
  const interpreter: LlmParser | null = p.interpreter !== undefined ? p.interpreter : (typeof window !== 'undefined' && !isStaticHosting() ? createLlmParser() : null);
  /** Set when the backend answers LLM_NOT_CONFIGURED: no further attempts this session. */
  let interpreterOff = false;
  const submitLandline = (text: string, source: 'voice' | 'typed', confidence?: number): LandlineResult => {
    transcript.add({ text: `landline: ${text}`, source: source === 'voice' ? 'speech' : 'typed', confidence });
    const r = transmitLandline({ engine, text, source, controller });
    strips.update(engine.getState());
    hooks.onLandlineResult?.(r);
    hooks.onRev();
    return r;
  };
  const submit = (text: string, source: 'voice' | 'typed', confidence?: number, channel: 'radio' | 'landline' = 'radio'): TransmitResult => {
    if (channel === 'landline' || landlineMode || looksLikeLandline(text)) {
      const lr = submitLandline(text, source, confidence);
      // the radio panel's result line: a landline call is not an aircraft instruction
      return { transmissionId: `ll-${Date.now().toString(36)}`, text, source, commands: [], results: [], summary: lr.summary === 'done' ? 'accepted' : lr.summary === 'clarify' ? 'clarify' : lr.summary === 'empty' ? 'empty' : 'rejected', message: `Landline: ${lr.message}`, clarification: lr.summary === 'clarify' ? lr.message : undefined };
    }
    transcript.add({ text, source: source === 'voice' ? 'speech' : 'typed', confidence });
    const { parsed, ctx } = parseForTransmit(engine, text.trim(), controller);
    if (!(interpreter && !interpreterOff && text.trim() && voiceSettings.get().interpreterEnabled && needsInterpreter(parsed))) {
      return finishRadio(transmit({ engine, text, source, controller, parsed }));
    }

    // The interpreter is a network call (up to LLM_PARSE_TIMEOUT_MS), so `submit` cannot make the caller wait for it: the voice controller
    // ignores the return value and the typed box only shows `hooks.onTransmitResult`. Rather than turn every caller async, a call that needs
    // the interpreter returns a provisional 'empty' result at once and delivers the real one through the same hook later. Clear
    // instructions (the normal case) still return the real result synchronously. Exactly one `transmit` runs per submission, in the
    // `.then` below, so the command is executed once and the pilot answers once whatever the interpreter does.
    const transmissionId = nextTransmissionId();
    engine.logEvent({ kind: 'INFO', text: 'Checking that phrasing with the phrase interpreter…', severity: 'info', speaker: 'SYSTEM' });
    const t0 = performance.now();
    const grammarFallback = (reason: string) => {
      engine.logEvent({ kind: 'INFO', text: `Phrase interpreter unavailable (${reason}); using the standard parse.`, severity: 'info', speaker: 'SYSTEM' });
      return parsed;
    };
    void interpreter.parse({
      text: text.trim(),
      context: ctx,
      grammar: parsed.commands.length > 0 ? { commands: parsed.commands.map((c) => ({ kind: c.kind, callsign: c.callsign, confidence: c.confidence, issues: c.issues })) } : undefined,
    }).then((resp) => {
      const adopted = adoptLlmCommands(resp, text.trim(), ctx);
      if (!adopted) engine.logEvent({ kind: 'INFO', text: `Phrase interpreter found no usable instruction${resp.note ? ` (${resp.note})` : ''}; using the standard parse.`, severity: 'info', speaker: 'SYSTEM' });
      return { merged: mergeResults(parsed, adopted), ms: performance.now() - t0 };
    }, (err: unknown) => {
      let reason = err instanceof Error ? err.message : String(err);
      if (err instanceof LlmParseError) {
        if (err.code === 'LLM_NOT_CONFIGURED') { interpreterOff = true; reason = 'phrase interpreter not configured on the local backend'; }
        else if (err.code === 'TIMEOUT') reason = 'it took too long';
        else if (err.code === 'NETWORK') reason = 'local backend not reachable';
      }
      return { merged: grammarFallback(reason), ms: performance.now() - t0 };
    }).then(({ merged, ms }) => {
      if (disposed) return;
      finishRadio(transmit({ engine, text, source, controller, parsed: merged, transmissionId, interpreterNote: `phrase interpreter, ${(ms / 1000).toFixed(1)} s` }));
    }).catch((err: unknown) => hooks.onNotice('error', `Transmission failed after the phrase interpreter: ${err instanceof Error ? err.message : String(err)}`));
    const provisional: TransmitResult = { transmissionId, text: text.trim(), source, commands: [], results: [], summary: 'empty', message: 'Interpreting…' };
    hooks.onTransmitResult(provisional);
    return provisional;
  };
  const finishRadio = (r: TransmitResult): TransmitResult => {
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
      landline: { key: s.landlineKey },
      onTransmission: (text, meta) => submit(text, meta.source === 'typed' ? 'typed' : 'voice', meta.confidence, meta.channel),
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
      voice?.landlinePtt?.setKey(next.landlineKey);
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
  buffer.capture(engine.getState(), nowMs());
  let atisSlotSeen = atisSlot(utcAt(engine.getState().clock.timeSec));
  let lastAtisCheck = 0;

  const frame = (t: number) => {
    if (disposed) return;
    clock.frame(t);
    const st = engine.getState();
    if (st.clock.speed > 0 && t - lastAtisCheck >= 1000) {
      lastAtisCheck = t;
      // Real hourly ATIS cycle (HH:55Z, JO 7110.65 2-9-2: a new recording on each new official observation): a new letter once an hour for simulated
      // weather. Live weather has real observation times; its hourly METAR makes the letter (`atisUpdateReasons`: new weather observation), so the clock
      // does not add a second one.
      if (realTime) {
        const adv = hourlyAtisAdvance(atisSlotSeen, utcAt(st.clock.timeSec), atis.letter);
        if (adv) {
          atisSlotSeen = adv.slot;
          if (hourlySlotApplies(st.weather)) reissueAtis('hourly update', adv.letter);
        }
      }
      syncAirportOps();
    }
    if (p.runner) {
      for (const ev of p.runner.update()) {
        if (ev.kind === 'weather') {
          // The runner changed the weather: new ATIS if it matters. Runways are NOT changed for the player.
          if (atisNeedsUpdate(atis, st.weather, st.activeRunways, opsNow())) reissueAtis('weather change');
          const rec = ev.recommendedRunways?.landing[0];
          hooks.onNotice('warn', `${ev.text}${rec ? ` The new wind favours runway ${rec}; change the runway configuration (Runways button) when ready.` : ''}`);
        } else if (ev.kind === 'emergency') {
          hooks.onNotice('warn', `${ev.declaration}: ${ev.text}`);
        } else if (ev.kind === 'closure' || ev.kind === 'birds') {
          hooks.onNotice('warn', ev.text);
          syncAirportOps(); // new letter / runway change right away, not at the next 1 s check
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
  /** The airport state the ATIS reports (closures, RVR, runway condition, braking action, birds) at the current sim time. */
  const opsNow = () => buildAtisOps(engine.getState(), utcAt(engine.getState().clock.timeSec));
  /**
   * Closures, braking action reports and bird activity change the airport (see `src/sim/airportOps.ts`). When the runway in use is closed the best open
   * runway takes over (JO 7110.65 3-3-2: a closed runway is not assigned); the ATIS gets a new letter when its airport-state content changed
   * (2-9-2: new or canceled NOTAMs, braking action worse than in the broadcast).
   */
  const syncAirportOps = () => {
    const st = engine.getState();
    const closedEnds = closedRunwayEnds(st);
    if (closedEnds.length && [...st.activeRunways.landing, ...st.activeRunways.departing].some((e) => closedEnds.includes(e))) {
      try {
        const change = runwayChangeForWind(st.weather, st.activeRunways, st.airport, closedEnds);
        if (change) {
          engine.setActiveRunways({ departing: change.departing, landing: change.landing });
          hooks.onNotice('warn', `The runway in use is closed (NOTAM): active runways changed to ${change.landing[0]}. Aircraft already inbound to the closed runway cannot be cleared to land on it.`);
        }
      } catch (err) {
        hooks.onNotice('error', `No open runway is left to switch to (${err instanceof Error ? err.message : String(err)}).`);
      }
    }
    const reasons = atisUpdateReasons(atis, st.weather, st.activeRunways, opsNow());
    if (reasons.length) reissueAtis(reasons.join(', '));
  };

  const reissueAtis = (reason: string, letter?: string) => {
    const st = engine.getState();
    atis = makeAtis(st, letter ?? nextAtisLetter(atis.letter), utcAt);
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
    utcAt,
    clockStatus: () => clock.status(),
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
    submitLandline: (text, source) => submitLandline(text, source),
    getLandlineMode: () => landlineMode,
    setLandlineMode(on) {
      landlineMode = on;
      hooks.onRev();
    },
    answerRequest(requestId, answer, o) {
      const req = engine.getState().coordination?.requests.find((r) => r.id === requestId);
      const api = (engine as SimulationEngine & SimulationEngineExtras).coordination;
      if (req && api) api.respond(requestId, answer, { by: req.to, source: 'player', afterAircraftId: o?.afterAircraftId, reason: o?.reason });
      hooks.onRev();
    },
    rescindRequest(requestId, reason) {
      const req = engine.getState().coordination?.requests.find((r) => r.id === requestId);
      const api = (engine as SimulationEngine & SimulationEngineExtras).coordination;
      if (req && api) api.rescind(requestId, { by: req.to, source: 'player', reason });
      hooks.onRev();
    },
    setSpeed(speed) {
      clock.setSpeed(speed);
      hooks.onRev();
    },
    getSpeed: () => engine.getState().clock.speed,
    setWeather(w) {
      const st = engine.getState();
      const needs = atisNeedsUpdate(atis, w, st.activeRunways, opsNow());
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
      const needs = atisNeedsUpdate(atis, st.weather, cfg, opsNow());
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
      unsubTtsEngine?.();
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
