/**
 * Scripted scenario events (`GameScenario.events`).
 *
 * The engine has no scenario script, so the UI (or a test) drives the events:
 *
 *   const runner = createScenarioEventRunner(engine, scenario, { onPilotTransmission: voice.speak, onEvent: showToast });
 *   engine.subscribe(() => runner.update());          // cheap: a few comparisons per call
 *
 * Event kinds:
 *  - weather    -> `engine.setWeather(w)`. The runway configuration is NOT changed (the player must do that); the event's
 *                  `recommendedRunways` tells the UI what to suggest. The UI should also regenerate the ATIS.
 *  - emergency  -> the aircraft's `flags.emergency` is set and its `pendingRequest` replaced by the declaration, and a
 *                  PILOT transmission is logged (and passed to `onPilotTransmission` for TTS). The engine itself has no
 *                  emergency behaviour; the aircraft keeps flying its normal approach.
 *  - message    -> an INFO/SCENARIO log entry.
 */
import type { SimulationEngine } from '../../sim/api';
import type { Scenario, Weather } from '../../sim/types';
import type { GameScenario, ScenarioEvent } from '../types';

export interface WeatherChange {
  atSec: number;
  weather: Weather;
  text: string;
  recommendedRunways?: { departing: string[]; landing: string[] };
}

export function scenarioEvents(scenario: Scenario): ScenarioEvent[] {
  return [...((scenario as GameScenario).events ?? [])].sort((a, b) => a.atSec - b.atSec);
}

/** Timed weather changes of a scenario, in time order. Empty for scenarios without a wind shift. */
export function scenarioWeatherSchedule(scenario: Scenario): WeatherChange[] {
  return scenarioEvents(scenario)
    .filter((e): e is Extract<ScenarioEvent, { kind: 'weather' }> => e.kind === 'weather')
    .map((e) => ({ atSec: e.atSec, weather: e.weather, text: e.text, recommendedRunways: e.recommendedRunways }));
}

export interface EventRunnerOptions {
  /** Receives scripted pilot calls so the voice layer can speak them (same payload as the engine's callback). */
  onPilotTransmission?: (t: { aircraftId: string; callsign: string; text: string; frequencyMhz: number; voiceId: string }) => void;
  /** Called after each event is applied. */
  onEvent?: (e: ScenarioEvent) => void;
}

export interface ScenarioEventRunner {
  /** Apply every event that is due at the engine's current time; returns the events applied this call. */
  update(): ScenarioEvent[];
  readonly pending: number;
}

export function createScenarioEventRunner(engine: SimulationEngine, scenario: Scenario, opts: EventRunnerOptions = {}): ScenarioEventRunner {
  const events = scenarioEvents(scenario);
  const done = new Set<number>();
  return {
    get pending() {
      return events.length - done.size;
    },
    update() {
      const applied: ScenarioEvent[] = [];
      if (done.size === events.length) return applied;
      const state = engine.getState();
      const now = state.clock.timeSec;
      events.forEach((e, i) => {
        if (done.has(i) || e.atSec > now + 1e-9) return;
        switch (e.kind) {
          case 'weather':
            engine.setWeather(e.weather);
            engine.logEvent({ kind: 'SCENARIO', severity: 'warning', speaker: 'SYSTEM', text: e.text, data: { weatherChange: true, recommendedRunways: e.recommendedRunways } });
            break;
          case 'message':
            engine.logEvent({ kind: 'SCENARIO', severity: 'info', speaker: 'SYSTEM', text: e.text });
            break;
          case 'emergency': {
            const ac = Object.values(state.aircraft).find((a) => a.callsign.toUpperCase() === e.callsign.toUpperCase());
            if (!ac) return; // not spawned yet: try again on the next update
            ac.flags.emergency = true;
            ac.pendingRequest = { kind: 'LANDING', text: `${e.declaration} - ${e.text}`, sinceSec: now };
            engine.logEvent({
              kind: 'TRANSMISSION', aircraftId: ac.id, callsign: ac.callsign, severity: 'critical', speaker: 'PILOT',
              frequencyMhz: ac.frequencyMhz, text: e.text, data: { request: 'LANDING', emergency: true, declaration: e.declaration },
            });
            opts.onPilotTransmission?.({ aircraftId: ac.id, callsign: ac.callsign, text: e.text, frequencyMhz: ac.frequencyMhz, voiceId: ac.voiceId });
            break;
          }
        }
        done.add(i);
        applied.push(e);
        opts.onEvent?.(e);
      });
      return applied;
    },
  };
}
