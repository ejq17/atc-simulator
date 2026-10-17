/**
 * Approach minima from `InstrumentProcedure.minimaText` (plate transcription) and the "runway in sight" test used at the
 * decision altitude.
 *
 * Which line is used: ILS -> "S-ILS" DA; LOC -> "S-LOC" MDA; RNAV -> LPV DA, else LNAV MDA, else RNP / LNAV/VNAV DA;
 * VOR -> the straight-in "S-<rwy>" line, MDA. The first (lowest-category) values are used. HAT comes from "HAT n" or
 * the bracketed height; visibility from the bracketed "(500-7/8)" pair, else "MDA 480-1", else RVR (ft / 5280).
 * If the text is missing or cannot be interpreted the fallback is a 200 ft HAT (ILS) / 450 ft HAT (everything else) with
 * 1/2 sm / 1 sm visibility, and `assumed` says so (the caller logs an INFO event).
 *
 * Runway in sight at the decision altitude: visibility >= the charted minimum AND ceiling (lowest BKN/OVC/VV) >= HAT.
 */
import type { ApproachType, InstrumentProcedure, Weather } from './types';
import { ceilingFt } from './approach';

export interface Minima {
  kind: 'DA' | 'MDA';
  /** Decision altitude / MDA, ft MSL. */
  altFt: number;
  /** Height above touchdown zone, ft. */
  hatFt: number;
  /** Minimum visibility, statute miles. */
  visSm: number;
  /** Set when the plate text could not be used: describes the fallback. */
  assumed?: string;
  source: string;
}

export const FALLBACK_HAT_ILS_FT = 200;
export const FALLBACK_HAT_OTHER_FT = 450;

const FRACTION = /^(\d+)(?: (\d+)\/(\d+))?$|^(\d+)\/(\d+)$/;
const VIS = '(\\d+(?: \\d+\\/\\d+|\\/\\d+)?)';

function visSm(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = FRACTION.exec(s.trim());
  if (!m) return undefined;
  if (m[1] !== undefined) return Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
  return Number(m[4]) / Number(m[5]);
}

function pickSegment(segs: string[], type: Exclude<ApproachType, 'VISUAL'>): { seg: string; kind: 'DA' | 'MDA' } | undefined {
  const find = (re: RegExp) => segs.find((s) => re.test(s));
  switch (type) {
    case 'ILS': {
      const s = find(/^S-ILS\b/) ?? find(/(^|[^-A-Z])ILS\b/);
      return s ? { seg: s, kind: 'DA' } : undefined;
    }
    case 'LOC': {
      const s = find(/^S-LOC\b/) ?? find(/(^|[^-A-Z])LOC\b/);
      return s ? { seg: s, kind: 'MDA' } : undefined;
    }
    case 'RNAV': {
      const lpv = find(/^LPV\b/);
      if (lpv) return { seg: lpv, kind: 'DA' };
      const lnav = find(/^LNAV\b/);
      if (lnav) return { seg: lnav, kind: 'MDA' };
      const rnp = find(/^RNP\b/) ?? find(/^LNAV\/VNAV\b/);
      return rnp ? { seg: rnp, kind: 'DA' } : undefined;
    }
    case 'VOR': {
      const s = find(/^S-\d+/);
      return s ? { seg: s, kind: 'MDA' } : undefined;
    }
  }
}

/** Parse the straight-in minima for `type`; undefined when the text is missing or unusable. */
export function parseMinima(text: string | undefined, type: ApproachType, tdzeFt: number): Minima | undefined {
  if (!text || type === 'VISUAL') return undefined;
  const segs = text.toUpperCase().split(';').map((s) => s.trim());
  const picked = pickSegment(segs, type);
  if (!picked) return undefined;
  const { seg, kind } = picked;
  let alt: number | undefined;
  const labelled = new RegExp(`\\b${kind} (\\d+)`).exec(seg);
  if (labelled) alt = Number(labelled[1]);
  else {
    const m = /^S-[A-Z0-9]+:?\s*[A-Z0-9]*\s*(?:[A-E](?:-[A-E])?\s+)?(\d{3,4})\b/.exec(seg);
    if (m) alt = Number(m[1]);
  }
  if (alt === undefined) return undefined;
  const hatM = /\bHAT (\d+)/.exec(seg) ?? /\((\d{3})\)/.exec(seg);
  const hat = hatM ? Number(hatM[1]) : Math.max(0, alt - tdzeFt);
  const parens = new RegExp(`\\(\\d{3,4}-${VIS}\\)`).exec(seg);
  const dash = new RegExp(`\\b\\d{3,4}-${VIS}`).exec(seg);
  const rvr = /\bRVR (\d+)/.exec(seg);
  const vis = visSm(parens?.[1]) ?? visSm(dash?.[1]) ?? (rvr ? Number(rvr[1]) / 5280 : undefined) ?? (type === 'ILS' ? 0.5 : 1);
  return { kind, altFt: alt, hatFt: hat, visSm: vis, source: `${kind} ${alt} HAT ${hat} vis ${vis.toFixed(2)} sm` };
}

export function resolveMinima(proc: InstrumentProcedure | undefined, type: ApproachType, tdzeFt: number): Minima {
  const parsed = parseMinima(proc?.minimaText, type, tdzeFt);
  if (parsed) return parsed;
  const hat = type === 'ILS' ? FALLBACK_HAT_ILS_FT : FALLBACK_HAT_OTHER_FT;
  const vis = type === 'ILS' ? 0.5 : 1;
  return {
    kind: type === 'ILS' ? 'DA' : 'MDA', altFt: tdzeFt + hat, hatFt: hat, visSm: vis, source: 'fallback',
    assumed: `minima for the ${type} approach could not be read from the plate text${proc?.minimaText ? ` ("${proc.minimaText}")` : ''}; using ${hat} ft HAT and ${vis} sm`,
  };
}

/** Is the runway environment in sight at the decision altitude? */
export function runwayInSight(w: Weather, m: Minima): { inSight: boolean; why?: string } {
  if (w.visibilitySm < m.visSm) return { inSight: false, why: `visibility ${w.visibilitySm} sm is below the ${m.visSm} sm minimum` };
  const c = ceilingFt(w);
  if (c < m.hatFt) return { inSight: false, why: `ceiling ${Math.round(c)} ft is below the ${m.hatFt} ft HAT` };
  return { inSight: true };
}
