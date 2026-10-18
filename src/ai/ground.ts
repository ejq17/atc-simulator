/**
 * Ground control: taxi instructions for departures (full-length entry of the active runway, hold-short of every
 * crossed runway), runway crossings, the handoff to Tower, and taxi-to-parking for arrivals that were handed over by Tower.
 *
 * Runway crossings: when the runway is active and Tower is a separate controller (JO 7110.65 3-1-3) Ground asks Tower over the landline,
 * waits for the answer (the aircraft keeps holding short), and crosses inside Tower's approval, after the landing aircraft it names if any
 * (coordination.ts, ai/coordination.ts). Otherwise (nobody works Tower, or one person works both) Ground decides alone with the stricter
 * rule below. The engine's own safety check (crossing in front of a departure, an arrival inside 3 nm, an occupied runway) always applies.
 */
import type { Aircraft } from '../sim/types';
import { assessClearanceSafety } from '../sim/conflicts';
import { findRunway, findRunwayEnd } from '../sim/runways';
import { COORDINATION_DESIGN, afterAircraftClear, crossingNeedsApproval, crossingPointFor, findOpenRequest, validApproval } from '../sim/coordination';
import { frequencyForPosition } from '../radio/frequencies';
import { hasActive, lastClearance, mkCmd } from './core';
import type { Agent, AgentView, Plan } from './core';
import { createClearanceAgent } from './clnc';
import type { ClearanceStore } from './clnc';
import { closedTaxiways } from '../sim/airportOps';
import { busyHoldIds, etaToThresholdSec, holdNodeAt, interactingRunways, opposingTraffic, pendingIntermediateStops, planDeparture, planParking, remainingRouteM } from './world';
import { holdTooShort } from '../sim/holdSelection';
import * as say from './phrase';

const HANDOFF_WITHIN_M = 400;
/** A second aircraft is not released onto a route within this distance of a freshly released one for this long. */
const TAXI_FOLLOW_SEC = 60;
const TAXI_FOLLOW_M = 300;
/** A runway is "about to be used" for a landing when a cleared / established arrival will cross its threshold within this many seconds. */
const CROSSING_ARRIVAL_SEC = 90;

/**
 * Is a runway in (or about to be in) use, so Ground must not walk an aircraft across it? Operations on a runway that intersects it count
 * too: a landing roll or a takeoff roll on 13/31 passes through the 4/22 surface, and the engine only checks the crossed runway itself.
 */
export function runwayInUse(v: AgentView, runwayId: string, exceptId: string): boolean {
  const rws = interactingRunways(v.airport, runwayId);
  for (const rid of rws) {
    const occ = v.state.runwayOccupancy[rid];
    if (!occ) continue;
    for (const id of [occ.departingId, occ.landingId, occ.lineUpId]) if (id && id !== exceptId) return true;
    if (rid !== runwayId && occ.occupants.some((id) => id !== exceptId)) return true;
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

function taxiFollowOk(v: AgentView, ac: Aircraft): boolean {
  for (const o of Object.values(v.state.aircraft)) {
    if (o.id === ac.id || !o.onGround || o.phase !== 'TAXIING') continue;
    const c = lastClearance(o, 'TAXI');
    if (!c || v.now - c.issuedAtSec >= TAXI_FOLLOW_SEC) continue;
    if (Math.hypot(o.pos.x - ac.pos.x, o.pos.y - ac.pos.y) < TAXI_FOLLOW_M) return false;
  }
  return true;
}

export function createGroundAgent(store: ClearanceStore): Agent {
  const clearanceAgent = createClearanceAgent(store);
  return (v) => {
    const plans: Plan[] = [];
    const { airport, state } = v;
    // Delivery closed (nobody works CLNC): Ground issues the clearance too.
    if (!v.staffed.has('CLNC')) plans.push(...clearanceAgent(v));
    for (const ac of v.onFrequency) {
      if (!ac.onGround || ac.radioState === 'TRANSMITTING') continue;
      const pending = ac.pendingRequest?.kind;

      // 1. Departure asking for taxi.
      if (ac.isDeparture && (ac.phase === 'READY' || ac.phase === 'PARKED') && pending === 'TAXI' && !hasActive(ac, 'TAXI')) {
        const needsIfr = ac.flightPlan?.flightRules === 'IFR' && !ac.flightPlan.ifrClearance;
        if (needsIfr || !taxiFollowOk(v, ac)) continue;
        const dep = planDeparture(airport, ac, state.activeRunways.departing, busyHoldIds(state, ac.id), closedTaxiways(state));
        if (!dep || opposingTraffic(state, dep.nodeIds, ac.id)) continue;
        plans.push({
          key: `${ac.id}:taxi`, aircraftId: ac.id, callsign: ac.callsign, priority: 50,
          cmds: [mkCmd('TAXI', ac, { destination: `RWY${dep.runwayEnd}`, runwayEnd: dep.runwayEnd, route: dep.via, holdShort: dep.holdShort })],
          phrase: say.taxiToRunway(ac, dep.runwayEnd, dep.via, dep.holdShort),
          summary: `${ac.callsign} taxi to runway ${dep.runwayEnd}${dep.holdShort.length ? `, hold short ${dep.holdShort.join(' ')}` : ''}`,
        });
        continue;
      }

      // 1b. Departure standing at an intersection hold with too little runway for its type (Tower sent it back): taxi to full length.
      if (ac.isDeparture && ac.phase === 'HOLDING_SHORT' && ac.groundSpeedKt < 1 && v.settled(ac) >= 4) {
        const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
        const hold = holdNodeAt(airport, ac);
        if (g && hold && hold.runwayId === g.runway.id && holdTooShort(g, hold, ac)) {
          const dep = planDeparture(airport, ac, state.activeRunways.departing, busyHoldIds(state, ac.id), closedTaxiways(state));
          if (dep && dep.holdId !== hold.id && !opposingTraffic(state, dep.nodeIds, ac.id)) {
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

      // 1c. Stopped short of a taxiway that closed under its route (pilot: "holding short of Bravo, taxiway closed, request taxi instructions"):
      // re-route it around the closure (the engine plans every taxi instruction around closed taxiways).
      const closedStop = pending === 'TAXI' && ac.groundSpeedKt < 1 && !!ac.pendingRequest && /\(closed\)/.test(ac.pendingRequest.text) && (ac.phase === 'TAXIING' || ac.phase === 'TAXI_TO_PARKING');
      if (closedStop && v.settled(ac) >= 3) {
        if (ac.phase === 'TAXI_TO_PARKING') {
          const p = planParking(state, ac);
          if (p && !opposingTraffic(state, p.nodeIds, ac.id)) {
            plans.push({
              key: `${ac.id}:reroute-parking:${ac.pendingRequest!.sinceSec}`, aircraftId: ac.id, callsign: ac.callsign, priority: 52,
              cmds: [mkCmd('TAXI_TO_PARKING', ac, { destination: p.spot.id, route: p.via, holdShort: p.holdShort })],
              phrase: say.taxiToParking(ac, p.spot, p.via, p.holdShort), summary: `${ac.callsign} re-routed around a closed taxiway to ${p.spot.name}`,
            });
          }
        } else {
          const dep = planDeparture(airport, ac, state.activeRunways.departing, busyHoldIds(state, ac.id), closedTaxiways(state));
          if (dep && !opposingTraffic(state, dep.nodeIds, ac.id)) {
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
      if (pending === 'CROSSING' && ac.groundSpeedKt < 1) {
        const hold = holdNodeAt(airport, ac);
        const rid = hold?.runwayId;
        if (!rid) continue;
        const cmd = mkCmd('CROSS_RUNWAY', ac, { crossRunwayId: rid, runwayId: rid });
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

      // 3. Departure close to (or at) its runway hold with nothing left to cross: switch to Tower.
      if (ac.isDeparture && (ac.phase === 'TAXIING' || ac.phase === 'HOLDING_SHORT') && v.staffed.has('TWR')) {
        const taxi = lastClearance(ac, 'TAXI');
        if (taxi && taxi.completedAtSec === undefined && taxi.destination?.startsWith('RWY') && ac.route && pendingIntermediateStops(airport, ac).length === 0
          && remainingRouteM(airport, ac) <= HANDOFF_WITHIN_M) {
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
      if (!ac.isDeparture && ac.phase === 'RUNWAY_EXIT' && pending === 'TAXI' && !hasActive(ac, 'TAXI_TO_PARKING')) {
        const p = planParking(state, ac);
        if (!p || opposingTraffic(state, p.nodeIds, ac.id)) continue;
        plans.push({
          key: `${ac.id}:to-parking`, aircraftId: ac.id, callsign: ac.callsign, priority: 50,
          cmds: [mkCmd('TAXI_TO_PARKING', ac, { destination: p.spot.id, route: p.via, holdShort: p.holdShort })],
          phrase: say.taxiToParking(ac, p.spot, p.via, p.holdShort),
          summary: `${ac.callsign} taxi to ${p.spot.name}`,
        });
      }
    }
    return plans;
  };
}

