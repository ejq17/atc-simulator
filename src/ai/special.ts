/**
 * AI handling of the traffic-variety kinds: airport vehicles, Coast Guard helicopters, VFR transitions (Class C service), flight-training circuits and
 * the overhead maneuver. One agent per position; Ground, Tower and Approach each add the plans for the aircraft tuned to them.
 *
 * Everything here is deliberately conservative: a vehicle is sent onto a runway only when the engine's own safety check accepts it (no traffic on the runway,
 * nothing landing / departing within the vehicle window), a helicopter is cleared only when no aeroplane is near its straight path, and every plan is checked
 * again by the engine when it is performed. Sources are in docs/FAA-REFERENCES.md "Traffic variety".
 */
import type { Aircraft, ControllerPositionId, SimulationState, Vec2 } from '../sim/types';
import { assessClearanceSafety } from '../sim/conflicts';
import { isRotorcraftType, isVehicleType, patternAltitudeFt, getPerformance } from '../sim/performance';
import { findRunwayEnd } from '../sim/runways';
import { digitsSpoken } from '../radio/spoken';
import { cardinal, mToNm, trueToMagnetic, dist } from '../sim/geo';
import { clearBearingFrom } from '../sim/rotorcraft';
import { fixedWingNearTrack } from '../sim/helicopterSeparation';
import { closedTaxiways } from '../sim/airportOps';
import { frequencyForPosition } from '../radio/frequencies';
import { hasActive, mkCmd } from './core';
import type { Agent, AgentView, Plan } from './core';
import { busyHoldIds, holdNodeAt, opposingTraffic, planDeparture, taxiStartNode } from './world';
import { findTaxiRoute } from '../sim/pathfinding';
import { pavementTour } from '../sim/vehicles';
import { runwayInUse } from './ground';
import * as say from './phrase';

const stationary = (ac: Aircraft): boolean => ac.groundSpeedKt < 1;

/** The transponder code assigned to a transit: a fixed function of the aircraft's seed, 4 octal digits in 2000-6777 (never 1200, 7500, 7600, 7700). */
export function transitSquawk(ac: Aircraft): string {
  const n = 1024 + ((ac.seed >>> 4) % 3000); // 2000..5999 octal as a number, rendered in base 8
  const code = n.toString(8).padStart(4, '0');
  return code === '1200' ? '2100' : code;
}

/** A transit is released once this far out and moving away (nm). */
const TERMINATE_NM = 8;
/** An inbound helicopter without a landing clearance hovers when this close to its pad (nm; design value): the pads lie within 1 nm of the runway tracks, so it waits outside them. */
const HOVER_HOLD_NM = 7;

/**
 * A helicopter's straight path is clear when no fixed-wing aircraft is rolling or airborne below the helicopter band within the separation distance of it
 * (`helicopterSeparation.ts`; pattern traffic at 1,000 ft AGL or higher is 500 ft or more above a helicopter that has levelled at 400 ft AGL and does not
 * block it).
 */
export function heliPathClear(state: SimulationState, from: Vec2, to: Vec2, exceptId: string): boolean {
  return fixedWingNearTrack(state, [from, to], exceptId, true).length === 0;
}

function windPhrase(v: AgentView): say.Phrase {
  const w = v.state.weather;
  const magDir = w.windDirDeg === 'VRB' ? undefined : (Math.round(trueToMagnetic(w.windDirDeg, v.airport.magneticVariationDeg) / 10) * 10 + 360) % 360 || 360;
  if (w.windSpeedKt === 0) return { text: 'wind calm', spoken: 'wind calm' };
  if (magDir === undefined) return { text: `wind variable at ${w.windSpeedKt}`, spoken: `wind variable at ${digitsSpoken(String(w.windSpeedKt))}` };
  const d = String(magDir).padStart(3, '0');
  return { text: `wind ${d} at ${w.windSpeedKt}`, spoken: `wind ${digitsSpoken(d)} at ${digitsSpoken(String(w.windSpeedKt))}` };
}

/**
 * Another vehicle is under way on the movement area. Vehicle movements are queued: Ground starts one only when no other vehicle is taxiing, and Tower
 * sends a vehicle onto a runway only then (a vehicle route is not checked against another vehicle's route, so two vehicles on the lanes at once could meet
 * head-on or arrive at the same ramp spot; the engine's leader spacing does not see an opposing vehicle). Aircraft are separated from vehicles by the
 * ordinary opposing-traffic and runway checks.
 */
export function otherVehicleMoving(state: SimulationState, ac: Aircraft, includeHolding = false): boolean {
  return Object.values(state.aircraft).some((o) => o.id !== ac.id && isVehicleType(o.type) && (o.phase === 'TAXIING' || (includeHolding && o.phase === 'HOLDING_SHORT')));
}

/** Aircraft are moving the other way on (part of) the route of a vehicle from where it stands to a parking node: the vehicle waits (same rule as the aircraft taxi plans). */
function routeBlocked(v: AgentView, ac: Aircraft, toNodeId: string): boolean {
  const start = taxiStartNode(v.airport, ac);
  if (!start) return true;
  const r = findTaxiRoute(v.airport.taxiwayGraph, start.id, toNodeId, { avoidRunways: true, allowedRunwayIds: v.airport.runways.map((x) => x.id), avoidTaxiways: closedTaxiways(v.state) });
  return !r.route || !!opposingTraffic(v.state, r.route.nodeIds, ac.id);
}

function vehicleGroundPlans(v: AgentView, ac: Aircraft): Plan[] {
  const { airport, state } = v;
  const pending = ac.pendingRequest;
  if (!pending || pending.kind !== 'TAXI' || !stationary(ac) || hasActive(ac, 'PROCEED')) return [];
  // (a vehicle standing at a hold line is part of the queue too: two vehicles holding short on both sides of a runway would wait for each other)
  if (otherVehicleMoving(state, ac, true)) return [];
  // Vehicles also wait for the taxiways to be quiet: a vehicle cannot pull off a lane, so one that starts while an aircraft is taxiing toward it meets it
  // head-on (the aircraft plans check the vehicle's route, but an aircraft already under way is not re-routed). Standing aircraft do not matter.
  if (Object.values(state.aircraft).some((o) => o.onGround && !isVehicleType(o.type) && (o.phase === 'TAXIING' || o.phase === 'TAXI_TO_PARKING' || o.phase === 'PUSHBACK') && o.groundSpeedKt > 0.5)) return [];
  const task = ac.flags.vehicleTask;
  const key = `${ac.id}:veh-ground:${pending.sinceSec}`;
  const mk = (cmds: Plan['cmds'], phrase: say.Phrase, summary: string): Plan => ({ key, aircraftId: ac.id, callsign: ac.callsign, priority: 50, cmds, phrase, summary, once: true });
  const home = ac.flags.vehicleHome;
  // Back from the inspection run / the errand: proceed to the home ramp.
  if (/ramp/.test(pending.text) && home && (ac.phase === 'HOLDING_SHORT' || ac.phase === 'TAXIING' || ac.phase === 'READY')) {
    const spot = airport.parking.find((p) => p.id === home);
    if (!spot || routeBlocked(v, ac, spot.nodeId)) return [];
    return [mk([mkCmd('TAXI_TO_PARKING', ac, { destination: spot.id })], say.proceedToRamp(ac, [], []), `${ac.callsign} proceed to the ramp`)];
  }
  if (ac.phase !== 'READY' && ac.phase !== 'PARKED') return [];
  if (task === 'RUNWAY_INSPECTION') {
    const end = findRunwayEnd(airport, ac.assignedRunwayEnd);
    if (!end) return [];
    const dep = planDeparture(airport, ac, [end.end.id, ...end.runway.ends.map((e) => e.id).filter((e) => e !== end.end.id)], busyHoldIds(state, ac.id), closedTaxiways(state));
    if (!dep || opposingTraffic(state, dep.nodeIds, ac.id)) return [];
    // inspect the runway that is not in use by the traffic first; if it is in use the vehicle waits at the hold for Tower (the engine's PROCEED check decides)
    return [mk([mkCmd('TAXI', ac, { destination: `RWY${dep.runwayEnd}`, runwayEnd: dep.runwayEnd, route: dep.via, holdShort: dep.holdShort })], say.proceedToRunway(ac, dep.runwayEnd, dep.via, dep.holdShort), `${ac.callsign} proceed to runway ${dep.runwayEnd} for the inspection`)];
  }
  if (task === 'PAVEMENT_INSPECTION') {
    // one vehicle at a time on the taxiways (the tour routes overlap)
    if (Object.values(state.aircraft).some((o) => o.id !== ac.id && isVehicleType(o.type) && o.flags.vehicleTask === 'PAVEMENT_INSPECTION' && o.phase === 'TAXIING')) return [];
    const tour = home ? pavementTour(airport, ac, home) : undefined;
    if (!tour || opposingTraffic(state, tour.nodeIds, ac.id)) return [];
    return [mk([mkCmd('PROCEED', ac, { destination: 'TAXIWAYS' })], say.proceedOnTaxiways(ac), `${ac.callsign} proceed on the taxiways`)];
  }
  if (task === 'ERRAND') {
    const want = /FBO/i.test(pending.text) ? 'fbo' : /FAA/i.test(pending.text) ? 'cargo' : 'ga';
    const spot = airport.parking.filter((p) => p.category === want && p.id !== home).sort((a, b) => dist(a.pos, ac.pos) - dist(b.pos, ac.pos))
      .find((p) => !Object.values(state.aircraft).some((o) => o.id !== ac.id && o.onGround && dist(o.pos, p.pos) < 10));
    if (!spot || routeBlocked(v, ac, spot.nodeId)) return [];
    return [mk([mkCmd('TAXI_TO_PARKING', ac, { destination: spot.id })], say.proceedToRamp(ac, [], []), `${ac.callsign} proceed to ${spot.name}`)];
  }
  return [];
}

function vehicleTowerPlans(v: AgentView, ac: Aircraft): Plan[] {
  const { airport, state } = v;
  const pending = ac.pendingRequest;
  if (!pending || !stationary(ac)) return [];
  if (pending.kind === 'OTHER' && /request to proceed on runway/.test(pending.text)) {
    const hold = holdNodeAt(airport, ac);
    const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
    if (!hold || !g || hold.runwayId !== g.runway.id) return [];
    const cmd = mkCmd('PROCEED', ac, { runwayEnd: g.end.id, runwayId: g.runway.id, reportClear: true });
    if (otherVehicleMoving(state, ac) || runwayInUse(v, g.runway.id, ac.id) || !assessClearanceSafety(state, cmd).safe) return [];
    return [{
      key: `${ac.id}:proceed:${pending.sinceSec}`, aircraftId: ac.id, callsign: ac.callsign, priority: 60, cmds: [cmd], once: true,
      phrase: say.proceedOnRunway(ac, g.end.id, 'report runway inspection complete'), summary: `${ac.callsign} proceed on runway ${g.end.id}, inspection`,
    }];
  }
  if (pending.kind === 'FREQUENCY_CHANGE' && ac.occupyingRunways.length === 0) {
    const gnd = v.staffed.has('GND') ? frequencyForPosition(airport, 'GND') : undefined;
    if (gnd) {
      return [{
        key: `${ac.id}:veh-to-gnd`, aircraftId: ac.id, callsign: ac.callsign, priority: 55, once: true,
        cmds: [mkCmd('CONTACT_FREQUENCY', ac, { frequencyId: gnd.id })], phrase: say.contact(ac, airport, gnd.id, gnd.mhz), summary: `${ac.callsign} handed to Ground`,
      }];
    }
  }
  return [];
}

function heliPlans(v: AgentView, ac: Aircraft, position: ControllerPositionId): Plan[] {
  const { airport, state } = v;
  const plans: Plan[] = [];
  const pending = ac.pendingRequest;
  // Departure from the pad: Tower, JO 7110.65 3-11-2.
  if (position === 'TWR' && ac.onGround && ac.phase === 'READY' && pending?.kind === 'DEPARTURE' && stationary(ac)) {
    const bearing = clearBearingFrom(airport, ac.pos, 180);
    const hovering = Object.values(state.aircraft).some((o) => o.id !== ac.id && isRotorcraftType(o.type) && !o.onGround && o.altitudeFt - airport.elevationFt < 100 && dist(o.pos, ac.pos) < 150);
    const magB = bearing === undefined ? 0 : Math.round(trueToMagnetic(bearing, airport.magneticVariationDeg));
    const takeoffCmd = mkCmd('TAKEOFF', ac, { headingDeg: magB === 0 ? 360 : magB });
    if (bearing !== undefined && !hovering && assessClearanceSafety(state, takeoffCmd).safe) {
      const mag = magB;
      const pad = airport.parking.find((p) => dist(p.pos, ac.pos) < 12);
      const turn: 'left' | 'right' = Math.sin(((bearing - ac.headingDeg) * Math.PI) / 180) >= 0 ? 'right' : 'left';
      plans.push({
        key: `${ac.id}:heli-takeoff`, aircraftId: ac.id, callsign: ac.callsign, priority: 70, once: true,
        cmds: [mkCmd('TAKEOFF', ac, { headingDeg: mag === 0 ? 360 : mag, turnDirection: turn })],
        phrase: say.heliTakeoff(ac, (pad?.name ?? 'present position').replace(/^USCG/i, 'Coast Guard'), turn, cardinal(bearing)),
        summary: `${ac.callsign} cleared for takeoff from ${pad?.name ?? 'the ramp'}, ${cardinal(bearing)} departure`,
      });
    }
  }
  // Air taxi between pads: Ground, 3-11-1.
  if (position === 'GND' && ac.onGround && ac.phase === 'READY' && pending?.kind === 'TAXI' && stationary(ac) && ac.flags.padId) {
    const pad = airport.parking.find((p) => p.id === ac.flags.padId);
    const busy = pad && Object.values(state.aircraft).some((o) => o.id !== ac.id && o.onGround && dist(o.pos, pad.pos) < 20);
    if (pad && !busy) {
      plans.push({
        key: `${ac.id}:air-taxi`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, once: true,
        cmds: [mkCmd('AIR_TAXI', ac, { destination: pad.id, taxiMode: 'air' })], phrase: say.airTaxi(ac, pad.name.replace(/^USCG/i, 'Coast Guard')),
        summary: `${ac.callsign} air taxi to ${pad.name}`,
      });
    }
  }
  // Crossing request while air taxiing: the same rule as for aeroplanes (the runway must be free).
  if (ac.onGround && pending?.kind === 'CROSSING' && stationary(ac)) {
    const hold = holdNodeAt(airport, ac);
    if (hold?.runwayId && !runwayInUse(v, hold.runwayId, ac.id)) {
      const cmd = mkCmd('CROSS_RUNWAY', ac, { crossRunwayId: hold.runwayId, runwayId: hold.runwayId });
      if (assessClearanceSafety(state, cmd).safe) {
        plans.push({ key: `${ac.id}:heli-cross:${hold.runwayId}`, aircraftId: ac.id, callsign: ac.callsign, priority: 60, cmds: [cmd], phrase: say.crossRunway(ac, hold.runwayId), summary: `${ac.callsign} cross runway ${hold.runwayId}` });
      }
    }
  }
  // Close to the pad without a landing clearance (traffic near its path): hover until cleared.
  if (position === 'TWR' && !ac.onGround && !ac.isDeparture && ac.phase === 'INBOUND') {
    const pad = airport.parking.find((p) => p.id === ac.flags.padId);
    if (pad && dist(ac.pos, pad.pos) < HOVER_HOLD_NM * 1852 && dist(ac.pos, pad.pos) > 1852 && ac.airspeedKt > 20 && !heliPathClear(state, ac.pos, pad.pos, ac.id)) {
      plans.push({ key: `${ac.id}:heli-hold`, aircraftId: ac.id, callsign: ac.callsign, priority: 90, cmds: [mkCmd('HOLD_POSITION', ac)], phrase: say.holdPosition(ac), cooldownSec: 60, summary: `${ac.callsign} hold position` });
    }
  }
  // Landing at the pad: Tower, 3-11-6. Wait (hover) when an aeroplane is near the helicopter's straight path.
  if (position === 'TWR' && !ac.onGround && !ac.isDeparture && (ac.phase === 'INBOUND' || ac.phase === 'APPROACH') && (!hasActive(ac, 'LAND') || ac.airspeedKt < 5)) {
    const pad = airport.parking.find((p) => p.id === ac.flags.padId);
    if (pad && pending?.kind === 'LANDING') {
      const occupied = Object.values(state.aircraft).some((o) => o.id !== ac.id && o.onGround && dist(o.pos, pad.pos) < 15);
      if (!occupied && heliPathClear(state, ac.pos, pad.pos, ac.id)) {
        plans.push({
          key: `${ac.id}:heli-land:${ac.clearances.filter((c) => c.kind === 'LAND').length}`, aircraftId: ac.id, callsign: ac.callsign, priority: 65, once: true,
          cmds: [mkCmd('LAND', ac, { destination: pad.id })], phrase: say.heliLand(ac, pad.name.replace(/^USCG/i, 'Coast Guard')), summary: `${ac.callsign} cleared to land at ${pad.name}`,
        });
      }
    }
  }
  return plans;
}

function transitPlans(v: AgentView, ac: Aircraft): Plan[] {
  const plans: Plan[] = [];
  const fac = v.facility(ac);
  if (!ac.radarIdentified && ac.squawk === '1200' && ac.pendingRequest?.text.includes('transition')) {
    const code = transitSquawk(ac);
    plans.push({
      key: `${ac.id}:transit-squawk`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, once: true,
      cmds: [mkCmd('SQUAWK', ac, { squawk: code })], phrase: say.squawkCode(ac, code), summary: `${ac.callsign} squawk ${code}`,
    });
  } else if (!ac.radarIdentified && ac.squawk && ac.squawk !== '1200') {
    plans.push({
      key: `${ac.id}:transit-radar`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, once: true,
      cmds: [mkCmd('RADAR_CONTACT', ac)], phrase: say.radarContactVfr(ac, fac), summary: `${ac.callsign} radar contact`,
    });
  }
  // Leaving: once the aircraft is more than 8 nm out and moving away, the service ends (7-8-8): squawk VFR, frequency change approved.
  if (ac.radarIdentified && mToNm(dist(ac.pos, { x: 0, y: 0 })) > TERMINATE_NM && ac.pos.x * Math.sin((ac.trackDeg * Math.PI) / 180) + ac.pos.y * Math.cos((ac.trackDeg * Math.PI) / 180) > 0 && !hasActive(ac, 'FREQUENCY_CHANGE_APPROVED')) {
    plans.push({
      key: `${ac.id}:transit-end`, aircraftId: ac.id, callsign: ac.callsign, priority: 52, once: true,
      cmds: [mkCmd('SQUAWK', ac, { squawk: '1200' }), mkCmd('FREQUENCY_CHANGE_APPROVED', ac)], phrase: say.classCTerminated(ac), summary: `${ac.callsign} radar service terminated`,
    });
  }
  return plans;
}

export function createSpecialAgent(position: ControllerPositionId): Agent {
  return (v) => {
    const plans: Plan[] = [];
    const { airport } = v;
    for (const ac of v.onFrequency) {
      if (ac.radioState === 'TRANSMITTING') continue;
      if (isVehicleType(ac.type)) {
        if (position === 'GND') plans.push(...vehicleGroundPlans(v, ac));
        else if (position === 'TWR') plans.push(...vehicleTowerPlans(v, ac));
        continue;
      }
      if (isRotorcraftType(ac.type)) {
        plans.push(...heliPlans(v, ac, position));
        continue;
      }
      if (!ac.onGround && ac.flags.transit && (position === 'APP' || position === 'TWR')) plans.push(...transitPlans(v, ac));
      // overhead maneuver (3-10-12)
      if (position === 'TWR' && !ac.onGround && ac.flags.overhead && ac.assignedRunwayEnd) {
        const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
        const p = ac.pendingRequest;
        if (g && p && /inbound for the overhead/.test(p.text)) {
          const alt = Math.round(patternAltitudeFt(getPerformance(ac.type), g.elevationFt, airport.trafficPatternAltitudeFt) / 100) * 100;
          plans.push({
            key: `${ac.id}:overhead`, aircraftId: ac.id, callsign: ac.callsign, priority: 66, once: true,
            cmds: [mkCmd('OVERHEAD', ac, { runwayEnd: g.end.id, runwayId: g.runway.id, altitudeFt: alt, destination: 'INITIAL' })],
            phrase: say.overheadInstruction(ac, g.end.id, windPhrase(v), alt), summary: `${ac.callsign} overhead runway ${g.end.id}, report initial`,
          });
        } else if (g && p && p.text === 'initial') {
          plans.push({
            key: `${ac.id}:break`, aircraftId: ac.id, callsign: ac.callsign, priority: 66, once: true,
            cmds: [mkCmd('OVERHEAD', ac, { runwayEnd: g.end.id, runwayId: g.runway.id, destination: 'BREAK' })],
            phrase: say.breakAtMidfield(ac), summary: `${ac.callsign} break at midfield`,
          });
        }
      }
    }
    return plans;
  };
}

