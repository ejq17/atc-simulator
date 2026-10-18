/**
 * Wind component maths and runway recommendation.
 * All headings passed to the component functions must be in the SAME
 * reference (both magnetic, or both true). `recommendRunways` handles the
 * true->magnetic conversion of the stored METAR wind.
 */
import type { Weather } from '../sim/types';
import { KACY_MAGNETIC_VARIATION_DEG, windMagnetic } from './metar';

const DEG = Math.PI / 180;

/** Headwind component in knots. Negative = tailwind. */
export function headwindComponent(windDirMag: number, windKt: number, runwayHeadingMag: number): number {
  return windKt * Math.cos((windDirMag - runwayHeadingMag) * DEG);
}

/** Crosswind component magnitude in knots (always >= 0). */
export function crosswindComponent(windDirMag: number, windKt: number, runwayHeadingMag: number): number {
  return Math.abs(windKt * Math.sin((windDirMag - runwayHeadingMag) * DEG));
}

/**
 * Signed crosswind: positive when the wind comes from the RIGHT of the runway
 * heading (pilot's view), negative from the left.
 */
export function crosswindSigned(windDirMag: number, windKt: number, runwayHeadingMag: number): number {
  return windKt * Math.sin((windDirMag - runwayHeadingMag) * DEG);
}

export interface RunwayEndInput {
  id: string;
  magneticHeadingDeg: number;
}

export interface RunwayRanking {
  id: string;
  headwindKt: number;
  crosswindKt: number;
}

export interface RunwayRecommendation {
  /** Ends whose headwind is within `toleranceKt` of the best, in preference order. */
  best: string[];
  /** First of `best`. */
  primary: string;
  /** Every end, sorted best first. */
  ranking: RunwayRanking[];
  /** True when wind was calm/variable/light and the preferred order decided. */
  calmWindRule: boolean;
}

export interface RecommendOptions {
  /** Runway ids in order of preference; used for ties and calm wind. */
  preferredOrder?: string[];
  /** East-positive magnetic variation used to convert the stored TRUE wind. Default KACY (-10). */
  variationDeg?: number;
  /** Headwind differences up to this are treated as ties. Default 1 kt. */
  toleranceKt?: number;
  /** Wind below this speed (or variable) is treated as calm and uses the preferred order only. Default 5 kt (FAA JO 7110.65 3-5-1: calm wind is less than 5 knots). */
  calmBelowKt?: number;
  /** Use gust speed instead of steady speed. Default false. */
  useGusts?: boolean;
  /**
   * Runway ends that must not be picked: the ends of a closed runway (NOTAM closure, `src/sim/airportOps.ts`; JO 7110.65 3-3-2). They are
   * dropped before ranking, so they never appear in `best`, `primary` or `ranking`. Throws when nothing is left.
   */
  excludeEnds?: readonly string[];
}

/**
 * Recommend the runway end(s) with the best headwind component for the wind in
 * `weather` (TRUE wind, converted internally to magnetic).
 */
export function recommendRunways(
  weather: Pick<Weather, 'windDirDeg' | 'windSpeedKt' | 'windGustKt'>,
  runwayEndsIn: readonly RunwayEndInput[],
  options: RecommendOptions = {},
): RunwayRecommendation {
  if (runwayEndsIn.length === 0) throw new Error('recommendRunways: no runway ends supplied');
  const excluded = new Set((options.excludeEnds ?? []).map((e) => e.toUpperCase()));
  const runwayEnds = excluded.size ? runwayEndsIn.filter((r) => !excluded.has(r.id.toUpperCase())) : runwayEndsIn;
  if (runwayEnds.length === 0) throw new Error('recommendRunways: every runway end is excluded (closed)');
  const {
    preferredOrder = [],
    variationDeg = KACY_MAGNETIC_VARIATION_DEG,
    toleranceKt = 1,
    calmBelowKt = 5,
    useGusts = false,
  } = options;

  const speed = useGusts && weather.windGustKt ? weather.windGustKt : weather.windSpeedKt;
  const magDir = windMagnetic(weather, variationDeg);
  const calm = magDir === 'VRB' || magDir === 0 || speed < calmBelowKt;

  const prefRank = (id: string) => {
    const i = preferredOrder.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };

  const ranking: RunwayRanking[] = runwayEnds.map((r) => {
    if (typeof magDir !== 'number' || magDir === 0) {
      return { id: r.id, headwindKt: 0, crosswindKt: 0 };
    }
    return {
      id: r.id,
      headwindKt: headwindComponent(magDir, speed, r.magneticHeadingDeg),
      crosswindKt: crosswindComponent(magDir, speed, r.magneticHeadingDeg),
    };
  });

  const orderIndex = new Map(runwayEnds.map((r, i) => [r.id, i]));
  const tieBreak = (a: RunwayRanking, b: RunwayRanking) =>
    prefRank(a.id) - prefRank(b.id) || (orderIndex.get(a.id)! - orderIndex.get(b.id)!);

  if (calm) {
    ranking.sort(tieBreak);
    const best = ranking.map((r) => r.id);
    return { best: [ranking[0].id], primary: best[0], ranking, calmWindRule: true };
  }

  const maxHw = Math.max(...ranking.map((r) => r.headwindKt));
  ranking.sort((a, b) => {
    const aTop = maxHw - a.headwindKt <= toleranceKt;
    const bTop = maxHw - b.headwindKt <= toleranceKt;
    if (aTop && bTop) return tieBreak(a, b);
    if (aTop !== bTop) return aTop ? -1 : 1;
    return b.headwindKt - a.headwindKt;
  });
  const best = ranking.filter((r) => maxHw - r.headwindKt <= toleranceKt).map((r) => r.id);
  return { best, primary: best[0], ranking, calmWindRule: false };
}

/**
 * Runway ends in the order a calm wind (or a headwind tie) should prefer them. KACY keeps its documented operator preferences
 * (13/31 first: the longer pair); any other airport: longest runway first, ILS ends before non-ILS ends, then by end number
 * (`calm: 'high'` prefers the higher-numbered end first).
 */
export function preferredEndOrder(
  airport: { icao: string; runways: { lengthFt: number; ends: { id: string; ils?: unknown }[] }[] },
  calm: 'low' | 'high' = 'low',
): string[] {
  if (airport.icao === 'KACY') return calm === 'high' ? ['31', '13', '22', '4'] : ['13', '31', '22', '4'];
  const num = (id: string): number => parseInt(id, 10);
  return [...airport.runways]
    .sort((a, b) => b.lengthFt - a.lengthFt)
    .flatMap((r) => [...r.ends].sort((a, b) => Number(!!b.ils) - Number(!!a.ils) || (calm === 'high' ? num(b.id) - num(a.id) : num(a.id) - num(b.id))).map((e) => e.id));
}
