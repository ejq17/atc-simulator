/**
 * Gameplay layer entry point: `game: GameApi` plus the extra helpers the UI may use (scenario events, references,
 * disclaimer). See src/game/README.md.
 */
import type { Airport, Scenario } from '../sim/types';
import type { FreePlayOptions, GameApi } from './index';
import { buildCatalogueScenario, buildFreePlay, listScenarioSummaries } from './scenarios';
import { createTrafficGenerator } from './traffic';
import { createTrainingController } from './training';
import { buildDebrief } from './debrief';
import { isScenarioComplete, loadCareerProgress, saveCareerResult } from './career';

export const game: GameApi = {
  listScenarios: () => listScenarioSummaries(),
  buildScenario: (id: string, airport: Airport, options?: FreePlayOptions): Scenario => buildCatalogueScenario(id, airport, options),
  buildFreePlay: (airport: Airport, options: FreePlayOptions): Scenario => buildFreePlay(airport, options),
  createTrafficGenerator,
  createTrainingController,
  buildDebrief,
  loadCareerProgress,
  saveCareerResult,
  isScenarioComplete,
};

export { defaultPlayerPositions, DEFAULT_PLAYER_POSITIONS } from './scenarios';
export { scenarioWeatherSchedule, scenarioEvents, createScenarioEventRunner } from './scenarios/events';
export type { WeatherChange, ScenarioEventRunner, EventRunnerOptions } from './scenarios/events';
export { REFERENCES, TRAINING_DISCLAIMER, KACY_READBACK_NOTE, refText } from './references';
export type { FaaReference } from './references';
export { evaluateCheck, evaluateObjectives, allObjectivesDone } from './objectives';
export { gradeFor } from './debrief';
export { arrivalProcedure, resolveIfrFlows, ifrFlightPlan } from './ifr';
export type { ArrivalProcedure, IfrFlowSwitches } from './ifr';
export { careerStepOf, CAREER_STORAGE_KEY } from './career';
export type { GameScenario, ScenarioEvent, TrainingStepSpec, Difficulty } from './types';
