/** The scenario catalogue: career, training and free-play presets. */
import type { Airport } from '../../sim/types';
import type { FreePlayOptions, ScenarioSummary } from '../index';
import type { GameScenario } from '../types';
import { CAREER_SCENARIOS } from './career';
import { TRAINING_SCENARIOS } from './training';
import { buildFreePlay } from './freeplay';
import type { ScenarioDef } from './common';

type Start = NonNullable<FreePlayOptions['startingScenario']>;

function freePlayDef(id: string, name: string, description: string, difficulty: number, start?: Start): ScenarioDef {
  return {
    summary: { id, name, description, mode: 'free_play', difficulty, estimatedMinutes: undefined },
    build: (airport, options) => buildFreePlay(airport, { ...options, startingScenario: start ?? options?.startingScenario }),
  };
}

export const FREE_PLAY_SCENARIOS: ScenarioDef[] = [
  freePlayDef('free-play', 'Free play', 'Configure weather, runways, traffic and difficulty yourself. Runs until you end the session.', 2),
  freePlayDef('free-play-quiet', 'Free play: Quiet morning', 'A couple of aircraft and a slow trickle of traffic.', 1, 'quiet'),
  freePlayDef('free-play-mixed', 'Free play: Typical day', 'A steady mix of arrivals, departures, GA and airline traffic.', 3, 'mixed'),
  freePlayDef('free-play-busy-departures', 'Free play: Departure push', 'The ramp is full of aircraft asking to taxi.', 4, 'busy_departures'),
  freePlayDef('free-play-busy-arrivals', 'Free play: Arrival push', 'A stream of inbound traffic with few departures.', 4, 'busy_arrivals'),
];

export const ALL_SCENARIOS: ScenarioDef[] = [...CAREER_SCENARIOS, ...TRAINING_SCENARIOS, ...FREE_PLAY_SCENARIOS];

export function findScenarioDef(id: string): ScenarioDef | undefined {
  return ALL_SCENARIOS.find((d) => d.summary.id === id);
}

export function listScenarioSummaries(): ScenarioSummary[] {
  return ALL_SCENARIOS.map((d) => ({ ...d.summary }));
}

export function buildCatalogueScenario(id: string, airport: Airport, options?: FreePlayOptions): GameScenario {
  const d = findScenarioDef(id);
  if (!d) throw new Error(`Unknown scenario "${id}"`);
  return d.build(airport, options);
}

export { CAREER_SCENARIOS, TRAINING_SCENARIOS };
export { buildFreePlay, resolveWeather, recommendConfig } from './freeplay';
export { scenarioWeatherSchedule, scenarioEvents, createScenarioEventRunner } from './events';
export type { WeatherChange, ScenarioEventRunner, EventRunnerOptions } from './events';
