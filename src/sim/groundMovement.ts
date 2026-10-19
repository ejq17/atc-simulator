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
import { activeClearance, advancePhase, emitEvent, getRuntime, perfOf, pilotSay, setPhase } from './context';
import { spokenTaxiway } from '../radio/spoken';
import { closedTaxiwayHoldCall } from '../radio/readback';
import type { AircraftRuntime, SimContext } from './context';
import { findRunwayEnd } from './runways';
import { runwayCrossingsAlong } from './pathfinding';
import { taxiSpeedKtFor } from './rotorcraft';
import { landerStubs } from './exitStubs';
import { seeded01 } from './rng';
import { HEAD_ON_LINGER_SEC, findHeadOn, headOnMarginM } from './headOn';

export const TAXI_ACCEL_MPS2 = 1.0;
export const TAXI_DECEL_CAP_MPS2 = 1.2;
const TAXI_DECEL_PLAN_MPS2 = 0.9;
const ARRIVE_EPS = 0.02;
/**
 * A new route that starts at a runway hold line the aircraft has already passed (it stopped between the hold line and the runway, e.g. the second
 * arrival to use a runway exit whose hold line is taken by the first) counts as holding at that line: backing up to it would put it head-on with the
 * aircraft standing there, and neither could move (free-play soak, docs/PROGRESS.md "Free-play jam"). DESIGN VALUE: 40 m.
 */
export const HOLD_START_SNAP_M = 40;

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

/** The route's first node is a runway hold line that needs a clearance and the aircraft stands within `HOLD_START_SNAP_M` of it on the runway side. */
function pastStartHold(graph: TaxiwayGraph, ac: Aircraft, route: NonNullable<Aircraft['route']>, node: TaxiNode): boolean {
  if (route.progressIndex !== 0 || node.kind !== 'holding_position' || !route.stopAtNodeIds.includes(node.id) || nodeAuthorized(ac, node)) return false;
  const next = graph.nodes[route.nodeIds[1]];
  if (!next) return false;
  const d = dist(ac.pos, node.pos);
  return d <= HOLD_START_SNAP_M && dist(ac.pos, next.pos) < dist(node.pos, next.pos);
}

function nodeAuthorized(ac: Aircraft, node: TaxiNode): boolean {
  return !!node.runwayId && ac.runwayAuthorizations.includes(node.runwayId);
}

function isHardStopNode(ac: Aircraft, node: TaxiNode, isLast: boolean): boolean {
  if (isLast) return true;
  const route = ac.route!;
  // A hold-short the pilot did not read back (JO 7110.65 2-4-3): no authorisation lifts it, only a read-back one.
  if (route.unreadStopNodeIds?.includes(node.id)) return true;
  return route.stopAtNodeIds.includes(node.id) && !nodeAuthorized(ac, node);
}

/**
 * Cruise taxi speed of this aircraft (kt): the type's figure times a seeded factor in [taxiSpeedMinFactor, 1], so a queue of one type does not
 * move in lockstep. DESIGN VALUE (pilotBehaviour.ground); the type figures are inside the AC 150/5300-13B Chg 1 range for taxiways (13-30 kt).
 */
export function taxiSpeedFactor(ctx: SimContext, ac: Aircraft): number {
  const min = ctx.pilotBehaviour.ground.taxiSpeedMinFactor;
  return min + (1 - min) * seeded01(ac.seed, 'taxi-speed');
}

/** Corner speed for a turn of `angleDeg` between route legs: full speed up to 15 degrees, the type's turn speed from 90 degrees, linear in between. */
export function cornerSpeedMps(angleDeg: number, vFull: number, vTurn: number): number {
  const k = Math.max(0, Math.min(1, (Math.abs(angleDeg) - 15) / 75));
  return vFull - (vFull - vTurn) * k;
}

export function findLeader(ctx: SimContext, ac: Aircraft): { gap: number; minGap: number } | undefined {
  const h = headingToVec(ac.headingDeg);
  const perf = perfOf(ac);
  let best: { gap: number; minGap: number } | undefined;
  for (const o of Object.values(ctx.state.aircraft)) {
    if (o === ac || !o.onGround || o.phase === 'PARKED' || o.phase === 'ARRIVED') continue;
    // An aircraft waiting at its parking position (READY, or standing on a stand with no route) is not traffic on the taxiway: it
    // does not hold up an aircraft passing on the apron connector. Only aircraft on the graph edges count for spacing.
    if ((o.phase === 'READY' && !ctx.runtime?.get(o.id)?.pushedBack) || (!o.route && o.groundSpeedKt < 0.1 && ctx.state.airport.parking.some((p) => dist(p.pos, o.pos) < 8))) continue;
    const r = vSub(o.pos, ac.pos);
    // Aircraft standing at the same spot (arrivals that stopped on one runway exit point, one behind the other): neither is ahead of the other, so
    // each used to wait for the other for good. The one whose id sorts first goes first (deterministic).
    if (Math.hypot(r.x, r.y) < 1 && o.id > ac.id) continue;
    const along = vDot(r, h);
    let gap = along;
    const inCone = along > 0 && along <= 250 && Math.abs(vCross(h, r)) <= 12 && Math.abs(headingDiff(ac.headingDeg, o.headingDeg)) <= 70;
    if (!inCone) {
      // A STOPPED aircraft (hold-short queue, a lined-up leader) that sits on the route ahead blocks it whatever its nose points at: the
      // follower is still turning toward the hold, and the leader faces the runway, so the heading cone above does not see it.
      if (o.groundSpeedKt >= 1 || dist(o.pos, ac.pos) > 250) continue;
      const g = gapAlongRoute(ctx, ac, o.pos);
      if (g === undefined) continue;
      gap = g;
    }
    if (!best || gap < best.gap) {
      const minGap = 1.5 * Math.max(perf.lengthM * (ac.formation?.size ?? 1), perfOf(o).lengthM * (o.formation?.size ?? 1)) + 20;
      best = { gap, minGap };
    }
  }
  // An arrival inside 2 nm (or rolling out) is about to stop on its exit's hold line: until it is there, that spot counts as a stopped aircraft on the
  // route (exitStubs.ts), so a taxiing aircraft does not run into the exit stub ahead of the lander.
  if (ac.route) {
    for (const s of landerStubs(ctx.state)) {
      if (s.aircraftId === ac.id) continue;
      const lander = ctx.state.aircraft[s.aircraftId];
      const spot = ctx.state.airport.taxiwayGraph.nodes[s.holdNodeId]?.pos;
      if (!lander || !spot) continue;
      const g = gapAlongRoute(ctx, ac, spot);
      if (g === undefined) continue;
      if (!best || g < best.gap) best = { gap: g, minGap: 1.5 * Math.max(perf.lengthM * (ac.formation?.size ?? 1), perfOf(lander).lengthM) + 20 };
    }
  }
  return best;
}

/** Distance (m) along the aircraft's remaining route to the point nearest `p`, when `p` lies within 12 m of the route in the next 250 m. */
function gapAlongRoute(ctx: SimContext, ac: Aircraft, p: Vec2): number | undefined {
  const r = ac.route;
  if (!r) return undefined;
  const nodes = ctx.state.airport.taxiwayGraph.nodes;
  let from = ac.pos;
  let travelled = 0;
  for (let i = r.progressIndex; i < r.nodeIds.length && travelled <= 250; i++) {
    const to = nodes[r.nodeIds[i]]?.pos;
    if (!to) break;
    const seg = vSub(to, from);
    const len = Math.hypot(seg.x, seg.y);
    if (len > 1e-6) {
      const raw = vDot(vSub(p, from), seg) / (len * len);
      // A point behind the aircraft (before the start of the first segment) is not on the route ahead.
      if (travelled === 0 && raw < 0) {
        travelled += len;
        from = to;
        continue;
      }
      const t = Math.max(0, Math.min(1, raw));
      const q = { x: from.x + seg.x * t, y: from.y + seg.y * t };
      if (dist(p, q) <= 12) return travelled + len * t;
    }
    travelled += len;
    from = to;
  }
  return undefined;
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
  if (rt.closedHold?.nodeId === node.id && !rt.calls.has(`closedTwy:${node.id}`)) {
    // the taxiway ahead was closed after the taxi instruction: stopped, and the pilot asks for new instructions
    rt.calls.add(`closedTwy:${node.id}`);
    const twy = rt.closedHold.taxiway;
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} stopped short of closed taxiway ${twy}`, severity: 'warning', speaker: 'SYSTEM', data: { closedTaxiway: twy } });
    pilotSay(ctx, ac, closedTaxiwayHoldCall(ac, { airport: ctx.state.airport }, twy), { request: 'TAXI', closedTaxiway: twy });
    ac.pendingRequest = { kind: 'TAXI', text: `holding short of taxiway ${twy} (closed), request taxi instructions`, sinceSec: ctx.state.clock.timeSec };
    return;
  }
  if (node.kind !== 'holding_position' && ac.route) {
    // Hold short of a taxiway: report it (the taxiway held short of is the one the route is about to join, not the one it arrived on).
    const graph = ctx.state.airport.taxiwayGraph;
    const prevId = ac.route.nodeIds[ac.route.progressIndex - 2];
    const arrived = graph.edges.find((e) => (e.from === prevId && e.to === node.id) || (e.from === node.id && e.to === prevId))?.taxiway;
    const twy = node.taxiways.find((t) => t !== arrived) ?? node.taxiways[0];
    if (twy && !rt.calls.has(`holdTwy:${node.id}`)) {
      rt.calls.add(`holdTwy:${node.id}`);
      emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} holding short of taxiway ${twy}`, severity: 'info', speaker: 'SYSTEM' });
      pilotSay(ctx, ac, `${ac.spokenCallsign}, holding short of ${spokenTaxiway(twy)}.`);
    }
  }
}

export function updateGroundMovement(ctx: SimContext, dt: number): void {
  for (const ac of Object.values(ctx.state.aircraft)) {
    if (!ac.onGround) continue;
    if (ac.phase === 'TAKEOFF_ROLL' || ac.phase === 'ROLLOUT') continue;
    if (getRuntime(ctx, ac).aborting) continue; // rejected takeoff: flightDynamics.stepAbort brakes it to a stop
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
  if (ac.phase === 'PUSHBACK') {
    stepPushback(ctx, ac, rt, dt);
    return;
  }
  if (ac.phase === 'PARKED' || ac.phase === 'ARRIVED') {
    ac.groundSpeedKt = 0;
    ac.airspeedKt = 0;
    return;
  }

  let v = ktToMps(ac.groundSpeedKt);
  const route = ac.route;

  // "Make a one eighty" (turnAround.ts): brake to a stop, turn in place at the type's ground turn rate, then hold position for new instructions.
  if (rt.turnAround) {
    holdStill(ac, v, dt);
    if (ac.groundSpeedKt === 0) {
      turnToward(ac, rt.turnAround.headingDeg, perf.groundTurnRateDegPerSec, dt);
      if (Math.abs(headingDiff(ac.headingDeg, rt.turnAround.headingDeg)) < 0.5) {
        ac.headingDeg = rt.turnAround.headingDeg;
        rt.turnAround = undefined;
        emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} turned around, holding position`, severity: 'info', speaker: 'SYSTEM' });
        pilotSay(ctx, ac, `${ac.spokenCallsign}, one eighty complete, holding position.`);
        if (rt.headOnCalled !== undefined || rt.headOn?.lastCallSec !== undefined) {
          rt.headOnCalled = undefined;
          rt.headOn = undefined;
          ac.pendingRequest = { kind: 'TAXI', text: 'turned around, request taxi instructions', sinceSec: now, resume: true };
        }
      }
    }
    ac.trackDeg = ac.headingDeg;
    ac.verticalSpeedFpm = 0;
    return;
  }

  // Process an arrival at the node we are standing on (e.g. a new route starting at a hold line).
  if (route) {
    while (route.progressIndex < route.nodeIds.length) {
      const node = graph.nodes[route.nodeIds[route.progressIndex]];
      if (dist(ac.pos, node.pos) >= ARRIVE_EPS && !pastStartHold(graph, ac, route, node)) break;
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
    const blocked = !!route && ((route.stopAtNodeIds.includes(node.id) && !nodeAuthorized(ac, node)) || !!route.unreadStopNodeIds?.includes(node.id));
    const routeDone = !route || route.progressIndex >= route.nodeIds.length;
    if (blocked || routeDone) {
      holdStill(ac, v, dt);
      return;
    }
    rt.stoppedAtNodeId = undefined;
  }

  const hasPath = !!ac.route && ac.route.progressIndex < ac.route.nodeIds.length;
  const sf = taxiSpeedFactor(ctx, ac);
  // A helicopter in a hover / air taxi moves at that mode's speed (JO 7110.65 3-11-1), a wheeled ground taxi at the type's taxi speed.
  let vmax = ktToMps((lineUpMode ? perf.taxiTurnSpeedKt : taxiSpeedKtFor(ac, rt) ?? perf.taxiSpeedKt) * sf);
  // Taxilanes and apron connectors: "not more than 15 mph (13 kts)" (AC 150/5300-13B Chg 1, Appendix 1 glossary "Taxilane").
  if (ac.route && ac.route.progressIndex < ac.route.nodeIds.length) {
    const r0 = ac.route;
    const apronNode = (id: string | undefined) => { const k = id ? graph.nodes[id]?.kind : undefined; return k === 'parking' || k === 'apron'; };
    if (rt.heli?.taxiMode !== 'air' && (apronNode(r0.nodeIds[r0.progressIndex]) || apronNode(r0.nodeIds[r0.progressIndex - 1]))) vmax = Math.min(vmax, ktToMps(ctx.pilotBehaviour.ground.taxilaneMaxKt));
  }
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
    const vt = ktToMps(perf.taxiTurnSpeedKt * sf);
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
        const turnDeg = Math.abs(headingDiff(dirIn, dirOut));
        if (turnDeg > 15) {
          const vc = Math.min(vmax, cornerSpeedMps(turnDeg, vmax, Math.min(vt, vmax)));
          vTarget = Math.min(vTarget, Math.sqrt(vc * vc + 2 * TAXI_DECEL_PLAN_MPS2 * cum));
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

  // Head-on traffic on a shared lane (headOn.ts): hold short of the stretch for the aircraft that has priority, or brake with the other to the margin.
  const ho = findHeadOn(ctx, ac);
  if (ho) {
    if (ho.role === 'wait') {
      vTarget = Math.min(vTarget, Math.sqrt(2 * TAXI_DECEL_PLAN_MPS2 * ho.stopDistM));
      if (ho.stopDistM <= 0) vTarget = 0;
    } else {
      const half = (ho.gapM - ho.marginM) / 2;
      vTarget = Math.min(vTarget, Math.sqrt(2 * TAXI_DECEL_PLAN_MPS2 * Math.max(0, half)));
      if (half <= 0) vTarget = 0;
      if (!rt.headOn || rt.headOn.otherId !== ho.other.id) rt.headOn = { otherId: ho.other.id, taxiway: ho.taxiway, sinceSec: now, laneNodeIds: ho.laneNodeIds };
      rt.headOn.lastSeenSec = now;
    }
  }
  if (rt.headOn && !(ho && ho.role === 'meet')) rt.headOnLinger ??= { otherId: rt.headOn.otherId, untilSec: now + HEAD_ON_LINGER_SEC };
  if (rt.headOn && now - (rt.headOn.lastSeenSec ?? rt.headOn.sinceSec) > 2) {
    // the conflict is gone; a pilot who had called for instructions asks for new ones once he stands clear (traffic.ts)
    rt.headOnCalled = now; // whichever aircraft was moved aside asks for new instructions when it stands still at the end of its short route (traffic.ts)
    if (ac.pendingRequest?.headOnWith) ac.pendingRequest = undefined; // the way is clear: the request is moot
    rt.headOn = undefined;
  }
  // After a head-on the aircraft that was not moved aside waits until the other has left the lane: it does not drive up to a counterpart that is only
  // just moving off (headOn.ts, HEAD_ON_LINGER_SEC); the counterpart itself moves away, it is not ahead of it.
  if (rt.headOnLinger) {
    const o = ctx.state.aircraft[rt.headOnLinger.otherId];
    if (!o || now >= rt.headOnLinger.untilSec) rt.headOnLinger = undefined;
    else {
      const r = vSub(o.pos, ac.pos);
      const d = Math.hypot(r.x, r.y);
      const margin = headOnMarginM(ac, o);
      if (d < 2 * margin && vDot(headingToVec(ac.headingDeg), r) > 0.17 * d) {
        const avail = d - margin;
        vTarget = Math.min(vTarget, Math.sqrt(2 * TAXI_DECEL_PLAN_MPS2 * Math.max(0, avail)));
        if (avail <= 0) vTarget = 0;
      } else if (d >= 2 * margin) rt.headOnLinger = undefined;
    }
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

/** Acceleration / deceleration of the tug, m/s^2. DESIGN VALUE (a tug brings the aircraft to its push speed in a few seconds). */
const PUSH_ACCEL_MPS2 = 0.4;

/** Another aircraft standing or moving in the way of the tail (the push point and the lane behind it). */
function pushBlocked(ctx: SimContext, ac: Aircraft, ahead: Vec2, pushTo: Vec2): boolean {
  const la = perfOf(ac).lengthM;
  for (const o of Object.values(ctx.state.aircraft)) {
    if (o === ac || !o.onGround || o.phase === 'ARRIVED' || o.phase === 'PARKED') continue;
    if (!o.route && o.groundSpeedKt < 0.1 && ctx.state.airport.parking.some((p) => dist(p.pos, o.pos) < 8)) continue; // standing on its own stand
    const need = (la + perfOf(o).lengthM) / 2 + 8;
    // The tail swings through half a length either side of the push direction.
    if (dist(o.pos, ahead) < need || dist(o.pos, pushTo) < need) return true;
  }
  return false;
}

/**
 * Pushback: the aircraft is moved backwards (heading unchanged, track opposite) along the stand lead-in to the push point at the tug speed
 * (`pilotBehaviour.ground.pushbackSpeedMps`), swinging its nose onto the lane over the last part of the push, then stands for
 * `pushSettleSec` (brakes set, tug disconnected). The aircraft is a normal ground target for the spacing logic throughout.
 */
function stepPushback(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, dt: number): void {
  const pb = rt.pushback;
  const gb = ctx.pilotBehaviour.ground;
  if (!pb) { ac.groundSpeedKt = 0; ac.airspeedKt = 0; return; }
  const now = ctx.state.clock.timeSec;
  const dir = headingToVec(normHeading(Math.atan2(pb.to.x - pb.from.x, pb.to.y - pb.from.y) * 180 / Math.PI));
  if (now < pb.startSec) { ac.groundSpeedKt = 0; ac.airspeedKt = 0; return; }
  const L = Math.max(1e-6, pb.lengthM);
  const along = Math.min(L, Math.max(0, vDot(vSub(ac.pos, pb.from), dir)));
  const remaining = L - along;
  const startHeading = rt.pushStartHeadingDeg ?? (rt.pushStartHeadingDeg = ac.headingDeg);
  const delta = headingDiff(startHeading, pb.finalHeadingDeg);
  let v = ktToMps(ac.groundSpeedKt);
  if (remaining > 1e-3) {
    const ahead = { x: ac.pos.x + dir.x * Math.min(remaining, 15 + perfOf(ac).lengthM / 2), y: ac.pos.y + dir.y * Math.min(remaining, 15 + perfOf(ac).lengthM / 2) };
    const blocked = now >= (pb.startSec) && pushBlocked(ctx, ac, ahead, pb.to);
    const vTarget = blocked ? 0 : Math.min(gb.pushbackSpeedMps, Math.sqrt(2 * PUSH_ACCEL_MPS2 * remaining) + 0.05);
    v = vTarget > v ? Math.min(vTarget, v + PUSH_ACCEL_MPS2 * dt) : Math.max(vTarget, v - PUSH_ACCEL_MPS2 * dt);
    const step = Math.min(v * dt, remaining);
    ac.pos = { x: ac.pos.x + dir.x * step, y: ac.pos.y + dir.y * step };
  } else {
    v = 0;
    ac.pos = { x: pb.to.x, y: pb.to.y };
  }
  // The nose swings over the last stretch of the push (and carries on after it stops if the lead-in was too short for the turn).
  const swingM = Math.min(L, (Math.abs(delta) / Math.max(0.1, gb.pushSwingRateDegPerSec)) * gb.pushbackSpeedMps);
  const progress = swingM <= 1e-6 ? 1 : Math.max(0, Math.min(1, (along - (L - swingM)) / swingM));
  const desired = normHeading(startHeading + delta * progress);
  const err = headingDiff(ac.headingDeg, desired);
  const maxStep = gb.pushSwingRateDegPerSec * dt;
  ac.headingDeg = normHeading(ac.headingDeg + Math.max(-maxStep, Math.min(maxStep, err)));
  ac.groundSpeedKt = mpsToKt(v);
  ac.airspeedKt = ac.groundSpeedKt;
  ac.trackDeg = v > 0.01 ? normHeading(Math.atan2(dir.x, dir.y) * 180 / Math.PI) : ac.headingDeg;
  ac.verticalSpeedFpm = 0;
  if (ac.groundSpeedKt < 0.05) { ac.groundSpeedKt = 0; ac.airspeedKt = 0; }
  if (remaining <= 1e-3 && Math.abs(headingDiff(ac.headingDeg, pb.finalHeadingDeg)) < 0.5 && pb.stoppedAtSec === undefined) {
    ac.headingDeg = pb.finalHeadingDeg;
    ac.trackDeg = ac.headingDeg;
    pb.stoppedAtSec = now;
    rt.pushedBack = true;
    rt.stoppedAtNodeId = undefined;
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} pushed back ${Math.round(L)} m to the lane, nose ${String(Math.round(pb.finalHeadingDeg)).padStart(3, '0')}`, severity: 'info', speaker: 'SYSTEM' });
  }
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
