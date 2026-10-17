/**
 * Typed accessors over data/sources/kacy-navaids.json (NASR 2026-10-01 +
 * d-TPP 2610 plate readings). Display-only; nothing is derived except the
 * great-circle distance/bearing from the ACY VORTAC, which is labelled as
 * computed in the UI.
 */
import rawNavaids from '../../data/sources/kacy-navaids.json';

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
  magVar: string;
  magVarEpoch: string;
  hours: string;
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
  vortac: Vortac;
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
  roles_on_kacy_plates: Record<string, string | null>;
  reference_navaid_radial_distance: null | Array<{ nav: string; nav_type: string; bearing_deg: number; dist_nm: number | null }>;
}
interface RawNav {
  _provenance: { sources: string[]; retrieved: string; faa_cycle_effective: string };
  vortac_acy: Record<string, unknown> & { remarks: string[] };
  ils_localizers_at_kacy: {
    runways_without_ils_or_loc: string[];
    note: string;
    systems: Array<{
      runway_end: string;
      plate_ident: string;
      category: string;
      loc_freq_mhz: number;
      dme_channel: string;
      front_course_mag_deg: number;
      status: string;
      approach_lighting: string;
      glideslope: { angle_deg: number; freq_mhz: number };
      plate_data: { plate_minima: string; tdze_plate_ft: number };
    }>;
  };
  other_navaids_referenced_by_kacy_procedures: Array<{
    id: string; type: string; name: string; status: string; freq_mhz: string; channel: string; lat: number; lon: number;
  }>;
  fixes_named_on_kacy_approach_charts: RawFix[];
  unverified: string[];
}
const raw = rawNavaids as unknown as RawNav;

/** Approach fixes the brief calls out: final-approach fixes/IFs for 13 and 31 plus the missed-approach hold. */
export const KEY_FIX_IDS = ['CARYL', 'MAYBN', 'STEVV', 'PRSTY', 'SMITS'] as const;
/** The nearby VORs the brief names, shown first. */
export const PRIMARY_NEARBY_IDS = ['VCN', 'SIE', 'CYN'] as const;

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

function build(): NavaidDataset {
  const v = raw.vortac_acy as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
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
    remarks: v.remarks,
    locationNote: v.location_note,
  };
  const ils: IlsSystem[] = raw.ils_localizers_at_kacy.systems.map((s) => ({
    runway: s.runway_end,
    plateIdent: s.plate_ident,
    category: s.category,
    freqMhz: s.loc_freq_mhz,
    dmeChannel: s.dme_channel,
    frontCourseMag: Math.round(s.front_course_mag_deg),
    gsAngleDeg: s.glideslope.angle_deg,
    gsFreqMhz: s.glideslope.freq_mhz,
    status: s.status,
    approachLighting: s.approach_lighting,
    minima: s.plate_data.plate_minima,
    tdzePlateFt: s.plate_data.tdze_plate_ft,
  }));
  const nearby: NearbyNavaid[] = raw.other_navaids_referenced_by_kacy_procedures
    .map((n) => {
      const db = distanceBearing(vortac, n);
      return {
        id: n.id, type: n.type, name: n.name, status: n.status, freqMhz: n.freq_mhz, channel: n.channel, lat: n.lat, lon: n.lon,
        distanceNmFromAcy: db.nm, bearingTrueFromAcy: db.bearing,
      };
    })
    .sort((a, b) => {
      const pa = PRIMARY_NEARBY_IDS.indexOf(a.id as (typeof PRIMARY_NEARBY_IDS)[number]);
      const pb = PRIMARY_NEARBY_IDS.indexOf(b.id as (typeof PRIMARY_NEARBY_IDS)[number]);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || a.distanceNmFromAcy - b.distanceNmFromAcy;
    });
  const fixes: ApproachFix[] = raw.fixes_named_on_kacy_approach_charts.map((f) => ({
    id: f.id,
    lat: f.lat,
    lon: f.lon,
    roles: Object.entries(f.roles_on_kacy_plates)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([procedure, role]) => ({ procedure, role })),
    reference: (f.reference_navaid_radial_distance ?? []).map(
      (r) => `${r.nav} ${r.bearing_deg.toFixed(0)}°${r.dist_nm != null ? ` / ${r.dist_nm} NM` : ''}`,
    ),
    key: (KEY_FIX_IDS as readonly string[]).includes(f.id),
  }));
  return {
    vortac,
    ils,
    runwaysWithoutIls: raw.ils_localizers_at_kacy.runways_without_ils_or_loc,
    ilsNote: raw.ils_localizers_at_kacy.note,
    nearby,
    fixes,
    provenance: { sources: raw._provenance.sources, retrieved: raw._provenance.retrieved, cycle: raw._provenance.faa_cycle_effective },
    unverified: raw.unverified,
  };
}

export const NAVAIDS: NavaidDataset = build();

/** "39-27.3N" style is overkill for a reference table; decimal degrees with hemisphere. */
export function formatLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}${lon >= 0 ? 'E' : 'W'}`;
}
