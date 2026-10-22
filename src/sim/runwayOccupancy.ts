/**
 * Runway occupancy model. `computeRunwayActivity` is a PURE function of the state (used by the
 * per-tick update and by `assessClearanceSafety`); `updateRunwayOccupancy` writes the result to
 * state, emits entered/exited events and expires authorisations once an aircraft has cleared a runway.
 */
import type { Aircraft, Airport, RunwayOccupancy, SimulationState, TaxiNode } from './types';
import { dist, pointInPolygon } from './geo';
import { findRunwayEnd } from './runways';
import { activeClearance, emitEvent, getRuntime } from './context';
import type { SimContext } from './context';

export interface RunwayActivity {
  runwayId: string;
  occupants: string[];
  departing: string[];
  landing: string[];
  lineUp: string[];
  crossing: string[];
  holdingShort: string[];
}

const HOLD_STOP_DIST_M = 20;

const holdCache = new WeakMap<Airport, TaxiNode[]>();
function holdNodes(airport: Airport): TaxiNode[] {
  let h = holdCache.get(airport);
  if (!h) {
    h = Object.values(airport.taxiwayGraph.nodes).filter((n) => n.kind === 'holding_position' && n.runwayId);
    holdCache.set(airport, h);
  }
  return h;
}

/** Runway id an aircraft is assigned to operate on (from its runway end), if any. */
export function assignedRunwayId(airport: Airport, ac: Aircraft): string | undefined {
  return findRunwayEnd(airport, ac.assignedRunwayEnd)?.runway.id;
}

function isParkedLike(ac: Aircraft): boolean {
  return ac.phase === 'PARKED' || ac.phase === 'ARRIVED';
}

export function computeRunwayActivity(state: SimulationState): Record<string, RunwayActivity> {
  const { airport } = state;
  const out: Record<string, RunwayActivity> = {};
  for (const rw of airport.runways) {
    out[rw.id] = { runwayId: rw.id, occupants: [], departing: [], landing: [], lineUp: [], crossing: [], holdingShort: [] };
  }
  const holds = holdNodes(airport);
  for (const ac of Object.values(state.aircraft)) {
    const agl = ac.altitudeFt - airport.elevationFt;
    const assigned = assignedRunwayId(airport, ac);
    for (const rw of airport.runways) {
      const a = out[rw.id];
      if ((ac.onGround || agl < 50) && pointInPolygon(ac.pos, rw.polygon)) a.occupants.push(ac.id);
    }
    if (assigned && out[assigned]) {
      const a = out[assigned];
      switch (ac.phase) {
        case 'CLEARED_FOR_TAKEOFF':
        case 'TAKEOFF_ROLL':
          a.departing.push(ac.id);
          break;
        case 'LINE_UP_AND_WAIT':
          a.lineUp.push(ac.id);
          break;
        case 'LANDING':
        case 'ROLLOUT':
          a.landing.push(ac.id);
          break;
        default:
          if (!ac.onGround && !ac.isDeparture && activeClearance(ac, 'LAND')) a.landing.push(ac.id);
      }
      if (ac.phase === 'INITIAL_CLIMB' && !ac.onGround && agl < 200 && pointInPolygon(ac.pos, airport.runways.find((r) => r.id === assigned)!.polygon)) {
        a.departing.push(ac.id);
      }
    }
    if (ac.onGround && !isParkedLike(ac)) {
      for (const rid of ac.runwayAuthorizations) {
        const a = out[rid];
        if (!a) continue;
        const operating = a.departing.includes(ac.id) || a.landing.includes(ac.id) || a.lineUp.includes(ac.id);
        if (!operating) a.crossing.push(ac.id);
      }
      if (ac.groundSpeedKt < 1) {
        for (const h of holds) {
          if (dist(h.pos, ac.pos) <= HOLD_STOP_DIST_M && h.runwayId && out[h.runwayId] && !ac.runwayAuthorizations.includes(h.runwayId)) {
            out[h.runwayId].holdingShort.push(ac.id);
            break;
          }
        }
      }
    }
  }
  return out;
}

function toOccupancy(a: RunwayActivity): RunwayOccupancy {
  return {
    runwayId: a.runwayId,
    occupants: a.occupants,
    departingId: a.departing[0],
    landingId: a.landing[0],
    lineUpId: a.lineUp[0],
    crossingIds: a.crossing,
    holdingShortIds: a.holdingShort,
  };
}

export function computeRunwayOccupancy(state: SimulationState): Record<string, RunwayOccupancy> {
  const act = computeRunwayActivity(state);
  const res: Record<string, RunwayOccupancy> = {};
  for (const id of Object.keys(act)) res[id] = toOccupancy(act[id]);
  return res;
}

export function updateRunwayOccupancy(ctx: SimContext): void {
  const { state } = ctx;
  const activity = computeRunwayActivity(state);
  const occ: Record<string, RunwayOccupancy> = {};
  for (const id of Object.keys(activity)) occ[id] = toOccupancy(activity[id]);
  state.runwayOccupancy = occ;

  for (const ac of Object.values(state.aircraft)) {
    const rt = getRuntime(ctx, ac);
    const now = Object.keys(activity).filter((rid) => activity[rid].occupants.includes(ac.id));
    const before = ac.occupyingRunways;
    for (const rid of now) {
      if (!before.includes(rid)) {
        emitEvent(ctx, {
          kind: 'RUNWAY_ENTERED', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
          text: `${ac.callsign} entered runway ${rid}`, data: { runwayId: rid },
        });
      }
      rt.enteredRunways.add(rid);
    }
    for (const rid of before) {
      if (!now.includes(rid)) {
        emitEvent(ctx, {
          kind: 'RUNWAY_EXITED', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
          text: `${ac.callsign} exited runway ${rid}`, data: { runwayId: rid },
        });
      }
    }
    // Authorisation is consumed once the aircraft has used and then left the runway surface.
    for (const rid of Array.from(rt.enteredRunways)) {
      if (!now.includes(rid)) {
        rt.enteredRunways.delete(rid);
        const idx = ac.runwayAuthorizations.indexOf(rid);
        if (idx >= 0) ac.runwayAuthorizations.splice(idx, 1);
      }
    }
    ac.occupyingRunways = now;
  }
}
