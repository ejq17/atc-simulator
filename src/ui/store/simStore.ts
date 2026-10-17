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
import { loadKacy } from '../../airport';
import { createEngine } from '../../sim/engine';
import type { Airport, ControllerPositionId, GameMode, Scenario, SimEvent, SimulationState, Weather } from '../../sim/types';
import { fetchLiveMetar } from '../../weather/liveWeather';
import { getPresetWeather } from '../../weather/presets';
import type { WeatherPresetId } from '../../weather/presets';
import { recommendRunways } from '../../weather/runwaySelection';
import type { SimulatedAtis } from '../../weather/atis';
import type { VoiceStatus } from '../../voice';
import type { TransmitResult, ControllerSetup } from '../commands/transmit';
import { createPilotSink, startSession as startEngineSession } from './session';
import type { Session } from './session';

export type Screen = 'setup' | 'sim' | 'debrief';

export type WeatherChoice = { kind: 'live' } | { kind: 'preset'; id: WeatherPresetId } | { kind: 'scenario' };

export type PositionChoice = 'TWR' | 'GND' | 'APP' | 'CLNC' | 'TWR+GND';

export interface StartOptions {
  mode: GameMode;
  /** Undefined = custom free play with generated traffic. */
  scenarioId?: string;
  freePlay: FreePlayOptions;
  weather: WeatherChoice;
  seed?: number;
  controller: PositionChoice;
  /** 'auto' = recommended from the wind; otherwise explicit ends. */
  runways: 'auto' | { landing: string; departing: string };
}

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export const POSITION_CHOICES: Record<PositionChoice, ControllerPositionId[]> = {
  TWR: ['TWR'], GND: ['GND'], APP: ['APP'], CLNC: ['CLNC'], 'TWR+GND': ['TWR', 'GND'],
};

export function choiceFromSetup(setup: ControllerSetup): PositionChoice {
  const key = setup.positions.join('+');
  return (Object.keys(POSITION_CHOICES) as PositionChoice[]).find((k) => POSITION_CHOICES[k].join('+') === key) ?? 'TWR';
}

/** Controller-position choice that covers the positions a scenario lists (Tower is the default). */
export function suggestPosition(positions: readonly ControllerPositionId[]): PositionChoice {
  const has = (p: ControllerPositionId) => positions.includes(p);
  if (has('TWR') && has('GND')) return 'TWR+GND';
  if (has('GND') && !has('TWR')) return 'GND';
  if (has('APP') || has('DEP')) return has('TWR') ? 'TWR' : 'APP';
  if (has('CLNC') && positions.length === 1) return 'CLNC';
  return 'TWR';
}

/** Runway configuration recommended for a weather snapshot (best headwind end, used for both arrivals and departures). */
export function recommendedRunways(weather: Weather, airport: Pick<Airport, 'runways' | 'magneticVariationDeg'> = loadKacy()): { departing: string[]; landing: string[]; summary: string } {
  const ends = airport.runways.flatMap((r) => r.ends.map((e) => ({ id: e.id, magneticHeadingDeg: e.magneticHeadingDeg })));
  const rec = recommendRunways(weather, ends, { preferredOrder: ['31', '13', '22', '4'], variationDeg: airport.magneticVariationDeg });
  const top = rec.ranking.find((r) => r.id === rec.primary);
  const summary = rec.calmWindRule
    ? `Wind calm or light: preferred runway ${rec.primary}`
    : `Runway ${rec.primary}: headwind ${Math.round(top?.headwindKt ?? 0)} kt, crosswind ${Math.round(Math.abs(top?.crosswindKt ?? 0))} kt`;
  return { departing: [rec.primary], landing: [rec.primary], summary };
}

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
  controller: ControllerSetup;
  voice: { status: VoiceStatus; message?: string; partial: string; transmitting: boolean };
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
}

let noticeSeq = 0;
let previousSpeed = 1;

export const useSimStore = create<SimStore>((set, get) => ({
  screen: 'setup',
  starting: false,
  startStatus: '',
  rev: 0,
  session: null,
  notices: [],
  weatherNote: '',
  controller: { positions: ['TWR'] },
  voice: { status: 'idle', partial: '', transmitting: false },
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
    set({ starting: true, startStatus: 'Preparing airport data…', notices: [], scenarioComplete: false });
    const airport = loadKacy();
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    const notices: Notice[] = [];
    const note = (level: Notice['level'], text: string) => notices.push({ id: ++noticeSeq, level, text });

    try {
      // ---- weather ---------------------------------------------------------------------------------------------
      let weather: Weather | undefined;
      let weatherNote = '';
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
        set({ startStatus: 'Fetching live METAR for KACY…' });
        try {
          const live = await fetchLiveMetar('KACY');
          weather = live.weather;
          weatherNote = `Live METAR ${live.raw}`;
        } catch (err) {
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
      let runways: { departing: string[]; landing: string[] } | undefined;
      if (opts.runways !== 'auto') runways = { departing: [opts.runways.departing], landing: [opts.runways.landing] };
      else if (!opts.scenarioId) {
        const rec = recommendedRunways(refWeather, airport);
        runways = { departing: rec.departing, landing: rec.landing };
      }
      const fp: FreePlayOptions = { ...opts.freePlay, seed, weather: weather ?? opts.freePlay.weather, ...(runways ? { activeRunways: runways } : {}) };
      const scenario: Scenario = opts.scenarioId
        ? game.buildScenario(opts.scenarioId, airport, fp)
        : game.buildFreePlay(airport, fp);
      if (opts.scenarioId && opts.runways !== 'auto' && runways) scenario.activeRunways = runways;
      if (!weather) {
        weather = scenario.weather === 'live' ? getPresetWeather('clear') : scenario.weather;
        weatherNote = `Scenario weather (${weather.source})`;
      }

      // ---- engine ------------------------------------------------------------------------------------------------
      const { sink, onPilotTransmission } = createPilotSink();
      const engine = createEngine({
        airport,
        scenario,
        onPilotTransmission,
        trafficGenerator: game.createTrafficGenerator(scenario, airport),
      });
      engine.setWeather(weather);
      const positions = POSITION_CHOICES[opts.controller];
      engine.setControllerPosition(positions[0]);
      const training = game.createTrainingController(scenario);
      const runner = createScenarioEventRunner(engine, scenario, { onPilotTransmission: (t) => sink.handler?.(t) });

      const prev = get().session;
      prev?.dispose();
      const startUtcMs = Date.now();
      const session = startEngineSession({
        engine,
        scenario,
        controller: { positions },
        startUtcMs,
        atisLetter: String.fromCharCode(65 + new Date(startUtcMs).getUTCHours()),
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
        },
      });

      previousSpeed = 1;
      set({
        session,
        screen: 'sim',
        starting: false,
        startStatus: '',
        startOptions: opts,
        notices,
        weatherNote,
        controller: { positions },
        lastTransmit: undefined,
        voice: { status: 'idle', partial: '', transmitting: false },
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
    const setup = { positions: POSITION_CHOICES[choice] };
    s.setController(setup);
    set({ controller: setup });
  },

  submitTyped(text) {
    const s = get().session;
    if (!s || !text.trim()) return undefined;
    return s.submit(text, 'typed');
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
