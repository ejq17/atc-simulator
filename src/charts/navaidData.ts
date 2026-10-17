/**
 * Typed accessors over data/sources/<icao>-navaids.json (NASR 2026-10-01 +
 * d-TPP 2610 plate readings). Display-only; nothing is derived except the
 * great-circle distance/bearing from the airport's own navaid (ACY VORTAC,
 * MHT DME), which is labelled as computed in the UI.
 */
import rawNavaids from '../../data/sources/kacy-navaids.json';
import rawKmhtNavaids from '../../data/sources/kmht-navaids.json';

export interface Vortac {
  id: string;
  type: string;
  name: string;
  status: string;
  freqMhz: number;
  channel: string;
  lat: number;
  lon: number;
  elevFt: number;
  magVar?: string;
  magVarEpoch?: string;
  hours?: string;
  remarks: string[];
  locationNote: string;
}

export interface IlsSystem {
  runway: string;
  plateIdent: string;
  category: string;
  freqMhz: number;
  dmeChannel: string;
  frontCourseMag: number;
  gsAngleDeg: number;
  gsFreqMhz: number;
  status: string;
  approachLighting: string;
  minima: string;
  tdzePlateFt: number;
}

export interface NearbyNavaid {
  id: string;
  type: string;
  name: string;
  status: string;
  freqMhz: string;
  channel: string;
  lat: number;
  lon: number;
  /** Computed from NASR coordinates, not an FAA-published figure. */
  distanceNmFromAcy: number;
  bearingTrueFromAcy: number;
}

export interface ApproachFix {
  id: string;
  lat: number;
  lon: number;
  roles: Array<{ procedure: string; role: string }>;
  reference: string[];
  key: boolean;
}

export interface NavaidDataset {
  /** The airport's own navaid (KACY: the ACY VORTAC; KMHT: the MHT DME). */
  vortac: Vortac;
  /** FAA id used in the UI labels ("ACY", "MHT"). */
  faaId: string;
  icao: string;
  /** Fixes shown by default (final approach fixes, intermediate fixes and missed-approach holds). */
  keyFixIds: readonly string[];
  /** Sentence about the runways without an ILS. */
  noIlsNote: string;
  ils: IlsSystem[];
  runwaysWithoutIls: string[];
  ilsNote: string;
  nearby: NearbyNavaid[];
  fixes: ApproachFix[];
  provenance: { sources: string[]; retrieved: string; cycle: string };
  unverified: string[];
}

// minimal structural view of the JSON
interface RawFix {
  id: string;
  lat: number;
  lon: number;
  roles_on_kacy_plates?: Record<string, string | null>;
  roles_on_plates?: Record<string, string | null>;
  reference_navaid_radial_distance: null | Array<{ nav: string; nav_type: string; bearing_deg: number; dist_nm: number | null }>;
}
interface RawIls {
  runways_without_ils_or_loc: string[];
  note: string;
  systems: Array<{
    runway_end: string;
    plate_ident: string;
    category: string;
    loc_freq_mhz: number;
    dme_channel: string | null;
    front_course_mag_deg: number;
    status: string;
    approach_lighting: string;
    glideslope: { angle_deg: number; freq_mhz: number };
    plate_data: { plate_minima: string; tdze_plate_ft: number };
  }>;
}
interface RawOther { id: string; type: string; name: string; status: string; freq_mhz: string | number; channel: string; lat: number; lon: number }
/** Two key spellings exist: the first airport's hand-written file and the extractor's generic output. */
interface RawNav {
  _provenance: { sources: string[]; retrieved: string; faa_cycle_effective: string };
  vortac_acy?: Record<string, unknown> & { remarks: string[] };
  primary_navaid?: Record<string, unknown> & { remarks: string[] };
  ils_localizers_at_kacy?: RawIls;
  ils_localizers?: RawIls;
  other_navaids_referenced_by_kacy_procedures?: RawOther[];
  other_navaids_referenced?: RawOther[];
  fixes_named_on_kacy_approach_charts?: RawFix[];
  fixes_named_on_approach_charts?: RawFix[];
  unverified: string[];
}

/** KACY approach fixes the brief calls out: final-approach fixes/IFs for 13 and 31 plus the missed-approach hold. */
export const KEY_FIX_IDS = ['CARYL', 'MAYBN', 'STEVV', 'PRSTY', 'SMITS'] as const;
/** The nearby KACY VORs the brief names, shown first. */
export const PRIMARY_NEARBY_IDS = ['VCN', 'SIE', 'CYN'] as const;

const AIRPORTS: Record<string, { raw: RawNav; faaId: string; noIlsNote: string; keyFixIds?: readonly string[]; primaryNearby: readonly string[] }> = {
  KACY: { raw: rawNavaids as unknown as RawNav, faaId: 'ACY', noIlsNote: 'RNAV (GPS) and VOR approaches only.', keyFixIds: KEY_FIX_IDS, primaryNearby: PRIMARY_NEARBY_IDS },
  KMHT: { raw: rawKmhtNavaids as unknown as RawNav, faaId: 'MHT', noIlsNote: 'RNAV (GPS) approaches only (see the approach charts).', primaryNearby: ['CON', 'GDM'] },
};

const toRad = (d: number) => (d * Math.PI) / 180;

export function distanceBearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): { nm: number; bearing: number } {
  const R_NM = 3440.065;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  const nm = 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dLon) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLon);
  return { nm, bearing: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 };
}

function build(icao: string): NavaidDataset {
  const cfg = AIRPORTS[icao];
  const raw = cfg.raw;
  const rawIls = (raw.ils_localizers ?? raw.ils_localizers_at_kacy)!;
  const v = (raw.primary_navaid ?? raw.vortac_acy) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const vortac: Vortac = {
    id: v.id,
    type: v.type,
    name: v.name,
    status: v.status,
    freqMhz: v.freq_mhz,
    channel: v.tacan_dme_channel,
    lat: v.lat,
    lon: v.lon,
    elevFt: v.elev_ft,
    magVar: v.mag_var,
    magVarEpoch: v.mag_var_epoch,
    hours: v.hours,
    remarks: v.remarks ?? [],
    locationNote: v.location_note,
  };
  const ils: IlsSystem[] = rawIls.systems.map((s) => ({
    runway: s.runway_end,
    plateIdent: s.plate_ident,
    category: s.category,
    freqMhz: s.loc_freq_mhz,
    dmeChannel: s.dme_channel ?? '-',
    frontCourseMag: Math.round(s.front_course_mag_deg),
    gsAngleDeg: s.glideslope.angle_deg,
    gsFreqMhz: s.glideslope.freq_mhz,
    status: s.status,
    approachLighting: s.approach_lighting,
    minima: s.plate_data.plate_minima,
    tdzePlateFt: s.plate_data.tdze_plate_ft,
  }));
  const nearby: NearbyNavaid[] = (raw.other_navaids_referenced ?? raw.other_navaids_referenced_by_kacy_procedures ?? [])
    .map((n) => {
      const db = distanceBearing(vortac, n);
      return {
        id: n.id, type: n.type, name: n.name, status: n.status, freqMhz: String(n.freq_mhz), channel: n.channel, lat: n.lat, lon: n.lon,
        distanceNmFromAcy: db.nm, bearingTrueFromAcy: db.bearing,
      };
    })
    .sort((a, b) => {
      const pa = cfg.primaryNearby.indexOf(a.id);
      const pb = cfg.primaryNearby.indexOf(b.id);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || a.distanceNmFromAcy - b.distanceNmFromAcy;
    });
  const keyFixIds: readonly string[] = cfg.keyFixIds ?? deriveKeyFixes(raw);
  const fixes: ApproachFix[] = (raw.fixes_named_on_approach_charts ?? raw.fixes_named_on_kacy_approach_charts ?? []).map((f) => ({
    id: f.id,
    lat: f.lat,
    lon: f.lon,
    roles: Object.entries(f.roles_on_plates ?? f.roles_on_kacy_plates ?? {})
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([procedure, role]) => ({ procedure, role })),
    reference: (f.reference_navaid_radial_distance ?? []).map(
      (r) => `${r.nav} ${r.bearing_deg.toFixed(0)}°${r.dist_nm != null ? ` / ${r.dist_nm} NM` : ''}`,
    ),
    key: keyFixIds.includes(f.id),
  }));
  return {
    vortac,
    faaId: cfg.faaId,
    icao,
    keyFixIds,
    noIlsNote: cfg.noIlsNote,
    ils,
    runwaysWithoutIls: rawIls.runways_without_ils_or_loc,
    ilsNote: rawIls.note,
    nearby,
    fixes,
    provenance: { sources: raw._provenance.sources, retrieved: raw._provenance.retrieved, cycle: raw._provenance.faa_cycle_effective },
    unverified: raw.unverified,
  };
}

/** Key fixes of an airport without a hand-picked list: every fix that is a FAF, IF or missed-approach hold on some plate. */
function deriveKeyFixes(raw: RawNav): string[] {
  return (raw.fixes_named_on_approach_charts ?? [])
    .filter((f) => Object.values(f.roles_on_plates ?? {}).some((r) => typeof r === 'string' && /\b(FAF|IF)\b|missed approach hold/i.test(r)))
    .map((f) => f.id);
}

const cache = new Map<string, NavaidDataset>();
/** Navaid dataset of an airport (default KACY). */
export function navaidsFor(icao: string = 'KACY'): NavaidDataset {
  const key = AIRPORTS[icao.toUpperCase()] ? icao.toUpperCase() : 'KACY';
  let d = cache.get(key);
  if (!d) cache.set(key, (d = build(key)));
  return d;
}

export const NAVAIDS: NavaidDataset = navaidsFor('KACY');

/** "39-27.3N" style is overkill for a reference table; decimal degrees with hemisphere. */
export function formatLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}${lon >= 0 ? 'E' : 'W'}`;
}
