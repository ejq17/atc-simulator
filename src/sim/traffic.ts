/**
 * Spawning, automatic pilot-initiated calls, aircraft lifecycle and the pluggable
 * `TrafficGenerator` interface (continuous traffic scheduling can be expanded by src/game).
 */
import type { Aircraft, BrakingReport, FlightPlan, Scenario, SimulationState, Vec2 } from './types';
import { brakingWorse, effectiveLightStep, latestBrakingReport, lightsRunwayId, pilotBrakingTerm, runwayLightsOn, spokenTypeForReport } from './airportOps';
import {
  bearingDeg, dist, headingDiff, headingToVec, mToNm, nmToM, vDot, vScale, vSub,
} from './geo';
import { glideAltitudeFt, finalStartNm } from './flightDynamics';
import { findRunwayEnd, alongCross } from './runways';
import { holdTooShort } from './holdSelection';
import { activeClearance, emitEvent, getRuntime, groundBehaviour, newRuntime, perfOf, pilotSay, setPhase } from './context';
import { pushbackStand } from './pushback';
import type { SimContext } from './context';
import { mulberry32, rngInt, rngPick, seeded01 } from './rng';
import { LUAW_LIMIT_SEC } from './towerCommands';
import { DEFAULT_PILOT_BEHAVIOUR, pilotUnfamiliar } from './pilotBehaviour';
import { aircraftPosition, frequencyById, frequencyForPosition, sameFrequency } from '../radio/frequencies';
import { findNavFix, fixPosition } from './navigation';
import { findStar } from './star';
import { assignSquawk } from './ifr';
import { pilotInitiatedRequest } from './pilotRequests';
import { jitteredInterval } from './radioDiscipline';
import { flyMisread } from './commandExecutor';
import { spokenCallsign as buildSpokenCallsign, spokenRunway } from '../radio/spoken';
import {
  approachCheckInCall, arrivalTowerCheckInCall, brakingActionCall, lightsRequestCall, checkInCall, clearOfRunwayCall, departureCheckInCall, establishedCall, finalCall, goAroundEstablishedCall,
  holdingShortCall, approachingHoldCall, holdingShortCrossingCall, ifrClearanceRequestCall, inboundCall, missedApproachCheckInCall, readyToTaxiCall, stoppedOnRunwayCall,
  holdShortQueryCall, nextSegmentCall, pushbackRequestCall, noseToNoseCall, clearOfCall,
  luawIntentionsCall, positionReportCall, requestNumbersCall, trafficAcquiredCall,
} from '../radio/readback';
import type { ReadbackEnv } from '../radio/readback';
import { headOnMarginM, mustGiveWay } from './headOn';
import { isVehicle, initVehicle, vehiclePilotCalls } from './vehicles';
import { heliPilotCalls, isRotorcraft } from './rotorcraft';
import { initSpecial, specialPilotCalls, trainingClearCall } from './special';

/** A pilot reports braking action for a runway at most this often, unless the report is worse than the one on file. */
export const BRAKING_REPORT_INTERVAL_SEC = 600;

export type SpawnSpec = Scenario['spawns'][number];

/** Continuous traffic scheduling hook. Returns spawn specs that are due NOW; the engine spawns them. */
export interface TrafficGenerator {
  update(state: Readonly<SimulationState>): SpawnSpec[];
}

export function createNullTrafficGenerator(): TrafficGenerator {
  return { update: () => [] };
}

const JET_ORIGINS = ['KPHL', 'KJFK', 'KBOS', 'KDCA', 'KORD', 'KATL', 'KBWI', 'KEWR'];
const GA_ORIGINS = ['KMIV', 'KVAY', 'KWWD', 'KILG', 'KTTN'];
const AIRLINE_CODES = ['NKS', 'AAL', 'DAL', 'JBU', 'SWA', 'UAL'];

/**
 * Simple seeded generator driven by `scenario.traffic` (arrivals/departures per hour, GA fraction, max aircraft).
 */
export function createBasicTrafficGenerator(): TrafficGenerator {
  let rng: (() => number) | undefined;
  let arrivalCounter = 0;
  let nextArrival = Infinity;
  let nextDeparture = Infinity;
  let counter = 0;
  const gap = (perHour: number) => (perHour > 0 ? -Math.log(1 - rng!() * 0.999) * (3600 / perHour) : Infinity);
  return {
    update(state) {
      const t = state.scenario.traffic;
      if (!t || !t.enabled) return [];
      const now = state.clock.timeSec;
      if (!rng) {
        rng = mulberry32((state.seed ^ 0x9e3779b9) >>> 0);
        nextArrival = now + gap(t.arrivalsPerHour);
        nextDeparture = now + gap(t.departuresPerHour);
      }
      const out: SpawnSpec[] = [];
      let count = Object.keys(state.aircraft).length;
      const used = new Set(Object.values(state.aircraft).map((a) => a.callsign));
      const makeCallsign = (ga: boolean): string => {
        for (let tries = 0; tries < 50; tries++) {
          const cs = ga
            ? `N${rngInt(rng!, 100, 999)}${String.fromCharCode(65 + rngInt(rng!, 0, 25))}${String.fromCharCode(65 + rngInt(rng!, 0, 25))}`
            : `${rngPick(rng!, AIRLINE_CODES)}${rngInt(rng!, 100, 2999)}`;
          if (!used.has(cs)) {
            used.add(cs);
            return cs;
          }
        }
        return `N${++counter}ZZ`;
      };
      // several landing runways (a published configuration): arrivals alternate over them, deterministically (no random number)
      const landingEnds = state.activeRunways.landing.length ? state.activeRunways.landing : state.activeRunways.departing;
      const landing = landingEnds[arrivalCounter % Math.max(1, landingEnds.length)];
      const departing = state.activeRunways.departing[0] ?? landing;
      if (now >= nextArrival) {
        nextArrival = now + gap(t.arrivalsPerHour);
        if (count < t.maxAircraft && landing) {
          arrivalCounter++;
          const ga = rng() < t.gaFraction;
          const g = findRunwayEnd(state.airport, landing);
          if (g) {
            const dNm = 14;
            const pos = vSub(g.end.threshold, vScale(g.dir, nmToM(dNm)));
            out.push({
              atSec: now,
              callsign: makeCallsign(ga),
              type: ga ? 'C172' : 'A320',
              flightRules: ga ? 'VFR' : 'IFR',
              start: { kind: 'airborne', pos, altitudeFt: ga ? 3000 : 5000, headingDeg: g.headingDeg, speedKt: ga ? 100 : 210, runwayEnd: g.end.id, distanceNm: dNm },
              isDeparture: false,
              // Approach only when somebody works it (player or AI); otherwise the arrival would never be handed to Tower.
              initialFrequencyId: state.airport.frequencies.some((f) => f.id === 'APP') && state.scenario.controllerPositions.includes('APP') ? 'APP' : 'TWR',
              initialRequest: 'LANDING',
            });
            count++;
          }
        }
      }
      if (now >= nextDeparture) {
        nextDeparture = now + gap(t.departuresPerHour);
        if (count < t.maxAircraft && departing) {
          const occupied = new Set(Object.values(state.aircraft).filter((a) => a.onGround).map((a) => a.pos.x.toFixed(1) + ',' + a.pos.y.toFixed(1)));
          const free = state.airport.parking.filter((p) => !occupied.has(p.pos.x.toFixed(1) + ',' + p.pos.y.toFixed(1)));
          if (free.length) {
            const ga = rng() < t.gaFraction;
            const p = rngPick(rng, free);
            out.push({
              atSec: now,
              callsign: makeCallsign(ga),
              type: ga ? 'C172' : 'A320',
              flightRules: ga ? 'VFR' : 'IFR',
              start: { kind: 'parked', parkingId: p.id },
              isDeparture: true,
              initialFrequencyId: 'GND',
              initialRequest: 'TAXI',
            });
            count++;
          }
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

function resolveFrequency(ctx: SimContext, id: string | undefined): { mhz: number; id?: string } {
  const af = ctx.state.airport;
  const f = id ? frequencyById(af, id) : undefined;
  if (f) return { mhz: f.mhz, id: f.id };
  return { mhz: ctx.state.controllerFrequencyMhz };
}

/** A pilot stopped nose to nose waits this long (s) after standing still before calling, and calls again after `HEAD_ON_RECALL_SEC` if nobody answers. DESIGN VALUES. */
const HEAD_ON_CALL_AFTER_SEC = 4;
const HEAD_ON_RECALL_SEC = 90;
/**
 * Two taxiing aircraft that stand still facing each other (closer than `HEAD_ON_STUCK_MARGINS` head-on margins, headings more than 100 degrees apart) for this long (s) are nose to
 * nose even when the route test of headOn.ts no longer sees a shared lane (soak seed 12 moderate: a student on progressive taxi and two arrivals on lane L stood 53 minutes
 * with nobody holding a request: the follow-distance rule had stopped them, the head-on state had been cleared). The one that must give way calls (`mustGiveWay`) and
 * calls again every `HEAD_ON_RECALL_SEC`. DESIGN VALUES.
 */
const HEAD_ON_STUCK_SEC = 30;
const HEAD_ON_STUCK_MARGINS = 2.5;
/** An aircraft moved aside after a head-on asks for new instructions only within this many seconds of the conflict ending. DESIGN VALUE. */
const HEAD_ON_RESUME_WINDOW_SEC = 300;

export function spawnFromSpec(ctx: SimContext, spec: SpawnSpec): Aircraft {
  const { state, rng } = ctx;
  const airport = state.airport;
  const graph = airport.taxiwayGraph;
  const now = state.clock.timeSec;
  const callsign = spec.callsign.toUpperCase();
  const perf = perfOf({ type: spec.type } as Aircraft);
  const freq = resolveFrequency(ctx, spec.initialFrequencyId);
  const id = `ac-${++ctx.aircraftSeq}`;
  const origins = perf.category === 'light' ? GA_ORIGINS : JET_ORIGINS;
  const picked = rngPick(rng, origins); // always drawn so seeded runs stay identical
  const other = spec.remoteAirport ?? picked;
  const ac: Aircraft = {
    id,
    callsign,
    spokenCallsign: buildSpokenCallsign(callsign, spec.type),
    type: spec.type,
    flightRules: spec.flightRules,
    origin: spec.isDeparture ? airport.icao : other,
    destination: spec.isDeparture ? other : airport.icao,
    isDeparture: spec.isDeparture,
    pos: { x: 0, y: 0 },
    headingDeg: 0,
    trackDeg: 0,
    altitudeFt: airport.elevationFt,
    airspeedKt: 0,
    groundSpeedKt: 0,
    verticalSpeedFpm: 0,
    onGround: true,
    phase: 'PARKED',
    frequencyMhz: freq.mhz,
    frequencyId: freq.id,
    clearances: [],
    target: {},
    radioState: 'IDLE',
    occupyingRunways: [],
    runwayAuthorizations: [],
    spawnedAtSec: now,
    history: [],
    voiceId: `voice-${rngInt(rng, 1, 8)}`,
    flags: {},
    seed: Math.floor(rng() * 2147483647),
  };
  // A student pilot: forced by the spawn, else a seeded share of light VFR aircraft (pilot realism studentShare). Own seeded draw: the sim's generator is untouched.
  const student = spec.student ?? (spec.flightRules === 'VFR' && perf.category === 'light' && !perf.craft && !perf.military && seeded01(ac.seed, 'student') < ctx.pilotBehaviour.realism.studentShare);
  if (student) ac.student = true;
  if (!spec.isDeparture && spec.parkingCategory) ac.parkingIntent = spec.parkingCategory;
  if (ctx.pilotBehaviour.realism.level !== 'off') ac.flags.inContact = false;
  const rt = newRuntime(now + 2 + rng() * 4);
  ctx.runtime.set(id, rt);
  if (spec.flightPlan) {
    const fp: FlightPlan = { ...spec.flightPlan, route: [...spec.flightPlan.route] };
    ac.flightPlan = fp;
    ac.origin = fp.origin;
    ac.destination = fp.destination;
  }
  const s = spec.start;
  if (s.kind === 'parked') {
    const p = airport.parking.find((x) => x.id === s.parkingId);
    if (!p) throw new Error(`Unknown parking position ${s.parkingId}`);
    ac.pos = { x: p.pos.x, y: p.pos.y };
    const nb = Object.values(graph.nodes).find((n) => n.id !== p.nodeId && dist(n.pos, p.pos) < 400 && n.kind !== 'parking');
    ac.headingDeg = p.headingDeg ?? (nb ? bearingDeg(p.pos, nb.pos) : 0);
    ac.trackDeg = ac.headingDeg;
    ac.phase = 'PARKED';
    rt.homeParkingCategory = p.category;
    rt.needsPushback = ctx.pilotBehaviour.ground.airlinerPushback && !!pushbackStand(airport, ac);
    rt.firstCallAtSec = now + 3 + rng() * 5;
  } else if (s.kind === 'holding_short') {
    const node = graph.nodes[s.nodeId];
    if (!node) throw new Error(`Unknown node ${s.nodeId}`);
    const g = findRunwayEnd(airport, s.runwayEnd);
    ac.pos = { x: node.pos.x, y: node.pos.y };
    const rwNode = Object.values(graph.nodes).find((n) => n.kind === 'runway' && n.runwayId === node.runwayId && dist(n.pos, node.pos) < 200);
    ac.headingDeg = rwNode ? bearingDeg(node.pos, rwNode.pos) : (g?.headingDeg ?? 0);
    ac.trackDeg = ac.headingDeg;
    ac.phase = 'HOLDING_SHORT';
    ac.assignedRunwayEnd = g?.end.id ?? s.runwayEnd;
    ac.route = { nodeIds: [node.id], taxiways: node.taxiways.slice(0, 1), stopAtNodeIds: [node.id], progressIndex: 1 };
    rt.stoppedAtNodeId = node.id;
    rt.firstCallAtSec = now + 2 + rng() * 3;
  } else if (s.kind === 'at_fix') {
    // Arrival entering the area over a named fix, flying its route to the airport.
    const fixNav = findNavFix(airport, s.fix);
    if (!fixNav) throw new Error(`Unknown fix ${s.fix}`);
    const first = s.route[0] ? findNavFix(airport, s.route[0])?.id : undefined;
    const route = s.route.length ? (first === fixNav.id ? [...s.route] : [fixNav.id, ...s.route]) : [fixNav.id];
    const g = findRunwayEnd(airport, s.runwayEnd ?? state.activeRunways.landing[0]);
    const nextPos = route[1] ? fixPosition(airport, route[1]) : undefined;
    ac.onGround = false;
    ac.pos = { x: fixNav.pos.x, y: fixNav.pos.y };
    ac.headingDeg = nextPos ? bearingDeg(ac.pos, nextPos) : g ? bearingDeg(ac.pos, g.end.threshold) : 0;
    ac.altitudeFt = s.altitudeFt;
    ac.airspeedKt = s.speedKt;
    ac.groundSpeedKt = s.speedKt;
    ac.phase = 'INBOUND';
    ac.assignedRunwayEnd = g?.end.id;
    ac.target = { altitudeFt: s.altitudeFt };
    ac.nav = { fixes: route, index: nextPos ? 1 : route.length, mode: 'route' };
    for (let i = 0; i < ac.nav.index; i++) rt.passedFixes.add(route[i].toUpperCase()); // the spawn fix is already reached
    if (!ac.flightPlan) {
      ac.flightPlan = { flightRules: 'IFR', origin: ac.origin, destination: airport.icao, cruiseAltitudeFt: s.altitudeFt, route: [...route] };
    }
    ac.squawk = ac.flightPlan.squawk ?? assignSquawk(ctx);
    ac.radarIdentified = false;
    ac.trackDeg = ac.headingDeg;
    if (s.star) {
      // An arrival on a STAR (JO 7110.65 4-7-1): the lateral route is the procedure, the altitude restrictions apply after "descend via" (4-5-7).
      const ref = findStar(airport, s.star.procedureId);
      if (!ref) throw new Error(`Unknown STAR ${s.star.procedureId} at ${airport.icao}`);
      ac.star = { procedureId: ref.procedure.id, name: ref.star.spokenName, ...(s.star.transition ? { transition: s.star.transition } : {}), runwayEnd: g?.end.id ?? '', descendVia: false };
    }
    rt.approachCheckIn = true;
    rt.calls.add('inbound'); // the approach check-in replaces the standard inbound call
    rt.firstCallAtSec = now + 1 + rng() * 3;
  } else {
    const landingEnd = s.runwayEnd ?? state.activeRunways.landing[0];
    const g = findRunwayEnd(airport, landingEnd);
    ac.onGround = false;
    ac.pos = { x: s.pos.x, y: s.pos.y };
    ac.headingDeg = s.headingDeg;
    ac.altitudeFt = s.altitudeFt;
    ac.airspeedKt = s.speedKt;
    ac.groundSpeedKt = s.speedKt;
    if (spec.isDeparture) {
      ac.phase = 'DEPARTURE';
      ac.assignedRunwayEnd = g?.end.id;
      rt.navMode = 'HEADING';
      ac.target = { headingDeg: s.headingDeg, altitudeFt: s.altitudeFt };
    } else if (g) {
      ac.assignedRunwayEnd = g.end.id;
      if (s.distanceNm !== undefined) {
        ac.pos = vSub(g.end.threshold, vScale(g.dir, nmToM(s.distanceNm)));
        ac.headingDeg = g.headingDeg;
        if (ac.altitudeFt <= 0) ac.altitudeFt = glideAltitudeFt(g.elevationFt, nmToM(s.distanceNm));
      }
      const { along, cross } = alongCross(g, ac.pos);
      const d = -along;
      const aligned = Math.abs(cross) < 300 && Math.abs(headingDiff(ac.headingDeg, g.headingDeg)) < 30 && d > 0;
      if (aligned && d <= nmToM(finalStartNm(perf)) + 300) ac.phase = 'FINAL';
      else if (dist(ac.pos, g.end.threshold) < nmToM(25)) ac.phase = 'APPROACH';
      else ac.phase = 'INBOUND';
    } else {
      ac.phase = 'INBOUND';
      rt.navMode = 'HEADING';
    }
    ac.trackDeg = ac.headingDeg;
    rt.firstCallAtSec = now + 1 + rng() * 3;
  }
  if (spec.behavior) {
    const b = spec.behavior;
    if (b.kind === 'vehicle' && s.kind === 'parked') initVehicle(ctx, ac, rt, b, s.parkingId);
    else initSpecial(ctx, ac, rt, b);
  }
  ac.history = [{ x: ac.pos.x, y: ac.pos.y }];
  state.aircraft[id] = ac;
  emitEvent(ctx, {
    kind: 'SPAWN', aircraftId: id, callsign, severity: 'info', speaker: 'SYSTEM',
    text: `${callsign} (${spec.type}) spawned ${s.kind === 'parked' ? `at ${s.parkingId}` : s.kind === 'holding_short' ? `holding short at ${s.nodeId}` : s.kind === 'at_fix' ? `inbound over ${s.fix}` : 'airborne'}`,
    data: { phase: ac.phase },
  });
  return ac;
}

export function processScheduledSpawns(ctx: SimContext): void {
  const spawns = ctx.state.scenario.spawns;
  for (let i = 0; i < spawns.length; i++) {
    if (ctx.spawnedIdx.has(i)) continue;
    if (spawns[i].atSec <= ctx.state.clock.timeSec + 1e-9) {
      ctx.spawnedIdx.add(i);
      spawnFromSpec(ctx, spawns[i]);
    }
  }
}

export function removeAircraft(ctx: SimContext, id: string, handled = false, why = 'removed'): void {
  const ac = ctx.state.aircraft[id];
  if (!ac) return;
  const byPlayer = !!ctx.runtime.get(id)?.playerTouched;
  delete ctx.state.aircraft[id];
  ctx.runtime.delete(id);
  if (ctx.state.selectedAircraftId === id) ctx.state.selectedAircraftId = undefined;
  emitEvent(ctx, {
    kind: 'DESPAWN', aircraftId: id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
    text: `${ac.callsign} ${why}`, data: { handled, byPlayer },
  });
}

// ---------------------------------------------------------------------------
// Frequency changes
// ---------------------------------------------------------------------------

/** Within this distance of its departure hold an aircraft that checks in on Tower makes the departure call. */
export const HOLD_CHECKIN_RANGE_M = 400;

export function applyPendingFrequencyChanges(ctx: SimContext): void {
  const now = ctx.state.clock.timeSec;
  for (const ac of Object.values(ctx.state.aircraft)) {
    const rt = getRuntime(ctx, ac);
    // an aircraft that went to a wrong frequency finds its way back
    if (rt.returnFreq && now >= rt.returnFreq.atSec && !rt.pendingFreq) {
      const back = rt.returnFreq;
      rt.returnFreq = undefined;
      ac.frequencyMhz = back.mhz;
      ac.frequencyId = back.id;
      rt.checkInAtSec = now + 1 + ctx.rng() * 1.5;
      emitEvent(ctx, { kind: 'HANDOFF', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', frequencyMhz: back.mhz, text: `${ac.callsign} found the right frequency again (${back.mhz.toFixed(3)})`, data: { returnedFromWrongFrequency: true } });
    }
    if (!rt.pendingFreq || now < rt.pendingFreq.atSec) continue;
    // A frequency read back wrongly: the pilot waits for the controller's confirmation (until the error is corrected or has been scored as missed).
    if (rt.readbackError?.kind === 'CONTACT_FREQUENCY') continue;
    // exit instruction + "contact Ground": the frequency changes once the aircraft is clear of the runway (JO 7110.65 3-10-9)
    if (rt.pendingFreq.afterClear && (ac.phase === 'LANDING' || ac.phase === 'ROLLOUT' || ac.occupyingRunways.length > 0)) continue;
    const { mhz, id, silent } = rt.pendingFreq;
    rt.pendingFreq = undefined;
    ac.frequencyMhz = mhz;
    ac.frequencyId = id;
    if (ac.pendingRequest?.kind === 'FREQUENCY_CHANGE') ac.pendingRequest = undefined;
    rt.handedOff = true;
    if (!silent) rt.checkInAtSec = now + 1 + ctx.rng() * 1.5;
    emitEvent(ctx, mhz <= 0
      ? { kind: 'HANDOFF', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', text: `${ac.callsign} left the frequency (frequency change approved)`, data: { leftFrequency: true } }
      : {
        kind: 'HANDOFF', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', frequencyMhz: mhz,
        text: `${ac.callsign} changed to ${mhz.toFixed(3)}${id ? ` (${id})` : ''}`, data: { frequencyId: id },
      });
  }
}

// ---------------------------------------------------------------------------
// Automatic pilot requests
// ---------------------------------------------------------------------------

function readbackEnv(ctx: SimContext): ReadbackEnv {
  return { airport: ctx.state.airport };
}

/** Light VFR aircraft that did not report the ATIS code (40 %, seeded per aircraft): they need the numbers from the controller (JO 7110.65 3-9-1 / 3-10-1). */
export function pilotNeedsNumbers(ac: Aircraft, fraction = DEFAULT_PILOT_BEHAVIOUR.noAtisFraction): boolean {
  return ac.flightRules === 'VFR' && perfOf(ac).category === 'light' && seeded01(ac.seed, 'no-atis') < fraction;
}

/**
 * Calls the controller asked for or the vocabulary implies: traffic acquired, requested position reports, line up and wait longer than
 * 90 s (JO 7110.65 3-9-4 NOTE), request for wind and altimeter. Returns true when the aircraft spoke.
 */
function towerVocabularyCalls(ctx: SimContext, ac: Aircraft, rt: ReturnType<typeof getRuntime>, env: ReadbackEnv): boolean {
  const { state } = ctx;
  const airport = state.airport;
  const now = state.clock.timeSec;
  const g = findRunwayEnd(airport, ac.assignedRunwayEnd);

  // 1. Traffic the pilot was looking for (JO 7110.65 3-1-6, 7-2-1).
  if (rt.trafficLook && now >= rt.trafficLook.acquireAtSec) {
    const target = state.aircraft[rt.trafficLook.targetId];
    rt.trafficLook = undefined;
    const sighted = !!target && dist(ac.pos, target.pos) <= Math.min(state.weather.visibilitySm, ctx.pilotBehaviour.look.maxRangeSm) * 1609.344;
    if (sighted && target) rt.trafficSeen = [...new Set([...(rt.trafficSeen ?? []), target.id])];
    pilotSay(ctx, ac, trafficAcquiredCall(ac, env, sighted), { trafficLook: true });
    return true;
  }

  // 2. Requested position reports.
  if (!ac.onGround && g && rt.reports.length) {
    const { along: alongPave } = alongCross(g, ac.pos);
    const along = alongPave - g.displacedM; // from the landing threshold
    for (const r of rt.reports) {
      let fire = false;
      if (r.kind === 'MIDFIELD_DOWNWIND') fire = ac.phase === 'PATTERN' && rt.pattern?.leg === 'DOWNWIND' && alongPave <= g.lengthM / 2;
      else if (r.kind === 'BASE') fire = ac.phase === 'PATTERN' && rt.pattern?.leg === 'BASE';
      else fire = (ac.phase === 'FINAL' || ac.phase === 'LANDING') && mToNm(-along) <= (r.distanceNm ?? 3) + 0.15 && -along > 0;
      if (!fire) continue;
      rt.reports = rt.reports.filter((x) => x !== r);
      pilotSay(ctx, ac, positionReportCall(ac, env, r.kind, g.end.id, { side: rt.pattern?.side, distanceNm: r.distanceNm ?? Math.max(1, mToNm(-along)) }), { positionReport: r.kind });
      if (r.kind === 'FINAL') {
        rt.calls.add('final');
        if (!rt.landingEnd) ac.pendingRequest = { kind: 'LANDING', text: `${Math.max(1, Math.round(r.distanceNm ?? mToNm(-along)))} mile final, requesting landing clearance`, sinceSec: now };
      } else {
        ac.pendingRequest = { kind: 'PATTERN', text: r.kind === 'BASE' ? 'on base, requesting landing clearance' : 'midfield downwind, requesting landing clearance', sinceSec: now };
      }
      return true;
    }
  }

  // 3. Line up and wait for more than 90 seconds (3-9-4 NOTE): the pilot asks for intentions; the timer restarts after the call.
  if (ac.onGround && ac.phase === 'LINE_UP_AND_WAIT' && rt.lineUp?.aligned && ac.groundSpeedKt < 1 && !rt.takeoffCleared && !rt.aborting) {
    rt.luawSinceSec ??= now;
    if (now - rt.luawSinceSec >= (ctx.pilotBehaviour.realism.level === 'off' ? LUAW_LIMIT_SEC : jitteredInterval(ctx, ac, 'luaw', LUAW_LIMIT_SEC * 1.125, rt.callSeq, LUAW_LIMIT_SEC)) && g) {
      rt.luawSinceSec = now;
      pilotSay(ctx, ac, luawIntentionsCall(ac, env, g.end.id), { request: 'DEPARTURE', luawTimeout: true });
      ac.pendingRequest = { kind: 'DEPARTURE', text: `in position runway ${g.end.id} for more than 90 seconds, say intentions`, sinceSec: now };
      emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'warning', speaker: 'SYSTEM', text: `${ac.callsign} has been in position on runway ${g.end.id} for ${LUAW_LIMIT_SEC} s (JO 7110.65 3-9-4 NOTE: not more than 90 seconds without additional instructions)`, data: { luawTimeout: true } });
      return true;
    }
  } else if (rt.luawSinceSec !== undefined && ac.phase !== 'LINE_UP_AND_WAIT') {
    rt.luawSinceSec = undefined;
  }

  // 4. A pilot who did not report the ATIS code and was not given the numbers asks for wind and altimeter.
  if (!rt.haveNumbers && !rt.numbersRequested && ac.pendingRequest && now - ac.pendingRequest.sinceSec >= jitteredInterval(ctx, ac, 'numbers', ctx.pilotBehaviour.numbersRequestAfterSec)
    && (ac.pendingRequest.kind === 'DEPARTURE' || ac.pendingRequest.kind === 'LANDING')
    && aircraftPosition(airport, ac) === 'TWR' && pilotNeedsNumbers(ac, ctx.pilotBehaviour.noAtisFraction)) {
    rt.numbersRequested = true;
    rt.requestBeforeNumbers = ac.pendingRequest;
    pilotSay(ctx, ac, requestNumbersCall(ac, env), { request: 'OTHER', numbersRequest: true });
    ac.pendingRequest = { kind: 'OTHER', text: 'request wind and altimeter', sinceSec: now };
    return true;
  }
  return false;
}

/**
 * A practising light-aircraft pilot who made a full stop in the pattern asks Ground to taxi back for another departure (realism request
 * TAXI_BACK, seeded per aircraft). Returns the runway end, and makes the aircraft a departure again so that the taxi instruction to the runway is valid.
 */
function wantsTaxiBack(ctx: SimContext, ac: Aircraft, rt: ReturnType<typeof getRuntime>): string | undefined {
  const rate = ctx.pilotBehaviour.realism.requests.TAXI_BACK;
  if (rate <= 0 || rt.requestsDone.has('TAXI_BACK') || !ac.onGround || ac.flightRules !== 'VFR' || perfOf(ac).category !== 'light' || rt.landingOp === 'touch_and_go') return undefined;
  if (seeded01(ac.seed, 'req:TAXI_BACK') >= rate || !ac.assignedRunwayEnd) return undefined;
  rt.requestsDone.add('TAXI_BACK');
  ac.isDeparture = true;
  return ac.assignedRunwayEnd;
}

export function updatePilotRequests(ctx: SimContext): void {
  const { state } = ctx;
  const now = state.clock.timeSec;
  const airport = state.airport;
  const graph = airport.taxiwayGraph;
  const env = readbackEnv(ctx);
  for (const ac of Object.values(state.aircraft)) {
    const rt = getRuntime(ctx, ac);
    if (ac.radioState === 'TRANSMITTING' && now >= rt.radioFreeAtSec) ac.radioState = rt.readbackError ? 'WAITING_FOR_READBACK' : 'IDLE';

    // Readback mistakes not corrected within 20 s are scored as missed.
    if (rt.readbackError && now - rt.readbackError.sinceSec >= 20) {
      emitEvent(ctx, {
        kind: 'READBACK_ERROR', aircraftId: ac.id, callsign: ac.callsign, severity: 'warning', speaker: 'SYSTEM',
        text: `Missed readback error from ${ac.callsign}: said "${rt.readbackError.spoken}", should be "${rt.readbackError.correct}"`,
        data: { missed: true, correct: rt.readbackError.correct, spoken: rt.readbackError.spoken, errorKind: rt.readbackError.errorKind, clearanceId: rt.readbackError.clearanceId, byPosition: rt.readbackError.byPosition },
      });
      const missed = rt.readbackError;
      rt.readbackError = undefined;
      ac.flags.readbackErrorPending = false;
      ac.flags.readbackErrorClearanceId = undefined;
      if (ac.radioState === 'WAITING_FOR_READBACK') ac.radioState = 'IDLE';
      flyMisread(ctx, ac, missed); // nobody corrected it: the aircraft does what it read back
    }

    if (ac.radioState === 'TRANSMITTING') continue;

    // Vehicles and helicopters make their own calls (vehicles.ts, rotorcraft.ts); VFR transits, training circuits and the overhead maneuver
    // replace the generic inbound / clear-of-runway calls (special.ts).
    if (isVehicle(ac)) {
      vehiclePilotCalls(ctx, ac, rt, env);
      continue;
    }
    if (isRotorcraft(ac)) {
      heliPilotCalls(ctx, ac, rt, env);
      continue;
    }
    if (specialPilotCalls(ctx, ac, rt, env)) continue;

    if (towerVocabularyCalls(ctx, ac, rt, env)) continue;
    if (pilotInitiatedRequest(ctx, ac, rt)) continue;

    // Track standing still.
    if (ac.onGround && ac.groundSpeedKt < 0.1) rt.stillSince = rt.stillSince ?? now;
    else {
      rt.stillSince = undefined;
      for (const k of Array.from(rt.calls)) if (k.startsWith('hold:') || k.startsWith('holdX:')) rt.calls.delete(k);
    }

    // 0. IFR departure: Clearance Delivery first; ~15 s after the clearance it tunes Ground and asks for taxi (step 1).
    if (ac.phase === 'PARKED' && ac.isDeparture && ac.flightPlan?.flightRules === 'IFR') {
      const fp = ac.flightPlan;
      if (!fp.ifrClearance) {
        if (!rt.calls.has('ifrClearance') && now >= rt.firstCallAtSec) {
          rt.calls.add('ifrClearance');
          pilotSay(ctx, ac, ifrClearanceRequestCall(ac, env, { destination: fp.destination, atisLetter: state.atis.letter }), { request: 'IFR_CLEARANCE' });
          ac.pendingRequest = { kind: 'IFR_CLEARANCE', text: `IFR to ${fp.destination}, ready to copy`, sinceSec: now };
        }
        continue;
      }
      if (rt.taxiRequestAtSec === undefined || now < rt.taxiRequestAtSec || rt.readbackError?.kind === 'IFR_CLEARANCE') continue; // a faulty clearance readback is corrected first
      const gnd = frequencyForPosition(airport, 'GND');
      if (gnd && sameFrequency(ac.frequencyMhz, gnd.mhz)) ac.frequencyId = gnd.id; // Delivery and Ground share the frequency: the pilot now calls Ground
      else if (gnd) {
        ac.frequencyMhz = gnd.mhz;
        ac.frequencyId = gnd.id;
        emitEvent(ctx, {
          kind: 'HANDOFF', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', frequencyMhz: gnd.mhz,
          text: `${ac.callsign} changed to ${gnd.mhz.toFixed(3)} (${gnd.id})`, data: { frequencyId: gnd.id },
        });
      }
    }

    const gb = groundBehaviour(ctx);
    const atisLetter = pilotNeedsNumbers(ac, ctx.pilotBehaviour.noAtisFraction) ? undefined : state.atis.letter;

    // 0b. A hold-short the pilot did not read back that stands uncorrected is a communication error (JO 7110.65 2-4-3, 3-7-2).
    if (rt.unreadHoldShort && !rt.unreadHoldShort.charged && now - rt.unreadHoldShort.sinceSec >= gb.holdShortReadbackGraceSec) {
      rt.unreadHoldShort.charged = true;
      emitEvent(ctx, {
        kind: 'READBACK_ERROR', aircraftId: ac.id, callsign: ac.callsign, severity: 'warning', speaker: 'SYSTEM',
        text: `No hold-short readback from ${ac.callsign} for ${Math.round(now - rt.unreadHoldShort.sinceSec)} s: the controller must request it (JO 7110.65 2-4-3 "Ensure the read back of hold short instructions"; 3-7-2 "READ BACK HOLD INSTRUCTIONS")`,
        data: { holdShortReadback: true, commError: true },
      });
    }

    // 1a. Airliner at its gate: asks for pushback first (and again if it is not approved).
    if (ac.phase === 'PARKED' && ac.isDeparture && rt.needsPushback && !rt.pushedBack) {
      const asked = rt.pushbackAskedAtSec;
      const repeatAfter = jitteredInterval(ctx, ac, 'pushback-repeat', gb.pushbackRepeatAfterSec * (1 + 0.5 * Math.min(4, Math.max(0, (rt.pushbackAsks ?? 1) - 1))), rt.pushbackAsks ?? 0) // asks again less and less often when nobody answers;
      if ((asked === undefined && now >= rt.firstCallAtSec) || (asked !== undefined && !ac.pendingRequest && now - asked >= repeatAfter)
        || (asked !== undefined && ac.pendingRequest?.kind === 'PUSHBACK' && now - asked >= repeatAfter)) {
        rt.pushbackAskedAtSec = now;
        rt.pushbackAsks = (rt.pushbackAsks ?? 0) + 1;
        const parking = airport.parking.find((p) => dist(p.pos, ac.pos) < 5);
        pilotSay(ctx, ac, pushbackRequestCall(ac, env, parking, { atisLetter, repeat: asked !== undefined }), { request: 'PUSHBACK' });
        ac.pendingRequest = { kind: 'PUSHBACK', text: 'request pushback', sinceSec: now };
      }
      continue;
    }

    // 1b. Pushed back: engines running, ready to taxi after the start interval.
    if (ac.phase === 'PUSHBACK' && ac.isDeparture) {
      const pb = rt.pushback;
      if (pb?.stoppedAtSec !== undefined) {
        if (rt.readyAtSec === undefined) {
          const [lo, hi] = gb.airlinerReadyAfterPushSec;
          rt.readyAtSec = pb.stoppedAtSec + gb.pushSettleSec + lo + (hi - lo) * seeded01(ac.seed, 'ready-after-push');
        }
        if (now >= rt.readyAtSec && !rt.calls.has('readyToTaxi')) {
          rt.calls.add('readyToTaxi');
          const parking = airport.parking.find((p) => dist(p.pos, pb.from) < 5);
          const progressive = pilotUnfamiliar(ac, gb.unfamiliarFraction, ctx.pilotBehaviour.realism.progressiveTaxiRate);
          rt.progressive = progressive;
          pilotSay(ctx, ac, readyToTaxiCall(ac, env, parking, { atisLetter, pushedBack: true, progressive }), { request: 'TAXI' });
          setPhase(ctx, ac, 'READY', 'engines started');
          ac.pendingRequest = { kind: 'TAXI', text: progressive ? 'ready to taxi, request progressive taxi' : 'ready to taxi', sinceSec: now, progressive };
        }
      }
      continue;
    }

    // 1. Parked departure (no pushback): engine start, then asks for taxi. Seeded interval after its first call time.
    if (ac.phase === 'PARKED' && ac.isDeparture && !rt.needsPushback && !rt.calls.has('readyToTaxi')) {
      const [lo, hi] = gb.gaStartSec;
      if (now >= rt.firstCallAtSec + lo + (hi - lo) * seeded01(ac.seed, 'ga-start')) {
        rt.calls.add('readyToTaxi');
        const parking = airport.parking.find((p) => dist(p.pos, ac.pos) < 5);
        const progressive = pilotUnfamiliar(ac, gb.unfamiliarFraction, ctx.pilotBehaviour.realism.progressiveTaxiRate);
        rt.progressive = progressive;
        pilotSay(ctx, ac, readyToTaxiCall(ac, env, parking, { atisLetter, progressive }), { request: 'TAXI' });
        setPhase(ctx, ac, 'READY');
        ac.pendingRequest = { kind: 'TAXI', text: progressive ? 'ready to taxi, request progressive taxi' : 'ready to taxi', sinceSec: now, progressive };
      }
      continue;
    }

    // 1c. Progressive taxi: the segment is flown; the pilot asks for the next one.
    if (rt.progressive && ac.onGround && ac.phase === 'TAXIING' && ac.route && ac.route.progressIndex >= ac.route.nodeIds.length && ac.groundSpeedKt < 0.1
      && rt.stillSince !== undefined && now - rt.stillSince >= 3) {
      const lastId = ac.route.nodeIds[ac.route.nodeIds.length - 1];
      const last = graph.nodes[lastId];
      if (last && last.kind !== 'parking' && last.kind !== 'holding_position' && !rt.calls.has(`seg:${lastId}`)) {
        rt.calls.add(`seg:${lastId}`);
        pilotSay(ctx, ac, nextSegmentCall(ac, env, last.taxiways[0]), { request: 'TAXI' });
        ac.pendingRequest = { kind: 'TAXI', text: 'request next progressive taxi instructions', sinceSec: now, progressive: true };
        continue;
      }
    }

    // 1e0. Standing nose to nose with no head-on state (see HEAD_ON_STUCK_SEC): make it one, so that the pilot who must give way holds a live request.
    // (HOLDING_SHORT counts: two aircraft at the hold lines on either side of a runway crossing, each wanting the other's lane, stood 2,000 s and more in the hub soak - KBOS taxiway C
    // across 4L/22R, a departure and an arrival - the departure's phase being HOLDING_SHORT and the crossing request being all either had open.)
    const standing = (o: Aircraft) => o.phase === 'TAXIING' || o.phase === 'TAXI_TO_PARKING' || o.phase === 'HOLDING_SHORT';
    if (ac.onGround && ac.groundSpeedKt < 0.1 && rt.stillSince !== undefined && now - rt.stillSince >= HEAD_ON_STUCK_SEC && standing(ac) && ac.route) {
      const facing = Object.values(state.aircraft).find((o) => {
        if (o.id === ac.id || !o.onGround || o.groundSpeedKt >= 0.1 || !standing(o)) return false;
        const dx = o.pos.x - ac.pos.x;
        const dy = o.pos.y - ac.pos.y;
        const d = Math.hypot(dx, dy);
        const h = (ac.headingDeg * Math.PI) / 180;
        return d < HEAD_ON_STUCK_MARGINS * headOnMarginM(ac, o) && Math.abs(((o.headingDeg - ac.headingDeg + 540) % 360) - 180) > 100 && (Math.sin(h) * dx + Math.cos(h) * dy) > 0.5 * d;
      });
      if (facing) {
        if (!rt.headOn) rt.headOn = { otherId: facing.id, taxiway: graph.nodes[ac.route.nodeIds[Math.max(0, ac.route.progressIndex - 1)]]?.taxiways[0] ?? '', sinceSec: now, laneNodeIds: [], synthetic: true };
        if (rt.headOn.synthetic && rt.headOn.otherId === facing.id) rt.headOn.lastSeenSec = now;
      }
    }

    // 1e. Nose to nose with another aircraft on a shared lane (headOn.ts): the pilot who must give way asks for instructions, and asks again if nobody answers.
    if (rt.headOn && ac.onGround && ac.groundSpeedKt < 0.1 && rt.stillSince !== undefined && now - rt.stillSince >= HEAD_ON_CALL_AFTER_SEC) {
      const other = state.aircraft[rt.headOn.otherId];
      if (other && mustGiveWay(ac, other) === ac && (rt.headOn.lastCallSec === undefined || now - rt.headOn.lastCallSec >= HEAD_ON_RECALL_SEC)) {
        rt.headOn.lastCallSec = now;
        pilotSay(ctx, ac, noseToNoseCall(ac, env, other.spokenCallsign, rt.headOn.taxiway), { request: 'TAXI', headOn: true, nonStandard: true });
        ac.pendingRequest = { kind: 'TAXI', text: `nose to nose with ${other.callsign}${rt.headOn.taxiway ? ` on ${rt.headOn.taxiway}` : ''}, request instructions`, sinceSec: now, headOnWith: other.id };
        emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, text: `${ac.callsign} and ${other.callsign} stopped nose to nose on ${rt.headOn.taxiway || 'a taxiway'}`, severity: 'warning', speaker: 'SYSTEM', data: { headOn: true, otherId: other.id, taxiway: rt.headOn.taxiway } });
        continue;
      }
    }

    // 1f. The head-on is over (the other aircraft passed): the aircraft that stepped aside asks for new taxi instructions from where it stands.
    if (rt.headOnCalled !== undefined && now - rt.headOnCalled > HEAD_ON_RESUME_WINDOW_SEC) rt.headOnCalled = undefined;
    if (rt.headOnCalled !== undefined && !rt.headOn && !rt.progressive && ac.onGround && ac.route && ac.route.progressIndex >= ac.route.nodeIds.length && ac.groundSpeedKt < 0.1
      && rt.stillSince !== undefined && now - rt.stillSince >= 3 && (ac.phase === 'TAXIING' || ac.phase === 'TAXI_TO_PARKING')) {
      const lastNode = graph.nodes[ac.route.nodeIds[ac.route.nodeIds.length - 1]];
      if (!lastNode || lastNode.kind === 'parking' || lastNode.kind === 'holding_position') { rt.headOnCalled = undefined; continue; }
      rt.headOnCalled = undefined;
      const where = lastNode?.taxiways[0];
      pilotSay(ctx, ac, clearOfCall(ac, env, where), { request: 'TAXI', nonStandard: true });
      ac.pendingRequest = { kind: 'TAXI', text: `clear${where ? ` on ${where}` : ''}, request taxi instructions`, sinceSec: now, resume: true };
      continue;
    }

    // 1d. Stopped short of a hold-short that was not read back: the pilot asks for it again.
    if (rt.unreadHoldShort && ac.onGround && ac.route && rt.stoppedAtNodeId && ac.route.unreadStopNodeIds?.includes(rt.stoppedAtNodeId)
      && rt.stillSince !== undefined && now - rt.stillSince >= 2 && now >= rt.firstCallAtSec && !rt.calls.has(`unread:${rt.stoppedAtNodeId}`)) {
      rt.calls.add(`unread:${rt.stoppedAtNodeId}`);
      pilotSay(ctx, ac, holdShortQueryCall(ac, env), { request: 'OTHER' });
      ac.pendingRequest = { kind: 'OTHER', text: 'say again hold short instructions', sinceSec: now };
      continue;
    }

    // 2/3. Stopped at a holding position.
    if (ac.onGround && rt.stoppedAtNodeId && rt.stillSince !== undefined && now - rt.stillSince >= 2 && now >= rt.firstCallAtSec && ac.route) {
      const node = graph.nodes[rt.stoppedAtNodeId];
      const routeDone = ac.route.progressIndex >= ac.route.nodeIds.length;
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
      const departureHold =
        ac.isDeparture && routeDone && !!g && node.kind === 'holding_position' && node.runwayId === g.runway.id && (!node.protectsRunwayEnd || node.protectsRunwayEnd === g.end.id);
      if (departureHold && ac.phase === 'HOLDING_SHORT' && !rt.calls.has(`hold:${node.id}`)) {
        rt.calls.add(`hold:${node.id}`);
        const onTower = aircraftPosition(airport, ac) === 'TWR';
        // An intersection with too little runway for the type: the pilot does not accept an intersection departure from here.
        const tooShort = holdTooShort(g!, node, ac);
        const at = tooShort ? node.taxiways[0] : undefined;
        pilotSay(ctx, ac, holdingShortCall(ac, env, g!.end.id, onTower && !tooShort, at ? { requestFullLengthAt: at } : {}), { request: tooShort ? 'TAXI' : onTower ? 'DEPARTURE' : 'FREQUENCY_CHANGE' });
        ac.pendingRequest = tooShort
          ? { kind: 'TAXI', text: `holding short runway ${g!.end.id} at ${at}, request full length`, sinceSec: now }
          : onTower
            ? { kind: 'DEPARTURE', text: `holding short runway ${g!.end.id}, ready for departure`, sinceSec: now }
            : { kind: 'FREQUENCY_CHANGE', text: `holding short runway ${g!.end.id}`, sinceSec: now };
        continue;
      }
      if (!routeDone && node.kind === 'holding_position' && node.runwayId && !rt.calls.has(`holdX:${node.id}`) && !rt.conditionalCross && ac.route.stopAtNodeIds.includes(node.id)) {
        rt.calls.add(`holdX:${node.id}`);
        const taxiway = node.taxiways[0];
        pilotSay(ctx, ac, holdingShortCrossingCall(ac, env, node.runwayId, taxiway), { request: 'CROSSING' });
        ac.pendingRequest = { kind: 'CROSSING', text: `holding short of runway ${node.runwayId}`, sinceSec: now };
        continue;
      }
    }

    // 3b. Arrival that entered at a fix: check in with Approach.
    if (!ac.onGround && !ac.isDeparture && rt.approachCheckIn && now >= rt.firstCallAtSec) {
      rt.approachCheckIn = false;
      pilotSay(ctx, ac, approachCheckInCall(ac, env, { altitudeFt: ac.altitudeFt, atisLetter: state.atis.letter }), { request: 'APPROACH' });
      ac.pendingRequest = { kind: 'APPROACH', text: 'checking in inbound', sinceSec: now };
      continue;
    }

    // 3c. Runway light request (free play, night or low visibility): an arrival on Tower asks for the edge lights up or down (JO 7110.65 3-4-10 d, 3-4-11).
    // Whether this aircraft asks is a fixed function of its own seed (no shared random numbers are drawn), about one aircraft in eight.
    if (state.scenario.pilotRequests?.lights && !ac.onGround && !ac.isDeparture && ac.assignedRunwayEnd && !rt.calls.has('lights') && !ac.pendingRequest
      && (ac.phase === 'APPROACH' || ac.phase === 'FINAL') && aircraftPosition(airport, ac) === 'TWR' && now >= rt.firstCallAtSec + 5 && runwayLightsOn(state)) {
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
      const dNm = g ? mToNm(-alongCross(g, ac.pos).along) : 0;
      if (g && dNm <= 9 && dNm > 2) {
        rt.calls.add('lights');
        if (((ac.seed >>> 5) % 8) === 0 && lightsRunwayId(state) === g.runway.id) {
          const step = effectiveLightStep(state, g.runway.id);
          const dir = step >= 4 ? 'down' : step <= 2 ? 'up' : ac.seed & 1 ? 'up' : 'down';
          pilotSay(ctx, ac, lightsRequestCall(ac, env, dir), { request: 'OTHER', lights: dir });
          ac.pendingRequest = { kind: 'OTHER', text: `request lights ${dir}`, sinceSec: now };
          continue;
        }
      }
    }

    // 4. Arrivals: inbound call, then a call on final if not yet cleared.
    if (!ac.onGround && !ac.isDeparture && ac.assignedRunwayEnd) {
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
      if (g && (ac.phase === 'INBOUND' || ac.phase === 'APPROACH' || ac.phase === 'FINAL') && !rt.calls.has('inbound') && now >= rt.firstCallAtSec) {
        rt.calls.add('inbound');
        const distNm = mToNm(dist(ac.pos, { x: 0, y: 0 }));
        pilotSay(ctx, ac, inboundCall(ac, env, { distanceNm: distNm, bearingFromAirportDeg: bearingDeg({ x: 0, y: 0 }, ac.pos), atisLetter: pilotNeedsNumbers(ac, ctx.pilotBehaviour.noAtisFraction) ? undefined : state.atis.letter }), { request: 'LANDING' });
        ac.pendingRequest = { kind: 'LANDING', text: 'inbound for landing', sinceSec: now };
        continue;
      }
      const onApproachFreq = ['APP', 'DEP'].includes(aircraftPosition(airport, ac) ?? '');
      if (g && ac.phase === 'FINAL' && !rt.landingEnd && !rt.calls.has('final') && rt.calls.has('inbound') && rt.approach && onApproachFreq) {
        // Established on a cleared approach but still with Approach: report and wait for the tower handoff.
        rt.calls.add('final');
        pilotSay(ctx, ac, establishedCall(ac, env, { type: rt.approach.type, runwayEnd: g.end.id }), { request: 'FREQUENCY_CHANGE' });
        ac.pendingRequest = { kind: 'FREQUENCY_CHANGE', text: `established on the approach to runway ${g.end.id}`, sinceSec: now };
        continue;
      }
      if (g && ac.phase === 'FINAL' && !rt.landingEnd && !rt.calls.has('final') && rt.calls.has('inbound')) {
        const { along } = alongCross(g, ac.pos);
        const dNm = mToNm(-along);
        if (dNm <= 4.5 && dNm > 0.9) {
          rt.calls.add('final');
          pilotSay(ctx, ac, finalCall(ac, env, g.end.id, dNm), { request: 'LANDING' });
          ac.pendingRequest = { kind: 'LANDING', text: 'established final, requesting landing clearance', sinceSec: now };
          continue;
        }
      }
    }

    // 4b. Established after a go-around: ask what to do next.
    if (!ac.onGround && ac.phase === 'GO_AROUND' && !rt.calls.has('gaEst') && ac.target.altitudeFt !== undefined && Math.abs(ac.altitudeFt - ac.target.altitudeFt) < 20) {
      rt.calls.add('gaEst');
      const ifr = ac.flightPlan?.flightRules === 'IFR';
      const published = !!rt.missed;
      pilotSay(ctx, ac, goAroundEstablishedCall(ac, env, ac.target.altitudeFt, { vectors: ifr, published }), { request: published ? 'FREQUENCY_CHANGE' : 'LANDING' });
      ac.pendingRequest = published
        ? { kind: 'FREQUENCY_CHANGE', text: 'flying the published missed approach, request frequency change', sinceSec: now }
        : { kind: 'LANDING', text: ifr ? 'request vectors for another approach' : 'request another approach', sinceSec: now };
      continue;
    }

    // 4c. Braking action report after landing on a wet or contaminated runway (JO 7110.65 3-3-4 terms; 3-3-5: the controller solicits and issues
    // them). One report per runway every 10 minutes, sooner when it is worse than the latest one on file.
    if (ac.onGround && ac.phase === 'RUNWAY_EXIT' && rt.landedEnd && !rt.calls.has('braking')) {
      rt.calls.add('braking');
      const term = pilotBrakingTerm(state.weather, ctx.rng);
      const prev = latestBrakingReport(state, rt.landedEnd, BRAKING_REPORT_INTERVAL_SEC);
      if (term && (!prev || brakingWorse(term, prev.term))) {
        const report: BrakingReport = { runwayEnd: rt.landedEnd, term, aircraftType: ac.type, aircraftSpoken: spokenTypeForReport(ac.type), atSec: now };
        state.ops.braking.push(report);
        if (state.ops.braking.length > 20) state.ops.braking.splice(0, state.ops.braking.length - 20);
        pilotSay(ctx, ac, brakingActionCall(ac, env, term), { brakingAction: term, runwayEnd: rt.landedEnd });
        emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', text: `Braking action ${term} reported by ${ac.callsign} (${ac.type}) on runway ${rt.landedEnd}.`, data: { brakingAction: term, runwayEnd: rt.landedEnd } });
        continue;
      }
    }

    // 5. Clear of runway after landing.
    if (ac.onGround && ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.1 && !rt.calls.has('clear')) {
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
      const routeDone = !ac.route || ac.route.progressIndex >= ac.route.nodeIds.length;
      if (g && routeDone) {
        rt.calls.add('clear');
        // The check-in on Ground (step 6 below) already asked to taxi back for another departure: this call must not replace that request with "taxi to parking"
        // (the aircraft is a departure again by then, and no Ground controller answers an arrival that is flagged as a departure).
        if (ac.pendingRequest?.request === 'TAXI_BACK') continue;
        if (rt.calls.has('stoppedOnRunway')) {
          pilotSay(ctx, ac, stoppedOnRunwayCall(ac, env, g.runway.id), { request: 'OTHER' });
          ac.pendingRequest = { kind: 'OTHER', text: 'stopped on runway, unable to exit', sinceSec: now };
        } else {
          const taxiway = ac.route ? airport.taxiwayGraph.nodes[ac.route.nodeIds[ac.route.nodeIds.length - 1]].taxiways[0] : undefined;
          const onGround = aircraftPosition(airport, ac) === 'GND';
          const taxiBackEnd = onGround && !ac.flags.training ? wantsTaxiBack(ctx, ac, rt) : undefined;
          pilotSay(ctx, ac, ac.flags.training ? trainingClearCall(ac, env, taxiway) : clearOfRunwayCall(ac, env, g.end.id, taxiway) + (taxiBackEnd ? ` Request taxi back to runway ${spokenRunway(taxiBackEnd)} for departure.` : onGround ? ' Request taxi to parking.' : ''), { request: onGround ? 'TAXI' : 'FREQUENCY_CHANGE' });
          if (taxiBackEnd) ac.pendingRequest = { kind: 'TAXI', request: 'TAXI_BACK', runwayEnd: taxiBackEnd, text: `request taxi back to runway ${taxiBackEnd} for departure`, sinceSec: now };
          else {
            ac.pendingRequest = onGround
              ? { kind: 'TAXI', text: 'request taxi to parking', sinceSec: now }
              : { kind: 'FREQUENCY_CHANGE', text: 'clear of runway, request frequency change', sinceSec: now };
          }
        }
        continue;
      }
    }

    // 6. Check-in after a frequency change.
    if (rt.checkInAtSec !== undefined && now >= rt.checkInAtSec) {
      rt.checkInAtSec = undefined;
      const pos = aircraftPosition(airport, ac);
      if (!ac.onGround && ac.isDeparture && ac.flightPlan?.flightRules === 'IFR' && (pos === 'DEP' || pos === 'APP')) {
        pilotSay(ctx, ac, departureCheckInCall(ac, env, { targetAltitudeFt: ac.target.altitudeFt }), { checkIn: true });
        ac.pendingRequest = { kind: 'OTHER', text: 'checked in on departure', sinceSec: now };
        continue;
      }
      if (!ac.onGround && !ac.isDeparture && ac.assignedRunwayEnd) {
        const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
        if (g && (pos === 'APP' || pos === 'DEP') && (ac.phase === 'GO_AROUND' || rt.calls.has('gaEst') || rt.missedFlown)) {
          const nextFix = rt.hold ? rt.hold.fix : rt.missed ? ac.nav?.fixes[ac.nav.index] : undefined;
          const published = nextFix ? { climbToFt: ac.target.altitudeFt ?? Math.round(ac.altitudeFt), fix: nextFix, holding: !!rt.hold } : undefined;
          pilotSay(ctx, ac, missedApproachCheckInCall(ac, env, { published }), { checkIn: true });
          ac.pendingRequest = { kind: 'APPROACH', text: published ? 'missed approach, requesting further clearance' : 'missed approach, requesting vectors', sinceSec: now };
          continue;
        }
        if (g && pos === 'TWR' && ac.flightPlan) {
          rt.calls.add('inbound');
          rt.calls.add('final');
          pilotSay(ctx, ac, arrivalTowerCheckInCall(ac, env, { distanceNm: mToNm(-alongCross(g, ac.pos).along), runwayEnd: g.end.id }), { checkIn: true, request: 'LANDING' });
          ac.pendingRequest = { kind: 'LANDING', text: 'inbound, requesting landing clearance', sinceSec: now };
          continue;
        }
      }
      // Handed to Tower at or near the hold: the check-in IS the departure call (not a generic one).
      if (ac.onGround && ac.isDeparture && pos === 'TWR') {
        const gDep = findRunwayEnd(airport, ac.assignedRunwayEnd);
        const lastId = ac.route ? ac.route.nodeIds[ac.route.nodeIds.length - 1] : rt.stoppedAtNodeId;
        const hold = lastId ? graph.nodes[lastId] : undefined;
        if (gDep && hold && hold.kind === 'holding_position' && hold.runwayId === gDep.runway.id && (!hold.protectsRunwayEnd || hold.protectsRunwayEnd === gDep.end.id) && dist(hold.pos, ac.pos) <= HOLD_CHECKIN_RANGE_M) {
          const atHold = ac.phase === 'HOLDING_SHORT' || (ac.groundSpeedKt < 1 && dist(hold.pos, ac.pos) <= 25);
          rt.calls.add(`hold:${hold.id}`); // this call replaces the standard "holding short" call
          pilotSay(ctx, ac, atHold ? holdingShortCall(ac, env, gDep.end.id, true) : approachingHoldCall(ac, env, gDep.end.id), { checkIn: true, request: 'DEPARTURE' });
          ac.pendingRequest = { kind: 'DEPARTURE', text: `${atHold ? 'holding short' : 'approaching the hold'} runway ${gDep.end.id}, ready for departure`, sinceSec: now };
          continue;
        }
      }
      const wantsTaxi = ac.onGround && ac.phase === 'RUNWAY_EXIT' && pos === 'GND';
      const taxiway = ac.onGround && ac.route ? graph.nodes[ac.route.nodeIds[ac.route.nodeIds.length - 1]]?.taxiways[0] : undefined;
      const taxiBackEnd = wantsTaxi ? wantsTaxiBack(ctx, ac, rt) : undefined;
      pilotSay(ctx, ac, checkInCall(ac, env, { taxiway, wantsTaxiToParking: wantsTaxi, taxiBackRunway: taxiBackEnd }), { checkIn: true });
      if (taxiBackEnd) ac.pendingRequest = { kind: 'TAXI', request: 'TAXI_BACK', runwayEnd: taxiBackEnd, text: `request taxi back to runway ${taxiBackEnd} for departure`, sinceSec: now };
      else if (wantsTaxi) ac.pendingRequest = { kind: 'TAXI', text: 'request taxi to parking', sinceSec: now };
      // A pushed-back departure that was sent to the wrong frequency and back (its "ready to taxi" went with the change): the check-in is the request again.
      else if (ac.onGround && ac.isDeparture && ac.phase === 'READY' && pos === 'GND' && !ac.pendingRequest && !activeClearance(ac, 'TAXI')) ac.pendingRequest = { kind: 'TAXI', text: 'ready to taxi', sinceSec: now };
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const DEPARTURE_EXIT_NM = 15;
export const LOST_AIRCRAFT_NM = 40;
export const IFR_EXIT_ALTITUDE_FT = 6000;

/** On its route (route / direct navigation, not vectors) and moving away from the airport reference point. */
function outboundOnRoute(ac: Aircraft): boolean {
  if (!ac.nav || ac.nav.mode === 'vectors') return false;
  return vDot(headingToVec(ac.trackDeg), ac.pos) > 0;
}

export function updateLifecycle(ctx: SimContext): void {
  const now = ctx.state.clock.timeSec;
  for (const ac of Object.values(ctx.state.aircraft)) {
    const rt = getRuntime(ctx, ac);
    if (ac.phase === 'ARRIVED') {
      rt.arrivedAtSec = rt.arrivedAtSec ?? now;
      if (now - rt.arrivedAtSec >= ctx.pilotBehaviour.ground.arrivedLingerSec) removeAircraft(ctx, ac.id, true, 'arrived and shut down');
      continue;
    }
    if (isVehicle(ac) && rt.vehicle?.stage === 'DWELL' && ac.phase === 'PARKED') {
      rt.arrivedAtSec = rt.arrivedAtSec ?? now;
      if (now - rt.arrivedAtSec >= ctx.pilotBehaviour.ground.arrivedLingerSec) removeAircraft(ctx, ac.id, true, "back at the ramp");
      continue;
    }
    // A VFR transit leaves when it reaches the far end of its track (JO 7110.65 7-8-8: service ends when the aircraft leaves the outer area).
    if (!ac.onGround && rt.special?.transit && dist(ac.pos, rt.special.transit.exitPos) < 1852) {
      removeAircraft(ctx, ac.id, !!ac.radarIdentified, ac.radarIdentified ? 'crossed the area (Class C service)' : 'left the area without radar identification');
      continue;
    }
    if (!ac.onGround) {
      const dNm = mToNm(dist(ac.pos, { x: 0, y: 0 }));
      if (ac.phase === 'DEPARTURE' && dNm > DEPARTURE_EXIT_NM && ac.flightPlan?.flightRules === 'IFR') {
        // IFR departure: leaves once clear of the area and above 6000 ft or established outbound on its route.
        // Handled only if Departure also issued an altitude / direct / resume instruction after the handoff.
        if (ac.altitudeFt >= IFR_EXIT_ALTITUDE_FT || outboundOnRoute(ac)) {
          const handled = rt.handedOff && rt.depInstructed;
          removeAircraft(ctx, ac.id, handled, handled ? 'departed the area (handed off)' : rt.handedOff ? 'departed the area (no instruction after handoff)' : 'left the area without a handoff');
          continue;
        }
      }
      if (ac.phase === 'DEPARTURE' && dNm > DEPARTURE_EXIT_NM && ac.flightPlan?.flightRules !== 'IFR') {
        removeAircraft(ctx, ac.id, rt.handedOff, rt.handedOff ? 'departed the area (handed off)' : 'left the area without a handoff');
      } else if (dNm > LOST_AIRCRAFT_NM && (ac.isDeparture || vDot(headingToVec(ac.trackDeg), ac.pos) > 0)) {
        // beyond the area and moving away (an arrival coming in from a STAR entry fix outside it is not lost)
        removeAircraft(ctx, ac.id, false, 'left the simulation area');
      }
    }
  }
}

export type { Vec2 };
