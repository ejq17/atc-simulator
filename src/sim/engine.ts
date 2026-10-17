/**
 * Deterministic fixed-step simulation engine. See src/sim/README.md.
 *
 * Per tick: scheduled spawns / traffic generator -> pending frequency changes -> pilot requests ->
 * ground movement -> flight dynamics -> runway occupancy -> conflicts -> lifecycle (despawn) -> scoring.
 */
import type { SimulationEngine, EngineOptions, Unsubscribe } from './api';
import type {
  Aircraft, Atis, CommandOutcome, ControllerPositionId, ParsedCommand, Scenario, SimEvent, SimulationState, Weather,
} from './types';
import { mulberry32 } from './rng';
import { emitEvent } from './context';
import type { SimContext } from './context';
import { executeCommand } from './commandExecutor';
import { updateGroundMovement } from './groundMovement';
import { updateFlightDynamics } from './flightDynamics';
import { updateRunwayOccupancy } from './runwayOccupancy';
import { detectConflicts } from './conflicts';
import { newScoreCard, updateScoring } from './scoring';
import {
  applyPendingFrequencyChanges, processScheduledSpawns, removeAircraft as removeFromCtx, spawnFromSpec, updateLifecycle, updatePilotRequests,
} from './traffic';
import type { TrafficGenerator } from './traffic';
import { createBasicTrafficGenerator } from './traffic';
import { frequencyForPosition } from '../radio/frequencies';

export interface EngineOptionsExt extends EngineOptions {
  /** Probability per eligible clearance of a pilot readback mistake. Default: 0 training, 0.08 otherwise. */
  readbackErrorRate?: number;
  /** Continuous traffic source. Default: basic generator driven by scenario.traffic. */
  trafficGenerator?: TrafficGenerator;
}

export const DEFAULT_WEATHER: Weather = {
  source: 'simulated',
  windDirDeg: 0,
  windSpeedKt: 0,
  visibilitySm: 10,
  clouds: [{ cover: 'SKC', baseFtAgl: 0 }],
  temperatureC: 15,
  dewpointC: 5,
  altimeterInHg: 29.92,
  phenomena: [],
  flightCategory: 'VFR',
};

const HISTORY_LEN = 60;
const MAX_STEPS_PER_ADVANCE = 2000;

export function createEngine(opts: EngineOptionsExt): SimulationEngine {
  const { airport, scenario } = opts;
  const dt = opts.dtSec ?? 0.1;
  const rng = mulberry32(scenario.seed);
  const controllerPosition: ControllerPositionId = scenario.controllerPositions[0] ?? 'TWR';
  const weather: Weather = scenario.weather === 'live' ? { ...DEFAULT_WEATHER } : { ...scenario.weather };
  const atis: Atis = {
    letter: 'A',
    text: 'Simulated ATIS',
    issuedAtSec: 0,
    activeRunways: { departing: [...scenario.activeRunways.departing], landing: [...scenario.activeRunways.landing] },
    simulated: true,
  };
  const state: SimulationState = {
    clock: { timeSec: 0, dtSec: dt, speed: 1, tick: 0 },
    airport,
    aircraft: {},
    weather,
    atis,
    activeRunways: { departing: [...scenario.activeRunways.departing], landing: [...scenario.activeRunways.landing] },
    runwayOccupancy: {},
    conflicts: [],
    events: [],
    controllerPosition,
    controllerFrequencyMhz: frequencyForPosition(airport, controllerPosition)?.mhz ?? airport.frequencies[0]?.mhz ?? 0,
    scenario,
    score: newScoreCard(),
    seed: scenario.seed,
  };
  const ctx: SimContext = {
    state,
    rng,
    runtime: new Map(),
    onPilotTransmission: opts.onPilotTransmission,
    readbackErrorRate: opts.readbackErrorRate ?? (scenario.mode === 'training' ? 0 : 0.08),
    eventSeq: 0,
    clearanceSeq: 0,
    aircraftSeq: 0,
    alertSeq: 0,
    scoreQueue: [],
    recentCommands: new Map(),
    loggedTransmissions: new Set(),
    dynamicAlerts: new Map(),
    clearanceAlerts: [],
    waitStats: { count: 0, totalSec: 0, delaySec: 0 },
    spawnedIdx: new Set(),
  };
  const generator = opts.trafficGenerator ?? createBasicTrafficGenerator();
  const listeners = new Set<(s: SimulationState) => void>();
  let accumulator = 0;

  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l(state);
      } catch (e) {
        console.error('[sim] subscriber threw', e);
      }
    }
  };

  const tickOnce = () => {
    processScheduledSpawns(ctx);
    for (const spec of generator.update(state)) spawnFromSpec(ctx, spec);
    applyPendingFrequencyChanges(ctx);
    updatePilotRequests(ctx);
    updateGroundMovement(ctx, dt);
    updateFlightDynamics(ctx, dt);
    updateRunwayOccupancy(ctx);
    detectConflicts(ctx);
    updateLifecycle(ctx);
    updateScoring(ctx);

    const before = state.clock.timeSec;
    state.clock.tick++;
    state.clock.timeSec = Math.round(state.clock.tick * dt * 1e6) / 1e6;
    if (Math.floor(state.clock.timeSec + 1e-9) > Math.floor(before + 1e-9)) {
      for (const ac of Object.values(state.aircraft)) {
        ac.history.push({ x: ac.pos.x, y: ac.pos.y });
        if (ac.history.length > HISTORY_LEN) ac.history.splice(0, ac.history.length - HISTORY_LEN);
      }
      if (Math.floor(state.clock.timeSec) % 30 === 0) {
        for (const [k, t] of ctx.recentCommands) if (state.clock.timeSec - t > 30) ctx.recentCommands.delete(k);
      }
    }
  };

  const engine: SimulationEngine = {
    getState: () => state,
    subscribe(listener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    step() {
      tickOnce();
      notify();
    },
    advance(wallSec: number) {
      if (state.clock.speed <= 0 || wallSec <= 0) return;
      accumulator += wallSec * state.clock.speed;
      let n = 0;
      while (accumulator + 1e-9 >= dt && n < MAX_STEPS_PER_ADVANCE) {
        tickOnce();
        accumulator -= dt;
        n++;
      }
      if (n >= MAX_STEPS_PER_ADVANCE) accumulator = 0;
      if (n > 0) notify();
    },
    setSpeed(speed: number) {
      state.clock.speed = Math.max(0, speed);
    },
    applyCommand(cmd: ParsedCommand, o): CommandOutcome {
      const out = executeCommand(ctx, cmd, o);
      notify();
      return out;
    },
    spawnAircraft(spec: Scenario['spawns'][number]): Aircraft {
      const ac = spawnFromSpec(ctx, spec);
      notify();
      return ac;
    },
    removeAircraft(id: string) {
      removeFromCtx(ctx, id, false, 'removed');
      notify();
    },
    setWeather(w: Weather) {
      state.weather = { ...w };
      const magDir = typeof w.windDirDeg === 'number' ? String(Math.round((((w.windDirDeg - airport.magneticVariationDeg) % 360) + 360) % 360) || 360).padStart(3, '0') : 'VRB';
      emitEvent(ctx, { kind: 'INFO', text: `Weather updated: wind ${magDir}/${w.windSpeedKt} kt (magnetic)`, severity: 'info', speaker: 'SYSTEM' });
      notify();
    },
    setAtis(atis) {
      state.atis = { ...atis, activeRunways: { departing: [...atis.activeRunways.departing], landing: [...atis.activeRunways.landing] }, simulated: true };
      notify();
    },
    setActiveRunways(cfg) {
      state.activeRunways = { departing: [...cfg.departing], landing: [...cfg.landing] };
      state.atis.activeRunways = { departing: [...cfg.departing], landing: [...cfg.landing] };
      emitEvent(ctx, { kind: 'SCENARIO', text: `Active runways: dep ${cfg.departing.join('/')} arr ${cfg.landing.join('/')}`, severity: 'info', speaker: 'SYSTEM' });
      notify();
    },
    setControllerPosition(position: ControllerPositionId) {
      state.controllerPosition = position;
      const f = frequencyForPosition(airport, position);
      if (f) state.controllerFrequencyMhz = f.mhz;
      notify();
    },
    selectAircraft(id?: string) {
      state.selectedAircraftId = id;
      notify();
    },
    logEvent(event: Omit<SimEvent, 'id' | 'timeSec'>): SimEvent {
      const ev = emitEvent(ctx, event);
      notify();
      return ev;
    },
    random: () => rng(),
    getAirport: () => airport,
  };

  processScheduledSpawns(ctx);
  return engine;
}
