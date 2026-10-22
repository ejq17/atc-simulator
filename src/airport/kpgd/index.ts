/**
 * KPGD (Punta Gorda Airport) dataset loader. The JSON is produced by `npx tsx scripts/build-airport.ts KPGD`
 * from the verified FAA/OSM sources in `data/sources/`; never edit it by hand.
 */
import type { KacyAirport } from '../types';
import kpgdJson from './kpgd.airport.json';

let cached: KacyAirport | undefined;

/** Structural sanity check run once on load (cheap; catches a stale or truncated build). */
function rehydrate(raw: unknown): KacyAirport {
  const ap = raw as KacyAirport;
  if (ap.icao !== 'KPGD' || ap.runways.length !== 2) throw new Error('kpgd.airport.json is not a KPGD build; run `npx tsx scripts/build-airport.ts KPGD`');
  const nodes = ap.taxiwayGraph.nodes;
  for (const e of ap.taxiwayGraph.edges) {
    if (!nodes[e.from] || !nodes[e.to]) throw new Error(`edge ${e.id} references a missing node`);
  }
  for (const p of ap.parking) {
    if (p.nodeId && !nodes[p.nodeId]) throw new Error(`parking ${p.id} references missing node ${p.nodeId}`);
  }
  return ap;
}

/** The KPGD `Airport` (shared, read-only; `{ fresh: true }` returns a private deep copy). */
export function loadKpgd(opts: { fresh?: boolean } = {}): KacyAirport {
  if (opts.fresh) return rehydrate(structuredClone(kpgdJson));
  cached ??= rehydrate(kpgdJson);
  return cached;
}
