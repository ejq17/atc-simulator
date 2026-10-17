/**
 * Public API contract of the simulation engine. UI, voice, and gameplay code
 * depend ONLY on this file and on `types.ts`, never on engine internals.
 */
import type {
  Aircraft, Airport, CommandOutcome, ControllerPositionId, ParsedCommand,
  Scenario, SimEvent, SimulationState, Weather,
} from './types';

export type Unsubscribe = () => void;

export interface SimulationEngine {
  /** Authoritative state. Treat as read-only outside the engine. */
  getState(): SimulationState;
  /** Called with the new state after every tick and after every command. */
  subscribe(listener: (state: SimulationState) => void): Unsubscribe;
  /** Advance the simulation by exactly one fixed step (`state.clock.dtSec`). */
  step(): void;
  /** Advance by wall-clock seconds, honouring `clock.speed`; runs N fixed steps and returns the leftover accumulator. */
  advance(wallSec: number): void;
  setSpeed(speed: number): void;

  /**
   * Validate and execute an already-parsed command. The engine is the ONLY
   * place that mutates aircraft state. It must reject unsafe or impossible
   * commands with a reason, and ask for clarification when the command is
   * ambiguous (unresolved callsign, missing runway...).
   */
  applyCommand(cmd: ParsedCommand, opts?: { position?: ControllerPositionId; source?: 'voice' | 'typed'; transmissionId?: string }): CommandOutcome;

  /** Spawn/despawn helpers used by scenarios and traffic generation. */
  spawnAircraft(spec: Scenario['spawns'][number]): Aircraft;
  removeAircraft(id: string): void;

  setWeather(weather: Weather): void;
  setActiveRunways(cfg: { departing: string[]; landing: string[] }): void;
  setControllerPosition(position: ControllerPositionId): void;
  selectAircraft(id?: string): void;

  /** Record a transmission (ATC or pilot) in the event log without changing aircraft state. */
  logEvent(event: Omit<SimEvent, 'id' | 'timeSec'>): SimEvent;
  /** Seeded PRNG shared by everything so scenarios replay deterministically. */
  random(): number;
  getAirport(): Airport;
}

export interface EngineOptions {
  airport: Airport;
  scenario: Scenario;
  dtSec?: number;              // default 0.1
  /** Called whenever a pilot "speaks" so the voice layer can synthesise it. */
  onPilotTransmission?: (t: { aircraftId: string; callsign: string; text: string; frequencyMhz: number; voiceId: string; event: SimEvent }) => void;
}
