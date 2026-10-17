/**
 * Real KACY airport with the plate transcriptions (missed approach / holding / minima text) guaranteed present.
 * The airport agent is adding these fields to kacy.airport.json; until they are there they are filled in from
 * data/sources/kacy-procedures.json (same transcription), matched by chart name. Read-only: returns a deep copy.
 */
import { loadKacy } from '../../airport';
import type { Airport } from '../types';
import plates from '../../../data/sources/kacy-procedures.json';

interface Plate { chart_name: string; missed_approach?: string; holding?: string; minima_summary?: string }

const clean = (s: string | undefined): string | undefined => (s && s.trim() !== '-' ? s : undefined);

export function kacyWithPlates(): Airport {
  const ap = structuredClone(loadKacy()) as Airport;
  const byName = new Map<string, Plate>();
  for (const p of (plates as unknown as { instrument_approaches: Plate[] }).instrument_approaches) byName.set(p.chart_name.toUpperCase(), p);
  for (const proc of ap.procedures) {
    const pl = byName.get(proc.name.toUpperCase());
    if (!pl) continue;
    proc.missedApproachText ??= clean(pl.missed_approach);
    proc.holdingText ??= clean(pl.holding);
    proc.minimaText ??= clean(pl.minima_summary);
  }
  return ap;
}
