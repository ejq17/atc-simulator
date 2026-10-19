/**
 * The exit stubs landers are about to use. An arrival inside `LANDER_STUB_NM` of its threshold, or rolling out, will leave the runway at an exit and
 * stop on the taxiway beyond the hold line (the stub, `exitChoice.EXIT_STUB_M`) to wait for Ground. A departure or a taxiing aircraft routed onto that stub
 * meets it head-on or queues behind it with no way out ("I can't do anything"): AI Ground does not route onto a reserved stub (`ai/world.opposingTraffic`),
 * and the engine's taxi movement stops an aircraft short of one whatever the route (`groundMovement.stepGround`).
 */
import type { Aircraft, SimulationState } from './types';
import { findRunwayEnd, alongCross } from './runways';
import { predictedExit } from './flightDynamics';
import { arrivalParkingTargets, holdToParking, stubNodes } from './exitChoice';
import { findOpenRequest } from './coordination';
import { mToNm } from './geo';

/** An aircraft this close (m) to a stub's hold line is at the head of that stub. DESIGN VALUE. */
const STUB_HEAD_M = 25;

/** A lander this close to its threshold (nm) reserves the exit stub it will use. */
export const LANDER_STUB_NM = 2;

export interface LanderStub {
  aircraftId: string;
  callsign: string;
  holdNodeId: string;
  /** The hold line and the taxiway nodes beyond it, in the order the lander drives over them. */
  nodeIds: string[];
}

const cache = new WeakMap<SimulationState, { timeSec: number; stubs: LanderStub[] }>();

/** Arrivals within `LANDER_STUB_NM` on final, or on the landing roll, and the stub of the exit each will take (an exit Ground arranged with Tower counts). */
export function landerStubs(state: SimulationState): LanderStub[] {
  // (recomputed once per simulated second: a lander's exit does not change faster than that, and the taxi movement asks every step)
  const sec = Math.floor(state.clock.timeSec);
  const hit = cache.get(state);
  if (hit && hit.timeSec === sec) return hit.stubs;
  const stubs: LanderStub[] = [];
  for (const ac of Object.values(state.aircraft)) {
    if (ac.isDeparture) continue;
    if (isExiting(ac)) {
      const last = ac.route!.nodeIds[ac.route!.nodeIds.length - 1];
      stubs.push({ aircraftId: ac.id, callsign: ac.callsign, holdNodeId: last, nodeIds: [last] });
      continue;
    }
    if (!isLanding(ac)) continue;
    const g = findRunwayEnd(state.airport, ac.assignedRunwayEnd);
    if (!g) continue;
    if (!ac.onGround && -mToNm(alongCross(g, ac.pos).along - g.displacedM) > LANDER_STUB_NM) continue;
    const asked = findOpenRequest(state, 'EXIT', ac.id);
    const instruction = asked && asked.status === 'approved' && (asked.point || asked.exitSide) ? { taxiway: asked.point, side: asked.exitSide } : undefined;
    const ex = predictedExit(state, ac, g, instruction);
    if (!ex) continue;
    const way = holdToParking(state, ex.holdNodeId, arrivalParkingTargets(state, ac));
    stubs.push({ aircraftId: ac.id, callsign: ac.callsign, holdNodeId: ex.holdNodeId, nodeIds: stubNodes(state, way.nodeIds) });
  }
  cache.set(state, { timeSec: sec, stubs });
  return stubs;
}

function isLanding(ac: Aircraft): boolean {
  if (ac.phase === 'ROLLOUT') return ac.onGround && ac.occupyingRunways.length > 0;
  return !ac.onGround && (ac.phase === 'FINAL' || ac.phase === 'LANDING');
}

/** A lander that has left the runway and is still rolling to the hold line of its exit (it stops there to wait for Ground). */
function isExiting(ac: Aircraft): boolean {
  return ac.onGround && ac.phase === 'RUNWAY_EXIT' && !!ac.route && ac.route.progressIndex < ac.route.nodeIds.length;
}

/** The first lander whose reserved stub shares a node with `nodeIds` (a taxi route), other than `exceptId`. */
export function landerStubOnRoute(state: SimulationState, nodeIds: readonly string[], exceptId: string): LanderStub | undefined {
  const stubs = landerStubs(state);
  if (!stubs.length) return undefined;
  const on = new Set(nodeIds);
  // An aircraft standing at the head of a stub (the lander that got there first) is not blocked by the next lander's reservation of the same stub: the
  // second one waits behind it, and the first would wait for the second for good (free-play soak seed 3: four landers queued on the Bravo stub).
  const me = state.aircraft[exceptId];
  const nodes = state.airport.taxiwayGraph.nodes;
  return stubs.find((s) => s.aircraftId !== exceptId && s.nodeIds.some((id) => on.has(id)) && !(me?.onGround && nodes[s.holdNodeId] && Math.hypot(me.pos.x - nodes[s.holdNodeId].pos.x, me.pos.y - nodes[s.holdNodeId].pos.y) < STUB_HEAD_M));
}
