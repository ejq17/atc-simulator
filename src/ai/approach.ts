/**
 * Approach and Departure control.
 *
 * Approach: radar contact + descent to the lowest MVA-safe altitude at or above the procedure's initial-fix altitude, direct to the
 * procedure's first fix when the aircraft is not on a route that joins it, the approach clearance when the engine's own
 * `assessApproach` finds the clearance proper and the spacing to the aircraft ahead is at least 5 nm (speed, then a published
 * hold when the gap is small), and the handoff to Tower once the aircraft is established. A missed approach that comes back to
 * Approach is climbed, sent direct to the procedure's first fix and cleared again.
 *
 * Departure: radar contact, climb to the filed cruise altitude and direct to the first fix of the route.
 */
import type { Aircraft, ApproachType } from '../sim/types';
import { assessClearanceSafety } from '../sim/conflicts';
import { findRunwayEnd } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { analyzeProcedure, assessApproach, matchingProcedures, visualApproachAllowed } from '../sim/approach';
import type { ProcedureInfo } from '../sim/approach';
import { distanceToFixNm, findNavFix } from '../sim/navigation';
import { getPerformance } from '../sim/performance';
import { frequencyForPosition } from '../radio/frequencies';
import { hasActive, mkCmd } from './core';
import type { Agent, AgentView, Plan } from './core';
import { distToThresholdNm, inboundSpeedKt, isInboundArrival, projectedGapNm } from './world';
import { ARRIVAL_RUNWAY_GAP_SEC } from './tower';
import * as say from './phrase';

/** Spacing the AI builds between arrivals on the same final (the engine's own minimum is 3 nm, 4 nm for a light behind a jet). */
export const ARRIVAL_SPACING_NM = 5;
const SLOW_SPEED_KT = 140;
const SLOW_FROM_NM = 5;
/** Speed assignments tried in order ("reduce speed to one six zero", "... one four zero") to build the spacing before the approach clearance. */
const SLOW_STEPS_KT = [160, SLOW_SPEED_KT];
/** The projected in-trail gap never drops below the radar minimum (JO 7110.65 5-5-4: 3 nm). */
const MIN_PROJECTED_GAP_NM = 3;
/** Speed alone cannot build the gap and the projected gap is short by more than this (nm): hold at the published fix instead of flying on. */
const HOLD_SHORTFALL_NM = 1.5;

/**
 * Spacing needed at the leader's threshold crossing: the clearance spacing (5 nm) or the runway occupancy gap
 * (`ARRIVAL_RUNWAY_GAP_SEC` at the follower's approach speed, 7110.65 3-10-3 same runway separation), whichever is larger.
 */
export function requiredGapNm(ac: Aircraft): number {
  return Math.max(ARRIVAL_SPACING_NM, (getPerformance(ac.type).approachSpeedKt * ARRIVAL_RUNWAY_GAP_SEC) / 3600);
}

interface ApproachChoice {
  type: ApproachType;
  end: RunwayEndGeom;
  /** `assessApproach` finds the clearance proper right now. */
  ok: boolean;
  info?: ProcedureInfo;
}

function landingEnd(v: AgentView, ac: Aircraft): RunwayEndGeom | undefined {
  const landing = v.state.activeRunways.landing;
  const id = ac.assignedRunwayEnd && landing.includes(ac.assignedRunwayEnd) ? ac.assignedRunwayEnd : (landing[0] ?? ac.assignedRunwayEnd);
  return findRunwayEnd(v.airport, id);
}

/** ILS first, then RNAV, then VOR (what is published for the end), a visual approach only when nothing else is published. */
function chooseApproach(v: AgentView, ac: Aircraft): ApproachChoice | undefined {
  const g = landingEnd(v, ac);
  if (!g) return undefined;
  let intended: ApproachChoice | undefined;
  for (const type of ['ILS', 'RNAV', 'VOR'] as const) {
    const procs = matchingProcedures(v.airport, type, g.end.id);
    if (!procs.length) continue;
    const a = assessApproach(v.state, ac, type, g);
    const infos = procs.map((p) => analyzeProcedure(v.airport, p, g));
    const byPlan = a.kind === 'ok' ? infos.find((i) => i.procedure.id === a.plan.procedureId) : undefined;
    const best = byPlan ?? [...infos].sort((x, y) => y.onCourse.length - x.onCourse.length)[0];
    if (a.kind === 'ok' && !a.geometry) return { type, end: g, ok: true, info: best };
    intended = intended ?? { type, end: g, ok: false, info: best };
  }
  if (intended) return intended;
  if (visualApproachAllowed(v.state.weather).ok) return { type: 'VISUAL', end: g, ok: assessApproach(v.state, ac, 'VISUAL', g).kind === 'ok' };
  return undefined;
}

/** Altitude at the initial fix of the straight-in segment from the plate (minimum, else mandatory), default 3000. */
function initialFixAltitude(info: ProcedureInfo | undefined): number {
  const ifFix = info?.onCourse[0]?.id.toUpperCase();
  const fa = info?.procedure.fixAltitudes?.find((f) => f.fix.toUpperCase() === ifFix);
  return fa?.minAltitudeFt ?? fa?.mandatoryAltitudeFt ?? 3000;
}

/** Lowest altitude >= the initial-fix altitude that the engine's MVA check accepts for this aircraft (never above where it is now). */
function descentAltitude(v: AgentView, ac: Aircraft, info: ProcedureInfo | undefined): number | undefined {
  const base = Math.ceil(initialFixAltitude(info) / 100) * 100;
  const current = ac.target.altitudeFt ?? ac.altitudeFt;
  const fa = info?.procedure.fixAltitudes?.find((f) => f.fix.toUpperCase() === info.onCourse[0]?.id.toUpperCase());
  const ceiling = fa?.maxAltitudeFt ?? Infinity;
  for (let alt = base; alt < current - 49 && alt <= ceiling; alt += 100) {
    if (assessClearanceSafety(v.state, mkCmd('ALTITUDE', ac, { altitudeFt: alt })).safe) return alt;
  }
  return undefined;
}

/** The fix the AI sends an aircraft to when it is not on a route that joins the procedure: the nearest IAF/IF ahead of the FAF. */
function joinFix(v: AgentView, ac: Aircraft, info: ProcedureInfo): string | undefined {
  const ids = [...info.feeders, ...info.onCourse.map((f) => f.id)];
  const usable = ids.length > 1 ? ids.slice(0, -1) : ids; // not the FAF itself
  let best: string | undefined;
  let bestD = Infinity;
  for (const id of usable) {
    const d = distanceToFixNm(v.airport, ac.pos, id);
    if (d !== undefined && d < bestD) {
      best = id;
      bestD = d;
    }
  }
  return best;
}

/** The nearest arrival ahead of `ac` for the same runway (closer to the threshold), if any. */
function leaderOf(v: AgentView, ac: Aircraft, g: RunwayEndGeom): { leader: Aircraft; gapNm: number } | undefined {
  const mine = distToThresholdNm(ac, g);
  let best: { leader: Aircraft; gapNm: number } | undefined;
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === ac.id || !isInboundArrival(o) || o.assignedRunwayEnd !== g.end.id) continue;
    const gap = mine - distToThresholdNm(o, g);
    if (gap > 0 && (!best || gap < best.gapNm)) best = { leader: o, gapNm: gap };
  }
  return best;
}

export function createApproachAgent(handleDepartures: (v: AgentView) => boolean): Agent {
  const departures = createDepartureAgent();
  return (v) => {
    const plans: Plan[] = [];
    const { airport, mem } = v;
    for (const ac of v.onFrequency) {
      if (ac.radioState === 'TRANSMITTING' || ac.onGround) continue;
      if (ac.isDeparture) continue;
      const pending = ac.pendingRequest?.kind;
      const ready = pending !== undefined || v.settled(ac) >= 4;
      if (!ready) continue;
      const phase = ac.phase;
      const facility = v.facility(ac);

      // Established: Tower.
      if (phase === 'FINAL' && v.staffed.has('TWR') && v.position !== 'TWR') {
        const twr = frequencyForPosition(airport, 'TWR');
        if (twr) {
          plans.push({
            key: `${ac.id}:to-twr`, aircraftId: ac.id, callsign: ac.callsign, priority: 60,
            cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: twr.id })],
            phrase: say.contact(ac, airport, twr.id, twr.mhz), cooldownSec: 30, summary: `${ac.callsign} handed to Tower`,
          });
        }
        continue;
      }
      if (!['INBOUND', 'APPROACH', 'GO_AROUND', 'HOLDING'].includes(phase) || phase === 'LANDING') continue;

      const choice = chooseApproach(v, ac);
      if (!choice) continue;
      const alt = descentAltitude(v, ac, choice.info);

      // Radar contact (with the descent, as one transmission).
      if (!ac.radarIdentified) {
        const cmds = [mkCmd('RADAR_CONTACT', ac)];
        let phrase = say.radarContact(ac, facility);
        if (alt !== undefined) {
          cmds.push(mkCmd('ALTITUDE', ac, { altitudeFt: alt }));
          phrase = say.clauses(phrase, say.descendMaintain(alt, ac.altitudeFt));
        }
        plans.push({
          key: `${ac.id}:radar`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, once: true, cmds, phrase,
          summary: `${ac.callsign} radar contact${alt !== undefined ? `, descend ${alt}` : ''}`,
        });
        continue;
      }

      // Descent (aircraft that came back from a missed approach, or radar contact without a descent because of the MVA).
      if (alt !== undefined && (ac.target.altitudeFt ?? ac.altitudeFt) > alt + 50) {
        plans.push({
          key: `${ac.id}:alt:${alt}`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, cooldownSec: 60,
          cmds: [mkCmd('ALTITUDE', ac, { altitudeFt: alt })], phrase: say.clauses(say.callsign(ac), say.descendMaintain(alt, ac.altitudeFt)),
          summary: `${ac.callsign} descend ${alt}`,
        });
        continue;
      }

      if (hasActive(ac, 'APPROACH')) continue; // cleared: nothing to add until it is established

      // Not on a route that joins the procedure: direct to its first fix.
      if (!choice.ok && choice.info && choice.type !== 'VISUAL') {
        const fix = joinFix(v, ac, choice.info);
        const alreadyThere = ac.nav?.mode === 'direct' && ac.nav.fixes[ac.nav.index] === fix;
        if (fix && !alreadyThere) {
          plans.push({
            key: `${ac.id}:join:${fix}`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, cooldownSec: 30,
            cmds: [mkCmd('DIRECT_FIX', ac, { fix })], phrase: say.clauses(say.callsign(ac), say.direct(airport, fix)),
            summary: `${ac.callsign} direct ${fix}`,
          });
        }
        continue;
      }
      if (!choice.ok) continue;

      // Spacing against the aircraft ahead, then the approach clearance.
      const lead = leaderOf(v, ac, choice.end);
      const need = requiredGapNm(ac);
      const proj = lead ? projectedGapNm(ac, lead.leader, choice.end) : undefined;
      const gapOk = !lead || (lead.gapNm >= ARRIVAL_SPACING_NM && proj!.atLeaderThresholdNm >= need && proj!.minNm >= MIN_PROJECTED_GAP_NM);
      const clearance = mkCmd('APPROACH', ac, { approachType: choice.type, runwayEnd: choice.end.end.id, runwayId: choice.end.runway.id });
      if (gapOk && assessClearanceSafety(v.state, clearance).safe) {
        plans.push({
          key: `${ac.id}:approach`, aircraftId: ac.id, callsign: ac.callsign, priority: 55, cooldownSec: 20, cmds: [clearance],
          phrase: say.clauses(say.callsign(ac), say.clearedApproach(choice.type, choice.end.end.id)),
          summary: `${ac.callsign} cleared ${choice.type} runway ${choice.end.end.id}`,
        });
        continue;
      }
      if (!lead) continue;

      // Too close to the aircraft ahead: hold at the published fix when it is still ahead and the gap is small, else slow down.
      const dNm = distToThresholdNm(ac, choice.end);
      const holdIssued = [...mem.done].some((k) => k.startsWith(`${ac.id}:hold:`));
      if (holdIssued || phase === 'HOLDING') continue; // released by the approach clearance once the gap is there
      // Speed first (the follower is faster than the leader almost always): the gentlest assignment whose projected gap at the leader's
      // threshold crossing meets the requirement, else the lowest one; when speed cannot build the gap, the published hold.
      const cur = inboundSpeedKt(ac);
      const steps = SLOW_STEPS_KT.map((kt) => Math.max(kt, getPerformance(ac.type).minSpeedKt + 20)).filter((kt, i, a) => kt < cur - 10 && a.indexOf(kt) === i);
      const fixing = steps.find((kt) => projectedGapNm(ac, lead.leader, choice.end, kt).atLeaderThresholdNm >= need);
      const speedKt = fixing ?? steps[steps.length - 1];
      const slowAvailable = dNm > SLOW_FROM_NM && speedKt !== undefined && !mem.done.has(`${ac.id}:slow:${speedKt}`);
      const speedsExhausted = fixing === undefined;
      const tryHold = lead.gapNm < ARRIVAL_SPACING_NM - 1.5 || (speedsExhausted && !slowAvailable && proj!.atLeaderThresholdNm < need - HOLD_SHORTFALL_NM);
      if (tryHold && choice.info && ac.nav) {
        const remaining = ac.nav.fixes.slice(ac.nav.index);
        const hold = choice.info.procedure.holdingPatterns?.find(
          (h) => h.role === 'hold_in_lieu' && remaining.some((f) => (findNavFix(airport, f)?.id ?? f).toUpperCase() === h.fix.toUpperCase()) && (distanceToFixNm(airport, ac.pos, h.fix) ?? 0) > 2,
        );
        if (hold) {
          plans.push({
            key: `${ac.id}:hold:${hold.fix}`, aircraftId: ac.id, callsign: ac.callsign, priority: 45, once: true,
            cmds: [mkCmd('HOLD_AT_FIX', ac, { hold: { fix: hold.fix, asPublished: true, turns: hold.turns } })],
            phrase: say.clauses(say.callsign(ac), say.holdAsPublished(airport, hold.fix)),
            summary: `${ac.callsign} hold at ${hold.fix} as published, ${lead.gapNm.toFixed(1)} nm behind ${lead.leader.callsign} (${proj!.atLeaderThresholdNm.toFixed(1)} nm projected at its threshold)`,
          });
          continue;
        }
      }
      if (slowAvailable) {
        const kt = speedKt!;
        plans.push({
          key: `${ac.id}:slow:${kt}`, aircraftId: ac.id, callsign: ac.callsign, priority: 45, once: true,
          cmds: [mkCmd('SPEED', ac, { speedKt: kt })], phrase: say.clauses(say.callsign(ac), say.reduceSpeed(kt)),
          summary: `${ac.callsign} reduce speed ${kt}, ${lead.gapNm.toFixed(1)} nm behind ${lead.leader.callsign} (${proj!.atLeaderThresholdNm.toFixed(1)} nm projected at its threshold, ${need.toFixed(1)} needed)`,
        });
      }
    }
    if (handleDepartures(v)) plans.push(...departures(v));
    return plans;
  };
}

export function createDepartureAgent(): Agent {
  return (v) => {
    const plans: Plan[] = [];
    const { airport } = v;
    for (const ac of v.onFrequency) {
      if (!ac.isDeparture || ac.onGround || ac.radioState === 'TRANSMITTING') continue;
      if (ac.phase !== 'INITIAL_CLIMB' && ac.phase !== 'DEPARTURE') continue;
      const ready = ac.pendingRequest !== undefined || v.settled(ac) >= 4;
      if (!ready || ac.radarIdentified) continue;
      const ifr = ac.flightPlan?.flightRules === 'IFR';
      const cmds = [mkCmd('RADAR_CONTACT', ac)];
      let phrase = say.radarContact(ac, v.facility(ac));
      let summary = `${ac.callsign} radar contact`;
      if (ifr && ac.flightPlan) {
        const cruise = ac.flightPlan.cruiseAltitudeFt;
        if (cruise > ac.altitudeFt + 100) {
          cmds.push(mkCmd('ALTITUDE', ac, { altitudeFt: cruise }));
          phrase = say.clauses(phrase, say.descendMaintain(cruise, ac.altitudeFt));
          summary += `, climb ${cruise}`;
        }
        const first = ac.flightPlan.route.find((f) => findNavFix(airport, f));
        if (first) {
          const fix = findNavFix(airport, first)!.id;
          cmds.push(mkCmd('DIRECT_FIX', ac, { fix }));
          phrase = say.clauses(phrase, say.direct(airport, fix));
          summary += `, direct ${fix}`;
        }
      }
      plans.push({ key: `${ac.id}:dep-checkin`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, once: true, cmds, phrase, summary });
    }
    return plans;
  };
}
