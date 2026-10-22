/**
 * Published missed approach: a small deterministic interpreter for the plate text transcribed in
 * `InstrumentProcedure.missedApproachText`, and the guidance that flies it.
 *
 * Grammar (case-insensitive, the forms used at KACY; each form is covered by a test with the verbatim text):
 *
 *   [Climb to <alt> then] climbing (left|right) turn to <alt> <legs> and hold.
 *   Climb to <alt> <legs> and hold.
 *   legs := leg (and leg)*
 *   leg  := (via|on) heading <deg> deg
 *         | (via|on) track <deg> deg to <FIX>
 *         | direct <FIX>
 *         | (via|on) <NAVAID> [VORTAC|VOR] R-<radial> to <FIX> [INT][/<NAVAID> <n> DME | /<n> DME]
 *
 * Model: climb straight ahead on the runway heading to the first altitude (or 400 ft above the field if none is stated),
 * then turn in the stated direction and fly the legs in order: a heading is flown until the next radial can be intercepted;
 * a radial leg means intercept the radial from the named navaid and track it outbound to the fix; `direct` and `track ... to`
 * fly to the fix (the stated track is the arrival course); the aircraft climbs to the final altitude throughout and then
 * enters the hold at the last fix (`holding.ts`). Headings, tracks and radials are MAGNETIC.
 *
 * Anything else is "not interpreted": the caller falls back to the plain go-around (runway heading, fixed altitude) and logs
 * an INFO event.
 */
import type { Aircraft, AircraftPerformance, Airport, InstrumentProcedure, Vec2 } from './types';
import type { AircraftRuntime, ApproachRuntime, SimContext } from './context';
import { bearingDeg, clamp, dist, headingDiff, magneticToTrue, nmToM, normHeading, trueToMagnetic, headingToVec } from './geo';
import { emitEvent } from './context';
import { findNavFix, turnLeadM } from './navigation';
import { parseHoldingText, startHold } from './holding';
import type { PublishedHold } from './holding';
import type { RunwayEndGeom } from './runways';
import { normalizeRunwayEndId } from './runways';

export type MissedLeg =
  | { kind: 'heading'; headingMag: number }
  | { kind: 'radial'; navaid: string; radialMag: number; toFix: string }
  | { kind: 'direct'; fix: string }
  | { kind: 'track'; trackMag: number; toFix: string };

export interface MissedApproachPlan {
  text: string;
  /** Climb straight ahead to this altitude before turning (undefined: 400 ft above the field). */
  initialAltitudeFt?: number;
  turn?: 'left' | 'right';
  finalAltitudeFt: number;
  legs: MissedLeg[];
  holdFix: string;
}

function parseLeg(raw: string): MissedLeg | undefined {
  // "CON VOR/DME R-154 to KHRIS/CON 21.3 DME": the navaid type word (VOR/DME) is not a distance-fix suffix; only "FIX INT/ACY 11 DME" style tails are cut
  let c = raw.trim().replace(/\bVOR\/DME\b/g, 'VOR').replace(/(?: INT)?\/.*$/, '').replace(/^(?:VIA|ON) /, '').trim();
  let m = /^HEADING (\d{1,3}) DEG$/.exec(c);
  if (m) return { kind: 'heading', headingMag: Number(m[1]) };
  m = /^TRACK (\d{1,3}) DEG TO ([A-Z0-9]{3,5})$/.exec(c);
  if (m) return { kind: 'track', trackMag: Number(m[1]), toFix: m[2] };
  m = /^DIRECT ([A-Z0-9]{3,5})$/.exec(c);
  if (m) return { kind: 'direct', fix: m[1] };
  c = c.replace(/^([A-Z0-9]{2,5}) (?:VORTAC|VOR\/DME|VOR|TACAN) /, '$1 ');
  m = /^([A-Z0-9]{2,5}) R-?(\d{1,3}) TO ([A-Z0-9]{3,5})(?: INT)?$/.exec(c);
  if (m) return { kind: 'radial', navaid: m[1], radialMag: Number(m[2]), toFix: m[3] };
  return undefined;
}

export function legFix(l: MissedLeg): string | undefined {
  return l.kind === 'direct' ? l.fix : l.kind === 'heading' ? undefined : l.toFix;
}

/** Interpret a missed approach text; undefined when it is not one of the supported forms. */
export function parseMissedApproach(text: string | undefined): MissedApproachPlan | undefined {
  if (!text) return undefined;
  const t = text.toUpperCase().replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  let initial: number | undefined;
  let turn: 'left' | 'right' | undefined;
  let finalAlt: number;
  let rest: string;
  let m = /^CLIMB TO (\d+) THEN CLIMBING (LEFT|RIGHT) TURN TO (\d+) (.+) AND HOLD$/.exec(t);
  if (m) {
    initial = Number(m[1]);
    turn = m[2].toLowerCase() as 'left' | 'right';
    finalAlt = Number(m[3]);
    rest = m[4];
  } else if ((m = /^CLIMBING (LEFT|RIGHT) TURN TO (\d+) (.+) AND HOLD$/.exec(t))) {
    turn = m[1].toLowerCase() as 'left' | 'right';
    finalAlt = Number(m[2]);
    rest = m[3];
  } else if ((m = /^CLIMB TO (\d+) (.+) AND HOLD$/.exec(t))) {
    finalAlt = Number(m[1]);
    rest = m[2];
  } else return undefined;
  const legs: MissedLeg[] = [];
  for (const clause of rest.split(' AND ')) {
    const leg = parseLeg(clause);
    if (!leg) return undefined;
    legs.push(leg);
  }
  const holdFix = [...legs].reverse().map(legFix).find((f) => !!f);
  if (!legs.length || !holdFix || legFix(legs[legs.length - 1]) === undefined) return undefined;
  if (initial !== undefined && initial > finalAlt) return undefined;
  return { text, initialAltitudeFt: initial, turn, finalAltitudeFt: finalAlt, legs, holdFix };
}

/** Procedure whose published missed approach applies: the cleared approach, else an IAP of the runway end. */
function missedProcedure(airport: Airport, approach: ApproachRuntime | undefined, g: RunwayEndGeom | undefined): InstrumentProcedure | undefined {
  if (approach?.procedureId) {
    const p = airport.procedures.find((x) => x.id === approach.procedureId);
    if (p) return p;
  }
  const end = g ? normalizeRunwayEndId(g.end.id) : undefined;
  const iaps = airport.procedures.filter((p) => p.type === 'IAP' && !!p.runwayEnd && normalizeRunwayEndId(p.runwayEnd) === end && !/\bCOPTER\b/i.test(p.name));
  return iaps.find((p) => parseMissedApproach(p.missedApproachText)) ?? iaps[0];
}

/**
 * The published missed approach climb altitude (ft) of the cleared / applicable procedure: the structured plate transcription
 * (`InstrumentProcedure.missedApproach`), else the altitude parsed from `missedApproachText`; undefined when the dataset has neither.
 */
export function publishedMissedAltitudeFt(airport: Airport, approach: ApproachRuntime | undefined, g: RunwayEndGeom | undefined): number | undefined {
  const proc = missedProcedure(airport, approach, g);
  return proc?.missedApproach?.finalAltitudeFt ?? parseMissedApproach(proc?.missedApproachText)?.finalAltitudeFt;
}

/** Magnetic inbound course of a fix that some procedure defines on a radial ("SMITS on ACY R-090" -> 270). */
export function inboundFromRadials(airport: Airport, fix: string): { inboundMag: number; source: string } | undefined {
  for (const p of airport.procedures) {
    const plan = parseMissedApproach(p.missedApproachText);
    const leg = plan?.legs.find((l) => l.kind === 'radial' && l.toFix === fix.toUpperCase());
    if (leg && leg.kind === 'radial') return { inboundMag: (leg.radialMag + 180) % 360, source: `${leg.navaid} R-${String(leg.radialMag).padStart(3, '0')} (${p.name})` };
  }
  return undefined;
}

export interface PublishedPattern {
  fix: string;
  /** Magnetic inbound course read from the plate depiction. */
  inboundCourseMag: number;
  turns: 'left' | 'right';
  legNm?: number;
  legMinutes?: number;
  role: string;
  procedureId: string;
  procedureName: string;
}

/**
 * The charted holding pattern at `fix` (`InstrumentProcedure.holdingPatterns[]`, transcribed from the plates): the first source for
 * "as published" holds and missed-approach holds, before `holdingText` and before any assumption. The pattern of the preferred
 * procedure wins, then the first procedure that charts one at that fix.
 */
export function publishedPatternFor(airport: Airport, fix: string, preferProcedureId?: string): PublishedPattern | undefined {
  const up = fix.toUpperCase();
  const procs = [...airport.procedures].sort((a, b) => (a.id === preferProcedureId ? -1 : 0) - (b.id === preferProcedureId ? -1 : 0));
  for (const p of procs) {
    const hp = p.holdingPatterns?.find((h) => h.fix.toUpperCase() === up && Number.isFinite(h.inboundCourseDeg));
    if (hp) {
      return { fix: up, inboundCourseMag: hp.inboundCourseDeg, turns: hp.turns, legNm: hp.legNm, legMinutes: hp.legMinutes, role: hp.role, procedureId: p.id, procedureName: p.name };
    }
  }
  return undefined;
}

/** Published hold at a fix: the charted pattern first, then leg length / turns / course from `holdingText`, the inbound course from a radial definition. */
export function publishedHoldFor(airport: Airport, fix: string, preferProcedureId?: string): { hold: PublishedHold; inboundSource?: string; source: string } | undefined {
  const chart = publishedPatternFor(airport, fix, preferProcedureId);
  if (chart) {
    return {
      hold: { inboundCourseMag: chart.inboundCourseMag, turns: chart.turns, legNm: chart.legNm, legMinutes: chart.legMinutes },
      inboundSource: `${chart.procedureName} holding pattern`,
      source: `${chart.procedureName} charted holding pattern`,
    };
  }
  const procs = [...airport.procedures].sort((a, b) => (a.id === preferProcedureId ? -1 : 0) - (b.id === preferProcedureId ? -1 : 0));
  let hold: PublishedHold | undefined;
  let source = '';
  for (const p of procs) {
    const h = parseHoldingText(p.holdingText, fix);
    if (h) {
      hold = h;
      source = `${p.name} holding text`;
      break;
    }
  }
  const radial = inboundFromRadials(airport, fix);
  if (!hold && !radial) {
    for (const p of procs) {
      if (parseMissedApproach(p.missedApproachText)?.holdFix === fix.toUpperCase()) {
        hold = {};
        source = `${p.name} missed approach`;
        break;
      }
    }
  }
  if (!hold && !radial) return undefined;
  const out: PublishedHold = { ...hold };
  if (radial && out.inboundCourseMag === undefined) out.inboundCourseMag = radial.inboundMag;
  return { hold: out, inboundSource: radial?.source, source: source || 'procedure' };
}

export interface MissedState {
  plan: MissedApproachPlan;
  procedureId: string;
  stage: 'straight' | 'legs';
  leg: number;
  /** TRUE runway heading flown straight ahead. */
  runwayHeadingTrue: number;
  turnPending?: 'left' | 'right';
  /** Where the current leg started (arrival course assumption for `direct` legs). */
  legStart: Vec2;
  /** Fix identifiers of the legs, as exposed in `Aircraft.nav.fixes`. */
  fixIds: string[];
}

/** Start the published missed approach. False (with an INFO event) when it cannot be interpreted: the caller falls back. */
export function startPublishedMissed(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, g: RunwayEndGeom | undefined, approach: ApproachRuntime | undefined): boolean {
  const airport = ctx.state.airport;
  const info = (text: string) =>
    emitEvent(ctx, { kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'warning', speaker: 'SYSTEM', text, data: { missedApproach: 'fallback' } });
  if (!g || !(ac.flightPlan?.flightRules === 'IFR' || approach)) return false;
  const proc = missedProcedure(airport, approach, g);
  if (!proc) return false;
  const plan = parseMissedApproach(proc.missedApproachText);
  if (!plan) {
    info(`${ac.callsign}: the published missed approach for ${proc.name} could not be interpreted${proc.missedApproachText ? ` ("${proc.missedApproachText}")` : ' (no text in the airport data)'}; flying runway heading to a fixed altitude instead.`);
    return false;
  }
  const fixIds = plan.legs.map(legFix).filter((f): f is string => !!f);
  const missing = [...fixIds, ...plan.legs.filter((l) => l.kind === 'radial').map((l) => (l as { navaid: string }).navaid)].filter((f) => !findNavFix(airport, f));
  if (missing.length) {
    info(`${ac.callsign}: the published missed approach for ${proc.name} could not be interpreted (unknown fix ${missing.join(', ')}); flying runway heading to a fixed altitude instead.`);
    return false;
  }
  rt.missed = { plan, procedureId: proc.id, stage: 'straight', leg: 0, runwayHeadingTrue: g.headingDeg, turnPending: plan.turn, legStart: { x: ac.pos.x, y: ac.pos.y }, fixIds };
  ac.nav = { fixes: fixIds, index: 0, mode: 'missed' };
  ac.target.altitudeFt = Math.max(plan.finalAltitudeFt, Math.floor(ac.altitudeFt / 100) * 100);
  emitEvent(ctx, {
    kind: 'INFO', aircraftId: ac.id, callsign: ac.callsign, severity: 'info', speaker: 'SYSTEM',
    text: `${ac.callsign} flying the published missed approach (${proc.name}): ${plan.text}`, data: { missedApproach: 'published', procedureId: proc.id },
  });
  return true;
}

export interface MissedGuidance {
  track: number;
  forceDir?: 'left' | 'right';
  speedKt: number;
}

const radialCourse = (airport: Airport, navaid: string, radialMag: number): { origin: Vec2; courseTrue: number } => ({
  origin: findNavFix(airport, navaid)!.pos,
  courseTrue: magneticToTrue(radialMag, airport.magneticVariationDeg),
});

function crossAlong(origin: Vec2, courseTrue: number, p: Vec2): { along: number; cross: number } {
  const c = headingToVec(courseTrue);
  const rel = { x: p.x - origin.x, y: p.y - origin.y };
  return { along: rel.x * c.x + rel.y * c.y, cross: rel.x * c.y - rel.y * c.x };
}

/** Lateral guidance for the missed approach; hands over to the hold after the last leg. */
export function missedGuidance(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, perf: AircraftPerformance): MissedGuidance {
  const airport = ctx.state.airport;
  const st = rt.missed!;
  const speedKt = ac.target.speedKt ?? perf.climbSpeedKt;
  if (st.stage === 'straight') {
    const turnAlt = st.plan.initialAltitudeFt ?? airport.elevationFt + 400;
    if (ac.altitudeFt < turnAlt - 1) return { track: st.runwayHeadingTrue, speedKt };
    st.stage = 'legs';
    st.legStart = { x: ac.pos.x, y: ac.pos.y };
  }
  for (let guard = 0; guard < 4; guard++) {
    const leg = st.plan.legs[st.leg];
    if (!leg) return finishMissed(ctx, ac, rt, st, speedKt);
    const next = st.plan.legs[st.leg + 1];
    let track: number | undefined;
    let advance = false;
    if (leg.kind === 'heading') {
      track = magneticToTrue(leg.headingMag, airport.magneticVariationDeg);
      if (next && next.kind === 'radial') {
        const { origin, courseTrue } = radialCourse(airport, next.navaid, next.radialMag);
        const { cross } = crossAlong(origin, courseTrue, ac.pos);
        const delta = Math.abs(headingDiff(ac.headingDeg, courseTrue));
        const toIntersect = Math.abs(cross) / Math.max(Math.sin((delta * Math.PI) / 180), 0.05);
        advance = Math.abs(cross) < nmToM(0.3) || toIntersect <= turnLeadM(ac, perf, delta);
      } else advance = !next; // a heading with nothing after it cannot end the missed approach
    } else if (leg.kind === 'radial') {
      const { origin, courseTrue } = radialCourse(airport, leg.navaid, leg.radialMag);
      const { along, cross } = crossAlong(origin, courseTrue, ac.pos);
      const fixAlong = crossAlong(origin, courseTrue, findNavFix(airport, leg.toFix)!.pos).along;
      const gs = Math.max(ac.groundSpeedKt * 0.5144, 15);
      const ang = clamp(cross * clamp(57.3 / (gs * 15), 0.03, 0.15), -45, 45);
      track = normHeading(courseTrue - ang);
      advance = along >= fixAlong - nmToM(0.3);
    } else {
      const fix = leg.kind === 'direct' ? leg.fix : leg.toFix;
      const p = findNavFix(airport, fix)!.pos;
      track = bearingDeg(ac.pos, p);
      const nextFix = next ? legFix(next) : undefined;
      const nextPos = nextFix ? findNavFix(airport, nextFix)?.pos : undefined;
      const turn = nextPos ? Math.abs(headingDiff(track, bearingDeg(p, nextPos))) : 0;
      advance = dist(ac.pos, p) <= turnLeadM(ac, perf, turn);
    }
    if (!advance) {
      if (st.turnPending) {
        // The stated turn direction is flown unless it would mean an absurd loop (> 200 degrees): then the short way round is taken.
        const err = headingDiff(ac.headingDeg, track);
        const amount = st.turnPending === 'right' ? (err >= 0 ? err : 360 + err) : err <= 0 ? -err : 360 - err;
        if (Math.abs(err) < 3 || amount > 200) st.turnPending = undefined;
      }
      const fixId = legFix(leg);
      if (fixId) ac.nav = { fixes: st.fixIds, index: Math.max(0, st.fixIds.indexOf(fixId)), mode: 'missed' };
      return { track, forceDir: st.turnPending, speedKt };
    }
    st.leg++;
    st.legStart = { x: ac.pos.x, y: ac.pos.y };
  }
  return { track: ac.headingDeg, speedKt };
}

/** The last leg is flown out: enter the hold at the named fix. */
function finishMissed(ctx: SimContext, ac: Aircraft, rt: AircraftRuntime, st: MissedState, speedKt: number): MissedGuidance {
  const airport = ctx.state.airport;
  const plan = st.plan;
  const fix = plan.holdFix;
  const last = plan.legs[plan.legs.length - 1];
  const proc = airport.procedures.find((p) => p.id === st.procedureId);
  const chart = publishedPatternFor(airport, fix, st.procedureId);
  const stated = chart
    ? ({ inboundCourseMag: chart.inboundCourseMag, turns: chart.turns, legNm: chart.legNm, legMinutes: chart.legMinutes } as PublishedHold)
    : parseHoldingText(proc?.holdingText, fix);
  const pub = stated ?? publishedHoldFor(airport, fix, st.procedureId)?.hold;
  const radialIn = inboundFromRadials(airport, fix);
  let inboundMag: number;
  let assumption: string | undefined;
  const fixPos = findNavFix(airport, fix)!.pos;
  if (stated?.inboundCourseMag !== undefined) {
    inboundMag = stated.inboundCourseMag;
  } else if (last.kind === 'radial') {
    inboundMag = (last.radialMag + 180) % 360;
    assumption = `inbound course ${String(inboundMag).padStart(3, '0')} = reciprocal of ${last.navaid} R-${String(last.radialMag).padStart(3, '0')} (inbound course not transcribed)`;
  } else if (radialIn) {
    inboundMag = radialIn.inboundMag;
    assumption = `inbound course ${String(inboundMag).padStart(3, '0')} taken from ${radialIn.source}, where ${fix} is defined on a radial (not transcribed for this procedure)`;
  } else if (last.kind === 'track') {
    inboundMag = last.trackMag;
    assumption = `inbound course ${String(last.trackMag).padStart(3, '0')} = the track flown to ${fix} (inbound course not transcribed)`;
  } else {
    inboundMag = Math.round(trueToMagnetic(bearingDeg(st.legStart, fixPos), airport.magneticVariationDeg)) % 360;
    assumption = `inbound course ${String(inboundMag).padStart(3, '0')} = the course from where the leg to ${fix} started (inbound course not transcribed)`;
  }
  const spec = {
    fix, inboundTrueDeg: magneticToTrue(inboundMag, airport.magneticVariationDeg), turns: pub?.turns ?? 'right',
    legMinutes: pub?.legMinutes, legNm: pub?.legNm, source: chart ? `charted holding pattern, ${chart.procedureName}` : 'published missed approach', assumption,
  } as const;
  startHold(ctx, ac, rt, { ...spec });
  return { track: bearingDeg(ac.pos, fixPos), speedKt };
}
