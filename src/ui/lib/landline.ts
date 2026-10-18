/**
 * Pure view model of the Landline panel (no React): what is waiting for the player, what the player asked and how it stands, the visible log,
 * and the one-click requests the panel offers for aircraft that wait for a coordination call.
 */
import type { Aircraft, ControllerPositionId, SimulationState } from '../../sim/types';
import { findOpenRequest, releaseNeeded, crossingNeedsApproval, validApproval } from '../../sim/coordination';
import type { CoordMessage, CoordRequest } from '../../sim/coordination';
import { findRunway } from '../../sim/runways';
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
  const givenOpen = c.requests.filter((r) => m.has(r.to) && r.status === 'approved' && (r.topic === 'CROSSING' || r.topic === 'RELEASE') && (r.expiresSec === undefined || now < r.expiresSec));
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
    case 'approved': return `${r.topic === 'RELEASE' ? 'released' : 'approved'}${r.afterCallsign ? ` behind ${r.afterCallsign}` : ''}, ${secondsLeft(r, now) ?? 0} s left`;
    case 'denied': return r.topic === 'RELEASE' ? 'hold for release' : 'unable';
    case 'rescinded': return 'taken back';
    case 'expired': return 'expired';
    case 'used': return 'in use';
    case 'completed': return r.topic === 'POINT_OUT' ? 'point out approved' : 'complete';
  }
}

export interface QuickRequest {
  topic: 'CROSSING' | 'RELEASE';
  aircraft: Aircraft;
  from: ControllerPositionId;
  to: ControllerPositionId;
  runwayId?: string;
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
  return out;
}

/** Arrivals a crossing could be approved "behind the landing ...": inbound to a runway, airborne. */
export function afterCandidates(state: SimulationState): Aircraft[] {
  return Object.values(state.aircraft).filter((a) => !a.onGround && !a.isDeparture && ['FINAL', 'LANDING', 'APPROACH', 'INBOUND'].includes(a.phase));
}
