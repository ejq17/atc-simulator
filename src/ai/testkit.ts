/** Test helpers for the AI controllers (not imported by production code). */
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import type { SimulationEngine } from '../sim/api';
import type {
  Aircraft, CommandOutcome, ControllerPositionId, GameMode, ParsedCommand, Scenario, ScenarioAircraftSpawn, SimEvent,
} from '../sim/types';
import { createAiControllers } from './index';
import type { AiControllers, AiTransmission } from './index';

export const kacy = loadKacy();
export const ALL: ControllerPositionId[] = ['CLNC', 'GND', 'TWR', 'APP', 'DEP'];

export function cmd(kind: ParsedCommand['kind'], callsign: string, f: Partial<ParsedCommand> = {}): ParsedCommand {
  return { kind, callsign, confidence: 1, rawText: `${kind} ${callsign}`, normalizedText: `${kind} ${callsign}`, issues: [], ...f };
}

export interface AiOutcome {
  timeSec: number;
  position?: ControllerPositionId;
  cmd: ParsedCommand;
  out: CommandOutcome;
}

export interface HarnessOptions {
  spawns: ScenarioAircraftSpawn[];
  player: ControllerPositionId[];
  /** AI positions; default: every position the player does not work. */
  ai?: ControllerPositionId[];
  seed?: number;
  mode?: GameMode;
  activeRunways?: { departing: string[]; landing: string[] };
  readbackErrorRate?: number;
  aiSeed?: number;
  reactionDelaySec?: [number, number];
  /** Make the engine refuse every AI command of these kinds (tests the AI's back-off). */
  rejectKinds?: ParsedCommand['kind'][];
}

export interface Harness {
  engine: SimulationEngine;
  ai: AiControllers;
  /** Every event ever emitted (the engine keeps only the last 2000). */
  events: SimEvent[];
  transmissions: AiTransmission[];
  outcomes: AiOutcome[];
  now(): number;
  find(callsign: string): Aircraft | undefined;
  /** Advance in 1 s steps (AI driven by an engine subscription, like the UI), calling `perSecond` after each. */
  run(seconds: number, perSecond?: () => void): void;
  runUntil(pred: () => boolean, maxSec: number, perSecond?: () => void): boolean;
  say(position: ControllerPositionId, c: ParsedCommand): CommandOutcome;
  pilotTexts(callsign?: string): string[];
  atc(position?: ControllerPositionId): SimEvent[];
}

export function createHarness(o: HarnessOptions): Harness {
  const ai = o.ai ?? ALL.filter((p) => !o.player.includes(p));
  const scenario: Scenario = {
    id: 'ai-test', name: 'AI test', description: 'AI controller test', mode: o.mode ?? 'training', seed: o.seed ?? 4242,
    weather: {
      source: 'simulated', windDirDeg: 130, windSpeedKt: 4, visibilitySm: 10, clouds: [{ cover: 'SCT', baseFtAgl: 5000 }],
      temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR',
    },
    activeRunways: o.activeRunways ?? { departing: ['13'], landing: ['13'] },
    controllerPositions: ALL, playerPositions: o.player, spawns: o.spawns,
  };
  const engine = createEngine({ airport: kacy, scenario, readbackErrorRate: o.readbackErrorRate ?? 0, utcStartMs: Date.UTC(2026, 5, 1, 16, 0, 0) });
  const events: SimEvent[] = [];
  const transmissions: AiTransmission[] = [];
  const outcomes: AiOutcome[] = [];
  let lastSeq = 0;
  const harvest = () => {
    const ev = engine.getState().events;
    const fresh: SimEvent[] = [];
    for (let i = ev.length - 1; i >= 0; i--) {
      const n = Number(ev[i].id.replace('ev-', ''));
      if (n <= lastSeq) break;
      fresh.push(ev[i]);
    }
    fresh.reverse();
    if (fresh.length) lastSeq = Number(fresh[fresh.length - 1].id.replace('ev-', ''));
    events.push(...fresh);
  };
  // The AI sees the engine through a spy so tests can inspect every outcome of its commands.
  const spied: SimulationEngine = {
    ...engine,
    applyCommand(c, opts) {
      if (opts?.source === 'ai' && o.rejectKinds?.includes(c.kind)) {
        const out: CommandOutcome = { status: 'rejected', reason: 'test: forced refusal', unsafe: true };
        outcomes.push({ timeSec: engine.getState().clock.timeSec, position: opts.aiPosition, cmd: c, out });
        return out;
      }
      const out = engine.applyCommand(c, opts);
      if (opts?.source === 'ai') outcomes.push({ timeSec: engine.getState().clock.timeSec, position: opts.aiPosition, cmd: c, out });
      return out;
    },
  };
  const controllers = createAiControllers({
    engine: spied, airport: kacy, positions: ai, playerPositions: o.player, seed: o.aiSeed ?? o.seed ?? 4242,
    reactionDelaySec: o.reactionDelaySec, onTransmission: (t) => transmissions.push(t),
  });
  engine.subscribe((s) => {
    controllers.update(s);
    harvest();
  });
  harvest();
  const stepSecond = () => {
    const n = Math.round(1 / engine.getState().clock.dtSec);
    for (let i = 0; i < n; i++) engine.step();
  };
  const h: Harness = {
    engine, ai: controllers, events, transmissions, outcomes,
    now: () => engine.getState().clock.timeSec,
    find: (cs) => Object.values(engine.getState().aircraft).find((a) => a.callsign === cs),
    run(seconds, perSecond) {
      for (let i = 0; i < seconds; i++) {
        stepSecond();
        perSecond?.();
      }
    },
    runUntil(pred, maxSec, perSecond) {
      for (let i = 0; i < maxSec; i++) {
        if (pred()) return true;
        stepSecond();
        perSecond?.();
      }
      return pred();
    },
    say: (position, c) => engine.applyCommand(c, { position, source: 'typed' }),
    pilotTexts: (cs) => events.filter((e) => e.kind === 'TRANSMISSION' && e.speaker === 'PILOT' && (!cs || e.callsign === cs)).map((e) => e.text),
    atc: (position) => events.filter((e) => e.kind === 'TRANSMISSION' && e.speaker === 'ATC' && e.aiPosition !== undefined && (!position || e.aiPosition === position)),
  };
  return h;
}

export const IFR_DEP = (callsign = 'NKS451', parkingId = 'GATE-1', route = ['VCN'], over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'CLNC', start: { kind: 'parked', parkingId },
  flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route }, ...over,
});

export const IFR_ARR = (callsign = 'AAL212', fix = 'CARYL', route = ['CARYL', 'MAYBN'], runwayEnd = '13', altitudeFt = 4000, over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP',
  start: { kind: 'at_fix', fix, altitudeFt, speedKt: 170, route, runwayEnd }, ...over,
});

/** Timeline for debugging: ATC (AI) lines and pilot lines. */
export function timeline(h: Harness): string {
  return h.events
    .filter((e) => e.kind === 'TRANSMISSION' || e.kind === 'GO_AROUND' || e.kind === 'CONFLICT' || e.kind === 'COMMAND_REJECTED' || e.kind === 'CLARIFICATION' || e.kind === 'RUNWAY_INCURSION' || e.kind === 'SEPARATION_VIOLATION')
    .map((e) => `${e.timeSec.toFixed(0).padStart(5)}s ${e.kind === 'TRANSMISSION' ? `${e.speaker}${e.aiPosition ? `/${e.aiPosition}` : ''}` : e.kind} ${e.text}`)
    .join('\n');
}
