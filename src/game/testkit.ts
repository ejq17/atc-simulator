/** Test helpers: drive a real engine with typed transmissions through the real parser. Not imported by production code. */
import { parseTransmission } from '../commands';
import type { ParseContext } from '../commands';
import type { SimulationEngine } from '../sim/api';
import type { CommandOutcome, ControllerPositionId, ParsedCommand, SimulationState } from '../sim/types';

export function parseContext(state: SimulationState): ParseContext {
  const taxiways = new Set<string>();
  for (const n of Object.values(state.airport.taxiwayGraph.nodes)) for (const t of n.taxiways) taxiways.add(t);
  return {
    aircraft: Object.values(state.aircraft).map((a) => ({ callsign: a.callsign, spokenCallsign: a.spokenCallsign, type: a.type })),
    taxiways: [...taxiways],
    runwayEnds: state.airport.runways.flatMap((r) => r.ends.map((e) => e.id)),
    frequencies: state.airport.frequencies.map((f) => ({ id: f.id, mhz: f.mhz })),
  };
}

export interface Said {
  commands: ParsedCommand[];
  outcomes: CommandOutcome[];
}

/** Parse `text` and apply every command through the engine as the given controller position. */
export function say(engine: SimulationEngine, text: string, position?: ControllerPositionId): Said {
  const state = engine.getState();
  if (position && state.controllerPosition !== position) engine.setControllerPosition(position);
  const parsed = parseTransmission(text, parseContext(state));
  const outcomes = parsed.commands.map((c) => engine.applyCommand(c, { position, source: 'typed' }));
  return { commands: parsed.commands, outcomes };
}

export function run(engine: SimulationEngine, seconds: number): void {
  const steps = Math.round(seconds / engine.getState().clock.dtSec);
  for (let i = 0; i < steps; i++) engine.step();
}

/** Step until `pred` holds (or `maxSec` passes). Returns whether it held. */
export function runUntil(engine: SimulationEngine, pred: (s: SimulationState) => boolean, maxSec: number): boolean {
  const steps = Math.round(maxSec / engine.getState().clock.dtSec);
  for (let i = 0; i < steps; i++) {
    if (pred(engine.getState())) return true;
    engine.step();
  }
  return pred(engine.getState());
}

export const accepted = (s: Said): boolean => s.outcomes.length > 0 && s.outcomes.every((o) => o.status === 'accepted');
