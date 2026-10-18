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
import type { CoordAnswer, CoordMessage, CoordRequest, InformInput, RequestInput, RespondOptions } from './coordination';
import type { BrakingReport, ClosureSource, ClosureSpec, CommandOutcome, ControllerPositionId, ParsedCommand } from './types';
import type { AddClosureResult } from './airportOps';
import type { SimulationEngine } from './api';

/**
 * The coordination channel (src/sim/coordination.ts). Every call logs a `COORDINATION` event and changes `state.coordination`; the same calls are
 * used by the player's Landline panel, the landline parser and the AI controllers.
 */
export interface CoordinationApi {
  request(input: RequestInput): CoordRequest | undefined;
  respond(requestId: string, answer: CoordAnswer, opts: RespondOptions): CoordRequest | undefined;
  rescind(requestId: string, opts: { by: ControllerPositionId; source: 'player' | 'ai' | 'system'; reason?: string }): CoordRequest | undefined;
  inform(input: InformInput): CoordMessage | undefined;
  /**
   * Who works what: `human` = positions a person works (one person working both positions of a pair coordinates with himself),
   * `ai` = positions an AI controller works. Positions in neither are unstaffed: no coordination is possible with them and none is required.
   * Without a call, every position of the scenario counts as staffed and the scenario's `playerPositions` (default: all) as human.
   */
  setStaffing(human: ControllerPositionId[], ai?: ControllerPositionId[]): void;
}

export interface SimulationEngineExtras {
  coordination?: CoordinationApi;
  /**
   * Airport operating state (src/sim/airportOps.ts). `addClosure` records a NOTAM-style runway / taxiway closure (refused for an unknown
   * ident and for the last open runway); `removeClosure` cancels it now; `setBirdActivity` puts bird activity (2-1-23) on the airport for
   * `durationSec` (ATIS text + advisory), `undefined` text clears it; `setRunwayLightStep` overrides the edge light intensity (3-4-11) of a runway
   * pair (`undefined` = back to the table default); `reportBrakingAction` files a pilot braking action report.
   */
  addClosure?(spec: ClosureSpec, source?: ClosureSource): AddClosureResult;
  removeClosure?(id: string): boolean;
  setBirdActivity?(text: string | undefined, durationSec?: number): void;
  setRunwayLightStep?(runwayId: string, step: number | undefined): void;
  reportBrakingAction?(report: Omit<BrakingReport, 'atSec'>): BrakingReport;
  validateCommand?(cmd: ParsedCommand, opts?: { position?: ControllerPositionId; source?: 'voice' | 'typed' | 'ai'; transmissionId?: string; aiPosition?: ControllerPositionId }): CommandOutcome;
}

export type ExtendedEngine = SimulationEngine & SimulationEngineExtras;
