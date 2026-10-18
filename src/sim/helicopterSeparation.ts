/**
 * Helicopter / fixed-wing separation in the airspace around the airport.
 *
 * The rule the simulator applies (conservative, no visual separation):
 *  - Helicopters operate low: an inbound helicopter levels at `HELI_LEVEL_AGL_FT` (400 ft AGL, under the 500 ft AGL helicopter pattern altitude of AIM 4-3-3,
 *    which keeps it 500 ft or more under a propeller aircraft's 1,000 ft AGL pattern) and a lifting-off helicopter climbs through that band.
 *  - A runway takeoff or landing clearance is not given while a helicopter below `HELI_BAND_AGL_FT` (900 ft AGL: its level plus the 500 ft of 7-8-3) is
 *    within `HELI_LATERAL_NM` of the runway's departure track / final approach course (the 1.5 nm alert distance of the simulator plus a margin).
 *  - A helicopter takeoff or landing clearance is not given while a fixed-wing aircraft that is rolling, or airborne below the band, is within the same
 *    distance of the helicopter's track.
 *  The helicopter then waits (on the pad, or hovering) and the runway traffic is released once the other aircraft has passed: separation is not left to
 *  chance. Tower-applied visual separation (JO 7110.65 7-2-1a1) would also be allowed when "the tower visually observes the aircraft, issues timely traffic
 *  advisories, and provides visual separation between the aircraft", "Do not apply visual separation between successive departures when departure
 *  routes and/or aircraft performance preclude maintaining separation", and "not authorized when wake turbulence separation is required"; the simulator
 *  does not model the tower's sight or the advisories, so it never relies on it. Helicopter operations "will be instructed to avoid the flow of
 *  fixed-wing aircraft" (AIM 4-3-17) and 3-11-3 / 3-11-4 separate helicopters only from other helicopters, so the distance and height values here are
 *  DESIGN values taken from the simulator's own near-miss alert (1.5 nm / 500 ft).
 */
import type { Aircraft, SimulationState, Vec2 } from './types';
import { distancePointToSegment, nmToM } from './geo';
import { findRunwayEnd } from './runways';
import type { RunwayEndGeom } from './runways';
import { isRotorcraftType, isVehicleType } from './performance';

export const HELI_LEVEL_AGL_FT = 400;
export const HELI_BAND_AGL_FT = 900;
export const HELI_LATERAL_NM = 1.8;
/** Departure track beyond the runway end and final approach course length (nm) used for the checks. */
export const DEPARTURE_TRACK_NM = 4;
export const FINAL_TRACK_NM = 4;

export type Track = [Vec2, Vec2];

/** Takeoff run + climb-out: from the departure threshold, down the runway and `DEPARTURE_TRACK_NM` beyond its end. */
export function runwayDepartureTrack(g: RunwayEndGeom): Track {
  const a = g.end.threshold;
  const len = g.lengthM + nmToM(DEPARTURE_TRACK_NM);
  return [a, { x: a.x + g.dir.x * len, y: a.y + g.dir.y * len }];
}

/** Final approach course: `FINAL_TRACK_NM` out to the landing threshold and on to the runway end. */
export function runwayFinalTrack(g: RunwayEndGeom): Track {
  const t = g.landingThreshold;
  const back = nmToM(FINAL_TRACK_NM);
  return [{ x: t.x - g.dir.x * back, y: t.y - g.dir.y * back }, { x: g.end.threshold.x + g.dir.x * g.lengthM, y: g.end.threshold.y + g.dir.y * g.lengthM }];
}

const near = (p: Vec2, tr: Track): boolean => distancePointToSegment(p, tr[0], tr[1]) < nmToM(HELI_LATERAL_NM);

/** Airborne helicopters below the helicopter band within the lateral distance of a track. */
export function lowHelicoptersNearTrack(state: SimulationState, tr: Track, exceptId: string): Aircraft[] {
  const elev = state.airport.elevationFt;
  return Object.values(state.aircraft).filter((o) => o.id !== exceptId && isRotorcraftType(o.type) && !o.onGround && o.altitudeFt - elev < HELI_BAND_AGL_FT && near(o.pos, tr));
}

/** Smallest distance between two segments (m). */
export function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
  return Math.min(distancePointToSegment(a, c, d), distancePointToSegment(b, c, d), distancePointToSegment(c, a, b), distancePointToSegment(d, a, b));
}

const trackNear = (t: Track, u: Track): boolean => segmentDistance(t[0], t[1], u[0], u[1]) < nmToM(HELI_LATERAL_NM);

/**
 * Fixed-wing runway operations that a helicopter track must not share the sky with: an aircraft rolling for takeoff or landing, cleared for takeoff, on final
 * (FINAL / LANDING, or on the approach within 6 nm of its threshold), whose runway's departure track / final approach course passes within the separation
 * distance of the helicopter's track (predictive: a pad lies within 1 nm of these tracks, a position test alone would see the aircraft only when it is
 * already too close), and any fixed-wing aircraft airborne below the helicopter band within the distance of the track (climbing out, going around,
 * in the pattern). With `includeHelicopters` other airborne helicopters below the band near the track count too: one helicopter at a time.
 */
export function fixedWingNearTrack(state: SimulationState, tr: Track, exceptId: string, includeHelicopters = false): Aircraft[] {
  const elev = state.airport.elevationFt;
  return Object.values(state.aircraft).filter((o) => {
    if (o.id === exceptId || isVehicleType(o.type)) return false;
    if (isRotorcraftType(o.type)) return includeHelicopters && !o.onGround && o.altitudeFt - elev < HELI_BAND_AGL_FT && near(o.pos, tr);
    const g = findRunwayEnd(state.airport, o.assignedRunwayEnd);
    if (o.onGround) {
      if (!g) return false;
      if (o.phase === 'CLEARED_FOR_TAKEOFF' || o.phase === 'TAKEOFF_ROLL') return trackNear(tr, runwayDepartureTrack(g));
      if (o.phase === 'ROLLOUT') return trackNear(tr, runwayFinalTrack(g));
      return false;
    }
    if (g && !o.isDeparture && (o.phase === 'FINAL' || o.phase === 'LANDING' || (o.phase === 'APPROACH' && Math.hypot(o.pos.x - g.end.threshold.x, o.pos.y - g.end.threshold.y) < nmToM(6)))) return trackNear(tr, runwayFinalTrack(g));
    return o.altitudeFt - elev < HELI_BAND_AGL_FT && near(o.pos, tr);
  });
}

/** The track of a helicopter lift-off or approach: a straight line `nm` long from its position along `trueHeadingDeg`. */
export function helicopterTrack(from: Vec2, trueHeadingDeg: number, nm = 8): Track {
  const r = (trueHeadingDeg * Math.PI) / 180;
  return [from, { x: from.x + Math.sin(r) * nmToM(nm), y: from.y + Math.cos(r) * nmToM(nm) }];
}
