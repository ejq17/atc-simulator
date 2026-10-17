/**
 * KACY dataset loader. The JSON is produced by `scripts/build-kacy-airport.ts`
 * from the verified FAA/OSM sources in `data/sources/`; never edit it by hand.
 */
import type { Airport } from '../../sim/types';
import type { KacyAirport } from '../types';
import kacyJson from './kacy.airport.json';

let cached: KacyAirport | undefined;

/** Structural sanity check run once on load (cheap; catches a stale or truncated build). */
function rehydrate(raw: unknown): KacyAirport {
  const ap = raw as KacyAirport;
  if (ap.icao !== 'KACY' || ap.runways.length !== 2) throw new Error('kacy.airport.json is not a KACY build; run `npx tsx scripts/build-kacy-airport.ts`');
  const nodes = ap.taxiwayGraph.nodes;
  for (const e of ap.taxiwayGraph.edges) {
    if (!nodes[e.from] || !nodes[e.to]) throw new Error(`edge ${e.id} references a missing node`);
  }
  for (const p of ap.parking) {
    if (p.nodeId && !nodes[p.nodeId]) throw new Error(`parking ${p.id} references missing node ${p.nodeId}`);
  }
  return ap;
}

/**
 * The KACY `Airport`. The returned object is shared and must be treated as
 * read-only; pass `{ fresh: true }` for a private deep copy.
 */
export function loadKacy(opts: { fresh?: boolean } = {}): KacyAirport {
  if (opts.fresh) return rehydrate(structuredClone(kacyJson));
  cached ??= rehydrate(kacyJson);
  return cached;
}

/** Type-level reminder that `KacyAirport` is an `Airport`. */
export const asAirport = (a: KacyAirport): Airport => a;
