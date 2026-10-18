/**
 * Aircraft liveries for the Tower view. Pure data and pure colour functions (no three.js, no DOM): the fuselage colour is a function
 * of the position along the fuselage (t, 0 = nose, 1 = tail) and the elevation around it (v, -1 = belly, 0 = the side, +1 = the crown),
 * which aircraftMeshes.ts samples into a small texture; the fin, tailplane, wing and engine colours are plain values.
 * Colours are approximations of the real schemes, not trademark-exact reproductions.
 */

export type FuselageStyle = 'airliner' | 'regional' | 'bizjet' | 'ga' | 'turboprop' | 'rotor' | 'fighter' | 'vehicle';

export interface LiveryBand {
  /** Elevation range around the fuselage (-1 belly .. 1 crown) and length range (0 nose .. 1 tail). */
  v0: number; v1: number; t0: number; t1: number;
  colour: number;
  /** Optional dashing along the length: [period in t, duty 0..1] (used to suggest titles and cheat-line breaks). */
  dash?: readonly [number, number];
}

export interface Livery {
  id: string;
  name: string;
  /** Upper fuselage colour and the colour below `bellyV`. */
  top: number;
  belly: number;
  bellyV: number;
  bands: readonly LiveryBand[];
  /** Colour of the tail cone aft of `tailConeT` (otherwise the fuselage colour). */
  tailCone?: number;
  tailConeT?: number;
  /** Fin colours from bottom to top as equal horizontal stripes (one entry = solid). */
  fin: readonly number[];
  tailplane: number;
  wing: number;
  engine: number;
  /** 0..1, MeshStandardMaterial metalness for the painted parts (bare-metal schemes). */
  metalness: number;
}

const WHITE = 0xf3f5f7;
const GREY = 0xcfd4da;

export const LIVERIES: Readonly<Record<string, Livery>> = {
  // Spirit (NKS): yellow throughout with black titles.
  NKS: {
    id: 'NKS', name: 'Spirit Airlines', top: 0xffd400, belly: 0xffd400, bellyV: -0.2,
    bands: [{ v0: 0.5, v1: 0.72, t0: 0.2, t1: 0.62, colour: 0x111111, dash: [0.045, 0.62] }],
    fin: [0xffd400, 0xffd400, 0x161616], tailplane: 0xf0c400, wing: 0xe8bd00, engine: 0xffd400, metalness: 0.05,
  },
  // American (AAL): bare polished aluminium, red/white/blue stripes on the fin.
  AAL: {
    id: 'AAL', name: 'American Airlines', top: 0xc7ccd2, belly: 0xb4bac1, bellyV: -0.5,
    bands: [{ v0: 0.5, v1: 0.66, t0: 0.2, t1: 0.6, colour: 0x4a5058, dash: [0.05, 0.6] }],
    fin: [0x0d3b7a, 0xf2f4f6, 0xc4162e], tailplane: 0xb9bfc6, wing: 0xaab0b8, engine: 0xb9bfc6, metalness: 0.55,
  },
  // Delta (DAL): white, dark blue belly, red and blue fin.
  DAL: {
    id: 'DAL', name: 'Delta Air Lines', top: WHITE, belly: 0x12295a, bellyV: -0.3,
    bands: [{ v0: 0.5, v1: 0.62, t0: 0.18, t1: 0.52, colour: 0x12295a, dash: [0.05, 0.6] }],
    fin: [0x12295a, 0xc01933, 0xc01933], tailplane: 0x12295a, wing: GREY, engine: 0xe4e7ea, metalness: 0.1,
  },
  // United (UAL): white over a pale grey belly, dark blue fin and engines' rear.
  UAL: {
    id: 'UAL', name: 'United Airlines', top: WHITE, belly: 0x9aa6bb, bellyV: -0.35,
    bands: [{ v0: 0.5, v1: 0.62, t0: 0.18, t1: 0.52, colour: 0x1b3d82, dash: [0.05, 0.6] }],
    tailCone: 0x1b3d82, tailConeT: 0.9,
    fin: [0x1b3d82], tailplane: 0x1b3d82, wing: GREY, engine: 0xe4e7ea, metalness: 0.1,
  },
  // JetBlue (JBU): white, blue fin with a lighter blue tailplane.
  JBU: {
    id: 'JBU', name: 'JetBlue', top: WHITE, belly: 0xe1e6ee, bellyV: -0.4,
    bands: [{ v0: 0.5, v1: 0.6, t0: 0.18, t1: 0.52, colour: 0x1f4fa8, dash: [0.05, 0.6] }],
    fin: [0x0b2f78], tailplane: 0x0b2f78, wing: GREY, engine: 0xe4e7ea, metalness: 0.1,
  },
  // Southwest (SWA): canyon blue upper fuselage, yellow and red belly bands, blue fin with red and yellow.
  SWA: {
    id: 'SWA', name: 'Southwest Airlines', top: 0x2a4cb0, belly: 0xc8202a, bellyV: -0.3,
    bands: [{ v0: -0.3, v1: -0.05, t0: 0.02, t1: 1, colour: 0xf2b705 }],
    tailCone: 0x2a4cb0, tailConeT: 0.9,
    fin: [0xf2b705, 0xc8202a, 0x2a4cb0, 0x2a4cb0], tailplane: 0x2a4cb0, wing: GREY, engine: 0x2a4cb0, metalness: 0.1,
  },
  // Frontier (FFT): white with a green fin.
  FFT: {
    id: 'FFT', name: 'Frontier Airlines', top: WHITE, belly: 0xe6ebe8, bellyV: -0.4,
    bands: [{ v0: 0.5, v1: 0.6, t0: 0.18, t1: 0.52, colour: 0x1d8f45, dash: [0.05, 0.6] }],
    fin: [0x1d8f45], tailplane: 0x1d8f45, wing: GREY, engine: 0x1d8f45, metalness: 0.1,
  },
  // Coast Guard (CGD): white upper fuselage and boom, Coast Guard red-orange lower fuselage, a blue band above it and the red-orange racing stripe on the fin.
  CGD: {
    id: 'CGD', name: 'U.S. Coast Guard', top: WHITE, belly: 0xe2401c, bellyV: -0.28,
    bands: [{ v0: -0.38, v1: -0.28, t0: 0.0, t1: 0.52, colour: 0x12295a }],
    tailCone: WHITE, tailConeT: 0.5,
    fin: [0xe2401c, 0xf3f5f7, 0xf3f5f7], tailplane: WHITE, wing: WHITE, engine: 0x3a3e44, metalness: 0.05,
  },
  // Air National Guard (ANG): F-16C in the low-visibility grey, darker nozzle.
  ANG: {
    id: 'ANG', name: 'Air National Guard', top: 0x9ca2a9, belly: 0x8e949b, bellyV: -0.1, bands: [],
    fin: [0x8b9198], tailplane: 0x868c93, wing: 0x929aa1, engine: 0x42464c, metalness: 0.15,
  },
  // Airport vehicle (APT): safety-yellow pickup with a dark lower trim.
  APT: {
    id: 'APT', name: 'Airport vehicle', top: 0xf0c000, belly: 0x2b2e33, bellyV: -0.5, bands: [],
    fin: [0xf0c000], tailplane: 0xf0c000, wing: 0xf0c000, engine: 0x2b2e33, metalness: 0.05,
  },
  // Regionals flying for the majors: white with the partner's tail.
  RPA: { id: 'RPA', name: 'Republic Airways', top: WHITE, belly: 0xe1e5ea, bellyV: -0.4, bands: [], fin: [0x1f3f75, 0xf2f4f6, 0xc4162e], tailplane: GREY, wing: GREY, engine: 0xe4e7ea, metalness: 0.1 },
  ENY: { id: 'ENY', name: 'Envoy', top: WHITE, belly: 0xe1e5ea, bellyV: -0.4, bands: [], fin: [0xc4162e, 0xf2f4f6, 0x0d3b7a], tailplane: GREY, wing: GREY, engine: 0xe4e7ea, metalness: 0.1 },
  SKW: { id: 'SKW', name: 'SkyWest', top: WHITE, belly: 0xe1e5ea, bellyV: -0.4, bands: [], fin: [0x16336d, 0x16336d, 0xc01933], tailplane: GREY, wing: GREY, engine: 0xe4e7ea, metalness: 0.1 },
};

/** Generic airline for an unknown 3-letter prefix: white with a fin colour seeded by the prefix. */
const GENERIC_FINS = [0x1f4fa8, 0x2e8b57, 0x7a3fb5, 0xc4162e, 0xd9822b, 0x138d90];

/** Cheat-line colour variants for general aviation, seeded by the registration. */
export const GA_STRIPES = [0xc8202a, 0x1f4fa8, 0x1f8a4c, 0xe07a10, 0x6a3a9a, 0x20262b, 0x138d90] as const;

function hashStr(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** `NKS451` -> `NKS`; `N723EJ`, `723EJ` and anything else without three leading letters followed by a digit -> undefined (a registration). */
export function airlinePrefix(callsign: string): string | undefined {
  const m = /^([A-Z]{3})\d/.exec(callsign.toUpperCase());
  return m ? m[1] : undefined;
}

/** The livery of an aircraft by callsign: a known airline, a generic airline paint for an unknown prefix, or a GA scheme for a registration. */
export function liveryFor(callsign: string): Livery {
  const cs = callsign.toUpperCase();
  const prefix = airlinePrefix(cs);
  if (prefix) {
    const known = LIVERIES[prefix];
    if (known) return known;
    const fin = GENERIC_FINS[hashStr(prefix) % GENERIC_FINS.length];
    return {
      id: `X-${fin.toString(16)}`, name: prefix, top: WHITE, belly: 0xe1e5ea, bellyV: -0.4,
      bands: [{ v0: 0.5, v1: 0.6, t0: 0.18, t1: 0.5, colour: fin, dash: [0.05, 0.6] }],
      fin: [fin], tailplane: fin, wing: GREY, engine: 0xe4e7ea, metalness: 0.1,
    };
  }
  const stripe = GA_STRIPES[hashStr(cs) % GA_STRIPES.length];
  const second = GA_STRIPES[(hashStr(cs) >>> 3) % GA_STRIPES.length];
  return {
    id: `GA-${stripe.toString(16)}-${second.toString(16)}`, name: 'General aviation', top: 0xf6f7f8, belly: 0xe4e7ea, bellyV: -0.55,
    bands: [
      { v0: -0.12, v1: 0.1, t0: 0.12, t1: 0.99, colour: stripe },
      { v0: -0.28, v1: -0.2, t0: 0.12, t1: 0.99, colour: second },
    ],
    fin: [stripe], tailplane: 0xe9ecee, wing: 0xf1f3f4, engine: 0xe9ecee, metalness: 0.05,
  };
}

const DARK_GLASS = 0x151a22;

export interface PaintParams {
  style: FuselageStyle;
  /** Number of passenger windows along the cabin (0 = none). */
  windows: number;
}

const inBand = (b: LiveryBand, t: number, v: number): boolean => {
  if (t < b.t0 || t > b.t1 || v < b.v0 || v > b.v1) return false;
  if (!b.dash) return true;
  return (t - b.t0) % b.dash[0] < b.dash[0] * b.dash[1];
};

/** Fuselage colour (sRGB hex) at (t along, v around). */
export function fuselagePaint(l: Livery, p: PaintParams, t: number, v: number): number {
  // Glass: cockpit windows and passenger windows draw over the paint.
  if (p.style === 'ga') {
    if (t > 0.27 && t < 0.42 && v > 0.12 && v < 0.78) return DARK_GLASS; // windscreen and door windows
    if (t >= 0.42 && t < 0.62 && v > 0.15 && v < 0.62) return DARK_GLASS;
  } else if (p.style === 'rotor') {
    if (t > 0.045 && t < 0.2 && v > 0.1 && v < 0.82) return DARK_GLASS; // windscreen
    if (t >= 0.2 && t < 0.31 && v > 0.12 && v < 0.55) return DARK_GLASS; // forward door window
    if (t >= 0.34 && t < 0.46 && v > 0.12 && v < 0.55) return DARK_GLASS; // aft cabin window
  } else if (p.style === 'fighter' || p.style === 'vehicle') {
    // no glass painted on the fuselage: canopy and windows are separate parts
  } else {
    const t0 = p.style === 'bizjet' ? 0.1 : 0.058;
    if (t > t0 && t < t0 + 0.03 && v > 0.18 && v < 0.72) return DARK_GLASS; // cockpit
    if (p.windows > 0 && t > t0 + 0.06 && t < 0.86 && v > 0.27 && v < 0.4) {
      const w = (t - (t0 + 0.06)) * p.windows;
      if (w - Math.floor(w) < 0.55) return DARK_GLASS;
    }
  }
  for (const b of l.bands) if (inBand(b, t, v)) return b.colour;
  if (l.tailCone !== undefined && t > (l.tailConeT ?? 0.9)) return l.tailCone;
  return v < l.bellyV ? l.belly : l.top;
}

/** Fin colour at a height fraction 0 (root) .. 1 (tip). */
export function finPaint(l: Livery, h: number): number {
  const i = Math.min(l.fin.length - 1, Math.max(0, Math.floor(h * l.fin.length)));
  return l.fin[i];
}
