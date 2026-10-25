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
import { alongCross, findRunwayEnd } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { analyzeProcedure, assessApproach, matchingProcedures, visualApproachAllowed } from '../sim/approach';
import type { ProcedureInfo } from '../sim/approach';
import { distanceToFixNm, findNavFix } from '../sim/navigation';
import { trueToMagnetic } from '../sim/geo';
import { getPerformance } from '../sim/performance';
import { findStar, starBeforeIaf } from '../sim/star';
import { frequencyForPosition } from '../radio/frequencies';
import { hasActive, lastClearance, mkCmd } from './core';
import { GAP_HOLD_DELAY_SEC } from './gap';
import type { Agent, AgentView, Plan } from './core';
import { DEPENDENT_PARALLEL_MAX_FT, dependentDiagonalNm, distToThresholdNm, etaToThresholdSec, holdNodeAt, inboundSpeedKt, isInboundArrival, projectedGapNm } from './world';
import type { ProjectedGap } from './world';
import { CROSSING_MARGIN_SEC, intersectionPassSec } from './crossing';
import { ARRIVAL_RUNWAY_GAP_SEC } from './tower';
import { safeDescentAltitude, separationAltitude, separationAt } from './approachSeparation';
import * as say from './phrase';

/** Spacing the AI builds between arrivals on the same final (the engine's own minimum is 3 nm, 4 nm for a light behind a jet). */
export const ARRIVAL_SPACING_NM = 5;
const SLOW_SPEED_KT = 140;
const SLOW_FROM_NM = 5;
/** Speed assignments tried in order ("reduce speed to one six zero", "... one four zero") to build the spacing before the approach clearance. */
const SLOW_STEPS_KT = [160, SLOW_SPEED_KT];
/** The projected in-trail gap never drops below the radar minimum (JO 7110.65 5-5-4: 3 nm). */
const MIN_PROJECTED_GAP_NM = 3;
/**
 * The most an aircraft descends per nm flown on the approach (DESIGN VALUE: 450 ft per nm is 1,050 fpm at 140 kt, the airliner's descent in the engine) and the
 * allowance above that before the final approach fix (1,000 ft, a stabilised-approach allowance). An approach clearance is not given to an aircraft that cannot get
 * down to the altitude of the final approach fix by the fix: it would cross the threshold high and float down the runway (soak: an airliner cleared 3.8 nm out at
 * 3,900 ft - 2,600 ft above the path - touched down 6.9 km past the threshold and stopped there).
 */
export const DESCENT_FT_PER_NM = 450;
export const FAF_HIGH_MARGIN_FT = 1000;
/** An arrival on a STAR is given the descent when it is more than this many feet per nm to the final approach fix above the fix altitude (DESIGN VALUE: 90 % of `DESCENT_FT_PER_NM`, `FAF_HIGH_MARGIN_FT` on top: only when the arrival is all but unable to get down). */
const STAR_DESCENT_NM_FT = 0.9 * DESCENT_FT_PER_NM;
/** ... and only this close (nm) to the fix: farther out the chart's own restrictions bring it down (the star tests check them). */
const STAR_DESCENT_MAX_NM = 14;
/** A withheld approach clearance sends the aircraft into a hold at the fix it is within this many nm of (and more than 1 nm from). DESIGN VALUE. */
const HOLD_AT_JOIN_FIX_NM = 4;
/** An arrival held or climbed for traffic is not descended again for this long (s): descending as soon as the picture clears sent it back into the traffic. DESIGN VALUE. */
const SEP_HOLD_SEC = 90;
/** Is an aircraft `aboveFafFt` above the altitude of the final approach fix, `distNm` from it, too high to be cleared for the approach? */
export const tooHighForFaf = (aboveFafFt: number, distNm: number, marginFt = FAF_HIGH_MARGIN_FT): boolean => aboveFafFt > DESCENT_FT_PER_NM * Math.max(0, distNm) + marginFt;
/**
 * The margin for the APPROACH clearance itself (JO 7110.65 5-9-1 / 5-9-2: the intercept is made at an altitude not above the glidepath; 4-8-1): the engine's glide capture recovers only
 * 400 fpm over the path rate, so an aircraft cleared 1,000 ft high arrived on final 1,700 ft above the path and went around (soak KBOS NE: DAL1294 at 3.9 nm and 2,999 ft). DESIGN VALUE.
 */
export const CLEARANCE_HIGH_MARGIN_FT = 300;

/** The altitude (ft MSL) the procedure has at its final approach fix: the plate's minimum / mandatory figure, else a 3 degree path from the fix distance. */
function fafAltitudeFt(airport: AgentView['airport'], info: ProcedureInfo | undefined): number | undefined {
  const faf = info?.faf;
  if (!faf) return undefined;
  const fa = info!.procedure.fixAltitudes?.find((f) => f.fix.toUpperCase() === faf.id.toUpperCase());
  return fa?.minAltitudeFt ?? fa?.mandatoryAltitudeFt ?? airport.elevationFt + 318 * (faf.dM / 1852);
}

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
/**
 * The fix the aircraft is sent direct to in order to join the approach: the nearest fix of the procedure (not the FAF itself), or, when the aircraft is already
 * within `JOIN_FIX_PASSED_NM` of it, the next one along the procedure. A "direct" to a fix the aircraft is at completes the route at once and leaves the aircraft
 * on a heading that does not join the approach: soak seeds 8 and 12 ("proceed direct FLDER" every 30-100 s for 30-56 minutes).
 */
const JOIN_FIX_PASSED_NM = 2.5;
function joinFix(v: AgentView, ac: Aircraft, info: ProcedureInfo): string | undefined {
  const ids = [...info.feeders, ...info.onCourse.map((f) => f.id)];
  const usable = ids.length > 1 ? ids.slice(0, -1) : ids; // not the FAF itself
  let best = -1;
  let bestD = Infinity;
  usable.forEach((id, i) => {
    const d = distanceToFixNm(v.airport, ac.pos, id);
    if (d !== undefined && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  if (best < 0) return undefined;
  return bestD < JOIN_FIX_PASSED_NM && best + 1 < usable.length ? usable[best + 1] : usable[best];
}

export { DEPENDENT_PARALLEL_MAX_FT, dependentDiagonalNm };
/** Margin the AI adds to the diagonal minimum when it builds the stagger (DESIGN VALUE: the finals converge and speeds differ). */
const DEPENDENT_MARGIN_NM = 1;

interface Leader {
  leader: Aircraft;
  gapNm: number;
  spacingNm: number;
  needNm: number | undefined;
  minProjectedNm: number;
  /** Set when the leader lands on a runway that crosses this one: its runway end (the spacing is a time at the thresholds, 3-10-4, `crossing.ts`). */
  crossingEnd?: RunwayEndGeom;
}

/** The in-trail gap to a leader, projected to the leader's threshold crossing (`projectedGapNm`; for a leader on a crossing runway the leader's own ETA is used). */
function gapProjection(ac: Aircraft, lead: Leader, g: RunwayEndGeom, assignedKt?: number): ProjectedGap {
  if (!lead.crossingEnd) return projectedGapNm(ac, lead.leader, g, assignedKt);
  const dF = distToThresholdNm(ac, g);
  const atLeaderThresholdNm = dF - (inboundSpeedKt(ac, assignedKt) * etaToThresholdSec(lead.leader, lead.crossingEnd)) / 3600;
  return { nowNm: lead.gapNm, atLeaderThresholdNm, minNm: Math.min(lead.gapNm, atLeaderThresholdNm) };
}

/**
 * The most binding arrival ahead of `ac`: the nearest for the same runway (spacing 5 nm), or one on the adjacent parallel final (same direction, centrelines
 * up to 9,000 ft apart) that is nearer the threshold and closer than the dependent-approach stagger (5-9-6, plus a margin) needs along the course.
 */
function leaderOf(v: AgentView, ac: Aircraft, g: RunwayEndGeom): Leader | undefined {
  const mine = distToThresholdNm(ac, g);
  let best: Leader | undefined;
  const slack = (l: Leader): number => l.gapNm - l.spacingNm;
  for (const o of Object.values(v.state.aircraft)) {
    // Pattern traffic is Tower's: it is sequenced around the approach traffic (sequence.ts), not the other way round.
    if (o.id === ac.id || !isInboundArrival(o) || o.phase === 'PATTERN') continue;
    if (o.assignedRunwayEnd === g.end.id) {
      const gap = mine - distToThresholdNm(o, g);
      if (gap > 0) {
        const cand: Leader = { leader: o, gapNm: gap, spacingNm: ARRIVAL_SPACING_NM, needNm: undefined, minProjectedNm: MIN_PROJECTED_GAP_NM };
        if (!best || slack(cand) < slack(best)) best = cand;
      }
      continue;
    }
    const og = findRunwayEnd(v.airport, o.assignedRunwayEnd);
    if (!og || og.runway.id === g.runway.id) continue;
    // An arrival to a runway that crosses this one: this aircraft must not reach its threshold before the other has passed the intersection (3-10-4): a time
    // between the two threshold crossings (the passing time of the one that lands first plus the AI's margin), expressed as the distance this aircraft covers in it.
    const passO = intersectionPassSec(v.airport, o.type, og, g.runway.id);
    if (passO !== undefined) {
      const passMine = intersectionPassSec(v.airport, ac.type, g, og.runway.id);
      const tO = etaToThresholdSec(o, og);
      const tMine = etaToThresholdSec(ac, g);
      if (passMine === undefined || tO > tMine) continue; // the other one lands after this one: it is judged from its own side
      // Only an arrival that is committed counts as the leader: one that is still waiting for its clearance orbits its fix, its time to the threshold swings with every turn and two such
      // aircraft on crossing runways took turns being the leader of each other for 90 minutes (soak KBOS SW, KAP343 and DAL714).
      if (!hasActive(o, 'APPROACH') && o.phase !== 'FINAL' && o.phase !== 'LANDING' && !hasActive(o, 'LAND')) continue;
      const kt = inboundSpeedKt(ac);
      const needNm = ((passO + CROSSING_MARGIN_SEC) * kt) / 3600;
      const cand: Leader = { leader: o, gapNm: ((tMine - tO) * kt) / 3600, spacingNm: needNm, needNm, minProjectedNm: needNm, crossingEnd: og };
      if (!best || slack(cand) < slack(best)) best = cand;
      continue;
    }
    if (!hasActive(o, 'APPROACH') && o.phase !== 'FINAL' && o.phase !== 'LANDING' && !hasActive(o, 'LAND')) continue; // (a parallel final is a stagger to arrivals that fly it; one still waiting orbits its fix)
    let dh = Math.abs(og.headingDeg - g.headingDeg) % 360;
    if (dh > 180) dh = 360 - dh;
    if (dh > 15) continue;
    const latFt = Math.abs(alongCross(g, og.end.threshold).cross) / 0.3048;
    if (latFt > DEPENDENT_PARALLEL_MAX_FT) continue;
    // the other aircraft's distance to its own threshold, against mine: thresholds of parallel runways are abeam or staggered by a known amount
    const stagger = alongCross(g, og.end.threshold).along / 1852; // metres -> nm (other threshold along my course)
    const gap = mine - (distToThresholdNm(o, og) - stagger);
    if (gap <= -DEPENDENT_MARGIN_NM) continue; // the other one is behind (it follows me, and is judged from its own side)
    const latNm = (latFt * 0.3048) / 1852;
    const diag = dependentDiagonalNm(latFt) + DEPENDENT_MARGIN_NM;
    const along = Math.sqrt(Math.max(0, diag * diag - latNm * latNm));
    const cand: Leader = { leader: o, gapNm: gap, spacingNm: along, needNm: along, minProjectedNm: along };
    if (gap > 0 && (!best || slack(cand) < slack(best))) best = cand;
  }
  return best;
}

/**
 * The published hold-in-lieu the aircraft can still be sent to: a fix it has not reached (more than 2 nm ahead) on the remaining route of the approach it is
 * working. Used to hold an arrival behind another one (below) and to hold one for a departure gap (`gapActions.ts`).
 */
export function publishedHoldFor(v: AgentView, ac: Aircraft): { fix: string; turns?: 'left' | 'right' } | undefined {
  const choice = chooseApproach(v, ac);
  if (!choice?.info || !ac.nav) return undefined;
  const remaining = ac.nav.fixes.slice(ac.nav.index);
  const hold = choice.info.procedure.holdingPatterns?.find(
    (h) => h.role === 'hold_in_lieu' && remaining.some((f) => (findNavFix(v.airport, f)?.id ?? f).toUpperCase() === h.fix.toUpperCase()) && (distanceToFixNm(v.airport, ac.pos, h.fix) ?? 0) > 2,
  );
  return hold ? { fix: hold.fix, turns: hold.turns } : undefined;
}

/**
 * The clearance is withheld (spacing, too high, a clearance the engine would refuse) and the aircraft is about to reach the fix it was sent to: it holds there, on the approach
 * course, until the clearance can be given (JO 7110.65 4-6-4; the hold is left by the approach clearance). Without it the aircraft overflew the fix, the join instruction was given
 * again, and so on for 20 to 90 minutes (soak KBOS / KPHL: AAL2531, KAP343, KAP958, ASA545). The published hold when the fix has one, else one minute legs, right turns.
 */
function joinFixHold(v: AgentView, ac: Aircraft, choice: ApproachChoice, why: string): Plan | undefined {
  const { airport, mem } = v;
  if (ac.phase === 'HOLDING' || ac.star || !ac.nav || (ac.nav.mode !== 'direct' && ac.nav.mode !== 'route') || !choice.info) return undefined;
  const nextFix = ac.nav.fixes[ac.nav.index];
  if (!nextFix || mem.done.has(`${ac.id}:hold-fix:${nextFix}`)) return undefined;
  const dFix = distanceToFixNm(airport, ac.pos, nextFix);
  const fixId = findNavFix(airport, nextFix)?.id ?? nextFix;
  if (dFix === undefined || dFix >= HOLD_AT_JOIN_FIX_NM || dFix <= 1 || !choice.info.onCourse.some((f) => f.id.toUpperCase() === fixId.toUpperCase())) return undefined;
  const pub = publishedHoldFor(v, ac);
  const inboundMag = Math.round(trueToMagnetic(choice.info.courseTrue, airport.magneticVariationDeg));
  const hold = pub && pub.fix.toUpperCase() === fixId.toUpperCase()
    ? { fix: pub.fix, asPublished: true, turns: pub.turns }
    : { fix: fixId, inboundCourseDeg: ((inboundMag % 360) + 360) % 360 || 360, turns: 'right' as const, legMinutes: 1, asPublished: false };
  return {
    key: `${ac.id}:hold-fix:${nextFix}`, aircraftId: ac.id, callsign: ac.callsign, priority: 46, once: true,
    cmds: [mkCmd('HOLD_AT_FIX', ac, { hold })],
    phrase: say.clauses(say.callsign(ac), hold.asPublished ? say.holdAsPublished(airport, fixId) : say.holdAtFix(airport, fixId, hold.inboundCourseDeg!, hold.turns ?? 'right')),
    summary: `${ac.callsign} hold at ${fixId} (${hold.asPublished ? 'as published' : `${hold.inboundCourseDeg} inbound, right turns`}): the approach clearance is withheld (${why})`,
  };
}

export function createApproachAgent(handleDepartures: (v: AgentView) => boolean): Agent {
  const departures = createDepartureAgent();
  return (v) => {
    const plans: Plan[] = [];
    const { airport, mem } = v;
    for (const ac of v.onFrequency) {
      if (ac.radioState === 'TRANSMITTING' || ac.onGround) continue;
      if (ac.isDeparture) continue;
      // VFR transits, overhead maneuvers and helicopters are worked by the special agent (special.ts), not sequenced as arrivals
      if (ac.flags.transit || ac.flags.overhead || ac.type === 'H65') continue;
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
      // An arrival on a STAR (KMHT ROZZE TWO): radar contact and "descend via" (JO 7110.65 4-5-7); the arrival's own restrictions then take it down
      // to the IAF, where the approach is cleared. No separate descent, no direct-to-fix while it is still flying the procedure.
      const star = ac.star ? findStar(airport, ac.star.procedureId) : undefined;
      const lowest = star ? undefined : descentAltitude(v, ac, choice.info);
      // (not into the level of traffic it would meet: 5-5-1 / 5-6-1, `approachSeparation.ts`)
      const alt = lowest === undefined ? undefined : safeDescentAltitude(v.state, ac, lowest);

      // Radar contact (with the descent, as one transmission).
      if (!ac.radarIdentified) {
        const cmds = [mkCmd('RADAR_CONTACT', ac)];
        let phrase = say.radarContact(ac, facility);
        if (star && ac.star) {
          cmds.push(mkCmd('STAR', ac, { starName: star.star.ident, descendVia: true }));
          phrase = say.clauses(phrase, say.descendViaArrival(star.star.spokenName));
        } else if (alt !== undefined) {
          cmds.push(mkCmd('ALTITUDE', ac, { altitudeFt: alt }));
          phrase = say.clauses(phrase, say.descendMaintain(alt, ac.altitudeFt));
        }
        plans.push({
          key: `${ac.id}:radar`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, once: true, cmds, phrase,
          summary: `${ac.callsign} radar contact${star ? `, descend via the ${star.star.spokenName} arrival` : alt !== undefined ? `, descend ${alt}` : ''}`,
        });
        continue;
      }

      // An arrival whose course meets other traffic inside the separation is held at its level or taken up 1,000 / 2,000 ft (5-5-1 / 5-5-4; never while flying a STAR's own profile).
      const sepAlt = !star && !hasActive(ac, 'APPROACH')
        ? separationAltitude(v.state, ac, (o) => v.onFrequency.some((f) => f.id === o.id), (o) => { const og = findRunwayEnd(airport, o.assignedRunwayEnd); return og ? distToThresholdNm(o, og) : 99; })
        : undefined;
      if (sepAlt !== undefined) {
        mem.notes.set(`sep:${ac.id}`, v.now);
        plans.push({
          key: `${ac.id}:sep-alt:${sepAlt}`, aircraftId: ac.id, callsign: ac.callsign, priority: 66, cooldownSec: 30,
          cmds: [mkCmd('ALTITUDE', ac, { altitudeFt: sepAlt })], phrase: say.clauses(say.callsign(ac), say.descendMaintain(sepAlt, ac.altitudeFt)),
          summary: `${ac.callsign} ${sepAlt > ac.altitudeFt + 50 ? 'climb' : 'maintain'} ${sepAlt} for traffic (${separationAt(v.state, ac, ac.target.altitudeFt ?? ac.altitudeFt).otherId ?? '?'})`,
        });
        continue;
      }

      // Descent (aircraft that came back from a missed approach, or radar contact without a descent because of the MVA).
      if (alt !== undefined && (ac.target.altitudeFt ?? ac.altitudeFt) > alt + 50 && v.now - (mem.notes.get(`sep:${ac.id}`) ?? -Infinity) >= SEP_HOLD_SEC) {
        plans.push({
          key: `${ac.id}:alt:${alt}`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, cooldownSec: 60,
          cmds: [mkCmd('ALTITUDE', ac, { altitudeFt: alt })], phrase: say.clauses(say.callsign(ac), say.descendMaintain(alt, ac.altitudeFt)),
          summary: `${ac.callsign} descend ${alt}`,
        });
        continue;
      }

      if (hasActive(ac, 'APPROACH')) {
        // Cleared: the spacing to the aircraft ahead is kept with speed while the aircraft is outside the FAF / 5 nm (JO 7110.65 5-7-1, 5-5-4): a follower that is faster than
        // its leader closes on it after the clearance (soak KBOS 4L / 4R and KPHL: two cleared arrivals at 1.5 nm and under 500 ft on the way to the final).
        const dClr = distToThresholdNm(ac, choice.end);
        const leadClr = dClr > SLOW_FROM_NM + 1 && phase !== 'FINAL' ? leaderOf(v, ac, choice.end) : undefined;
        if (leadClr) {
          const needClr = leadClr.needNm ?? requiredGapNm(ac);
          const curClr = inboundSpeedKt(ac);
          const stepsClr = SLOW_STEPS_KT.map((kt) => Math.max(kt, getPerformance(ac.type).minSpeedKt + 20)).filter((kt, i, a) => kt < curClr - 10 && a.indexOf(kt) === i);
          if (gapProjection(ac, leadClr, choice.end).atLeaderThresholdNm < needClr && stepsClr.length) {
            const fixingClr = stepsClr.find((kt) => gapProjection(ac, leadClr, choice.end, kt).atLeaderThresholdNm >= needClr);
            const kt = fixingClr ?? stepsClr[stepsClr.length - 1];
            if (!mem.done.has(`${ac.id}:slow:${kt}`)) {
              plans.push({
                key: `${ac.id}:slow:${kt}`, aircraftId: ac.id, callsign: ac.callsign, priority: 45, once: true,
                cmds: [mkCmd('SPEED', ac, { speedKt: kt })], phrase: say.clauses(say.callsign(ac), say.reduceSpeed(kt)),
                summary: `${ac.callsign} reduce speed ${kt}, cleared, ${leadClr.gapNm.toFixed(1)} nm behind ${leadClr.leader.callsign} (${gapProjection(ac, leadClr, choice.end).atLeaderThresholdNm.toFixed(1)} nm projected at its threshold, ${needClr.toFixed(1)} needed)`,
              });
            }
          }
        }
        continue;
      }

      // Still flying the arrival before its IAF: the procedure does the work (restrictions, route); the approach is cleared at the IAF. Unless the arrival's restrictions would keep the
      // aircraft too high to be cleared by the final approach fix (PAATS FOUR over JALTO at 12,000 ft, 8.6 nm out, then "direct JALTO" for 40 minutes, soak KPHL WEST): then it is
      // given the descent (JO 7110.65 4-5-7 NOTE: a descend-via arrival is descended by an altitude instruction when the sequence needs it), which cancels the restrictions.
      if (ac.star && ac.nav && (ac.nav.mode === 'route' || ac.nav.mode === 'direct') && starBeforeIaf(airport, ac)) {
        const fafStar = fafAltitudeFt(airport, choice.info);
        const dFafStar = choice.info?.faf ? distanceToFixNm(airport, ac.pos, choice.info.faf.id) : undefined;
        const lowestStar = descentAltitude(v, ac, choice.info);
        if (fafStar !== undefined && dFafStar !== undefined && dFafStar < STAR_DESCENT_MAX_NM && lowestStar !== undefined && ac.altitudeFt - fafStar > STAR_DESCENT_NM_FT * dFafStar + FAF_HIGH_MARGIN_FT && (ac.target.altitudeFt ?? ac.altitudeFt) > lowestStar + 50) {
          const altStar = safeDescentAltitude(v.state, ac, lowestStar);
          if (altStar < (ac.target.altitudeFt ?? ac.altitudeFt) - 50) {
            plans.push({
              key: `${ac.id}:star-descent`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, cooldownSec: 60, cmds: [mkCmd('ALTITUDE', ac, { altitudeFt: altStar })],
              phrase: say.clauses(say.callsign(ac), say.descendMaintain(altStar, ac.altitudeFt)),
              summary: `${ac.callsign} descend ${altStar} (${Math.round(ac.altitudeFt - fafStar)} ft above the final approach fix altitude, ${dFafStar.toFixed(1)} nm from the fix: the arrival's restrictions keep it too high)`,
            });
          }
        }
        continue;
      }

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
      const need = lead?.needNm ?? requiredGapNm(ac);
      const proj = lead ? gapProjection(ac, lead, choice.end) : undefined;
      const gapOk = !lead || (lead.gapNm >= lead.spacingNm && proj!.atLeaderThresholdNm >= need && proj!.minNm >= lead.minProjectedNm);
      const clearance = mkCmd('APPROACH', ac, { approachType: choice.type, runwayEnd: choice.end.end.id, runwayId: choice.end.runway.id });
      // Not while the aircraft is too high to get down to the final approach fix altitude (`tooHighForFaf`): it keeps descending to its assigned altitude and is cleared
      // when the fix is within reach.
      const fafAlt = fafAltitudeFt(airport, choice.info);
      const dFaf = choice.info?.faf ? distanceToFixNm(airport, ac.pos, choice.info.faf.id) : undefined;
      const tooHigh = fafAlt !== undefined && dFaf !== undefined && tooHighForFaf(ac.altitudeFt - fafAlt, dFaf, CLEARANCE_HIGH_MARGIN_FT);
      // An arrival held for a departure gap (`gapActions.ts`: the hold is the later approach clearance) is cleared when the hold has run its planned time.
      const gapHeld = phase === 'HOLDING' && mem.notes.has(`gaphold:${ac.id}`) && v.now < (lastClearance(ac, 'HOLD_AT_FIX')?.issuedAtSec ?? v.now) + GAP_HOLD_DELAY_SEC
        && (v.state.coordination?.requests ?? []).some((r) => r.topic === 'GAP' && r.status === 'approved');
      if (gapOk && !gapHeld && !tooHigh && assessClearanceSafety(v.state, clearance).safe) {
        // The engine holds the altitude the controller assigned until the aircraft is established, then descends only 400 fpm over the path rate: an aircraft cleared at its
        // assigned 3,000 ft arrived on final 1,700 ft above the path (soak KBOS NE: DAL1294). The clearance carries the descent to the path altitude at the final approach fix
        // (JO 7110.65 4-8-1, 5-9-1: intercept at an altitude not above the glidepath).
        const assigned = ac.target.altitudeFt ?? ac.altitudeFt;
        const pathAtFaf = fafAlt !== undefined ? Math.ceil(fafAlt / 100) * 100 : undefined;
        const descend = pathAtFaf !== undefined && assigned > pathAtFaf + 150 ? mkCmd('ALTITUDE', ac, { altitudeFt: pathAtFaf }) : undefined;
        const withDescent = !!descend && assessClearanceSafety(v.state, descend).safe;
        plans.push({
          key: `${ac.id}:approach`, aircraftId: ac.id, callsign: ac.callsign, priority: 55, cooldownSec: 20, cmds: withDescent ? [clearance, descend!] : [clearance],
          phrase: say.clauses(say.callsign(ac), say.clearedApproach(choice.type, choice.end.end.id), ...(withDescent ? [say.descendMaintain(pathAtFaf!, ac.altitudeFt)] : [])),
          summary: `${ac.callsign} cleared ${choice.type} runway ${choice.end.end.id}${withDescent ? `, descend ${pathAtFaf}` : ''}`,
        });
        continue;
      }
      if (!lead) {
        // Too high while the arrival's own restrictions hold it there (a hold at its STAR altitude never brings it down): the descent cancels them.
        const lowestHigh = tooHigh && ac.star ? descentAltitude(v, ac, choice.info) : undefined;
        if (lowestHigh !== undefined && (ac.target.altitudeFt ?? ac.altitudeFt) > lowestHigh + 50) {
          const altHigh = safeDescentAltitude(v.state, ac, lowestHigh);
          if (altHigh < (ac.target.altitudeFt ?? ac.altitudeFt) - 50) {
            plans.push({
              key: `${ac.id}:star-descent`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, cooldownSec: 60, cmds: [mkCmd('ALTITUDE', ac, { altitudeFt: altHigh })],
              phrase: say.clauses(say.callsign(ac), say.descendMaintain(altHigh, ac.altitudeFt)), summary: `${ac.callsign} descend ${altHigh} (too high for the final approach fix on its arrival)`,
            });
            continue;
          }
        }
        const hp = joinFixHold(v, ac, choice, tooHigh ? 'too high' : 'a clearance the engine would refuse');
        if (hp) plans.push(hp);
        continue;
      }

      // Too close to the aircraft ahead: hold at the published fix when it is still ahead and the gap is small, else slow down.
      const dNm = distToThresholdNm(ac, choice.end);
      const holdIssued = [...mem.done].some((k) => k.startsWith(`${ac.id}:hold:`));
      if (holdIssued || phase === 'HOLDING') continue; // released by the approach clearance once the gap is there
      // Speed first (the follower is faster than the leader almost always): the gentlest assignment whose projected gap at the leader's
      // threshold crossing meets the requirement, else the lowest one; when speed cannot build the gap, the published hold.
      const cur = inboundSpeedKt(ac);
      const steps = SLOW_STEPS_KT.map((kt) => Math.max(kt, getPerformance(ac.type).minSpeedKt + 20)).filter((kt, i, a) => kt < cur - 10 && a.indexOf(kt) === i);
      const fixing = steps.find((kt) => gapProjection(ac, lead, choice.end, kt).atLeaderThresholdNm >= need);
      const speedKt = fixing ?? steps[steps.length - 1];
      const slowAvailable = dNm > SLOW_FROM_NM && speedKt !== undefined && !mem.done.has(`${ac.id}:slow:${speedKt}`);
      const speedsExhausted = fixing === undefined;
      const tryHold = lead.gapNm < lead.spacingNm - 1.5 || (speedsExhausted && !slowAvailable && proj!.atLeaderThresholdNm < need - HOLD_SHORTFALL_NM);
      if (tryHold && choice.info && ac.nav) {
        const hold = publishedHoldFor(v, ac);
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
      } else {
        // no speed left to give and the gap is still short by more than a mile and a half: the aircraft holds at the fix it is about to reach instead of orbiting it
        const hp = proj!.atLeaderThresholdNm < need - HOLD_SHORTFALL_NM ? joinFixHold(v, ac, choice, `${lead.gapNm.toFixed(1)} nm behind ${lead.leader.callsign}, speed exhausted`) : undefined;
        if (hp) plans.push(hp);
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
      // A departure still on the ground that took another aircraft's frequency change (a similar callsign read back by the wrong pilot: soak seed 12, NKS603 stood ready
      // at the hold of 22 on Departure's frequency for 40 minutes, nobody answered it): Departure sends it back, to Tower when it is at a runway, else to Ground.
      if (ac.isDeparture && ac.onGround && ac.radioState !== 'TRANSMITTING' && v.settled(ac) >= 4) {
        const at = holdNodeAt(airport, ac, 60) || ac.pendingRequest?.kind === 'DEPARTURE';
        const back = frequencyForPosition(airport, at && v.staffed.has('TWR') ? 'TWR' : 'GND') ?? frequencyForPosition(airport, 'TWR') ?? frequencyForPosition(airport, 'GND');
        if (back) {
          plans.push({
            key: `${ac.id}:misrouted-from-dep`, aircraftId: ac.id, callsign: ac.callsign, priority: 54, cooldownSec: 60,
            cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: back.id })],
            phrase: say.contact(ac, airport, back.id, back.mhz), summary: `${ac.callsign} is on the ground, back to ${back.id}`,
          });
        }
        continue;
      }
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
