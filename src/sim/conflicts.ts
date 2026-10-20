/**
 * Safety logic: pre-execution clearance assessment and per-tick conflict detection.
 *
 * Paragraph references cite FAA JO 7110.65 TOPICS only (no quoted text):
 *   3-9-6   same runway separation (departures)
 *   3-10-3  same runway separation (arrivals); 3-10-5 landing clearance
 *   3-7-2   taxi and ground movement, runway crossings
 *   3-9-8   intersecting runway / intersecting flight path operations
 *   (paragraph numbers and titles verified 2026-10-16; see docs/FAA-REFERENCES.md)
 */
import type { Aircraft, ConflictAlert, ParsedCommand, SimulationState } from './types';
import { dist, headingDiff, ktToMps, magneticToTrue, mToFt, mToNm, nmToM, pointInPolygon } from './geo';
import { projectArrival, surfaceWindow, timeToThreshold } from './runwayTiming';
import { highestMvaAhead, MVA_LOOKAHEAD_NM, mvaExempt } from './mva';
import { alongCross, crossingRunways, findRunway, findRunwayEnd, isOnFinal, runwayIntersection } from './runways';
import type { Runway, Vec2 } from './types';
import { assessApproach, courseGeom } from './approach';
import { computeRunwayActivity } from './runwayOccupancy';
import { TAXI_PHASES } from './stateMachines';
import { activeClearance, emitEvent, perfOf } from './context';
import { activeClosures } from './airportOps';
import { isDaylight, simUtcMs } from './solar';
import { fixedWingNearTrack, helicopterTrack, lowHelicoptersNearTrack, runwayDepartureTrack, runwayFinalTrack, HELI_LATERAL_NM } from './helicopterSeparation';
import { getPerformance, isRotorcraftType, isVehicleType, lineUpTimeSec, srsCategory, wakeRecatCategory } from './performance';
import { wakeMinimumNm } from './wake';
import type { RunwayEndGeom } from './runways';
import type { SimContext } from './context';

export const REF_SAME_RUNWAY = 'FAA JO 7110.65 3-9-6 (same runway separation)';
export const REF_MVA = 'FAA JO 7110.65 5-6-1 (vector aircraft at or above the MVA or the minimum IFR altitude)';
export const REF_LANDING = 'FAA JO 7110.65 3-10-5 (landing clearance) and 3-10-3 (same runway separation)';
export const REF_CLOSED_RUNWAY = 'FAA JO 7110.65 3-3-2 (closed/unsafe runway information) and 3-10-5 (landing clearance)';
export const REF_TAXI = 'FAA JO 7110.65 3-7-2 (taxi and ground movement, runway crossings)';
export const REF_INTERSECTING = 'FAA JO 7110.65 3-9-8 / 3-10-4 (intersecting runway separation)';
export const REF_WAKE_INTERSECTION = 'FAA JO 7110.65 3-9-7 (wake turbulence separation for intersection departures)';
/** 7110.65 5-5-4 MINIMA (paragraph number and title verified, docs/REALISM-VERIFICATION.md): 3 nm is the terminal radar minimum. */
export const REF_RADAR_SEPARATION = 'FAA JO 7110.65 5-5-4 (radar separation minima, simplified here to 3 nm in-trail on the same final)';
export const REF_WAKE_SEPARATION = 'FAA JO 7110.65 5-5-4, TBL 5-5-4 (wake turbulence separation, on approach; categories per JO 7110.126A Appendix A)';
export const APPROACH_IN_TRAIL_NM = 3;

export interface SafetyIssue {
  kind: ConflictAlert['kind'];
  text: string;
  reference: string;
  aircraftIds: string[];
  runwayId?: string;
}

export interface SafetyAssessment {
  safe: boolean;
  issues: SafetyIssue[];
}

const FINAL_TAKEOFF_NM = 2;
const FINAL_CROSSING_NM = 3;
const REF_HELI = 'JO 7110.65 3-11-1 / AIM 4-3-17 (helicopters avoid the flow of fixed-wing aircraft); 7-8-3 (500 ft); 7-2-1 visual separation not applied';
/** A vehicle sent onto a runway stays for minutes (a runway inspection): no arrival on final inside this range (nm) and no traffic in the pattern (design value). */
const FINAL_PROCEED_NM = 8;

function cs(state: SimulationState, ids: string[]): string {
  return ids.map((i) => state.aircraft[i]?.callsign ?? i).join(', ');
}

/** Arrivals on final to the runway within `nm` (airborne, aligned, to either end of the runway). */
function arrivalsOnFinal(state: SimulationState, runwayId: string, nm: number, exclude: string): Aircraft[] {
  const out: Aircraft[] = [];
  const rw = state.airport.runways.find((r) => r.id === runwayId);
  if (!rw) return out;
  for (const ac of Object.values(state.aircraft)) {
    if (ac.id === exclude || ac.onGround) continue;
    for (const end of rw.ends) {
      const g = findRunwayEnd(state.airport, end.id);
      if (g && isOnFinal(g, ac.pos, ac.headingDeg, nm) && ac.assignedRunwayEnd === end.id) out.push(ac);
    }
  }
  return out;
}

/**
 * Same-runway separation, FAA JO 7110.65 3-9-6 (departing aircraft) and 3-10-3 (arriving aircraft), categorical distances:
 *   both Category I ............................. 3,000 ft      Category I preceded by Category II ... 3,000 ft
 *   the succeeding (or both) Category II ........ 4,500 ft      either aircraft Category III ......... 6,000 ft
 * (3-10-3 uses the same figures for a landing aircraft behind a departure that is airborne: measured from the landing
 * threshold.) Categories: `srsCategory` in performance.ts (C172 = I, A320 = III).
 */
export function srsMinimumFt(succeedingType: string, precedingType: string): number {
  const s = srsCategory(succeedingType);
  const p = srsCategory(precedingType);
  if (s === 3 || p === 3) return 6000;
  if (s === 2) return 4500;
  return 3000;
}

/**
 * JO 7110.65 3-10-3, the landed-aircraft exception (verbatim, fetched from faa.gov): "Between sunrise and sunset, if you can
 * determine distances by reference to suitable landmarks and the other aircraft has landed, it need not be clear of the runway
 * if the following minimum distance from the landing threshold exists: When a Category I aircraft is landing behind a Category I
 * or II - 3,000 feet. When a Category II aircraft is landing behind a Category I or II - 4,500 feet." There is NO figure for a
 * Category III aircraft on either side, so the exception does not apply to them. Applied only between sunrise and sunset (NOAA
 * solar position at the airport reference point and the engine epoch, `solar.ts`); the "suitable landmarks" are assumed to
 * exist (the simulator knows every distance). The airborne case (departed, or airborne ahead of the threshold) has no daylight
 * condition in the text and is `airborneBlockers`.
 */
export function landedDistanceExceptionApplies(state: SimulationState, subject: Aircraft, other: Aircraft, g: RunwayEndGeom): boolean {
  if (!other.onGround || other.isDeparture && other.phase !== 'ROLLOUT' && other.phase !== 'RUNWAY_EXIT') return false; // "has landed"
  if (other.phase !== 'ROLLOUT' && other.phase !== 'RUNWAY_EXIT' && other.phase !== 'LANDING') return false;
  const og = findRunwayEnd(state.airport, other.assignedRunwayEnd);
  if (!og || og.end.id !== g.end.id) return false;
  if (Math.abs(alongCross(g, other.pos).cross) >= TURNED_AWAY_M) return false;
  return landedExceptionHolds(state, subject, other, alongCross(g, other.pos).along - g.displacedM - perfOf(other).lengthM / 2); // tail distance from the LANDING threshold
}

/** The 3-10-3 daylight rule given the preceding (landed) aircraft's TAIL position `tailAlongM` from the landing threshold. */
function landedExceptionHolds(state: SimulationState, subject: Aircraft, other: Aircraft, tailAlongM: number): boolean {
  if (!isDaylight(state.airport.arp, simUtcMs(state))) return false;
  const s = srsCategory(subject.type);
  const p = srsCategory(other.type);
  if (s === 3 || p === 3) return false;
  return mToFt(tailAlongM) >= (s === 1 ? 3000 : 4500);
}

/** Aircraft whose lateral offset from the centreline exceeds this have "turned to avert any conflict" (3-9-6 a). */
const TURNED_AWAY_M = 450;

/**
 * Preceding AIRBORNE aircraft (departures climbing out, go-arounds) that still block the runway for `ac`:
 * an aircraft that has crossed the runway end, or turned away, no longer does; one that is airborne only blocks while it is
 * less than the categorical distance ahead of the succeeding aircraft's start of roll (takeoff, `startAlongM` = its position
 * along the runway) or of the landing threshold (landing, `startAlongM` = 0). One on the ground never qualifies (callers treat
 * it as "runway occupied"). Anticipating separation (3-9-5 / 3-10-6) is applied conservatively: only the distance that
 * ALREADY exists counts.
 */
function airborneBlockers(state: SimulationState, ac: Aircraft, g: RunwayEndGeom, startAlongM: number, verb: string, reference: string): SafetyIssue[] {
  const out: SafetyIssue[] = [];
  const para = reference === REF_LANDING ? '3-10-3' : '3-9-6';
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id || o.onGround) continue;
    if (o.phase !== 'INITIAL_CLIMB' && o.phase !== 'DEPARTURE' && o.phase !== 'GO_AROUND') continue;
    const og = findRunwayEnd(state.airport, o.assignedRunwayEnd);
    if (!og || og.runway.id !== g.runway.id) continue;
    const { along, cross } = alongCross(g, o.pos);
    if (Math.abs(cross) > TURNED_AWAY_M || along >= g.lengthM || along < startAlongM - 30) continue; // turned away / crossed the runway end / behind
    if (og.end.id !== g.end.id) {
      out.push({ kind: 'RUNWAY_CONFLICT', text: `${verb} for ${ac.callsign} while ${o.callsign} is airborne over runway ${g.runway.id} using the opposite direction`, reference, aircraftIds: [ac.id, o.id], runwayId: g.runway.id });
      continue;
    }
    const gapFt = mToFt(along - startAlongM);
    const needFt = srsMinimumFt(ac.type, o.type);
    if (gapFt < needFt) {
      out.push({
        kind: 'RUNWAY_CONFLICT',
        text: `${verb} for ${ac.callsign} (SRS category ${srsCategory(ac.type)}) with ${o.callsign} (category ${srsCategory(o.type)}) airborne only ${Math.round(gapFt)} ft ahead on runway ${g.runway.id}; ${para} needs ${needFt} ft`,
        reference, aircraftIds: [ac.id, o.id], runwayId: g.runway.id,
      });
    }
  }
  return out;
}

/**
 * Departure behind a SLOWER departure on the same runway and the same initial track (JO 7110.65 3-9-6 same runway separation; 5-8-3
 * successive departures: the follower must not overtake the leader inside radar separation unless courses diverge by 15 degrees or more).
 * The engine alerts at 1.5 nm / 500 ft, the controller keeps 3 nm. Estimated at the clearance: the leader flies on at its climb speed on the
 * runway track, the follower rolls (line-up delay + acceleration), lifts off and climbs at its own climb speed (it does not turn: a direct-to
 * instruction comes only after radar contact). The gap is linear in time once the follower is airborne, so its minimum over the time the
 * leader stays inside `DEPARTURE_TRAIL_RANGE_NM` of the field is at that time's end. A leader that has turned `DEPARTURE_DIVERGE_DEG` or more
 * away from the runway heading no longer counts. Only a follower that closes by `DEPARTURE_CLOSURE_KT` or more is judged (equal types and
 * slower followers keep the plain airborne-distance rule of `airborneBlockers`).
 */
export const DEPARTURE_TRAIL_NM = 3;
export const DEPARTURE_TRAIL_RANGE_NM = 10;
export const DEPARTURE_DIVERGE_DEG = 15;
const DEPARTURE_CLOSURE_KT = 10;
const DEPARTURE_LINE_UP_DELAY_SEC = 20;

export interface DepartureTrailConflict {
  leader: Aircraft;
  /** Smallest projected gap (nm) before the leader is 10 nm out. */
  minGapNm: number;
  /** Leader's distance along the runway track now, nm. */
  leaderAlongNm: number;
}

export function departureTrailConflict(state: SimulationState, ac: Aircraft, g: RunwayEndGeom, ownTrackTrueDeg?: number): DepartureTrailConflict | undefined {
  // The takeoff clearance carries a departure heading that diverges from the runway heading by 15 degrees or more (JO 7110.65 5-8-2 INITIAL HEADING, 5-8-3 (a):
  // diverging courses): the follower is not on the leader's track, however much faster it is. The engine flies the heading from 400 ft AGL.
  if (ownTrackTrueDeg !== undefined && Math.abs(headingDiff(ownTrackTrueDeg, g.headingDeg)) >= DEPARTURE_DIVERGE_DEG) return undefined;
  const pF = getPerformance(ac.type);
  const vF = pF.climbSpeedKt;
  const startAlong = Math.max(0, alongCross(g, ac.pos).along);
  const tRoll = pF.rotateSpeedKt / pF.accelKtPerSec;
  const dRollNm = mToNm(0.5 * pF.accelKtPerSec * 0.514444 * tRoll * tRoll);
  const tf = (ac.phase === 'LINE_UP_AND_WAIT' ? 0 : DEPARTURE_LINE_UP_DELAY_SEC) + 2.5 + tRoll;
  let worst: DepartureTrailConflict | undefined;
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id || o.onGround || !o.isDeparture) continue;
    if (o.phase !== 'INITIAL_CLIMB' && o.phase !== 'DEPARTURE') continue;
    const og = findRunwayEnd(state.airport, o.assignedRunwayEnd);
    if (!og || og.end.id !== g.end.id) continue;
    const { along, cross } = alongCross(g, o.pos);
    if (along <= startAlong || Math.abs(cross) > FINAL_LATERAL_M) continue;
    if (Math.abs(headingDiff(o.trackDeg, g.headingDeg)) >= DEPARTURE_DIVERGE_DEG) continue; // diverging courses
    const vL = Math.max(getPerformance(o.type).climbSpeedKt, o.groundSpeedKt);
    if (vF - vL < DEPARTURE_CLOSURE_KT) continue;
    const leaderNm = mToNm(along);
    const tEnd = ((DEPARTURE_TRAIL_RANGE_NM - leaderNm) / vL) * 3600;
    if (tEnd <= tf) continue; // the leader is out of the area before the follower is airborne
    const gapNm = leaderNm - mToNm(startAlong) + (vL / 3600) * tEnd - dRollNm - (vF / 3600) * (tEnd - tf);
    if (gapNm < DEPARTURE_TRAIL_NM && (!worst || gapNm < worst.minGapNm)) worst = { leader: o, minGapNm: gapNm, leaderAlongNm: leaderNm };
  }
  return worst;
}

/**
 * Intersecting runway operations, JO 7110.65 3-9-8 (departing aircraft) and 3-10-4 (arriving aircraft), judged at the clearance:
 *
 *  - A DEPARTURE must not begin its roll until a preceding departure on the other runway "has departed and passed the intersection"
 *    (measured by its position along its runway, not by a height), or a preceding arrival there "is clear of the landing runway ...
 *    or has passed the intersection". A preceding departure that has not passed the intersection, or an arrival still rolling out
 *    before it, blocks. An arrival that is still airborne on final only matters if it would cross its threshold before the
 *    departure clears the intersection (estimated from the departure's acceleration, and the arrival's distance / ground speed).
 *  - An ARRIVAL must not cross its threshold until the other aircraft has "departed and passed the intersection" / is clear / has
 *    passed it. Estimated the same way: unsafe only if it would cross its threshold before the departure passes the intersection;
 *    against another arrival, only if that one lands first and would not have passed the intersection by then.
 * Land and hold short (3-10-5): an arrival cleared to hold short of the other runway (either way round) is not judged against it; the executor validates the LAHSO, and the rollout planning stops it short (crossing the point is an incursion).
 */
const INTERSECTION_PASS_MARGIN_M = 60;
const ROLL_START_DELAY_SEC = 2.5;

function timeToCover(distM: number, v0Mps: number, accelMps2: number): number {
  if (distM <= 0) return 0;
  if (accelMps2 <= 1e-6) return distM / Math.max(v0Mps, 1);
  return (-v0Mps + Math.sqrt(v0Mps * v0Mps + 2 * accelMps2 * distM)) / accelMps2;
}

function intersectingIssues(state: SimulationState, ac: Aircraft, kind: 'TAKEOFF' | 'LAND', g: RunwayEndGeom, other: Runway): SafetyIssue[] {
  const out: SafetyIssue[] = [];
  const airport = state.airport;
  const P = runwayIntersection(g.runway, other);
  if (!P) return out;
  const verb = kind === 'TAKEOFF' ? 'Takeoff clearance' : 'Landing clearance';
  const subjectPerf = perfOf(ac);
  const sSubjectInt = alongCross(g, P).along; // intersection, along the subject's runway
  // Time for the subject to be clear (departure: passed the intersection) or to reach its threshold (arrival).
  let tSubjectDepClear = Infinity;
  let tSubjectThr = Infinity;
  if (kind === 'TAKEOFF') {
    const startAlong = alongCross(g, ac.pos).along;
    const dist2 = Math.max(0, sSubjectInt + INTERSECTION_PASS_MARGIN_M - startAlong);
    // cleared from the hold (not yet lined up): the line-up takes 10-17+ s before the roll
    const delay = ac.phase === 'LINE_UP_AND_WAIT' ? ROLL_START_DELAY_SEC : lineUpTimeSec(subjectPerf, Math.abs(alongCross(g, ac.pos).cross) + 20);
    tSubjectDepClear = delay + timeToCover(dist2, 0, ktToMps(subjectPerf.accelKtPerSec));
  } else {
    tSubjectThr = dist(ac.pos, g.landingThreshold) / Math.max(ktToMps(ac.groundSpeedKt), ktToMps(30));
  }
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id) continue;
    const og = findRunwayEnd(airport, o.assignedRunwayEnd);
    if (!og || og.runway.id !== other.id) continue;
    const sO = alongCross(og, o.pos).along;
    const sInt = alongCross(og, P).along;
    const passed = sO > sInt + INTERSECTION_PASS_MARGIN_M;
    const oPerf = perfOf(o);
    const issue = (text: string): SafetyIssue => ({ kind: 'RUNWAY_CONFLICT', text, reference: REF_INTERSECTING, aircraftIds: [ac.id, o.id], runwayId: g.runway.id });
    const onSurface = o.onGround && o.occupyingRunways.includes(other.id);
    const departing = o.phase === 'LINE_UP_AND_WAIT' || o.phase === 'CLEARED_FOR_TAKEOFF' || o.phase === 'TAKEOFF_ROLL' ||
      (!o.onGround && (o.phase === 'INITIAL_CLIMB' || o.phase === 'DEPARTURE') && o.altitudeFt - airport.elevationFt < 1500 && sO < og.lengthM + 500);
    const arrivingGround = o.onGround && (o.phase === 'ROLLOUT' || o.phase === 'LANDING');
    const arrivingAir = !o.onGround && (o.phase === 'FINAL' || o.phase === 'LANDING' || !!activeClearance(o, 'LAND'));
    // an arrival cleared to land and hold short of the subject's runway never reaches the intersection
    const oHoldsShort = (activeClearance(o, 'LAND')?.holdShort ?? []).some((r) => findRunway(airport, r)?.id === g.runway.id);
    if (oHoldsShort && (arrivingAir || arrivingGround)) continue;
    if (departing && !o.isDeparture && o.phase !== 'LINE_UP_AND_WAIT') continue;
    if (departing) {
      if (passed) continue; // "has departed and passed the intersection"
      const rolling = o.phase === 'TAKEOFF_ROLL' || !o.onGround;
      const v0 = ktToMps(o.groundSpeedKt);
      const startDelay = rolling ? 0 : o.phase === 'CLEARED_FOR_TAKEOFF' && !onSurface ? lineUpTimeSec(oPerf, Math.abs(alongCross(og, o.pos).cross) + 20) : ROLL_START_DELAY_SEC;
      const tClear = startDelay + (o.onGround ? timeToCover(sInt + INTERSECTION_PASS_MARGIN_M - sO, rolling ? v0 : 0, ktToMps(oPerf.accelKtPerSec)) : (sInt + INTERSECTION_PASS_MARGIN_M - sO) / Math.max(v0, 1));
      if (kind === 'TAKEOFF') {
        out.push(issue(`${verb} for ${ac.callsign} on runway ${g.runway.id} before ${o.callsign} departing runway ${other.id} has passed the intersection (${Math.max(0, Math.round(mToFt(sInt - sO)))} ft short of it)`));
      } else if (tSubjectThr < tClear) {
        out.push(issue(`${verb} for ${ac.callsign}: it would cross the threshold of runway ${g.runway.id} in ${Math.round(tSubjectThr)} s, before ${o.callsign} departing runway ${other.id} passes the intersection (about ${Math.round(tClear)} s)`));
      }
    } else if (arrivingGround || (onSurface && o.phase === 'RUNWAY_EXIT' && !passed)) {
      if (passed) continue; // "has passed the intersection"
      if (o.phase === 'RUNWAY_EXIT' && !onSurface) continue; // clear of the landing runway
      out.push(issue(`${verb} for ${ac.callsign} on runway ${g.runway.id} while ${o.callsign} is still rolling out on runway ${other.id} and has not passed or exited before the intersection`));
    } else if (arrivingAir) {
      const tOThr = dist(o.pos, og.landingThreshold) / Math.max(ktToMps(o.groundSpeedKt), ktToMps(30));
      if (kind === 'TAKEOFF') {
        if (tOThr < tSubjectDepClear) {
          out.push(issue(`${verb} for ${ac.callsign} on runway ${g.runway.id}: ${o.callsign} would cross the threshold of runway ${other.id} in ${Math.round(tOThr)} s, before the departure passes the intersection (about ${Math.round(tSubjectDepClear)} s)`));
        }
      } else {
        // two arrivals: the one that lands first must have passed the intersection before the other crosses its threshold
        const tOPass = tOThr + (sInt + INTERSECTION_PASS_MARGIN_M) / (0.5 * ktToMps(oPerf.touchdownSpeedKt));
        const tSPass = tSubjectThr + (sSubjectInt + INTERSECTION_PASS_MARGIN_M) / (0.5 * ktToMps(subjectPerf.touchdownSpeedKt));
        if ((tOThr <= tSubjectThr && tSubjectThr < tOPass) || (tSubjectThr < tOThr && tOThr < tSPass)) {
          out.push(issue(`${verb} for ${ac.callsign} on runway ${g.runway.id}: it and ${o.callsign} (runway ${other.id}) would cross their thresholds within ${Math.round(Math.abs(tOThr - tSubjectThr))} s of each other, before the first one has passed the intersection (3-10-4)`));
        }
      }
    }
  }
  return out;
}

/**
 * 3-9-7 WAKE TURBULENCE SEPARATION FOR INTERSECTION DEPARTURES (the part that applies to the aircraft the simulator has):
 * a Category I aircraft (C172) taking off from an intersection on the same runway (same or opposite direction) behind a departing
 * Category F, G or H aircraft (the A320 is "Large": F/G) must not start its roll until at least 3 minutes after the preceding
 * aircraft took off. The pilot-requested waiver is not modelled. Intersection departure = starting more than 500 ft from the
 * runway end it is departing from. The 3-9-6 / 3-9-8 intervals (2-3 minutes) apply only behind Category A-E (super, heavy, B757):
 * none of the simulated types is, so they are not modelled; the 4/3-minute intersection intervals for A-D/E likewise.
 */
export const INTERSECTION_WAKE_INTERVAL_SEC = 180;
export const INTERSECTION_DEPARTURE_MIN_FT = 500;

function intersectionWakeIssues(state: SimulationState, ac: Aircraft, g: RunwayEndGeom): SafetyIssue[] {
  if (srsCategory(ac.type) !== 1 || perfOf(ac).wakeCategory !== 'light') return [];
  const startAlongFt = mToFt(alongCross(g, ac.pos).along);
  if (startAlongFt <= INTERSECTION_DEPARTURE_MIN_FT) return [];
  const now = state.clock.timeSec;
  const out: SafetyIssue[] = [];
  for (const ev of state.events) {
    const d = ev.data as { airborne?: boolean; runwayId?: string } | undefined;
    if (!d?.airborne || d.runwayId !== g.runway.id || !ev.aircraftId || ev.aircraftId === ac.id) continue;
    if (now + ROLL_START_DELAY_SEC - ev.timeSec >= INTERSECTION_WAKE_INTERVAL_SEC) continue;
    const prec = state.aircraft[ev.aircraftId];
    const precType = prec?.type ?? 'A320';
    if (getPerformance(precType).wakeCategory === 'light') continue; // a small aircraft ahead is not Category F, G or H
    out.push({
      kind: 'RUNWAY_CONFLICT',
      text: `Takeoff clearance for ${ac.callsign} (Category I) from an intersection (${Math.round(startAlongFt)} ft from the runway end) ${Math.round(now - ev.timeSec)} s after ${ev.callsign ?? 'a larger aircraft'} took off on runway ${g.runway.id}: hold for wake turbulence, 3 minutes required`,
      reference: REF_WAKE_INTERSECTION, aircraftIds: [ac.id, ...(prec ? [prec.id] : [])], runwayId: g.runway.id,
    });
  }
  return out;
}

/** An approach clearance must not put the aircraft on a final course within 3 nm (in trail) of another aircraft established on it. */
function assessApproachSeparation(state: SimulationState, ac: Aircraft, cmd: ParsedCommand): SafetyAssessment {
  const issues: SafetyIssue[] = [];
  const g = findRunwayEnd(state.airport, cmd.runwayEnd ?? ac.assignedRunwayEnd);
  if (!g || !cmd.approachType || ac.onGround) return { safe: true, issues };
  const a = assessApproach(state, ac, cmd.approachType, g);
  if (a.kind !== 'ok') return { safe: true, issues };
  // In-trail spacing at the moment the follower joins the course: the follower is measured at its own position when it
  // is already on the course, else at the projected join point; the leader is advanced by its groundspeed over the
  // time the follower needs to get there (floor 0).
  const gc = courseGeom(g, a.plan.courseTrue); // distances along the procedure's final approach course
  const mine = a.plan.joinDM;
  const tJoinSec = a.plan.joinTravelM / Math.max(ktToMps(ac.groundSpeedKt), ktToMps(40));
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id || o.onGround || o.isDeparture || o.assignedRunwayEnd !== g.end.id) continue;
    const { along, cross } = alongCross(gc, o.pos);
    const aligned = isOnFinal(gc, o.pos, o.headingDeg, 30) && Math.abs(cross) <= nmToM(0.5) && Math.abs(headingDiff(o.headingDeg, gc.headingDeg)) < 30;
    const established = o.phase === 'FINAL' || o.phase === 'LANDING' || aligned;
    if (!established) continue;
    const theirsNow = -along;
    const theirsAtJoin = Math.max(0, theirsNow - ktToMps(o.groundSpeedKt) * tJoinSec);
    const gapNm = mToNm(Math.abs(mine - theirsAtJoin));
    // Wake: the follower is the one farther out on the course; a light aircraft behind a medium / heavy one needs more.
    const followerIsMine = mine >= theirsAtJoin;
    const follower = followerIsMine ? ac : o;
    const leader = followerIsMine ? o : ac;
    // Aircraft in trail on the same final are "on approach" (TBL 5-5-4); the 3 NM radar minimum is the floor.
    const lc = wakeRecatCategory(leader.type);
    const fc = wakeRecatCategory(follower.type);
    const wakeNm = wakeMinimumNm(lc, fc, 'on_approach');
    const wake = wakeNm > APPROACH_IN_TRAIL_NM;
    const minNm = Math.max(APPROACH_IN_TRAIL_NM, wakeNm);
    if (gapNm < minNm) {
      issues.push({
        kind: 'AIRBORNE_PROXIMITY',
        text: `Approach clearance for ${ac.callsign} to runway ${g.end.id} puts it ${gapNm.toFixed(1)} nm ${followerIsMine ? 'in trail of' : 'ahead of'} ${o.callsign}, established on the same final (${mToNm(theirsNow).toFixed(1)} nm out now); ${wake ? `wake turbulence separation (7110.65 5-5-4, TBL 5-5-4 on approach: Category ${lc} leader, Category ${fc} follower) needs ${minNm} NM for ${follower.callsign} (${follower.type}) behind ${leader.callsign} (${leader.type})` : `radar separation minimum ${minNm} nm`}`,
        reference: wake ? REF_WAKE_SEPARATION : REF_RADAR_SEPARATION,
        aircraftIds: [ac.id, o.id],
        runwayId: g.runway.id,
      });
    }
  }
  return { safe: issues.length === 0, issues };
}

/**
 * Would issuing `cmd` create an unsafe situation given the current state?
 * Pure: reads the state only. Used by the executor before any state change.
 */
/** A takeoff / line up / landing / approach / pattern clearance onto a runway closed by NOTAM (3-3-2: "RUNWAY (number) CLOSED/UNSAFE ... UNABLE TO ISSUE ... CLEARANCE"). */
function closedRunwayIssues(state: SimulationState, ac: Aircraft, cmd: ParsedCommand): SafetyIssue[] {
  if (!['TAKEOFF', 'LINE_UP_AND_WAIT', 'LAND', 'APPROACH', 'ENTER_PATTERN'].includes(cmd.kind)) return [];
  const g = findRunwayEnd(state.airport, cmd.runwayEnd ?? cmd.runwayId ?? ac.assignedRunwayEnd);
  if (!g) return [];
  const c = activeClosures(state).find((x) => x.kind === 'RUNWAY' && x.ident === g.runway.id);
  if (!c) return [];
  const what = cmd.kind === 'TAKEOFF' ? 'Takeoff clearance' : cmd.kind === 'LINE_UP_AND_WAIT' ? 'Line up and wait' : cmd.kind === 'LAND' ? 'Landing clearance' : cmd.kind === 'APPROACH' ? 'Approach clearance' : 'Pattern clearance';
  return [{
    kind: 'UNSAFE_CLEARANCE', aircraftIds: [ac.id], runwayId: g.runway.id, reference: REF_CLOSED_RUNWAY,
    text: `${what} for ${ac.callsign} to runway ${g.end.id}, but runway ${g.runway.id} is closed (${c.reason})`,
  }];
}

export function assessClearanceSafety(state: SimulationState, cmd: ParsedCommand): SafetyAssessment {
  const issues: SafetyIssue[] = [];
  const ac = cmd.callsign ? Object.values(state.aircraft).find((a) => a.callsign.toUpperCase() === cmd.callsign!.toUpperCase()) : undefined;
  if (!ac) return { safe: true, issues };
  const { airport } = state;
  issues.push(...closedRunwayIssues(state, ac, cmd));
  if (cmd.kind === 'APPROACH') {
    const a = assessApproachSeparation(state, ac, cmd);
    const all = [...issues, ...a.issues];
    return { safe: all.length === 0, issues: all };
  }
  if (cmd.kind === 'HEADING' || cmd.kind === 'ALTITUDE') return assessMva(state, ac, cmd);
  const activity = computeRunwayActivity(state);

  if (cmd.kind === 'TAKEOFF' && isRotorcraftType(ac.type) && !findRunwayEnd(airport, cmd.runwayEnd ?? cmd.runwayId)) {
    // A helicopter lift-off (3-11-2): not while fixed-wing traffic is rolling or low near its first 4 nm.
    const bearing = cmd.headingDeg !== undefined ? magneticToTrue(cmd.headingDeg, airport.magneticVariationDeg) : ac.headingDeg;
    const fw = fixedWingNearTrack(state, helicopterTrack(ac.pos, bearing), ac.id, true);
    if (fw.length) {
      issues.push({
        kind: 'RUNWAY_CONFLICT', aircraftIds: [ac.id, ...fw.map((o) => o.id)],
        text: `Takeoff clearance for helicopter ${ac.callsign} with ${cs(state, fw.map((o) => o.id))} rolling or low within ${HELI_LATERAL_NM} nm of its departure path`, reference: REF_HELI,
      });
    }
    return { safe: issues.length === 0, issues };
  }
  let runwayId: string | undefined;
  if (cmd.kind === 'TAKEOFF' || cmd.kind === 'LINE_UP_AND_WAIT' || cmd.kind === 'LAND') {
    const g = findRunwayEnd(airport, cmd.runwayEnd ?? cmd.runwayId ?? ac.assignedRunwayEnd);
    runwayId = g?.runway.id;
  } else if (cmd.kind === 'CROSS_RUNWAY' || cmd.kind === 'PROCEED') {
    runwayId = findRunway(airport, cmd.crossRunwayId ?? cmd.runwayId ?? cmd.runwayEnd)?.id;
  } else {
    return { safe: issues.length === 0, issues };
  }
  if (!runwayId || !activity[runwayId]) return { safe: issues.length === 0, issues };
  const act = activity[runwayId];
  const others = (ids: string[]) => ids.filter((i) => i !== ac.id);

  const push = (text: string, reference: string, ids: string[], kind: SafetyIssue['kind'] = 'RUNWAY_CONFLICT') =>
    issues.push({ kind, text, reference, aircraftIds: [ac.id, ...ids], runwayId });

  if (cmd.kind === 'TAKEOFF' || cmd.kind === 'LINE_UP_AND_WAIT') {
    const verb = cmd.kind === 'TAKEOFF' ? 'Takeoff clearance' : 'Line up and wait';
    const grounded = (ids: string[]) => ids.filter((i) => state.aircraft[i]?.onGround);
    const occ = grounded(others(act.occupants)); // airborne aircraft are judged by the categorical distance below
    if (occ.length) push(`${verb} for ${ac.callsign} on runway ${runwayId} while it is occupied by ${cs(state, occ)}`, REF_SAME_RUNWAY, occ);
    const dep = grounded(others(act.departing)).filter((i) => !occ.includes(i));
    if (dep.length) push(`${verb} for ${ac.callsign} while ${cs(state, dep)} is cleared for takeoff / rolling on runway ${runwayId}`, REF_SAME_RUNWAY, dep);
    const gEnd = findRunwayEnd(airport, cmd.runwayEnd ?? cmd.runwayId ?? ac.assignedRunwayEnd);
    if (gEnd) issues.push(...airborneBlockers(state, ac, gEnd, alongCross(gEnd, ac.pos).along, verb, REF_SAME_RUNWAY));
    if (cmd.kind === 'TAKEOFF' && gEnd) {
      const trail = departureTrailConflict(state, ac, gEnd, cmd.departureHeading !== undefined ? magneticToTrue(cmd.departureHeading, airport.magneticVariationDeg) : undefined);
      if (trail) {
        push(`Takeoff clearance for ${ac.callsign} (${ac.type}) behind slower ${trail.leader.callsign} (${trail.leader.type}), ${trail.leaderAlongNm.toFixed(1)} nm out on the same track: it would close to ${Math.max(0, trail.minGapNm).toFixed(1)} nm before the leader is ${DEPARTURE_TRAIL_RANGE_NM} nm out; 3-9-6 / 5-8-3 need ${DEPARTURE_TRAIL_NM} nm, a departure interval or diverging courses`, REF_SAME_RUNWAY, [trail.leader.id]);
      }
    }
    const lu = others(act.lineUp).filter((i) => !occ.includes(i));
    if (lu.length) push(`${verb} for ${ac.callsign} while ${cs(state, lu)} is in position on runway ${runwayId}`, REF_SAME_RUNWAY, lu);
    const crossing = others(act.crossing).filter((i) => !occ.includes(i));
    if (crossing.length) push(`${verb} for ${ac.callsign} while ${cs(state, crossing)} is cleared to cross runway ${runwayId}`, REF_TAXI, crossing);
    // an arrival in the flare / over the runway surface (any height) is on the runway for the departure rules, however far past the threshold
    const rwy = airport.runways.find((r) => r.id === runwayId);
    const over = rwy ? arrivalsOverRunway(state, rwy, ac.id).filter((o) => !occ.includes(o.id)) : [];
    if (over.length) push(`${verb} for ${ac.callsign} while ${over.map((o) => o.callsign).join(', ')} is landing over runway ${runwayId}`, REF_LANDING, over.map((o) => o.id));
    if (cmd.kind === 'TAKEOFF') {
      const arr = arrivalsOnFinal(state, runwayId, FINAL_TAKEOFF_NM, ac.id);
      if (arr.length) {
        const a = arr[0];
        const g = findRunwayEnd(airport, a.assignedRunwayEnd);
        const nm = g ? mToNm(dist(a.pos, g.end.threshold)).toFixed(1) : '?';
        push(`Takeoff clearance for ${ac.callsign} with ${a.callsign} on ${nm} nm final for runway ${runwayId}`, REF_LANDING, [a.id]);
      }
    }
  } else if (cmd.kind === 'LAND') {
    // 3-10-3: not across the threshold until the other aircraft has landed and is clear of the runway (unless the daylight
    // distance exception for a landed aircraft applies, `landedDistanceExceptionApplies`), or has departed and crossed the runway end / is airborne
    // the categorical distance ahead of the landing threshold (checked below).
    const gLand = findRunwayEnd(airport, cmd.runwayEnd ?? cmd.runwayId ?? ac.assignedRunwayEnd);
    const occ = others(act.occupants).filter((i) => state.aircraft[i]?.onGround && !(gLand && landedDistanceExceptionApplies(state, ac, state.aircraft[i], gLand)));
    if (occ.length) push(`Landing clearance for ${ac.callsign} on runway ${runwayId} while it is occupied by ${cs(state, occ)}`, REF_LANDING, occ);
    const dep = others(act.departing).filter((i) => !occ.includes(i) && state.aircraft[i]?.onGround);
    if (dep.length) push(`Landing clearance for ${ac.callsign} while ${cs(state, dep)} is cleared for takeoff / rolling on runway ${runwayId}`, REF_LANDING, dep);
    const gEnd = findRunwayEnd(airport, cmd.runwayEnd ?? cmd.runwayId ?? ac.assignedRunwayEnd);
    if (gEnd) issues.push(...airborneBlockers(state, ac, gEnd, 0, 'Landing clearance', REF_LANDING));
    const lu = others(act.lineUp).filter((i) => !occ.includes(i));
    if (lu.length) push(`Landing clearance for ${ac.callsign} while ${cs(state, lu)} is in position on runway ${runwayId}`, REF_LANDING, lu);
    const crossing = others(act.crossing).filter((i) => !occ.includes(i));
    if (crossing.length) push(`Landing clearance for ${ac.callsign} while ${cs(state, crossing)} is cleared to cross runway ${runwayId}`, REF_TAXI, crossing);
    if (gLand) issues.push(...precedingArrivalIssues(state, ac, gLand));
  } else if (cmd.kind === 'PROCEED') {
    // A vehicle onto a runway (JO 7110.65 3-1-3, 3-7-2): the runway and the runways it may cross must be free of aircraft, nothing departing, in position or
    // landing, and no arrival close.
    for (const rid of [runwayId, ...crossingRunways(airport, runwayId).map((r) => r.id)]) {
      const a2 = activity[rid];
      if (!a2) continue;
      const occ = others(a2.occupants);
      if (occ.length) push(`Vehicle ${ac.callsign} sent onto runway ${runwayId} while runway ${rid} is occupied by ${cs(state, occ)}`, REF_TAXI, occ);
      const dep = others([...a2.departing, ...a2.lineUp, ...a2.landing]).filter((i) => !occ.includes(i));
      if (dep.length) push(`Vehicle ${ac.callsign} sent onto runway ${runwayId} while ${cs(state, dep)} is departing / in position / landing on runway ${rid}`, REF_TAXI, dep);
      const near = arrivalsOnFinal(state, rid, FINAL_PROCEED_NM, ac.id).filter((a) => !occ.includes(a.id));
      const rw = airport.runways.find((r) => r.id === rid);
      const pattern = Object.values(state.aircraft).filter((o) => o.id !== ac.id && !o.onGround && o.phase === 'PATTERN' && rw && rw.ends.some((e) => e.id === o.assignedRunwayEnd));
      const all = [...near, ...pattern];
      if (all.length) push(`Vehicle ${ac.callsign} sent onto runway ${runwayId} with ${cs(state, all.map((x) => x.id))} landing / in the pattern for runway ${rid}`, REF_TAXI, all.map((x) => x.id));
    }
  } else if (cmd.kind === 'CROSS_RUNWAY') {
    const occ = others(act.occupants);
    if (occ.length) push(`Crossing clearance for ${ac.callsign} over runway ${runwayId} while it is occupied by ${cs(state, occ)}`, REF_TAXI, occ);
    const dep = others([...act.departing, ...act.lineUp]).filter((i) => !occ.includes(i));
    if (dep.length) push(`Crossing clearance for ${ac.callsign} over runway ${runwayId} while ${cs(state, dep)} is departing / in position`, REF_TAXI, dep);
    const landing = arrivalsOnFinal(state, runwayId, FINAL_CROSSING_NM, ac.id).filter((a) => !occ.includes(a.id));
    const rolling = others(act.landing).filter((i) => state.aircraft[i]?.onGround && !occ.includes(i));
    if (landing.length || rolling.length) {
      const ids = [...landing.map((a) => a.id), ...rolling];
      push(`Crossing clearance for ${ac.callsign} over runway ${runwayId} with ${cs(state, ids)} landing`, REF_TAXI, ids);
    }
    const crossed = airport.runways.find((r) => r.id === runwayId);
    if (crossed) issues.push(...crossingTrafficIssues(state, ac, crossed));
  }

  // Intersecting runways (e.g. 13/31 and 4/22): JO 7110.65 3-9-8 (departures) and 3-10-4 (arrivals).
  if (cmd.kind === 'TAKEOFF' || cmd.kind === 'LAND') {
    const gEnd = findRunwayEnd(airport, cmd.runwayEnd ?? cmd.runwayId ?? ac.assignedRunwayEnd);
    // Land and hold short (3-10-4 / 3-10-5): the clearance names the intersecting runway to hold short of, so the arrival is not
    // required to have the other runway's traffic clear of the intersection; the hold-short itself is validated by the executor.
    const holdShortIds = cmd.kind === 'LAND' ? (cmd.holdShort ?? []).map((r) => findRunway(airport, r)?.id) : [];
    if (gEnd) {
      for (const other of crossingRunways(airport, runwayId)) {
        if (holdShortIds.includes(other.id)) continue;
        issues.push(...intersectingIssues(state, ac, cmd.kind, gEnd, other));
        issues.push(...crossingAgainstIssues(state, ac, cmd.kind, gEnd, other, activity));
      }
    }
  }
  // A helicopter low near the departure track / final approach course (helicopterSeparation.ts): the clearance waits until it has passed.
  if (cmd.kind === 'TAKEOFF' || cmd.kind === 'LAND') {
    const gH = findRunwayEnd(airport, cmd.runwayEnd ?? cmd.runwayId ?? ac.assignedRunwayEnd);
    if (gH && !isRotorcraftType(ac.type)) {
      const heli = lowHelicoptersNearTrack(state, cmd.kind === 'TAKEOFF' ? runwayDepartureTrack(gH) : runwayFinalTrack(gH), ac.id);
      if (heli.length) {
        issues.push({
          kind: 'RUNWAY_CONFLICT', aircraftIds: [ac.id, ...heli.map((h) => h.id)], runwayId,
          text: `${cmd.kind === 'TAKEOFF' ? 'Takeoff' : 'Landing'} clearance for ${ac.callsign} with ${cs(state, heli.map((h) => h.id))} hovering / flying low within ${HELI_LATERAL_NM} nm of the ${cmd.kind === 'TAKEOFF' ? 'departure path' : 'final approach course'} of runway ${gH.end.id}`,
          reference: REF_HELI,
        });
      }
    }
  }
  // Wake turbulence time interval for an intersection departure (3-9-7).
  if (cmd.kind === 'TAKEOFF') {
    const gEnd = findRunwayEnd(airport, cmd.runwayEnd ?? cmd.runwayId ?? ac.assignedRunwayEnd);
    if (gEnd) issues.push(...intersectionWakeIssues(state, ac, gEnd));
  }
  return { safe: issues.length === 0, issues };
}


// ---------------------------------------------------------------------------
// Arrival behind an arrival (3-10-3), airborne arrivals over the runway, crossings against intersecting-runway traffic
// ---------------------------------------------------------------------------

const ARRIVAL_CLEAR_MARGIN_SEC = 3;
const CROSSING_MARGIN_SEC = 4;
/** Lateral offset beyond which an arrival is not on the final of the runway (pattern / other approach). */
const FINAL_LATERAL_M = 900;

// (A departure is never an arrival: an aircraft that landed, taxied back for another takeoff - pilot request TAXI_BACK - and is climbing out still carries its first
// landing clearance as "active", and counted as a preceding arrival "landing in 3 minutes" for every real arrival behind it, which then went around: soak seed 3,
// 40 go-arounds and an hour of circling.)
const isArriving = (o: Aircraft): boolean => !o.onGround && !o.isDeparture && (o.phase === 'FINAL' || o.phase === 'LANDING' || !!activeClearance(o, 'LAND'));

/** Airborne arrivals (LANDING / FINAL / cleared to land) that are over the surface of the runway: they occupy it for the departure rules. */
function arrivalsOverRunway(state: SimulationState, rw: Runway, excludeId: string): Aircraft[] {
  return Object.values(state.aircraft).filter(
    (o) => o.id !== excludeId && !o.onGround && isArriving(o) && findRunwayEnd(state.airport, o.assignedRunwayEnd)?.runway.id === rw.id && pointInPolygon(o.pos, rw.polygon),
  );
}

/**
 * JO 7110.65 3-10-3 for an arrival behind a preceding ARRIVAL that is still airborne on the same final: "ensuring that the arriving
 * aircraft does not cross the landing threshold until ... the other aircraft has landed and is clear of the runway" (or, by day, is the
 * categorical distance down the runway). Judged at the clearance by projecting both aircraft (`runwayTiming.projectArrival`): the
 * preceding aircraft's threshold crossing, touchdown and rollout / exit time against the follower's projected threshold crossing,
 * with a 3 s margin.
 */
/** A pattern aircraft whose heading is within this many degrees of the runway heading is on its final (DESIGN VALUE; base is 90 degrees off, downwind 180). */
const PATTERN_FINAL_HEADING_DEG = 40;

export function precedingArrivalBlockers(state: SimulationState, ac: Aircraft, g: RunwayEndGeom): { other: Aircraft; tMine: number; tTd: number; tClear: number }[] {
  const out: { other: Aircraft; tMine: number; tTd: number; tClear: number }[] = [];
  if (ac.onGround) return out;
  const myAlong = alongCross(g, ac.pos).along;
  const tMine = timeToThreshold(ac, g);
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id || o.onGround || o.assignedRunwayEnd !== g.end.id || !isArriving(o)) continue;
    const { along, cross } = alongCross(g, o.pos);
    if (along <= myAlong || Math.abs(cross) > FINAL_LATERAL_M) continue; // behind the subject: it is the follower
    // A pattern aircraft that is not on its final (on the upwind / crosswind / downwind leg abeam the runway, heading some other way) is not "ahead on the same final": it lands
    // only after the turn to base and final, and the sequencer (ai/sequence.ts) places it there. Counting it as landing now sent the aircraft behind it around (soak seed 6:
    // "N9001T ahead on the same final lands in 172 s" with N9001T on a 0.9 nm downwind).
    if (o.phase === 'PATTERN' && Math.abs(headingDiff(o.headingDeg, g.headingDeg)) > PATTERN_FINAL_HEADING_DEG) continue;
    const proj = projectArrival(state, o, g);
    if (tMine >= proj.tClear + ARRIVAL_CLEAR_MARGIN_SEC) continue; // landed and clear when the follower crosses the threshold
    if (tMine >= proj.tTd && landedExceptionHolds(state, ac, o, proj.alongAt(tMine) - g.displacedM - perfOf(o).lengthM / 2)) continue; // by day, 3,000 / 4,500 ft down the runway
    out.push({ other: o, tMine, tTd: proj.tTd, tClear: proj.tClear });
  }
  return out;
}

function precedingArrivalIssues(state: SimulationState, ac: Aircraft, g: RunwayEndGeom): SafetyIssue[] {
  return precedingArrivalBlockers(state, ac, g).map(({ other: o, tMine, tTd, tClear }) => ({
    kind: 'RUNWAY_CONFLICT' as const,
    text: `Landing clearance for ${ac.callsign}: it would cross the threshold of runway ${g.end.id} in ${Math.round(tMine)} s, but ${o.callsign} ahead on the same final ` +
      `lands in ${Math.round(tTd)} s and is not clear of the runway until about ${Math.round(tClear)} s (3-10-3: no crossing of the threshold until it has landed and is clear)`,
    reference: REF_LANDING, aircraftIds: [ac.id, o.id], runwayId: g.runway.id,
  }));
}

/** The path (aircraft position, then route nodes) over which `ac` crosses runway `rw`: from its hold, over the runway nodes, to the far hold. */
export function crossingPath(state: SimulationState, ac: Aircraft, rw: Runway): Vec2[] | undefined {
  const route = ac.route;
  if (!route) return undefined;
  const graph = state.airport.taxiwayGraph;
  const path: Vec2[] = [ac.pos];
  let sawRunway = false;
  let started = false;
  for (let i = Math.max(0, route.progressIndex - 1); i < route.nodeIds.length && path.length < 14; i++) {
    const n = graph.nodes[route.nodeIds[i]];
    if (!n) continue;
    const isHold = n.kind === 'holding_position' && n.runwayId === rw.id;
    if (!started && !isHold && !(n.kind === 'runway' && n.runwayId === rw.id)) continue; // before the near hold
    started = true;
    path.push(n.pos);
    if (n.kind === 'runway' && n.runwayId === rw.id) sawRunway = true;
    if (isHold && sawRunway) return path;
  }
  return started && sawRunway ? path : undefined;
}

/** Does the subject's movement (`timeAtAlong`, seconds to reach `s` m along the runway) overlap the crossing window at `sX`? */
function overlapsCrossing(timeAtAlong: (s: number) => number, sX: number, win: { tEnter: number; tLeave: number }, lenM: number): boolean {
  const tArrive = timeAtAlong(sX - 45);
  const tPassed = timeAtAlong(sX + 45 + lenM);
  return tArrive < win.tLeave + CROSSING_MARGIN_SEC && tPassed > win.tEnter - CROSSING_MARGIN_SEC;
}

/** Seconds for a departure to reach `s` m along its runway (rolling, or cleared and not yet rolling); Infinity if not departing. */
function departureTimeAtAlong(state: SimulationState, o: Aircraft, og: RunwayEndGeom): ((s: number) => number) | undefined {
  const rolling = o.phase === 'TAKEOFF_ROLL';
  if (!(rolling || o.phase === 'CLEARED_FOR_TAKEOFF')) return undefined;
  const perf = perfOf(o);
  const sO = alongCross(og, o.pos).along;
  const onSurface = o.occupyingRunways.includes(og.runway.id);
  const delay = rolling ? 0 : !onSurface ? lineUpTimeSec(perf, Math.abs(alongCross(og, o.pos).cross) + 20) : ROLL_START_DELAY_SEC;
  const v0 = rolling ? ktToMps(o.groundSpeedKt) : 0;
  void state;
  return (s) => (s <= sO ? 0 : delay + timeToCover(s - sO, v0, ktToMps(perf.accelKtPerSec)));
}

/**
 * Traffic on runway `q` against a window (seconds from now) during which an aircraft occupies the part of `q` it crosses. Departures
 * rolling / cleared, arrivals rolling out or on short final (projected touchdown and rollout), and aircraft standing on the surface
 * there all count. `win.enterAt` is where the crossing aircraft first meets the surface of `q`.
 */
function trafficOnRunwayIssues(state: SimulationState, subject: Aircraft, q: Runway, win: { tEnter: number; tLeave: number; enterAt: Vec2 }, verb: string, reference: string): SafetyIssue[] {
  const out: SafetyIssue[] = [];
  for (const o of Object.values(state.aircraft)) {
    if (o.id === subject.id) continue;
    const og = findRunwayEnd(state.airport, o.assignedRunwayEnd);
    if (!og || og.runway.id !== q.id) continue;
    const sX = alongCross(og, win.enterAt).along;
    const len = perfOf(o).lengthM;
    const issue = (what: string): SafetyIssue => ({
      kind: 'RUNWAY_CONFLICT', reference, aircraftIds: [subject.id, o.id], runwayId: q.id,
      text: `${verb} for ${subject.callsign}: it would be on the crossed runway from about ${Math.round(win.tEnter)} to ${Math.round(win.tLeave)} s, while ${o.callsign} ${what}`,
    });
    const dep = departureTimeAtAlong(state, o, og);
    if (dep) {
      if (overlapsCrossing(dep, sX, win, len)) out.push(issue(`is ${o.phase === 'TAKEOFF_ROLL' ? 'rolling' : 'cleared for takeoff'} on runway ${q.id} and reaches the intersection in about ${Math.round(dep(sX - 45))} s`));
      continue;
    }
    if (o.onGround && (o.phase === 'ROLLOUT' || o.phase === 'LANDING')) {
      const proj = projectArrival(state, o, og);
      if (overlapsCrossing(proj.timeAtAlong, sX, win, len)) out.push(issue(`is rolling out on runway ${q.id} and reaches the intersection in about ${Math.round(proj.timeAtAlong(sX - 45))} s`));
      continue;
    }
    if (isArriving(o)) {
      const { along, cross } = alongCross(og, o.pos);
      if (Math.abs(cross) > FINAL_LATERAL_M || along > sX + 45 + len || -along > nmToM(3)) continue;
      const proj = projectArrival(state, o, og);
      if (overlapsCrossing(proj.timeAtAlong, sX, win, len)) out.push(issue(`is ${along < 0 ? `on ${mToNm(-along).toFixed(1)} nm final` : 'landing'} for runway ${og.end.id} and reaches the intersection in about ${Math.round(proj.timeAtAlong(sX - 45))} s`));
      continue;
    }
    // standing on the surface in the way (lined up, stopped on the runway)
    if (o.onGround && o.groundSpeedKt < 1 && o.occupyingRunways.includes(q.id)) {
      const sO = alongCross(og, o.pos).along;
      if (Math.abs(sO - sX) < 45 + len) out.push(issue(`is standing on runway ${q.id} at that point`));
    }
  }
  return out;
}

/**
 * Crossing clearance against traffic on the runways that intersect the one being crossed (JO 7110.65 3-9-8 / 3-10-4 logic applied to
 * the crossing aircraft): the aircraft must be able to clear the intersecting runway's surface before any aircraft using it (departing
 * roll, landing rollout, arrival on short final) reaches the crossing point. The crossing path is the aircraft's own route over the runway.
 */
function crossingTrafficIssues(state: SimulationState, ac: Aircraft, rw: Runway): SafetyIssue[] {
  const path = crossingPath(state, ac, rw);
  if (!path) return [];
  const out: SafetyIssue[] = [];
  for (const q of crossingRunways(state.airport, rw.id)) {
    // The crossing aircraft is on the surface of `rw` for a window; traffic on `q` is on that same surface when it passes the point
    // where the two runways cross (it rolls through the intersection), so it must not get there inside the window.
    const p = runwayIntersection(rw, q);
    const win = p && surfaceWindow(path, rw.polygon, ac.type, CROSSING_WINGTIP_M, CROSSING_START_DELAY_SEC);
    if (win && p) out.push(...trafficOnRunwayIssues(state, ac, q, { ...win, enterAt: p }, `Crossing clearance over runway ${rw.id}`, REF_INTERSECTING));
  }
  return out;
}
const CROSSING_START_DELAY_SEC = 3;
/** The crossing aircraft counts as on the runway this far (m) before its edge (nose, wingtips). */
const CROSSING_WINGTIP_M = 10;

/** The reverse: a takeoff / landing on `g` against aircraft already cleared across the runway `other` that intersects it. */
function crossingAgainstIssues(state: SimulationState, ac: Aircraft, kind: 'TAKEOFF' | 'LAND', g: RunwayEndGeom, other: Runway, activity: Record<string, { crossing: string[] }>): SafetyIssue[] {
  const out: SafetyIssue[] = [];
  const verb = kind === 'TAKEOFF' ? 'Takeoff clearance' : 'Landing clearance';
  for (const id of activity[other.id]?.crossing ?? []) {
    const o = state.aircraft[id];
    if (!o || o.id === ac.id) continue;
    const path = crossingPath(state, o, other);
    if (!path) continue;
    const p = runwayIntersection(g.runway, other);
    const win = p && surfaceWindow(path, other.polygon, o.type, CROSSING_WINGTIP_M, 0);
    if (!win || !p) continue;
    const sX = alongCross(g, p).along;
    const len = perfOf(o).lengthM;
    let timeAt: (s: number) => number;
    if (kind === 'LAND') timeAt = projectArrival(state, ac, g).timeAtAlong;
    else {
      const perf = perfOf(ac);
      const sO = alongCross(g, ac.pos).along;
      const delay = ac.phase === 'LINE_UP_AND_WAIT' ? ROLL_START_DELAY_SEC : lineUpTimeSec(perf, Math.abs(alongCross(g, ac.pos).cross) + 20);
      timeAt = (s) => (s <= sO ? 0 : delay + timeToCover(s - sO, 0, ktToMps(perf.accelKtPerSec)));
    }
    if (overlapsCrossing(timeAt, sX, win, len)) {
      out.push({
        kind: 'RUNWAY_CONFLICT', reference: REF_INTERSECTING, aircraftIds: [ac.id, o.id], runwayId: g.runway.id,
        text: `${verb} for ${ac.callsign} on runway ${g.runway.id}: ${o.callsign} is cleared across runway ${other.id} and is on its surface from about ${Math.round(win.tEnter)} to ${Math.round(win.tLeave)} s, when ${ac.callsign} reaches the intersection`,
      });
    }
  }
  return out;
}

/**
 * Record an unsafe clearance: a RUNWAY_CONFLICT/UNSAFE_CLEARANCE alert pair and events.
 * `prevented` = true in training mode (the clearance was refused).
 */
export function recordUnsafeClearance(ctx: SimContext, ac: Aircraft, assessment: SafetyAssessment, prevented: boolean): void {
  const now = ctx.state.clock.timeSec;
  for (const issue of assessment.issues) {
    if (issue.kind === 'UNSAFE_CLEARANCE') {
      // not tied to a runway / proximity alert: only the unsafe-clearance alert and event
      const unsafe: ConflictAlert = { id: `cf-${++ctx.alertSeq}`, kind: 'UNSAFE_CLEARANCE', aircraftIds: issue.aircraftIds, text: `Unsafe clearance: ${issue.text} [${issue.reference}]`, severity: 'critical', sinceSec: now };
      ctx.clearanceAlerts.push({ alert: unsafe, expiresAtSec: now + 90 });
      refreshConflicts(ctx);
      emitEvent(ctx, {
        kind: 'CONFLICT', aircraftId: ac.id, callsign: ac.callsign, severity: 'critical', speaker: 'SYSTEM',
        text: `${prevented ? 'Unsafe clearance prevented' : 'Unsafe clearance issued'}: ${issue.text}`,
        data: { alertKind: 'UNSAFE_CLEARANCE', reference: issue.reference, prevented },
      });
      continue;
    }
    const alert: ConflictAlert = {
      id: `cf-${++ctx.alertSeq}`,
      kind: issue.kind,
      aircraftIds: issue.aircraftIds,
      runwayId: issue.runwayId,
      text: issue.text,
      severity: 'critical',
      sinceSec: now,
    };
    const unsafe: ConflictAlert = { ...alert, id: `cf-${++ctx.alertSeq}`, kind: 'UNSAFE_CLEARANCE', text: `Unsafe clearance: ${issue.text} [${issue.reference}]` };
    ctx.clearanceAlerts.push({ alert, expiresAtSec: now + 90 }, { alert: unsafe, expiresAtSec: now + 90 });
    refreshConflicts(ctx);
    emitEvent(ctx, {
      kind: 'CONFLICT', aircraftId: ac.id, callsign: ac.callsign, severity: 'critical', speaker: 'SYSTEM',
      text: issue.text, data: { alertKind: 'RUNWAY_CONFLICT', runwayId: issue.runwayId, reference: issue.reference, prevented },
    });
    emitEvent(ctx, {
      kind: 'CONFLICT', aircraftId: ac.id, callsign: ac.callsign, severity: 'critical', speaker: 'SYSTEM',
      text: `${prevented ? 'Unsafe clearance prevented' : 'Unsafe clearance issued'}: ${issue.text}`,
      data: { alertKind: 'UNSAFE_CLEARANCE', runwayId: issue.runwayId, reference: issue.reference, prevented },
    });
  }
}

// ---------------------------------------------------------------------------
// Per-tick detection
// ---------------------------------------------------------------------------

interface Candidate {
  key: string;
  alert: Omit<ConflictAlert, 'id' | 'sinceSec'>;
}

export const GROUND_PROXIMITY_M = 30;
/** The normal following distance of the taxi model (`groundMovement.findLeader`): 1.5 x the longer aircraft + 20 m. */
/** A formation of N aircraft is handled as one aircraft (JO 7110.65 2-1-13) that is N lengths long. */
export const followingDistanceM = (a: Aircraft, b: Aircraft): number =>
  1.5 * Math.max(perfOf(a).lengthM * (a.formation?.size ?? 1), perfOf(b).lengthM * (b.formation?.size ?? 1)) + 20;
/** Alert when an aircraft is closer than its following target by 20% (0.8 x), but never at more than 30 m. */
/** A vehicle (5.5 m, driven by an operator who sees the aircraft) passes closer than two aeroplanes may: its alert distance is 5 m (design value). */
export const VEHICLE_PROXIMITY_M = 5;
export const groundProximityM = (a: Aircraft, b: Aircraft): number =>
  Math.min(GROUND_PROXIMITY_M, 0.8 * followingDistanceM(a, b), isVehicleType(a.type) || isVehicleType(b.type) ? VEHICLE_PROXIMITY_M : Infinity);
/** Two aircraft standing still one behind the other in the same queue (holding short / waiting to taxi): not a proximity event. */
function sameQueue(state: SimulationState, a: Aircraft, b: Aircraft): boolean {
  const q = (x: Aircraft) => x.groundSpeedKt < 1 && (x.phase === 'TAXIING' || x.phase === 'HOLDING_SHORT' || x.phase === 'READY') && x.occupyingRunways.length === 0;
  // A follower still rolling into its place in the queue (slower than QUEUE_CREEP_KT) behind a stopped leader is queueing, not a proximity event.
  const creeping = (x: Aircraft) => x.groundSpeedKt < QUEUE_CREEP_KT && (x.phase === 'TAXIING' || x.phase === 'HOLDING_SHORT') && x.occupyingRunways.length === 0;
  void state;
  if (Math.abs(headingDiff(a.headingDeg, b.headingDeg)) >= 60) return false;
  return (q(a) && q(b)) || (q(a) && creeping(b)) || (creeping(a) && q(b));
}
const QUEUE_CREEP_KT = 8;

/** Parked, shut down, or standing still on a parking position (stands can be closer than 30 m). */
function parkedLike(state: SimulationState, ac: Aircraft): boolean {
  if (ac.phase === 'PARKED' || ac.phase === 'ARRIVED') return true;
  return ac.groundSpeedKt < 0.1 && state.airport.parking.some((p) => dist(p.pos, ac.pos) < 8);
}
/**
 * Minimum vectoring altitude, JO 7110.65 5-6-1: "Vector aircraft ... At or above the MVA or the minimum IFR altitude except as
 * authorized for radar approaches, radar departures, special VFR, VFR operations, or by paragraph 5-6-3". An ALTITUDE assignment
 * below the MVA of the sector the aircraft is in, or of one it enters within 2 nm along its track, or a HEADING that points it into
 * airspace whose MVA is above its altitude at its present (or lower assigned) altitude, is unsafe. Exempt: see `mvaExempt`. Does nothing when
 * the airport has no `mvaSectors`.
 */
function assessMva(state: SimulationState, ac: Aircraft, cmd: ParsedCommand): SafetyAssessment {
  const issues: SafetyIssue[] = [];
  const airport = state.airport;
  if (!airport.mvaSectors?.length || mvaExempt(ac)) return { safe: true, issues };
  const lookahead = (trackTrue: number) => highestMvaAhead(airport, ac.pos, trackTrue);
  if (cmd.kind === 'ALTITUDE' && cmd.altitudeFt !== undefined) {
    const mva = lookahead(ac.trackDeg);
    if (mva && cmd.altitudeFt < mva.altitudeFt) {
      issues.push({
        kind: 'UNSAFE_CLEARANCE', aircraftIds: [ac.id], reference: REF_MVA,
        text: `Altitude ${cmd.altitudeFt} ft for ${ac.callsign} is below the minimum vectoring altitude of ${mva.altitudeFt} ft (MVA sector ${mva.sectorId}, its sector now or one it enters within ${MVA_LOOKAHEAD_NM} nm)`,
      });
    }
  } else if (cmd.kind === 'HEADING' && cmd.headingDeg !== undefined) {
    const altitude = Math.min(ac.altitudeFt, ac.target.altitudeFt ?? ac.altitudeFt);
    const mva = lookahead(magneticToTrue(cmd.headingDeg, airport.magneticVariationDeg));
    if (mva && altitude < mva.altitudeFt) {
      issues.push({
        kind: 'UNSAFE_CLEARANCE', aircraftIds: [ac.id], reference: REF_MVA,
        text: `Heading ${Math.round(cmd.headingDeg)} for ${ac.callsign} at ${Math.round(altitude)} ft would put it below the minimum vectoring altitude of ${mva.altitudeFt} ft (MVA sector ${mva.sectorId}, within ${MVA_LOOKAHEAD_NM} nm)`,
      });
    }
  }
  return { safe: issues.length === 0, issues };
}

/** Near-miss ALERT thresholds (not the separation minimum: the radar minimum is 3 nm, see REF_RADAR_SEPARATION). */
export const AIRBORNE_PROXIMITY_NM = 1.5;
export const AIRBORNE_PROXIMITY_FT = 500;

export function detectConflicts(ctx: SimContext): void {
  const { state } = ctx;
  const now = state.clock.timeSec;
  const candidates: Candidate[] = [];
  const list = Object.values(state.aircraft);
  const { airport } = state;

  // Runway incursions: taxiing / holding aircraft on a runway without authorisation.
  for (const ac of list) {
    if (!ac.onGround || !TAXI_PHASES.includes(ac.phase)) continue;
    for (const rw of airport.runways) {
      if (!pointInPolygon(ac.pos, rw.polygon)) continue;
      if (ac.runwayAuthorizations.includes(rw.id)) continue;
      if (ac.phase === 'RUNWAY_EXIT' && findRunwayEnd(airport, ac.assignedRunwayEnd)?.runway.id === rw.id) continue;
      candidates.push({
        key: `INC:${ac.id}:${rw.id}`,
        alert: { kind: 'RUNWAY_INCURSION', aircraftIds: [ac.id], runwayId: rw.id, text: `${ac.callsign} is on runway ${rw.id} without a clearance`, severity: 'critical' },
      });
    }
  }

  // Land and hold short: the nose passing the published hold-short point is an incursion of the other runway (JO 7110.65 3-10-5).
  for (const ac of list) {
    const lahso = ctx.runtime.get(ac.id)?.lahso;
    if (!lahso || !ac.onGround || ac.phase !== 'ROLLOUT') continue;
    const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
    if (!g) continue;
    const noseAlong = alongCross(g, ac.pos).along + perfOf(ac).lengthM / 2;
    if (noseAlong <= lahso.holdShortAlongM) continue;
    candidates.push({
      key: `INC:${ac.id}:${lahso.holdShortRunwayId}`,
      alert: { kind: 'RUNWAY_INCURSION', aircraftIds: [ac.id], runwayId: lahso.holdShortRunwayId, text: `${ac.callsign} did not hold short of runway ${lahso.holdShortRunwayId} after a land and hold short clearance`, severity: 'critical' },
    });
  }

  // Two or more aircraft on a runway surface while one of them is operating at speed.
  const activity = computeRunwayActivity(state);
  for (const rid of Object.keys(activity)) {
    const act = activity[rid];
    // A departure that is already climbing out is judged by the categorical same-runway distance (3-9-6) at clearance time,
    // so it is not a "surface" conflict here (anticipating separation, 3-9-5).
    const surface = act.occupants.filter((i) => {
      const a = state.aircraft[i];
      return !!a && (a.onGround || !(a.phase === 'INITIAL_CLIMB' || a.phase === 'DEPARTURE'));
    });
    act.occupants = surface;
    if (act.occupants.length < 2) continue;
    const moving = act.occupants.filter((i) => {
      const a = state.aircraft[i];
      return a && (a.groundSpeedKt > 25 || a.phase === 'TAKEOFF_ROLL' || a.phase === 'ROLLOUT');
    });
    if (!moving.length) continue;
    const ids = [...act.occupants].sort();
    candidates.push({
      key: `RWC:${rid}:${ids.join('+')}`,
      alert: { kind: 'RUNWAY_CONFLICT', aircraftIds: ids, runwayId: rid, text: `Runway ${rid}: ${cs(state, ids)} on the surface with high-speed traffic`, severity: 'critical' },
    });
  }

  // Proximity.
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const d = dist(a.pos, b.pos);
      if (a.onGround && b.onGround) {
        if (parkedLike(state, a) || parkedLike(state, b)) continue;
        if (d < groundProximityM(a, b) && !(d >= 15 && sameQueue(state, a, b))) {
          candidates.push({
            key: `GND:${[a.id, b.id].sort().join('+')}`,
            alert: { kind: 'GROUND_PROXIMITY', aircraftIds: [a.id, b.id], text: `${a.callsign} and ${b.callsign} are ${Math.round(d)} m apart on the ground`, severity: d < 15 ? 'critical' : 'warning' },
          });
        }
      } else if (!a.onGround && !b.onGround) {
        const dv = Math.abs(a.altitudeFt - b.altitudeFt);
        if (d < nmToM(AIRBORNE_PROXIMITY_NM) && dv < AIRBORNE_PROXIMITY_FT) {
          candidates.push({
            key: `AIR:${[a.id, b.id].sort().join('+')}`,
            alert: {
              kind: 'AIRBORNE_PROXIMITY', aircraftIds: [a.id, b.id],
              text: `Near-miss alert: ${a.callsign} and ${b.callsign}: ${mToNm(d).toFixed(1)} nm, ${Math.round(dv)} ft`,
              severity: d < nmToM(0.5) && dv < 200 ? 'critical' : 'warning',
            },
          });
        }
      }
    }
  }

  // Diff against the active set: emit events only when an alert first appears.
  const seen = new Set<string>();
  for (const c of candidates) {
    seen.add(c.key);
    if (ctx.dynamicAlerts.has(c.key)) {
      const cur = ctx.dynamicAlerts.get(c.key)!;
      cur.text = c.alert.text;
      cur.severity = c.alert.severity;
      continue;
    }
    const alert: ConflictAlert = { id: `cf-${++ctx.alertSeq}`, sinceSec: now, ...c.alert };
    ctx.dynamicAlerts.set(c.key, alert);
    const first = state.aircraft[alert.aircraftIds[0]];
    const base = { aircraftId: first?.id, callsign: first?.callsign, text: alert.text, severity: alert.severity, speaker: 'SYSTEM' as const };
    if (alert.kind === 'RUNWAY_INCURSION') emitEvent(ctx, { ...base, kind: 'RUNWAY_INCURSION', data: { runwayId: alert.runwayId, alertId: alert.id } });
    else if (alert.kind === 'RUNWAY_CONFLICT') emitEvent(ctx, { ...base, kind: 'CONFLICT', data: { alertKind: 'RUNWAY_CONFLICT', runwayId: alert.runwayId, alertId: alert.id } });
    else emitEvent(ctx, { ...base, kind: 'SEPARATION_VIOLATION', data: { alertKind: alert.kind, alertId: alert.id } });
  }
  for (const key of [...ctx.dynamicAlerts.keys()]) if (!seen.has(key)) ctx.dynamicAlerts.delete(key);

  refreshConflicts(ctx);
}

/** Rebuild `state.conflicts` from the active clearance-origin and dynamic alerts. */
export function refreshConflicts(ctx: SimContext): void {
  const now = ctx.state.clock.timeSec;
  ctx.clearanceAlerts = ctx.clearanceAlerts.filter((c) => c.expiresAtSec > now);
  ctx.state.conflicts = [...ctx.clearanceAlerts.map((c) => c.alert), ...ctx.dynamicAlerts.values()];
}
