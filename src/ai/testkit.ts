/** Test helpers for the AI controllers (not imported by production code). */
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import type { SimulationEngine } from '../sim/api';
import type {
  Aircraft, Airport, CommandOutcome, ControllerPositionId, GameMode, ParsedCommand, Scenario, ScenarioAircraftSpawn, SimEvent,
} from '../sim/types';
import { awaitingAnswer, releaseNeeded, validApproval } from '../sim/coordination';
import type { SimulationEngineExtras } from '../sim/engineExtras';
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
  /** Airport to work (default: KACY). */
  airport?: Airport;
  /** Make the engine refuse every AI command of these kinds (tests the AI's back-off). */
  rejectKinds?: ParsedCommand['kind'][];
  /**
   * A scripted human on the player's positions answers landline requests: 'approve' (default) approves every request `answerAfterSec` (default 3)
   * seconds after it was made; false leaves them unanswered (tests of the coordination itself answer or ignore them).
   */
  humanAnswers?: 'approve' | false;
  answerAfterSec?: number;
  /** Pilot behaviour override of the scenario (e.g. unfamiliar pilots, hold-short readback omissions). */
  pilotBehaviour?: Scenario['pilotBehaviour'];
}

export interface Harness {
  engine: SimulationEngine;
  ai: AiControllers;
  /** Every event ever emitted (the engine keeps only the last 2000). */
  events: SimEvent[];
  /** Radio transmissions (one ATC event each). */
  transmissions: AiTransmission[];
  /** Landline calls the AI made (coordination channel). */
  landline: AiTransmission[];
  outcomes: AiOutcome[];
  now(): number;
  find(callsign: string): Aircraft | undefined;
  /** Advance in 1 s steps (AI driven by an engine subscription, like the UI), calling `perSecond` after each. */
  run(seconds: number, perSecond?: () => void): void;
  runUntil(pred: () => boolean, maxSec: number, perSecond?: () => void): boolean;
  say(position: ControllerPositionId, c: ParsedCommand): CommandOutcome;
  pilotTexts(callsign?: string): string[];
  atc(position?: ControllerPositionId): SimEvent[];
  /** A scripted human Tower: true when `ac` may be cleared for takeoff now (no release needed, or one is current); otherwise the release is requested and false returned. */
  towerMayDepart(ac: Aircraft): boolean;
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
    controllerPositions: ALL, playerPositions: o.player, spawns: o.spawns, pilotBehaviour: o.pilotBehaviour,
  };
  const engine = createEngine({ airport: o.airport ?? kacy, scenario, readbackErrorRate: o.readbackErrorRate ?? 0, utcStartMs: Date.UTC(2026, 5, 1, 16, 0, 0) });
  const events: SimEvent[] = [];
  const transmissions: AiTransmission[] = [];
  const landline: AiTransmission[] = [];
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
    engine: spied, airport: o.airport ?? kacy, positions: ai, playerPositions: o.player, seed: o.aiSeed ?? o.seed ?? 4242,
    reactionDelaySec: o.reactionDelaySec, onTransmission: (t) => (t.channel === 'landline' ? landline : transmissions).push(t),
  });
  const humanAnswers = o.humanAnswers ?? 'approve';
  const api = (engine as SimulationEngineExtras).coordination;
  engine.subscribe((s) => {
    controllers.update(s);
    if (humanAnswers && api) {
      for (const pos of s.coordination?.human ?? o.player) {
        for (const r of awaitingAnswer(s, pos)) {
          if (r.status === 'pending' && s.clock.timeSec - r.lastAskSec >= (o.answerAfterSec ?? 3)) api.respond(r.id, 'approve', { by: pos, source: 'player' });
        }
      }
    }
    harvest();
  });
  harvest();
  const stepSecond = () => {
    const n = Math.round(1 / engine.getState().clock.dtSec);
    for (let i = 0; i < n; i++) engine.step();
  };
  const h: Harness = {
    engine, ai: controllers, events, transmissions, landline, outcomes,
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
    towerMayDepart(ac) {
      const st = engine.getState();
      const dep = releaseNeeded(st, 'TWR', ac);
      if (!dep || validApproval(st, 'RELEASE', ac.id)) return true;
      api?.request({ topic: 'RELEASE', from: 'TWR', to: dep, aircraftId: ac.id, source: 'player' });
      return false;
    },
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
