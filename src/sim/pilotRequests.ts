/**
 * Pilot-initiated requests (pilot realism). Each aircraft makes a given request at most once, decided with a seeded draw
 * (`seeded01(ac.seed, 'req:<CODE>') < rate`, rates in `PilotRealism.requests`) and only when the situation fits. The request is
 * spoken and becomes `Aircraft.pendingRequest` with a `request` code; the controller answers with an ordinary command
 * (the answer column) or "unable" (`UNABLE`, which just clears the request):
 *
 *   RUNWAY_CHANGE    "request runway two two"                      LAND runway 22 (clears the new runway) / unable
 *   SHORT_APPROACH   "request short approach" (downwind)           PATTERN_INSTRUCTION short approach / unable
 *   OPTION           "request the option"                          LAND with the option (JO 7110.65 3-8-1) / unable
 *   STRAIGHT_IN      "request straight-in runway 13"               ENTER_PATTERN straight in, or LAND / unable
 *   STAY_IN_PATTERN  "request to stay in the pattern for a few more"  LAND touch-and-go, or closed traffic (3-10-11) / unable
 *   SPACING_360      "request a three sixty for spacing"           PATTERN_INSTRUCTION 360 (3-8-1) / unable
 *   NEED_MINUTE      "unable, we need a minute" to a takeoff clearance, then "ready for departure" (see commandExecutor)
 *   HIGHER / LOWER   "request higher" / "request lower"            ALTITUDE / unable
 *   DIRECT_FIX       "request direct <fix>"                        DIRECT_FIX / unable
 *   VISUAL_APPROACH  "we have the field in sight, request visual approach"   APPROACH visual (7-4-1) / unable
 *   TAXI_BACK        "clear of the runway, request taxi back for departure"  TAXI to the runway (GND) / unable
 *   PROGRESSIVE_TAXI a student asks for progressive taxi (see traffic.ts; the ground task decides how to follow it)
 *
 * The phrases are pilot habit, not FAA phraseology (the FAA gives the controller's side); each is read from the answer the
 * controller can already give with an existing command. All values are design values (pilotBehaviour.ts).
 */
import type { Aircraft, Airport, PendingRequest } from './types';
import type { AircraftRuntime, SimContext } from './context';
import { getRuntime, pilotSay } from './context';
import { seeded01 } from './rng';
import { dist, mToNm, nmToM } from './geo';
import { findRunwayEnd } from './runways';
import { perfOf } from './context';
import { findNavFix } from './navigation';
import { windComponents } from './wind';
import { aircraftPosition, facilityCallName } from '../radio/frequencies';
import { spokenRunway } from '../radio/spoken';
import { spokenFix } from '../radio/readback';
import type { PilotRequestCode } from './pilotBehaviour';

/** Minimum time between two requests of one aircraft. */
const REQUEST_COOLDOWN_SEC = 90;

interface Offer { code: PilotRequestCode; phrase: string; pending: Omit<PendingRequest, 'sinceSec' | 'request'> & Partial<Pick<PendingRequest, 'fix' | 'runwayEnd'>> }

function facility(ctx: SimContext, ac: Aircraft): string {
  return facilityCallName(ctx.state.airport, ac.frequencyMhz, ac.frequencyId);
}

function wants(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, code: Exclude<PilotRequestCode, 'PROGRESSIVE_TAXI' | 'LOWER'>): boolean {
  if (rt.requestsDone.has(code)) return false;
  if ((code === 'OPTION' || code === 'STAY_IN_PATTERN') && ctx.state.scenario.traffic?.patternWork === false) return false;
  const rate = ctx.pilotBehaviour.realism.requests[code];
  return rate > 0 && seeded01(ac.seed, `req:${code}`) < rate;
}

const isLightVfr = (ac: Aircraft) => ac.flightRules === 'VFR' && perfOf(ac).category === 'light';

/** The runway end of another runway with the best headwind, for "request runway ..." (undefined: none better / single runway). */
export function betterRunwayEnd(ctx: SimContext, ac: Aircraft): string | undefined {
  const airport = ctx.state.airport;
  const cur = findRunwayEnd(airport, ac.assignedRunwayEnd);
  if (!cur) return undefined;
  let best: { id: string; hw: number } | undefined;
  for (const r of airport.runways) {
    if (r.id === cur.runway.id) continue;
    for (const e of r.ends) {
      const g = findRunwayEnd(airport, e.id);
      if (!g) continue;
      const hw = windComponents(ctx.state.weather, g.headingDeg).headwindKt;
      if (!best || hw > best.hw) best = { id: g.end.id, hw };
    }
  }
  return best?.id;
}

function offerFor(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime): Offer | undefined {
  const { state } = ctx;
  const airport: Airport = state.airport;
  const pos = aircraftPosition(airport, ac);
  const g = findRunwayEnd(airport, ac.assignedRunwayEnd);
  const airborne = !ac.onGround;
  const dThrNm = g ? mToNm(dist(ac.pos, g.end.threshold)) : Infinity;

  if (airborne && !ac.isDeparture && g && !rt.landingEnd && (pos === 'TWR' || pos === 'APP')) {
    // VFR arrivals
    if (isLightVfr(ac) && (ac.phase === 'INBOUND' || ac.phase === 'APPROACH' || ac.phase === 'FINAL') && rt.calls.has('inbound') && !rt.pattern && dThrNm >= 5 && dThrNm <= 15) {
      if (wants(ctx, ac, rt, 'RUNWAY_CHANGE')) {
        const other = betterRunwayEnd(ctx, ac);
        if (other) return { code: 'RUNWAY_CHANGE', phrase: `request runway ${spokenRunway(other)}`, pending: { kind: 'LANDING', text: `request runway ${other}`, runwayEnd: other } };
        rt.requestsDone.add('RUNWAY_CHANGE');
      }
      if (wants(ctx, ac, rt, 'STRAIGHT_IN')) {
        return { code: 'STRAIGHT_IN', phrase: `request straight-in runway ${spokenRunway(g.end.id)}`, pending: { kind: 'LANDING', text: `request straight-in runway ${g.end.id}`, runwayEnd: g.end.id } };
      }
    }
    if (isLightVfr(ac) && ac.phase === 'PATTERN' && rt.pattern) {
      const leg = rt.pattern.leg;
      if (leg === 'DOWNWIND' && !rt.pattern.short && !rt.pattern.extend && wants(ctx, ac, rt, 'SHORT_APPROACH')) {
        return { code: 'SHORT_APPROACH', phrase: 'request short approach', pending: { kind: 'PATTERN', text: 'request short approach' } };
      }
      if ((leg === 'DOWNWIND' || leg === 'BASE') && wants(ctx, ac, rt, 'OPTION')) {
        return { code: 'OPTION', phrase: 'request the option', pending: { kind: 'PATTERN', text: 'request the option' } };
      }
      if (leg === 'DOWNWIND' && rt.closedTraffic && wants(ctx, ac, rt, 'STAY_IN_PATTERN')) {
        return { code: 'STAY_IN_PATTERN', phrase: 'request to stay in the pattern for a few more', pending: { kind: 'PATTERN', text: 'request to stay in the pattern for a few more' } };
      }
      if ((leg === 'DOWNWIND' || leg === 'BASE') && wants(ctx, ac, rt, 'SPACING_360')) {
        // a leader closer to touchdown in the same circuit (further along the legs, or the same leg and nearer the threshold) and close by
        const rank = (o: Aircraft): number => (o.phase === 'FINAL' || o.phase === 'APPROACH' || o.phase === 'LANDING' ? 4 : { UPWIND: 0, CROSSWIND: 1, DOWNWIND: 2, BASE: 3 }[getRuntime(ctx, o).pattern?.leg ?? 'UPWIND']);
        const mine = rank(ac);
        const toThr = (o: Aircraft) => dist(o.pos, g.end.threshold);
        const ahead = Object.values(state.aircraft).some((o) => o.id !== ac.id && !o.onGround && o.assignedRunwayEnd === ac.assignedRunwayEnd
          && ['FINAL', 'PATTERN', 'APPROACH'].includes(o.phase) && dist(o.pos, ac.pos) < nmToM(2.5) && (rank(o) > mine || (rank(o) === mine && toThr(o) < toThr(ac))));
        if (ahead) return { code: 'SPACING_360', phrase: 'request a three sixty for spacing', pending: { kind: 'PATTERN', text: 'request a three sixty for spacing' } };
      }
    }
  }

  // IFR arrival with the field in sight (visual approach, JO 7110.65 7-4-1)
  if (airborne && !ac.isDeparture && ac.flightPlan?.flightRules === 'IFR' && g && !rt.approach && !rt.landingEnd && pos === 'APP'
    && (ac.phase === 'INBOUND' || ac.phase === 'APPROACH' || ac.phase === 'FINAL') && dThrNm <= 15 && dThrNm >= 3 && state.weather.flightCategory === 'VFR' && state.weather.visibilitySm >= 5 && wants(ctx, ac, rt, 'VISUAL_APPROACH')) {
    return {
      code: 'VISUAL_APPROACH', phrase: `we have the field in sight, request visual approach runway ${spokenRunway(g.end.id)}`,
      pending: { kind: 'APPROACH', text: `field in sight, request visual approach runway ${g.end.id}`, runwayEnd: g.end.id },
    };
  }

  // Departures
  if (airborne && ac.isDeparture && ac.phase === 'DEPARTURE' && (pos === 'DEP' || pos === 'APP' || pos === 'TWR')) {
    const agl = ac.altitudeFt - airport.elevationFt;
    if (agl >= 1200) {
      // a fix of the filed route beyond the next one (or any later fix when no route is being flown yet)
      const later = ac.nav && ac.nav.mode === 'route' ? ac.nav.fixes.slice(ac.nav.index + 1) : (ac.flightPlan?.route ?? []).slice(1);
      if (later.length && wants(ctx, ac, rt, 'DIRECT_FIX')) {
        const fix = later[0];
        if (findNavFix(airport, fix)) return { code: 'DIRECT_FIX', phrase: `request direct ${spokenFix(airport, fix)}`, pending: { kind: 'OTHER', text: `request direct ${fix}`, fix } };
      }
      if (wants(ctx, ac, rt, 'HIGHER')) {
        const lower = ac.altitudeFt > 3500 && seeded01(ac.seed, 'req:lower') < 0.35;
        const word = lower ? 'lower' : 'higher';
        return { code: lower ? 'LOWER' : 'HIGHER', phrase: `request ${word}`, pending: { kind: 'OTHER', text: `request ${word}` } };
      }
    }
  }
  return undefined;
}

/**
 * Called from `updatePilotRequests` for an aircraft that is free to speak. Returns true when the aircraft spoke (a request, or "ready
 * for departure" after a minute at the hold).
 */
export function pilotInitiatedRequest(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime): boolean {
  const R = ctx.pilotBehaviour.realism;
  const now = ctx.state.clock.timeSec;
  // After "we need a minute": ready again.
  if (rt.notReadyUntilSec !== undefined && now >= rt.notReadyUntilSec && ac.onGround) {
    rt.notReadyUntilSec = undefined;
    const g = findRunwayEnd(ctx.state.airport, ac.assignedRunwayEnd);
    pilotSay(ctx, ac, `${facility(ctx, ac)}, ${ac.spokenCallsign}, ready for departure${g ? ` runway ${spokenRunway(g.end.id)}` : ''}.`, { request: 'DEPARTURE', ready: true });
    ac.pendingRequest = { kind: 'DEPARTURE', text: `ready for departure${g ? ` runway ${g.end.id}` : ''}`, sinceSec: now };
    return true;
  }
  if (R.level === 'off' || (ac.onGround && ac.isDeparture)) return false;
  if (rt.requestCheckedAtSec !== undefined && now - rt.requestCheckedAtSec < 1) return false; // the situation is judged once a second
  rt.requestCheckedAtSec = now;
  // The pilot's own earlier call (inbound for landing, checking in) is still unanswered: a request replaces it after a short wait.
  const open = ac.pendingRequest;
  if (open && (open.request !== undefined || !['LANDING', 'PATTERN', 'APPROACH'].includes(open.kind) || now - open.sinceSec < 6)) return false;
  if (rt.lastRequestAtSec !== undefined && now - rt.lastRequestAtSec < REQUEST_COOLDOWN_SEC) return false;
  if (now - ac.spawnedAtSec < 20) return false;
  const offer = offerFor(ctx, ac, rt);
  if (!offer) return false;
  rt.requestsDone.add(offer.code);
  rt.lastRequestAtSec = now;
  pilotSay(ctx, ac, `${facility(ctx, ac)}, ${ac.spokenCallsign}, ${offer.phrase}.`, { request: 'OTHER', pilotRequest: offer.code });
  ac.pendingRequest = { ...offer.pending, request: offer.code, sinceSec: now };
  return true;
}

