/**
 * Airport ground vehicles (operations trucks): runway inspections, pavement inspections and errands between ramps.
 *
 * A vehicle is an `Aircraft` of type VEH (performance.ts, `craft: 'vehicle'`) that lives on the taxiway graph, so it uses the ground-movement
 * model, hold-short points, runway authorisations, runway occupancy and incursion detection of every taxiing aircraft. What is specific:
 *  - Callsign "Airport <n> vehicle" (internal tag APT<n>): FAA AC 150/5210-20A Appendix B para 4.3 ("this is Airport 21 vehicle at Taxiway Alpha").
 *    Other vehicle names ("Mower Three") are not in a source and are not used.
 *  - Calls: the operator tells the controller WHO, WHERE and WHAT (AC 150/5210-20A B 4.3); the sample calls and replies there are the templates in
 *    src/radio/specialCalls.ts.
 *  - Controller instructions: "proceed" / "hold" are the verbs for vehicles, never "cleared" (JO 7110.65 3-7-2); "PROCEED AS REQUESTED" is not approved
 *    for crossing or operating on a runway (3-1-5 NOTE, 3-7-2); a clearance is required for a vehicle on any active, inactive or closed runway except per
 *    a Letter of Agreement (3-7-2 NOTE); runway use other than crossing is authorised on the local control frequency (3-1-3, civil facilities);
 *    a vehicle needs a crossing clearance for each runway it crosses (3-7-2).
 *  - A runway inspection drives the runway from the named end to the far exit and reports "is off of runway N" (AC B 4.3).
 * Vehicle speeds and the task mix are design values (no source). Mowers, follow-me and other roles have no sourced difference on the radio and are not modelled
 * as separate kinds.
 */
import type { Aircraft, Airport, ParkingPosition, Vec2 } from './types';
import { dist } from './geo';
import { getRuntime, pilotSay, setPhase, advancePhase, completeClearances, emitEvent } from './context';
import type { AircraftRuntime, SimContext } from './context';
import type { Env, PlanResult } from './commandExecutor';
import { unable } from './commandExecutor';
import { findTaxiRoute, neighborIds } from './pathfinding';
import { alongCross, crossingRunways, findRunway, findRunwayEnd } from './runways';
import { seeded01 } from './rng';
import { runwayExitNodes } from '../airport/graphUtils';
import { isVehicleType } from './performance';
import { frequencyByMhz } from '../radio/frequencies';
import { vehicleAtHoldCall, vehicleOffRunwayCall, vehicleTaxiRequestCall } from '../radio/specialCalls';
import type { VehiclePurpose } from '../radio/specialCalls';
import { checkInCall, holdingShortCrossingCall } from '../radio/readback';
import type { ReadbackEnv } from '../radio/readback';

export type VehicleTask = 'RUNWAY_INSPECTION' | 'PAVEMENT_INSPECTION' | 'ERRAND';

export interface VehicleRuntime {
  task: VehicleTask;
  /** Runway pair id of the inspection ("13/31") and the end it starts at ("13": driven toward the opposite end). */
  runwayId?: string;
  runwayEnd?: string;
  /** Errand: the kind of ramp it drives to. */
  errandCategory?: ParkingPosition['category'];
  /** Parking position it leaves from and returns to. */
  homeParkingId: string;
  stage: 'OUT' | 'ON_TASK' | 'DWELL' | 'RETURNING';
  /** The inspection run has been on the runway surface. */
  enteredRunway?: boolean;
  /** Errand: parked at the destination since (sim seconds). */
  dwellSinceSec?: number;
}

/** Errand dwell time at the far ramp before the vehicle asks to go back (design value). */
export const ERRAND_DWELL_SEC = 40;

export const isVehicle = (ac: Pick<Aircraft, 'type'>): boolean => isVehicleType(ac.type);

/** The opposite end of the runway that `endId` belongs to. */
export function oppositeEnd(airport: Airport, endId: string): string | undefined {
  const g = findRunwayEnd(airport, endId);
  if (!g) return undefined;
  const other = g.runway.ends.find((e) => e.id !== g.end.id);
  return other?.id;
}

/** Initialise a freshly spawned vehicle (called by spawnFromSpec once it stands at its parking position). */
export function initVehicle(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, b: { task: VehicleTask; runwayId?: string; errandCategory?: ParkingPosition['category'] }, homeParkingId: string): void {
  const airport = ctx.state.airport;
  let runwayEnd: string | undefined;
  if (b.task === 'RUNWAY_INSPECTION') {
    const rw = findRunway(airport, b.runwayId) ?? airport.runways[0];
    // which end the inspection starts at: a fixed function of the vehicle's seed
    runwayEnd = rw.ends[seeded01(ac.seed, 'veh-end') < 0.5 ? 0 : 1].id;
    b = { ...b, runwayId: rw.id };
    ac.assignedRunwayEnd = runwayEnd;
  }
  rt.vehicle = { task: b.task, runwayId: b.runwayId, runwayEnd, errandCategory: b.errandCategory, homeParkingId, stage: 'OUT' };
  ac.isDeparture = true;
  ac.flightRules = 'VFR';
  ac.flags.vehicleTask = b.task;
  ac.flags.vehicleHome = homeParkingId;
}

function purposeOf(v: VehicleRuntime): VehiclePurpose {
  return v.task === 'RUNWAY_INSPECTION' ? 'runway inspection' : v.task === 'PAVEMENT_INSPECTION' ? 'pavement inspection' : 'ops errand';
}

/**
 * Vehicle radio calls (updatePilotRequests hands every vehicle here and skips the aeroplane logic). Returns true when the vehicle spoke.
 */
export function vehiclePilotCalls(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, env: ReadbackEnv): boolean {
  const v = rt.vehicle;
  if (!v) return false;
  const { state } = ctx;
  const now = state.clock.timeSec;
  const airport = state.airport;
  const pos = frequencyByMhz(airport, ac.frequencyMhz)?.position;

  // 1. First call from the parking position (who / where / what).
  if (ac.phase === 'PARKED' && v.stage === 'OUT' && !rt.calls.has('vehReq') && now >= rt.firstCallAtSec) {
    rt.calls.add('vehReq');
    const parking = airport.parking.find((p) => p.id === v.homeParkingId);
    const toWhere = v.errandCategory === 'ga' ? 'the GA ramp' : v.errandCategory === 'fbo' ? 'the FBO ramp' : v.errandCategory === 'cargo' ? 'the FAA ramp' : 'the other ramp';
    pilotSay(ctx, ac, vehicleTaxiRequestCall(ac, env, { at: parking?.name, purpose: purposeOf(v), runwayEnd: v.runwayEnd, toWhere }), { request: 'TAXI' });
    setPhase(ctx, ac, 'READY');
    ac.pendingRequest = { kind: 'TAXI', text: `request ${purposeOf(v)}`, sinceSec: now };
    return true;
  }

  // 2. Check-in after a frequency change.
  if (rt.checkInAtSec !== undefined && now >= rt.checkInAtSec) {
    rt.checkInAtSec = undefined;
    const node = rt.stoppedAtNodeId ? airport.taxiwayGraph.nodes[rt.stoppedAtNodeId] : undefined;
    if (pos === 'GND' && v.stage === 'RETURNING') {
      const taxiway = node?.taxiways[0];
      pilotSay(ctx, ac, checkInCall(ac, env, { taxiway, wantsTaxiToParking: true }).replace(/request taxi to parking\.$/, 'request taxi to the ramp.'), { checkIn: true, request: 'TAXI' });
      ac.pendingRequest = { kind: 'TAXI', text: 'request taxi to the ramp', sinceSec: now };
      return true;
    }
    pilotSay(ctx, ac, checkInCall(ac, env, {}), { checkIn: true });
    return true;
  }

  // 2b. On Tower and standing at the hold of the inspection runway: ask to proceed onto it (3-1-3).
  if (pos === 'TWR' && v.task === 'RUNWAY_INSPECTION' && v.stage === 'OUT' && ac.onGround && ac.groundSpeedKt < 1 && !rt.calls.has('vehHold')) {
    const node = rt.stoppedAtNodeId ? airport.taxiwayGraph.nodes[rt.stoppedAtNodeId] : undefined;
    const end = ac.assignedRunwayEnd ?? v.runwayEnd;
    if (node?.kind === 'holding_position' && node.runwayId && end) {
      rt.calls.add('vehHold');
      v.runwayEnd = end;
      pilotSay(ctx, ac, vehicleAtHoldCall(ac, env, { runwayEnd: end, taxiway: node.taxiways[0] }), { request: 'OTHER' });
      ac.pendingRequest = { kind: 'OTHER', text: `request to proceed on runway ${end} for a runway inspection`, sinceSec: now };
      return true;
    }
  }

  // 3. Stopped at a runway hold on the way (an errand that crosses): ask to cross.
  if (ac.onGround && rt.stoppedAtNodeId && ac.route && ac.groundSpeedKt < 1 && v.stage !== 'ON_TASK') {
    const node = airport.taxiwayGraph.nodes[rt.stoppedAtNodeId];
    const routeDone = ac.route.progressIndex >= ac.route.nodeIds.length;
    if (!routeDone && node.kind === 'holding_position' && node.runwayId && ac.route.stopAtNodeIds.includes(node.id) && !rt.calls.has(`holdX:${node.id}`)) {
      rt.calls.add(`holdX:${node.id}`);
      pilotSay(ctx, ac, holdingShortCrossingCall(ac, env, node.runwayId, node.taxiways[0]), { request: 'CROSSING' });
      ac.pendingRequest = { kind: 'CROSSING', text: `holding short of runway ${node.runwayId}`, sinceSec: now };
      return true;
    }
  }

  // 4. Off the inspection runway: report (AC 150/5210-20A B 4.3: "Airport 21 vehicle is off of runway 19 right").
  if (v.task === 'RUNWAY_INSPECTION' && v.stage === 'ON_TASK' && v.runwayId) {
    if (ac.occupyingRunways.includes(v.runwayId)) v.enteredRunway = true;
    const routeDone = !ac.route || ac.route.progressIndex >= ac.route.nodeIds.length;
    if (v.enteredRunway && routeDone && !ac.occupyingRunways.includes(v.runwayId) && ac.groundSpeedKt < 1 && !rt.calls.has('vehOff')) {
      rt.calls.add('vehOff');
      pilotSay(ctx, ac, vehicleOffRunwayCall(ac, env, { runwayEnd: v.runwayEnd ?? v.runwayId, inspectionComplete: true }), { request: 'FREQUENCY_CHANGE' });
      ac.pendingRequest = { kind: 'FREQUENCY_CHANGE', text: 'off the runway, inspection complete', sinceSec: now };
      v.stage = 'RETURNING';
      completeClearances(ctx, ac, ['PROCEED']);
      return true;
    }
  }

  // 5. Errand: dwell at the far ramp, then ask to go back.
  if (v.task === 'ERRAND' && v.stage === 'ON_TASK' && ac.phase === 'PARKED' && ac.onGround && !airport.parking.some((p) => p.id === v.homeParkingId && dist(p.pos, ac.pos) < 8)) {
    v.dwellSinceSec ??= now;
    if (now - v.dwellSinceSec >= ERRAND_DWELL_SEC && !rt.calls.has('vehBack')) {
      rt.calls.add('vehBack');
      v.stage = 'RETURNING';
      const parking = airport.parking.find((p) => dist(p.pos, ac.pos) < 8);
      pilotSay(ctx, ac, `${vehicleTaxiRequestCall(ac, env, { at: parking?.name, purpose: 'ops errand', toWhere: 'the home ramp' })}`, { request: 'TAXI' });
      setPhase(ctx, ac, 'READY');
      ac.pendingRequest = { kind: 'TAXI', text: 'request to return to the home ramp', sinceSec: now };
      return true;
    }
  }
  return false;
}

/** Per-tick vehicle bookkeeping that is not a radio call: the stage after a PROCEED, the return to the ramp. */
export function updateVehicles(ctx: SimContext): void {
  for (const ac of Object.values(ctx.state.aircraft)) {
    if (!isVehicle(ac)) continue;
    const rt = getRuntime(ctx, ac);
    const v = rt.vehicle;
    if (!v) continue;
    // A taxi to the ramp / pavement tour that ended at the home position: the task is done (lifecycle removes the vehicle).
    if (ac.phase === 'PARKED' && (v.stage === 'RETURNING' || (v.task === 'PAVEMENT_INSPECTION' && v.stage === 'ON_TASK'))) v.stage = 'DWELL';
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// PROCEED planner
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * "Airport two one vehicle, proceed on runway one three, report runway inspection complete": the vehicle drives the runway from the hold it stands at
 * to the exit nearest the far end and stops short of the exit's hold line. Also "proceed on the taxiways" (a pavement inspection tour that never enters a
 * runway). Refused for anything that is not a vehicle, and for a runway the vehicle is not holding short of.
 */
export function planProceed(env: Env): PlanResult {
  const { ac, rt, cmd, airport, ctx } = env;
  const graph = airport.taxiwayGraph;
  if (!isVehicle(ac)) return unable(env, `"Proceed" is the instruction for vehicles; ${ac.callsign} is an aircraft (JO 7110.65 3-7-2: aircraft taxi or are cleared).`, "we're an aircraft");
  const v = rt.vehicle;
  if (!v) return unable(env, `${ac.callsign} has no task.`, 'we have no task');

  if (cmd.destination === 'TAXIWAYS') {
    const tour = pavementTour(ctx, ac, v);
    if (!tour) return unable(env, `No taxiway tour from ${ac.callsign}'s position.`, "we can't reach the taxiways");
    return {
      plan: {
        patch: { destination: 'TAXIWAYS', route: tour.taxiways },
        commit: () => {
          ac.route = { nodeIds: tour.nodeIds, taxiways: tour.taxiways, stopAtNodeIds: [], progressIndex: 0 };
          rt.stoppedAtNodeId = undefined;
          ac.flags.holdingPosition = false;
          v.stage = 'ON_TASK';
          completeClearances(ctx, ac, ['TAXI', 'TAXI_TO_PARKING']);
          advancePhase(ctx, ac, 'TAXIING');
        },
      },
    };
  }

  const rawRunway = cmd.runwayId ?? cmd.runwayEnd;
  const rw = findRunway(airport, rawRunway);
  if (!rw) return unable(env, `Unknown runway "${rawRunway}".`, "we can't find that runway");
  const hold = rt.stoppedAtNodeId ? graph.nodes[rt.stoppedAtNodeId] : undefined;
  if (!hold || hold.kind !== 'holding_position' || hold.runwayId !== rw.id || dist(hold.pos, ac.pos) > 6) {
    return unable(env, `${ac.callsign} is not holding short of runway ${rw.id}; a vehicle needs to be at the hold line to be cleared onto the runway.`, `we're not holding short of runway ${rw.id}`);
  }
  // start end: the one the controller named (a runway end), else the vehicle's own request, else the end the hold protects
  const named = cmd.runwayEnd ? findRunwayEnd(airport, cmd.runwayEnd) : undefined;
  const startEnd = named?.runway.id === rw.id ? named : findRunwayEnd(airport, v.runwayEnd ?? hold.protectsRunwayEnd ?? rw.ends[0].id)!;
  const run = runwayRun(airport, hold, startEnd.end.id);
  if (!run) return unable(env, `No way along runway ${rw.id} from ${hold.id}.`, "we can't see a way onto the runway");
  return {
    plan: {
      patch: { runwayId: rw.id, runwayEnd: startEnd.end.id, reportClear: cmd.reportClear ?? true, destination: v.task === 'RUNWAY_INSPECTION' ? 'INSPECTION' : undefined },
      commit: () => {
        ac.route = { nodeIds: run.nodeIds, taxiways: [hold.taxiways[0] ?? rw.id], stopAtNodeIds: [], progressIndex: 0 };
        // JO 7110.65 3-7-2: a vehicle cleared onto a runway for runway operations may cross the intersecting runways unless restricted
        for (const id of [rw.id, ...crossingRunways(airport, rw.id).map((r) => r.id)]) if (!ac.runwayAuthorizations.includes(id)) ac.runwayAuthorizations.push(id);
        rt.stoppedAtNodeId = undefined;
        ac.flags.holdingPosition = false;
        v.stage = 'ON_TASK';
        v.enteredRunway = false;
        v.runwayId = rw.id;
        v.runwayEnd = startEnd.end.id;
        completeClearances(ctx, ac, ['TAXI', 'TAXI_TO_PARKING']);
        if (ac.phase === 'HOLDING_SHORT') setPhase(ctx, ac, 'TAXIING', `proceeding on runway ${rw.id}`);
        emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', text: `${ac.callsign} proceeding on runway ${rw.id} from the ${startEnd.end.id} end`, data: { vehicleRun: true, runwayId: rw.id } });
      },
    },
  };
}

/**
 * Node route that drives the runway: hold -> entry runway node -> along the runway toward the far end -> the exit nearest the far end -> the hold line of
 * that exit. `startEndId` is the end the run starts at.
 */
export function runwayRun(airport: Airport, hold: { id: string; pos: Vec2 }, startEndId: string): { nodeIds: string[] } | undefined {
  const graph = airport.taxiwayGraph;
  const g = findRunwayEnd(airport, startEndId);
  if (!g) return undefined;
  const rid = g.runway.id;
  // the runway node a hold line leads to: a linked runway node, else the nearest one (the same rule as a line-up, commandExecutor.runwayEntryNode)
  const linked = neighborIds(graph, hold.id).map((i) => graph.nodes[i]).filter((n) => n.kind === 'runway' && n.runwayId === rid);
  const pool = linked.length ? linked : Object.values(graph.nodes).filter((n) => n.kind === 'runway' && n.runwayId === rid && dist(n.pos, hold.pos) <= 200);
  const entry = pool.sort((a, b) => dist(a.pos, hold.pos) - dist(b.pos, hold.pos))[0];
  if (!entry) return undefined;
  const holdsOf = (n: { id: string; pos: Vec2 }) => {
    const near = neighborIds(graph, n.id).map((i) => graph.nodes[i]).filter((x) => x.kind === 'holding_position' && x.runwayId === rid);
    return (near.length ? near : Object.values(graph.nodes).filter((x) => x.kind === 'holding_position' && x.runwayId === rid && dist(x.pos, n.pos) <= 150)).filter((x) => x.id !== hold.id);
  };
  const alongOf = (p: Vec2): number => alongCross(g, p).along;
  const runwayNodes = Object.values(graph.nodes).filter((n) => n.kind === 'runway' && n.runwayId === rid).sort((a, b) => alongOf(a.pos) - alongOf(b.pos));
  const exits = runwayExitNodes(airport, g.end.id)
    .map((e) => ({ e, holds: holdsOf(e.node) }))
    .filter((x) => x.holds.length && alongOf(x.e.node.pos) > alongOf(entry.pos) + 50);
  if (!exits.length) return undefined;
  const last = exits[exits.length - 1];
  const exitHold = last.holds.sort((a, b) => dist(a.pos, last.e.node.pos) - dist(b.pos, last.e.node.pos))[0];
  const exitNode = last.e.node;
  const slice = runwayNodes.filter((n) => alongOf(n.pos) >= alongOf(entry.pos) - 1 && alongOf(n.pos) <= alongOf(exitNode.pos) + 1);
  // hold -> entry is a direct link (as for a line-up); the rest follows the runway nodes
  const ids: string[] = [hold.id, entry.id];
  // The runway nodes are the centreline points of the runway (graph edges between them may run over a parallel taxiway): follow them in order.
  for (const n of slice) if (n.id !== entry.id) ids.push(n.id);
  if (ids[ids.length - 1] !== exitNode.id) ids.push(exitNode.id);
  ids.push(exitHold.id);
  return { nodeIds: ids };
}

/** A tour of three taxiway points that never touches a runway, from the vehicle's node back to its home parking position. */
function pavementTour(ctx: SimContext, ac: Aircraft, v: VehicleRuntime): { nodeIds: string[]; taxiways: string[] } | undefined {
  const graph = ctx.state.airport.taxiwayGraph;
  const home = ctx.state.airport.parking.find((p) => p.id === v.homeParkingId);
  const startId = home?.nodeId;
  const here = Object.values(graph.nodes).filter((n) => dist(n.pos, ac.pos) < 3)[0]?.id ?? startId;
  if (!here || !home) return undefined;
  const cands = Object.values(graph.nodes).filter((n) => (n.kind === 'taxiway' || n.kind === 'intersection') && n.taxiways.some((t) => t && t !== 'UNNAMED') && dist(n.pos, ac.pos) > 150);
  if (!cands.length) return undefined;
  const picks: string[] = [];
  for (let i = 0; i < 3; i++) {
    const idx = Math.min(cands.length - 1, Math.floor(seeded01(ac.seed, `tour${i}`) * cands.length));
    picks.push(cands[idx].id);
  }
  const ids: string[] = [here];
  const twys: string[] = [];
  let cur = here;
  for (const target of [...picks, home.nodeId]) {
    if (target === cur) continue;
    const leg = findTaxiRoute(graph, cur, target, { avoidRunways: true, allowedRunwayIds: [] });
    if (!leg.route) continue;
    ids.push(...leg.route.nodeIds.slice(1));
    for (const t of leg.route.taxiways) if (!twys.includes(t)) twys.push(t);
    cur = target;
  }
  if (cur !== home.nodeId || ids.length < 3) return undefined;
  return { nodeIds: ids, taxiways: twys.filter((t) => t && t !== 'UNNAMED' && !t.startsWith('RWY')).slice(0, 4) };
}

