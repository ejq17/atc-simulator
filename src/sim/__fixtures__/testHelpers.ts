import type { Aircraft, ClearanceKind, CommandKind, CommandOutcome, ControllerPositionId, GameMode, ParsedCommand, Scenario, ScenarioAircraftSpawn } from '../types';
import type { SimulationEngine } from '../api';
import { createEngine } from '../engine';
import type { EngineOptionsExt } from '../engine';
import { createTestAirport } from './testAirport';

/**
 * Fixture pilots start instantly and airliners taxi from their stands, so the tests of other features do not depend on engine-start timing or
 * pushback. Tests of those features (pushback.test.ts, groundOps.test.ts) pass `pilotBehaviour: REAL_GROUND`.
 */
export const FIXTURE_GROUND = { airlinerPushback: false, gaStartSec: [0, 0] as [number, number] };
export const REAL_GROUND = { airlinerPushback: true, gaStartSec: [8, 25] as [number, number] };

export function makeScenario(over: Partial<Scenario> = {}): Scenario {
  const pilotBehaviour = { ...over.pilotBehaviour, ground: { ...FIXTURE_GROUND, ...over.pilotBehaviour?.ground } };
  return {
    id: 'test',
    name: 'Test scenario',
    description: 'fixture',
    mode: 'free_play' as GameMode,
    seed: 12345,
    weather: {
      source: 'simulated', windDirDeg: 0, windSpeedKt: 0, visibilitySm: 10, clouds: [{ cover: 'SKC', baseFtAgl: 0 }],
      temperatureC: 15, dewpointC: 5, altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR',
    },
    activeRunways: { departing: ['13'], landing: ['13'] },
    controllerPositions: ['TWR', 'GND'],
    spawns: [],
    ...over,
    pilotBehaviour,
  };
}

export function makeEngine(over: { scenario?: Partial<Scenario>; opts?: Partial<EngineOptionsExt> } = {}): SimulationEngine {
  return createEngine({ airport: createTestAirport(), scenario: makeScenario(over.scenario), readbackErrorRate: 0, ...over.opts });
}

export function cmd(kind: CommandKind, callsign: string, f: Partial<ParsedCommand> = {}): ParsedCommand {
  return { kind, callsign, confidence: 0.95, rawText: `${kind} ${callsign}`, normalizedText: `${kind} ${callsign}`, issues: [], ...f };
}

export function run(engine: SimulationEngine, seconds: number): void {
  const n = Math.round(seconds / engine.getState().clock.dtSec);
  for (let i = 0; i < n; i++) engine.step();
}

export function runUntil(engine: SimulationEngine, pred: () => boolean, maxSec: number): boolean {
  const n = Math.round(maxSec / engine.getState().clock.dtSec);
  for (let i = 0; i < n; i++) {
    if (pred()) return true;
    engine.step();
  }
  return pred();
}

export function find(engine: SimulationEngine, callsign: string): Aircraft {
  const a = Object.values(engine.getState().aircraft).find((x) => x.callsign === callsign);
  if (!a) throw new Error(`no aircraft ${callsign}`);
  return a;
}

export function has(engine: SimulationEngine, callsign: string): boolean {
  return Object.values(engine.getState().aircraft).some((x) => x.callsign === callsign);
}

export const GA_PARKED = (callsign = 'N723EJ', parkingId = 'GA1', freq = 'GND', over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'C172', flightRules: 'VFR', start: { kind: 'parked', parkingId }, isDeparture: true, initialFrequencyId: freq, ...over,
});

export const HOLDING = (callsign: string, nodeId: string, runwayEnd: string, type = 'C172', freq = 'TWR'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type, flightRules: type === 'A320' ? 'IFR' : 'VFR', start: { kind: 'holding_short', nodeId, runwayEnd }, isDeparture: true, initialFrequencyId: freq,
});

export const ARRIVING = (callsign: string, runwayEnd: string, distanceNm: number, type = 'C172', freq = 'TWR'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type, flightRules: 'VFR',
  start: { kind: 'airborne', pos: { x: 0, y: 0 }, altitudeFt: 0, headingDeg: 0, speedKt: type === 'A320' ? 160 : 70, runwayEnd, distanceNm },
  isDeparture: false, initialFrequencyId: freq,
});

export type { ClearanceKind };

/** IFR arrival entering the area over `fix`, flying `route` (fixture fixes: TARR -> FX13A -> FX13B for ILS 13). */
export const AT_FIX = (
  callsign: string, fix: string, route: string[], runwayEnd = '13', over: Partial<ScenarioAircraftSpawn> = {},
  alt = 5000, speed = 210,
): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP',
  start: { kind: 'at_fix', fix, altitudeFt: alt, speedKt: speed, route, runwayEnd }, ...over,
});

/** IFR departure parked at a gate, on Clearance Delivery, filed to KPHL via `route`. */
export const IFR_DEPARTURE = (callsign = 'NKS451', parkingId = 'GATE-1', route: string[] = ['TVO'], over: Partial<ScenarioAircraftSpawn> = {}): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'A320', flightRules: 'IFR', start: { kind: 'parked', parkingId }, isDeparture: true, initialFrequencyId: 'CLNC',
  flightPlan: { flightRules: 'IFR', origin: 'KTST', destination: 'KPHL', cruiseAltitudeFt: 10000, route },
  ...over,
});

/** IFR departure already holding short of `nodeId` (skips the ground phase), with its IFR clearance already issued. */
export const IFR_HOLDING = (callsign: string, nodeId: string, runwayEnd: string, route: string[] = ['TVO'], freq = 'TWR'): ScenarioAircraftSpawn => ({
  atSec: 0, callsign, type: 'A320', flightRules: 'IFR', start: { kind: 'holding_short', nodeId, runwayEnd }, isDeparture: true, initialFrequencyId: freq,
  flightPlan: { flightRules: 'IFR', origin: 'KTST', destination: 'KPHL', cruiseAltitudeFt: 10000, route },
});

export const ALL_POSITIONS: ControllerPositionId[] = ['TWR', 'GND', 'APP', 'DEP', 'CLNC'];

/** Scenario overrides for IFR tests: every controller position available. */
export const ifrScenario = (spawns: ScenarioAircraftSpawn[], over: Partial<Scenario> = {}): Partial<Scenario> => ({ controllerPositions: ALL_POSITIONS, spawns, ...over });

/** Apply a command as a specific controller position. */
export function say(engine: SimulationEngine, c: ParsedCommand, position: ControllerPositionId): CommandOutcome {
  return engine.applyCommand(c, { position });
}

/** Text of every pilot transmission so far. */
export function pilotTexts(engine: SimulationEngine, callsign?: string): string[] {
  return engine.getState().events.filter((x) => x.kind === 'TRANSMISSION' && x.speaker === 'PILOT' && (!callsign || x.callsign === callsign)).map((x) => x.text);
}
