/**
 * Special traffic behaviours that run on the ordinary fixed-wing model: VFR transitions through the Class C, flight-training circuits, military
 * fighters (flights of two, the overhead maneuver) and the common spawn initialisation of helicopters and vehicles.
 *
 * Sources: JO 7110.65 7-8 (Class C service: sequencing, traffic advisories, "(a/c call sign) standby" establishes two-way communication, 7-8-8
 * termination of service), AIM 3-2-4 (the pilot's call: position, altitude, radar beacon code, destination, request for Class C service), JO 7110.65
 * 2-1-13 (formation flights are controlled as a single aircraft), 3-10-12 (overhead maneuver: "pattern altitude", "report initial", "break at ...",
 * "report break"), 3-10-11 / 3-8-1 (closed traffic, touch-and-go), 14 CFR 91.117(b) as quoted in AIM 3-2-4 (no more than 200 kt at or below 2,500 ft AGL
 * within 4 nm of the primary Class C airport). Design values: the initial point 3 nm out, the break at midfield, the 200 kt overhead speed (the regulation
 * limit above; the 300 kt of simulator syllabi is not used).
 */
import type { Aircraft, SpawnBehavior, Vec2 } from './types';
import { dist, mToNm, bearingDeg, normHeading } from './geo';
import { emitEvent, getRuntime, pilotSay, setPhase } from './context';
import type { AircraftRuntime, SimContext } from './context';
import { alongCross, findRunwayEnd } from './runways';
import { patternAltitudeFt, getPerformance } from './performance';
import { overheadInboundCall, overheadReportCall, taxiBackRequestCall, trainingDownwindCall, trainingInboundCall, transitionRequestCall } from '../radio/specialCalls';
import type { ReadbackEnv } from '../radio/readback';

export interface SpecialRuntime {
  /** Helicopter: the pad name it is inbound to (for its calls). */
  padName?: string;
  /** Helicopter mission: DEPARTURE from the pad, ARRIVAL at it, REPOSITION = air taxi to another pad (padId). */
  mission?: 'DEPARTURE' | 'ARRIVAL' | 'REPOSITION';
  /** VFR transition: the straight track across the area. */
  transit?: { exitPos: Vec2; altitudeFt: number; called: boolean };
  /** Flight training: touch-and-go circuits left (counting the one being flown). */
  training?: { circuitsLeft: number; downwindCalled: boolean };
  /** Overhead maneuver. */
  overhead?: { stage: 'INBOUND' | 'INITIAL' | 'BROKE'; side: 'left' | 'right'; altitudeFt: number; reportInitial: boolean; reportBreak: boolean; instructed: boolean };
}

/** Overhead maneuver design values. */
export const OVERHEAD_INITIAL_NM = 3;
/** Indicated airspeed in the overhead (kt): the 200 kt limit at or below 2,500 ft AGL within 4 nm of a Class C primary airport (14 CFR 91.117(b), AIM 3-2-4). */
export const OVERHEAD_SPEED_KT = 200;
/** Distance of the spawn point from the airport for transits and overhead arrivals (nm). */
export const TRANSIT_EXIT_NM = 3;

/** Spawn-time setup of the special behaviours that need no module of their own (called from spawnFromSpec after the aircraft exists). */
export function initSpecial(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, b: SpawnBehavior): void {
  const airport = ctx.state.airport;
  if (b.kind === 'transit') {
    rt.special = { transit: { exitPos: b.exitPos, altitudeFt: b.altitudeFt, called: false } };
    rt.navMode = 'HEADING';
    ac.phase = 'INBOUND';
    ac.assignedRunwayEnd = undefined;
    ac.target = { headingDeg: normHeading(bearingDeg(ac.pos, b.exitPos)), altitudeFt: b.altitudeFt };
    ac.altitudeFt = b.altitudeFt;
    ac.squawk = '1200'; // VFR code until the controller assigns one (AIM 3-2-4: the pilot gives his radar beacon code)
    ac.flags.transit = true;
    ac.destination = ac.origin; // the spawn's remote airport is where the flight is going (the track leaves the area on the far side)
  } else if (b.kind === 'training') {
    rt.special = { training: { circuitsLeft: Math.max(1, b.circuits), downwindCalled: false } };
    ac.flags.training = true;
    ac.flags.circuits = Math.max(1, b.circuits);
  } else if (b.kind === 'military') {
    if (b.size && b.size > 1) {
      ac.formation = { size: b.size };
      ac.spokenCallsign = `${ac.spokenCallsign} flight of ${['', 'one', 'two', 'three', 'four'][Math.min(4, b.size)]}`;
    }
    if (b.overhead && !ac.onGround) {
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd ?? ctx.state.activeRunways.landing[0]);
      if (g) {
        const side = 'left' as const;
        const alt = Math.round(patternAltitudeFt(getPerformance(ac.type), g.elevationFt, airport.trafficPatternAltitudeFt) / 100) * 100;
        rt.special = { overhead: { stage: 'INBOUND', side, altitudeFt: alt, reportInitial: false, reportBreak: false, instructed: false } };
        ac.assignedRunwayEnd = g.end.id;
        ac.flags.overhead = 'INBOUND';
        rt.navMode = 'HEADING';
        ac.phase = 'INBOUND';
        ac.nav = undefined;
        ac.target = { headingDeg: g.headingDeg, altitudeFt: alt, speedKt: OVERHEAD_SPEED_KT };
        ac.altitudeFt = alt;
      }
    }
  } else if (b.kind === 'helicopter') {
    const pad = airport.parking.find((p) => p.id === b.padId);
    rt.special = { padName: pad?.name, mission: b.mission };
    ac.flags.padId = b.padId;
    if (!ac.onGround && pad) {
      // an inbound helicopter flies straight to its helipad, not to a runway (JO 7110.65 3-11-6; AIM 4-3-17: helicopters avoid the flow of fixed-wing traffic)
      ac.assignedRunwayEnd = undefined;
      ac.nav = undefined;
      ac.phase = 'INBOUND';
      rt.navMode = 'HEADING';
      rt.approach = undefined;
      ac.target = { headingDeg: normHeading(bearingDeg(ac.pos, pad.pos)), altitudeFt: ac.altitudeFt };
      ac.headingDeg = ac.target.headingDeg!;
      ac.trackDeg = ac.headingDeg;
    }
  }
}

/** Radio calls of the special behaviours; returns true when the aircraft spoke (the generic calls are then skipped this tick). */
export function specialPilotCalls(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, env: ReadbackEnv): boolean {
  const sp = rt.special;
  if (!sp) return false;
  const { state } = ctx;
  const now = state.clock.timeSec;
  const airport = state.airport;
  const distNm = mToNm(dist(ac.pos, { x: 0, y: 0 }));
  const brg = bearingDeg({ x: 0, y: 0 }, ac.pos);

  // VFR transition: AIM 3-2-4 call (position, altitude, code, destination, request).
  if (sp.transit && !sp.transit.called && now >= rt.firstCallAtSec) {
    sp.transit.called = true;
    pilotSay(ctx, ac, transitionRequestCall(ac, env, { distanceNm: distNm, bearingFromAirportDeg: brg, altitudeFt: ac.altitudeFt, destination: ac.destination }), { request: 'OTHER', transition: true });
    ac.pendingRequest = { kind: 'OTHER', text: 'request transition through the Class C airspace', sinceSec: now };
    return true;
  }

  // Flight training: inbound call (replaces the generic one), downwind call on every circuit.
  if (sp.training && !ac.onGround && !ac.isDeparture) {
    if (!rt.calls.has('inbound') && now >= rt.firstCallAtSec && (ac.phase === 'INBOUND' || ac.phase === 'APPROACH' || ac.phase === 'FINAL')) {
      rt.calls.add('inbound');
      pilotSay(ctx, ac, trainingInboundCall(ac, env, { distanceNm: distNm, bearingFromAirportDeg: brg, atisLetter: state.atis.letter }), { request: 'LANDING', training: true });
      ac.pendingRequest = { kind: 'LANDING', text: 'inbound for touch and go', sinceSec: now };
      return true;
    }
    const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
    if (g && ac.phase === 'PATTERN' && rt.pattern?.leg === 'DOWNWIND' && !sp.training.downwindCalled && alongCross(g, ac.pos).along <= g.lengthM / 2 + 300) {
      sp.training.downwindCalled = true;
      pilotSay(ctx, ac, trainingDownwindCall(ac, env, { side: rt.pattern.side, runwayEnd: g.end.id }), { request: 'PATTERN', training: true });
      ac.pendingRequest = { kind: 'LANDING', text: `${rt.pattern.side} downwind, request touch and go`, sinceSec: now };
      return true;
    }
    if (ac.phase !== 'PATTERN') sp.training.downwindCalled = false;
  }

  // Overhead maneuver: inbound call, "initial", "break".
  const oh = sp.overhead;
  if (oh && !ac.onGround) {
    const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
    if (g && !rt.calls.has('inbound') && now >= rt.firstCallAtSec) {
      rt.calls.add('inbound');
      pilotSay(ctx, ac, overheadInboundCall(ac, env, { distanceNm: distNm, bearingFromAirportDeg: brg, atisLetter: state.atis.letter }), { request: 'LANDING', overhead: true });
      ac.pendingRequest = { kind: 'LANDING', text: 'inbound for the overhead', sinceSec: now };
      return true;
    }
    if (g && oh.stage === 'INITIAL' && oh.reportInitial && !rt.calls.has('ohInitial')) {
      rt.calls.add('ohInitial');
      pilotSay(ctx, ac, overheadReportCall(ac, env, { what: 'INITIAL', runwayEnd: g.end.id }), { request: 'LANDING', overheadReport: 'INITIAL' });
      ac.pendingRequest = { kind: 'LANDING', text: 'initial', sinceSec: now };
      return true;
    }
    if (g && oh.stage === 'BROKE' && oh.reportBreak && !rt.calls.has('ohBreak')) {
      rt.calls.add('ohBreak');
      pilotSay(ctx, ac, overheadReportCall(ac, env, { what: 'BREAK', runwayEnd: g.end.id }), { request: 'LANDING', overheadReport: 'BREAK' });
      ac.pendingRequest = { kind: 'LANDING', text: 'break', sinceSec: now };
      return true;
    }
  }
  return false;
}

/** After a full stop the student asks to taxi back (replaces the generic "clear of the runway, request taxi to parking" call). */
export function trainingClearCall(ac: Aircraft, env: ReadbackEnv, taxiway?: string): string {
  return taxiBackRequestCall(ac, env, { taxiway });
}

/** One touch-and-go of a training aircraft has been flown (flightDynamics.continueInPattern): count it; the last one becomes a full stop. */
export function trainingCircuitDone(ac: Aircraft, rt: AircraftRuntime): void {
  const t = rt.special?.training;
  if (t && t.circuitsLeft > 0) t.circuitsLeft--;
  if (t) ac.flags.circuits = t.circuitsLeft;
}

/** Circuits still to fly including the current approach (AI: touch-and-go while above 1, full stop on the last). */
export function trainingCircuitsLeft(rt: AircraftRuntime | undefined): number {
  return rt?.special?.training?.circuitsLeft ?? 0;
}

/** Per-tick progression of the overhead maneuver and the transit exit. */
export function updateSpecial(ctx: SimContext): void {
  const { state } = ctx;
  const airport = state.airport;
  for (const ac of Object.values(state.aircraft)) {
    const rt = getRuntime(ctx, ac);
    const sp = rt.special;
    if (!sp) continue;
    const oh = sp.overhead;
    if (oh && !ac.onGround && (oh.stage === 'INBOUND' || oh.stage === 'INITIAL')) {
      const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
      if (!g) continue;
      const { along, cross } = alongCross(g, ac.pos);
      // keep the course to the runway: the track is the extended centreline until the break
      ac.target.headingDeg = normHeading(g.headingDeg - Math.max(-25, Math.min(25, cross * 0.05)));
      ac.target.altitudeFt = oh.altitudeFt;
      const dNm = mToNm(-along);
      if (oh.stage === 'INBOUND' && dNm <= OVERHEAD_INITIAL_NM) {
        oh.stage = 'INITIAL';
        ac.flags.overhead = 'INITIAL';
        ac.target.speedKt = OVERHEAD_SPEED_KT;
      }
      // the break: over the middle of the runway (design value; 3-10-12 specifies the point only when it is nonstandard)
      if (oh.stage === 'INITIAL' && along >= g.lengthM / 2) {
        oh.stage = 'BROKE';
        ac.flags.overhead = 'BROKE';
        rt.turnDirection = oh.side;
        rt.pattern = { leg: 'DOWNWIND', side: oh.side, runwayEnd: g.end.id };
        rt.navMode = 'AUTO';
        ac.target = {};
        setPhase(ctx, ac, 'PATTERN', 'overhead break');
        emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM', text: `${ac.callsign} breaks over runway ${g.end.id} (${oh.side} turn to downwind)`, data: { overheadBreak: true } });
      }
    }
  }
}

