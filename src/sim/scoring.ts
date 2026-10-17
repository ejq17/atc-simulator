/**
 * Scoring. The ScoreCard counters are maintained from SimEvents; `score` is a pure function of them.
 *
 *   score = clamp(0, 100,
 *             100
 *             - 25 * runwayIncursions
 *             - 15 * unsafeInstructions
 *             - 10 * separationViolations
 *             -  5 * missedReadbackErrors
 *             -  2 * communicationErrors
 *             +  2 * correctClearances
 *             +  5 * aircraftHandled )
 *
 * Because bonuses are added before clamping, a long clean session can offset small mistakes but
 * a runway incursion (-25) always outweighs a handful of correct clearances (safety weighted).
 *
 * Counter sources:
 *   RUNWAY_INCURSION event                         -> runwayIncursions
 *   SEPARATION_VIOLATION event                     -> separationViolations
 *   CONFLICT event with data.alertKind = UNSAFE_CLEARANCE -> unsafeInstructions (also when prevented in training)
 *   READBACK_ERROR event with data.missed          -> missedReadbackErrors
 *   COMMAND_REJECTED / CLARIFICATION with data.commError -> communicationErrors
 *   COMMAND_ACCEPTED with data.scored              -> correctClearances (+ request wait statistics)
 *   DESPAWN with data.handled                      -> aircraftHandled
 *
 * Wait statistics: every accepted clearance that answers a pilot request records the request age;
 * averageWaitSec is the mean, totalDelaySec sums the part of each wait above 60 s ("unnecessary delay").
 */
import type { ScoreCard, SimEvent } from './types';
import type { SimContext } from './context';
import { emitEvent } from './context';

export const SCORE_WEIGHTS = {
  runwayIncursion: -25,
  unsafeInstruction: -15,
  separationViolation: -10,
  missedReadbackError: -5,
  communicationError: -2,
  correctClearance: 2,
  aircraftHandled: 5,
} as const;

export const ACCEPTABLE_WAIT_SEC = 60;

export function newScoreCard(): ScoreCard {
  return {
    aircraftHandled: 0,
    correctClearances: 0,
    communicationErrors: 0,
    runwayIncursions: 0,
    separationViolations: 0,
    unsafeInstructions: 0,
    missedReadbackErrors: 0,
    averageWaitSec: 0,
    totalDelaySec: 0,
    scenarioCompleted: false,
    score: 100,
  };
}

export function computeScore(card: ScoreCard): number {
  const w = SCORE_WEIGHTS;
  const raw =
    100 +
    w.runwayIncursion * card.runwayIncursions +
    w.unsafeInstruction * card.unsafeInstructions +
    w.separationViolation * card.separationViolations +
    w.missedReadbackError * card.missedReadbackErrors +
    w.communicationError * card.communicationErrors +
    w.correctClearance * card.correctClearances +
    w.aircraftHandled * card.aircraftHandled;
  return Math.max(0, Math.min(100, raw));
}

export function applyEventToScore(ctx: SimContext, ev: SimEvent): void {
  const s = ctx.state.score;
  const d = ev.data ?? {};
  switch (ev.kind) {
    case 'RUNWAY_INCURSION':
      s.runwayIncursions++;
      break;
    case 'SEPARATION_VIOLATION':
      s.separationViolations++;
      break;
    case 'CONFLICT':
      if (d.alertKind === 'UNSAFE_CLEARANCE') s.unsafeInstructions++;
      break;
    case 'READBACK_ERROR':
      if (d.missed) s.missedReadbackErrors++;
      break;
    case 'COMMAND_REJECTED':
    case 'CLARIFICATION':
      if (d.commError) s.communicationErrors++;
      break;
    case 'COMMAND_ACCEPTED':
      if (d.scored) s.correctClearances++;
      if (typeof d.waitSec === 'number') {
        const ws = ctx.waitStats;
        ws.count++;
        ws.totalSec += d.waitSec;
        ws.delaySec += Math.max(0, d.waitSec - ACCEPTABLE_WAIT_SEC);
        s.averageWaitSec = ws.totalSec / ws.count;
        s.totalDelaySec = ws.delaySec;
      }
      break;
    case 'DESPAWN':
      if (d.handled) s.aircraftHandled++;
      break;
    default:
      break;
  }
}

/** Per-tick: consume queued events, update counters, check scenario completion. */
export function updateScoring(ctx: SimContext): void {
  const q = ctx.scoreQueue;
  ctx.scoreQueue = [];
  for (const ev of q) applyEventToScore(ctx, ev);
  const s = ctx.state.score;
  s.score = computeScore(s);
  const sc = ctx.state.scenario;
  if (!s.scenarioCompleted) {
    const timeUp = sc.durationSec !== undefined && ctx.state.clock.timeSec >= sc.durationSec;
    const allSpawned = ctx.spawnedIdx.size >= sc.spawns.length && !sc.traffic?.enabled;
    const empty = Object.keys(ctx.state.aircraft).length === 0;
    if (timeUp || (allSpawned && empty && sc.spawns.length > 0)) {
      s.scenarioCompleted = true;
      emitEvent(ctx, { kind: 'SCENARIO', severity: 'info', speaker: 'SYSTEM', text: timeUp ? 'Scenario time elapsed' : 'All traffic handled', data: { completed: true } });
    }
  }
}
