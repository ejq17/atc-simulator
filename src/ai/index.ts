/**
 * AI controllers: rule-based agents that work the positions the human player does not.
 * They act ONLY through `engine.applyCommand(cmd, { position, source: 'ai', aiPosition })`,
 * so every safety rule applies to them exactly as to the player.
 */
import type { SimulationEngine } from '../sim/api';
import type { Airport, ControllerPositionId, SimulationState } from '../sim/types';

export interface AiTransmission {
  position: ControllerPositionId;
  frequencyMhz: number;
  text: string;            // what the AI controller said, in ATC phraseology
  spokenText: string;      // TTS-ready
  callsign?: string;
  timeSec: number;
  voiceId: string;         // distinct from pilot voices
  /** 'landline': a call to another position (coordination), not a radio transmission; `toPosition` is who it is for. Default 'radio'. */
  channel?: 'radio' | 'landline';
  toPosition?: ControllerPositionId;
}

export interface AiControllerOptions {
  engine: SimulationEngine;
  airport: Airport;
  /** Positions the AI works (the complement of the player's positions within the scenario's positions). */
  positions: ControllerPositionId[];
  /** Positions the human works; AI never transmits on these frequencies but hands aircraft to them. */
  playerPositions: ControllerPositionId[];
  onTransmission?: (t: AiTransmission) => void;
  /** Reaction delay range in sim seconds (default 2–6) so the AI sounds human. */
  reactionDelaySec?: [number, number];
  seed?: number;
}

export interface AiControllers {
  /** Call once per engine step (or at least every second of sim time). */
  update(state: SimulationState): void;
  positions(): ControllerPositionId[];
  /** Human-readable status per position for the UI (e.g. "TWR (AI): 2 aircraft, sequencing NKS451 to land"). */
  status(): Record<string, string>;
  dispose(): void;
}

export { createAiControllers } from './controllers';
