/**
 * Game-layer extensions to the engine's `Scenario` contract.
 *
 * `Scenario` (src/sim/types.ts) is fixed. Everything extra a game scenario carries lives in optional fields
 * that the engine ignores; the UI may read them (`events`, `difficulty`, `careerStep`...). All of them are
 * plain JSON so a scenario survives structuredClone / persistence.
 */
import type { ClosureKind, CommandKind, Scenario, Weather } from '../sim/types';
import type { SpecialTrafficSelection } from './specialTraffic';

/** A scripted occurrence at a scenario time. The UI applies them with `applyDueScenarioEvents` (scenarios/events.ts). */
export type ScenarioEvent =
  | {
      atSec: number;
      kind: 'weather';
      weather: Weather;
      /** Text for the log / a toast, e.g. "Wind shift: now 290 at 14". */
      text: string;
      /** Runway configuration the new wind favours. NOT applied automatically: the player must switch. */
      recommendedRunways?: { departing: string[]; landing: string[] };
    }
  | {
      atSec: number;
      kind: 'emergency';
      callsign: string;
      declaration: 'MAYDAY' | 'PAN-PAN';
      /** Full pilot call, shown/spoken as that aircraft's transmission. */
      text: string;
    }
  | { atSec: number; kind: 'message'; text: string }
  | {
      atSec: number;
      kind: 'closure';
      /** `ident` is a runway end / pair or a taxiway designator. `durationSec` counts from the moment the closure is applied (omitted: closed for the rest of the session). */
      closure: { kind: ClosureKind; ident: string; durationSec?: number; reason?: string };
      /** Runways only: wait until no aircraft is on, cleared onto or on short final to the runway (an airport-operations inspection waits for a quiet time). */
      quiet?: boolean;
      text: string;
    }
  | {
      atSec: number;
      kind: 'birds';
      /** Clause appended to "Bird activity in the vicinity of the airport", e.g. "flocks of small birds, altitude unknown" (JO 7110.65 2-1-23). */
      detail: string;
      durationSec: number;
      text: string;
    };

/** Training step as stored on `Scenario.training.steps`, with the game-layer extras. */
export interface TrainingStepSpec {
  id: string;
  prompt: string;
  expectCommand?: CommandKind;
  explanation: string;
  reference?: string;
  /** The aircraft the step is about; an accepted command for another callsign does not complete it. */
  callsign?: string;
  /** Alternative/additional completion: an objective-check string (see objectives.ts). If set without `expectCommand`, the step is a "wait" step. */
  check?: string;
  /** Example of a correct transmission (shown as a hint). */
  example?: string;
  /** Typical errors, appended to the explanation and used in feedback. */
  mistakes?: string[];
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface GameScenarioExtras {
  events?: ScenarioEvent[];
  difficulty?: Difficulty;
  /** Aircraft types the traffic generator may use. */
  aircraftTypes?: string[];
  /** Special traffic kinds the generator may produce (specialTraffic.ts); unset = none (scripted and career scenarios keep their traffic). */
  specialTraffic?: Partial<SpecialTrafficSelection>;
  careerStep?: number;
  /** Longer briefing text (description is the short form). */
  briefing?: string;
  /**
   * IFR flows of the traffic generator (see ifr.ts `resolveIfrFlows`): airline arrivals as `at_fix` arrivals on the published procedure and
   * airline departures as parked IFR departures with a flight plan. `ifrArrivals` / `ifrDepartures` override `ifrFlows` for one side;
   * all unset = decided from `controllerPositions` (APP -> arrivals, CLNC -> departures).
   */
  ifrFlows?: boolean;
  ifrArrivals?: boolean;
  ifrDepartures?: boolean;
  /** Which spawns are the *scripted* ones (traffic generator must not reuse their callsigns). */
  training?: { steps: TrainingStepSpec[] };
}

export type GameScenario = Scenario & GameScenarioExtras;
