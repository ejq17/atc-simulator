/**
 * Pure view model of the Landline panel (no React): what is waiting for the player, what the player asked and how it stands, the visible log,
 * and the one-click requests the panel offers for aircraft that wait for a coordination call.
 */
import type { Aircraft, ControllerPositionId, SimulationState } from '../../sim/types';
import { findOpenRequest, releaseNeeded, crossingNeedsApproval, isStaffed, sameController, validApproval } from '../../sim/coordination';
import type { CoordMessage, CoordRequest } from '../../sim/coordination';
import { findRunway, findRunwayEnd } from '../../sim/runways';
import { holdNodeAt } from '../../ai/world';

/** Closed requests stay in the "asked" list this long (sim seconds) so the player sees how they ended. */
export const CLOSED_VISIBLE_SEC = 90;

export interface LandlineView {
  /** Waiting for the player's answer (pending or on stand-by), oldest first. */
  incoming: CoordRequest[];
  /** Approvals / releases the player gave that nobody has used yet (can be taken back). */
  givenOpen: CoordRequest[];
  /** What the player asked, newest first, open ones and the recently closed. */
  outgoing: CoordRequest[];
  log: CoordMessage[];
}

const OPEN: ReadonlySet<CoordRequest['status']> = new Set(['pending', 'standby', 'approved']);

export function landlineView(state: SimulationState, mine: readonly ControllerPositionId[], allTraffic = false): LandlineView {
  const c = state.coordination;
  if (!c) return { incoming: [], givenOpen: [], outgoing: [], log: [] };
  const now = state.clock.timeSec;
  const m = new Set(mine);
  const incoming = c.requests.filter((r) => m.has(r.to) && (r.status === 'pending' || r.status === 'standby'));
  const givenOpen = c.requests.filter((r) => m.has(r.to) && r.status === 'approved' && (r.topic === 'CROSSING' || r.topic === 'RELEASE' || r.topic === 'GAP') && (r.expiresSec === undefined || now < r.expiresSec));
  const outgoing = c.requests
    .filter((r) => m.has(r.from) && !m.has(r.to) && (OPEN.has(r.status) || now - (r.answeredSec ?? r.lastAskSec) < CLOSED_VISIBLE_SEC))
    .slice()
    .reverse();
  const log = c.messages.filter((x) => allTraffic || m.has(x.from) || m.has(x.to)).slice(-200);
  return { incoming, givenOpen, outgoing, log };
}

/** One-line description of a request for the cards: "Cessna ... cross runway 13 at A". */
export function describeRequest(r: CoordRequest): string {
  switch (r.topic) {
    case 'CROSSING': return `${r.callsign}: cross runway ${(r.runwayId ?? '').split('/')[0]}${r.point ? ` at ${r.point}` : ''}`;
    case 'RELEASE': return `${r.callsign}: release for departure`;
    case 'GAP': return `Tower needs a gap for ${(r.departures ?? 1) > 1 ? `${r.departures} departures` : 'a departure'}${r.runwayEnd ? ` runway ${r.runwayEnd}` : ''} (${r.callsign} waiting at the hold)`;
    default: return `${r.callsign}: point out${r.positionText ? `, ${r.positionText}` : ''}${r.altitudeFt !== undefined ? `, ${r.altitudeFt} ft` : ''}`;
  }
}

/** Seconds an approval is still valid, or undefined. */
export function secondsLeft(r: CoordRequest, now: number): number | undefined {
  return r.status === 'approved' && r.expiresSec !== undefined ? Math.max(0, Math.round(r.expiresSec - now)) : undefined;
}

export function statusLabel(r: CoordRequest, now: number): string {
  switch (r.status) {
    case 'pending': return r.asks > 1 ? `waiting (asked ${r.asks}x)` : 'waiting for an answer';
    case 'standby': return 'stand by';
    case 'approved': return r.topic === 'GAP' ? `gap ${r.afterCallsign ? `after ${r.afterCallsign}` : 'available'}, ${secondsLeft(r, now) ?? 0} s left` : `${r.topic === 'RELEASE' ? 'released' : 'approved'}${r.afterCallsign ? ` behind ${r.afterCallsign}` : ''}, ${secondsLeft(r, now) ?? 0} s left`;
    case 'denied': return r.topic === 'RELEASE' ? 'hold for release' : 'unable';
    case 'rescinded': return 'taken back';
    case 'expired': return 'expired';
    case 'used': return 'in use';
    case 'completed': return r.topic === 'POINT_OUT' ? 'point out approved' : 'complete';
  }
}

export interface QuickRequest {
  topic: 'CROSSING' | 'RELEASE' | 'GAP';
  aircraft: Aircraft;
  from: ControllerPositionId;
  to: ControllerPositionId;
  runwayId?: string;
  runwayEnd?: string;
  departures?: number;
  label: string;
}

/** Aircraft that wait for a call the player has not made: standing at a hold line asking to cross, or an IFR departure ready without a release. */
export function quickRequests(state: SimulationState, mine: readonly ControllerPositionId[]): QuickRequest[] {
  const out: QuickRequest[] = [];
  if (!state.coordination) return out;
  for (const ac of Object.values(state.aircraft)) {
    if (!ac.onGround) continue;
    if (mine.includes('GND') && ac.pendingRequest?.kind === 'CROSSING' && ac.groundSpeedKt < 1) {
      const rid = holdNodeAt(state.airport, ac)?.runwayId;
      const rw = rid ? findRunway(state.airport, rid) : undefined;
      if (rid && rw && crossingNeedsApproval(state, 'GND', rw) && !findOpenRequest(state, 'CROSSING', ac.id, rid) && !validApproval(state, 'CROSSING', ac.id, rid)) {
        out.push({ topic: 'CROSSING', aircraft: ac, from: 'GND', to: 'TWR', runwayId: rid, label: `Ask Tower: ${ac.callsign} cross runway ${rid.split('/')[0]}` });
      }
    }
    if (mine.includes('TWR') && ac.isDeparture && ac.phase === 'HOLDING_SHORT') {
      const dep = releaseNeeded(state, 'TWR', ac);
      if (dep && !findOpenRequest(state, 'RELEASE', ac.id) && !validApproval(state, 'RELEASE', ac.id)) {
        out.push({ topic: 'RELEASE', aircraft: ac, from: 'TWR', to: dep, label: `Ask ${dep === 'DEP' ? 'Departure' : 'Approach'}: release ${ac.callsign}` });
      }
    }
  }
  // A departure gap (Tower to Approach): offered for a runway whose hold has had a departure waiting for GAP_QUICK_WAIT_SEC, while a separate Approach exists.
  if (mine.includes('TWR') && isStaffed(state, 'APP') && !sameController(state, 'TWR', 'APP')) {
    const seen = new Set<string>();
    for (const ac of departuresAtHold(state)) {
      const g = findRunwayEnd(state.airport, ac.assignedRunwayEnd);
      if (!g || seen.has(g.runway.id) || findOpenRequest(state, 'GAP', ac.id) || validApproval(state, 'GAP', ac.id)) continue;
      if (state.clock.timeSec - (ac.pendingRequest?.sinceSec ?? state.clock.timeSec) < GAP_QUICK_WAIT_SEC) continue;
      seen.add(g.runway.id);
      const n = departuresAtHold(state, g.runway.id).length;
      out.push({ topic: 'GAP', aircraft: ac, from: 'TWR', to: 'APP', runwayId: g.runway.id, runwayEnd: g.end.id, departures: n, label: `Ask Approach: need a gap for ${n > 1 ? `${n} departures` : 'a departure'} runway ${g.end.id}` });
    }
  }
  return out;
}

/** A departure that has stood ready at the hold line this long (s) gets the one-click gap request in the panel. DESIGN VALUE (the AI Tower asks after 150 s, ai/gap.ts). */
export const GAP_QUICK_WAIT_SEC = 60;

/** Departures standing at a runway hold line (optionally for one runway), the one that has waited longest first. */
export function departuresAtHold(state: SimulationState, runwayId?: string): Aircraft[] {
  return Object.values(state.aircraft)
    .filter((a) => a.isDeparture && a.onGround && a.phase === 'HOLDING_SHORT' && (!runwayId || findRunwayEnd(state.airport, a.assignedRunwayEnd)?.runway.id === runwayId))
    .sort((a, b) => (a.pendingRequest?.sinceSec ?? Infinity) - (b.pendingRequest?.sinceSec ?? Infinity));
}

/** Arrivals a crossing could be approved "behind the landing ...": inbound to a runway, airborne. */
export function afterCandidates(state: SimulationState): Aircraft[] {
  return Object.values(state.aircraft).filter((a) => !a.onGround && !a.isDeparture && ['FINAL', 'LANDING', 'APPROACH', 'INBOUND'].includes(a.phase));
}
