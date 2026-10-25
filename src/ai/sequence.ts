/**
 * Landing sequence for the traffic pattern (Tower).
 *
 * Without it every pattern aircraft turned base on its own and was cleared to land from downwind, so several reached the final together and
 * went around, over and over (free-play soak, docs/PROGRESS.md "Free-play jam"). JO 7110.65 3-8-1 (sequence / spacing application) has the
 * controller sequence arrivals and gives him "EXTEND DOWNWIND" and "MAKE SHORT APPROACH" for it; 3-10-3 (same runway separation) says when the
 * runway is free for the next landing. The rule here:
 *
 *  - Everything that cannot wait (aircraft on final or base, straight-in arrivals, landings and departures using the runway) takes a time
 *    window on the runway: from its threshold crossing until it is clear (`projectArrival`), padded by `SEQ_MARGIN_SEC` (DESIGN VALUE).
 *  - Aircraft on downwind are taken in the order they reach their normal base turn. One whose window is free is left alone; one whose window
 *    is taken is told to extend its downwind, and told to turn base when a window is free again (the engine accepts "turn base now" from
 *    0.75 nm behind the threshold; that phrase is not from the order, see BEHAVIOUR-ACCURACY T15).
 *
 * Since the new-airport round the choice is also checked against the projected paths of everything else that flies (`patternPath.ts`, `pathWorld.ts`): extend, turn base
 * now, a 360 away from the runway, in the order of preference, the first that has a free window AND stays outside the simulator's near-miss alert (`sequenceDownwind`);
 * and the windows know the intersecting runways (`crossing.ts`: an arrival to a crossing runway takes the time it needs to pass the intersection, JO 7110.65 3-10-4).
 *
 * Pure functions of the simulation state (the pattern leg is read from the aircraft's heading and position).
 */
import type { Aircraft, SimulationState } from '../sim/types';
import { nmToM } from '../sim/geo';
import { alongCross } from '../sim/runways';
import type { RunwayEndGeom } from '../sim/runways';
import { projectArrival } from '../sim/runwayTiming';
import { BASE_ALONG_M, EXTEND_LIMIT_M } from '../sim/flightDynamics';
import { BASE_NOW_MIN_NM } from '../sim/towerCommands';
import { getPerformance } from '../sim/performance';
import { assignedEnd, dependentMates, dependentStaggerSec, interactingRunways } from './world';
import { baseTurnM, CIRCLE_ROLL_IN_SEC, circleDirectionFor, circleRemainingSec, extendedByController, PATH_HORIZON_SEC, patternLeg, patternProjection, sideOf } from './patternPath';
import type { Path, PatternPlan } from './patternPath';
import { CLEAR_RATIO, COMFORT_RATIO, currentPlan, defaultPaths, pathSeparation } from './pathWorld';
import type { PathConflict } from './pathWorld';
import { crossingPairClear, INTERSECTION_PASS_MARGIN_M, intersectionAlongM, intersectionPassSec } from './crossing';

/** Seconds between one aircraft being clear of the runway and the next crossing the threshold, and the other way round (DESIGN VALUE). */
export const SEQ_MARGIN_SEC = 15;
/** Lateral distance of the downwind leg from the runway (the engine's pattern geometry, flightDynamics `patternHeading`). */
const PATTERN_OFFSET_M = nmToM(0.8);
const MIN_SPEED_MPS = 50 * 0.514444;
/** A downwind aircraft closer than this to its normal base turn can no longer be told to extend (reaction time and the pilot's turn). */
const EXTEND_LAST_CHANCE_M = nmToM(0.35);

export { patternLeg } from './patternPath';
export type { PatternLeg } from './patternPath';

/** Metres behind the landing threshold (negative = past it) and lateral offset of an aircraft. */
function geometry(ac: Aircraft, g: RunwayEndGeom): { behindM: number; crossM: number } {
  const { along, cross } = alongCross(g, ac.pos);
  return { behindM: -(along - g.displacedM), crossM: Math.abs(cross) };
}

const speedMps = (ac: Aircraft): number => Math.max(ac.groundSpeedKt * 0.514444, MIN_SPEED_MPS);

export { extendedByController } from './patternPath';

/** Seconds until an aircraft on downwind crosses the threshold if it turns base where it normally does (or, past that point, now). */
export function etaNormalSec(ac: Aircraft, g: RunwayEndGeom): number {
  const { behindM } = geometry(ac, g);
  const turnM = baseTurnM(ac);
  const toTurn = Math.max(0, turnM - behindM);
  const pastTurn = behindM > turnM;
  const finalM = pastTurn ? behindM : turnM;
  return (toTurn + PATTERN_OFFSET_M + finalM) / speedMps(ac);
}

/** Seconds until it crosses the threshold if it is told to turn base as soon as that is possible. */
export function etaBaseNowSec(ac: Aircraft, g: RunwayEndGeom): number {
  const { behindM } = geometry(ac, g);
  const minM = nmToM(BASE_NOW_MIN_NM);
  const toPoint = Math.max(0, minM - behindM);
  return (toPoint + PATTERN_OFFSET_M + Math.max(behindM, minM)) / speedMps(ac);
}

/**
 * A light aircraft holds the runway at least this long (s) in a window: the rollout to the far exit of KACY 4/22 took 123-137 s in the soak (the near exit 44-54 s), and
 * the exit it takes is not known when the window is made (it depends on touchdown, wind, who stands on the stub). DESIGN VALUE.
 */
export const LIGHT_OCCUPANCY_FLOOR_SEC = 140;

const occupancyCache = new WeakMap<object, Map<string, number>>();

/**
 * Seconds an aircraft occupies the runway from the threshold crossing until it is clear: the rollout of THIS aircraft (its own exit: `projectArrival` reads the
 * exit it will fly from its parking position and the stubs), not a type average. A light aircraft that goes on to the far exit at KACY 4/22 holds the runway
 * about 123 s, one that leaves at the near exit 54 s: a window of the type average let the next aircraft turn base for a gap that the lander ahead then
 * filled (soak seed 12: "N41ZP ahead lands in 39 s and is not clear of the runway until about 162 s", a go-around for the aircraft behind).
 */
export function occupancySec(state: SimulationState, ac: Aircraft, g: RunwayEndGeom): number {
  let m = occupancyCache.get(state.airport);
  if (!m) occupancyCache.set(state.airport, (m = new Map()));
  const key = `${g.end.id}:${ac.id}:${ac.type}`;
  let v = m.get(key);
  if (v === undefined) {
    const pa = projectArrival(state, { ...ac, onGround: false, altitudeFt: g.elevationFt + 600, groundSpeedKt: 70, pos: { x: g.end.threshold.x - g.dir.x * 1500, y: g.end.threshold.y - g.dir.y * 1500 } }, g);
    v = Math.max(pa.tClear - pa.tThr, getPerformance(ac.type).category === 'light' ? LIGHT_OCCUPANCY_FLOOR_SEC : 0);
    m.set(key, v);
  }
  return v;
}

export interface SeqWindow {
  start: number;
  end: number;
  /**
   * An arrival on the adjacent final of a parallel runway (JO 7110.65 5-9-6 stagger): `start` is its threshold time, `end` the same; it does not occupy this runway, but
   * the threshold times of the two must be at least `staggerSec(slower follower)` apart (`alongNm` at the speed of whichever crosses second).
   */
  mate?: { alongNm: number; kt: number };
  /**
   * An arrival to the runway `crossRunwayId`, which intersects the runway the candidate lands on (JO 7110.65 3-10-4): `start` is its threshold time, `end` the time it has
   * passed the intersection (`crossing.ts`, the engine's figure). The candidate needs its own passing time against that runway: `crossingPairClear`.
   */
  crossRunwayId?: string;
}

/**
 * Is [start, end] free of the windows? `selfKt`: the approach speed of the aircraft being placed (for the stagger to a parallel final). `selfPassSec`: the
 * seconds the candidate needs after its threshold crossing to pass the intersection with a given runway (for the windows of arrivals on intersecting runways).
 */
const free = (windows: SeqWindow[], start: number, end: number, selfKt = 65, selfPassSec?: (runwayId: string) => number | undefined): boolean =>
  windows.every((w) => {
    if (w.mate) {
      const behindKt = start >= w.start ? selfKt : w.mate.kt;
      return Math.abs(start - w.start) >= dependentStaggerSec(w.mate.alongNm, behindKt) + SEQ_MARGIN_SEC;
    }
    if (w.crossRunwayId) {
      const mine = selfPassSec?.(w.crossRunwayId);
      if (mine !== undefined) return crossingPairClear(start, mine, w.start, w.end - w.start);
    }
    return end + SEQ_MARGIN_SEC <= w.start || start >= w.end + SEQ_MARGIN_SEC;
  });

/** Aircraft the sequencer may delay: anything flying the pattern, a fighter after its break included (3-8-1 applies to every type: "extend downwind" for the F-16 as for the Cessna, soak seed 13: 15 minutes of go-arounds). Only an overhead maneuver that has not broken yet is its own. */
export function isSequenceable(ac: Aircraft): boolean {
  return !ac.onGround && !ac.isDeparture && ac.phase === 'PATTERN' && (!ac.flags.overhead || ac.flags.overhead === 'BROKE');
}

export type SeqAction = 'ok' | 'extend' | 'hold' | 'release' | 'circle';

export interface SeqDecision {
  ac: Aircraft;
  action: SeqAction;
  etaSec: number;
  /** For `circle`: the direction of the 360s (away from the runway) and how many. */
  circleDir?: 'left' | 'right';
  circles?: number;
  /** Why the sequence did not simply let the aircraft turn base where it normally does (for the summary). */
  why?: string;
}

/**
 * The window of an airborne arrival: from its threshold crossing until it is clear. `projectArrival` measures the distance to the threshold ALONG the runway
 * axis only, which is right on final and wrong for an aircraft that is still off the extended centreline (an A320 circling at 1,800 ft over the field was
 * projected to cross the threshold "now" for 15 minutes, a phantom window that kept the pattern aircraft extending downwind, soak seed 12). Off the final the
 * threshold time is the straight distance at the aircraft's own approach speed (never earlier than the projection), the window is shifted by the difference.
 */
export function arrivalWindow(state: SimulationState, o: Aircraft, og: RunwayEndGeom): SeqWindow {
  const pa = projectArrival(state, o, og);
  const perf = getPerformance(o.type);
  const v = Math.max(perf.minSpeedKt, Math.min(Math.max(o.groundSpeedKt, 1), 1.15 * perf.approachSpeedKt)) * 0.514444;
  const direct = Math.hypot(o.pos.x - og.end.threshold.x, o.pos.y - og.end.threshold.y) / Math.max(v, 1);
  const shift = Math.max(0, direct - pa.tThr);
  return { start: pa.tThr + shift, end: pa.tClear + shift };
}

/**
 * Windows taken by everything on the runways that interact with `g` that cannot be delayed, plus `departureWindows` (seconds from now, from
 * the caller: it knows the takeoff roll model). An arrival to the same runway takes its threshold crossing until it is clear; an arrival to a runway that
 * crosses `g`'s takes its threshold crossing until it has passed the intersection (`crossing.ts`: the engine's 3-10-4 figure), and carries `crossRunwayId`.
 */
export function committedWindows(state: SimulationState, g: RunwayEndGeom, departureWindows: SeqWindow[], exceptIds: ReadonlySet<string>): SeqWindow[] {
  const rws = interactingRunways(state.airport, g.runway.id);
  const out: SeqWindow[] = [...departureWindows];
  for (const o of Object.values(state.aircraft)) {
    if (exceptIds.has(o.id) || o.isDeparture) continue;
    const og = assignedEnd(state.airport, o);
    if (!og || !rws.includes(og.runway.id)) continue;
    const sameRunway = og.runway.id === g.runway.id;
    if (o.onGround) {
      if (['LANDING', 'ROLLOUT', 'RUNWAY_EXIT'].includes(o.phase) && o.occupyingRunways.some((r) => rws.includes(r))) {
        const pa = projectArrival(state, o, og);
        if (sameRunway) out.push({ start: 0, end: pa.tClear });
        else {
          // rolling out on the crossing runway: it blocks until it has passed (or left before) the intersection
          const sInt = intersectionAlongM(state.airport, og, g.runway.id);
          const t = sInt === undefined ? pa.tClear : Math.min(pa.tClear, pa.timeAtAlong(sInt + INTERSECTION_PASS_MARGIN_M));
          if (alongCross(og, o.pos).along <= (sInt ?? Infinity) + INTERSECTION_PASS_MARGIN_M) out.push({ start: 0, end: Number.isFinite(t) ? t : pa.tClear });
        }
      }
      continue;
    }
    if (o.phase === 'GO_AROUND' || o.phase === 'HOLDING') continue;
    if (o.phase === 'PATTERN') {
      const leg = patternLeg(o, og);
      if (leg !== 'BASE' && leg !== 'FINAL') continue; // downwind aircraft are handled one by one; upwind / crosswind ones are far from landing
    }
    const w = arrivalWindow(state, o, og);
    out.push(sameRunway ? w : crossingWindow(state, o, og, g, w));
  }
  // The adjacent finals of parallel runways: an arrival there that cannot wait is a point in time this runway's arrivals must keep the stagger from.
  for (const m of dependentMates(state.airport, g)) {
    for (const o of Object.values(state.aircraft)) {
      if (exceptIds.has(o.id) || o.isDeparture || o.onGround || o.assignedRunwayEnd !== m.end.end.id || o.phase === 'GO_AROUND' || o.phase === 'HOLDING') continue;
      if (o.phase === 'PATTERN' && patternLeg(o, m.end) !== 'BASE' && patternLeg(o, m.end) !== 'FINAL') continue;
      const w = arrivalWindow(state, o, m.end);
      out.push({ start: w.start, end: w.start, mate: { alongNm: m.alongNm, kt: getPerformance(o.type).approachSpeedKt } });
    }
  }
  return out;
}

/** The window of the arrival `o` (runway end `og`, threshold window `w`) as the aircraft landing on `g`, a runway that crosses `og`'s, sees it. */
function crossingWindow(state: SimulationState, o: Aircraft, og: RunwayEndGeom, g: RunwayEndGeom, w: { start: number; end: number }): SeqWindow {
  const pass = intersectionPassSec(state.airport, o.type, og, g.runway.id);
  return pass === undefined ? w : { start: w.start, end: w.start + pass, crossRunwayId: og.runway.id };
}

/** Longest the base turn is put off in the options the sequencer weighs (s), and the step between them. DESIGN VALUES (the engine turns an extended aircraft base at 6 nm anyway). */
const EXTEND_SWEEP_MAX_SEC = 200;
const EXTEND_SWEEP_STEP_SEC = 10;
/** The most 360s for spacing one aircraft gets on a trip round the pattern. */
export const MAX_SPACING_CIRCLES = 2;

/** 360s given to this aircraft since its last go-around. */
const circlesGiven = (ac: Aircraft): number => ac.clearances.filter((c) => c.kind === 'PATTERN_INSTRUCTION' && c.destination === 'CIRCLE' && c.issuedAtSec > (ac.lastGoAroundSec ?? -1)).length;

interface SeqOption {
  plan: PatternPlan;
  action: SeqAction;
  why?: string;
  /** The kind of option (stable in time, unlike its plan: the seconds are relative to now): the previous choice is kept while an option of its kind still serves. */
  kind: string;
}

/** Seconds a choice is kept while an option of the same kind still has a free window and clears the alert (the pick must not flip from one second to the next: a transmission takes seconds to make). */
const STICKY_SEC = 60;
const sticky = new WeakMap<SimulationState, Map<string, { kind: string; sinceSec: number }>>();

const seqCache = new WeakMap<SimulationState, { tick: number; byCluster: Map<string, SeqDecision[]> }>();

/**
 * Decide for every sequenceable aircraft on downwind of `g` (see the file header). The aircraft on downwind of the runways that cross `g`'s are part of the same
 * sequence (one order by the time they reach their base turn, the windows of the earlier ones count for the later ones, 3-10-4); the decisions returned are for
 * the aircraft that land on `g`. `departureWindows` may be a function of the landing end (the windows of the departures on the runways that interact with it).
 *
 * For each aircraft in that order the options are weighed with the projected paths (`patternPath.ts`, `pathWorld.ts`): turn base where it normally does; turn base
 * now; extend and turn base at the first moment that suits (3-8-1 "extend downwind"); a 360 away from the runway (3-8-1) once or twice. The first option whose
 * threshold window is free of the other windows (3-10-3, 3-10-4) AND whose path stays outside the near-miss alert of every other airborne aircraft is taken; when
 * none has both, the first that keeps clear of the alert (a go-around for the runway is the lesser harm), else the window alone, as before.
 * `departurePaths`: the projected climb-outs of the departures waiting at the runways (the pattern traffic yields to them, 3-9-5 / 3-8-1).
 */
export function sequenceDownwind(state: SimulationState, g: RunwayEndGeom, departureWindows: SeqWindow[] | ((end: RunwayEndGeom) => SeqWindow[]), departurePaths: ReadonlyMap<string, Path> = new Map()): SeqDecision[] {
  const rws = interactingRunways(state.airport, g.runway.id);
  let cached = seqCache.get(state);
  if (!cached || cached.tick !== state.clock.tick) seqCache.set(state, (cached = { tick: state.clock.tick, byCluster: new Map() }));
  const clusterKey = [...rws].sort().join('+');
  const hit = cached.byCluster.get(clusterKey);
  if (hit) return hit.filter((d) => d.ac.assignedRunwayEnd === g.end.id);
  const depFor = (end: RunwayEndGeom): SeqWindow[] => (typeof departureWindows === 'function' ? departureWindows(end) : end.end.id === g.end.id ? departureWindows : []);
  const movable = Object.values(state.aircraft)
    .map((a) => ({ a, ge: isSequenceable(a) ? assignedEnd(state.airport, a) : undefined }))
    .filter((x): x is { a: Aircraft; ge: RunwayEndGeom } => !!x.ge && rws.includes(x.ge.runway.id) && (patternLeg(x.a, x.ge) === 'DOWNWIND' || circleRemainingSec(state, x.a) > 0))
    .sort((x, y) => etaNormalSec(x.a, x.ge) - etaNormalSec(y.a, y.ge));
  const ids = new Set(movable.map((x) => x.a.id));
  const base = new Map<string, SeqWindow[]>();
  const baseFor = (end: RunwayEndGeom): SeqWindow[] => {
    let w = base.get(end.end.id);
    if (!w) base.set(end.end.id, (w = committedWindows(state, end, depFor(end), ids)));
    return w;
  };
  const planned: { ac: Aircraft; ge: RunwayEndGeom; start: number; occ: number }[] = [];
  const windowsFor = (end: RunwayEndGeom): SeqWindow[] => {
    const out = [...baseFor(end)];
    for (const p of planned) {
      if (p.ge.runway.id === end.runway.id) out.push({ start: p.start, end: p.start + p.occ });
      else {
        const pass = intersectionPassSec(state.airport, p.ac.type, p.ge, end.runway.id);
        if (pass !== undefined) out.push({ start: p.start, end: p.start + pass, crossRunwayId: p.ge.runway.id });
      }
    }
    return out;
  };
  const paths = new Map(defaultPaths(state));
  // (the climb-out of a departure that is waiting to go, as if it were released now: the pattern traffic keeps out of it rather than holding the departure for ever)
  for (const [id, p] of departurePaths) paths.set(`dep:${id}`, p);
  const out: SeqDecision[] = [];
  for (const { a: ac, ge } of movable) {
    const windows = windowsFor(ge);
    const occ = occupancySec(state, ac, ge);
    const kt = getPerformance(ac.type).approachSpeedKt;
    const pass = (rid: string): number | undefined => intersectionPassSec(state.airport, ac.type, ge, rid);
    const { behindM } = geometry(ac, ge);
    const extended = extendedByController(ac) || behindM > baseTurnM(ac);
    const side = sideOf(state, ac, ge, 'DOWNWIND');
    const take = (start: number, path?: Path): void => { planned.push({ ac, ge, start, occ }); if (path) paths.set(ac.id, path); };
    if (circleRemainingSec(state, ac) > 0) {
      // in the middle of a 360: nothing to decide, its window is where the turn ends
      const pr = patternProjection(state, ac, ge, currentPlan(state, ac));
      if (pr.thresholdSec !== Infinity) take(pr.thresholdSec, pr.path);
      continue;
    }
    // the options, most preferred first
    const options: SeqOption[] = [];
    if (!extended) options.push({ plan: {}, action: 'ok', kind: 'normal' });
    else if (behindM >= nmToM(BASE_NOW_MIN_NM) + nmToM(0.1)) options.push({ plan: { extend: true, baseAtSec: 0 }, action: 'release', kind: 'base-now' });
    const canExtend = !extended && behindM < baseTurnM(ac) - EXTEND_LAST_CHANCE_M && behindM < EXTEND_LIMIT_M;
    if (!extended && behindM >= nmToM(BASE_NOW_MIN_NM) + nmToM(0.1)) options.push({ plan: { baseAtSec: 0 }, action: 'release', why: 'turn base now', kind: 'base-now' });
    if (canExtend || extended) {
      for (let T = extended ? EXTEND_SWEEP_STEP_SEC : EXTEND_SWEEP_STEP_SEC; T <= EXTEND_SWEEP_MAX_SEC; T += EXTEND_SWEEP_STEP_SEC) {
        options.push({ plan: { extend: true, baseAtSec: T }, action: extended ? 'hold' : 'extend', kind: 'extend' });
      }
    }
    if (circlesGiven(ac) < MAX_SPACING_CIRCLES) {
      const circleSec = 360 / Math.max(1, getPerformance(ac.type).turnRateDegPerSec) + CIRCLE_ROLL_IN_SEC;
      for (let n = 1; n <= MAX_SPACING_CIRCLES - circlesGiven(ac); n++) {
        const dir = circleDirectionFor(side);
        if (!extended) options.push({ plan: { circles: n, circleDir: dir }, action: 'circle', why: `${n} x 360`, kind: 'circle' });
        // ... and the base turn put off a little more after the turns, when the sequence needs it (the aircraft is then told to turn base, the extension of the engine
        // stays in effect for it after the turn)
        for (let k = 0; k <= 8; k++) options.push({ plan: { circles: n, circleDir: dir, extend: true, baseAtSec: Math.ceil(n * circleSec) + k * EXTEND_SWEEP_STEP_SEC }, action: 'circle', why: `${n} x 360, then base`, kind: 'circle-base' });
      }
    }
    interface Evaluated { opt: SeqOption; thr: number; path: Path; windowFree: boolean; conflict?: PathConflict; ratio: number }
    const evaluated: Evaluated[] = [];
    let chosen: Evaluated | undefined;
    let pathOnly: Evaluated | undefined;
    let windowAndClear: Evaluated | undefined;
    for (const opt of options) {
      const pr = patternProjection(state, ac, ge, opt.plan, PATH_HORIZON_SEC);
      if (pr.thresholdSec === Infinity) continue;
      const thr = pr.thresholdSec;
      const ev: Evaluated = { opt, thr, path: pr.path, windowFree: free(windows, thr, thr + occ, kt, pass), ratio: Infinity };
      // (a fighter's overhead pattern is not modelled by the projection: its windows alone decide, as before)
      ev.conflict = getPerformance(ac.type).military && !getPerformance(ac.type).craft ? undefined : pathSeparation(state, ac.id, pr.path, paths);
      ev.ratio = ev.conflict?.ratio ?? Infinity;
      evaluated.push(ev);
      if (ev.windowFree && ev.ratio >= COMFORT_RATIO) { chosen = ev; break; }
      if (ev.windowFree && ev.ratio >= CLEAR_RATIO) windowAndClear ??= ev;
      if (ev.ratio >= COMFORT_RATIO) pathOnly ??= ev;
    }
    const bestBy = (list: Evaluated[]): Evaluated | undefined => list.reduce<Evaluated | undefined>((b, e) => (!b || e.ratio > b.ratio ? e : b), undefined);
    // (no option is clear of the alert by the margin: the one that comes closest to clearing it, among those that also suit the runway, else among all)
    let memo = sticky.get(state);
    if (!memo) sticky.set(state, (memo = new Map()));
    const prev = memo.get(ac.id);
    const keep = prev && state.clock.timeSec - prev.sinceSec < STICKY_SEC ? evaluated.find((e) => e.opt.kind === prev.kind && e.windowFree && e.ratio >= CLEAR_RATIO) : undefined;
    const pick = chosen ?? keep ?? windowAndClear ?? pathOnly ?? bestBy(evaluated.filter((e) => e.windowFree)) ?? bestBy(evaluated);
    if (pick && (!prev || prev.kind !== pick.opt.kind || state.clock.timeSec - prev.sinceSec >= STICKY_SEC)) memo.set(ac.id, { kind: pick.opt.kind, sinceSec: state.clock.timeSec });
    if (pick) {
      take(pick.thr, pick.path);
      out.push({ ac, action: pick.opt.action, etaSec: pick.thr, ...(pick.opt.action === 'circle' ? { circleDir: pick.opt.plan.circleDir, circles: pick.opt.plan.circles ?? 1 } : {}), ...(pick.opt.why ? { why: pick.opt.why } : {}) });
      continue;
    }
    // Nothing keeps clear of the alert: the window rule alone (the earlier behaviour).
    const eNormal = etaNormalSec(ac, ge);
    const eNow = etaBaseNowSec(ac, ge);
    const okWindow = (e: number): boolean => free(windows, e, e + occ, kt, pass);
    if (!extended && okWindow(eNormal)) { take(eNormal); out.push({ ac, action: 'ok', etaSec: eNormal }); continue; }
    if (extended && okWindow(eNow)) { take(eNow); out.push({ ac, action: behindM >= nmToM(BASE_NOW_MIN_NM) + nmToM(0.1) ? 'release' : 'hold', etaSec: eNow }); continue; }
    if (!extended && !canExtend) { take(eNormal); out.push({ ac, action: 'ok', etaSec: eNormal }); } else out.push({ ac, action: extended ? 'hold' : 'extend', etaSec: eNow });
  }
  cached.byCluster.set(clusterKey, out);
  return out.filter((d) => d.ac.assignedRunwayEnd === g.end.id);
}

/** An aircraft on downwind within half a mile of its normal base turn (or already past it): it counts as traffic for a departure. */
export function turnsBaseSoon(ac: Aircraft, g: RunwayEndGeom): boolean {
  return geometry(ac, g).behindM > BASE_ALONG_M - nmToM(0.5);
}
