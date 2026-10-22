/**
 * Zustand store that owns ONE engine instance (inside a `Session`) and exposes it to React.
 *
 * - The engine's `SimulationState` is the single source of truth. It is mutated in place by the engine, so React
 *   components re-render off `rev` (bumped ~10 Hz and after every command) and read `getState()`; nothing copies
 *   aircraft data into component state. The canvases ignore React entirely and read the live state every frame.
 * - `startSession` builds the scenario through `game`, resolves weather (live METAR with a visible fallback),
 *   creates the engine with the game's traffic generator, generates the ATIS and starts the rAF loop.
 */
import { create } from 'zustand';
import { game, createScenarioEventRunner } from '../../game';
import type { CareerProgress, DebriefReport, FreePlayOptions, TrainingStepState } from '../../game';
import { airportOrDefault } from '../../airport';
import { createEngine } from '../../sim/engine';
import { closedEndsOf, closedRunwayEnds } from '../../sim/airportOps';
import type { GameMode, Scenario, SimEvent, SimulationState, Weather } from '../../sim/types';
import { fetchLiveMetar } from '../../weather/liveWeather';
import type { LiveMetar } from '../../weather/liveWeather';
import { createLiveFeed, METAR_RETRY_MS } from '../../weather/liveFeed';
import type { LiveFeed, LiveFeedStatus } from '../../weather/liveFeed';
import { initialAtisLetter } from '../../weather/atisCycle';
import { realTimeDensity } from '../../game/trafficDensity';
import { getPresetWeather } from '../../weather/presets';
import type { WeatherPresetId } from '../../weather/presets';
import { recommendedRunways, runwayChangeForWind } from './runwayConfig';
import type { SimulatedAtis } from '../../weather/atis';
import { unlockAudio } from '../../voice';
import type { VoiceStatus } from '../../voice';
import type { TransmitResult, ControllerSetup } from '../commands/transmit';
import { POSITION_CHOICES, choiceFromPositions } from '../lib/positions';
import type { PositionChoice } from '../lib/positions';
import { createPilotSink, startSession as startEngineSession } from './session';
import type { Session } from './session';

export type Screen = 'setup' | 'sim' | 'debrief';

export type WeatherChoice = { kind: 'live' } | { kind: 'preset'; id: WeatherPresetId } | { kind: 'scenario' };

export type { PositionChoice } from '../lib/positions';
export { POSITION_CHOICES, suggestPosition } from '../lib/positions';

export function choiceFromSetup(setup: ControllerSetup): PositionChoice {
  return choiceFromPositions(setup.positions);
}

export interface StartOptions {
  /** Airport to work (ICAO); default KACY. */
  icao?: string;
  mode: GameMode;
  /** Undefined = custom free play with generated traffic. */
  scenarioId?: string;
  freePlay: FreePlayOptions;
  weather: WeatherChoice;
  seed?: number;
  /** What the player works ("I work"). Every other position of the scenario is run by AI controllers unless `ai` is false. */
  controller: PositionChoice;
  /** AI controllers work the positions the player does not (default true). False leaves them unstaffed (aircraft there are "not on frequency"). */
  ai?: boolean;
  /** 'auto' = recommended from the wind; otherwise explicit ends. */
  runways: 'auto' | { landing: string | string[]; departing: string | string[] };
  /**
   * Real-time mode (default true): sim time follows the wall clock, the UTC epoch is the real time at start, free-play traffic follows the
   * time-of-day curve and the ATIS letter follows the hourly cycle. False = the old "sim clock at the speed buttons' multiple" behaviour.
   */
  realTime?: boolean;
}

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export { recommendedRunways, runwayChangeForWind } from './runwayConfig';

interface SimStore {
  screen: Screen;
  starting: boolean;
  startStatus: string;
  rev: number;
  session: Session | null;
  startOptions?: StartOptions;
  notices: Notice[];
  atis?: SimulatedAtis;
  weatherNote: string;
  /** Live METAR feed state for the running session (undefined when the session uses simulated weather). */
  liveWeather?: LiveFeedStatus;
  /** The running session follows the wall clock (it may still be in 2x/4x: see `session.clockStatus()`). */
  realTime: boolean;
  controller: ControllerSetup;
  voice: { status: VoiceStatus; message?: string; partial: string; transmitting: boolean };
  /** Pilot audio: the browser is speaking right now (and who). */
  audio: { speaking: boolean; who?: string };
  training: TrainingStepState | null;
  lastTransmit?: TransmitResult;
  typedHistory: string[];
  scenarioComplete: boolean;
  debrief?: DebriefReport;
  debriefEvents: SimEvent[];
  debriefDurationSec: number;
  career?: CareerProgress;

  startSession(opts: StartOptions): Promise<boolean>;
  endSession(): void;
  playAgain(): Promise<void>;
  backToSetup(): void;
  dismissNotice(id: number): void;
  addNotice(level: Notice['level'], text: string): void;
  selectAircraft(id?: string): void;
  setSpeed(speed: number): void;
  togglePause(): void;
  setControllerChoice(choice: PositionChoice): void;
  submitTyped(text: string): TransmitResult | undefined;
  setWeather(w: Weather): void;
  setActiveRunways(cfg: { departing: string[]; landing: string[] }): void;
  /** Re-render views after a change that lives outside the engine state (strip order, notes, strike). */
  touch(): void;
  /** Strip board: toggle "handled" on a strip (default: the selected aircraft's). Returns the new struck state. */
  strikeStrip(aircraftId?: string): boolean | undefined;
  /** Strip board: drop a strip that is struck or whose aircraft has left. Returns false (with the reason in `stripHint`) otherwise. */
  dropStrip(aircraftId?: string): boolean;
  /** One-line feedback from the last strip action (cleared by the strip board after a few seconds). */
  stripHint: string | null;
  setStripHint(text: string | null): void;
}

let noticeSeq = 0;
let previousSpeed = 1;
let liveFeed: LiveFeed | null = null;
function stopLiveFeed() {
  liveFeed?.stop();
  liveFeed = null;
}

export const useSimStore = create<SimStore>((set, get) => ({
  screen: 'setup',
  starting: false,
  startStatus: '',
  rev: 0,
  session: null,
  notices: [],
  weatherNote: '',
  realTime: false,
  controller: { positions: ['TWR'], aiPositions: [] },
  voice: { status: 'idle', partial: '', transmitting: false },
  audio: { speaking: false },
  training: null,
  typedHistory: [],
  scenarioComplete: false,
  debriefEvents: [],
  debriefDurationSec: 0,

  addNotice(level, text) {
    set((s) => ({ notices: [...s.notices.filter((n) => n.text !== text), { id: ++noticeSeq, level, text }].slice(-4) }));
  },
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),

  async startSession(opts) {
    if (get().starting) return false;
    // Browsers only play audio after a user gesture: this runs synchronously inside the "Start session" click, before any await.
    unlockAudio();
    set({ starting: true, startStatus: 'Preparing airport data…', notices: [], scenarioComplete: false });
    const airport = airportOrDefault(opts.icao);
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    const notices: Notice[] = [];
    const note = (level: Notice['level'], text: string) => notices.push({ id: ++noticeSeq, level, text });

    try {
      // ---- weather ---------------------------------------------------------------------------------------------
      let weather: Weather | undefined;
      let weatherNote = '';
      let initialMetar: LiveMetar | undefined;
      let liveFailed = false;
      let wantLive = opts.weather.kind === 'live';
      if (opts.weather.kind === 'scenario' && opts.scenarioId) {
        // The scenario decides: a fixed Weather object, or 'live' (placeholder / free-play style scenarios).
        const pre = game.buildScenario(opts.scenarioId, airport, { seed });
        if (pre.weather === 'live') wantLive = true;
        else {
          weather = pre.weather;
          weatherNote = `Scenario weather (${weather.source})`;
        }
      }
      if (wantLive) {
        set({ startStatus: `Fetching live METAR for ${airport.icao}…` });
        try {
          const live = await fetchLiveMetar(airport.icao);
          weather = live.weather;
          initialMetar = live;
          weatherNote = `Live METAR ${live.raw}`;
        } catch (err) {
          liveFailed = true;
          weather = getPresetWeather('clear');
          weatherNote = 'Simulated weather: Clear (live weather unavailable)';
          note('warn', `Live weather unavailable (${err instanceof Error ? err.message : String(err)}). Using the simulated "Clear" preset instead.`);
        }
      } else if (opts.weather.kind === 'preset') {
        weather = getPresetWeather(opts.weather.id);
        weatherNote = `Simulated weather: ${opts.weather.id}`;
      }

      // ---- scenario ----------------------------------------------------------------------------------------------
      set({ startStatus: 'Building scenario…' });
      const refWeather = weather ?? getPresetWeather('clear');
      const closedEnds = closedEndsOf(airport, opts.freePlay.closures ?? []);
      let runways: { departing: string[]; landing: string[] } | undefined;
      const asList = (v: string | string[]): string[] => (Array.isArray(v) ? [...v] : [v]); // a published configuration names several ends per direction
      if (opts.runways !== 'auto' && ![...asList(opts.runways.departing), ...asList(opts.runways.landing)].some((e) => closedEnds.includes(e))) runways = { departing: asList(opts.runways.departing), landing: asList(opts.runways.landing) };
      else if (opts.runways !== 'auto') {
        note('warn', 'The runway you chose is closed for this session (NOTAM); the best open runway was selected instead.');
        const rec = recommendedRunways(refWeather, airport, closedEnds);
        runways = { departing: rec.departing, landing: rec.landing };
      } else if (!opts.scenarioId || closedEnds.length) {
        const rec = recommendedRunways(refWeather, airport, closedEnds);
        runways = { departing: rec.departing, landing: rec.landing };
      }
      const positions = POSITION_CHOICES[opts.controller];
      const startUtcMs = Date.now();
      const fp: FreePlayOptions = { ...opts.freePlay, seed, startUtcMs, weather: weather ?? opts.freePlay.weather, playerPositions: [...positions], ...(runways ? { activeRunways: runways } : {}) };
      const scenario: Scenario = opts.scenarioId
        ? game.buildScenario(opts.scenarioId, airport, fp)
        : game.buildFreePlay(airport, fp);
      if (opts.scenarioId && (opts.runways !== 'auto' || closedEnds.length) && runways) scenario.activeRunways = runways;
      if (opts.scenarioId && opts.freePlay.closures?.length) scenario.closures = opts.freePlay.closures.map((c) => ({ ...c }));
      if (!weather) {
        weather = scenario.weather === 'live' ? getPresetWeather('clear') : scenario.weather;
        weatherNote = `Scenario weather (${weather.source})`;
      }

      // ---- engine ------------------------------------------------------------------------------------------------
      const realTime = opts.realTime !== false;
      const { sink, onPilotTransmission } = createPilotSink();
      const engine = createEngine({
        airport,
        scenario,
        onPilotTransmission,
        trafficGenerator: game.createTrafficGenerator(scenario, airport, realTime && !opts.scenarioId ? { densityAt: realTimeDensity } : {}),
      });
      engine.setWeather(weather);
      engine.setControllerPosition(positions[0]);
      const training = game.createTrainingController(scenario);
      const runner = createScenarioEventRunner(engine, scenario, { onPilotTransmission: (t) => sink.handler?.(t) });

      const prev = get().session;
      prev?.dispose();
      stopLiveFeed();
      const session = startEngineSession({
        engine,
        scenario,
        controller: { positions: [...positions] },
        enableAi: opts.ai !== false,
        seed,
        startUtcMs,
        realTime,
        atisLetter: realTime ? initialAtisLetter(startUtcMs) : String.fromCharCode(65 + new Date(startUtcMs).getUTCHours()),
        training,
        runner,
        pilotSink: sink,
        hooks: {
          onRev: () => set((s) => ({ rev: s.rev + 1 })),
          onVoiceStatus: (e) => set((s) => ({ voice: { ...s.voice, status: e.status, message: e.message } })),
          onPartial: (t) => set((s) => ({ voice: { ...s.voice, partial: t } })),
          onTransmitting: (on) => set((s) => ({ voice: { ...s.voice, transmitting: on, partial: on ? '' : s.voice.partial } })),
          onTransmitResult: (r) => set((s) => ({
            lastTransmit: r,
            typedHistory: r.source === 'typed' && r.text ? [...s.typedHistory.filter((h) => h !== r.text), r.text].slice(-50) : s.typedHistory,
          })),
          onTraining: (step) => set({ training: step }),
          onAtis: (atis) => set({ atis }),
          onScenarioComplete: () => set({ scenarioComplete: true }),
          onNotice: (level, text) => get().addNotice(level, text),
          onSpeaking: (speaking, who) => set({ audio: { speaking, who: speaking ? who : undefined } }),
        },
      });

      previousSpeed = 1;
      if (wantLive) {
        const autoRunways = opts.runways === 'auto' && !opts.scenarioId;
        liveFeed = createLiveFeed({
          fetchMetar: () => fetchLiveMetar(airport.icao),
          initial: initialMetar,
          onStatus: (liveWeather) => {
            set({ liveWeather });
            if (liveWeather.kind === 'stale') get().addNotice('warn', `Live weather refresh failed (${liveWeather.error}). Still using the ${airport.icao} METAR observed ${liveWeather.observedAt.slice(11, 16)}Z; retrying every minute.`);
            else if (liveWeather.kind === 'fallback') set({ weatherNote: 'Simulated weather: Clear (live weather unavailable)' });
          },
          onWeather: (w, m) => {
            if (get().session !== session) return;
            session.setWeather(w);
            set({ weatherNote: `Live METAR ${m.raw}` });
            get().addNotice('info', `New ${airport.icao} METAR (${m.observedAt.slice(11, 16)}Z): ${m.raw}`);
            const change = autoRunways ? runwayChangeForWind(w, session.engine.getState().activeRunways, airport, closedRunwayEnds(session.engine.getState())) : undefined;
            if (change) {
              session.setActiveRunways({ departing: change.departing, landing: change.landing });
              get().addNotice('warn', `The wind favours runway ${change.landing[0]} now (${change.summary}); active runways changed. Aircraft already in the pattern may need to be re-sequenced.`);
            }
          },
        });
        liveFeed.start(liveFailed ? METAR_RETRY_MS : undefined);
      }
      set({
        session,
        realTime,
        liveWeather: wantLive ? (initialMetar ? { kind: 'live', observedAt: initialMetar.observedAt, raw: initialMetar.raw, checkedAtMs: Date.now(), source: initialMetar.source } : { kind: 'fallback', error: 'live weather unavailable', failedAtMs: Date.now() }) : undefined,
        screen: 'sim',
        starting: false,
        startStatus: '',
        startOptions: opts,
        notices,
        weatherNote,
        controller: session.getController(),
        lastTransmit: undefined,
        voice: { status: 'idle', partial: '', transmitting: false },
        audio: { speaking: false },
        rev: get().rev + 1,
      });
      return true;
    } catch (err) {
      console.error('[ui] startSession failed', err);
      set({ starting: false, startStatus: '' });
      get().addNotice('error', `Could not start the session: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  },

  endSession() {
    const s = get().session;
    if (!s) return;
    const st = s.engine.getState();
    const report = game.buildDebrief(st, 0);
    let career: CareerProgress | undefined;
    if (st.scenario.mode === 'career') career = game.saveCareerResult(st.scenario.id, report);
    const events = st.events.slice();
    const duration = st.clock.timeSec;
    s.dispose();
    stopLiveFeed();
    set({
      session: null,
      screen: 'debrief',
      debrief: report,
      debriefEvents: events,
      debriefDurationSec: duration,
      career,
      training: null,
      scenarioComplete: false,
    });
  },

  async playAgain() {
    const o = get().startOptions;
    if (!o) {
      get().backToSetup();
      return;
    }
    set({ screen: 'setup' });
    // A fixed seed replays identically; a random one gets a fresh seed.
    await get().startSession({ ...o, seed: o.seed });
  },

  backToSetup() {
    get().session?.dispose();
    stopLiveFeed();
    set({ session: null, screen: 'setup', debrief: undefined, training: null, scenarioComplete: false, notices: [] });
  },

  selectAircraft(id) {
    get().session?.engine.selectAircraft(id);
    set((s) => ({ rev: s.rev + 1 }));
  },

  setSpeed(speed) {
    const s = get().session;
    if (!s) return;
    if (speed > 0) previousSpeed = speed;
    s.setSpeed(speed);
  },
  togglePause() {
    const s = get().session;
    if (!s) return;
    const cur = s.getSpeed();
    s.setSpeed(cur > 0 ? 0 : previousSpeed || 1);
    if (cur > 0) previousSpeed = cur;
  },

  setControllerChoice(choice) {
    const s = get().session;
    if (!s) return;
    s.setController({ positions: [...POSITION_CHOICES[choice]] });
    set({ controller: s.getController() });
  },

  submitTyped(text) {
    const s = get().session;
    if (!s || !text.trim()) return undefined;
    return s.submit(text, 'typed');
  },

  stripHint: null,
  setStripHint: (stripHint) => set({ stripHint }),
  touch: () => set((s) => ({ rev: s.rev + 1 })),
  strikeStrip(id) {
    const sess = get().session;
    const target = id ?? sess?.engine.getState().selectedAircraftId;
    if (!sess || !target) {
      set({ stripHint: 'Select a strip first (click it), then press S to strike it.' });
      return undefined;
    }
    const r = sess.strips.strike(target);
    set((s) => ({ rev: s.rev + 1, stripHint: r === undefined ? 'No strip for that aircraft.' : r ? 'Strip struck: handled, moved to the bottom of its bay.' : 'Strip restored.' }));
    return r;
  },
  dropStrip(id) {
    const sess = get().session;
    const target = id ?? sess?.engine.getState().selectedAircraftId;
    if (!sess || !target) {
      set({ stripHint: 'Select a strip first (click it), then press X to drop it.' });
      return false;
    }
    const ok = sess.strips.drop(target);
    set((s) => ({
      rev: s.rev + 1,
      stripHint: ok ? 'Strip dropped.' : sess.strips.get(target) ? 'Strike the strip (S) or wait until the aircraft has left before dropping it (X).' : 'No strip for that aircraft.',
    }));
    return ok;
  },

  setWeather: (w) => get().session?.setWeather(w),
  setActiveRunways: (cfg) => get().session?.setActiveRunways(cfg),
}));

/** Live engine state (mutated in place by the engine). Components call this inside render after reading `rev`. */
export function useSimState(): SimulationState | null {
  useSimStore((s) => s.rev);
  return useSimStore.getState().session?.engine.getState() ?? null;
}

export function getSimState(): SimulationState | null {
  return useSimStore.getState().session?.engine.getState() ?? null;
}
