/**
 * Engine methods beyond `SimulationEngine` (api.ts is frozen): the engine object returned by `createEngine` has them all.
 *
 *   const out = (engine as SimulationEngine & SimulationEngineExtras).validateCommand?.(cmd, { position });
 *
 * `validateCommand` is a dry run of `applyCommand`: the same validation, safety gate and `CommandOutcome`, but nothing is executed,
 * logged, spoken or scored. A command that `applyCommand` would refuse in training (an unsafe clearance) comes back `rejected` with
 * `unsafe: true`; one that other modes would accept and flag comes back `accepted`. The clearance in an accepted outcome is a preview
 * (`id: 'dry-run'`), and a 5 s duplicate-command rejection is reported as it would be for the real call.
 */
import type { CommandOutcome, ControllerPositionId, ParsedCommand } from './types';
import type { SimulationEngine } from './api';

export interface SimulationEngineExtras {
  validateCommand?(cmd: ParsedCommand, opts?: { position?: ControllerPositionId; source?: 'voice' | 'typed' | 'ai'; transmissionId?: string; aiPosition?: ControllerPositionId }): CommandOutcome;
}

export type ExtendedEngine = SimulationEngine & SimulationEngineExtras;
