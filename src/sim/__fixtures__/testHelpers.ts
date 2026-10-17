import type { Aircraft, ClearanceKind, CommandKind, GameMode, ParsedCommand, Scenario, ScenarioAircraftSpawn } from '../types';
import type { SimulationEngine } from '../api';
import { createEngine } from '../engine';
import type { EngineOptionsExt } from '../engine';
import { createTestAirport } from './testAirport';

export function makeScenario(over: Partial<Scenario> = {}): Scenario {
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
