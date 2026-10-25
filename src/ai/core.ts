/**
 * Shared types and small helpers of the AI controllers. An *agent* is a pure function of an `AgentView`
 * (read-only simulation state + per-position memory) that returns the transmissions it could make right now;
 * `controllers.ts` picks the best one, applies the human reaction delay and performs it through `engine.applyCommand`.
 */
import type {
  Aircraft, Airport, ClearanceKind, CommandKind, ControllerPositionId, ParsedCommand, RadioFrequency, SimulationState,
} from '../sim/types';
import type { Phrase } from './phrase';
import type { CoordMessage } from '../sim/coordination';
import type { CoordinationApi } from '../sim/engineExtras';
import { hearsFrequency } from '../radio/frequencies';

export interface Plan {
  /** Identity of the intended action (`<aircraft id>:<what>`); the controller re-checks it after the reaction delay. */
  key: string;
  aircraftId: string;
  callsign: string;
  /** Higher first. 100 = safety (go-around), 80 landing / takeoff, 50 normal handoffs and clearances. */
  priority: number;
  /** Commands issued under ONE transmission (one ATC event); each gets the full phrase as rawText. */
  cmds: ParsedCommand[];
  phrase: Phrase;
  /** Never repeated for this aircraft once accepted; otherwise suppressed for `cooldownSec` (default 15). */
  once?: boolean;
  cooldownSec?: number;
  /** Short status line, e.g. "NKS451 cleared for takeoff runway 13". */
  summary: string;
  /**
   * A landline call to another position instead of a radio transmission (`cmds` is then empty and `phrase` unused): `run` makes the
   * coordination call and returns the message it logged, which is what the AI "says" (AiTransmission.channel 'landline').
   */
  coord?: { to: ControllerPositionId; run(api: CoordinationApi): CoordMessage | undefined };
}

/** Per-agent bookkeeping that survives between evaluations. */
export interface AgentMemory {
  /** Keys of `once` plans that were accepted. */
  done: Set<string>;
  /** key -> sim time of the last accepted transmission (cooldown). */
  recent: Map<string, number>;
  /** key -> do not try before this sim time (after a rejection). */
  backoff: Map<string, number>;
  /** key -> consecutive rejections. */
  rejects: Map<string, number>;
  /** aircraft id -> sim time at which it was first seen on this position's frequency. */
  firstSeen: Map<string, number>;
  /** Free-form per-agent notes (e.g. when a speed restriction was issued). */
  notes: Map<string, number>;
  /** `aircraft id:command kind` -> the command as this position sent it (the clearance recorded in the aircraft is what the pilot flew, which after a misread runway is the wrong one). */
  sent: Map<string, ParsedCommand>;
  lastTxAt: number;
  lastSummary?: string;
  lastSummaryAt: number;
}

export function newMemory(): AgentMemory {
  return {
    done: new Set(), recent: new Map(), backoff: new Map(), rejects: new Map(), firstSeen: new Map(), notes: new Map(), sent: new Map(),
    lastTxAt: -Infinity, lastSummaryAt: -Infinity,
  };
}

export interface AgentView {
  state: SimulationState;
  airport: Airport;
  now: number;
  position: ControllerPositionId;
  /** Positions that exist in the scenario (AI + human). */
  staffed: ReadonlySet<ControllerPositionId>;
  /** Positions the AI works. */
  aiPositions: ReadonlySet<ControllerPositionId>;
  mem: AgentMemory;
  /** Aircraft currently tuned to one of this position's frequencies, in state order. */
  onFrequency: Aircraft[];
  /** Seconds the aircraft has been on this position's frequency. */
  settled(ac: Aircraft): number;
  /** Frequencies of a position. */
  freqs(position: ControllerPositionId): RadioFrequency[];
  /** "Atlantic City Approach" for the frequency the aircraft is tuned to. */
  facility(ac: Aircraft): string;
}

export type Agent = (v: AgentView) => Plan[];

export function mkCmd(kind: CommandKind, ac: Aircraft, f: Partial<ParsedCommand> = {}): ParsedCommand {
  return { kind, callsign: ac.callsign, confidence: 1, rawText: '', normalizedText: '', issues: [], ...f };
}

export function freqsOf(airport: Airport, position: ControllerPositionId): RadioFrequency[] {
  return airport.frequencies.filter((f) => f.position === position);
}

export function onPosition(airport: Airport, ac: Aircraft, position: ControllerPositionId): boolean {
  return airport.frequencies.some((f) => f.position === position && hearsFrequency(ac, f.mhz));
}

/** A clearance of this kind was issued and has not been completed or cancelled. */
export function hasActive(ac: Aircraft, kind: ClearanceKind): boolean {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind === kind) return c.completedAtSec === undefined;
  }
  return false;
}

export function lastClearance(ac: Aircraft, kind: ClearanceKind) {
  for (let i = ac.clearances.length - 1; i >= 0; i--) if (ac.clearances[i].kind === kind) return ac.clearances[i];
  return undefined;
}

/** Plans the controller may not attempt right now (cooldown, back-off, already done). */
export function blocked(mem: AgentMemory, p: Plan, now: number): boolean {
  if (p.once && mem.done.has(p.key)) return true;
  const until = mem.backoff.get(p.key);
  if (until !== undefined && now < until) return true;
  const last = mem.recent.get(p.key);
  if (last !== undefined && now - last < (p.cooldownSec ?? 15)) return true;
  return false;
}

export function pickBest(plans: Plan[]): Plan | undefined {
  let best: Plan | undefined;
  for (const p of plans) if (!best || p.priority > best.priority) best = p; // stable: first of equal priority wins (state order)
  return best;
}

/** The intersecting runway the aircraft was told to hold short of on landing ("cleared to land, hold short of runway 13", a later "hold short of runway 13"), if any. */
export function landingHoldShort(ac: Aircraft): string | undefined {
  const land = lastClearance(ac, 'LAND');
  const hold = lastClearance(ac, 'HOLD_SHORT');
  const c = hold && (!land || hold.issuedAtSec >= land.issuedAtSec) ? hold : land;
  return c && c.completedAtSec === undefined ? c.holdShort?.[0] : undefined;
}
