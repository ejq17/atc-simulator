/**
 * Airport operating state: NOTAM-style runway / taxiway closures, pilot braking action reports, bird activity and runway edge light
 * intensity. Everything here is a pure function of `SimulationState` (plus a few engine hooks that emit events), so the ATIS, the
 * runway selector, taxi planning, the safety assessment and the renderers all ask the same questions.
 *
 * Sources (see docs/FAA-REFERENCES.md): JO 7110.65 3-3-1 / 3-3-2 (closed or unsafe runway), 2-9-3 (ATIS content: closures, bird
 * activity), 3-3-4 / 3-3-5 (braking action), 2-1-23 (bird activity), 3-4-10 / 3-4-11 (runway edge lights, HIRL step table),
 * AC 150/5370-2G 2.18.2.1.2 (temporarily closed runway: yellow X at each end).
 */
import type {
  Airport, AirportOps, BrakingReport, BrakingTerm, Closure, ClosureSource, ClosureSpec, SimulationState, Weather,
} from './types';
import { findRunway, findRunwayEnd } from './runways';
import { isDaylight, simUtcMs } from './solar';
import { emitEvent } from './context';
import type { SimContext } from './context';
import { routeSegmentTaxiways } from './pathfinding';
import { getRuntime } from './context';
import { RCAM_BRAKING_TERM, runwayCondition, termRank } from '../weather/runwayCondition';

export function newAirportOps(): AirportOps {
  return { closures: [], braking: [], lightStep: {}, closureSeq: 0 };
}

// ---------------------------------------------------------------------------
// Closures
// ---------------------------------------------------------------------------

export const isClosureActive = (c: Closure, nowSec: number): boolean => c.startSec <= nowSec + 1e-9 && (c.endSec === undefined || nowSec < c.endSec - 1e-9);

/** Closures in force at `nowSec` (default: the state's clock). */
export function activeClosures(state: Pick<SimulationState, 'ops' | 'clock'>, nowSec: number = state.clock?.timeSec ?? 0): Closure[] {
  return (state.ops?.closures ?? []).filter((c) => isClosureActive(c, nowSec));
}

/** Runway pair ids ("13/31") closed right now. */
export function closedRunwayIds(state: Pick<SimulationState, 'ops' | 'clock'>): Set<string> {
  return new Set(activeClosures(state).filter((c) => c.kind === 'RUNWAY').map((c) => c.ident));
}

/** Upper-case taxiway designators closed right now. */
export function closedTaxiways(state: Pick<SimulationState, 'ops' | 'clock'>): Set<string> {
  return new Set(activeClosures(state).filter((c) => c.kind === 'TAXIWAY').map((c) => c.ident.toUpperCase()));
}

/** `ref` may be a runway end ("13"), a pair ("13/31") or "RWY13". */
export function isRunwayClosed(state: Pick<SimulationState, 'ops' | 'clock' | 'airport'>, ref: string | undefined): boolean {
  if (!ref) return false;
  const rw = findRunway(state.airport, ref) ?? findRunwayEnd(state.airport, ref)?.runway;
  return !!rw && closedRunwayIds(state).has(rw.id);
}

/** Runway end ids that are on a closed runway (what the runway selector must not pick). */
export function closedRunwayEnds(state: Pick<SimulationState, 'ops' | 'clock' | 'airport'>): string[] {
  const closed = closedRunwayIds(state);
  return state.airport.runways.filter((r) => closed.has(r.id)).flatMap((r) => r.ends.map((e) => e.id));
}

/** Runway end ids on the closed runways named by closure specs (setup options): what the runway selector must not pick. */
export function closedEndsOf(airport: Airport, specs: readonly ClosureSpec[]): string[] {
  const ids = new Set(specs.filter((c) => c.kind === 'RUNWAY').map((c) => resolveClosureIdent(airport, 'RUNWAY', c.ident)).filter((x): x is string => !!x));
  return airport.runways.filter((r) => ids.has(r.id)).flatMap((r) => r.ends.map((e) => e.id));
}

/** Resolve a closure ident against the airport: runway pair id, or upper-case taxiway designator. Undefined = unknown. */
export function resolveClosureIdent(airport: Airport, kind: Closure['kind'], ident: string): string | undefined {
  if (kind === 'RUNWAY') {
    const rw = findRunway(airport, ident) ?? findRunwayEnd(airport, ident.replace(/^(RWY|RUNWAY)\s*/i, ''))?.runway;
    return rw?.id;
  }
  const up = ident.trim().toUpperCase().replace(/^(TWY|TAXIWAY)\s*/, '');
  const known = airport.taxiwayGraph.edges.some((e) => e.taxiway.toUpperCase() === up && !/^RWY/i.test(e.taxiway));
  return known ? up : undefined;
}

/** "Runway 13/31 closed" / "Taxiway B closed": the NOTAM keyword form used by the ATIS (2-9-3: "closures which impact airport operations"). */
export function closureText(c: Pick<Closure, 'kind' | 'ident'>): string {
  return c.kind === 'RUNWAY' ? `Runway ${c.ident} closed` : `Taxiway ${c.ident} closed`;
}

export type AddClosureResult = { ok: true; closure: Closure } | { ok: false; reason: string };

/**
 * Add a closure to the state. Refuses an unknown runway / taxiway and the closure of the last open runway (the simulator needs one
 * to run traffic). Does not emit events (see `announceClosureChanges`).
 */
export function addClosureToState(state: SimulationState, spec: ClosureSpec, source: ClosureSource): AddClosureResult {
  const ident = resolveClosureIdent(state.airport, spec.kind, spec.ident);
  if (!ident) return { ok: false, reason: `${spec.kind === 'RUNWAY' ? 'Runway' : 'Taxiway'} ${spec.ident} does not exist at ${state.airport.icao}.` };
  const startSec = spec.startSec ?? state.clock.timeSec;
  if (spec.kind === 'RUNWAY') {
    const stillOpen = state.airport.runways.filter((r) => r.id !== ident && !closedRunwayIds(state).has(r.id));
    if (!stillOpen.length) return { ok: false, reason: `Runway ${ident} is the last open runway at ${state.airport.icao}; it cannot be closed.` };
  }
  const closure: Closure = {
    id: `closure-${++state.ops.closureSeq}`,
    kind: spec.kind,
    ident,
    startSec,
    ...(spec.endSec !== undefined ? { endSec: spec.endSec } : {}),
    reason: spec.reason ?? (spec.kind === 'RUNWAY' ? 'runway closed (NOTAM)' : 'taxiway closed (NOTAM)'),
    source,
  };
  state.ops.closures.push(closure);
  return { ok: true, closure };
}

/**
 * True when no aircraft is on, on short final to, or cleared onto the runway: the "quiet time" an airport-operations inspection waits for.
 * `finalNm` is how far out an arrival counts.
 */
export function runwayIsQuiet(state: SimulationState, runwayId: string, finalNm = 8): boolean {
  const rw = state.airport.runways.find((r) => r.id === runwayId);
  if (!rw) return true;
  const ends = new Set(rw.ends.map((e) => e.id));
  for (const ac of Object.values(state.aircraft)) {
    if (ac.occupyingRunways.includes(rw.id)) return false;
    if (ac.assignedRunwayEnd && ends.has(ac.assignedRunwayEnd) && !ac.onGround) {
      const g = findRunwayEnd(state.airport, ac.assignedRunwayEnd);
      if (g) {
        const d = Math.hypot(ac.pos.x - g.end.threshold.x, ac.pos.y - g.end.threshold.y) / 1852;
        if (d < finalNm) return false;
      }
    }
    if (ac.onGround && ac.route && ac.assignedRunwayEnd && ends.has(ac.assignedRunwayEnd) && ac.phase !== 'PARKED') {
      // a departure taxiing to / holding at this runway
      if (ac.phase === 'HOLDING_SHORT' || ac.phase === 'LINE_UP_AND_WAIT' || ac.phase === 'CLEARED_FOR_TAKEOFF' || ac.phase === 'TAKEOFF_ROLL') return false;
    }
  }
  return true;
}

/** Log the start and the end of closures once each (engine tick). */
export function announceClosureChanges(ctx: SimContext): void {
  const now = ctx.state.clock.timeSec;
  for (const c of ctx.state.ops.closures) {
    const started = `${c.id}:start`;
    const ended = `${c.id}:end`;
    if (isClosureActive(c, now) && !ctx.opsAnnounced.has(started)) {
      ctx.opsAnnounced.add(started);
      emitEvent(ctx, { kind: 'SCENARIO', severity: 'warning', speaker: 'SYSTEM', text: `NOTAM: ${closureText(c)}${c.reason ? ` (${c.reason})` : ''}.`, data: { closure: c.id, closureKind: c.kind, ident: c.ident, opened: false } });
    } else if (c.endSec !== undefined && now >= c.endSec - 1e-9 && ctx.opsAnnounced.has(started) && !ctx.opsAnnounced.has(ended)) {
      ctx.opsAnnounced.add(ended);
      emitEvent(ctx, { kind: 'SCENARIO', severity: 'info', speaker: 'SYSTEM', text: `NOTAM cancelled: ${closureText(c)}; reopened.`, data: { closure: c.id, closureKind: c.kind, ident: c.ident, opened: true } });
    }
  }
}

/**
 * A taxiway closes under an aircraft that is already routed over it: the aircraft stops at the node short of the first closed segment of its
 * remaining route (the route stays; `stopAtNodeIds` holds it there) and the pilot asks for instructions (`groundMovement.onHoldReached`). An aircraft
 * already on the closed segment carries on (it cannot stop "short" of it) and only a later closed segment is considered. A route replaced by a taxi
 * instruction clears the hold (`commandExecutor.planTaxi`); that instruction is planned around the closure.
 */
export function enforceClosuresOnRoutes(ctx: SimContext): void {
  const closed = closedTaxiways(ctx.state);
  if (!closed.size) return;
  const graph = ctx.state.airport.taxiwayGraph;
  for (const ac of Object.values(ctx.state.aircraft)) {
    const route = ac.route;
    if (!ac.onGround || !route || route.progressIndex >= route.nodeIds.length) continue;
    const rt = getRuntime(ctx, ac);
    if (rt.closedHold && route.stopAtNodeIds.includes(rt.closedHold.nodeId)) continue;
    const seg = routeSegmentTaxiways(graph, route.nodeIds);
    for (let k = route.progressIndex + 1; k < route.nodeIds.length; k++) {
      const twy = seg[k];
      if (!twy || !closed.has(twy.toUpperCase())) continue;
      const stop = route.nodeIds[k - 1];
      if (!route.stopAtNodeIds.includes(stop)) route.stopAtNodeIds.push(stop);
      rt.closedHold = { nodeId: stop, taxiway: twy.toUpperCase() };
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Braking action
// ---------------------------------------------------------------------------

/** Newest braking report for a runway end (any end of the runway when `runwayEnd` is a pair id), within `maxAgeSec`. */
export function latestBrakingReport(state: Pick<SimulationState, 'ops' | 'clock' | 'airport'>, runwayEnd: string | undefined, maxAgeSec = 3600): BrakingReport | undefined {
  const rw = runwayEnd ? (findRunwayEnd(state.airport, runwayEnd)?.runway ?? findRunway(state.airport, runwayEnd)) : undefined;
  const ends = new Set(rw ? rw.ends.map((e) => e.id) : runwayEnd ? [runwayEnd] : []);
  const braking = state.ops?.braking ?? [];
  for (let i = braking.length - 1; i >= 0; i--) {
    const r = braking[i];
    if (state.clock.timeSec - r.atSec > maxAgeSec) break;
    if (!ends.size || ends.has(r.runwayEnd)) return r;
  }
  return undefined;
}

const SPOKEN_TYPE: Record<string, string> = {
  C172: 'a Cessna one seventy two', C182: 'a Cessna one eighty two', C152: 'a Cessna one fifty two', C208: 'a Cessna Caravan', PA28: 'a Piper Cherokee', SR22: 'a Cirrus S R twenty two',
  A319: 'an Airbus three nineteen', A320: 'an Airbus three twenty', A321: 'an Airbus three twenty one', BCS3: 'an Airbus A two twenty',
  B737: 'a Boeing seven thirty seven', B738: 'a Boeing seven thirty seven', B739: 'a Boeing seven thirty seven', B38M: 'a Boeing seven thirty seven', B752: 'a Boeing seven fifty seven',
  E175: 'an Embraer one seventy five', E170: 'an Embraer one seventy', E190: 'an Embraer one ninety', CRJ9: 'a C R J nine hundred', CRJ7: 'a C R J seven hundred', CRJ2: 'a C R J two hundred',
  A20N: 'an Airbus three twenty', A21N: 'an Airbus three twenty one', B762: 'a heavy Boeing seven sixty seven', B763: 'a heavy Boeing seven sixty seven',
  A306: 'a heavy Airbus three hundred', MD11: 'a heavy M D eleven', B772: 'a heavy Boeing seven seventy seven', B77W: 'a heavy Boeing seven seventy seven',
  B788: 'a heavy Boeing seven eighty seven', B789: 'a heavy Boeing seven eighty seven', A332: 'a heavy Airbus three thirty', A333: 'a heavy Airbus three thirty',
  A339: 'a heavy Airbus three thirty', A359: 'a heavy Airbus three fifty', A35K: 'a heavy Airbus three fifty', A388: 'a super Airbus three eighty',
  B744: 'a heavy Boeing seven forty seven', B748: 'a heavy Boeing seven forty seven', DH8D: 'a Dash eight', BE20: 'a King Air', BE9L: 'a King Air', PC12: 'a Pilatus',
  C402: 'a Cessna four oh two', C56X: 'a Citation', CL35: 'a Challenger', GLF5: 'a Gulfstream', GLEX: 'a Global Express',
};

/** "a Boeing seven thirty seven": the aircraft description of a braking report (JO 7110.65 3-3-4: "Include type of aircraft from which the report is received"). */
export function spokenTypeForReport(type: string): string {
  return SPOKEN_TYPE[type.trim().toUpperCase()] ?? `a ${type.trim().toUpperCase().split('').join(' ')}`;
}

/**
 * The term a landing pilot reports: the RCAM row of the derived runway condition (`runwayCondition`), one step better or worse
 * with probability 1/4 each way (seeded, so the same session replays the same reports). Never reported on a dry runway.
 */
export function pilotBrakingTerm(weather: Pick<Weather, 'phenomena' | 'temperatureC'>, rng: () => number): BrakingTerm | undefined {
  const c = runwayCondition(weather);
  if (c.code >= 6) return undefined;
  const r = rng();
  const code = Math.max(0, Math.min(5, c.code + (r < 0.25 ? 1 : r > 0.75 ? -1 : 0)));
  return RCAM_BRAKING_TERM[code];
}

/** The ATIS statement for the latest report: "Braking action medium, reported by a Boeing seven thirty seven" (3-3-4 EXAMPLE). */
export function brakingStatement(r: BrakingReport): string {
  return `Braking action ${r.term}, reported by ${r.aircraftSpoken}`;
}

/** A report is "worse than the one in the ATIS" (2-9-2: new recording when braking action is reported worse than in the current broadcast). */
export function brakingWorse(a: BrakingTerm, than: BrakingTerm | undefined): boolean {
  return than === undefined ? true : termRank(a) < termRank(than);
}

// ---------------------------------------------------------------------------
// Runway edge lights (JO 7110.65 3-4-10, 3-4-11)
// ---------------------------------------------------------------------------

export const MAX_LIGHT_STEP = 5;

/** True between sunset and sunrise at the airport (NOAA solar position, `solar.ts`). */
export function isNight(state: SimulationState): boolean {
  return !isDaylight(state.airport.arp, simUtcMs(state));
}

/** 3-4-10: lights on between sunset and sunrise, and by day when the surface visibility is less than 2 miles. */
export function runwayLightsOn(state: SimulationState): boolean {
  return isNight(state) || state.weather.visibilitySm < 2;
}

/**
 * Default HIRL step from JO 7110.65 TBL 3-4-8 (both airports' runways are high intensity, NASR RWY_LGT_CODE HIGH):
 *   day:   < 1 SM = 5, 1 to < 2 = 4, 2 to < 3 = 3, otherwise lights off (3-4-10: on by day only below 2 SM, steps 1-2 "when requested");
 *   night: > 5 SM = 1, 3 to 5 = 2, 1 to < 3 = 3, < 1 = 4 (5 only when requested).
 * 0 = lights off. (The table's "and/or appropriate RVR equivalent" is not applied.)
 */
export function defaultLightStep(visibilitySm: number, night: boolean): number {
  if (night) return visibilitySm > 5 ? 1 : visibilitySm >= 3 ? 2 : visibilitySm >= 1 ? 3 : 4;
  if (visibilitySm < 1) return 5;
  if (visibilitySm < 2) return 4;
  return 0;
}

/** Step in force for a runway: a pilot-requested override, else the table default. 0 = off. */
export function effectiveLightStep(state: SimulationState, runwayId: string): number {
  const o = state.ops?.lightStep?.[runwayId];
  if (o !== undefined) return runwayLightsOn(state) ? o : 0;
  return defaultLightStep(state.weather.visibilitySm, isNight(state));
}

/** Runway id the lights request applies to: the landing / departing runway in use that is not closed. */
export function lightsRunwayId(state: SimulationState): string | undefined {
  const ends = [...state.activeRunways.landing, ...state.activeRunways.departing];
  for (const e of ends) {
    const rw = findRunwayEnd(state.airport, e)?.runway;
    if (rw) return rw.id;
  }
  return undefined;
}
