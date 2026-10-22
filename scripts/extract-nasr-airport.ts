/**
 * Extract one airport's rows from the FAA NASR 28-day subscription CSVs into the three source JSON files the airport
 * build reads (data/sources/<icao>-facility.json, -frequencies.json, -navaids.json).
 *
 *   npx tsx scripts/extract-nasr-airport.ts MHT KMHT
 *
 * Reads    data/sources/raw/nasr_<cycle>/x_<NAME>_CSV/*.csv   (APT, ATC, CLS_ARSP, FRQ, ILS, NAV, FIX)
 *          data/sources/<icao>-procedures.json                (hand-transcribed plate data: charted headings, ILS plate data,
 *                                                              fix roles, navaids referenced by the plates)
 * Values are copied from the CSV rows verbatim; the only conversions are string -> number and a few joins. Blank NASR fields
 * become null / "none recorded", never a guess. Nothing is typed in from memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../data/sources');
const [, , FAA_ID = 'MHT', ICAO = 'KMHT', CYCLE_ARG = '2026-10-01', RETRIEVED_ARG = '2026-10-17'] = process.argv;
const icaoLower = ICAO.toLowerCase();
const CYCLE = CYCLE_ARG;
const RAW = path.join(SRC, `raw/nasr_${CYCLE}`);
const NEXT_CYCLE = '2026-10-29';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type Row = Record<string, string>;

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). */
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const table = (dir: string, file: string): Row[] => parseCsv(fs.readFileSync(path.join(RAW, `x_${dir}_CSV`, file), 'utf8'));
const num = (v: string | undefined): number | null => (v === undefined || v === '' ? null : Number(v));
const str = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);
const dms = (d: string, m: string, s: string, h: string): string => `${d}-${m}-${s}${h}`;

const procPath = path.join(SRC, `${icaoLower}-procedures.json`);
const proc: J = JSON.parse(fs.readFileSync(procPath, 'utf8'));
const provenanceBase = {
  retrieved: RETRIEVED_ARG,
  faa_cycle_effective: CYCLE,
  faa_cycle_next: NEXT_CYCLE,
};

// ---------------------------------------------------------------------------------------------------------------------
// facility
// ---------------------------------------------------------------------------------------------------------------------
const apt = table('APT', 'APT_BASE.csv').find((r) => r.ARPT_ID === FAA_ID)!;
if (!apt) throw new Error(`${FAA_ID} not in APT_BASE.csv`);
if (apt.ICAO_ID !== ICAO) throw new Error(`NASR ICAO ${apt.ICAO_ID} != ${ICAO}`);
const atcBase = table('ATC', 'ATC_BASE.csv').find((r) => r.FACILITY_ID === FAA_ID);
const atcAtis = table('ATC', 'ATC_ATIS.csv').filter((r) => r.FACILITY_ID === FAA_ID);
const atcSvc = table('ATC', 'ATC_SVC.csv').filter((r) => r.FACILITY_ID === FAA_ID);
const atcRmk = table('ATC', 'ATC_RMK.csv').filter((r) => r.FACILITY_ID === FAA_ID);
const aptRmk = table('APT', 'APT_RMK.csv').filter((r) => r.ARPT_ID === FAA_ID);
const aptCon = table('APT', 'APT_CON.csv').filter((r) => r.ARPT_ID === FAA_ID);
const aptArs = table('APT', 'APT_ARS.csv').filter((r) => r.ARPT_ID === FAA_ID);
const rwyRows = table('APT', 'APT_RWY.csv').filter((r) => r.ARPT_ID === FAA_ID);
const endRows = table('APT', 'APT_RWY_END.csv').filter((r) => r.ARPT_ID === FAA_ID);
const cls = table('CLS_ARSP', 'CLS_ARSP.csv').filter((r) => r.ARPT_ID === FAA_ID);

const charted: Record<string, number> = proc.airport_diagram.charted_runway_headings_mag;
/** Runway end key used in the *-procedures.json files: leading zeros stripped, the L/R/C letter kept ("04" -> "4", "04R" -> "4R"). */
const endKey = (id: string): string => id.replace(/^0+(?=\d)/, '');
const ilsBase = table('ILS', 'ILS_BASE.csv').filter((r) => r.ARPT_ID === FAA_ID);
const ilsGs = table('ILS', 'ILS_GS.csv').filter((r) => r.ARPT_ID === FAA_ID);
const ilsDme = table('ILS', 'ILS_DME.csv').filter((r) => r.ARPT_ID === FAA_ID);
const ilsMkr = table('ILS', 'ILS_MKR.csv').filter((r) => r.ARPT_ID === FAA_ID);
const ilsRmk = table('ILS', 'ILS_RMK.csv').filter((r) => r.ARPT_ID === FAA_ID);

const OWNERSHIP: Record<string, string> = { PU: 'PU = publicly owned (NASR code)', PR: 'PR = privately owned (NASR code)' };
const magVar = { deg: num(apt.MAG_VARN)!, hemisphere: apt.MAG_HEMIS, epoch_year: apt.MAG_VARN_YEAR };

const runways = rwyRows.map((r) => {
  const ends = endRows.filter((e) => e.RWY_ID === r.RWY_ID).map((e) => {
    const lahso = num(e.LAHSO_ALD) !== null
      ? { available_landing_distance_ft: num(e.LAHSO_ALD), hold_short_of: e.RWY_END_INTERSECT_LAHSO, hold_short_point: { lat: num(e.LAT_LAHSO_DECIMAL), lon: num(e.LONG_LAHSO_DECIMAL) } }
      : null;
    const displaced = num(e.DISPLACED_THR_LEN);
    return {
      id: e.RWY_END_ID,
      true_alignment_deg: num(e.TRUE_ALIGNMENT),
      charted_magnetic_heading_deg: charted[endKey(e.RWY_END_ID)] ?? null,
      charted_magnetic_heading_source: `airport diagram ${proc.airport_diagram.pdf_name} (runway end heading printed on the chart)`,
      threshold: {
        lat: num(e.LAT_DECIMAL),
        lon: num(e.LONG_DECIMAL),
        lat_dms: dms(e.RWY_END_LAT_DEG, e.RWY_END_LAT_MIN, e.RWY_END_LAT_SEC, e.RWY_END_LAT_HEMIS),
        lon_dms: dms(e.RWY_END_LONG_DEG, e.RWY_END_LONG_MIN, e.RWY_END_LONG_SEC, e.RWY_END_LONG_HEMIS),
        elev_ft: num(e.RWY_END_ELEV),
        position_source: e.RWY_END_PSN_SOURCE,
        position_date: e.RWY_END_PSN_DATE,
        note: 'NASR RWY_END_LAT/LONG = the physical runway end (pavement end). The simulator uses it as the runway-end node; a displaced landing threshold, where one exists, is listed in displaced_threshold.',
      },
      displaced_threshold: displaced
        ? {
            present: true,
            length_ft: displaced,
            lat: num(e.LAT_DISPLACED_THR_DECIMAL),
            lon: num(e.LONG_DISPLACED_THR_DECIMAL),
            elev_ft: num(e.DISPLACED_THR_ELEV),
            note: 'NASR DISPLACED_THR_LEN: landing threshold displaced from the pavement end (the displaced area is usable for takeoff, taxi and landing rollout). Not modelled by the simulator beyond this record.',
          }
        : { present: false, length_ft: null, note: 'NASR DISPLACED_THR_* fields are blank for this runway end (none recorded).' },
      tdz_elev_ft: num(e.TDZ_ELEV),
      threshold_crossing_height_ft: num(e.THR_CROSSING_HGT),
      visual_glide_path_angle_deg: num(e.VISUAL_GLIDE_PATH_ANGLE),
      vgsi: str(e.VGSI_CODE),
      approach_lighting: str(e.APCH_LGT_SYSTEM_CODE) ?? 'NONE recorded in NASR',
      tdz_lights: e.TDZ_LGT_AVBL_FLAG === 'Y' ? 'Y' : null,
      centerline_lights: e.CNTRLN_LGTS_AVBL_FLAG === 'Y' ? 'Y' : null,
      reil: e.RWY_END_LGTS_FLAG === 'Y' ? 'REIL' : null,
      ils_type_nasr: str(e.ILS_TYPE) ?? 'NONE recorded in NASR',
      marking: { type: str(e.RWY_MARKING_TYPE_CODE), condition: str(e.RWY_MARKING_COND) },
      declared_distances_ft: { tora: num(e.TKOF_RUN_AVBL), toda: num(e.TKOF_DIST_AVBL), asda: num(e.ACLT_STOP_DIST_AVBL), lda: num(e.LNDG_DIST_AVBL) },
      lahso,
      right_hand_traffic: str(e.RIGHT_HAND_TRAFFIC_PAT_FLAG),
      controlling_obstruction: str(e.OBSTN_TYPE)
        ? { type: e.OBSTN_TYPE, height_ft: num(e.OBSTN_HGT), slope: str(e.OBSTN_CLNC_SLOPE), dist_from_thr_ft: num(e.DIST_FROM_THR), offset_ft: num(e.CNTRLN_OFFSET), offset_side: str(e.CNTRLN_DIR_CODE) }
        : null,
    };
  });
  return {
    id: r.RWY_ID,
    length_ft: num(r.RWY_LEN),
    width_ft: num(r.RWY_WIDTH),
    surface: r.SURFACE_TYPE_CODE,
    condition: str(r.COND),
    treatment: str(r.TREATMENT_CODE),
    pavement_classification: str(r.PAVEMENT_CLASSIFICATION),
    pcr_number: str(r.PCN_PCR_NUMBER),
    pavement_code: [r.PAVEMENT_TYPE_CODE, r.SUBGRADE_STRENGTH_CODE, r.TIRE_PRES_CODE, r.DTRM_METHOD_CODE].filter(Boolean).join('/'),
    edge_lights: str(r.RWY_LGT_CODE),
    weight_bearing_klbs: { single: num(r.GROSS_WT_SW), dual: num(r.GROSS_WT_DW), dual_tandem: num(r.GROSS_WT_DTW), double_dual_tandem: num(r.GROSS_WT_DDTW) },
    length_source: str(r.RWY_LEN_SOURCE),
    length_source_date: str(r.LENGTH_SOURCE_DATE),
    ends,
    type: 'RUNWAY',
  };
});

const ilsByEnd: Record<string, J> = {};
for (const b of ilsBase) {
  const gs = ilsGs.find((g) => g.RWY_END_ID === b.RWY_END_ID);
  ilsByEnd[endKey(b.RWY_END_ID)] = {
    loc_ident: b.ILS_LOC_ID,
    category: b.CATEGORY,
    loc_freq_mhz: num(b.LOC_FREQ),
    approach_bearing_mag: num(b.APCH_BEAR),
    glideslope_angle: num(gs?.G_S_ANGLE),
    gs_freq_mhz: num(gs?.G_S_FREQ),
  };
}

const facility = {
  _provenance: {
    source: `FAA NASR 28-day subscription, cycle effective ${CYCLE} (next ${NEXT_CYCLE}), CSV per-file zips from https://nfdc.faa.gov/webContent/28DaySub/extra/01_Oct_2026_<NAME>_CSV.zip; page https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/${CYCLE}/`,
    files: ['APT_BASE.csv', 'APT_RWY.csv', 'APT_RWY_END.csv', 'APT_RMK.csv', 'APT_CON.csv', 'APT_ARS.csv', 'ATC_BASE.csv', 'ATC_ATIS.csv', 'ATC_SVC.csv', 'ATC_RMK.csv', 'CLS_ARSP.csv', 'ILS_BASE.csv', 'ILS_GS.csv', 'ILS_DME.csv', 'ILS_MKR.csv', 'ILS_RMK.csv'],
    ...provenanceBase,
    arpt_id: FAA_ID,
    icao: ICAO,
    site_no: apt.SITE_NO,
    method: `Extracted by scripts/extract-nasr-airport.ts ${FAA_ID} ${ICAO}: rows with ARPT_ID/FACILITY_ID == ${FAA_ID} copied verbatim, only numeric conversion applied. Blank NASR fields are reported as null/none-recorded, never filled in. Charted magnetic runway headings are read from the airport diagram (see airport_diagram.charted_runway_headings_mag in ${icaoLower}-procedures.json).`,
    raw_dir: `raw/nasr_${CYCLE}/`,
  },
  airport: {
    name: apt.ARPT_NAME,
    icao: apt.ICAO_ID,
    faa_id: apt.ARPT_ID,
    city: apt.CITY,
    state: apt.STATE_CODE,
    county: apt.COUNTY_NAME,
    faa_region: apt.REGION_CODE,
    ownership: {
      type_code: apt.OWNERSHIP_TYPE_CODE,
      type_meaning: OWNERSHIP[apt.OWNERSHIP_TYPE_CODE] ?? apt.OWNERSHIP_TYPE_CODE,
      owner: aptCon.find((c) => c.TITLE === 'OWNER')?.NAME ?? null,
      contacts: aptCon.map((c) => ({ title: c.TITLE, name: c.NAME, address: [c.ADDRESS1, c.TITLE_CITY, c.STATE, c.ZIP_CODE].filter(Boolean).join(', '), phone: c.PHONE_NO })),
    },
    facility_use: apt.FACILITY_USE_CODE,
    status: apt.ARPT_STATUS,
    activation_date: apt.ACTIVATION_DATE,
    far139_type: apt.FAR_139_TYPE_CODE,
    far139_carrier_service: apt.FAR_139_CARRIER_SER_CODE,
    arp: {
      lat: num(apt.LAT_DECIMAL),
      lon: num(apt.LONG_DECIMAL),
      lat_dms: dms(apt.LAT_DEG, apt.LAT_MIN, apt.LAT_SEC, apt.LAT_HEMIS),
      lon_dms: dms(apt.LONG_DEG, apt.LONG_MIN, apt.LONG_SEC, apt.LONG_HEMIS),
      source: apt.ARPT_PSN_SOURCE,
      source_date: apt.POSITION_SRC_DATE,
    },
    field_elevation_ft: num(apt.ELEV),
    elevation_source: apt.ARPT_ELEV_SOURCE,
    elevation_source_date: apt.ELEVATION_SRC_DATE,
    magnetic_variation: {
      ...magVar,
      note: `NASR airport variation is ${magVar.deg}${magVar.hemisphere}, epoch ${magVar.epoch_year}. The airport diagram prints "VAR ${magVar.deg}° ${magVar.hemisphere}, ${proc.airport_diagram.printed_variation_epoch}, annual rate of change ${proc.airport_diagram.printed_annual_rate_of_change}". Charted magnetic runway headings = true + ${magVar.deg}. Current WMM declination for 2026 is NOT verified here.`,
    },
    artcc: { id: apt.RESP_ARTCC_ID, name: apt.ARTCC_NAME },
    fss: { id: apt.FSS_ID, name: apt.FSS_NAME },
    tower_type: apt.TWR_TYPE_CODE,
    beacon: { schedule: apt.BCN_LGT_SKED, lens: apt.BCN_LENS_COLOR },
    wind_indicator: apt.WIND_INDCR_FLAG,
    fuel: apt.FUEL_TYPES,
    customs: apt.USER_FEE_FLAG || null,
    landing_fee: apt.LNDG_FEE_FLAG,
    military_landing_rights: apt.MIL_LNDG_FLAG,
    acreage: num(apt.ACREAGE),
    chart_name: apt.CHART_NAME,
    distance_city_to_airport_nm: num(apt.DIST_CITY_TO_AIRPORT),
    direction_city_to_airport: apt.DIRECTION_CODE,
    last_inspection: apt.LAST_INSPECTION,
    traffic_pattern_altitude_ft: num(apt.TPA),
    traffic_pattern_altitude_note: num(apt.TPA) === null ? `TPA blank in NASR for ${FAA_ID} - UNVERIFIED` : 'NASR TPA',
  },
  tower: {
    facility_type: atcBase?.FACILITY_TYPE ?? null,
    operator_code: atcBase?.TWR_OPERATOR_CODE ?? null,
    operator_meaning: atcBase?.TWR_OPERATOR_CODE === 'F' ? 'F = FAA (NASR code)' : atcBase?.TWR_OPERATOR_CODE === 'FCT' ? 'FCT = FAA contract tower (NASR code)' : atcBase?.TWR_OPERATOR_CODE ?? null,
    tower_call: atcBase?.TWR_CALL ?? null,
    tower_hours: atcBase?.TWR_HRS ?? null,
    tower_hours_note: `NASR TWR_HRS = ${atcBase?.TWR_HRS} (hours/day).`,
    approach_radio_call: atcBase?.PRIMARY_APCH_RADIO_CALL ?? null,
    departure_radio_call: atcBase?.PRIMARY_DEP_RADIO_CALL ?? null,
    approach_provider: atcBase?.APCH_P_PROVIDER ?? null,
    services: atcSvc.map((s) => s.CTL_SVC),
    atis: atcAtis.map((a) => ({ atis_no: a.ATIS_NO, hours: a.ATIS_HRS, phone: a.ATIS_PHONE_NO })),
    note: `ATC_BASE: ${atcBase?.FACILITY_TYPE}, tower radio call "${atcBase?.TWR_CALL}", primary approach/departure provider ${atcBase?.APCH_P_PROVIDER} ("${atcBase?.PRIMARY_APCH_RADIO_CALL}").${atcRmk.length ? ` ATC remarks: ${atcRmk.map((r) => `"${r.REMARK}"`).join(' ')}` : ''}`,
  },
  airspace: {
    class_c: cls.some((c) => c.CLASS_C_AIRSPACE === 'Y'),
    class_b: cls.some((c) => c.CLASS_B_AIRSPACE === 'Y'),
    class_d: cls.some((c) => c.CLASS_D_AIRSPACE === 'Y'),
    class_e_surface: cls.some((c) => c.CLASS_E_AIRSPACE === 'Y'),
    hours: str(cls[0]?.AIRSPACE_HRS),
    note: `NASR CLS_ARSP: ${FAA_ID} CLASS_C_AIRSPACE = ${cls[0]?.CLASS_C_AIRSPACE ?? 'n/a'}. Vertical/lateral limits are NOT in the CSV rows; class_airspace_shape_files.zip was not downloaded - shelf dimensions UNVERIFIED.`,
  },
  runways,
  lights_and_aids: { arresting_gear: aptArs.map((a) => ({ rwy_end: `${a.RWY_ID} end ${a.RWY_END_ID}`, device: a.ARREST_DEVICE_CODE })) },
  ils_by_runway_end: ilsByEnd,
  remarks: aptRmk.map((r) => ({ legacy_element: r.LEGACY_ELEMENT_NUMBER, applies_to: r.REF_COL_NAME, seq: r.REF_COL_SEQ_NO, text: r.REMARK })),
  unverified: [
    'Traffic pattern altitude (TPA blank in NASR)',
    'Current (2026) magnetic declination; NASR/diagram epoch is stale',
    'Class C airspace vertical/lateral dimensions (shape files not downloaded)',
    'Operating hours of airport-owned customer services other than as given in remarks',
  ],
};
// optional hand-sourced runway configurations (data/sources/<slug>-runway-configurations.json): embedded as facility.runway_configurations
const cfgPath = path.join(SRC, `${icaoLower}-runway-configurations.json`);
if (fs.existsSync(cfgPath)) {
  const cfg: J = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  (facility as J).runway_configurations = cfg.configurations;
  (facility as J).runway_configurations_provenance = cfg._provenance;
  if (cfg.time_zone) {
    (facility as J).airport.time_zone = cfg.time_zone;
    (facility as J).airport.time_zone_source = cfg.time_zone_source;
  }
}
// airspace class from the NASR CLS_ARSP flags (B takes precedence over C over D)
(facility as J).airspace.class = facility.airspace.class_b ? 'B' : facility.airspace.class_c ? 'C' : facility.airspace.class_d ? 'D' : undefined;
fs.writeFileSync(path.join(SRC, `${icaoLower}-facility.json`), JSON.stringify(facility, null, 1) + '\n');

// ---------------------------------------------------------------------------------------------------------------------
// frequencies
// ---------------------------------------------------------------------------------------------------------------------
// A TRACON that serves many airports (PHL: Newark, Teterboro, ...) has FACILITY == FAA_ID for the rows of all of them: rows that name another
// serviced airport are not this airport's frequencies.
const frq = table('FRQ', 'FRQ.csv').filter((r) => r.SERVICED_FACILITY === FAA_ID || (r.FACILITY === FAA_ID && (!r.SERVICED_FACILITY || r.SERVICED_FACILITY === r.FACILITY)));
const frqRow = (r: Row): J => ({
  freq_mhz: r.FREQ,
  use_code: r.FREQ_USE,
  sectorization: str(r.SECTORIZATION),
  remark: str(r.REMARK),
  facility: r.FACILITY,
  facility_name: str(r.FAC_NAME),
  facility_type: r.FACILITY_TYPE,
  serviced_facility: r.SERVICED_FACILITY,
  serviced_site_type: r.SERVICED_SITE_TYPE,
  radio_call: str(r.TOWER_OR_COMM_CALL),
  approach_radio_call: str(r.PRIMARY_APPROACH_RADIO_CALL),
  band: Number(r.FREQ.split('/')[0]) >= 225 ? 'UHF' : 'VHF',
});
const vhfUse = (use: string, facilityType?: string): J[] => frq.filter((r) => r.FREQ_USE === use && (!facilityType || r.FACILITY_TYPE === facilityType) && Number(r.FREQ) < 225);
const uhfUse = (use: string, facilityType?: string): string | undefined => frq.find((r) => r.FREQ_USE === use && (!facilityType || r.FACILITY_TYPE === facilityType) && Number(r.FREQ) >= 225)?.FREQ;
// Airports with several rows of one use (BOS: two GND/P, three LCL/P by sector, D-ATIS arrival/departure, no CD/P VHF) take the
// multi-row path; single-row airports (KACY, KMHT) keep exactly the old fields.
const atisRows = vhfUse('ATIS', 'ATCT');
const datisRows = frq.filter((r) => r.FREQ_USE === 'D-ATIS' && Number(r.FREQ) < 225);
const atis = atisRows.length === 1 ? atisRows[0] : datisRows[0];
if (!atis) throw new Error('no ATIS or D-ATIS VHF row');
const cdRows = vhfUse('CD/P').filter((r) => r.FACILITY === FAA_ID);
const cdPre = frq.filter((r) => r.FREQ_USE === 'CD PRE TAXI CLNC' && Number(r.FREQ) < 225);
const cd = cdRows.length === 1 ? cdRows[0] : cdPre[0];
if (!cd) throw new Error('no VHF clearance delivery row (CD/P or CD PRE TAXI CLNC)');
const gndRows = vhfUse('GND/P').filter((r) => r.FACILITY === FAA_ID);
if (!gndRows.length) throw new Error('no VHF GND/P row');
const gnd = gndRows[0];
const lclRows = vhfUse('LCL/P').filter((r) => r.FACILITY === FAA_ID && (r.FACILITY_TYPE.startsWith('ATCT') || r.FACILITY_TYPE === ''));
if (!lclRows.length) throw new Error('no VHF LCL/P row');
const lcl = lclRows.find((r) => !str(r.SECTORIZATION)) ?? lclRows.find((r) => r.SECTORIZATION !== 'HELICOPTERS') ?? lclRows[0];
const appRows = frq.filter((r) => r.FREQ_USE.startsWith('APCH/P DEP/P')); // 'APCH/P DEP/P' and 'APCH/P DEP/P IC' (PGD lists its UHF row with the IC suffix)
const appVhf = appRows.find((r) => Number(r.FREQ) < 225) ?? frq.find((r) => r.FREQ_USE.startsWith('APCH/P') && r.FACILITY_TYPE === 'TRACON' && Number(r.FREQ) < 225)!;
const appUhf = appRows.find((r) => Number(r.FREQ) >= 225);
const tracon = frq.filter((r) => r.FACILITY_TYPE === 'TRACON' && Number(r.FREQ) < 225);
const classC = frq.filter((r) => r.FREQ_USE === 'CLASS C');
const classB = frq.filter((r) => r.FREQ_USE === 'CLASS B');
// Further use codes of a large TRACON-airport (PHL): secondary ground, PRM monitor, final approach, sectorized approach / departure rows, the named
// departure positions and the STAR frequencies. Present in the summary only when the airport has them (KACY, KMHT, KBOS unchanged).
// (only for a combined ATCT-TRACON facility, so that other airports' files stay byte-identical)
const combined = atcBase?.FACILITY_TYPE === 'ATCT-TRACON';
const rowSummary = (r: Row): J => ({ freq_mhz: r.FREQ, use_code: r.FREQ_USE, sectorization: str(r.SECTORIZATION), remark: str(r.REMARK) });
const atisDepRow = !combined ? undefined : frq.find((r) => r.FREQ_USE === 'D-ATIS' && r.SECTORIZATION === 'DEP' && Number(r.FREQ) < 225);
const gndSecondary = !combined ? [] : frq.filter((r) => r.FREQ_USE === 'GND/S' && Number(r.FREQ) < 225);
const prmRows = !combined ? [] : frq.filter((r) => r.FREQ_USE === 'PRM' && Number(r.FREQ) < 225);
const finalRows = !combined ? [] : frq.filter((r) => r.FREQ_USE === 'FINAL APCH' && Number(r.FREQ) < 225);
const apchSectors = !combined ? [] : frq.filter((r) => r.FREQ_USE === 'APCH/P' && Number(r.FREQ) < 225 && r.FACILITY_TYPE.startsWith('ATCT'));
const depSectors = !combined ? [] : frq.filter((r) => r.FREQ_USE === 'DEP/P' && Number(r.FREQ) < 225 && r.FACILITY_TYPE.startsWith('ATCT'));
const namedDep = !combined ? [] : frq.filter((r) => r.FREQ_USE.endsWith(' DP') && Number(r.FREQ) < 225);
const starRows = !combined ? [] : frq.filter((r) => r.FREQ_USE.endsWith(' STAR') && Number(r.FREQ) < 225);
const emerg = frq.find((r) => r.FREQ_USE === 'EMERG' && Number(r.FREQ) < 225);
const emergU = frq.find((r) => r.FREQ_USE === 'EMERG' && Number(r.FREQ) >= 225);
const unicom = frq.find((r) => r.FREQ_USE === 'UNICOM');
const callName = atcBase!.TWR_CALL;
const frequencies = {
  _provenance: {
    source: `FAA NASR 28-day subscription, cycle effective ${CYCLE}; https://nfdc.faa.gov/webContent/28DaySub/extra/01_Oct_2026_FRQ_CSV.zip (FRQ.csv)`,
    also_used: ['ATC_BASE.csv', 'ATC_ATIS.csv (ATIS phone)', 'ATC_RMK.csv', `FAA d-TPP ${ICAO} airport diagram ${proc.airport_diagram.pdf_name} cycle ${proc._provenance.cycle} (cross-check of the printed frequencies)`, `FAA d-TPP departure procedure charts (departure facility name)`],
    ...provenanceBase,
    method: `All rows in FRQ.csv where FACILITY==${FAA_ID} or SERVICED_FACILITY==${FAA_ID}, copied verbatim (scripts/extract-nasr-airport.ts). No values from memory.`,
    raw: `raw/nasr_${CYCLE}/x_FRQ_CSV/FRQ.csv`,
  },
  facility: {
    id: FAA_ID,
    name: apt.ARPT_NAME,
    type: atcBase!.FACILITY_TYPE,
    tower_hours: atcBase!.TWR_HRS,
    radio_call: callName,
    approach_radio_call: atcBase!.PRIMARY_APCH_RADIO_CALL,
    departure_radio_call: atcBase!.PRIMARY_DEP_RADIO_CALL,
    approach_provider: atcBase!.APCH_P_PROVIDER,
    approach_provider_name: frq.find((r) => r.FACILITY === atcBase!.APCH_P_PROVIDER)?.FAC_NAME ?? null,
    controlling_artcc: `${apt.RESP_ARTCC_ID} (${apt.ARTCC_NAME})`,
  },
  summary_by_function: {
    ATIS: { vhf: atis.FREQ, uhf: uhfUse('ATIS', 'ATCT') ?? null, hours: atcAtis[0]?.ATIS_HRS || atis.TOWER_HRS, phone: atcAtis[0]?.ATIS_PHONE_NO || null, note: atisRows.length === 1 ? 'FRQ use code ATIS (facility type ATCT); phone from ATC_ATIS.csv. The ASOS row on the same frequency is the automated weather source.' : `FRQ use code D-ATIS (${datisRows.map((r) => `${r.SECTORIZATION} ${r.FREQ}`).join(', ')}); no plain ATIS row; ATC_ATIS.csv phone ${atcAtis[0]?.ATIS_PHONE_NO ?? 'none recorded'}. The ASOS row on the same frequency is the automated weather source.` },
    clearance_delivery: { vhf: cd.FREQ, uhf: uhfUse('CD/P') ?? null, note: `FRQ ${cd.FREQ_USE}${cdRows.length === 1 ? '' : ' (no VHF CD/P row; the VHF clearance row is the pre-taxi clearance frequency)'}; the airport diagram prints CLNC DEL ${proc.airport_diagram.printed_frequencies?.CLNC_DEL}` },
    ground: { vhf: gnd.FREQ, uhf: uhfUse('GND/P') ?? null, note: `FRQ GND/P${gndRows.length > 1 ? ` (${gndRows.length} VHF rows: ${gndRows.map((r) => r.FREQ).join(', ')}; NASR gives no sectorization)` : ''}; the airport diagram prints GND CON ${proc.airport_diagram.printed_frequencies?.GND_CON}` },
    ...(gndRows.length > 1 ? { ground_all: gndRows.map((r) => ({ freq_mhz: r.FREQ, sectorization: str(r.SECTORIZATION) })) } : {}),
    tower: { vhf: lcl.FREQ, uhf: uhfUse('LCL/P', 'ATCT') ?? null, note: `FRQ LCL/P; the airport diagram prints ${proc.airport_diagram.printed_frequencies?.TOWER}` },
    ...(lclRows.length > 1 ? { tower_all: lclRows.map((r) => ({ freq_mhz: r.FREQ, sectorization: str(r.SECTORIZATION), remark: str(r.REMARK) })) } : {}),
    ramp_control: frq.filter((r) => r.FREQ_USE === 'RAMP CTL' && Number(r.FREQ) < 225).map((r) => ({ freq_mhz: r.FREQ, note: 'FRQ RAMP CTL' })),
    tracon_vhf_rows: tracon.map((r) => ({ freq_mhz: r.FREQ, use_code: r.FREQ_USE, sectorization: str(r.SECTORIZATION), facility: r.FACILITY, facility_name: r.FAC_NAME })),
    class_b_frequencies: classB.map((r) => ({ freq_mhz: r.FREQ, sectorization: str(r.SECTORIZATION) })),
    ...(atisDepRow ? { atis_departure: { vhf: atisDepRow.FREQ, note: 'FRQ use code D-ATIS, sectorization DEP (departure ATIS)' } } : {}),
    ...(gndSecondary.length ? { ground_secondary: gndSecondary.map((r) => ({ vhf: r.FREQ, note: 'FRQ GND/S (secondary ground control; not printed on the airport diagram)' })) } : {}),
    ...(combined && lclRows.length > 1 ? { tower_additional: lclRows.filter((r) => r !== lcl).map((r) => ({ vhf: r.FREQ, sectorization: str(r.SECTORIZATION), note: 'further FRQ LCL/P row (a second tower position)' })) } : {}),
    ...(prmRows.length ? { prm_monitor: prmRows.map((r) => ({ vhf: r.FREQ, sectorization: str(r.SECTORIZATION), note: 'FRQ PRM (precision runway monitor); not an ATC position of this simulator' })) } : {}),
    ...(finalRows.length ? { final_approach: finalRows.map((r) => ({ vhf: r.FREQ, note: 'FRQ FINAL APCH (final approach control); no sector of this simulator' })) } : {}),
    ...(apchSectors.length ? { approach_sectors: apchSectors.map(rowSummary) } : {}),
    ...(depSectors.length ? { departure_sectors: depSectors.map(rowSummary) } : {}),
    ...(namedDep.length ? { named_departure_positions: namedDep.map(rowSummary) } : {}),
    ...(starRows.length ? { star_frequencies: starRows.map(rowSummary) } : {}),
    approach_departure: {
      vhf: appRows.length ? appVhf.FREQ : null,
      uhf: appUhf?.FREQ ?? null,
      sectorization: null,
      chart_name: proc.airport_diagram.printed_frequencies?.APPROACH,
      facility: appVhf.FACILITY,
      facility_name: appVhf.FAC_NAME,
      radio_call: appVhf.PRIMARY_APPROACH_RADIO_CALL,
      note: appRows.length ? `FRQ APCH/P DEP/P (${appVhf.FAC_NAME}, serving ${FAA_ID}); no sectorization bearings are published for this row. Approach and departure share this frequency.` : `No combined APCH/P DEP/P row: ${appVhf.FAC_NAME} publishes sector rows (see tracon_vhf_rows: APCH/P NORTH / SOUTH, APCH/P IC WEST, DEP/P, CLASS B by bearing, STAR frequency).`,
    },
    class_c_sector_frequencies: classC.map((r) => ({ freq_mhz: r.FREQ, sectorization: str(r.SECTORIZATION), note: 'FRQ use code CLASS C row (secondary Class C service frequency, named by area, not by bearings)' })),
    emergency: { vhf: emerg?.FREQ ?? null, uhf: emergU?.FREQ ?? null },
    unicom: unicom ? { vhf: unicom.FREQ, note: 'FRQ use code UNICOM' } : { value: 'UNVERIFIED', note: 'No UNICOM row in FRQ.csv. Do not invent one.' },
  },
  all_frequencies_serving_airport: frq.map(frqRow),
  notes: [
    '>=225 MHz are UHF (military) frequencies; the sim ignores UHF.',
    ...atcRmk.map((r) => `NASR ATC remark ${r.REMARK_NO}: ${r.REMARK}`),
    `The approach/departure facility (${appVhf.FACILITY} ${appVhf.FAC_NAME}) is a separate TRACON; its radio call is "${appVhf.PRIMARY_APPROACH_RADIO_CALL}" while the tower call is "${callName}".`,
  ],
};
fs.writeFileSync(path.join(SRC, `${icaoLower}-frequencies.json`), JSON.stringify(frequencies, null, 1) + '\n');

// ---------------------------------------------------------------------------------------------------------------------
// navaids: ILS components, the airport's own navaid(s), navaids referenced by the plates, fixes named on the plates
// ---------------------------------------------------------------------------------------------------------------------
const navBase = table('NAV', 'NAV_BASE.csv');
const navRmk = table('NAV', 'NAV_RMK.csv');
const fixBase = table('FIX', 'FIX_BASE.csv');
const fixNav = table('FIX', 'FIX_NAV.csv');
const fixChrt = table('FIX', 'FIX_CHRT.csv');
const navObj = (r: Row, withRemarks = true): J => ({
  id: r.NAV_ID,
  type: r.NAV_TYPE,
  name: r.NAME,
  status: r.NAV_STATUS,
  freq_mhz: num(r.FREQ),
  channel: str(r.CHAN),
  lat: num(r.LAT_DECIMAL),
  lon: num(r.LONG_DECIMAL),
  elev_ft: num(r.ELEV),
  mag_var: r.MAG_VARN ? `${r.MAG_VARN}${r.MAG_VARN_HEMIS} (${r.MAG_VARN_YEAR})` : null,
  ...(withRemarks ? { remarks: navRmk.filter((m) => m.NAV_ID === r.NAV_ID && m.NAV_TYPE === r.NAV_TYPE).map((m) => m.REMARK) } : {}),
});
const NAV_TYPES_USED = new Set(['VOR', 'VORTAC', 'VOR/DME', 'DME', 'TACAN', 'NDB']);
const referenced: string[] = proc.navaids_referenced as string[];
const primaryId: string = proc.primary_navaid_id;
const primaryRow = navBase.find((r) => r.NAV_ID === primaryId && NAV_TYPES_USED.has(r.NAV_TYPE))!;
const otherNav = referenced
  .filter((id) => id !== primaryId)
  .map((id) => navBase.find((r) => r.NAV_ID === id && NAV_TYPES_USED.has(r.NAV_TYPE)))
  .map((r, i) => {
    if (!r) throw new Error(`navaid ${referenced[i]} not found in NAV_BASE`);
    return navObj(r, false);
  });

const marker = (rwy: string): string => {
  const m = ilsMkr.filter((x) => x.RWY_END_ID === rwy);
  return m.length ? m.map((x) => `${x.ILS_COMP_TYPE_CODE === 'IM' ? 'inner' : x.ILS_COMP_TYPE_CODE === 'MM' ? 'middle' : 'outer'} marker ${x.MARKER_ID_BEACON ? `${x.MARKER_ID_BEACON} ` : ''}(${x.LAT_DECIMAL}, ${x.LONG_DECIMAL}, ${x.COMPONENT_STATUS})`).join('; ') : `none listed in ILS_MKR.csv for ${FAA_ID}`;
};
const ilsPlate: Record<string, J> = proc.ils_plate_data;
const systems = ilsBase.map((b) => {
  const gs = ilsGs.find((g) => g.RWY_END_ID === b.RWY_END_ID);
  const dme = ilsDme.find((d) => d.RWY_END_ID === b.RWY_END_ID) ?? ilsDme.find((d) => d.ILS_LOC_ID === b.ILS_LOC_ID);
  const endId = endKey(b.RWY_END_ID);
  const plate = ilsPlate[endId];
  const rwEnd = endRows.find((e) => e.RWY_END_ID === b.RWY_END_ID);
  return {
    runway_end: b.RWY_END_ID,
    system_type_code: b.SYSTEM_TYPE_CODE,
    system_type_meaning: b.SYSTEM_TYPE_CODE === 'LD' ? 'LD = localizer with DME (NASR code; plates say LOC/DME and ILS/DME)' : b.SYSTEM_TYPE_CODE === 'LS' ? 'LS = localizer/glideslope (ILS) without a collocated DME (NASR code)' : b.SYSTEM_TYPE_CODE,
    loc_ident: b.ILS_LOC_ID,
    plate_ident: plate.plate_ident,
    category: `CAT ${b.CATEGORY}`,
    loc_freq_mhz: num(b.LOC_FREQ),
    dme_channel: dme?.CHANNEL ?? null,
    front_course_mag_deg: num(b.APCH_BEAR),
    mag_var: `${b.MAG_VAR}${b.MAG_VAR_HEMIS}`,
    status: b.COMPONENT_STATUS,
    status_date: b.COMPONENT_STATUS_DATE,
    localizer_antenna: { lat: num(b.LAT_DECIMAL), lon: num(b.LONG_DECIMAL), elev_ft: num(b.SITE_ELEVATION) },
    glideslope: gs ? { angle_deg: num(gs.G_S_ANGLE), freq_mhz: num(gs.G_S_FREQ), type: gs.G_S_TYPE_CODE, antenna: { lat: num(gs.LAT_DECIMAL), lon: num(gs.LONG_DECIMAL), elev_ft: num(gs.SITE_ELEVATION) }, status: gs.COMPONENT_STATUS } : null,
    dme_antenna: dme ? { lat: num(dme.LAT_DECIMAL), lon: num(dme.LONG_DECIMAL), elev_ft: num(dme.SITE_ELEVATION), status: dme.COMPONENT_STATUS } : null,
    marker_beacons: marker(b.RWY_END_ID),
    classification_remark: ilsRmk.filter((r) => r.RWY_END_ID === b.RWY_END_ID).map((r) => r.REMARK),
    approach_lighting: str(rwEnd?.APCH_LGT_SYSTEM_CODE) ?? 'none',
    plate_data: { plate_minima: plate.plate_minima, tdze_plate_ft: plate.tdze_plate_ft },
    plate_data_source: plate.source,
  };
});

// fixes: every 5-letter id named in fixes_and_roles of an instrument approach / STAR / DP of the procedures file
const roleMap = new Map<string, Record<string, string | null>>();
const addRole = (fix: string, chart: string, role: string): void => {
  const m = roleMap.get(fix) ?? {};
  m[chart] = m[chart] && m[chart] !== role && !m[chart]!.split('; ').includes(role) ? `${m[chart]}; ${role}` : role;
  roleMap.set(fix, m);
};
for (const a of proc.instrument_approaches as J[]) {
  for (const fr of a.fixes_and_roles as { fix: string; role: string }[]) {
    const tok = fr.fix.match(/\b[A-Z]{5}\b/)?.[0];
    if (tok && fixBase.some((f) => f.FIX_ID === tok)) addRole(tok, a.chart_name, fr.role);
  }
}
// STAR transcriptions (`stars[].star`): every fix on a transition, on a runway leg or in the approach join of the STAR, with its role on that chart
for (const st of (proc.stars ?? []) as J[]) {
  const t = st.star as J | undefined;
  if (!t) continue;
  const chart = st.chart_name as string;
  for (const tr of t.transitions as J[]) {
    (tr.fixes as string[]).forEach((f, i) => {
      if (fixBase.some((x) => x.FIX_ID === f)) addRole(f, chart, i === 0 ? `${tr.name as string} transition entry fix` : `${tr.name as string} transition`);
    });
  }
  for (const rw of t.runways as J[]) {
    (rw.fixes as string[]).forEach((f, i, a) => {
      if (fixBase.some((x) => x.FIX_ID === f)) addRole(f, chart, i === 0 ? 'common fix' : i === a.length - 1 ? `runway ${rw.runway_end as string} end of the procedure (IAF of the expected approach)` : `runway ${rw.runway_end as string} leg`);
    });
  }
}
const fixes = [...roleMap.keys()].sort().map((id) => {
  const rows = fixBase.filter((f) => f.FIX_ID === id);
  const f = rows.length === 1 ? rows[0] : rows.reduce((best, r) => (Math.hypot(Number(r.LAT_DECIMAL) - Number(apt.LAT_DECIMAL), Number(r.LONG_DECIMAL) - Number(apt.LONG_DECIMAL)) < Math.hypot(Number(best.LAT_DECIMAL) - Number(apt.LAT_DECIMAL), Number(best.LONG_DECIMAL) - Number(apt.LONG_DECIMAL)) ? r : best));
  return {
    id,
    lat: num(f.LAT_DECIMAL),
    lon: num(f.LONG_DECIMAL),
    fix_use_code: f.FIX_USE_CODE,
    fix_use_meaning: null,
    artcc_low: f.ARTCC_ID_LOW,
    charted_on: [...new Set(fixChrt.filter((c) => c.FIX_ID === id && c.STATE_CODE === f.STATE_CODE).map((c) => c.CHARTING_TYPE_DESC))].join(', '),
    reference_navaid_radial_distance: fixNav.filter((n) => n.FIX_ID === id && n.STATE_CODE === f.STATE_CODE).map((n) => ({ nav: n.NAV_ID, nav_type: n.NAV_TYPE, bearing_deg: num(n.BEARING), dist_nm: num(n.DISTANCE) })),
    roles_on_plates: roleMap.get(id),
    source: 'NASR FIX_BASE.csv / FIX_NAV.csv / FIX_CHRT.csv; roles read from the d-TPP plate images (human transcription of PDF)',
  };
});

const navaids = {
  _provenance: {
    sources: [`FAA NASR 28-day subscription, cycle effective ${CYCLE}; NAV_CSV, ILS_CSV, FIX_CSV zips (https://nfdc.faa.gov/webContent/28DaySub/extra/01_Oct_2026_<NAME>_CSV.zip)`, `FAA d-TPP cycle ${proc._provenance.cycle} approach plate PDFs for roles/minima`],
    ...provenanceBase,
    method: `Extracted by scripts/extract-nasr-airport.ts ${FAA_ID} ${ICAO}. ILS rows with ARPT_ID == ${FAA_ID}; navaids named in ${icaoLower}-procedures.json navaids_referenced; fixes = every 5-letter fix named in fixes_and_roles of an instrument approach and every fix of a STAR transcription (stars[].star) in that file (each also checked against NASR FIX_BASE and, in charted_on, FIX_CHRT).`,
    raw: `raw/nasr_${CYCLE}/, raw/${icaoLower}_dtpp_2610_pdfs/`,
  },
  primary_navaid: { ...navObj(primaryRow), tacan_dme_channel: primaryRow.CHAN, location_note: proc.primary_navaid_note },
  ils_localizers: {
    runways_with_ils: ilsBase.map((b) => endKey(b.RWY_END_ID)),
    runways_without_ils_or_loc: runways.flatMap((r) => r.ends.map((e) => endKey(e.id))).filter((id) => !ilsByEnd[id]),
    note: proc.ils_note,
    systems,
  },
  other_navaids_referenced: otherNav,
  fixes_named_on_approach_charts: fixes,
  unverified: proc.navaid_unverified ?? [],
};
fs.writeFileSync(path.join(SRC, `${icaoLower}-navaids.json`), JSON.stringify(navaids, null, 1) + '\n');
console.log(`${ICAO}: facility (${runways.length} runways), frequencies (${frq.length} rows), navaids (${systems.length} ILS, ${otherNav.length + 1} navaids, ${fixes.length} fixes)`);
