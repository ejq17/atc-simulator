/**
 * Typed index of the official FAA d-TPP charts per airport (KACY, KMHT, KBOS, KPGD, KPHL).
 *
 * Built at import time from `data/sources/<icao>-procedures.json` (verified d-TPP
 * cycle 2610, every PDF URL checked HTTP 200 by the research pass). Nothing is
 * invented here: a chart exists in this index only if it is a record in that
 * file, and every entry carries `isOfficialFaa: true` plus the official
 * aeronav.faa.gov URL.
 */
import rawProcedures from '../../data/sources/kacy-procedures.json';
import rawKmhtProcedures from '../../data/sources/kmht-procedures.json';
import rawKbosProcedures from '../../data/sources/kbos-procedures.json';
import rawKpgdProcedures from '../../data/sources/kpgd-procedures.json';
import rawKphlProcedures from '../../data/sources/kphl-procedures.json';

export type ChartCategory = 'DIAGRAM' | 'IAP' | 'DP' | 'STAR' | 'HOT_SPOT' | 'LAHSO' | 'MINIMUMS';

export interface ChartEntry {
  /** Stable id: the d-TPP file stem, e.g. "00669AD". */
  id: string;
  /** Official chart title, e.g. "ILS Z OR LOC Z RWY 13". */
  name: string;
  category: ChartCategory;
  /** Runway designator for approaches ("04", "13", "22", "31"); undefined otherwise. */
  runway?: string;
  /** Approach type text from the data, e.g. "RNAV (GPS)". */
  approachType?: string;
  pdfName: string;
  /** Official FAA PDF URL on aeronav.faa.gov. */
  pdfUrl: string;
  /** d-TPP cycle, e.g. "2610". */
  cycle: string;
  /** ISO dates (UTC), e.g. "2026-10-01". The chart is effective from 0901Z. */
  effectiveFrom: string;
  effectiveTo: string;
  /** Amendment printed on the plate, where the data records one. */
  printedAmendment?: string;
  /** Short caveat from the data (e.g. authorization required). */
  note?: string;
  isOfficialFaa: true;
}

export interface ChartGroup {
  id: string;
  label: string;
  category: ChartCategory;
  runway?: string;
  charts: ChartEntry[];
}

export interface CycleInfo {
  cycle: string;
  effectiveFrom: string;
  effectiveTo: string;
  /** "FAA d-TPP cycle 2610, effective 2026-10-01 to 2026-10-29" */
  label: string;
  /** Instant the cycle expires (0901Z on effectiveTo). */
  expiresAtMs: number;
  retrieved: string;
}

// --- minimal structural view of the JSON (only the fields we read) ----------
interface PdfRef { url: string }
interface IapRecord {
  chart_name: string;
  pdf_name: string;
  runway: string;
  approach_type: string;
  printed_amendment_on_plate?: string | null;
  pdf: PdfRef;
}
interface SimpleChartRecord { chart_name: string; pdf_name: string; pdf: PdfRef }
interface ProceduresFile {
  _provenance: { cycle: string; effective_from: string; effective_to: string; retrieved: string; volume?: string };
  airport_diagram: SimpleChartRecord;
  instrument_approaches: IapRecord[];
  departure_procedures: Array<{ chart_name: string; type?: string; faa_id?: string; printed_date?: string; pdf: PdfRef; continuation_pdf?: PdfRef & { local_file?: string }; radar_required?: boolean }>;
  stars?: Array<{ chart_name: string; pdf_name: string; type?: string; pdf: PdfRef; continuation_pdf?: PdfRef }>;
  /** Visual approach charts (KPHL: d-TPP chart code IAP, not instrument procedures). */
  visual_approaches?: Array<{ chart_name: string; pdf_name: string; pdf: PdfRef }>;
  supporting_charts: {
    /** Holds both the TAKEOFF MINIMUMS and ALTERNATE MINIMUMS booklet pages. */
    takeoff_minimums_pdf: SimpleChartRecord[];
    lahso: SimpleChartRecord[];
    hot_spot: SimpleChartRecord[];
  };
}

const DATASETS: Record<string, ProceduresFile> = {
  KACY: rawProcedures as unknown as ProceduresFile,
  KMHT: rawKmhtProcedures as unknown as ProceduresFile,
  KBOS: rawKbosProcedures as unknown as ProceduresFile,
  KPGD: rawKpgdProcedures as unknown as ProceduresFile,
  KPHL: rawKphlProcedures as unknown as ProceduresFile,
};
const DEFAULT_ICAO = 'KACY';

const isoDate = (s: string): string => s.slice(0, 10);

function cycleOf(data: ProceduresFile): CycleInfo {
  const p = data._provenance;
  const effectiveFrom = isoDate(p.effective_from);
  const effectiveTo = isoDate(p.effective_to);
  return {
    cycle: p.cycle,
    effectiveFrom,
    effectiveTo,
    label: `FAA d-TPP cycle ${p.cycle}, effective ${effectiveFrom} to ${effectiveTo}`,
    expiresAtMs: Date.parse(`${effectiveTo}T09:01:00Z`),
    retrieved: p.retrieved,
  };
}

/** The charted cycle of the default airport (all airports are built from the same d-TPP cycle). */
export const CYCLE: CycleInfo = cycleOf(DATASETS[DEFAULT_ICAO]);

/** Charted cycle of an airport's chart set. */
export function cycleFor(icao: string = DEFAULT_ICAO): CycleInfo {
  return cycleOf(datasetFor(icao));
}

function datasetFor(icao: string): ProceduresFile {
  return DATASETS[icao.toUpperCase()] ?? DATASETS[DEFAULT_ICAO];
}

/** True while `nowMs` is inside the charted cycle's validity. */
export function isCycleCurrent(nowMs: number = Date.now()): boolean {
  return nowMs < CYCLE.expiresAtMs;
}

function stem(pdfName: string): string {
  return pdfName.replace(/\.pdf$/i, '');
}

/** ILS first, then RNAV (GPS), RNAV (RNP), VOR/TACAN, helicopter last. */
function approachRank(name: string): number {
  const n = name.toUpperCase();
  if (n.startsWith('COPTER')) return 9;
  if (n.includes('ILS')) return n.startsWith('HI-') ? 1 : 0;
  if (n.includes('RNP')) return 4;
  if (n.includes('RNAV')) return 3;
  if (n.includes('VOR') || n.includes('TACAN')) return n.startsWith('HI-') ? 6 : 5;
  if (n.includes('VISUAL')) return 7;
  return 8;
}

/** "NE-2 (printed on charts as ...)" -> "Northeast 2". */
function volumeName(volume: string): string {
  const m = /^NE-(\d)/.exec(volume);
  return m ? `Northeast ${m[1]}` : volume.split(' ')[0];
}

/** Sort key of a runway end id: number, then L < C < R ("9L" < "9R" < "17" < "27L"). */
function runwayOrder(runway: string | undefined): number {
  const m = /^(\d+)([LCR]?)$/.exec(runway ?? '');
  return m ? Number(m[1]) * 10 + 'LCR'.indexOf(m[2]) + 1 : 9999;
}

function buildCharts(data: ProceduresFile, icao: string): ChartEntry[] {
  const cycle = cycleOf(data);
  const base = (rec: { pdf_name?: string; pdf: PdfRef }, name: string, category: ChartCategory): ChartEntry => {
    const pdfName = rec.pdf_name ?? rec.pdf.url.split('/').pop() ?? '';
    return {
      id: stem(pdfName),
      name,
      category,
      pdfName,
      pdfUrl: rec.pdf.url,
      cycle: cycle.cycle,
      effectiveFrom: cycle.effectiveFrom,
      effectiveTo: cycle.effectiveTo,
      isOfficialFaa: true,
    };
  };
  const out: ChartEntry[] = [];

  out.push(base(data.airport_diagram, data.airport_diagram.chart_name, 'DIAGRAM'));

  const iaps = data.instrument_approaches
    .map((r): ChartEntry => {
      const e = base(r, r.chart_name, 'IAP');
      e.runway = r.runway;
      e.approachType = r.approach_type;
      if (r.printed_amendment_on_plate) e.printedAmendment = r.printed_amendment_on_plate;
      if (/authorization required|special authorization|special aircrew/i.test(r.approach_type)) e.note = 'Special aircraft and aircrew authorization required.';
      if (/^HI-/i.test(r.chart_name)) e.note = 'High-altitude (USAF-designated) procedure; DME or radar required.';
      if (/^COPTER/i.test(r.chart_name)) e.note = 'Helicopter procedure.';
      return e;
    })
    .concat(
      (data.visual_approaches ?? []).map((r): ChartEntry => {
        const e = base(r, r.chart_name, 'IAP');
        e.runway = /RWY\s+0?(\d+[LRC]?)/i.exec(r.chart_name)?.[1];
        e.approachType = 'Visual approach';
        e.note = 'Visual approach chart (not an instrument procedure).';
        return e;
      }),
    )
    .sort((a, b) => runwayOrder(a.runway) - runwayOrder(b.runway) || approachRank(a.name) - approachRank(b.name) || a.name.localeCompare(b.name));
  out.push(...iaps);

  for (const dp of data.departure_procedures) {
    const e = base(dp, dp.chart_name, 'DP');
    e.note = /radar vector/i.test(dp.type ?? 'radar vector') ? 'Radar vector departure (runway heading, then vectors); not a SID with a named route.' : (dp.type ?? '');
    if (dp.printed_date) e.printedAmendment = dp.printed_date;
    out.push(e);
    // a second PDF page of the same chart (KPHL: the departure route description page)
    if (dp.continuation_pdf) out.push({ ...base({ pdf: dp.continuation_pdf }, `${dp.chart_name}, CONT.1`, 'DP'), note: 'Continuation page (departure route description).' });
  }
  for (const st of data.stars ?? []) {
    out.push({ ...base(st, st.chart_name, 'STAR'), ...(st.type ? { note: st.type } : {}) });
    if (st.continuation_pdf) out.push({ ...base({ pdf: st.continuation_pdf }, `${st.chart_name}, CONT.1`, 'STAR'), note: 'Continuation page (arrival route description).' });
  }
  for (const r of data.supporting_charts.hot_spot) out.push(base(r, r.chart_name, 'HOT_SPOT'));
  for (const r of data.supporting_charts.lahso) out.push(base(r, r.chart_name, 'LAHSO'));
  for (const r of data.supporting_charts.takeoff_minimums_pdf) {
    out.push({ ...base(r, r.chart_name, 'MINIMUMS'), note: `${volumeName(data._provenance.volume ?? '')} booklet page (covers many airports; find the ${icao} entry).` });
  }
  return out;
}

const cache = new Map<string, readonly ChartEntry[]>();
function chartsOf(icao: string): readonly ChartEntry[] {
  const key = DATASETS[icao.toUpperCase()] ? icao.toUpperCase() : DEFAULT_ICAO;
  let c = cache.get(key);
  if (!c) cache.set(key, (c = Object.freeze(buildCharts(DATASETS[key], key))));
  return c;
}

export const CATEGORY_LABELS: Record<ChartCategory, string> = {
  DIAGRAM: 'Airport Diagram',
  IAP: 'Instrument Approaches',
  DP: 'Departure Procedures',
  STAR: 'Arrival Procedures',
  HOT_SPOT: 'Hot Spots',
  LAHSO: 'LAHSO',
  MINIMUMS: 'Takeoff / Alternate Minimums',
};

/** Flat list in display order: diagram, IAPs (by runway), DP, STAR, hot spot, LAHSO, minimums. */
export function listCharts(icao: string = DEFAULT_ICAO): ChartEntry[] {
  return chartsOf(icao).map((c) => ({ ...c }));
}

/** Charts grouped for the side list. IAPs get one group per runway. */
export function listChartGroups(icao: string = DEFAULT_ICAO): ChartGroup[] {
  const groups: ChartGroup[] = [];
  for (const c of chartsOf(icao)) {
    const id = c.category === 'IAP' ? `IAP-${c.runway}` : c.category;
    let g = groups.find((x) => x.id === id);
    if (!g) {
      g = {
        id,
        category: c.category,
        runway: c.runway,
        label: c.category === 'IAP' ? `Approaches - Runway ${c.runway}` : CATEGORY_LABELS[c.category],
        charts: [],
      };
      groups.push(g);
    }
    g.charts.push({ ...c });
  }
  return groups;
}

export function getChart(id: string, icao: string = DEFAULT_ICAO): ChartEntry | undefined {
  const c = chartsOf(icao).find((x) => x.id === id);
  return c ? { ...c } : undefined;
}

export function chartsByCategory(category: ChartCategory, icao: string = DEFAULT_ICAO): ChartEntry[] {
  return chartsOf(icao).filter((c) => c.category === category).map((c) => ({ ...c }));
}
