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
import { resolvePilotBehaviour } from './pilotBehaviour';
import { emitEvent } from './context';
import { flushScheduledSpeech } from './radioDiscipline';
import { setSimulationEpoch } from './solar';
import type { SimContext } from './context';
import { executeCommand, validateCommand } from './commandExecutor';
import type { SimulationEngineExtras } from './engineExtras';
import { updateGroundMovement } from './groundMovement';
import { updateFlightDynamics } from './flightDynamics';
import { updateRotorcraft } from './rotorcraft';
import { updateVehicles } from './vehicles';
import { updateSpecial } from './special';
import { updateRunwayOccupancy } from './runwayOccupancy';
import { detectConflicts } from './conflicts';
import { newScoreCard, updateScoring } from './scoring';
import { coordInform, coordRequest, coordRescind, coordRespond, newCoordinationState, updateCoordination } from './coordination';
import {
  applyPendingFrequencyChanges, processScheduledSpawns, removeAircraft as removeFromCtx, spawnFromSpec, updateLifecycle, updatePilotRequests,
} from './traffic';
import type { TrafficGenerator } from './traffic';
import { createBasicTrafficGenerator } from './traffic';
import { frequencyForPosition } from '../radio/frequencies';
import { addClosureToState, announceClosureChanges, enforceClosuresOnRoutes, newAirportOps } from './airportOps';

export interface EngineOptionsExt extends EngineOptions {
  /** Probability per eligible clearance of a pilot readback mistake. Default: 0 training, 0.08 otherwise. */
  readbackErrorRate?: number;
  /** Continuous traffic source. Default: basic generator driven by scenario.traffic. */
  trafficGenerator?: TrafficGenerator;
  /** Wall-clock UTC (ms since the epoch) of scenario time 0: drives sunrise / sunset (LAHSO, 3-10-3 daylight rule). Default: the real time at engine creation. */
  utcStartMs?: number;
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

export function createEngine(opts: EngineOptionsExt): SimulationEngine & SimulationEngineExtras {
  const { airport, scenario } = opts;
  const dt = opts.dtSec ?? 0.1;
  const pilotBehaviour = resolvePilotBehaviour(scenario.pilotBehaviour, scenario.mode, scenario.pilotRealism);
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
    coordination: newCoordinationState(scenario),
    ops: newAirportOps(),
  };
  for (const c of scenario.closures ?? []) {
    const r = addClosureToState(state, { ...c, startSec: c.startSec ?? 0 }, 'setup');
    if (!r.ok) console.warn(`[sim] scenario closure ignored: ${r.reason}`);
  }
  setSimulationEpoch(state, opts.utcStartMs ?? Date.now());
  const ctx: SimContext = {
    state,
    pilotBehaviour,
    rng,
    runtime: new Map(),
    onPilotTransmission: opts.onPilotTransmission,
    readbackErrorRate: opts.readbackErrorRate ?? (scenario.pilotRealism ? (pilotBehaviour.realism.level === 'off' ? 0 : pilotBehaviour.realism.digitErrorRate) : scenario.mode === 'training' ? 0 : 0.08),
    scheduledSpeech: [],
    speechSeq: 0,
    frequencyUse: new Map(),
    frequencyReserved: new Map(),
    answerWindow: new Map(),
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
    opsAnnounced: new Set(),
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
    flushScheduledSpeech(ctx);
    updatePilotRequests(ctx);
    enforceClosuresOnRoutes(ctx);
    updateGroundMovement(ctx, dt);
    updateRotorcraft(ctx, dt);
    updateFlightDynamics(ctx, dt);
    updateSpecial(ctx);
    updateVehicles(ctx);
    updateRunwayOccupancy(ctx);
    detectConflicts(ctx);
    updateLifecycle(ctx);
    updateCoordination(ctx);
    announceClosureChanges(ctx);
    if (state.ops.birds && state.clock.timeSec >= state.ops.birds.untilSec) state.ops.birds = undefined;
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

  const engine: SimulationEngine & SimulationEngineExtras = {
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
    validateCommand(cmd: ParsedCommand, o): CommandOutcome {
      return validateCommand(ctx, cmd, o); // dry run: no events, no readback, no scoring, no notification
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
    coordination: {
      request(input) {
        const r = coordRequest(ctx, input);
        notify();
        return r;
      },
      respond(id, answer, o) {
        const r = coordRespond(ctx, id, answer, o);
        notify();
        return r;
      },
      rescind(id, o) {
        const r = coordRescind(ctx, id, o);
        notify();
        return r;
      },
      inform(input) {
        const m = coordInform(ctx, input);
        notify();
        return m;
      },
      setStaffing(human, ai) {
        const c = state.coordination!;
        c.human = [...new Set(human)];
        c.staffed = [...new Set([...human, ...(ai ?? scenario.controllerPositions.filter((p) => !human.includes(p)))])];
        notify();
      },
    },
    addClosure(spec, source = 'player') {
      const r = addClosureToState(state, spec, source);
      if (r.ok) notify();
      return r;
    },
    removeClosure(id) {
      const c = state.ops.closures.find((x) => x.id === id);
      if (!c || (c.endSec !== undefined && c.endSec <= state.clock.timeSec)) return false;
      c.endSec = state.clock.timeSec;
      notify();
      return true;
    },
    setBirdActivity(text, durationSec = 1800) {
      state.ops.birds = text ? { text, untilSec: state.clock.timeSec + durationSec } : undefined;
      if (text) emitEvent(ctx, { kind: 'SCENARIO', severity: 'info', speaker: 'SYSTEM', text: `Bird activity: ${text}`, data: { birds: true } });
      notify();
    },
    setRunwayLightStep(runwayId, step) {
      if (step === undefined) delete state.ops.lightStep[runwayId];
      else state.ops.lightStep[runwayId] = Math.max(1, Math.min(5, Math.round(step)));
      notify();
    },
    reportBrakingAction(report) {
      const full = { ...report, atSec: state.clock.timeSec };
      state.ops.braking.push(full);
      if (state.ops.braking.length > 20) state.ops.braking.splice(0, state.ops.braking.length - 20);
      notify();
      return full;
    },
    random: () => rng(),
    getAirport: () => airport,
  };

  processScheduledSpawns(ctx);
  return engine;
}
