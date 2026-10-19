/**
 * An arrival's own parking stand: assigned in the engine while the aircraft is inbound (`refreshArrivalStands`, once a second), used by the exit prediction
 * (`exitChoice.arrivalParkingTargets`) and by AI Ground's taxi-in (`ai/world.planParking`), re-resolved when something else takes the stand.
 *
 * The choice (`resolveArrivalStand`): the free stand of the category the flight parks in (the spawn's `parkingIntent`: the generator's cargo apron for a freighter
 * or a Caravan on a cargo flight; else the type's natural category - the military ramp for ANG, the pads for USCG), not one another inbound aircraft is bound for, with
 * the shortest taxi from the exits of the landing runway the type can make from its typical touchdown point (taxi metres plus the crossing cost of exitChoice.ts). DESIGN VALUE: no FAA source
 * assigns stands; Ground may still direct the aircraft elsewhere, the stand then follows the route it is given.
 */
import type { Aircraft, ParkingPosition, SimulationState } from './types';
import type { SimContext } from './context';
import { perfOf } from './context';
import { assignedStandOf, freeParkingCandidates, standsReservedByOthers } from './parkingResolver';
import { findRunwayEnd } from './runways';
import { isVehicleType } from './performance';
import { rolloutExitOptions, runwayExits } from './flightDynamics';
import { CROSSING_COST_M, holdToParking } from './exitChoice';
import { dist, ktToMps } from './geo';

/** An exit nearer than this (m) to the threshold is not one the arrivals use (a C172 touches down about 390 m in). */
const EXIT_MIN_ALONG_M = 400;

export function resolveArrivalStand(state: SimulationState, ac: Aircraft): ParkingPosition | undefined {
  const perf = perfOf(ac);
  const military = (p: ParkingPosition) => p.category !== 'military' || perf.category === 'light' || !!perf.military;
  const taken = standsReservedByOthers(state, ac.id);
  const intent = ac.parkingIntent;
  const zone = intent === 'military' ? (ac.type === 'H65' ? 'USCG-' : 'ANG-') : undefined;
  let cands = (intent ? freeParkingCandidates(state, ac, intent, undefined, zone) : freeParkingCandidates(state, ac, undefined, undefined)).filter((p) => military(p) && !taken.has(p.id));
  if (!cands.length && intent) cands = freeParkingCandidates(state, ac, undefined, undefined).filter((p) => military(p) && !taken.has(p.id));
  if (!cands.length) return undefined;
  const g = ac.assignedRunwayEnd ? findRunwayEnd(state.airport, ac.assignedRunwayEnd) : undefined;
  // the exits the type can make from its typical touchdown (the same braking logic as the exit choice), best first; the stand is the one nearest to them
  let holds: string[] = [];
  if (g) {
    const probe = { ...ac, assignedStand: undefined } as Aircraft;
    const td = g.displacedM + (perf.category === 'light' ? 390 : 490);
    holds = [...new Set(rolloutExitOptions(state, probe, g, td, ktToMps(perf.touchdownSpeedKt)).map((o) => o.holdNodeId))];
    if (!holds.length) holds = runwayExits({ state } as SimContext, g, false).filter((x) => x.along - g.displacedM >= EXIT_MIN_ALONG_M).flatMap((x) => x.holds.map((h) => h.id));
  }
  const ref = g ? { x: g.end.threshold.x + g.dir.x * 450, y: g.end.threshold.y + g.dir.y * 450 } : ac.pos;
  const cost = (p: ParkingPosition): number => {
    if (!holds.length) return dist(p.pos, ref);
    let best = Infinity;
    for (const h of holds) {
      const w = holdToParking(state, h, [p]);
      best = Math.min(best, w.taxiM + w.crossings * CROSSING_COST_M);
    }
    return best;
  };
  let pick = cands[0];
  let pickCost = cost(pick);
  for (const p of cands.slice(1)) {
    const c = cost(p);
    if (c < pickCost - 1e-6 || (Math.abs(c - pickCost) <= 1e-6 && p.id < pick.id)) { pick = p; pickCost = c; }
  }
  return pick;
}

/**
 * Once a second: give every inbound arrival its stand, and re-resolve when the stand has since been taken (another aircraft standing on it or cleared to it).
 * An arrival taxiing to a stand is bound for the stand its route ends at.
 */
export function refreshArrivalStands(ctx: SimContext): void {
  const state = ctx.state;
  const sec = Math.floor(state.clock.timeSec + 1e-9);
  if (ctx.standCheckSec === sec) return;
  ctx.standCheckSec = sec;
  for (const ac of Object.values(state.aircraft)) {
    if (ac.isDeparture || ac.flags.transit || ac.flags.vehicleTask || isVehicleType(ac.type)) continue;
    if (ac.phase === 'PARKED' || ac.phase === 'ARRIVED') continue;
    if (ac.phase === 'TAXI_TO_PARKING') {
      const last = ac.route?.nodeIds[ac.route.nodeIds.length - 1];
      const p = last ? state.airport.parking.find((x) => x.nodeId === last) : undefined;
      if (p) ac.assignedStand = { parkingId: p.id, category: p.category };
      continue;
    }
    if (ac.onGround && ac.phase !== 'ROLLOUT' && ac.phase !== 'RUNWAY_EXIT') continue;
    if (assignedStandOf(state, ac)) continue;
    const p = resolveArrivalStand(state, ac);
    ac.assignedStand = p ? { parkingId: p.id, category: p.category } : undefined;
  }
}
