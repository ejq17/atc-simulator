/** The scenario catalogue: career, training and free-play presets. */
import type { Airport, ControllerPositionId } from '../../sim/types';
import type { FreePlayOptions, ScenarioSummary } from '../index';
import type { GameScenario } from '../types';
import { CAREER_SCENARIOS } from './career';
import { TRAINING_SCENARIOS } from './training';
import { buildFreePlay } from './freeplay';
import type { ScenarioDef } from './common';
import { realismForDifficulty } from '../../sim/pilotBehaviour';
import type { PilotRealismLevel } from '../../sim/pilotBehaviour';

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

/**
 * The career steps and training lessons are written around one airport's real geometry (KACY: runway 13 hold lines, taxiways
 * Alpha/Bravo/Delta, GA-2, GATE-4, neighbouring airports): they are offered only there. Free play works at every airport.
 */
const AUTHORED_FOR: readonly string[] = ['KACY'];
const tagged = (defs: ScenarioDef[]): ScenarioDef[] => defs.map((d) => ({ ...d, summary: { ...d.summary, airports: AUTHORED_FOR } }));

export const ALL_SCENARIOS: ScenarioDef[] = [...tagged(CAREER_SCENARIOS), ...tagged(TRAINING_SCENARIOS), ...FREE_PLAY_SCENARIOS];

export function findScenarioDef(id: string): ScenarioDef | undefined {
  return ALL_SCENARIOS.find((d) => d.summary.id === id);
}

/** Scenario summaries; with an airport, only those that can be played there. */
export function listScenarioSummaries(icao?: string): ScenarioSummary[] {
  return ALL_SCENARIOS.filter((d) => !icao || !d.summary.airports || d.summary.airports.includes(icao.toUpperCase())).map((d) => ({ ...d.summary }));
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
  'train-10-coordination': ['GND'],
};

export function defaultPlayerPositions(id: string): ControllerPositionId[] | undefined {
  const p = DEFAULT_PLAYER_POSITIONS[id];
  return p ? [...p] : undefined;
}

/** Career: steps 1-2 (introductory) off, 3-5 light, 6-9 moderate, 10-12 heavy (the catalogue has 12 steps). */
export function careerRealism(step: number | undefined): PilotRealismLevel {
  const s = step ?? 1;
  return s <= 2 ? 'off' : s <= 5 ? 'light' : s <= 9 ? 'moderate' : 'heavy';
}

/** Pilot realism of a catalogue scenario that does not set it: training lessons off, career by step, anything else from its Difficulty (easy light, normal moderate, hard heavy). */
function realismFor(mode: GameScenario['mode'], careerStep: number | undefined, difficulty: GameScenario['difficulty']): PilotRealismLevel {
  if (mode === 'training') return 'off';
  if (mode === 'career') return careerRealism(careerStep);
  return realismForDifficulty(difficulty);
}

export function buildCatalogueScenario(id: string, airport: Airport, options?: FreePlayOptions): GameScenario {
  const d = findScenarioDef(id);
  if (!d) throw new Error(`Unknown scenario "${id}"`);
  if (d.summary.airports && !d.summary.airports.includes(airport.icao)) throw new Error(`Scenario "${id}" is authored for ${d.summary.airports.join(', ')} only, not ${airport.icao}`);
  const sc = d.build(airport, options);
  // career steps always ramp (step 11 is built on the free-play builder, whose default is moderate); a lesson may opt in to realism itself
  if (d.summary.mode === 'career') sc.pilotRealism = careerRealism(d.summary.careerStep);
  else sc.pilotRealism ??= realismFor(d.summary.mode, d.summary.careerStep, sc.difficulty);
  // Explicit option wins; otherwise a career/training scenario defaults to the position it is about (free play: all positions).
  const wanted = options?.playerPositions?.length ? [...new Set(options.playerPositions)] : d.summary.mode === 'free_play' ? undefined : defaultPlayerPositions(id);
  if (wanted) sc.playerPositions = wanted;
  return sc;
}

export { CAREER_SCENARIOS, TRAINING_SCENARIOS };
export { buildFreePlay, resolveWeather, recommendConfig } from './freeplay';
export { scenarioWeatherSchedule, scenarioEvents, createScenarioEventRunner } from './events';
export type { WeatherChange, ScenarioEventRunner, EventRunnerOptions } from './events';
