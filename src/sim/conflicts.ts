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
import { dist, headingDiff, ktToMps, mToNm, nmToM, pointInPolygon } from './geo';
import { alongCross, crossingRunways, findRunway, findRunwayEnd, isOnFinal } from './runways';
import { assessApproach } from './approach';
import { computeRunwayActivity } from './runwayOccupancy';
import type { RunwayActivity } from './runwayOccupancy';
import { TAXI_PHASES } from './stateMachines';
import { emitEvent } from './context';
import type { SimContext } from './context';

export const REF_SAME_RUNWAY = 'FAA JO 7110.65 3-9-6 (same runway separation)';
export const REF_LANDING = 'FAA JO 7110.65 3-10-5 (landing clearance) and 3-10-3 (same runway separation)';
export const REF_TAXI = 'FAA JO 7110.65 3-7-2 (taxi and ground movement, runway crossings)';
export const REF_INTERSECTING = 'FAA JO 7110.65 3-9-8 (intersecting runway separation)';
/** Paragraph deliberately not cited: only the topic (radar separation minima) is referenced; the 3 nm figure is a simplification. */
export const REF_RADAR_SEPARATION = 'FAA JO 7110.65, radar separation minima (simplified here to 3 nm in-trail on the same final)';
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
const FINAL_ACTIVE_NM = 5;

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

function activeOnRunway(state: SimulationState, act: RunwayActivity, exclude: string): string[] {
  const ids = new Set<string>([...act.departing, ...act.lineUp]);
  for (const id of act.landing) {
    const ac = state.aircraft[id];
    if (!ac) continue;
    if (ac.onGround) ids.add(id);
    else if (arrivalsOnFinal(state, act.runwayId, FINAL_ACTIVE_NM, exclude).some((a) => a.id === id)) ids.add(id);
  }
  for (const id of act.occupants) {
    const ac = state.aircraft[id];
    if (ac && ac.groundSpeedKt > 5) ids.add(id);
  }
  ids.delete(exclude);
  return [...ids];
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
  const mine = a.plan.joinDM;
  const tJoinSec = a.plan.joinTravelM / Math.max(ktToMps(ac.groundSpeedKt), ktToMps(40));
  for (const o of Object.values(state.aircraft)) {
    if (o.id === ac.id || o.onGround || o.isDeparture || o.assignedRunwayEnd !== g.end.id) continue;
    const { along, cross } = alongCross(g, o.pos);
    const aligned = isOnFinal(g, o.pos, o.headingDeg, 30) && Math.abs(cross) <= nmToM(0.5) && Math.abs(headingDiff(o.headingDeg, g.headingDeg)) < 30;
    const established = o.phase === 'FINAL' || o.phase === 'LANDING' || aligned;
    if (!established) continue;
    const theirsNow = -along;
    const theirsAtJoin = Math.max(0, theirsNow - ktToMps(o.groundSpeedKt) * tJoinSec);
    const gapNm = mToNm(Math.abs(mine - theirsAtJoin));
    if (gapNm < APPROACH_IN_TRAIL_NM) {
      issues.push({
        kind: 'AIRBORNE_PROXIMITY',
        text: `Approach clearance for ${ac.callsign} to runway ${g.end.id} puts it ${gapNm.toFixed(1)} nm in trail of ${o.callsign}, established on the same final (${mToNm(theirsNow).toFixed(1)} nm out now)`,
        reference: REF_RADAR_SEPARATION,
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
export function assessClearanceSafety(state: SimulationState, cmd: ParsedCommand): SafetyAssessment {
  const issues: SafetyIssue[] = [];
  const ac = cmd.callsign ? Object.values(state.aircraft).find((a) => a.callsign.toUpperCase() === cmd.callsign!.toUpperCase()) : undefined;
  if (!ac) return { safe: true, issues };
  const { airport } = state;
  if (cmd.kind === 'APPROACH') return assessApproachSeparation(state, ac, cmd);
  const activity = computeRunwayActivity(state);

  let runwayId: string | undefined;
  if (cmd.kind === 'TAKEOFF' || cmd.kind === 'LINE_UP_AND_WAIT' || cmd.kind === 'LAND') {
    const g = findRunwayEnd(airport, cmd.runwayEnd ?? cmd.runwayId ?? ac.assignedRunwayEnd);
    runwayId = g?.runway.id;
  } else if (cmd.kind === 'CROSS_RUNWAY') {
    runwayId = findRunway(airport, cmd.crossRunwayId ?? cmd.runwayId ?? cmd.runwayEnd)?.id;
  } else {
    return { safe: true, issues };
  }
  if (!runwayId || !activity[runwayId]) return { safe: true, issues };
  const act = activity[runwayId];
  const others = (ids: string[]) => ids.filter((i) => i !== ac.id);

  const push = (text: string, reference: string, ids: string[], kind: SafetyIssue['kind'] = 'RUNWAY_CONFLICT') =>
    issues.push({ kind, text, reference, aircraftIds: [ac.id, ...ids], runwayId });

  if (cmd.kind === 'TAKEOFF' || cmd.kind === 'LINE_UP_AND_WAIT') {
    const verb = cmd.kind === 'TAKEOFF' ? 'Takeoff clearance' : 'Line up and wait';
    const occ = others(act.occupants);
    if (occ.length) push(`${verb} for ${ac.callsign} on runway ${runwayId} while it is occupied by ${cs(state, occ)}`, REF_SAME_RUNWAY, occ);
    const dep = others(act.departing).filter((i) => !occ.includes(i));
    if (dep.length) push(`${verb} for ${ac.callsign} while ${cs(state, dep)} is cleared for takeoff / rolling on runway ${runwayId}`, REF_SAME_RUNWAY, dep);
    const lu = others(act.lineUp).filter((i) => !occ.includes(i));
    if (lu.length) push(`${verb} for ${ac.callsign} while ${cs(state, lu)} is in position on runway ${runwayId}`, REF_SAME_RUNWAY, lu);
    const crossing = others(act.crossing).filter((i) => !occ.includes(i));
    if (crossing.length) push(`${verb} for ${ac.callsign} while ${cs(state, crossing)} is cleared to cross runway ${runwayId}`, REF_TAXI, crossing);
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
    const occ = others(act.occupants);
    if (occ.length) push(`Landing clearance for ${ac.callsign} on runway ${runwayId} while it is occupied by ${cs(state, occ)}`, REF_LANDING, occ);
    const dep = others(act.departing).filter((i) => !occ.includes(i));
    if (dep.length) push(`Landing clearance for ${ac.callsign} while ${cs(state, dep)} is cleared for takeoff / rolling on runway ${runwayId}`, REF_LANDING, dep);
    const lu = others(act.lineUp).filter((i) => !occ.includes(i));
    if (lu.length) push(`Landing clearance for ${ac.callsign} while ${cs(state, lu)} is in position on runway ${runwayId}`, REF_LANDING, lu);
    const crossing = others(act.crossing).filter((i) => !occ.includes(i));
    if (crossing.length) push(`Landing clearance for ${ac.callsign} while ${cs(state, crossing)} is cleared to cross runway ${runwayId}`, REF_TAXI, crossing);
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
  }

  // Simultaneous operations on intersecting runways (e.g. 13/31 and 4/22).
  if (cmd.kind === 'TAKEOFF' || cmd.kind === 'LAND') {
    for (const other of crossingRunways(airport, runwayId)) {
      const oact = activity[other.id];
      if (!oact) continue;
      const busy = activeOnRunway(state, oact, ac.id).filter((i) => !issues.some((x) => x.aircraftIds.includes(i)));
      if (busy.length) {
        push(
          `${cmd.kind === 'TAKEOFF' ? 'Takeoff' : 'Landing'} clearance for ${ac.callsign} on runway ${runwayId} while ${cs(state, busy)} is using intersecting runway ${other.id}`,
          REF_INTERSECTING,
          busy,
        );
      }
    }
  }
  return { safe: issues.length === 0, issues };
}

/**
 * Record an unsafe clearance: a RUNWAY_CONFLICT/UNSAFE_CLEARANCE alert pair and events.
 * `prevented` = true in training mode (the clearance was refused).
 */
export function recordUnsafeClearance(ctx: SimContext, ac: Aircraft, assessment: SafetyAssessment, prevented: boolean): void {
  const now = ctx.state.clock.timeSec;
  for (const issue of assessment.issues) {
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

/** Parked, shut down, or standing still on a parking position (stands can be closer than 30 m). */
function parkedLike(state: SimulationState, ac: Aircraft): boolean {
  if (ac.phase === 'PARKED' || ac.phase === 'ARRIVED') return true;
  return ac.groundSpeedKt < 0.1 && state.airport.parking.some((p) => dist(p.pos, ac.pos) < 8);
}
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

  // Two or more aircraft on a runway surface while one of them is operating at speed.
  const activity = computeRunwayActivity(state);
  for (const rid of Object.keys(activity)) {
    const act = activity[rid];
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
        if (d < GROUND_PROXIMITY_M) {
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
              text: `${a.callsign} and ${b.callsign}: ${mToNm(d).toFixed(1)} nm, ${Math.round(dv)} ft`,
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
