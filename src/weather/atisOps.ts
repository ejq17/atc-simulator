/**
 * Builds the airport-state part of an ATIS (`AtisOps`, atis.ts) from the simulation state: closures in force, RVR for the runway(s) in
 * use, runway condition codes and braking action (runway condition derived from the weather, `runwayCondition.ts`), bird activity.
 */
import type { SimulationState } from '../sim/types';
import { activeClosures, latestBrakingReport, spokenTypeForReport } from '../sim/airportOps';
import { findRunwayEnd } from '../sim/runways';
import type { AtisOps } from './atis';
import { brakingAdvisoriesInEffect, runwayCondition } from './runwayCondition';
import { runwayHasRvr, rvrForVisibility } from './rvr';

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/** Reports older than this are not read on the ATIS. */
export const BRAKING_REPORT_MAX_AGE_SEC = 3600;

export function buildAtisOps(state: SimulationState, utcMs: number): AtisOps {
  const ops: AtisOps = {};
  const closures = activeClosures(state).map((c) => ({ kind: c.kind, ident: c.ident }));
  if (closures.length) ops.closures = closures;

  const ends = [...new Set([...state.activeRunways.landing, ...state.activeRunways.departing])];
  const rvr: NonNullable<AtisOps['rvr']> = [];
  const rwyCc: NonNullable<AtisOps['rwyCondition']> = [];
  const cond = runwayCondition(state.weather);
  const report = rvrForVisibility(state.weather.visibilitySm);
  for (const id of ends) {
    const g = findRunwayEnd(state.airport, id);
    if (!g) continue;
    if (report && runwayHasRvr(g.end)) rvr.push({ runwayEnd: g.end.id, report });
    if (cond.code < 6 && state.activeRunways.landing.includes(id)) rwyCc.push({ runwayEnd: g.end.id, code: cond.code, atUtc: hhmm(utcMs) });
  }
  if (rvr.length) ops.rvr = rvr;
  if (rwyCc.length) ops.rwyCondition = rwyCc;

  if (cond.code < 6) {
    const reports = state.ops.braking.filter((r) => state.clock.timeSec - r.atSec <= BRAKING_REPORT_MAX_AGE_SEC);
    if (brakingAdvisoriesInEffect(state.weather, reports)) ops.brakingAdvisories = true;
    const latest = ends.map((e) => latestBrakingReport(state, e, BRAKING_REPORT_MAX_AGE_SEC)).filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => b.atSec - a.atSec)[0];
    if (latest) ops.braking = { term: latest.term, aircraftSpoken: latest.aircraftSpoken || spokenTypeForReport(latest.aircraftType) };
  }
  if (state.ops.birds && state.clock.timeSec < state.ops.birds.untilSec) ops.birds = state.ops.birds.text;
  return ops;
}
