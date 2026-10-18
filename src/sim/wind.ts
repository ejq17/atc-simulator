/**
 * Wind: the steady (METAR) wind vector, a seeded gust model and the runway-relative components.
 *
 * GUST MODEL (design values, not measured data; there is no source for these constants):
 *  - the METAR gust spread `windGustKt - windSpeedKt` sets the amplitude;
 *  - the wind SPEED seen by an aircraft is `mean + dev`, `dev = clamp(spread / 2 * x, -GUST_LULL_FRACTION * spread, +spread)` where `x` is a
 *    unit-variance first-order Gauss-Markov (Ornstein-Uhlenbeck) process with time constant `GUST_SPEED_TAU_SEC`; peaks never exceed the
 *    reported gust, lulls never go below `mean - GUST_LULL_FRACTION * spread`;
 *  - the wind DIRECTION wanders by `clamp(sigma * y, +-2 sigma)` degrees, `sigma = min(GUST_DIR_MAX_DEG, GUST_DIR_DEG_PER_KT * spread)`, `y` an
 *    independent OU process with time constant `GUST_DIR_TAU_SEC`;
 *  - the OU output is passed through a first-order smoother (`GUST_SMOOTH_TAU_SEC`, variance restored) so that the wind changes smoothly from
 *    tick to tick instead of jumping at the 10 Hz step rate;
 *  - one process pair per aircraft (it flies through its own air), seeded from `hash(scenario seed, aircraft id)` so the result does not depend on
 *    spawn order or on what other aircraft do, and it does not consume the engine's shared random stream (all other random draws replay unchanged);
 *  - no gust (`windGustKt` absent or not above the steady speed) or calm / variable wind: exactly the steady wind, zero draws.
 */
import type { Vec2, Weather } from './types';
import { clamp, headingToVec, ktToMps, mpsToKt } from './geo';
import { hashString, mulberry32 } from './rng';
import type { Rng } from './rng';

/** Time constant (s) of the speed process: gusts last of the order of 5-15 s. Design value. */
export const GUST_SPEED_TAU_SEC = 8;
/** Time constant (s) of the direction process. Design value. */
export const GUST_DIR_TAU_SEC = 12;
/** Smoothing time constant (s) applied to the OU output (no physical meaning; keeps 0.1 s steps free of jitter). Design value. */
export const GUST_SMOOTH_TAU_SEC = 2;
/** A lull is at most this fraction of the gust spread below the steady speed. Design value. */
export const GUST_LULL_FRACTION = 0.5;
/** Direction wander: degrees of one-sigma per knot of spread, capped. Design values. */
export const GUST_DIR_DEG_PER_KT = 0.6;
export const GUST_DIR_MAX_DEG = 10;

/** Steady air mass motion vector (m/s) the METAR wind imparts; VRB is treated as calm. */
export function windVector(w: Pick<Weather, 'windDirDeg' | 'windSpeedKt'>): Vec2 {
  if (w.windDirDeg === 'VRB' || w.windSpeedKt <= 0) return { x: 0, y: 0 };
  const toward = headingToVec(w.windDirDeg + 180);
  return { x: toward.x * ktToMps(w.windSpeedKt), y: toward.y * ktToMps(w.windSpeedKt) };
}

/** Gust spread (kt) of a weather: 0 without a gust, in calm or in variable wind. */
export function gustSpreadKt(w: Pick<Weather, 'windDirDeg' | 'windSpeedKt' | 'windGustKt'>): number {
  if (w.windDirDeg === 'VRB' || w.windSpeedKt <= 0) return 0;
  return Math.max(0, (w.windGustKt ?? 0) - w.windSpeedKt);
}

export interface GustState {
  rng: Rng;
  x: number;
  y: number;
  /** Smoothed (and unit-variance) values of x and y that drive the deviations. */
  xs: number;
  ys: number;
  /** Effective wind (m/s) of the last sample. */
  wind: Vec2;
  /** Deviation from the steady wind (m/s) of the last and the previous sample. */
  dev: Vec2;
  prevDev: Vec2;
  /** Speed (kt) and direction deviation of the last sample (for tests and display). */
  devKt: number;
  devDeg: number;
}

export function newGustState(seed: number, aircraftId: string, w: Pick<Weather, 'windDirDeg' | 'windSpeedKt'>): GustState {
  const rng = mulberry32((seed ^ hashString(`gust:${aircraftId}`)) >>> 0);
  const g: GustState = { rng, x: 0, y: 0, xs: 0, ys: 0, wind: windVector(w), dev: { x: 0, y: 0 }, prevDev: { x: 0, y: 0 }, devKt: 0, devDeg: 0 };
  g.x = gauss(rng);
  g.y = gauss(rng);
  g.xs = g.x;
  g.ys = g.y;
  return g;
}

function gauss(rng: Rng): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Advance the gust state by `dt` and return the effective wind vector (m/s). Without a gust the steady vector is returned and
 * no random number is drawn.
 */
export function stepGust(state: GustState, w: Weather, dt: number): Vec2 {
  const spread = gustSpreadKt(w);
  state.prevDev = state.dev;
  if (spread <= 0) {
    state.devKt = 0;
    state.devDeg = 0;
    state.dev = { x: 0, y: 0 };
    state.wind = windVector(w);
    return state.wind;
  }
  const a = Math.exp(-dt / GUST_SPEED_TAU_SEC);
  const b = Math.exp(-dt / GUST_DIR_TAU_SEC);
  state.x = a * state.x + Math.sqrt(1 - a * a) * gauss(state.rng);
  state.y = b * state.y + Math.sqrt(1 - b * b) * gauss(state.rng);
  // smoother: stationary variance of a first-order lag of an OU process is tau1 / (tau1 + tau2); divide to restore unit variance
  const c = 1 - Math.exp(-dt / GUST_SMOOTH_TAU_SEC);
  state.xs += c * (state.x - state.xs);
  state.ys += c * (state.y - state.ys);
  const restore = 1 / Math.sqrt(GUST_SPEED_TAU_SEC / (GUST_SPEED_TAU_SEC + GUST_SMOOTH_TAU_SEC));
  const restoreDir = 1 / Math.sqrt(GUST_DIR_TAU_SEC / (GUST_DIR_TAU_SEC + GUST_SMOOTH_TAU_SEC));
  const devKt = clamp((spread / 2) * state.xs * restore, -GUST_LULL_FRACTION * spread, spread);
  const sigma = Math.min(GUST_DIR_MAX_DEG, GUST_DIR_DEG_PER_KT * spread);
  const devDeg = clamp(sigma * state.ys * restoreDir, -2 * sigma, 2 * sigma);
  const speed = Math.max(0, w.windSpeedKt + devKt);
  const dir = (w.windDirDeg as number) + devDeg;
  const toward = headingToVec(dir + 180);
  state.devKt = devKt;
  state.devDeg = devDeg;
  state.wind = { x: toward.x * ktToMps(speed), y: toward.y * ktToMps(speed) };
  const steady = windVector(w);
  state.dev = { x: state.wind.x - steady.x, y: state.wind.y - steady.y };
  return state.wind;
}

export interface WindComponents {
  /** Along-runway component (kt): positive = headwind, negative = tailwind. */
  headwindKt: number;
  /** Tailwind magnitude (kt), 0 when there is a headwind. */
  tailwindKt: number;
  /** Crosswind magnitude (kt). */
  crosswindKt: number;
  /** Which side the crosswind comes from, looking along the runway heading. */
  crosswindFrom: 'left' | 'right' | 'none';
}

/** Components of a wind vector (m/s, the direction it blows TOWARD) on a runway heading (TRUE). */
export function componentsOfVector(wind: Vec2, runwayHeadingTrue: number): WindComponents {
  const d = headingToVec(runwayHeadingTrue);
  const along = wind.x * d.x + wind.y * d.y; // + = blowing along the landing direction = tailwind
  const right = { x: d.y, y: -d.x };
  const across = wind.x * right.x + wind.y * right.y; // + = blowing toward the right = coming from the left
  const hw = -mpsToKt(along);
  const xw = mpsToKt(across);
  return {
    headwindKt: hw,
    tailwindKt: Math.max(0, -hw),
    crosswindKt: Math.abs(xw),
    crosswindFrom: Math.abs(xw) < 0.05 ? 'none' : xw > 0 ? 'left' : 'right',
  };
}

/**
 * Components of the reported wind on a runway heading (TRUE). `useGust` takes the gust speed (the worst case a pilot or controller
 * considers: the METAR gust), otherwise the steady speed.
 */
export function windComponents(w: Pick<Weather, 'windDirDeg' | 'windSpeedKt' | 'windGustKt'>, runwayHeadingTrue: number, useGust = false): WindComponents {
  const speed = useGust && w.windGustKt !== undefined ? Math.max(w.windGustKt, w.windSpeedKt) : w.windSpeedKt;
  return componentsOfVector(windVector({ windDirDeg: w.windDirDeg, windSpeedKt: speed }), runwayHeadingTrue);
}

/**
 * DESIGN DECISION (no source): the component a pilot weighs when deciding on a runway is halfway between the steady and the gust-speed
 * component, `steady + 0.5 x (gust - steady)`. The C172's 15 kt is a DEMONSTRATED value, not a limitation (POH), and judging it at the full gust
 * speed would make every Cessna refuse an ordinary 15G22 day.
 */
export const PILOT_GUST_WEIGHT = 0.5;
export function effectiveComponents(w: Pick<Weather, 'windDirDeg' | 'windSpeedKt' | 'windGustKt'>, runwayHeadingTrue: number): WindComponents {
  const a = windComponents(w, runwayHeadingTrue);
  const b = windComponents(w, runwayHeadingTrue, true);
  const mix = (x: number, y: number) => x + PILOT_GUST_WEIGHT * (y - x);
  const hw = mix(a.headwindKt, b.headwindKt);
  return { headwindKt: hw, tailwindKt: Math.max(0, -hw), crosswindKt: mix(a.crosswindKt, b.crosswindKt), crosswindFrom: b.crosswindFrom };
}

/** Does a runway-end wind exceed the type's cited limits? Undefined limits never trigger. */
export function exceedsLimits(c: WindComponents, limits: { maxCrosswindKt?: number; maxTailwindKt?: number }, marginKt = 0): string | undefined {
  if (limits.maxCrosswindKt !== undefined && c.crosswindKt > limits.maxCrosswindKt + marginKt + 1e-9) return `crosswind ${Math.round(c.crosswindKt)} knots exceeds ${limits.maxCrosswindKt}`;
  if (limits.maxTailwindKt !== undefined && c.tailwindKt > limits.maxTailwindKt + marginKt + 1e-9) return `tailwind ${Math.round(c.tailwindKt)} knots exceeds ${limits.maxTailwindKt}`;
  return undefined;
}

export interface RunwayEndWind {
  id: string;
  steady: WindComponents;
  /** Components at the METAR gust speed (equal to `steady` without a gust). */
  gust: WindComponents;
}

/** Per runway end wind components (TRUE runway headings against the TRUE METAR wind), for the Weather & Runways panel. */
export function runwayEndWinds(airport: { runways: { ends: { id: string; trueHeadingDeg: number }[] }[] }, w: Pick<Weather, 'windDirDeg' | 'windSpeedKt' | 'windGustKt'>): RunwayEndWind[] {
  return airport.runways.flatMap((r) => r.ends.map((e) => ({ id: e.id, steady: windComponents(w, e.trueHeadingDeg), gust: windComponents(w, e.trueHeadingDeg, true) })));
}
