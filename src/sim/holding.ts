/**
 * Holding patterns (standard racetrack over a fix) with the three AIM 5-3-8 entry procedures.
 *
 * Entry (AIM 5-3-8 "Entry Procedures", FIG 5-3-4): chosen from the aircraft's heading (its ground track, so a wind-corrected
 * heading does not move it across a sector boundary) relative to the inbound course when it reaches the fix. With `rel` = track minus inbound course, positive to the right, for a right-turn (standard) hold:
 *
 *     direct    -110 < rel < +70       (the 180 degree sector containing the inbound leg: fly to the fix, turn to the pattern)
 *     parallel   +70 <= rel <= +175    (approaching from the non-holding side)
 *     teardrop  -175 <= rel <= -110    (the 70 degree sector on the holding side)
 *
 * and mirrored for a left-turn hold (nonstandard: the sectors are oriented to the 70 degree line on the holding side just as
 * in the standard pattern). Within 5 degrees of the outbound heading the aircraft is already outbound: direct.
 *   direct   : over the fix turn (pattern direction) onto the outbound heading, fly the outbound leg, turn back, fly inbound.
 *   teardrop : over the fix turn outbound onto a heading 30 degrees off the outbound course toward the holding side, fly the
 *              leg (timed), then turn in the pattern direction to intercept the inbound course.
 *   parallel : over the fix fly the outbound heading parallel to the course (timed), then turn toward the HOLDING side (the
 *              direction opposite to the pattern turns, through more than 180 degrees) and return to the fix / intercept the
 *              inbound course, then fly the racetrack.
 * The inbound leg tracks the inbound COURSE (cross-track correction; the caller wind-corrects the heading), not a heading.
 * Right turns unless stated. Leg length: the stated leg (minutes or nm), else 1 minute at or below 14,000 ft and 1.5 minutes
 * above. Outbound timing starts when the ground track is within 5 degrees of the outbound (or teardrop) course. Hold speed: 170 kt for
 * jets, 90 kt for light aircraft (a simplification that keeps the pattern compact; the 180 degree turns are standard rate for
 * the type, so the racetrack is ~2 nm wide for a jet).
 *
 * Nav mode 'holding': the aircraft stays until a DIRECT_FIX / APPROACH / HEADING / RESUME_OWN_NAVIGATION clearance.
 */
import type { Aircraft, AircraftPerformance, Vec2 } from './types';
import type { AircraftRuntime, SimContext } from './context';
import { bearingDeg, clamp, dist, headingDiff, headingToVec, mToNm, nmToM, normHeading, trueToMagnetic } from './geo';
import { emitEvent, setPhase } from './context';
import { fixPosition } from './navigation';

export const HOLD_ABOVE_FT = 14000;
export const HOLD_SPEED_JET_KT = 170;
export const HOLD_SPEED_LIGHT_KT = 90;
const FIX_REACHED_M = nmToM(0.3);
const LEG_END_TOLERANCE_DEG = 5;
const TEARDROP_OFFSET_DEG = 30;

/** AIM 5-3-8 entry sector for an aircraft with `headingDeg` reaching a fix whose inbound course is `inboundDeg`. */
export function holdEntryFor(inboundDeg: number, headingDeg: number, turns: 'left' | 'right'): HoldEntry {
  let rel = headingDiff(inboundDeg, headingDeg); // + = right of the inbound course
  if (turns === 'left') rel = -rel;
  if (Math.abs(rel) > 175) return 'direct'; // already on the outbound heading
  if (rel > -110 && rel < 70) return 'direct';
  return rel >= 70 ? 'parallel' : 'teardrop';
}

export type HoldStage = 'entry' | 'turn_out' | 'outbound' | 'turn_in' | 'inbound' | 'teardrop_out' | 'par_out' | 'par_turn';
export type HoldEntry = 'direct' | 'teardrop' | 'parallel';

export interface HoldState {
  fix: string;
  fixPos: Vec2;
  /** TRUE inbound course to the fix. */
  inboundTrueDeg: number;
  turns: 'left' | 'right';
  legSec?: number;
  legM?: number;
  stage: HoldStage;
  /** Entry procedure chosen when the aircraft reached the fix. */
  entry?: HoldEntry;
  outStartSec?: number;
  outStartPos?: Vec2;
  laps: number;
  efcZulu?: string;
}

export interface PublishedHold {
  legMinutes?: number;
  legNm?: number;
  turns?: 'left' | 'right';
  /** Magnetic inbound course when the plate text states one. */
  inboundCourseMag?: number;
}

/** Parse the entry of a procedure's `holdingText` that belongs to `fixId` ("CARYL: one-minute hold 4500/2000", "RODDI 5 NM hold"). */
export function parseHoldingText(text: string | undefined, fixId: string): PublishedHold | undefined {
  if (!text) return undefined;
  const id = fixId.toUpperCase();
  const seg = text.toUpperCase().split(';').map((s) => s.trim()).find((s) => s === id || s.startsWith(`${id}:`) || s.startsWith(`${id} `));
  if (seg === undefined) return undefined;
  const out: PublishedHold = {};
  const nm = /(\d+(?:\.\d+)?)\s*-?\s*NM\b/.exec(seg);
  if (nm) out.legNm = Number(nm[1]);
  else if (/\b(?:ONE|1)[- ]MIN(?:UTE)?\b/.test(seg)) out.legMinutes = 1;
  else {
    const mn = /\b(\d(?:\.\d)?)[- ]MIN(?:UTE)?S?\b/.exec(seg);
    if (mn) out.legMinutes = Number(mn[1]);
  }
  if (/\bLEFT\b/.test(seg)) out.turns = 'left';
  const inb = /\b(\d{3})\s*(?:DEG|°)?\s*INBOUND\b/.exec(seg) ?? /\bINBOUND\s*(?:COURSE|TRACK)?\s*(\d{3})\b/.exec(seg);
  if (inb) out.inboundCourseMag = Number(inb[1]);
  return out;
}

export function holdSpeedKt(perf: AircraftPerformance): number {
  return perf.category === 'light' ? HOLD_SPEED_LIGHT_KT : Math.max(perf.minSpeedKt, HOLD_SPEED_JET_KT);
}

export interface HoldSpec {
  fix: string;
  inboundTrueDeg: number;
  turns: 'left' | 'right';
  legMinutes?: number;
  legNm?: number;
  efcZulu?: string;
  /** Where the parameters came from, and any assumption made (recorded in the INFO event). */
  source: string;
  assumption?: string;
}

/** Begin holding at `spec.fix` (direct entry). Cancels the approach clearance and any published missed approach in progress. */
export function startHold(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, spec: HoldSpec): boolean {
  const airport = ctx.state.airport;
  const fixPos = fixPosition(airport, spec.fix);
  if (!fixPos) return false;
  const legSec = spec.legNm === undefined ? (spec.legMinutes ?? (ac.altitudeFt > HOLD_ABOVE_FT ? 1.5 : 1)) * 60 : undefined;
  rt.hold = {
    fix: spec.fix, fixPos, inboundTrueDeg: normHeading(spec.inboundTrueDeg), turns: spec.turns, legSec,
    legM: spec.legNm !== undefined ? nmToM(spec.legNm) : undefined, stage: 'entry', laps: 0, efcZulu: spec.efcZulu,
  };
  rt.missed = undefined;
  rt.approach = undefined;
  rt.navBeforeVectors = undefined;
  rt.turnDirection = undefined;
  rt.navMode = 'AUTO';
  ac.target.headingDeg = undefined;
  ac.nav = { fixes: [spec.fix], index: 0, mode: 'holding' };
  if (!ac.isDeparture && (ac.phase === 'INBOUND' || ac.phase === 'APPROACH' || ac.phase === 'GO_AROUND')) setPhase(ctx, ac, 'HOLDING', `hold at ${spec.fix}`);
  const magIn = trueToMagnetic(spec.inboundTrueDeg, airport.magneticVariationDeg);
  const leg = spec.legNm !== undefined ? `${spec.legNm} nm legs` : `${(legSec ?? 60) / 60} min legs`;
  emitEvent(ctx, {
    kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
    text: `${ac.callsign} holding at ${spec.fix}: inbound course ${String(Math.round(magIn) || 360).padStart(3, '0')} magnetic, ${spec.turns} turns, ${leg} (${spec.source})${spec.assumption ? `; assumption: ${spec.assumption}` : ''}`,
    data: { hold: { fix: spec.fix, inboundCourseMag: Math.round(magIn), turns: spec.turns }, assumption: spec.assumption },
  });
  return true;
}

export interface HoldGuidance {
  /** Desired TRUE ground track (the caller applies the wind correction). */
  track: number;
  forceDir?: 'left' | 'right';
  speedKt: number;
}

/** Advance the pattern state machine one tick and return the lateral guidance. */
export function holdGuidance(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, perf: AircraftPerformance): HoldGuidance {
  const h = rt.hold!;
  const now = ctx.state.clock.timeSec;
  const inbound = h.inboundTrueDeg;
  const outbound = normHeading(inbound + 180);
  const c = headingToVec(inbound);
  const right = { x: c.y, y: -c.x };
  const rel = { x: ac.pos.x - h.fixPos.x, y: ac.pos.y - h.fixPos.y };
  const along = rel.x * c.x + rel.y * c.y;
  const cross = rel.x * right.x + rel.y * right.y;
  const speedKt = ac.target.speedKt ?? holdSpeedKt(perf);
  const atFix = dist(ac.pos, h.fixPos) <= FIX_REACHED_M;

  const dirSign = h.turns === 'right' ? 1 : -1; // + when the pattern is on the right of the inbound course
  if (h.stage === 'entry') {
    if (!atFix) return { track: bearingDeg(ac.pos, h.fixPos), speedKt };
    h.entry = holdEntryFor(inbound, ac.trackDeg, h.turns);
    h.stage = h.entry === 'direct' ? 'turn_out' : h.entry === 'teardrop' ? 'teardrop_out' : 'par_out';
    const rel = Math.round(headingDiff(inbound, ac.trackDeg) * dirSign);
    emitEvent(ctx, {
      kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
      text: `${ac.callsign} over ${h.fix}: ${h.entry} entry (track ${rel >= 0 ? '+' : ''}${rel} deg from the inbound course, ${h.turns} turns; AIM 5-3-8)`,
      data: { holdEntry: h.entry, relativeHeadingDeg: rel },
    });
  }
  const legDone = (): boolean => (h.legM !== undefined ? dist(ac.pos, h.outStartPos ?? ac.pos) >= h.legM : now - (h.outStartSec ?? now) >= (h.legSec ?? 60));
  const startLegTimer = (): void => {
    if (h.outStartSec === undefined) {
      h.outStartSec = now;
      h.outStartPos = { x: ac.pos.x, y: ac.pos.y };
    }
  };
  if (h.stage === 'turn_out') {
    if (Math.abs(headingDiff(ac.trackDeg, outbound)) >= LEG_END_TOLERANCE_DEG) return { track: outbound, forceDir: h.turns, speedKt };
    h.stage = 'outbound';
    h.outStartSec = undefined;
    startLegTimer();
    return { track: outbound, speedKt };
  }
  if (h.stage === 'teardrop_out') {
    // 30 degrees off the outbound course toward the holding side (right-turn hold: the holding side is to the left when outbound)
    const track = normHeading(outbound - TEARDROP_OFFSET_DEG * dirSign);
    if (h.outStartSec === undefined) {
      if (Math.abs(headingDiff(ac.trackDeg, track)) >= LEG_END_TOLERANCE_DEG) return { track, speedKt };
      startLegTimer();
    }
    if (!legDone()) return { track, speedKt };
    h.stage = 'turn_in';
  }
  if (h.stage === 'par_out') {
    if (h.outStartSec === undefined) {
      if (Math.abs(headingDiff(ac.trackDeg, outbound)) >= LEG_END_TOLERANCE_DEG) return { track: outbound, speedKt };
      startLegTimer();
    }
    if (!legDone()) return { track: outbound, speedKt };
    h.stage = 'par_turn';
  }
  if (h.stage === 'par_turn') {
    // toward the holding side (opposite of the pattern turns), through more than 180 degrees, back to the fix / the inbound course
    const toFix = bearingDeg(ac.pos, h.fixPos);
    if (Math.abs(headingDiff(ac.trackDeg, toFix)) >= 10) return { track: toFix, forceDir: h.turns === 'right' ? 'left' : 'right', speedKt };
    h.stage = 'inbound';
  }
  if (h.stage === 'outbound') {
    if (!legDone()) return { track: outbound, speedKt };
    h.stage = 'turn_in';
  }
  // Inbound: track the COURSE (cross-track correction, up to a 45 degree intercept toward it; the caller wind-corrects the
  // heading). The turn onto the inbound leg rolls out on this intercept track, so wind drift during the pattern is corrected.
  const gs = Math.max(ac.groundSpeedKt * 0.5144, 15);
  const gain = clamp(57.3 / (gs * 15), 0.03, 0.15);
  const inboundTrack = normHeading(inbound - clamp(cross * gain, -45, 45));
  if (h.stage === 'turn_in') {
    if (Math.abs(headingDiff(ac.trackDeg, inboundTrack)) >= LEG_END_TOLERANCE_DEG) return { track: inboundTrack, forceDir: h.turns, speedKt };
    h.stage = 'inbound';
  }
  if (along >= -FIX_REACHED_M * 0.5 || atFix) {
    h.stage = 'turn_out';
    h.outStartSec = undefined;
    h.laps++;
    return { track: outbound, forceDir: h.turns, speedKt };
  }
  return { track: inboundTrack, speedKt };
}

/** Distance (nm) from the aircraft to the hold fix (for displays / tests). */
export function distanceToHoldFixNm(ac: Aircraft, h: HoldState): number {
  return mToNm(dist(ac.pos, h.fixPos));
}
