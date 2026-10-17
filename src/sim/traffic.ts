/**
 * Spawning, automatic pilot-initiated calls, aircraft lifecycle and the pluggable
 * `TrafficGenerator` interface (continuous traffic scheduling can be expanded by src/game).
 */
import type { Aircraft, FlightPlan, Scenario, SimulationState, Vec2 } from './types';
import {
  bearingDeg, dist, headingDiff, headingToVec, mToNm, nmToM, vDot, vScale, vSub,
} from './geo';
import { glideAltitudeFt, finalStartNm } from './flightDynamics';
import { findRunwayEnd, alongCross } from './runways';
import { emitEvent, getRuntime, newRuntime, perfOf, pilotSay, setPhase } from './context';
import type { SimContext } from './context';
import { mulberry32, rngInt, rngPick } from './rng';
import { frequencyById, frequencyByMhz, frequencyForPosition, sameFrequency } from '../radio/frequencies';
import { findNavFix, fixPosition } from './navigation';
import { assignSquawk } from './ifr';
import { spokenCallsign as buildSpokenCallsign } from '../radio/spoken';
import {
  approachCheckInCall, arrivalTowerCheckInCall, checkInCall, clearOfRunwayCall, departureCheckInCall, establishedCall, finalCall, goAroundEstablishedCall,
  holdingShortCall, holdingShortCrossingCall, ifrClearanceRequestCall, inboundCall, missedApproachCheckInCall, readyToTaxiCall, stoppedOnRunwayCall,
} from '../radio/readback';
import type { ReadbackEnv } from '../radio/readback';

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
      const landing = state.activeRunways.landing[0] ?? state.activeRunways.departing[0];
      const departing = state.activeRunways.departing[0] ?? landing;
      if (now >= nextArrival) {
        nextArrival = now + gap(t.arrivalsPerHour);
        if (count < t.maxAircraft && landing) {
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
              initialFrequencyId: state.airport.frequencies.some((f) => f.id === 'APP') ? 'APP' : 'TWR',
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
  const other = rngPick(rng, origins);
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
  delete ctx.state.aircraft[id];
  ctx.runtime.delete(id);
  if (ctx.state.selectedAircraftId === id) ctx.state.selectedAircraftId = undefined;
  emitEvent(ctx, {
    kind: 'DESPAWN', aircraftId: id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
    text: `${ac.callsign} ${why}`, data: { handled },
  });
}

// ---------------------------------------------------------------------------
// Frequency changes
// ---------------------------------------------------------------------------

export function applyPendingFrequencyChanges(ctx: SimContext): void {
  const now = ctx.state.clock.timeSec;
  for (const ac of Object.values(ctx.state.aircraft)) {
    const rt = getRuntime(ctx, ac);
    if (!rt.pendingFreq || now < rt.pendingFreq.atSec) continue;
    const { mhz, id } = rt.pendingFreq;
    rt.pendingFreq = undefined;
    ac.frequencyMhz = mhz;
    ac.frequencyId = id;
    if (ac.pendingRequest?.kind === 'FREQUENCY_CHANGE') ac.pendingRequest = undefined;
    rt.handedOff = true;
    rt.checkInAtSec = now + 1 + ctx.rng() * 1.5;
    emitEvent(ctx, {
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
        data: { missed: true, correct: rt.readbackError.correct, spoken: rt.readbackError.spoken },
      });
      rt.readbackError = undefined;
      ac.flags.readbackErrorPending = false;
      if (ac.radioState === 'WAITING_FOR_READBACK') ac.radioState = 'IDLE';
    }

    if (ac.radioState === 'TRANSMITTING') continue;

    // Track standing still.
    if (ac.onGround && ac.groundSpeedKt < 0.1) rt.stillSince = rt.stillSince ?? now;
    else {
      rt.stillSince = undefined;
      for (const k of [...rt.calls]) if (k.startsWith('hold:') || k.startsWith('holdX:')) rt.calls.delete(k);
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
      if (rt.taxiRequestAtSec === undefined || now < rt.taxiRequestAtSec) continue;
      const gnd = frequencyForPosition(airport, 'GND');
      if (gnd && !sameFrequency(ac.frequencyMhz, gnd.mhz)) {
        ac.frequencyMhz = gnd.mhz;
        ac.frequencyId = gnd.id;
        emitEvent(ctx, {
          kind: 'HANDOFF', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', frequencyMhz: gnd.mhz,
          text: `${ac.callsign} changed to ${gnd.mhz.toFixed(3)} (${gnd.id})`, data: { frequencyId: gnd.id },
        });
      }
    }

    // 1. Parked departure asks for taxi.
    if (ac.phase === 'PARKED' && ac.isDeparture && !rt.calls.has('readyToTaxi') && now >= rt.firstCallAtSec) {
      rt.calls.add('readyToTaxi');
      const parking = airport.parking.find((p) => dist(p.pos, ac.pos) < 5);
      pilotSay(ctx, ac, readyToTaxiCall(ac, env, parking), { request: 'TAXI' });
      setPhase(ctx, ac, 'READY');
      ac.pendingRequest = { kind: 'TAXI', text: 'ready to taxi', sinceSec: now };
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
        const onTower = frequencyByMhz(airport, ac.frequencyMhz)?.position === 'TWR';
        pilotSay(ctx, ac, holdingShortCall(ac, env, g!.end.id, onTower), { request: onTower ? 'DEPARTURE' : 'FREQUENCY_CHANGE' });
        ac.pendingRequest = onTower
          ? { kind: 'DEPARTURE', text: `holding short runway ${g!.end.id}, ready for departure`, sinceSec: now }
          : { kind: 'FREQUENCY_CHANGE', text: `holding short runway ${g!.end.id}`, sinceSec: now };
        continue;
      }
      if (!routeDone && node.kind === 'holding_position' && node.runwayId && !rt.calls.has(`holdX:${node.id}`) && ac.route.stopAtNodeIds.includes(node.id)) {
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

    // 4. Arrivals: inbound call, then a call on final if not yet cleared.
    if (!ac.onGround && !ac.isDeparture && ac.assignedRunwayEnd) {
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
      if (g && (ac.phase === 'INBOUND' || ac.phase === 'APPROACH' || ac.phase === 'FINAL') && !rt.calls.has('inbound') && now >= rt.firstCallAtSec) {
        rt.calls.add('inbound');
        const distNm = mToNm(dist(ac.pos, { x: 0, y: 0 }));
        pilotSay(ctx, ac, inboundCall(ac, env, { distanceNm: distNm, bearingFromAirportDeg: bearingDeg({ x: 0, y: 0 }, ac.pos), atisLetter: state.atis.letter }), { request: 'LANDING' });
        ac.pendingRequest = { kind: 'LANDING', text: 'inbound for landing', sinceSec: now };
        continue;
      }
      const onApproachFreq = ['APP', 'DEP'].includes(frequencyByMhz(airport, ac.frequencyMhz)?.position ?? '');
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

    // 5. Clear of runway after landing.
    if (ac.onGround && ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.1 && !rt.calls.has('clear')) {
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
      const routeDone = !ac.route || ac.route.progressIndex >= ac.route.nodeIds.length;
      if (g && routeDone) {
        rt.calls.add('clear');
        if (rt.calls.has('stoppedOnRunway')) {
          pilotSay(ctx, ac, stoppedOnRunwayCall(ac, env, g.runway.id), { request: 'OTHER' });
          ac.pendingRequest = { kind: 'OTHER', text: 'stopped on runway, unable to exit', sinceSec: now };
        } else {
          const taxiway = ac.route ? airport.taxiwayGraph.nodes[ac.route.nodeIds[ac.route.nodeIds.length - 1]].taxiways[0] : undefined;
          const onGround = frequencyByMhz(airport, ac.frequencyMhz)?.position === 'GND';
          pilotSay(ctx, ac, clearOfRunwayCall(ac, env, g.end.id, taxiway) + (onGround ? ' Request taxi to parking.' : ''), { request: onGround ? 'TAXI' : 'FREQUENCY_CHANGE' });
          ac.pendingRequest = onGround
            ? { kind: 'TAXI', text: 'request taxi to parking', sinceSec: now }
            : { kind: 'FREQUENCY_CHANGE', text: 'clear of runway, request frequency change', sinceSec: now };
        }
        continue;
      }
    }

    // 6. Check-in after a frequency change.
    if (rt.checkInAtSec !== undefined && now >= rt.checkInAtSec) {
      rt.checkInAtSec = undefined;
      const pos = frequencyByMhz(airport, ac.frequencyMhz)?.position;
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
      const wantsTaxi = ac.onGround && ac.phase === 'RUNWAY_EXIT' && pos === 'GND';
      const taxiway = ac.onGround && ac.route ? graph.nodes[ac.route.nodeIds[ac.route.nodeIds.length - 1]]?.taxiways[0] : undefined;
      pilotSay(ctx, ac, checkInCall(ac, env, { taxiway, wantsTaxiToParking: wantsTaxi }), { checkIn: true });
      if (wantsTaxi) ac.pendingRequest = { kind: 'TAXI', text: 'request taxi to parking', sinceSec: now };
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const ARRIVED_DESPAWN_SEC = 20;
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
      if (now - rt.arrivedAtSec >= ARRIVED_DESPAWN_SEC) removeAircraft(ctx, ac.id, true, 'arrived and shut down');
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
      } else if (dNm > LOST_AIRCRAFT_NM) {
        removeAircraft(ctx, ac.id, false, 'left the simulation area');
      }
    }
  }
}

export type { Vec2 };
