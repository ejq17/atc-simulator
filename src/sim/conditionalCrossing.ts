/**
 * Conditional runway crossing: "N12345, cross runway 13 at Bravo behind the landing Cessna". An ICAO Doc 4444 conditional clearance, not JO 7110.65
 * phraseology (the command is always flagged non-standard by the parser). The pilot reads it back and keeps holding short; `updateConditionalCrossings`
 * (called every tick from engine.ts, before ground movement) releases it, and until then the crossing is NOT an authorisation: the runway is not in
 * `runwayAuthorizations` and the hold node stays in `route.stopAtNodeIds`, so a premature move is a runway incursion like any other.
 */
import type { Aircraft, Runway } from './types';
import { emitEvent, getRuntime, setPhase } from './context';
import type { SimContext } from './context';
import { findRunwayEnd, alongCross } from './runways';

/**
 * The named aircraft's reference point must be this far (m) beyond the crossing point before the hold is released.
 * Not a published figure: a simulator margin so that the crossing aircraft does not start while the lander's tail is still at the crossing (hold line
 * ~50-60 m from the runway centreline, wingspan and length of the landers in the sim up to ~40 m).
 */
export const CROSS_BEHIND_MARGIN_M = 100;

export interface ConditionalCross {
  clearanceId: string;
  /** Aircraft id and callsign of the traffic to let pass. */
  behindId: string;
  behindCallsign: string;
  runwayId: string;
  /** Runway as the controller named it, for the log ("13"). */
  runwayLabel: string;
  holdNodeId: string;
  /** Route node at the runway centreline the crossing aircraft goes over (the point the named aircraft must pass). */
  crossNodeId: string;
  /** The hold node was not in `stopAtNodeIds` (a crossing at a runway intersection node); added so that the aircraft stops, and removed on release. */
  addedStop?: boolean;
  /** The named aircraft has been on the runway since the clearance (so that "no longer on the runway" means it has left it). */
  sawOnRunway?: boolean;
}

/** Is `lander` arriving to, or rolling out on, runway `rw`: airborne on FINAL / LANDING for one of its ends, or on the ground in LANDING / ROLLOUT on it. */
export function landingOnRunway(ctx: SimContext, lander: Aircraft, rw: Runway): boolean {
  const g = findRunwayEnd(ctx.state.airport, lander.assignedRunwayEnd);
  if (!g || g.runway.id !== rw.id) return false;
  if (lander.onGround) return (lander.phase === 'LANDING' || lander.phase === 'ROLLOUT') && lander.occupyingRunways.includes(rw.id);
  return lander.phase === 'FINAL' || lander.phase === 'LANDING';
}

/** The hold is lifted exactly as a plain crossing clearance lifts it (commandExecutor planCross). */
export function releaseCrossing(ctx: SimContext, ac: Aircraft, runwayId: string): void {
  const graph = ctx.state.airport.taxiwayGraph;
  if (!ac.runwayAuthorizations.includes(runwayId)) ac.runwayAuthorizations.push(runwayId);
  if (ac.route) ac.route.stopAtNodeIds = ac.route.stopAtNodeIds.filter((id) => graph.nodes[id]?.runwayId !== runwayId);
  ac.flags.holdingPosition = false;
  if (ac.phase === 'HOLDING_SHORT') setPhase(ctx, ac, 'TAXIING', `crossing runway ${runwayId}`);
}

function cancel(ctx: SimContext, ac: Aircraft, text: string, askAgain: boolean): void {
  const rt = getRuntime(ctx, ac);
  const cc = rt.conditionalCross;
  if (!cc) return;
  rt.conditionalCross = undefined;
  // the pilot, still holding short, asks again (the "holding short of runway" call is made once per hold node)
  if (askAgain) rt.calls.delete(`holdX:${cc.holdNodeId}`);
  emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text, severity: 'warning', speaker: 'SYSTEM', data: { conditionalCrossing: 'cancelled', behind: cc.behindCallsign } });
}

/** Release, keep or cancel every pending conditional crossing. */
export function updateConditionalCrossings(ctx: SimContext): void {
  const { state } = ctx;
  const graph = state.airport.taxiwayGraph;
  for (const ac of Object.values(state.aircraft)) {
    const rt = ctx.runtime.get(ac.id);
    if (rt?.crossedBehind && !ac.runwayAuthorizations.includes(rt.crossedBehind.runwayId) && !ac.occupyingRunways.includes(rt.crossedBehind.runwayId)) rt.crossedBehind = undefined;
    const cc = rt?.conditionalCross;
    if (!rt || !cc) continue;
    const clr = ac.clearances.find((c) => c.id === cc.clearanceId);
    // Superseded: a later instruction took the aircraft off this crossing (hold position, a new route that no longer reaches the hold).
    if (!clr || clr.completedAtSec !== undefined || !ac.route || !ac.route.nodeIds.includes(cc.holdNodeId) || ac.flags.holdingPosition) {
      rt.conditionalCross = undefined;
      continue;
    }
    const behind = state.aircraft[cc.behindId];
    if (!behind) {
      cancel(ctx, ac, `${ac.callsign}: conditional crossing of runway ${cc.runwayLabel} cancelled, ${cc.behindCallsign} is no longer in the airspace; the controller must clear the crossing again`, true);
      continue;
    }
    if (behind.phase === 'GO_AROUND') {
      cancel(ctx, ac, `${ac.callsign} stays holding short of runway ${cc.runwayLabel}: ${behind.callsign} went around, so the crossing behind it is not released; the controller must clear the crossing again`, true);
      continue;
    }
    const g = findRunwayEnd(state.airport, behind.assignedRunwayEnd);
    const onRunway = behind.occupyingRunways.includes(cc.runwayId);
    if (onRunway && behind.onGround) cc.sawOnRunway = true;
    const crossNode = graph.nodes[cc.crossNodeId];
    let passed = false;
    if (behind.onGround && g && g.runway.id === cc.runwayId && crossNode) {
      passed = alongCross(g, behind.pos).along > alongCross(g, crossNode.pos).along + CROSS_BEHIND_MARGIN_M;
    }
    const vacated = !!cc.sawOnRunway && !onRunway;
    if (!passed && !vacated) {
      // an airborne aircraft that is no longer arriving to this runway (e.g. sent around into the pattern) will not pass the crossing point
      if (!behind.onGround && behind.phase !== 'FINAL' && behind.phase !== 'LANDING' && behind.phase !== 'APPROACH') {
        cancel(ctx, ac, `${ac.callsign} stays holding short of runway ${cc.runwayLabel}: ${behind.callsign} is no longer landing on it; the controller must clear the crossing again`, true);
      }
      continue;
    }
    rt.conditionalCross = undefined;
    rt.crossedBehind = { behindId: cc.behindId, runwayId: cc.runwayId, crossNodeId: cc.crossNodeId };
    if (cc.addedStop && ac.route) ac.route.stopAtNodeIds = ac.route.stopAtNodeIds.filter((id) => id !== cc.holdNodeId);
    releaseCrossing(ctx, ac, cc.runwayId);
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} crossing runway ${cc.runwayLabel} behind ${behind.callsign}`, severity: 'info', speaker: 'SYSTEM', data: { conditionalCrossing: 'released', behind: behind.callsign, runwayId: cc.runwayId } });
  }
}

/**
 * Two aircraft on the runway surface that are NOT a conflict: `crosser` was released to cross behind `lander`, and `lander` is still beyond the
 * crossing point (rolling away from it, or slowing down) while `crosser` goes over it.
 */
export function crossesBehind(ctx: SimContext, crosser: Aircraft, lander: Aircraft): boolean {
  const cb = ctx.runtime.get(crosser.id)?.crossedBehind;
  if (!cb || cb.behindId !== lander.id || !lander.onGround) return false;
  const g = findRunwayEnd(ctx.state.airport, lander.assignedRunwayEnd);
  const node = ctx.state.airport.taxiwayGraph.nodes[cb.crossNodeId];
  return !!g && !!node && g.runway.id === cb.runwayId && alongCross(g, lander.pos).along > alongCross(g, node.pos).along;
}
