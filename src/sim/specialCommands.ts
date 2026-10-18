/**
 * Planners for the traffic-variety instructions and the dispatch wrappers that route helicopters to the helicopter versions of takeoff, landing and
 * hold position. Registered in commandExecutor.PLANNERS.
 */
import type { PlanResult, Env } from './commandExecutor';
import { unable } from './commandExecutor';
import { completeClearances } from './context';
import { findRunwayEnd } from './runways';
import { isRotorcraft, planHeliHold, planHeliLand, planHeliTakeoff } from './rotorcraft';
import type { HeliRuntime } from './rotorcraft';

/** OVERHEAD (JO 7110.65 3-10-12): "runway 13, pattern altitude one thousand five hundred, right turns, report initial" / "break at midfield, report break". */
export function planOverhead(env: Env): PlanResult {
  const { ac, rt, cmd, airport, ctx } = env;
  const oh = rt.special?.overhead;
  if (!oh) return unable(env, `${ac.callsign} is not flying an overhead maneuver.`, "we're not flying the overhead", false);
  const g = env.g ?? findRunwayEnd(airport, ac.assignedRunwayEnd);
  if (!g) return unable(env, 'No runway for the overhead maneuver.', "we don't have a runway", false);
  if (oh.stage === 'BROKE') return unable(env, `${ac.callsign} has already broken.`, "we've already broken", false);
  const isBreak = cmd.destination === 'BREAK';
  return {
    plan: {
      patch: { runwayEnd: g.end.id, runwayId: g.runway.id, altitudeFt: cmd.altitudeFt, turnDirection: cmd.turnDirection, destination: isBreak ? 'BREAK' : 'INITIAL' },
      commit: () => {
        ac.assignedRunwayEnd = g.end.id;
        oh.instructed = true;
        if (cmd.altitudeFt !== undefined) oh.altitudeFt = cmd.altitudeFt;
        if (cmd.turnDirection) oh.side = cmd.turnDirection;
        if (isBreak) oh.reportBreak = true;
        else oh.reportInitial = true;
        completeClearances(ctx, ac, ['OVERHEAD']);
      },
    },
  };
}

/** TAKEOFF: a helicopter without a runway lifts off from its present position (3-11-2), everything else is the runway takeoff. */
export function takeoffDispatch(env: Env, runwayPlan: (e: Env) => PlanResult): PlanResult {
  if (isRotorcraft(env.ac) && !env.g) return planHeliTakeoff(env);
  return runwayPlan(env);
}

/** LAND: a helicopter cleared to a named helipad (3-11-6) versus the runway landing. */
export function landDispatch(env: Env, runwayPlan: (e: Env) => PlanResult): PlanResult {
  if (isRotorcraft(env.ac) && (!env.g || env.cmd.destination?.match(/^USCG|HELIPAD|PAD/i))) return planHeliLand(env);
  return runwayPlan(env);
}

/** HOLD_POSITION: hover in the air for a helicopter. */
export function holdDispatch(env: Env, groundPlan: (e: Env) => PlanResult): PlanResult {
  if (isRotorcraft(env.ac) && !env.ac.onGround) return planHeliHold(env, () => groundPlan(env));
  return groundPlan(env);
}

/** AIR_TAXI / hover taxi (3-11-1): the taxi planner with the rotor lifted while the route is flown. */
export function airTaxiPlan(env: Env, taxiPlan: (e: Env) => PlanResult): PlanResult {
  const { ac, rt, cmd } = env;
  if (!isRotorcraft(ac)) return unable(env, `${ac.callsign} is not a helicopter; air taxi and hover taxi are helicopter instructions (JO 7110.65 3-11-1).`, "we're not a helicopter");
  const res = taxiPlan({ ...env, cmd: { ...cmd, kind: 'TAXI' } });
  if ('reject' in res) return res;
  const commit = res.plan.commit;
  return {
    plan: {
      ...res.plan,
      patch: { ...res.plan.patch, taxiMode: cmd.taxiMode ?? 'air' },
      commit: (clr) => {
        commit(clr);
        const h: HeliRuntime = rt.heli ?? (rt.heli = { mode: 'IDLE' });
        h.mode = 'IDLE';
        h.taxiMode = cmd.taxiMode ?? 'air';
        completeClearances(env.ctx, ac, ['AIR_TAXI']);
      },
    },
  };
}

