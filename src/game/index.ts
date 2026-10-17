/**
 * Gameplay layer contract (scenarios, traffic, training, career, debrief).
 *
 * This file is the interface the UI depends on. The gameplay builder fills in
 * src/game/* behind these exports; the signatures below must stay stable.
 */
import type { Airport, ControllerPositionId, GameMode, Scenario, SimulationState, Weather } from '../sim/types';
import type { TrafficGenerator } from '../sim/traffic';

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  mode: GameMode;
  /** 1 = easiest. Career scenarios are ordered by this. */
  difficulty: number;
  /** Career index (1..12) when mode === 'career'. */
  careerStep?: number;
  estimatedMinutes?: number;
  /** ICAO codes the scenario is authored for (taxiway names, runway ends, parking ids); undefined = every airport. */
  airports?: readonly string[];
}

export interface FreePlayOptions {
  seed?: number;
  weather?: Weather | 'live' | string;        // preset id, full object, or 'live'
  activeRunways?: { departing: string[]; landing: string[] };
  aircraftCount?: number;                      // initial aircraft
  arrivalsPerHour?: number;
  departuresPerHour?: number;
  gaFraction?: number;                         // 0..1
  maxAircraft?: number;
  difficulty?: 'easy' | 'normal' | 'hard';
  aircraftTypes?: string[];                    // e.g. ['C172','A320']
  startingScenario?: 'quiet' | 'busy_departures' | 'busy_arrivals' | 'mixed';
  /**
   * IFR flows: airline arrivals appear over the published approach fix on the Approach frequency (ILS 13 via CARYL, ILS 31 via STEVV,
   * RNAV 22 via KOPCE, RNAV 4 via JEDOB) and airline departures are parked IFR departures that call Clearance Delivery first. GA stays VFR.
   * Default: on when the session's controller positions include APP (arrivals) or CLNC (departures), off for Tower/Ground sessions, which keep
   * arrivals on final already cleared for the approach. Passing a boolean forces both flows on/off and, when true, lists CLNC/APP/DEP in
   * `controllerPositions`. Free-play builds list only TWR and GND, so a UI that offers other positions should pass this option.
   */
  ifrFlows?: boolean;
  /**
   * Positions the human works; sets `scenario.playerPositions`. Every other position in `scenario.controllerPositions` (the full set that
   * exists in the session, unchanged by this option) is worked by an AI controller. Unset: catalogue career/training scenarios use the
   * position each one is about (see `defaultPlayerPositions`, e.g. the Ground lessons give GND only), free play leaves it unset (= all).
   */
  playerPositions?: ControllerPositionId[];
}

export interface DebriefReport {
  scenarioId: string;
  scenarioName: string;
  durationSec: number;
  score: SimulationState['score'];
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  summary: string;
  improvements: string[];
  timeline: { timeSec: number; kind: string; text: string; severity: 'info' | 'warning' | 'critical'; callsign?: string }[];
  objectives: { id: string; text: string; completed: boolean }[];
  completed: boolean;
}

export interface TrainingStepState {
  index: number;
  total: number;
  id: string;
  prompt: string;
  explanation: string;
  reference?: string;
  status: 'pending' | 'active' | 'done' | 'error';
  lastFeedback?: string;
}

export interface TrainingController {
  /** Call after every engine state change; returns the current step. */
  update(state: SimulationState): TrainingStepState;
  /** Call with each parsed/applied command outcome so the trainer can give feedback. */
  onCommand(outcome: { kind: string; status: 'accepted' | 'rejected' | 'clarify'; reason?: string; callsign?: string | null }): void;
  current(): TrainingStepState;
  isComplete(): boolean;
}

export interface CareerProgress {
  completedSteps: number[];
  bestScores: Record<string, number>;
  unlockedStep: number;
}

export interface GameApi {
  /** All scenarios; with an airport (ICAO), only those playable there. */
  listScenarios(icao?: string): ScenarioSummary[];
  /** Build a full Scenario (with spawns resolved against the airport) ready for createEngine. */
  buildScenario(id: string, airport: Airport, options?: FreePlayOptions): Scenario;
  buildFreePlay(airport: Airport, options: FreePlayOptions): Scenario;
  createTrafficGenerator(scenario: Scenario, airport: Airport, options?: { densityAt?: (state: Readonly<SimulationState>) => number }): TrafficGenerator;
  createTrainingController(scenario: Scenario): TrainingController | null;
  buildDebrief(state: SimulationState, startedAtSec?: number): DebriefReport;
  loadCareerProgress(): CareerProgress;
  saveCareerResult(scenarioId: string, report: DebriefReport): CareerProgress;
  isScenarioComplete(state: SimulationState): boolean;
}

export { game as default } from './game';
export * from './game';
