/**
 * KPHL (Philadelphia International) dataset loader. The JSON is produced by `npx tsx scripts/build-airport.ts KPHL`
 * from the verified FAA/OSM sources in `data/sources/`; never edit it by hand.
 */
import type { KacyAirport } from '../types';
import { notPreloadedError } from '../lazy';

let cached: KacyAirport | undefined;
let raw: unknown;

/** Structural sanity check run once on load (cheap; catches a stale or truncated build). */
function rehydrate(raw: unknown): KacyAirport {
  const ap = raw as KacyAirport;
  if (ap.icao !== 'KPHL' || ap.runways.length !== 4) throw new Error('kphl.airport.json is not a KPHL build; run `npx tsx scripts/build-airport.ts KPHL`');
  const nodes = ap.taxiwayGraph.nodes;
  for (const e of ap.taxiwayGraph.edges) {
    if (!nodes[e.from] || !nodes[e.to]) throw new Error(`edge ${e.id} references a missing node`);
  }
  for (const p of ap.parking) {
    if (p.nodeId && !nodes[p.nodeId]) throw new Error(`parking ${p.id} references missing node ${p.nodeId}`);
  }
  return ap;
}

/** The KPHL `Airport` (shared, read-only; `{ fresh: true }` returns a private deep copy). */
export function loadKphl(opts: { fresh?: boolean } = {}): KacyAirport {
  if (raw === undefined) throw notPreloadedError('KPHL');
  if (opts.fresh) return rehydrate(structuredClone(raw));
  cached ??= rehydrate(raw);
  return cached;
}

/** Loads the KPHL dataset as its own chunk (dynamic import) and fills the cache behind the synchronous `loadKphl()`. Idempotent. */
export async function preloadKphl(): Promise<KacyAirport> {
  if (raw === undefined) raw = (await import('./kphl.airport.json')).default;
  cached ??= rehydrate(raw);
  return cached;
}
