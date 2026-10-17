import type { Airport, DataProvenance } from '../../sim/types';

export interface ProvenanceSummary {
  nasrEffective?: string;
  dtppCycle?: string;
  dtppFrom?: string;
  dtppTo?: string;
  footer: string;
}

/**
 * Footer text for the setup screen, derived from the airport's recorded provenance rather than hard-coded:
 * "FAA NASR 2026-10-01, d-TPP cycle 2610 (effective 2026-10-01 to 2026-10-29); taxiway geometry © OpenStreetMap contributors (ODbL)".
 */
export function summariseProvenance(airport: Pick<Airport, 'provenance'>): ProvenanceSummary {
  const list: DataProvenance[] = airport.provenance ?? [];
  const nasr = list.find((p) => /^FAA NASR/i.test(p.source));
  // The d-TPP record itself, not a NASR record that merely mentions d-TPP in a cross-check note.
  const dtpp = list.find((p) => /^FAA d-TPP/i.test(p.source) && /cycle\s*\d{4}(?![\d-])/i.test(p.source));
  const cycle = dtpp?.source.match(/cycle\s*(\d{4})(?![\d-])/i)?.[1];
  const nasrDate = nasr?.effectiveFrom ?? nasr?.source.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const parts: string[] = [];
  parts.push(`FAA NASR ${nasrDate ?? 'cycle unknown'}`);
  parts.push(`d-TPP cycle ${cycle ?? 'unknown'}${dtpp?.effectiveFrom && dtpp.effectiveTo ? ` (effective ${dtpp.effectiveFrom} to ${dtpp.effectiveTo})` : ''}`);
  const osm = list.some((p) => /OpenStreetMap/i.test(p.source));
  const footer = `${parts.join(', ')}${osm ? '; taxiway geometry © OpenStreetMap contributors (ODbL)' : ''}`;
  return { nasrEffective: nasrDate, dtppCycle: cycle, dtppFrom: dtpp?.effectiveFrom, dtppTo: dtpp?.effectiveTo, footer };
}
