/**
 * Ground control: taxi instructions for departures (full-length entry of the active runway, hold-short of every
 * crossed runway), runway crossings, the handoff to Tower, and taxi-to-parking for arrivals that were handed over by Tower.
 *
 * Runway crossings: when the runway is active and Tower is a separate controller (JO 7110.65 3-1-3) Ground asks Tower over the landline,
 * waits for the answer (the aircraft keeps holding short), and crosses inside Tower's approval, after the landing aircraft it names if any
 * (coordination.ts, ai/coordination.ts). Otherwise (nobody works Tower, or one person works both) Ground decides alone with the stricter
 * rule below. The engine's own safety check (crossing in front of a departure, an arrival inside 3 nm, an occupied runway) always applies.
 */
import type { Aircraft, Clearance, SimulationState } from '../sim/types';
import { cardinal } from '../sim/geo';
import { pushbackGeometry, pushbackStand } from '../sim/pushback';
import { assessClearanceSafety } from '../sim/conflicts';
import { findRunway, findRunwayEnd } from '../sim/runways';
import { COORDINATION_DESIGN, afterAircraftClear, crossingNeedsApproval, crossingPointFor, findOpenRequest, validApproval } from '../sim/coordination';
import { frequencyForPosition } from '../radio/frequencies';
import { hasActive, lastClearance, mkCmd } from './core';
import type { Agent, AgentView, Plan } from './core';
import { createClearanceAgent } from './clnc';
import type { ClearanceStore } from './clnc';
import { closedTaxiways } from '../sim/airportOps';
import { HOLD_START_SNAP_M } from '../sim/groundMovement';
import { pathOf } from '../sim/headOn';
import { DEPARTURE_WAIT_BOUND_SEC, aheadInCrossingQueue, blockedBeforeHold, busyHoldIds, edgesNear, landingExitHoldIds, pushbackBlockedBy, etaToThresholdSec, holdNodeAt, interactingRunways, nextProgressiveSegment, opposingTraffic, outranks, pendingIntermediateStops, planDeparture, planParking, remainingRouteM, retreatNode, routePassesNear, sharedEdgeIds, starvingDeparture, taxiStartNode } from './world';
import { holdTooShort } from '../sim/holdSelection';
import { resolveHeadOn } from './headOn';
import * as say from './phrase';
import { isRotorcraftType, isVehicleType } from '../sim/performance';

const HANDOFF_WITHIN_M = 400;
/**
 * A taxi request that has been held back this long (s) by traffic on its route is planned again around the lane that traffic uses (`planDeparture` / `planParking` with
 * `avoidEdges`), when the airport has another way: one controller keeps the aircraft on a path that does not meet the other (JO 7110.65 3-7-2, 3-7-3: taxi instructions are
 * the controller's means of keeping aircraft apart). DESIGN VALUE.
 */
export const ALT_ROUTE_AFTER_SEC = 300;
/** The replanned route may be this many times the original length plus `ALT_ROUTE_EXTRA_M` (a sane detour, not a tour of the airport). DESIGN VALUE. */
export const ALT_ROUTE_MAX_FACTOR = 3;
export const ALT_ROUTE_EXTRA_M = 500;
/** Two aircraft at the hold lines on either side of a crossing, each waiting for the other's lane, are left to sort it out for this long (s) (the crossing of the aircraft that has the right of way may be only seconds off), then the lower-ranked one is rerouted. DESIGN VALUE. */
export const MUTUAL_CROSSING_AFTER_SEC = 90;
const MUTUAL_CROSSING_RETRY_SEC = 15;
/** A pilot whose taxi or crossing request has gone this long (s) without an instruction is told to hold position and expect a delay, and again every `DELAY_CALL_EVERY_SEC`. DESIGN VALUE. */
export const DELAY_CALL_AFTER_SEC = 180;
export const DELAY_CALL_EVERY_SEC = 300;
/** How long (s) Ground remembers which aircraft an aircraft it turned around or pulled aside was meeting. DESIGN VALUE. */
const PARTNER_MEMORY_SEC = 900;
/**
 * A "nose to nose" request is remembered this long (s) after the pilot's call. The engine withdraws the request again a moment later when the stand-off flickers (a stopped aircraft
 * creeps and the two no longer face each other for a second), and the pilot calls again some seconds on: the answer, with the reaction delay and a busy frequency, would never
 * be on the air while the request exists (soak, KPGD seed 1: 2,000 s of the same call, Ground silent). DESIGN VALUE.
 */
const HEAD_ON_LATCH_SEC = 45;
/** After a head-on resolution, an aircraft that cannot be routed around the aircraft it met waits this long (s) for the lane to clear, then gets the original route again. DESIGN VALUE. */
const PARTNER_PATIENCE_SEC = 240;
/** A taxi request waits at most this long (s) for traffic on the route to clear before Ground stops checking (the engine's spacing and the nose-to-nose resolution take over). DESIGN VALUE. */
export const GROUND_PATIENCE_SEC = Infinity;
/** A taxi request that has waited this long (s) is answered although an aircraft stands still on the route (the nose-to-nose resolution takes over if they meet). DESIGN VALUE. */
export const STOPPED_PATIENCE_SEC = Infinity;
/**
 * A taxi request that has waited this long (s) is answered although an aircraft stands still on the route (the head-on resolution of ai/headOn.ts then runs if they meet):
 * the fairness bound of the lanes (`DEPARTURE_WAIT_BOUND_SEC`, 8 minutes) applies to the aircraft that waits, whatever stands in its way (soak: a GA departure ready for 27 minutes
 * while arrivals bound for the same ramp stopped on its lane one after another, seeds 10 and 12). DESIGN VALUE.
 */
export const OVERDUE_IGNORE_STOPPED_SEC = DEPARTURE_WAIT_BOUND_SEC;
/** Pushback is held while another aircraft's remaining route passes within this distance of the stand (DESIGN VALUE: the lead-in plus a tug and tail). */
const PUSHBACK_LANE_CLEAR_M = 90;
/** A second aircraft is not released onto a route within this distance of a freshly released one for this long. */
const TAXI_FOLLOW_SEC = 60;
const TAXI_FOLLOW_M = 300;
/**
 * A runway is "about to be used" for a landing when a cleared / established arrival will cross its threshold within this many seconds. DESIGN VALUE: the crossing
 * itself takes about 30 s on the runway (`conflicts.surfaceWindow`) and the engine keeps a margin on top; 90 s (the first value) left no gap at all between
 * arrivals 130-160 s apart (soak: crossing waits of 20 minutes at the 13/31 hold line).
 */
export const CROSSING_ARRIVAL_SEC = 60;

/**
 * Is a runway in (or about to be in) use, so Ground must not walk an aircraft across it? On the crossed runway itself: anything departing, in position, landing or
 * standing on it. Operations on a runway that intersects it (a landing roll or a takeoff roll on 4/22 passes through the 13/31 surface) are judged by the engine's own
 * time-based check of the crossing (`conflicts.crossingTrafficIssues`: the crossing aircraft must be clear of the intersection before the traffic reaches it), which both
 * callers apply on top of this; only an arrival that will reach the threshold inside the crossing window counts here, the rest of the approach does not.
 */
export function runwayInUse(v: AgentView, runwayId: string, exceptId: string): boolean {
  const rws = interactingRunways(v.airport, runwayId);
  const occ = v.state.runwayOccupancy[runwayId];
  if (occ) {
    for (const id of [occ.departingId, occ.landingId, occ.lineUpId]) {
      if (!id || id === exceptId) continue;
      // `landingId` is set from the landing clearance (5 nm out, four minutes at 70 kt): an arrival that is still in the air counts through the ETA window below
      // (CROSSING_ARRIVAL_SEC), not for the whole approach, or a crossing would wait for the gap between a landing and the NEXT landing clearance (docs/PROGRESS.md "Throughput").
      const lander = id === occ.landingId ? v.state.aircraft[id] : undefined;
      if (lander && !lander.onGround && lander.phase !== 'LANDING') continue;
      return true;
    }
    if (occ.occupants.some((id) => id !== exceptId)) return true;
  }
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === exceptId || o.onGround || o.isDeparture) continue;
    const g = findRunwayEnd(v.airport, o.assignedRunwayEnd);
    if (!g || !rws.includes(g.runway.id) || o.phase === 'GO_AROUND') continue;
    const near = etaToThresholdSec(o, g) <= CROSSING_ARRIVAL_SEC;
    if (near && (o.phase === 'FINAL' || o.phase === 'LANDING' || hasActive(o, 'LAND'))) return true;
  }
  return false;
}

/** A segment of a progressive taxi is issued this far before the aircraft reaches the end of the one it is flying, so it does not have to stop. */
const SEGMENT_LOOKAHEAD_M = 60;

/** The pilot's readback of this clearance (a pilot TRANSMISSION event tagged with its id) contains the hold-short. */
function holdShortReadBack(state: SimulationState, ac: Aircraft, clr: Clearance): boolean | undefined {
  const evs = state.events;
  for (let i = evs.length - 1, n = 0; i >= 0 && n < 300; i--, n++) {
    const ev = evs[i];
    if (ev.speaker !== 'PILOT' || ev.aircraftId !== ac.id || ev.data?.clearanceId !== clr.id && !(ev.data?.clearanceIds as string[] | undefined)?.includes(clr.id)) continue;
    return /hold short/i.test(ev.text);
  }
  return undefined;
}

function taxiFollowOk(v: AgentView, ac: Aircraft): boolean {
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === ac.id || !o.onGround || o.phase !== 'TAXIING') continue;
    const c = lastClearance(o, 'TAXI');
    if (!c || v.now - c.issuedAtSec >= TAXI_FOLLOW_SEC) continue;
    if (Math.hypot(o.pos.x - ac.pos.x, o.pos.y - ac.pos.y) < TAXI_FOLLOW_M) return false;
  }
  return true;
}

/** The aircraft that stands still at the hold line on the far side of runway `rid` on `ac`'s route (the first hold line of that runway after the one `ac` stands at), if any. */
function farHoldOccupant(state: SimulationState, ac: Aircraft, rid: string): Aircraft | undefined {
  const r = ac.route;
  if (!r) return undefined;
  const nodes = state.airport.taxiwayGraph.nodes;
  let far: string | undefined;
  for (let i = Math.max(0, r.progressIndex - 1); i < r.nodeIds.length; i++) {
    const n = nodes[r.nodeIds[i]];
    if (n?.kind === 'holding_position' && n.runwayId === rid && Math.hypot(n.pos.x - ac.pos.x, n.pos.y - ac.pos.y) > 25) { far = n.id; break; }
  }
  if (!far) return undefined;
  return Object.values(state.aircraft).find((o) => o.id !== ac.id && o.onGround && o.groundSpeedKt < 1 && o.occupyingRunways.length === 0 && holdNodeAt(state.airport, o)?.id === far);
}

/** Another aircraft stands still at the hold line on the far side of runway `rid` on `ac`'s route (the first hold line of that runway after the one `ac` stands at). */
function farHoldOccupied(state: SimulationState, ac: Aircraft, rid: string): boolean {
  return !!farHoldOccupant(state, ac, rid);
}

/**
 * Two aircraft at the hold lines on either side of one runway crossing, each waiting to cross to the other's side (a departure and an arrival on the same taxiway, one lane): neither
 * can be sent, the one that crosses would stop on the far side nose to nose with the other. The far-side aircraft when its own route leads to this side's hold line. Soak (hub
 * configurations), KBOS taxiway C over 4L/22R, taxiway F over 4L/22R: the pair stood for 2,000 s and more. The sim's own nose-to-nose test (traffic.ts 1e0) only sees aircraft
 * within 2.5 follow distances (about 80 m for two light aircraft), the hold lines are 150 m apart.
 */
function mutualCrossingPartner(state: SimulationState, ac: Aircraft, rid: string, hold: { id: string }): Aircraft | undefined {
  const o = farHoldOccupant(state, ac, rid);
  if (!o?.route || o.pendingRequest?.kind !== 'CROSSING') return undefined;
  const rest = o.route.nodeIds.slice(Math.max(0, o.route.progressIndex - 1));
  return rest.includes(hold.id) ? o : undefined;
}

export function createGroundAgent(store: ClearanceStore): Agent {
  const clearanceAgent = createClearanceAgent(store);
  const partner = new Map<string, { otherId: string; since: number }>();
  const headOnCalls = new Map<string, { otherId: string; at: number }>();
  /** Aircraft sent out of another's way (`retreatNode`) that Ground routes on again by itself: they have no request open. */
  const retreated = new Map<string, { otherId: string; at: number }>();
  /** When Ground last looked for a way out of a mutual crossing wait for each aircraft (the search runs route plans: not every second). */
  const mutualTried = new Map<string, number>();
  return (v) => {
    const plans: Plan[] = [];
    const { airport, state } = v;
    // Patience: Ground's own check for traffic the route would meet head-on is conservative (the engine stops aircraft short of each other on a shared lane and
    // Ground resolves a nose-to-nose, ai/headOn.ts). A request that has waited longer than GROUND_PATIENCE_SEC is answered without it, so a pair of aircraft that each
    // wait for the other, or a queue behind an aircraft that stands in the lane, cannot hold a request for good (free-play soak, docs/PROGRESS.md).
    const opposing = (ac: Aircraft, nodeIds: string[], opts: { ignoreStopped?: boolean; ignoreStoppedAhead?: boolean } = {}) => {
      const waited = v.now - (ac.pendingRequest?.sinceSec ?? v.now);
      if (waited >= GROUND_PATIENCE_SEC) return undefined;
      // after STOPPED_PATIENCE_SEC an aircraft that merely stands on the route is no reason to go on waiting: it is stuck too (see `opposingTraffic`, ignoreStopped)
      return opposingTraffic(state, nodeIds, ac.id, { ignoreStopped: opts.ignoreStopped ?? (waited >= STOPPED_PATIENCE_SEC || (ac.isDeparture && waited >= OVERDUE_IGNORE_STOPPED_SEC)), ignoreStoppedAhead: opts.ignoreStoppedAhead ?? true });
    };
    // The aircraft Ground turned around (or pulled aside) for another one, and when: the route it is given afterwards must not meet that aircraft on the same lane again.
    for (const [id, m] of partner) if (v.now - m.since > PARTNER_MEMORY_SEC || !state.aircraft[id]) partner.delete(id);
    for (const ac of v.onFrequency) if (ac.pendingRequest?.headOnWith) headOnCalls.set(ac.id, { otherId: ac.pendingRequest.headOnWith, at: ac.pendingRequest.sinceSec });
    for (const [id, c] of headOnCalls) if (v.now - c.at > HEAD_ON_LATCH_SEC || !state.aircraft[id]) headOnCalls.delete(id);
    const waitedSec = (ac: Aircraft) => v.now - (ac.pendingRequest?.sinceSec ?? v.now);
    /** The edges `nodeIds` shares with the path of the aircraft that blocks it: the lane to plan around. */
    const aroundBlocker = (nodeIds: string[], blocker: Aircraft): Set<string> => {
      const op = pathOf(airport.taxiwayGraph, blocker);
      const shared = op ? sharedEdgeIds(airport, nodeIds, op.ids) : new Set<string>();
      return shared.size ? shared : edgesNear(airport, nodeIds, blocker.pos, 30);
    };
    /**
     * The aircraft stands at the hold line of a runway its route crosses, with no crossing clearance yet: whatever else it asks for (a pilot who stood nose to nose with an
     * aircraft across the runway replaces his crossing request with "request instructions"), what it needs is the crossing (soak, KPHL seed 1: N58MK at the 17/35 hold line, 2,300 s).
     */
    const waitsAtCrossingHold = (ac: Aircraft): boolean => {
      const r = ac.route;
      if (!r || ac.groundSpeedKt >= 1 || (ac.phase !== 'TAXIING' && ac.phase !== 'TAXI_TO_PARKING' && ac.phase !== 'HOLDING_SHORT')) return false;
      const hold = holdNodeAt(airport, ac, HOLD_START_SNAP_M + 5);
      if (!hold?.runwayId || !r.stopAtNodeIds.includes(hold.id) || ac.runwayAuthorizations.includes(hold.runwayId)) return false;
      const i = r.nodeIds.indexOf(hold.id);
      return i >= 0 && i < r.nodeIds.length - 1;
    };
    const saneDetour = (alt: { lengthM: number }, orig: { lengthM: number }) => alt.lengthM <= orig.lengthM * ALT_ROUTE_MAX_FACTOR + ALT_ROUTE_EXTRA_M;
    /** A departure's route around `blocker` (another way to the same kind of hold), when the original one is blocked. */
    const departureAround = (ac: Aircraft, orig: NonNullable<ReturnType<typeof planDeparture>>, blocker: Aircraft) => {
      const avoid = aroundBlocker(orig.nodeIds, blocker);
      if (!avoid.size) return undefined;
      const alt = planDeparture(airport, ac, state.activeRunways.departing, busyHoldIds(state, ac.id), closedTaxiways(state), avoid);
      return alt && saneDetour(alt, orig) && !opposing(ac, alt.nodeIds) ? alt : undefined;
    };
    const parkingAround = (ac: Aircraft, orig: NonNullable<ReturnType<typeof planParking>>, blocker: Aircraft) => {
      const avoid = aroundBlocker(orig.nodeIds, blocker);
      if (!avoid.size) return undefined;
      const alt = planParking(state, ac, avoid);
      return alt && saneDetour(alt, orig) && !opposing(ac, alt.nodeIds, { ignoreStoppedAhead: true }) ? alt : undefined;
    };
    /**
     * The taxi instruction that takes an aircraft on after a head-on (it was turned around or pulled aside, or sent out of the way): to the runway hold for a departure, to
     * a stand for an arrival. The aircraft it met is checked strictly (no stopped-aircraft exemption): when the route would meet it on the same lane again, another way if the
     * airport has one (`departureAround`, `parkingAround`), else a place out of its way (`retreatNode`), else the lane clears first - after PARTNER_PATIENCE_SEC the original
     * route is issued after all. 'wait' = nothing yet.
     */
    const resumeAfterHeadOn = (ac: Aircraft, at: number): Plan | 'wait' | undefined => {
      const m = partner.get(ac.id);
      const other = m && state.aircraft[m.otherId];
      const blockedBy = (nodeIds: string[]) => !!other && other.onGround && !!opposingTraffic(state, nodeIds, ac.id, { only: other.id });
      const retreat = (): Plan | 'wait' => {
        if (!other || v.now - m!.since >= PARTNER_PATIENCE_SEC) return 'wait';
        const n = retreatNode(state, ac, other);
        if (!n) return 'wait';
        retreated.set(ac.id, { otherId: other.id, at: retreated.get(ac.id)?.at ?? at });
        return {
          key: `${ac.id}:retreat:${at}`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, once: true,
          cmds: [mkCmd('TAXI', ac, { destination: `TWY${n.taxiways[0]}`, toNodeId: n.id })],
          phrase: say.headOnPullAside(ac, other, n.taxiways[0]), summary: `${ac.callsign} taxied out of the way of ${other.callsign} to ${n.taxiways[0]}`,
        };
      };
      const retreating = retreated.get(ac.id);
      if (ac.isDeparture) {
        // (no queue limit here: the aircraft stands in somebody's way and has to go somewhere - every hold "full" because of the arrival that waits for it
        // to move was a deadlock, soak seed 3)
        // An exit hold of the landing runway is not a way out of a head-on with an arrival (the queue limit lets a light aircraft use it when the end entry is full): the
        // full-length entry, whatever its queue.
        const queued = planDeparture(airport, ac, state.activeRunways.departing, busyHoldIds(state, ac.id), closedTaxiways(state));
        let dep = (queued && !landingExitHoldIds(state).has(queued.holdId) ? queued : undefined) ?? planDeparture(airport, ac, state.activeRunways.departing, new Map(), closedTaxiways(state));
        if (dep && blockedBy(dep.nodeIds)) {
          const alt = departureAround(ac, dep, other!);
          if (alt) dep = alt;
          else if (v.now - m!.since < PARTNER_PATIENCE_SEC) return retreating ? 'wait' : retreat();
        }
        if (!dep || opposing(ac, dep.nodeIds)) return undefined;
        return {
          key: `${ac.id}:resume:${at}`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, once: true,
          cmds: [mkCmd('TAXI', ac, { destination: `RWY${dep.runwayEnd}`, runwayEnd: dep.runwayEnd, route: dep.via, holdShort: dep.holdShort })],
          phrase: say.taxiToRunway(ac, dep.runwayEnd, dep.via, dep.holdShort), summary: `${ac.callsign} routed again to runway ${dep.runwayEnd} after a head-on`,
        };
      }
      let p = planParking(state, ac);
      if (p && blockedBy(p.nodeIds)) {
        const alt = parkingAround(ac, p, other!);
        if (alt) p = alt;
        else if (v.now - m!.since < PARTNER_PATIENCE_SEC) return retreating ? 'wait' : retreat();
      }
      if (!p || opposing(ac, p.nodeIds)) return undefined;
      return {
        key: `${ac.id}:resume:${at}`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, once: true,
        cmds: [mkCmd('TAXI_TO_PARKING', ac, { destination: p.spot.id, route: p.via, holdShort: p.holdShort })],
        phrase: say.taxiToParking(ac, p.spot, p.via, p.holdShort), summary: `${ac.callsign} routed again to ${p.spot.name} after a head-on`,
      };
    };
    // Delivery closed (nobody works CLNC): Ground issues the clearance too.
    if (!v.staffed.has('CLNC')) plans.push(...clearanceAgent(v));
    for (const ac of v.onFrequency) {
      // (a pilot in the middle of a call is left alone, except one who keeps repeating a nose-to-nose call: that request is answered)
      if (!ac.onGround || (ac.radioState === 'TRANSMITTING' && !headOnCalls.has(ac.id))) continue;
      const pending = ac.pendingRequest?.kind;

      // 0. Airliner at its gate asking for pushback (not FAA phraseology; the sim lets Ground approve it): approve, tail toward the lane that leads to the runway.
      if (ac.isDeparture && ac.phase === 'PARKED' && pending === 'PUSHBACK') {
        if (!starvingDeparture(state, ac) && routePassesNear(state, ac.pos, PUSHBACK_LANE_CLEAR_M, ac.id)) continue; // an aircraft is taxiing over the lane the push ends in: wait until it has passed
        const stand = pushbackStand(airport, ac);
        const geo = stand ? pushbackGeometry(airport, stand, ac, { departingEnds: state.activeRunways.departing }) : undefined;
        if (geo && pushbackBlockedBy(state, ac, geo.from, geo.to)) continue; // somebody stands in the way of the push: the pilot asks again
        const tail = geo ? cardinal(geo.finalHeadingDeg + 180) : undefined;
        const tailDeg = tail ? Math.round(((geo!.finalHeadingDeg + 180) % 360) / 45) * 45 % 360 : undefined;
        plans.push({
          key: `${ac.id}:pushback`, aircraftId: ac.id, callsign: ac.callsign, priority: 50,
          cmds: [mkCmd('PUSHBACK', ac, tailDeg !== undefined ? { pushTailDeg: tailDeg } : {})],
          phrase: say.pushbackApproved(ac, tail), cooldownSec: 20, summary: `${ac.callsign} pushback approved${tail ? `, tail ${tail}` : ''}`,
        });
        continue;
      }

      // 0a. Nose to nose on a shared lane (sim/headOn.ts): resolve it (ai/headOn.ts), or once the pair is apart route the aircraft again from where it stands.
      const latched = pending !== 'TAXI' ? headOnCalls.get(ac.id) : undefined;
      if ((pending === 'TAXI' || latched) && ac.groundSpeedKt < 1 && v.settled(ac) >= 2 && !isVehicleType(ac.type)) {
        const req = ac.pendingRequest ?? { kind: 'TAXI' as const, text: '', sinceSec: latched!.at, headOnWith: latched!.otherId, resume: undefined };
        if (req.headOnWith) {
          const other = state.aircraft[req.headOnWith];
          const res = other ? resolveHeadOn(state, ac, other, new Set(v.onFrequency.map((x) => x.id))) : undefined;
          if (res) { const m = partner.get(res.mover.id); if (!m || m.otherId !== res.other.id) partner.set(res.mover.id, { otherId: res.other.id, since: v.now }); }
          if (res?.kind === 'pull') {
            plans.push({
              key: `${res.mover.id}:headon-pull:${res.junctionId}`, aircraftId: res.mover.id, callsign: res.mover.callsign, priority: 56, cooldownSec: 45,
              cmds: [mkCmd('TAXI', res.mover, { destination: `TWY${res.taxiway}`, toNodeId: res.endNodeId })],
              phrase: say.headOnPullAside(res.mover, res.other, res.taxiway, res.toStand),
              summary: `${res.mover.callsign} pulled off onto ${res.toStand ?? res.taxiway} for ${res.other.callsign}`,
            });
          } else if (res?.kind === 'turn') {
            plans.push({
              key: `${res.mover.id}:headon-turn:${req.sinceSec}`, aircraftId: res.mover.id, callsign: res.mover.callsign, priority: 56, once: true,
              cmds: [mkCmd('TURN_AROUND', res.mover)], phrase: say.headOnTurnAround(res.mover, res.other),
              summary: `${res.mover.callsign} turned around for ${res.other.callsign}`,
            });
          }
          // (nothing to resolve and the aircraft waits at a runway hold line for its crossing: the crossing below answers it)
          if (res || !waitsAtCrossingHold(ac)) continue;
        }
        if (req.resume && !(ac.phase === 'PARKED' || ac.phase === 'READY')) {
          const r = resumeAfterHeadOn(ac, req.sinceSec);
          if (r && r !== 'wait') plans.push(r);
          continue;
        }
      }
      // 0a2. Sent out of another aircraft's way: once it stands at the node it was sent to, Ground routes it on by itself (the pilot has nothing open to ask).
      {
        const rt = retreated.get(ac.id);
        if (rt) {
          if (v.mem.done.has(`${ac.id}:resume:${rt.at}`) || v.now - rt.at > PARTNER_MEMORY_SEC) retreated.delete(ac.id);
          else if (!pending && ac.groundSpeedKt < 1 && v.settled(ac) >= 2 && (!ac.route || ac.route.progressIndex >= ac.route.nodeIds.length) && v.now - rt.at >= 10 && (ac.phase === 'TAXIING' || ac.phase === 'TAXI_TO_PARKING')) {
            const r = resumeAfterHeadOn(ac, rt.at);
            if (r && r !== 'wait') plans.push(r);
            continue;
          }
        }
      }

      // 0b. A hold-short that was not read back (JO 7110.65 2-4-3, 3-7-2 "READ BACK HOLD INSTRUCTIONS"): ask for it.
      {
        const clr = lastClearance(ac, 'TAXI') ?? lastClearance(ac, 'TAXI_TO_PARKING');
        const last = [lastClearance(ac, 'TAXI'), lastClearance(ac, 'TAXI_TO_PARKING')].filter((c): c is Clearance => !!c).sort((a, b) => b.issuedAtSec - a.issuedAtSec)[0] ?? clr;
        if (last && last.byPosition === 'GND' && last.completedAtSec === undefined && last.holdShort?.length && v.now - last.issuedAtSec >= 4 && holdShortReadBack(state, ac, last) === false) {
          plans.push({
            key: `${ac.id}:rbhold:${last.id}`, aircraftId: ac.id, callsign: ac.callsign, priority: 55, cmds: [mkCmd('READ_BACK_HOLD', ac)],
            phrase: say.readBackHoldInstructions(ac), once: true, summary: `${ac.callsign} read back hold instructions`,
          });
          continue;
        }
      }

      // 1p. Progressive taxi (AIM 4-3-18): the pilot asked for it, or a segment is about to end. Step by step until two taxiways remain, then the full route.
      {
        const asked = ac.isDeparture && (ac.phase === 'READY' || ac.phase === 'PARKED' || ac.phase === 'TAXIING') && pending === 'TAXI' && !!ac.pendingRequest?.progressive;
        const lastTaxi = lastClearance(ac, 'TAXI');
        const lookahead = ac.isDeparture && ac.phase === 'TAXIING' && !pending && !!lastTaxi?.segment && lastTaxi.completedAtSec === undefined && !!ac.route
          && remainingRouteM(airport, ac) <= SEGMENT_LOOKAHEAD_M;
        if (asked || lookahead) {
          const needsIfr = ac.flightPlan?.flightRules === 'IFR' && !ac.flightPlan.ifrClearance;
          if (needsIfr || (asked && ac.phase !== 'TAXIING' && !taxiFollowOk(v, ac))) continue;
          let virtual: Aircraft = ac;
          if (lookahead && ac.route) {
            const ids = ac.route.nodeIds;
            const endN = airport.taxiwayGraph.nodes[ids[ids.length - 1]];
            const prevN = airport.taxiwayGraph.nodes[ids[Math.max(0, ids.length - 2)]];
            if (!endN || endN.kind === 'holding_position' || endN.kind === 'parking') continue;
            virtual = { ...ac, pos: endN.pos, route: undefined, headingDeg: (Math.atan2(endN.pos.x - prevN.pos.x, endN.pos.y - prevN.pos.y) * 180 / Math.PI + 360) % 360 };
          }
          const dep = planDeparture(airport, virtual, state.activeRunways.departing, busyHoldIds(state, ac.id));
          const startNode = taxiStartNode(airport, virtual);
          if (!dep || !startNode || opposing(ac, dep.nodeIds)) continue;
          const seg = nextProgressiveSegment(airport, dep.nodeIds, virtual.headingDeg);
          if (seg && seg.remaining > 2) {
            plans.push({
              key: `${ac.id}:seg:${startNode.id}`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, once: true,
              cmds: [mkCmd('TAXI', ac, { segment: true, turnDirection: seg.turn, route: seg.taxiways, destination: seg.next ? `TWY${seg.next}` : undefined, toNodeId: seg.endNodeId })],
              phrase: say.progressiveStep(ac, seg), summary: `${ac.callsign} progressive taxi: ${seg.turn ? `turn ${seg.turn} on ${seg.taxiways[0]}` : `via ${seg.taxiways.join(' ')}`}${seg.next ? `, continue to ${seg.next}` : ''}`,
            });
            continue;
          }
          // Two taxiways or fewer left: the complete route (with the hold-short instructions) in one instruction.
          if (!lookahead || dep.nodeIds.length > 1) {
            plans.push({
              key: `${ac.id}:seg-final:${startNode.id}`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, once: true,
              cmds: [mkCmd('TAXI', ac, { destination: `RWY${dep.runwayEnd}`, runwayEnd: dep.runwayEnd, route: dep.via, holdShort: dep.holdShort })],
              phrase: say.taxiToRunway(ac, dep.runwayEnd, dep.via, dep.holdShort),
              summary: `${ac.callsign} taxi to runway ${dep.runwayEnd} (final step of a progressive taxi)`,
            });
          }
          continue;
        }
      }

      // 1. Departure asking for taxi.
      if (ac.isDeparture && !isVehicleType(ac.type) && !isRotorcraftType(ac.type) && (ac.phase === 'READY' || ac.phase === 'PARKED') && pending === 'TAXI' && !hasActive(ac, 'TAXI')) {
        const needsIfr = ac.flightPlan?.flightRules === 'IFR' && !ac.flightPlan.ifrClearance;
        if (needsIfr || !taxiFollowOk(v, ac)) continue;
        // A departure that waited past the fairness bound is served before the ones that called after it: while it could be sent now (a hold with room, nothing opposing on its
        // route) the others do not take the place (soak seed 10: a GA departure ready at the ramp for 27 minutes while eleven later ones took every free place at the hold of 22).
        const overdueFirst = v.onFrequency.some((o) => o.id !== ac.id && o.isDeparture && !isVehicleType(o.type) && !isRotorcraftType(o.type) && (o.phase === 'READY' || o.phase === 'PARKED') && o.pendingRequest?.kind === 'TAXI'
          && !hasActive(o, 'TAXI') && starvingDeparture(state, o) && outranks(state, o, ac) && !(o.flightPlan?.flightRules === 'IFR' && !o.flightPlan.ifrClearance)
          && (() => { const od = planDeparture(airport, o, state.activeRunways.departing, busyHoldIds(state, o.id), closedTaxiways(state)); return !!od && !opposing(o, od.nodeIds); })());
        if (overdueFirst) continue;
        let dep = planDeparture(airport, ac, state.activeRunways.departing, busyHoldIds(state, ac.id), closedTaxiways(state));
        if (!dep) continue;
        const blocker = opposing(ac, dep.nodeIds);
        if (blocker) {
          // held back by traffic on the route: after ALT_ROUTE_AFTER_SEC another way, when there is one
          const alt = waitedSec(ac) >= ALT_ROUTE_AFTER_SEC ? departureAround(ac, dep, blocker) : undefined;
          if (!alt) continue;
          dep = alt;
        }
        plans.push({
          key: `${ac.id}:taxi`, aircraftId: ac.id, callsign: ac.callsign, priority: 50,
          cmds: [mkCmd('TAXI', ac, { destination: `RWY${dep.runwayEnd}`, runwayEnd: dep.runwayEnd, route: dep.via, holdShort: dep.holdShort })],
          phrase: say.taxiToRunway(ac, dep.runwayEnd, dep.via, dep.holdShort),
          summary: `${ac.callsign} taxi to runway ${dep.runwayEnd}${dep.holdShort.length ? `, hold short ${dep.holdShort.join(' ')}` : ''}`,
        });
        continue;
      }

      // 1b. Departure standing at an intersection hold with too little runway for its type (Tower sent it back): taxi to full length.
      if (ac.isDeparture && !isVehicleType(ac.type) && ac.phase === 'HOLDING_SHORT' && ac.groundSpeedKt < 1 && v.settled(ac) >= 4) {
        const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
        const hold = holdNodeAt(airport, ac);
        if (g && hold && hold.runwayId === g.runway.id && holdTooShort(g, hold, ac)) {
          const dep = planDeparture(airport, ac, state.activeRunways.departing, busyHoldIds(state, ac.id), closedTaxiways(state));
          if (dep && dep.holdId !== hold.id && !opposing(ac, dep.nodeIds)) {
            plans.push({
              key: `${ac.id}:taxi-full:${hold.id}`, aircraftId: ac.id, callsign: ac.callsign, priority: 50,
              cmds: [mkCmd('TAXI', ac, { destination: `RWY${dep.runwayEnd}`, runwayEnd: dep.runwayEnd, route: dep.via, holdShort: dep.holdShort })],
              phrase: say.taxiToRunway(ac, dep.runwayEnd, dep.via, dep.holdShort),
              summary: `${ac.callsign} taxi to runway ${dep.runwayEnd} full length`,
            });
          }
          continue;
        }
      }

      // 1d. The departure runway left the configuration (it is in neither the departing nor the landing list: the runway configuration was changed, a wind shift): a departure that has not reached its runway, or stands at the hold
      // line of a runway no longer in use, is given a new taxi instruction to a departure runway now in use. An aircraft already on the runway keeps its takeoff.
      if (ac.isDeparture && !isVehicleType(ac.type) && !isRotorcraftType(ac.type) && (ac.phase === 'TAXIING' || ac.phase === 'HOLDING_SHORT') && ac.occupyingRunways.length === 0
        && ac.assignedRunwayEnd !== undefined && state.activeRunways.departing.length > 0 && ![...state.activeRunways.departing, ...state.activeRunways.landing].includes(ac.assignedRunwayEnd)
        && (ac.phase === 'HOLDING_SHORT' || !!lastClearance(ac, 'TAXI')?.destination?.startsWith('RWY')) && v.settled(ac) >= 2) {
        const dep = planDeparture(airport, ac, state.activeRunways.departing, busyHoldIds(state, ac.id), closedTaxiways(state));
        if (dep && !opposing(ac, dep.nodeIds)) {
          plans.push({
            key: `${ac.id}:reroute-cfg:${ac.assignedRunwayEnd}>${dep.runwayEnd}`, aircraftId: ac.id, callsign: ac.callsign, priority: 53, cooldownSec: 30,
            cmds: [mkCmd('TAXI', ac, { destination: `RWY${dep.runwayEnd}`, runwayEnd: dep.runwayEnd, route: dep.via, holdShort: dep.holdShort })],
            phrase: say.taxiToRunway(ac, dep.runwayEnd, dep.via, dep.holdShort), summary: `${ac.callsign} re-routed to runway ${dep.runwayEnd}: runway ${ac.assignedRunwayEnd} is no longer in use`,
          });
        }
        continue;
      }

      // 1c. Stopped short of a taxiway that closed under its route (pilot: "holding short of Bravo, taxiway closed, request taxi instructions"):
      // re-route it around the closure (the engine plans every taxi instruction around closed taxiways).
      const closedStop = pending === 'TAXI' && ac.groundSpeedKt < 1 && !!ac.pendingRequest && /\(closed\)/.test(ac.pendingRequest.text) && (ac.phase === 'TAXIING' || ac.phase === 'TAXI_TO_PARKING');
      if (closedStop && v.settled(ac) >= 3) {
        if (ac.phase === 'TAXI_TO_PARKING') {
          const p = planParking(state, ac);
          if (p && !opposing(ac, p.nodeIds)) {
            plans.push({
              key: `${ac.id}:reroute-parking:${ac.pendingRequest!.sinceSec}`, aircraftId: ac.id, callsign: ac.callsign, priority: 52,
              cmds: [mkCmd('TAXI_TO_PARKING', ac, { destination: p.spot.id, route: p.via, holdShort: p.holdShort })],
              phrase: say.taxiToParking(ac, p.spot, p.via, p.holdShort), summary: `${ac.callsign} re-routed around a closed taxiway to ${p.spot.name}`,
            });
          }
        } else {
          const dep = planDeparture(airport, ac, state.activeRunways.departing, busyHoldIds(state, ac.id), closedTaxiways(state));
          if (dep && !opposing(ac, dep.nodeIds)) {
            plans.push({
              key: `${ac.id}:reroute-dep:${ac.pendingRequest!.sinceSec}`, aircraftId: ac.id, callsign: ac.callsign, priority: 52,
              cmds: [mkCmd('TAXI', ac, { destination: `RWY${dep.runwayEnd}`, runwayEnd: dep.runwayEnd, route: dep.via, holdShort: dep.holdShort })],
              phrase: say.taxiToRunway(ac, dep.runwayEnd, dep.via, dep.holdShort), summary: `${ac.callsign} re-routed around a closed taxiway to runway ${dep.runwayEnd}`,
            });
          }
        }
        continue;
      }

      // 2. Holding short of a runway on the taxi route: cross when the runway is not in use.
      if ((pending === 'CROSSING' || (pending === 'TAXI' && waitsAtCrossingHold(ac))) && ac.groundSpeedKt < 1) {
        const hold = holdNodeAt(airport, ac, HOLD_START_SNAP_M + 5);
        const rid = hold?.runwayId;
        if (!rid) continue;
        const cmd = mkCmd('CROSS_RUNWAY', ac, { crossRunwayId: rid, runwayId: rid });
        // Several aircraft wait on one exit stub: the one nearest the runway goes first (the others cannot pass it).
        if (aheadInCrossingQueue(state, ac)) continue;
        // Not onto a taxiway where an aircraft waits head-on on the far side (a departure standing at the far hold line for the same runway):
        // the crossing aircraft would stop on the runway behind it, which cannot move until the runway is free.
        if (ac.route && opposing(ac, ac.route.nodeIds.slice(Math.max(0, ac.route.progressIndex - 1)))) continue;
        // ... and never when an aircraft stands AT the far hold line, patience or not: it waits for its own takeoff clearance, not for this crossing, and a crossing
        // aircraft that has left the runway can then neither reach the hold line nor turn back (soak seed 13, special traffic: a vehicle 32 m short of the far hold
        // of 4/22 and a Cessna cleared for takeoff from that hold line stood nose to nose for 1,000 s, the landing runway blocked all that time).
        if (ac.route && farHoldOccupied(state, ac, rid)) {
          // Each waits for the other's lane: the one that ranks lower (`outranks`: waited less, an arrival before a departure that is not overdue) is routed another way or out of the
          // other's way (`resumeAfterHeadOn`, the same machinery as after a nose-to-nose), once it has waited MUTUAL_CROSSING_AFTER_SEC for the crossing.
          const mate = hold ? mutualCrossingPartner(state, ac, rid, hold) : undefined;
          if (mate && !outranks(state, ac, mate) && waitedSec(ac) >= MUTUAL_CROSSING_AFTER_SEC && v.now - (mutualTried.get(ac.id) ?? -Infinity) >= MUTUAL_CROSSING_RETRY_SEC) {
            mutualTried.set(ac.id, v.now);
            const at = ac.pendingRequest?.sinceSec ?? v.now;
            const m = partner.get(ac.id);
            if (!m || m.otherId !== mate.id) partner.set(ac.id, { otherId: mate.id, since: v.now });
            const r = resumeAfterHeadOn(ac, at);
            if (r && r !== 'wait') plans.push(r);
          }
          continue;
        }
        const rw = findRunway(airport, rid);
        if (rw && crossingNeedsApproval(state, 'GND', rw)) {
          // JO 7110.65 3-1-3: ask local control, wait for the answer (the aircraft keeps holding short), cross inside the approval.
          const approval = validApproval(state, 'CROSSING', ac.id, rid);
          if (approval) {
            if (!afterAircraftClear(state, approval) || !assessClearanceSafety(state, cmd).safe) continue;
            plans.push({
              key: `${ac.id}:cross:${rid}`, aircraftId: ac.id, callsign: ac.callsign, priority: 60, cmds: [cmd],
              phrase: say.crossRunway(ac, rid), summary: `${ac.callsign} cross runway ${rid} (Tower approved)`,
            });
            continue;
          }
          const open = findOpenRequest(state, 'CROSSING', ac.id, rid);
          if (open && (open.status === 'standby' || v.now - open.lastAskSec < COORDINATION_DESIGN.reaskIntervalSec)) continue; // waiting for Tower
          const point = crossingPointFor(state, ac, rid);
          plans.push({
            key: `${ac.id}:co-ask:${rid}:${open?.asks ?? 0}`, aircraftId: ac.id, callsign: ac.callsign, priority: 58, cmds: [],
            phrase: { text: '', spoken: '' }, summary: `${ac.callsign}: ${open ? 'asking Tower again' : 'asking Tower'} to cross runway ${rid}`,
            coord: {
              to: 'TWR',
              run: (api) => {
                const req = api.request({ topic: 'CROSSING', from: 'GND', to: 'TWR', aircraftId: ac.id, runwayId: rid, point, source: 'ai' });
                const msgs = state.coordination?.messages ?? [];
                return req ? [...msgs].reverse().find((m) => m.requestId === req.id) : undefined;
              },
            },
          });
          continue;
        }
        if (runwayInUse(v, rid, ac.id) || !assessClearanceSafety(state, cmd).safe) continue;
        plans.push({
          key: `${ac.id}:cross:${rid}`, aircraftId: ac.id, callsign: ac.callsign, priority: 60, cmds: [cmd],
          phrase: say.crossRunway(ac, rid), summary: `${ac.callsign} cross runway ${rid}`,
        });
        continue;
      }

      // 3. Departure close to (or at) its runway hold with nothing left to cross and nothing between it and the hold (an arrival on the exit stub, a head-on):
      // switch to Tower. With something in the way it stays with Ground, the only controller that can taxi it aside or turn it around (ai/headOn.ts); it is handed
      // over when it stands at the hold line (the taxi instruction is complete by then) or as soon as the way is clear.
      if (ac.isDeparture && (ac.phase === 'TAXIING' || ac.phase === 'HOLDING_SHORT') && v.staffed.has('TWR')) {
        const taxi = lastClearance(ac, 'TAXI');
        const toRunway = !!taxi?.destination?.startsWith('RWY');
        const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
        const hold = ac.phase === 'HOLDING_SHORT' && ac.groundSpeedKt < 1 ? holdNodeAt(airport, ac) : undefined;
        // (a person's vehicle, a helicopter, and an aircraft that asks Ground for something - taxi, a crossing - are not departures at their hold)
        const atDepartureHold = !!hold && !!g && hold.runwayId === g.runway.id && !isVehicleType(ac.type) && !isRotorcraftType(ac.type) && pending !== 'CROSSING' && pending !== 'TAXI' && pending !== 'PUSHBACK';
        const approaching = toRunway && taxi!.completedAtSec === undefined && !!ac.route && pendingIntermediateStops(airport, ac).length === 0
          && remainingRouteM(airport, ac) <= HANDOFF_WITHIN_M && !blockedBeforeHold(state, ac);
        if (approaching || atDepartureHold) {
          const twr = frequencyForPosition(airport, 'TWR');
          if (twr) {
            plans.push({
              key: `${ac.id}:to-twr`, aircraftId: ac.id, callsign: ac.callsign, priority: 55,
              cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: twr.id })],
              phrase: say.contact(ac, airport, twr.id, twr.mhz), cooldownSec: 30, summary: `${ac.callsign} handed to Tower`,
            });
            continue;
          }
        }
      }

      // 4. Arrival that left the runway and asks to taxi to parking.
      if (!ac.isDeparture && !isRotorcraftType(ac.type) && ac.phase === 'RUNWAY_EXIT' && pending === 'TAXI' && !hasActive(ac, 'TAXI_TO_PARKING')) {
        let p = planParking(state, ac);
        if (!p) continue;
        const blocker = opposing(ac, p.nodeIds, { ignoreStoppedAhead: true });
        if (blocker) {
          const alt = waitedSec(ac) >= ALT_ROUTE_AFTER_SEC ? parkingAround(ac, p, blocker) : undefined;
          if (!alt) continue;
          p = alt;
        }
        plans.push({
          key: `${ac.id}:to-parking`, aircraftId: ac.id, callsign: ac.callsign, priority: 50,
          cmds: [mkCmd('TAXI_TO_PARKING', ac, { destination: p.spot.id, route: p.via, holdShort: p.holdShort })],
          phrase: say.taxiToParking(ac, p.spot, p.via, p.holdShort),
          summary: `${ac.callsign} taxi to ${p.spot.name}`,
        });
      }
    }
    // A taxi or crossing request that has gone unanswered this long gets a "hold position, expect delay" (no state change: the request stays open and is answered when the way is
    // clear). A pilot is never left without a word from the controller for more than DELAY_CALL_AFTER_SEC (then every DELAY_CALL_EVERY_SEC).
    const planned = new Set(plans.map((p) => p.aircraftId));
    for (const ac of v.onFrequency) {
      const req = ac.pendingRequest;
      if (!req || (req.kind !== 'TAXI' && req.kind !== 'CROSSING') || !ac.onGround || ac.groundSpeedKt >= 1 || ac.radioState === 'TRANSMITTING' || planned.has(ac.id) || req.unheard || isVehicleType(ac.type) || isRotorcraftType(ac.type)) continue; // (vehicles and helicopters are answered by the special-traffic agent)
      if (ac.flightPlan?.flightRules === 'IFR' && !ac.flightPlan.ifrClearance && ac.isDeparture) continue; // waits for its clearance from Delivery
      const waited = v.now - req.sinceSec;
      if (waited < DELAY_CALL_AFTER_SEC) continue;
      const n = Math.floor((waited - DELAY_CALL_AFTER_SEC) / DELAY_CALL_EVERY_SEC);
      plans.push({
        key: `${ac.id}:delay:${req.sinceSec}:${n}`, aircraftId: ac.id, callsign: ac.callsign, priority: 30, cmds: [], once: true,
        phrase: say.expectDelay(ac), summary: `${ac.callsign} hold position, expect delay (${req.kind === 'CROSSING' ? 'crossing' : 'taxi'} request waiting ${Math.round(waited)} s)`,
      });
    }
    return plans;
  };
}

