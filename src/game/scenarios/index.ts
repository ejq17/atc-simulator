/** The scenario catalogue: career, training and free-play presets. */
import type { Airport, ControllerPositionId } from '../../sim/types';
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

/**
 * The position(s) a career / training scenario is about, when that is fewer than the positions it lists (the rest is AI work):
 * Ground lessons give GND only, Tower lessons TWR only (AI Ground moves the landed aircraft), the approach lessons APP + DEP.
 * Scenarios that exercise several positions together (career 2 and 7, 9-12, the crossing and IFR-clearance lessons) are absent:
 * the player keeps everything they list. The setup screen lets the player override any of this.
 */
export const DEFAULT_PLAYER_POSITIONS: Readonly<Record<string, readonly ControllerPositionId[]>> = {
  'career-03-single-landing': ['TWR'],
  'career-04-multiple-departures': ['TWR'],
  'career-05-ground-taxi': ['GND'],
  'career-06-pattern': ['TWR'],
  'career-08-ifr': ['APP', 'DEP'],
  'train-02-taxi': ['GND'],
  'train-03-runway-safety': ['TWR'],
  'train-05-sequencing': ['TWR'],
  'train-06-pattern': ['TWR'],
  'train-07-go-around': ['TWR'],
  'train-09-approach': ['APP', 'DEP'],
};

export function defaultPlayerPositions(id: string): ControllerPositionId[] | undefined {
  const p = DEFAULT_PLAYER_POSITIONS[id];
  return p ? [...p] : undefined;
}

export function buildCatalogueScenario(id: string, airport: Airport, options?: FreePlayOptions): GameScenario {
  const d = findScenarioDef(id);
  if (!d) throw new Error(`Unknown scenario "${id}"`);
  const sc = d.build(airport, options);
  // Explicit option wins; otherwise a career/training scenario defaults to the position it is about (free play: all positions).
  const wanted = options?.playerPositions?.length ? [...new Set(options.playerPositions)] : d.summary.mode === 'free_play' ? undefined : defaultPlayerPositions(id);
  if (wanted) sc.playerPositions = wanted;
  return sc;
}

export { CAREER_SCENARIOS, TRAINING_SCENARIOS };
export { buildFreePlay, resolveWeather, recommendConfig } from './freeplay';
export { scenarioWeatherSchedule, scenarioEvents, createScenarioEventRunner } from './events';
export type { WeatherChange, ScenarioEventRunner, EventRunnerOptions } from './events';
