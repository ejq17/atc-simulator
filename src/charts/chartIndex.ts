/**
 * Typed index of the official FAA d-TPP charts for KACY.
 *
 * Built at import time from `data/sources/kacy-procedures.json` (verified d-TPP
 * cycle 2610, every PDF URL checked HTTP 200 by the research pass). Nothing is
 * invented here: a chart exists in this index only if it is a record in that
 * file, and every entry carries `isOfficialFaa: true` plus the official
 * aeronav.faa.gov URL.
 */
import rawProcedures from '../../data/sources/kacy-procedures.json';

export type ChartCategory = 'DIAGRAM' | 'IAP' | 'DP' | 'HOT_SPOT' | 'LAHSO' | 'MINIMUMS';

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
  _provenance: { cycle: string; effective_from: string; effective_to: string; retrieved: string };
  airport_diagram: SimpleChartRecord;
  instrument_approaches: IapRecord[];
  departure_procedures: Array<{ chart_name: string; faa_id?: string; printed_date?: string; pdf: PdfRef; radar_required?: boolean }>;
  supporting_charts: {
    /** Holds both the TAKEOFF MINIMUMS and ALTERNATE MINIMUMS booklet pages. */
    takeoff_minimums_pdf: SimpleChartRecord[];
    lahso: SimpleChartRecord[];
    hot_spot: SimpleChartRecord[];
  };
}

const data = rawProcedures as unknown as ProceduresFile;

const isoDate = (s: string): string => s.slice(0, 10);

export const CYCLE: CycleInfo = (() => {
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
})();

/** True while `nowMs` is inside the charted cycle's validity. */
export function isCycleCurrent(nowMs: number = Date.now()): boolean {
  return nowMs < CYCLE.expiresAtMs;
}

function stem(pdfName: string): string {
  return pdfName.replace(/\.pdf$/i, '');
}

function base(rec: { pdf_name?: string; pdf: PdfRef }, name: string, category: ChartCategory): ChartEntry {
  const pdfName = rec.pdf_name ?? rec.pdf.url.split('/').pop() ?? '';
  return {
    id: stem(pdfName),
    name,
    category,
    pdfName,
    pdfUrl: rec.pdf.url,
    cycle: CYCLE.cycle,
    effectiveFrom: CYCLE.effectiveFrom,
    effectiveTo: CYCLE.effectiveTo,
    isOfficialFaa: true,
  };
}

const RUNWAY_ORDER = ['04', '13', '22', '31'];

/** ILS first, then RNAV (GPS), RNAV (RNP), VOR/TACAN, helicopter last. */
function approachRank(name: string): number {
  const n = name.toUpperCase();
  if (n.startsWith('COPTER')) return 9;
  if (n.includes('ILS')) return n.startsWith('HI-') ? 1 : 0;
  if (n.includes('RNP')) return 4;
  if (n.includes('RNAV')) return 3;
  if (n.includes('VOR') || n.includes('TACAN')) return n.startsWith('HI-') ? 6 : 5;
  return 8;
}

function buildCharts(): ChartEntry[] {
  const out: ChartEntry[] = [];

  out.push(base(data.airport_diagram, data.airport_diagram.chart_name, 'DIAGRAM'));

  const iaps = data.instrument_approaches
    .map((r): ChartEntry => {
      const e = base(r, r.chart_name, 'IAP');
      e.runway = r.runway;
      e.approachType = r.approach_type;
      if (r.printed_amendment_on_plate) e.printedAmendment = r.printed_amendment_on_plate;
      if (/authorization required/i.test(r.approach_type)) e.note = 'Special aircraft and aircrew authorization required (RNP AR).';
      if (/^HI-/i.test(r.chart_name)) e.note = 'High-altitude (USAF-designated) procedure; DME or radar required.';
      if (/^COPTER/i.test(r.chart_name)) e.note = 'Helicopter procedure.';
      return e;
    })
    .sort((a, b) => {
      const ra = RUNWAY_ORDER.indexOf(a.runway ?? '');
      const rb = RUNWAY_ORDER.indexOf(b.runway ?? '');
      return ra - rb || approachRank(a.name) - approachRank(b.name) || a.name.localeCompare(b.name);
    });
  out.push(...iaps);

  for (const dp of data.departure_procedures) {
    const e = base(dp, dp.chart_name, 'DP');
    e.note = 'Radar vector departure (runway heading, then vectors); not a SID with a named route.';
    if (dp.printed_date) e.printedAmendment = dp.printed_date;
    out.push(e);
  }
  for (const r of data.supporting_charts.hot_spot) out.push(base(r, r.chart_name, 'HOT_SPOT'));
  for (const r of data.supporting_charts.lahso) out.push(base(r, r.chart_name, 'LAHSO'));
  for (const r of data.supporting_charts.takeoff_minimums_pdf) {
    out.push({ ...base(r, r.chart_name, 'MINIMUMS'), note: 'Northeast 2 booklet page (covers many airports; find the KACY entry).' });
  }
  return out;
}

const CHARTS: readonly ChartEntry[] = Object.freeze(buildCharts());

export const CATEGORY_LABELS: Record<ChartCategory, string> = {
  DIAGRAM: 'Airport Diagram',
  IAP: 'Instrument Approaches',
  DP: 'Departure Procedures',
  HOT_SPOT: 'Hot Spots',
  LAHSO: 'LAHSO',
  MINIMUMS: 'Takeoff / Alternate Minimums',
};

/** Flat list in display order: diagram, IAPs (by runway), DP, hot spot, LAHSO, minimums. */
export function listCharts(): ChartEntry[] {
  return CHARTS.map((c) => ({ ...c }));
}

/** Charts grouped for the side list. IAPs get one group per runway. */
export function listChartGroups(): ChartGroup[] {
  const groups: ChartGroup[] = [];
  for (const c of CHARTS) {
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

export function getChart(id: string): ChartEntry | undefined {
  const c = CHARTS.find((x) => x.id === id);
  return c ? { ...c } : undefined;
}

export function chartsByCategory(category: ChartCategory): ChartEntry[] {
  return CHARTS.filter((c) => c.category === category).map((c) => ({ ...c }));
}
