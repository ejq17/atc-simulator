/**
 * Placeholder implementation so the UI can compile before the gameplay module lands.
 * The gameplay builder replaces this file (keep the `game: GameApi` export).
 */
import type { Airport, Scenario, SimulationState } from '../sim/types';
import { createBasicTrafficGenerator } from '../sim/traffic';
import { runwayEntryNodes } from '../airport';
import type { DebriefReport, FreePlayOptions, GameApi, ScenarioSummary, CareerProgress } from './index';

function nodeId(e: unknown): string {
  const x = e as { node?: { id: string }; id?: string };
  return x.node?.id ?? x.id ?? '';
}

const SUMMARIES: ScenarioSummary[] = [
  { id: 'first-takeoff', name: 'First takeoff', description: 'A Cessna 172 is holding short of runway 13. Clear it for takeoff, then clear the inbound Spirit A320 to land.', mode: 'free_play', difficulty: 1, estimatedMinutes: 5 },
];

function firstTakeoff(airport: Airport, seed = 1): Scenario {
  const hp = nodeId(runwayEntryNodes(airport, '13')[0]);
  const thr13 = airport.runways.find((r) => r.id === '13/31')!.ends.find((e) => e.id === '13')!;
  const trueHdg = thr13.trueHeadingDeg;
  const rad = ((trueHdg + 180) * Math.PI) / 180; // back along the approach course
  const nm = 1852;
  return {
    id: 'first-takeoff', name: 'First takeoff', description: SUMMARIES[0].description, mode: 'free_play', seed,
    weather: 'live', activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR', 'GND'],
    spawns: [
      { atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: hp, runwayEnd: '13' }, isDeparture: true, initialFrequencyId: 'TWR', initialRequest: 'DEPARTURE' },
      { atSec: 20, callsign: 'NKS451', type: 'A320', flightRules: 'IFR',
        start: { kind: 'airborne', pos: { x: thr13.threshold.x + Math.sin(rad) * 8 * nm, y: thr13.threshold.y + Math.cos(rad) * 8 * nm }, altitudeFt: 2500, headingDeg: trueHdg, speedKt: 160, runwayEnd: '13', distanceNm: 8 },
        isDeparture: false, initialFrequencyId: 'TWR', initialRequest: 'LANDING' },
    ],
  };
}

export const game: GameApi = {
  listScenarios: () => SUMMARIES,
  buildScenario: (_id, airport, options) => firstTakeoff(airport, options?.seed),
  buildFreePlay: (airport, options: FreePlayOptions) => ({ ...firstTakeoff(airport, options.seed), id: 'free-play', name: 'Free play', traffic: { enabled: true, arrivalsPerHour: options.arrivalsPerHour ?? 6, departuresPerHour: options.departuresPerHour ?? 6, gaFraction: options.gaFraction ?? 0.5, maxAircraft: options.maxAircraft ?? 6 } }),
  createTrafficGenerator: () => createBasicTrafficGenerator(),
  createTrainingController: () => null,
  buildDebrief: (state: SimulationState): DebriefReport => ({
    scenarioId: state.scenario.id, scenarioName: state.scenario.name, durationSec: state.clock.timeSec, score: state.score,
    grade: state.score.score >= 90 ? 'A' : state.score.score >= 80 ? 'B' : state.score.score >= 70 ? 'C' : state.score.score >= 60 ? 'D' : 'F',
    summary: `Handled ${state.score.aircraftHandled} aircraft.`, improvements: [],
    timeline: state.events.filter((e) => e.severity !== 'info').map((e) => ({ timeSec: e.timeSec, kind: e.kind, text: e.text, severity: e.severity, callsign: e.callsign })),
    objectives: [], completed: false,
  }),
  loadCareerProgress: (): CareerProgress => ({ completedSteps: [], bestScores: {}, unlockedStep: 1 }),
  saveCareerResult: () => ({ completedSteps: [], bestScores: {}, unlockedStep: 1 }),
  isScenarioComplete: () => false,
};
