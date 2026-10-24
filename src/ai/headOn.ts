/**
 * AI Ground's answer to "nose to nose with <callsign> on <taxiway>, request instructions" (engine side: sim/headOn.ts).
 *
 * Deterministic, in this order:
 *  1. Pull aside: the junction on the shared lane between the two aircraft, with a branch off the lane (a taxiway, a stand connector or an apron
 *     lane), nearest to either aircraft. The aircraft nearer to it (the caller on a tie) is taxied onto the branch to let the other pass, and asks for
 *     taxi instructions once it stands clear (it is then routed again from where it is).
 *  2. Turn around ("make a one eighty", turnAround.ts) a departure (else the aircraft that called), where the rule allows it (a light aircraft on any taxiway, a larger one
 *     within 60 m of an apron); else the other one if that is allowed; it then asks for new instructions.
 *  3. Neither: nothing can be done from the ground (the engine has no way to back an aircraft up); AI Ground keeps the pair stopped and the situation
 *     stays visible as the pilot's repeated call.
 * Both distances (150 m to the junction, 80 m of branch) are DESIGN VALUES; JO 7110.65 3-7-2 gives no procedure for this.
 */
import type { Aircraft, SimulationState, TaxiNode, Vec2 } from '../sim/types';
import type { SimContext } from '../sim/context';
import { findHeadOnIn, headOnMarginM, pathOf } from '../sim/headOn';
import { turnAroundCheck } from '../sim/turnAround';
import { perfOf } from '../sim/context';

/** A branch off the lane farther than this from the aircraft that would take it is not considered (m). */
export const PULL_ASIDE_MAX_M = 150;
/** Clearance (m) between the wing tips of the two aircraft when one passes the junction the other pulled onto. DESIGN VALUE. */
export const PULL_ASIDE_CLEAR_M = 6;
/** The end of the branch is at least this far (m) from either aircraft's route: a parked aircraft there is off the lane. DESIGN VALUE (the engine's lane width is 12 m, a wing and a margin on top). */
export const PULL_ASIDE_LANE_CLEAR_M = 25;
/** The aircraft is taxied this far (m) along the branch, so its tail is clear of the lane. */
export const PULL_ASIDE_BRANCH_M = 80;

export type HeadOnResolution =
  | { kind: 'pull'; mover: Aircraft; other: Aircraft; junctionId: string; endNodeId: string; taxiway: string; toStand?: string }
  | { kind: 'turn'; mover: Aircraft; other: Aircraft };

interface Branch { endNodeId: string; taxiway: string; toStand?: string }

/** The branches off `lane` at `junction`, each walked up to `PULL_ASIDE_BRANCH_M` (stopping at the next junction or at a stand). */
function branchesFrom(state: SimulationState, junction: TaxiNode, lane: ReadonlySet<string>, away: readonly Vec2[], clearOfLane: (p: Vec2) => boolean): Branch[] {
  const g = state.airport.taxiwayGraph;
  const out: Branch[] = [];
  // the branch must lead AWAY from both aircraft: no node of it nearer to either than the junction is (or than 30 m)
  const usable = (n: TaxiNode | undefined): n is TaxiNode =>
    !!n && n.kind !== 'runway' && n.kind !== 'holding_position' && n.kind !== 'parking' && away.every((p) => Math.hypot(n.pos.x - p.x, n.pos.y - p.y) >= Math.max(30, Math.hypot(junction.pos.x - p.x, junction.pos.y - p.y)));
  const adj = (id: string) => g.edges.filter((e) => e.from === id || e.to === id).map((e) => ({ to: e.from === id ? e.to : e.from, taxiway: e.taxiway, len: e.lengthM }));
  for (const first of adj(junction.id)) {
    const n0 = g.nodes[first.to];
    if (!usable(n0) || lane.has(n0.id)) continue;
    let end: TaxiNode = n0;
    let total = first.len;
    let prev = junction.id;
    while (total < PULL_ASIDE_BRANCH_M) {
      const next = adj(end.id).filter((x) => x.to !== prev && !lane.has(x.to) && usable(g.nodes[x.to]));
      if (next.length !== 1) break; // a junction or a dead end
      prev = end.id;
      total += next[0].len;
      end = g.nodes[next[0].to];
    }
    if (!clearOfLane(end.pos)) continue;
    // (a stand itself is never the end: a departure that parks there would be out of the flow; the connector in front of it is)
    const stand = state.airport.parking.some((p) => adj(p.nodeId).some((x) => x.to === end.id)) ? state.airport.parking.find((p) => adj(p.nodeId).some((x) => x.to === end.id)) : undefined;
    out.push({ endNodeId: end.id, taxiway: first.taxiway, ...(stand ? { toStand: stand.name } : {}) });
  }
  return out;
}

/** Decide how to resolve the head-on `caller` reported. `onFrequency`: ids of the aircraft this controller can instruct. */
export function resolveHeadOn(state: SimulationState, caller: Aircraft, other: Aircraft, onFrequency: ReadonlySet<string>): HeadOnResolution | undefined {
  const ho = findHeadOnIn(state, caller);
  const graph = state.airport.taxiwayGraph;
  const ctx = { state } as SimContext;
  // A pair that stands face to face with no shared lane in the route data (two aircraft at the hold lines on either side of a runway crossing, each waiting for the other's
  // lane; the engine's own `traffic.ts` 1e0 turns that into a nose-to-nose call): only the turn applies. Soak, KPGD seed 1: the call was repeated for the rest of the run and kept
  // Ground off its own frequency.
  if ((!ho || ho.role !== 'meet' || ho.other.id !== other.id) && !facingEachOther(caller, other)) return undefined; // not nose to nose any more
  if (ho && ho.role === 'meet' && ho.other.id === other.id) {
    const cp = pathOf(graph, caller);
    const op = pathOf(graph, other);
    if (cp && op) {
      const lane = new Set(ho.laneNodeIds);
      const away = [caller.pos, other.pos];
      // an aircraft standing at the end of the branch must not stand on the lane (the engine treats a stopped aircraft within 12 m of a route as a leader)
      const routes = [cp.ids, op.ids].map((ids) => ids.map((id) => graph.nodes[id].pos));
      const clear = (p: Vec2): boolean => routes.every((pts) => pts.every((q, i) => i === 0 || distToSegment(p, pts[i - 1], q) >= PULL_ASIDE_LANE_CLEAR_M));
      let best: { mover: Aircraft; d: number; junction: TaxiNode } | undefined;
      for (const id of ho.laneNodeIds) {
        const node = graph.nodes[id];
        const ci = cp.ids.indexOf(id);
        const oi = op.ids.indexOf(id);
        if (!node || ci < 0 || oi < 0) continue;
        if (cp.cum[ci] < -5 || op.cum[oi] < -5) continue; // behind one of them
        if (!branchesFrom(state, node, lane, away, clear).length) continue;
        for (const [mover, d] of [[caller, cp.cum[ci]], [other, op.cum[oi]]] as const) {
          if (!onFrequency.has(mover.id) || d > PULL_ASIDE_MAX_M) continue;
          // the junction is clear of the aircraft that stays: wing tips apart (half the two lengths plus a clearance)
          const stays = mover === caller ? other : caller;
          if (Math.hypot(node.pos.x - stays.pos.x, node.pos.y - stays.pos.y) < (perfOf(mover).lengthM + perfOf(stays).lengthM) / 2 + PULL_ASIDE_CLEAR_M) continue;
          if (!best || d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && mover === caller && best.mover !== caller)) best = { mover, d, junction: node };
        }
      }
      if (best) {
        const b = branchesFrom(state, best.junction, lane, away, clear).sort((x, y) => (x.toStand ? 0 : 1) - (y.toStand ? 0 : 1) || x.endNodeId.localeCompare(y.endNodeId))[0];
        return { kind: 'pull', mover: best.mover, other: best.mover === caller ? other : caller, junctionId: best.junction.id, endNodeId: b.endNodeId, taxiway: b.taxiway, toStand: b.toStand };
      }
    }
  }
  // A departure is turned around rather than an arrival: it goes back to its stand end of the lane and is routed to another hold (a departure bound for the
  // hold at the end of an exit stub and an arrival coming off it cannot both be satisfied), while the arrival goes on to its stand. Same kind: the caller first.
  const order: (readonly [Aircraft, Aircraft])[] = caller.isDeparture !== other.isDeparture && other.isDeparture ? [[other, caller], [caller, other]] : [[caller, other], [other, caller]];
  for (const [mover, o] of order) {
    if (onFrequency.has(mover.id) && turnAroundCheck(ctx, mover).ok) return { kind: 'turn', mover, other: o };
  }
  return undefined;
}

/** Both stopped on the ground, nose to nose within 2.5 head-on margins (the test `traffic.ts` 1e0 applies before it makes the stand-off a head-on request). */
function facingEachOther(a: Aircraft, b: Aircraft): boolean {
  if (!a.onGround || !b.onGround || a.groundSpeedKt >= 0.5 || b.groundSpeedKt >= 0.5) return false;
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const d = Math.hypot(dx, dy);
  const h = (a.headingDeg * Math.PI) / 180;
  return d < 2.5 * headOnMarginM(a, b) && Math.abs(((b.headingDeg - a.headingDeg + 540) % 360) - 180) > 100 && Math.sin(h) * dx + Math.cos(h) * dy > 0.5 * d;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
