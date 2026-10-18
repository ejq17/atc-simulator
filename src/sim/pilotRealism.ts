/**
 * Pilot-realism decisions the command executor asks for (seeded, deterministic): which readback error, whether the pilot
 * missed the call, asks "say again", gives no readback, or an aircraft with a similar callsign answers instead.
 * All draws are derived from the aircraft seed (`seeded01(ac.seed, label)`) and never touch the engine's shared random stream, so
 * enabling realism does not shift anything else and the same seed replays the same event log. Rates: pilotBehaviour.ts.
 */
import type { Aircraft, ClearanceKind, ParsedCommand } from './types';
import type { SimContext, AircraftRuntime } from './context';
import { seeded01 } from './rng';
import type { ReadbackRealism } from '../radio/readback';
import { similarSounding } from '../radio/callsigns';
import { hearsFrequency } from '../radio/frequencies';

/** Safety-of-flight instructions a pilot never misses or answers late. */
const ALWAYS_HEARD = new Set<string>(['GO_AROUND', 'CANCEL_TAKEOFF', 'HOLD_POSITION', 'HOLD_SHORT', 'MISSED_APPROACH']);

export function realismActive(ctx: SimContext): boolean {
  return ctx.pilotBehaviour.realism.level !== 'off';
}

/** Rates of the readback errors for one clearance, with a seeded draw per label. Undefined at level off. */
export function readbackRealism(ctx: SimContext, ac: Aircraft, clearanceId: string): ReadbackRealism | undefined {
  const R = ctx.pilotBehaviour.realism;
  if (R.level === 'off') return undefined;
  return {
    rand: (label) => seeded01(ac.seed, `rb:${clearanceId}:${label}`),
    altitude: R.altitudeErrorRate,
    frequency: R.frequencyErrorRate,
    squawk: R.squawkErrorRate,
    pattern: R.patternMisunderstandRate * (ac.student ? R.studentPatternFactor : 1),
  };
}

function draw(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, label: string): number {
  return seeded01(ac.seed, `${label}:${ctx.state.clock.tick}:${rt.callSeq++}`);
}

/** The pilot did not hear the call (delayed response): nothing is said or done until the controller calls again. */
export function missesCall(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, cmd: ParsedCommand): boolean {
  const R = ctx.pilotBehaviour.realism;
  if (R.delayedResponseRate <= 0 || ALWAYS_HEARD.has(cmd.kind) || rt.unanswered) return false;
  return draw(ctx, ac, rt, 'miss') < R.delayedResponseRate * (ac.student ? 1.5 : 1);
}

/** Long transmission: more than `sayAgainMinCommands` instructions draw "say again" (students more often). */
export function asksSayAgain(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, cmd: ParsedCommand): boolean {
  const R = ctx.pilotBehaviour.realism;
  if (R.sayAgainRate <= 0 || (cmd.groupSize ?? 1) <= R.sayAgainMinCommands) return false;
  return draw(ctx, ac, rt, 'sayagain') < Math.min(1, R.sayAgainRate * (ac.student ? R.studentSayAgainFactor : 1));
}

/** The pilot complies but does not read back at all. */
export function givesNoReadback(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, kind: ClearanceKind): boolean {
  const R = ctx.pilotBehaviour.realism;
  if (R.noReadbackRate <= 0 || kind === 'RADAR_CONTACT') return false;
  return draw(ctx, ac, rt, 'noreadback') < R.noReadbackRate;
}

/** An aircraft with a similar callsign on the controller's frequency that answers the call meant for `ac` (JO 7110.65 2-4-20; AIM 4-2-4). */
export function wrongCallsignAnswerer(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, ctrlMhz: number): Aircraft | undefined {
  const R = ctx.pilotBehaviour.realism;
  if (R.wrongCallsignRate <= 0) return undefined;
  const others = Object.values(ctx.state.aircraft)
    .filter((o) => o.id !== ac.id && hearsFrequency(o, ctrlMhz) && similarSounding(ac.callsign, o.callsign))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!others.length) return undefined;
  if (draw(ctx, ac, rt, 'wrongcs') >= R.wrongCallsignRate) return undefined;
  return others[Math.min(others.length - 1, Math.floor(seeded01(ac.seed, `wrongcs-pick:${ctx.state.clock.tick}`) * others.length))];
}
