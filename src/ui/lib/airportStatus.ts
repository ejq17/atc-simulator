/**
 * What the panels say about the airport state (closures, braking action, runway condition, RVR, runway lights, bird activity) as plain data:
 * the Weather & Runways panel shows all of it, the flight strips show the closures. Pure, derived from `SimulationState` (src/sim/airportOps.ts,
 * src/weather/runwayCondition.ts, src/weather/rvr.ts).
 */
import type { Closure, SimulationState } from '../../sim/types';
import { activeClosures, closureText, effectiveLightStep, lightsRunwayId, latestBrakingReport, runwayLightsOn } from '../../sim/airportOps';
import { findRunwayEnd } from '../../sim/runways';
import { runwayCondition } from '../../weather/runwayCondition';
import { runwayHasRvr, rvrForVisibility } from '../../weather/rvr';

export interface ClosureLine {
  id: string;
  kind: Closure['kind'];
  ident: string;
  /** "Runway 4/22 closed" / "Taxiway B closed". */
  text: string;
  reason: string;
  /** Minutes until it reopens, rounded up; undefined = the rest of the session. */
  minutesLeft?: number;
}

export function closureLines(state: Pick<SimulationState, 'ops' | 'clock'>): ClosureLine[] {
  const now = state.clock.timeSec;
  return activeClosures(state).map((c) => ({
    id: c.id, kind: c.kind, ident: c.ident, text: closureText(c), reason: c.reason,
    ...(c.endSec !== undefined ? { minutesLeft: Math.max(1, Math.ceil((c.endSec - now) / 60)) } : {}),
  }));
}

export interface AirportStatus {
  closures: ClosureLine[];
  /** Runway condition derived from the weather ("wet, code 5"); undefined when dry. */
  runwayCondition?: string;
  braking?: string;
  rvr?: string;
  lights?: string;
  birds?: string;
}

export function airportStatus(state: SimulationState): AirportStatus {
  const out: AirportStatus = { closures: closureLines(state) };
  const cond = runwayCondition(state.weather);
  if (cond.code < 6) out.runwayCondition = `${cond.description}, runway condition code ${cond.code}${cond.term ? ` (${cond.term})` : ''}`;
  const ends = [...new Set([...state.activeRunways.landing, ...state.activeRunways.departing])];
  const report = rvrForVisibility(state.weather.visibilitySm);
  if (report) {
    const parts = ends.filter((e) => runwayHasRvr(findRunwayEnd(state.airport, e)?.end)).map((e) => `runway ${e} RVR ${report.kind === 'less_than' ? 'less than ' : ''}${report.rvrFt}`);
    if (parts.length) out.rvr = parts.join(', ');
  }
  for (const e of ends) {
    const b = latestBrakingReport(state, e);
    if (b && cond.code < 6) { out.braking = `braking action ${b.term} (${b.aircraftType}, runway ${b.runwayEnd})`; break; }
  }
  const rwy = lightsRunwayId(state);
  if (rwy) {
    const step = effectiveLightStep(state, rwy);
    out.lights = runwayLightsOn(state) ? `runway ${rwy} edge lights step ${step || 'off'}` : `runway ${rwy} edge lights off (daylight)`;
  }
  if (state.ops.birds && state.clock.timeSec < state.ops.birds.untilSec) out.birds = `bird activity in the vicinity of the airport, ${state.ops.birds.text}`;
  return out;
}
