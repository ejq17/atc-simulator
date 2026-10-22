/**
 * Selection among the published runway configurations of an airport (`Airport.runwayConfigurations`, hubs only).
 *
 * Rule (FAA JO 7110.65 3-5-1 "Selecting runway", as applied by `recommendRunways` for single runways): when the wind is calm (under 5 kt, or
 * variable) the configuration the operator prefers is used, i.e. the first usable one in list order; otherwise the configuration whose
 * runways are most nearly aligned with the wind is used. Here that is the configuration whose worst arrival-runway headwind component is
 * best; headwinds within `toleranceKt` of the best are ties, and a tie goes to a configuration whose published wind sector contains the
 * wind, then to the first listed (the airport data lists them in operator-preference order). A configuration whose `maxTailwindKt` would be
 * exceeded on any of its runways is passed over unless none remains. A configuration using a closed runway end (JO 7110.65 3-3-2 / NOTAM)
 * is never selected. I could not retrieve the 3-5-1 text in this environment to quote it; the paragraph number is the one the existing
 * single-runway code already cites.
 */
import type { RunwayConfiguration, Weather } from '../sim/types';
import { headwindComponent } from './runwaySelection';
import { windMagnetic } from './metar';

export interface ConfigAirport {
  runways: readonly { ends: readonly { id: string; magneticHeadingDeg: number }[] }[];
  magneticVariationDeg: number;
}

export interface ConfigOptions {
  closedEnds?: readonly string[];
  /** Headwind differences up to this are ties. Default 1 kt (same as `recommendRunways`). */
  toleranceKt?: number;
  /** Wind below this speed is calm. Default 5 kt (JO 7110.65 3-5-1). */
  calmBelowKt?: number;
  /** Restricts the choice to configurations all of whose arrival ends (and at least one departure end) satisfy this (e.g. runway long enough for the jets in play). Ignored when it would leave none. */
  endUsable?: (endId: string) => boolean;
}

export interface ConfigScore {
  config: RunwayConfiguration;
  /** Worst (smallest) headwind component over the arrival ends, kt (negative = tailwind). */
  landingHeadwindKt: number;
  /** Worst headwind component over all ends of the configuration. */
  worstHeadwindKt: number;
  /** The published wind sector contains the magnetic wind. */
  inSector: boolean;
  /** `maxTailwindKt` exceeded on some end. */
  tailwindExceeded: boolean;
}

export interface ConfigSelection {
  config: RunwayConfiguration;
  calm: boolean;
  /** Usable configurations, best first. */
  ranking: ConfigScore[];
  summary: string;
}

const norm = (d: number): number => ((d % 360) + 360) % 360;
/** True when `dir` lies in the clockwise sector from `from` to `to` (inclusive, may wrap through north). */
export function inWindSector(dir: number, from: number, to: number): boolean {
  const f = norm(from);
  const t = norm(to);
  const d = norm(dir);
  return f <= t ? d >= f && d <= t : d >= f || d <= t;
}

const headingOf = (airport: ConfigAirport, endId: string): number | undefined => {
  for (const r of airport.runways) for (const e of r.ends) if (e.id.toUpperCase() === endId.toUpperCase()) return e.magneticHeadingDeg;
  return undefined;
};

/** Whether a configuration names any closed end. */
export function usesClosedEnd(c: { landing: readonly string[]; departing: readonly string[] }, closedEnds: readonly string[]): boolean {
  const closed = new Set(closedEnds.map((e) => e.toUpperCase()));
  return [...c.landing, ...c.departing].some((e) => closed.has(e.toUpperCase()));
}

export function scoreConfigurations(
  configs: readonly RunwayConfiguration[],
  weather: Pick<Weather, 'windDirDeg' | 'windSpeedKt' | 'windGustKt'>,
  airport: ConfigAirport,
): { scores: ConfigScore[]; calm: boolean } {
  const magDir = windMagnetic(weather, airport.magneticVariationDeg);
  const calm = magDir === 'VRB' || magDir === 0 || weather.windSpeedKt < 5;
  const speed = weather.windSpeedKt;
  const hw = (endId: string): number => {
    const h = headingOf(airport, endId);
    return typeof magDir === 'number' && magDir !== 0 && h !== undefined ? headwindComponent(magDir, speed, h) : 0;
  };
  const scores = configs.map((config) => {
    const landing = config.landing.map(hw);
    const all = [...config.landing, ...config.departing].map(hw);
    return {
      config,
      landingHeadwindKt: landing.length ? Math.min(...landing) : Math.min(...all),
      worstHeadwindKt: Math.min(...all),
      inSector: typeof magDir === 'number' && magDir !== 0 && config.windFromDeg !== undefined && config.windToDeg !== undefined && inWindSector(magDir, config.windFromDeg, config.windToDeg),
      tailwindExceeded: config.maxTailwindKt !== undefined && all.some((h) => -h > (config.maxTailwindKt as number)),
    };
  });
  return { scores, calm };
}

/** The configuration for the weather, or undefined when the airport has none usable (the caller falls back to single-runway selection). */
export function selectRunwayConfiguration(
  configs: readonly RunwayConfiguration[] | undefined,
  weather: Pick<Weather, 'windDirDeg' | 'windSpeedKt' | 'windGustKt'>,
  airport: ConfigAirport,
  options: ConfigOptions = {},
): ConfigSelection | undefined {
  if (!configs?.length) return undefined;
  const { closedEnds = [], toleranceKt = 1, endUsable } = options;
  let open = configs.filter((c) => !usesClosedEnd(c, closedEnds));
  if (endUsable) {
    const usable = open.filter((c) => c.landing.every(endUsable) && c.departing.some(endUsable));
    if (usable.length) open = usable;
  }
  if (!open.length) return undefined;
  const { scores, calm } = scoreConfigurations(open, weather, airport);
  const index = new Map(open.map((c, i) => [c.id, i]));
  let ranking: ConfigScore[];
  if (calm) {
    ranking = [...scores].sort((a, b) => index.get(a.config.id)! - index.get(b.config.id)!);
  } else {
    const ok = scores.filter((s) => !s.tailwindExceeded);
    const pool = ok.length ? ok : scores;
    const best = Math.max(...pool.map((s) => s.landingHeadwindKt));
    const tied = (s: ConfigScore): boolean => best - s.landingHeadwindKt <= toleranceKt;
    ranking = [...scores].sort((a, b) => {
      const ra = pool.includes(a) ? 0 : 1;
      const rb = pool.includes(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ta = tied(a);
      const tb = tied(b);
      if (ta !== tb) return ta ? -1 : 1;
      if (ta && tb) return Number(b.inSector) - Number(a.inSector) || index.get(a.config.id)! - index.get(b.config.id)!;
      return b.landingHeadwindKt - a.landingHeadwindKt || index.get(a.config.id)! - index.get(b.config.id)!;
    });
  }
  const top = ranking[0];
  const summary = calm
    ? `Wind calm or light: ${top.config.name}`
    : `${top.config.name}: arrival headwind ${Math.round(top.landingHeadwindKt)} kt`;
  return { config: top.config, calm, ranking, summary };
}

/** Same sets of ends (order ignored) as a configuration. */
export function sameConfiguration(a: { landing: readonly string[]; departing: readonly string[] }, b: { landing: readonly string[]; departing: readonly string[] }): boolean {
  const eq = (x: readonly string[], y: readonly string[]): boolean => x.length === y.length && x.every((e) => y.includes(e));
  return eq(a.landing, b.landing) && eq(a.departing, b.departing);
}

/**
 * Live wind: a new configuration is proposed only when the one in use is no longer among the best (within tolerance) and, in light wind,
 * only when its arrival runways have a tailwind. A configuration using a closed end is replaced whatever the wind. Mirrors `runwayChangeForWind`.
 */
export function configurationChangeForWind(
  configs: readonly RunwayConfiguration[] | undefined,
  weather: Pick<Weather, 'windDirDeg' | 'windSpeedKt' | 'windGustKt'>,
  current: { landing: readonly string[]; departing: readonly string[] },
  airport: ConfigAirport,
  options: ConfigOptions = {},
): { config: RunwayConfiguration; summary: string } | undefined {
  const sel = selectRunwayConfiguration(configs, weather, airport, options);
  if (!sel) return undefined;
  const { closedEnds = [], toleranceKt = 1 } = options;
  if (usesClosedEnd(current, closedEnds)) return { config: sel.config, summary: 'a runway in use is closed' };
  if (sameConfiguration(current, sel.config)) return undefined;
  const { scores } = scoreConfigurations([{ ...sel.config, id: '__current', landing: [...current.landing], departing: [...current.departing] }], weather, airport);
  const cur = scores[0];
  const top = sel.ranking[0];
  if (sel.calm) return cur.landingHeadwindKt >= 0 ? undefined : { config: sel.config, summary: `tailwind on the arrival runway; ${sel.config.name}` };
  if (top.landingHeadwindKt - cur.landingHeadwindKt <= toleranceKt) return undefined;
  return { config: sel.config, summary: `wind favours ${sel.config.name} (arrival headwind ${Math.round(top.landingHeadwindKt)} kt)` };
}
