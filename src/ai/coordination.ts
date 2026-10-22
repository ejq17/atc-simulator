/**
 * AI side of the coordination channel (src/sim/coordination.ts): what an AI position answers, rescinds and announces over the landline.
 *
 *  - TWR answers Ground's crossing requests with its own safety view (`runwayInUse` + the engine's `assessClearanceSafety`): "cross runway
 *    13 at Alpha"; or, when the one blocker is an arrival that is already cleared to land, "cross ..., behind the landing Spirit"; or
 *    "unable, traffic on a two mile final, I'll call you back" (stand-by; the answer comes when the runway is free). It rescinds an approval
 *    that was not used yet when an arrival comes inside the window ("hold short ... traffic on final"), and tells the release position
 *    "rolling" when an IFR departure starts and "going around" when an IFR arrival does.
 *  - DEP / APP answer release requests ("Spirit four fifty one released", or "hold for release" while a missed approach is in progress, or
 *    "stand by" while another departure was released less than `releaseSpacingSec` ago) and point-outs ("point out approved"), and make
 *    point-outs of their own: Departure points a departing aircraft out to Approach when it passes close to an arrival, Approach points a
 *    missed approach out to Departure when a departure is close.
 *
 * Asking is done by Ground (ground.ts, crossings) and Tower (tower.ts, releases) because they know when the aircraft is ready.
 * Reaction delays and the "one call at a time" rule are the controller's (controllers.ts).
 */
import type { Aircraft, ControllerPositionId } from '../sim/types';
import { assessClearanceSafety } from '../sim/conflicts';
import {
  COORDINATION_DESIGN, awaitingAnswer, isHuman, releaseNeeded, releasePosition, sameController,
} from '../sim/coordination';
import { checkExitRequest, predictedExit } from '../sim/flightDynamics';
import { spokenTaxiway } from '../radio/spoken';
import type { CoordRequest } from '../sim/coordination';
import { findRunwayEnd } from '../sim/runways';
import { bearingDeg, cardinal, dist, mToNm } from '../sim/geo';
import { numberWords } from '../radio/spoken';
import { hasActive, landingHoldShort, mkCmd } from './core';
import type { Agent, AgentView, Plan } from './core';
import { CROSSING_ARRIVAL_SEC, runwayInUse } from './ground';
import { gapPlanFor } from './gapActions';
import { assignedEnd, distToThresholdNm, etaToThresholdSec, interactingRunways, isInboundArrival } from './world';


/** The engine's own crossing rule keeps a crossing off a runway with an arrival inside this many nm on final (conflicts.ts FINAL_CROSSING_NM, with a margin). DESIGN VALUE. */
const CROSSING_FINAL_NM = 3.5;
/** A second arrival this soon (s) after the first leaves no gap behind it: Tower does not promise a crossing "behind the landing" aircraft. DESIGN VALUE. */
const FOLLOW_ON_WINDOW_SEC = 150;

const noText = { text: '', spoken: '' };

type Decision =
  | { answer: 'approve'; after?: Aircraft }
  | { answer: 'standby'; reason: string };

/** Why the runway is not free for a crossing, in Tower's words, and the arrival it would have to wait for (if it is the only blocker). */
export function crossingDecision(v: AgentView, rid: string, ac: Aircraft): Decision {
  const cmd = mkCmd('CROSS_RUNWAY', ac, { crossRunwayId: rid, runwayId: rid });
  if (!runwayInUse(v, rid, ac.id) && assessClearanceSafety(v.state, cmd).safe) return { answer: 'approve' };
  const rws = interactingRunways(v.airport, rid);
  for (const r of rws) {
    const occ = v.state.runwayOccupancy[r];
    if (!occ) continue;
    const dep = occ.departingId && occ.departingId !== ac.id ? v.state.aircraft[occ.departingId] : undefined;
    if (dep) return { answer: 'standby', reason: 'departure rolling' };
    const lined = occ.lineUpId && occ.lineUpId !== ac.id ? v.state.aircraft[occ.lineUpId] : undefined;
    if (lined) return { answer: 'standby', reason: 'aircraft in position' };
    if (occ.occupants.some((id) => id !== ac.id)) return { answer: 'standby', reason: 'aircraft on the runway' };
  }
  // Arrivals to this runway (or one that intersects it), nearest first: inside the crossing window (90 s, or the engine's 3 nm final rule).
  const arrivals: { a: Aircraft; eta: number; nm: number }[] = [];
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === ac.id || o.onGround || o.isDeparture || o.phase === 'GO_AROUND') continue;
    const g = assignedEnd(v.airport, o);
    if (!g || !rws.includes(g.runway.id)) continue;
    const eta = etaToThresholdSec(o, g);
    const nm = distToThresholdNm(o, g);
    const onFinal = o.phase === 'FINAL' || o.phase === 'LANDING' || hasActive(o, 'LAND') || (isInboundArrival(o) && nm <= 6.5);
    if (onFinal && eta <= 3 * FOLLOW_ON_WINDOW_SEC) arrivals.push({ a: o, eta, nm });
  }
  arrivals.sort((x, y) => x.eta - y.eta);
  const [best, next] = arrivals;
  if (best && (best.eta <= CROSSING_ARRIVAL_SEC || best.nm <= CROSSING_FINAL_NM)) {
    // One landing aircraft that is already cleared and nobody close behind it: cross behind it. Otherwise there is no usable gap yet.
    if (hasActive(best.a, 'LAND') && !(next && next.eta - best.eta <= FOLLOW_ON_WINDOW_SEC)) return { answer: 'approve', after: best.a };
    return { answer: 'standby', reason: `traffic on a ${numberWords(Math.min(9, Math.max(1, Math.round(best.nm))))} mile final` };
  }
  return { answer: 'standby', reason: 'traffic' };
}

/** "two miles west of Cedar Lake": the nearest named fix and the 8-point direction of the aircraft from it. */
export function describePositionFrom(v: AgentView, ac: Aircraft): string {
  let best: { name: string; d: number; pos: { x: number; y: number } } | undefined;
  for (const n of v.airport.navaids) {
    if (n.type === 'ILS' || n.type === 'LOC' || n.type === 'DME') continue;
    const d = dist(n.pos, ac.pos);
    if (!best || d < best.d) best = { name: n.name ?? n.id, d, pos: n.pos };
  }
  if (!best) return 'near the airport';
  const nm = Math.round(mToNm(best.d));
  if (nm < 1) return `over ${best.name}`;
  return `${numberWords(Math.min(nm, 99))} mile${nm === 1 ? '' : 's'} ${cardinal(bearingDeg(best.pos, ac.pos))} of ${best.name}`;
}

const roundAlt = (ft: number): number => Math.round(ft / 100) * 100;

function coordPlan(ac: Aircraft, key: string, priority: number, to: ControllerPositionId, summary: string, run: NonNullable<Plan['coord']>['run'], extra: Partial<Plan> = {}): Plan {
  return { key, aircraftId: ac.id, callsign: ac.callsign, priority, cmds: [], phrase: noText, summary, coord: { to, run }, ...extra };
}

export const coordinationAgent: Agent = (v) => {
  const plans: Plan[] = [];
  const { state } = v;
  const me = v.position;

  // ---- requests addressed to this position --------------------------------------------------------------------------------
  for (const r of awaitingAnswer(state, me)) {
    const ac = state.aircraft[r.aircraftId];
    if (!ac) continue;
    if (r.topic === 'CROSSING' && me === 'TWR' && r.runwayId) {
      const d = crossingDecision(v, r.runwayId, ac);
      if (d.answer === 'approve') {
        plans.push(coordPlan(ac, `co:${r.id}:approve`, 70, r.from, `${ac.callsign}: cross runway ${r.runwayId} approved${d.after ? ` behind ${d.after.callsign}` : ''}`,
          (api) => api.respond(r.id, 'approve', { by: me, source: 'ai', afterAircraftId: d.after?.id }) && lastMessage(v, r), { once: true }));
      } else if (r.status === 'pending') {
        plans.push(coordPlan(ac, `co:${r.id}:standby`, 66, r.from, `${ac.callsign}: crossing runway ${r.runwayId} unable, ${d.reason}`,
          (api) => api.respond(r.id, 'standby', { by: me, source: 'ai', reason: d.reason }) && lastMessage(v, r), { once: true }));
      }
    } else if (r.topic === 'RELEASE') {
      const verdict = releaseVerdict(v, r);
      if (verdict.answer === 'approve') {
        plans.push(coordPlan(ac, `co:${r.id}:release`, 70, r.from, `${ac.callsign} released`,
          (api) => api.respond(r.id, 'approve', { by: me, source: 'ai' }) && lastMessage(v, r), { once: true }));
      } else if (verdict.answer === 'deny') {
        plans.push(coordPlan(ac, `co:${r.id}:hfr`, 68, r.from, `${ac.callsign} hold for release (${verdict.reason})`,
          (api) => api.respond(r.id, 'deny', { by: me, source: 'ai', reason: verdict.reason }) && lastMessage(v, r), { once: true }));
      } else if (r.status === 'pending') {
        plans.push(coordPlan(ac, `co:${r.id}:rel-standby`, 64, r.from, `${ac.callsign} release stand by`,
          (api) => api.respond(r.id, 'standby', { by: me, source: 'ai' }) && lastMessage(v, r), { once: true }));
      }
    } else if (r.topic === 'EXIT' && me === 'TWR') {
      const verdict = exitVerdict(v, r, ac);
      if (verdict.answer === 'approve') {
        plans.push(coordPlan(ac, `co:${r.id}:exit-ok`, 71, r.from, `${ac.callsign}: exit request accepted`,
          (api) => api.respond(r.id, 'approve', { by: me, source: 'ai', exitTaxiway: verdict.taxiway, exitSide: verdict.side }) && lastMessage(v, r), { once: true }));
      } else if (verdict.answer === 'deny') {
        plans.push(coordPlan(ac, `co:${r.id}:exit-no`, 71, r.from, `${ac.callsign}: exit request unable, ${verdict.reason}`,
          (api) => api.respond(r.id, 'deny', { by: me, source: 'ai', reason: verdict.reason }) && lastMessage(v, r), { once: true }));
      } else if (r.status === 'pending') {
        plans.push(coordPlan(ac, `co:${r.id}:exit-sb`, 64, r.from, `${ac.callsign}: exit request, stand by`,
          (api) => api.respond(r.id, 'standby', { by: me, source: 'ai', reason: verdict.reason }) && lastMessage(v, r), { once: true }));
      }
    } else if (r.topic === 'GAP' && me === 'APP') {
      // 3-8-1 / 2-1-14: Approach says which arrival the gap follows and then builds it (approach.ts `gapPlans`), or that it cannot.
      const plan = gapPlanFor(v, ac, r.departures);
      if (!plan) {
        plans.push(coordPlan(ac, `co:${r.id}:gap-gone`, 64, r.from, `${ac.callsign}: gap request, departure no longer at the hold`,
          (api) => api.respond(r.id, 'deny', { by: me, source: 'ai', reason: 'departure is not at the hold' }) && lastMessage(v, r), { once: true }));
      } else if (plan.feasible) {
        plans.push(coordPlan(ac, `co:${r.id}:gap-ok`, 66, r.from, `${ac.callsign}: ${plan.after ? `gap after ${plan.after.callsign}` : 'gap available now'}`,
          (api) => api.respond(r.id, 'approve', { by: me, source: 'ai', afterAircraftId: plan.after?.id }) && lastMessage(v, r), { once: true }));
      } else {
        const why = plan.reason ?? 'no gap';
        plans.push(coordPlan(ac, `co:${r.id}:gap-no`, 64, r.from, `${ac.callsign}: gap request unable, ${why}`,
          (api) => api.respond(r.id, 'deny', { by: me, source: 'ai', reason: why }) && lastMessage(v, r), { once: true }));
      }
    } else if (r.topic === 'POINT_OUT') {
      plans.push(coordPlan(ac, `co:${r.id}:po-ok`, 62, r.from, `${ac.callsign} point out approved`,
        (api) => api.respond(r.id, 'approve', { by: me, source: 'ai' }) && lastMessage(v, r), { once: true }));
    }
  }

  // ---- Tower: rescind, announce -------------------------------------------------------------------------------------------
  if (me === 'TWR') {
    for (const r of state.coordination?.requests ?? []) {
      if (r.topic !== 'CROSSING' || r.status !== 'approved' || r.to !== 'TWR') continue;
      const ac = state.aircraft[r.aircraftId];
      if (!ac || !r.runwayId) continue;
      let reason: string | undefined;
      if (r.afterAircraftId) {
        const after = state.aircraft[r.afterAircraftId];
        if (after && !after.onGround && after.phase === 'GO_AROUND') reason = `${after.callsign} is going around`;
      } else if (runwayInUse(v, r.runwayId, ac.id)) reason = 'traffic on final';
      if (reason) {
        const why = reason;
        plans.push(coordPlan(ac, `co:${r.id}:rescind`, 95, r.from, `${ac.callsign}: crossing rescinded, ${why}`,
          (api) => api.rescind(r.id, { by: me, source: 'ai', reason: why }) && lastMessage(v, r), { once: true }));
      }
    }
    for (const ac of v.onFrequency) {
      // 3-1-4: Tower tells a Ground controller who is a person when the exit an arrival will have to take is a poor one for its parking (the far side
      // of the runway, a runway crossing on the way, or a taxiway with aircraft on it), while there is still time to ask for another (see `exitVerdict`).
      if (!ac.isDeparture && !ac.onGround && ac.phase === 'FINAL' && v.staffed.has('GND') && isHuman(state, 'GND') && !isHuman(state, 'TWR')) {
        const g = assignedEnd(v.airport, ac);
        const ex = g && distToThresholdNm(ac, g) <= EXIT_INFO_NM ? predictedExit(state, ac, g, undefined, landingHoldShort(ac)) : undefined;
        if (ex && (ex.wrongSide || ex.blockedBy || ex.crossings > 0)) {
          const twy = spokenTaxiway(ex.taxiway);
          const why = ex.blockedBy ? `${ex.blockedBy} is on that taxiway` : ex.wrongSide ? 'the far side of the runway from its parking' : 'a runway crossing to its parking';
          plans.push(coordPlan(ac, `${ac.id}:exit-info`, 57, 'GND', `${ac.callsign} exit information to Ground`,
            (api) => api.inform({ kind: 'TEXT', from: me, to: 'GND', aircraftId: ac.id, text: `${ac.spokenCallsign} will exit ${ex.side} at ${twy}, ${why}`, source: 'ai' }), { once: true }));
        }
      }
      const rel = releaseNeeded(state, 'TWR', ac);
      if (rel && ac.isDeparture && (ac.phase === 'CLEARED_FOR_TAKEOFF' || ac.phase === 'TAKEOFF_ROLL')) {
        const g = findRunwayEnd(v.airport, ac.assignedRunwayEnd);
        plans.push(coordPlan(ac, `${ac.id}:rolling`, 72, rel, `${ac.callsign} rolling`,
          (api) => api.inform({ kind: 'ROLLING', from: me, to: rel, aircraftId: ac.id, runwayId: g?.runway.id, source: 'ai' }), { once: true }));
      }
      const app = releasePosition(state) && isStaffedAndSeparate(v, 'APP') ? 'APP' : undefined;
      if (app && !ac.isDeparture && !ac.onGround && ac.phase === 'GO_AROUND' && ac.flightPlan?.flightRules === 'IFR') {
        plans.push(coordPlan(ac, `${ac.id}:ga-info:${Math.round(ac.lastGoAroundSec ?? 0)}`, 74, app, `${ac.callsign} going around`,
          (api) => api.inform({ kind: 'GOING_AROUND', from: me, to: app, aircraftId: ac.id, runwayId: findRunwayEnd(v.airport, ac.assignedRunwayEnd)?.runway.id, source: 'ai' }), { once: true }));
      }
    }
  }

  // ---- Departure / Approach: point-outs ----------------------------------------------------------------------------------
  if (me === 'DEP' || me === 'APP') plans.push(...pointOutPlans(v));
  return plans;
};

/** Tower tells Ground about a poor exit from this distance on final (nm): about two minutes for a jet, enough to ask for another. DESIGN VALUE. */
const EXIT_INFO_NM = 4;

type ExitVerdict = { answer: 'approve'; taxiway?: string; side?: 'left' | 'right' } | { answer: 'deny'; reason: string } | { answer: 'standby'; reason: string };

/**
 * Ground's request "have <callsign> exit <side> at <taxiway>" / "hold short of runway N after landing" (3-1-4): Tower gives it to the pilot when the
 * aircraft can fly it (the landing roll's own braking logic, `checkExitRequest`); otherwise "unable, <why>, will exit at <taxiway>". Before the aircraft is
 * on final the exit instruction cannot be given (the pilot takes it on final or on the roll): stand by.
 */
function exitVerdict(v: AgentView, r: CoordRequest, ac: Aircraft): ExitVerdict {
  const g = assignedEnd(v.airport, ac);
  if (!g || ac.isDeparture) return { answer: 'deny', reason: `${ac.spokenCallsign} is not landing` };
  if (ac.onGround && ac.phase !== 'ROLLOUT' && ac.phase !== 'LANDING') return { answer: 'deny', reason: 'already clear of the runway' };
  if (ac.phase !== 'FINAL' && ac.phase !== 'LANDING' && ac.phase !== 'ROLLOUT') return { answer: 'standby', reason: 'not on final yet' };
  const check = checkExitRequest(v.state, ac, g, { taxiway: r.point, side: r.exitSide }, r.holdShortRunwayId ?? landingHoldShort(ac));
  if (check.ok) return { answer: 'approve', taxiway: r.point ?? undefined, side: r.exitSide };
  const why = (check.reason ?? '').startsWith('no exit') ? 'no such exit ahead of the aircraft' : /too far|too fast|cannot slow/.test(check.reason ?? '') ? 'too fast for that exit' : check.reason ?? 'cannot';
  return { answer: 'deny', reason: `${why}${check.taxiway ? `, will exit at ${spokenTaxiway(check.taxiway)}` : ''}` };
}

function isStaffedAndSeparate(v: AgentView, other: ControllerPositionId): boolean {
  return v.staffed.has(other) && !sameController(v.state, v.position, other);
}

/** The newest message of a request, for the AI's spoken line. */
function lastMessage(v: AgentView, r: CoordRequest) {
  const msgs = v.state.coordination?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].requestId === r.id) return msgs[i];
  return undefined;
}

type Verdict = { answer: 'approve' } | { answer: 'deny'; reason: string } | { answer: 'standby' };

/** A release is granted unless a missed approach is in progress (hold for release) or another departure was released moments ago (stand by). */
function releaseVerdict(v: AgentView, r: CoordRequest): Verdict {
  const { state, now } = v;
  const missed = Object.values(state.aircraft).some((a) => !a.isDeparture && !a.onGround && a.phase === 'GO_AROUND' && a.flightPlan?.flightRules === 'IFR');
  if (missed) return { answer: 'deny', reason: 'missed approach in progress' };
  const recent = (state.coordination?.requests ?? []).some(
    (o) => o.topic === 'RELEASE' && o.id !== r.id && o.aircraftId !== r.aircraftId && !o.renewalOf && o.approvedSec !== undefined
      && now - o.approvedSec < COORDINATION_DESIGN.releaseSpacingSec && (o.status === 'approved' || o.status === 'used' || o.status === 'completed'),
  );
  return recent ? { answer: 'standby' } : { answer: 'approve' };
}

function pointOutPlans(v: AgentView): Plan[] {
  const plans: Plan[] = [];
  const { state, position: me } = v;
  const other: ControllerPositionId = me === 'DEP' ? 'APP' : 'DEP';
  if (!v.staffed.has(other) || sameController(state, me, other)) return plans;
  const near = (a: Aircraft, b: Aircraft) => dist(a.pos, b.pos) < COORDINATION_DESIGN.pointOutNm * 1852 && Math.abs(a.altitudeFt - b.altitudeFt) < 3000;
  for (const ac of v.onFrequency) {
    if (ac.onGround) continue;
    // Departure points out its departure to Approach; Approach points out a missed approach to Departure.
    const mine = me === 'DEP' ? ac.isDeparture && (ac.phase === 'INITIAL_CLIMB' || ac.phase === 'DEPARTURE') : !ac.isDeparture && ac.phase === 'GO_AROUND';
    if (!mine) continue;
    for (const o of Object.values(state.aircraft)) {
      if (o.id === ac.id || o.onGround) continue;
      const theirs = me === 'DEP' ? isInboundArrival(o) && o.phase !== 'PATTERN' : o.isDeparture && (o.phase === 'INITIAL_CLIMB' || o.phase === 'DEPARTURE');
      if (!theirs || !near(ac, o)) continue;
      const posText = describePositionFrom(v, ac);
      const alt = roundAlt(ac.altitudeFt);
      const climbing = ac.verticalSpeedFpm > 300 ? 'climbing' : ac.verticalSpeedFpm < -300 ? 'descending' : undefined;
      plans.push(coordPlan(ac, `${ac.id}:po:${o.id}`, 58, other, `${ac.callsign} point out to ${other}`,
        (api) => {
          const req = api.request({ topic: 'POINT_OUT', from: me, to: other, aircraftId: ac.id, positionText: posText, altitudeFt: alt, extra: climbing, source: 'ai' });
          return req ? lastMessage(v, req) : undefined;
        }, { once: true }));
      break;
    }
  }
  return plans;
}

