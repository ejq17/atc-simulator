/**
 * Continuous taxi motion along a GroundRoute.
 *
 * - Speed changes only through bounded acceleration/braking (no teleporting).
 * - Speed is capped by a braking profile v = sqrt(2*a*d) to the next hard stop (hold position, end of
 *   route, aircraft ahead) and by a corner-speed profile before sharp turns.
 * - An aircraft never enters a runway surface node whose runway it has not been authorised to use:
 *   stop nodes come from the route (`stopAtNodeIds`) and a last-line safety net checks runway nodes.
 */
import type { Aircraft, TaxiNode, TaxiwayGraph, Vec2 } from './types';
import { dist, headingDiff, headingToVec, ktToMps, mpsToKt, normHeading, vCross, vDot, vSub, vecToHeading } from './geo';
import { activeClearance, advancePhase, emitEvent, getRuntime, perfOf, setPhase } from './context';
import type { AircraftRuntime, SimContext } from './context';
import { findRunwayEnd } from './runways';
import { runwayCrossingsAlong } from './pathfinding';

export const TAXI_ACCEL_MPS2 = 1.0;
export const TAXI_DECEL_CAP_MPS2 = 1.2;
const TAXI_DECEL_PLAN_MPS2 = 0.9;
const ARRIVE_EPS = 0.02;

/**
 * Hold-position nodes along a path that need an explicit clearance: those from which the route goes
 * ON to the runway surface (crossing / entering), unless that runway is already authorised.
 * A hold node the aircraft is merely leaving the runway through (or the route end) is handled elsewhere.
 */
export function computeStopNodes(graph: TaxiwayGraph, nodeIds: string[], authorizedRunways: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < nodeIds.length; i++) {
    const n = graph.nodes[nodeIds[i]];
    if (!n || n.kind !== 'holding_position' || !n.runwayId || authorizedRunways.includes(n.runwayId)) continue;
    const next = graph.nodes[nodeIds[i + 1]];
    const entersRunway =
      (next && next.kind === 'runway' && next.runwayId === n.runwayId) || runwayCrossingsAlong(graph, nodeIds.slice(i, i + 2)).includes(n.runwayId);
    if (entersRunway || i === nodeIds.length - 1) out.push(n.id);
  }
  return out;
}

function nodeAuthorized(ac: Aircraft, node: TaxiNode): boolean {
  return !!node.runwayId && ac.runwayAuthorizations.includes(node.runwayId);
}

function isHardStopNode(ac: Aircraft, node: TaxiNode, isLast: boolean): boolean {
  if (isLast) return true;
  const route = ac.route!;
  return route.stopAtNodeIds.includes(node.id) && !nodeAuthorized(ac, node);
}

function findLeader(ctx: SimContext, ac: Aircraft): { gap: number; minGap: number } | undefined {
  const h = headingToVec(ac.headingDeg);
  const perf = perfOf(ac);
  let best: { gap: number; minGap: number } | undefined;
  for (const o of Object.values(ctx.state.aircraft)) {
    if (o === ac || !o.onGround || o.phase === 'PARKED' || o.phase === 'ARRIVED') continue;
    const r = vSub(o.pos, ac.pos);
    const along = vDot(r, h);
    if (along <= 0 || along > 250) continue;
    if (Math.abs(vCross(h, r)) > 12) continue;
    if (Math.abs(headingDiff(ac.headingDeg, o.headingDeg)) > 70) continue;
    if (!best || along < best.gap) {
      const minGap = 1.5 * Math.max(perf.lengthM, perfOf(o).lengthM) + 20;
      best = { gap: along, minGap };
    }
  }
  return best;
}

function routeNodePos(ctx: SimContext, id: string): Vec2 {
  return ctx.state.airport.taxiwayGraph.nodes[id].pos;
}

function turnToward(ac: Aircraft, desired: number, rateDegPerSec: number, dt: number): void {
  const err = headingDiff(ac.headingDeg, desired);
  const max = rateDegPerSec * dt;
  ac.headingDeg = normHeading(ac.headingDeg + Math.max(-max, Math.min(max, err)));
}

function onRouteComplete(ctx: SimContext, ac: Aircraft, node: TaxiNode): void {
  const rt = getRuntime(ctx, ac);
  const taxi = activeClearance(ac, 'TAXI') ?? activeClearance(ac, 'TAXI_TO_PARKING');
  if (node.kind === 'parking') {
    ac.route = undefined;
    ac.groundSpeedKt = 0;
    ac.airspeedKt = 0;
    if (taxi) taxi.completedAtSec = ctx.state.clock.timeSec;
    if (ac.phase === 'TAXI_TO_PARKING') {
      setPhase(ctx, ac, 'ARRIVED', 'parked');
      emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} parked at ${node.name ?? node.id}`, severity: 'info', speaker: 'SYSTEM' });
    } else if (ac.phase === 'TAXIING') {
      setPhase(ctx, ac, 'PARKED', 'returned to parking');
    }
    return;
  }
  if (node.kind === 'holding_position' && node.runwayId) {
    rt.stoppedAtNodeId = node.id;
    if (ac.phase === 'TAXIING') setPhase(ctx, ac, 'HOLDING_SHORT', node.id);
  }
}

/** Stop-and-hold bookkeeping when the aircraft reaches an unauthorised hold node mid-route. */
function onHoldReached(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, node: TaxiNode): void {
  rt.stoppedAtNodeId = node.id;
  if (ac.phase === 'TAXIING' && node.kind === 'holding_position') setPhase(ctx, ac, 'HOLDING_SHORT', node.id);
}

export function updateGroundMovement(ctx: SimContext, dt: number): void {
  for (const ac of Object.values(ctx.state.aircraft)) {
    if (!ac.onGround) continue;
    if (ac.phase === 'TAKEOFF_ROLL' || ac.phase === 'ROLLOUT') continue;
    stepGround(ctx, ac, dt);
  }
}

function stepGround(ctx: SimContext, ac: Aircraft, dt: number): void {
  const graph = ctx.state.airport.taxiwayGraph;
  const rt = getRuntime(ctx, ac);
  const perf = perfOf(ac);
  const now = ctx.state.clock.timeSec;
  const lineUpMode = !!rt.lineUp && !rt.lineUp.aligned;

  // Takeoff roll starts once lined up, aligned and cleared (after a short pilot reaction time).
  if (rt.lineUp?.aligned && rt.takeoffCleared && ac.phase === 'CLEARED_FOR_TAKEOFF' && now >= (rt.rollAtSec ?? 0)) {
    setPhase(ctx, ac, 'TAKEOFF_ROLL');
    return;
  }
  if (ac.phase === 'PARKED' || ac.phase === 'ARRIVED') {
    ac.groundSpeedKt = 0;
    ac.airspeedKt = 0;
    return;
  }

  let v = ktToMps(ac.groundSpeedKt);
  const route = ac.route;

  // Process an arrival at the node we are standing on (e.g. a new route starting at a hold line).
  if (route) {
    while (route.progressIndex < route.nodeIds.length) {
      const node = graph.nodes[route.nodeIds[route.progressIndex]];
      if (dist(ac.pos, node.pos) >= ARRIVE_EPS) break;
      const isLast = route.progressIndex === route.nodeIds.length - 1;
      route.progressIndex++;
      if (isLast) {
        v = 0;
        onRouteComplete(ctx, ac, node);
        break;
      }
      if (isHardStopNode(ac, node, false)) {
        v = 0;
        onHoldReached(ctx, ac, rt, node);
        break;
      }
    }
  }

  // Remain stopped while the hold instruction stands.
  if (rt.stoppedAtNodeId) {
    const node = graph.nodes[rt.stoppedAtNodeId];
    const blocked = !!route && route.stopAtNodeIds.includes(node.id) && !nodeAuthorized(ac, node);
    const routeDone = !route || route.progressIndex >= route.nodeIds.length;
    if (blocked || routeDone) {
      holdStill(ac, v, dt);
      return;
    }
    rt.stoppedAtNodeId = undefined;
  }

  const hasPath = !!ac.route && ac.route.progressIndex < ac.route.nodeIds.length;
  const vmax = ktToMps(lineUpMode ? perf.taxiTurnSpeedKt : perf.taxiSpeedKt);
  let vTarget = ac.flags.holdingPosition ? 0 : vmax;
  let stopDist = Infinity;
  const pts: Vec2[] = [ac.pos];
  if (hasPath) {
    const r = ac.route!;
    for (let i = r.progressIndex; i < r.nodeIds.length; i++) pts.push(routeNodePos(ctx, r.nodeIds[i]));
  }
  if (!hasPath) {
    vTarget = 0;
  } else {
    const r = ac.route!;
    const vt = ktToMps(perf.taxiTurnSpeedKt);
    let cum = 0;
    for (let j = 1; j < pts.length; j++) {
      const segLen = dist(pts[j - 1], pts[j]);
      const prevCum = cum;
      cum += segLen;
      const nodeIdx = r.progressIndex + j - 1;
      const node = graph.nodes[r.nodeIds[nodeIdx]];
      const isLast = nodeIdx === r.nodeIds.length - 1;
      // Safety net: never enter a runway surface node without authorisation.
      if (node.kind === 'runway' && node.runwayId && !nodeAuthorized(ac, node) && !(isLast && lineUpMode)) {
        vTarget = Math.min(vTarget, Math.sqrt(2 * TAXI_DECEL_PLAN_MPS2 * Math.max(0, prevCum)));
        stopDist = Math.min(stopDist, prevCum);
        break;
      }
      if (isHardStopNode(ac, node, isLast)) {
        vTarget = Math.min(vTarget, Math.sqrt(2 * TAXI_DECEL_PLAN_MPS2 * cum));
        stopDist = Math.min(stopDist, cum);
        break;
      }
      if (cum < 200 && j + 1 < pts.length) {
        const dirIn = segLen > 0.5 ? vecToHeading(vSub(pts[j], pts[j - 1])) : ac.headingDeg;
        const dirOut = vecToHeading(vSub(pts[j + 1], pts[j]));
        if (Math.abs(headingDiff(dirIn, dirOut)) > 25) {
          vTarget = Math.min(vTarget, Math.sqrt(vt * vt + 2 * TAXI_DECEL_PLAN_MPS2 * cum));
        }
      }
    }
  }

  // Aircraft ahead.
  const leader = findLeader(ctx, ac);
  if (leader) {
    const avail = leader.gap - leader.minGap;
    vTarget = Math.min(vTarget, Math.sqrt(2 * TAXI_DECEL_PLAN_MPS2 * Math.max(0, avail)));
    if (avail <= 0) vTarget = 0;
  }

  // Desired heading: look ahead along the route so the nose swings smoothly into corners.
  let desiredHeading = ac.headingDeg;
  if (hasPath) {
    const lookAhead = Math.max(4, v * 1.5);
    let remain = lookAhead;
    let target = pts[pts.length - 1];
    for (let j = 1; j < pts.length; j++) {
      const l = dist(pts[j - 1], pts[j]);
      if (l >= remain) {
        const t = l > 0 ? remain / l : 0;
        target = { x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * t, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * t };
        break;
      }
      remain -= l;
    }
    if (dist(target, ac.pos) > 0.3) desiredHeading = vecToHeading(vSub(target, ac.pos));
    // Do not drive off sideways: pivot first if the nose points well away from the path.
    if (Math.abs(headingDiff(ac.headingDeg, desiredHeading)) > 45) vTarget = Math.min(vTarget, 1.5);
  }

  // Speed update (bounded acceleration / braking).
  if (vTarget > v) v = Math.min(vTarget, v + TAXI_ACCEL_MPS2 * dt);
  else v = Math.max(vTarget, v - TAXI_DECEL_CAP_MPS2 * dt);

  // Move along the polyline.
  let remaining = Math.min(v * dt, stopDist);
  const moved = remaining;
  if (hasPath) {
    const r = ac.route!;
    while (remaining > 1e-9 && r.progressIndex < r.nodeIds.length) {
      const node = graph.nodes[r.nodeIds[r.progressIndex]];
      const d = dist(ac.pos, node.pos);
      if (d <= remaining + 1e-9) {
        ac.pos = { x: node.pos.x, y: node.pos.y };
        remaining -= d;
        const isLast = r.progressIndex === r.nodeIds.length - 1;
        r.progressIndex++;
        if (isLast) {
          v = 0;
          onRouteComplete(ctx, ac, node);
          break;
        }
        if (isHardStopNode(ac, node, false)) {
          v = 0;
          onHoldReached(ctx, ac, rt, node);
          break;
        }
      } else {
        const k = remaining / d;
        ac.pos = { x: ac.pos.x + (node.pos.x - ac.pos.x) * k, y: ac.pos.y + (node.pos.y - ac.pos.y) * k };
        remaining = 0;
      }
    }
  }
  if (stopDist < Infinity && moved >= stopDist - 1e-9 && stopDist < v * dt + 1e-9) {
    // reached a safety-net stop that is not a node (stop short of a runway node)
    v = 0;
  }

  // Line-up: after reaching the runway centreline, rotate onto the runway heading.
  if (lineUpMode && rt.lineUp) {
    const routeDone = !ac.route || ac.route.progressIndex >= ac.route.nodeIds.length;
    if (routeDone) {
      const g = findRunwayEnd(ctx.state.airport, rt.lineUp.runwayEnd);
      if (g) {
        v = 0;
        turnToward(ac, g.headingDeg, perf.groundTurnRateDegPerSec, dt);
        if (Math.abs(headingDiff(ac.headingDeg, g.headingDeg)) < 0.5) {
          ac.headingDeg = g.headingDeg;
          rt.lineUp.aligned = true;
          ac.route = undefined;
          if (ac.phase === 'LINE_UP_AND_WAIT') {
            emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} lined up runway ${g.end.id}`, severity: 'info', speaker: 'SYSTEM' });
          }
        }
      }
    }
  } else {
    turnToward(ac, desiredHeading, perf.groundTurnRateDegPerSec, dt);
  }

  ac.groundSpeedKt = mpsToKt(v);
  ac.airspeedKt = ac.groundSpeedKt;
  ac.trackDeg = ac.headingDeg;
  ac.verticalSpeedFpm = 0;
  if (ac.groundSpeedKt < 0.05) ac.groundSpeedKt = 0;
  if (ac.groundSpeedKt === 0) ac.airspeedKt = 0;
}

function holdStill(ac: Aircraft, v: number, dt: number): void {
  const nv = Math.max(0, v - TAXI_DECEL_CAP_MPS2 * dt);
  ac.groundSpeedKt = mpsToKt(nv);
  ac.airspeedKt = ac.groundSpeedKt;
  if (ac.groundSpeedKt < 0.05) {
    ac.groundSpeedKt = 0;
    ac.airspeedKt = 0;
  }
}

/** Convenience used by the executor/tests: put an aircraft in TAXIING from PARKED/READY (via the machine). */
export function startTaxiing(ctx: SimContext, ac: Aircraft): boolean {
  return advancePhase(ctx, ac, 'TAXIING');
}
