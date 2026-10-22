/**
 * Seeded airport events for free play: a runway inspection that closes a runway for a few minutes at a quiet time, a taxiway closure, and bird
 * activity. They are `ScenarioEvent`s ('closure', 'birds') applied by `createScenarioEventRunner` (events.ts) and are a pure function of the seed
 * (own mulberry32 stream) and, for the bird activity, of the session's start time (season and time of day).
 *
 * What is sourced and what is not:
 *  - The ATIS / advisory wording and the requirement to give airport conditions and bird activity are FAA text (JO 7110.65 2-1-23, 2-9-3, 3-3-1,
 *    3-3-2); a runway is closed legally by the airport management (3-3-1 NOTE), which is what the inspection event stands for.
 *  - How OFTEN these things happen, how long they last, and the season / time-of-day weights of bird activity are SIMULATOR DESIGN CHOICES, not FAA
 *    statistics (no source was verified; stated in docs/BEHAVIOUR-ACCURACY.md). The weights only follow the commonly known pattern that bird activity is
 *    higher in the spring and fall migration months and around dawn and dusk.
 */
import type { Airport, ClosureSpec } from '../../sim/types';
import { mulberry32 } from '../../sim/rng';
import type { Rng } from '../../sim/rng';
import { findRunwayEnd } from '../../sim/runways';
import { shortestDistances } from '../../sim/pathfinding';
import { runwayHoldCandidates } from '../../sim/holdSelection';
import { localHourAt } from '../trafficDensity';
import type { ScenarioEvent } from '../types';

export interface AirportEventOptions {
  /** Wall-clock UTC ms of scenario time 0; enables the season / time-of-day weighting of bird activity (unset: neutral weights). */
  startUtcMs?: number;
  /** Runway ends in use at the start (an inspection prefers the runway in use). */
  active: { departing: string[]; landing: string[] };
  /** Closures already set up (setup-screen options): not closed a second time, and the airport must stay connected. */
  closures?: readonly ClosureSpec[];
}

/** Month weights 0..1 for bird activity: spring (Mar-May) and fall (Aug-Nov) migration high, summer middling, winter low (a design choice). */
export const BIRD_MONTH_WEIGHT: readonly number[] = [0.25, 0.25, 0.8, 1, 1, 0.6, 0.6, 0.9, 1, 1, 0.9, 0.3];

/** Time-of-day factor: dawn / dusk (local 5-8 and 16-19 h) busiest, daytime normal, night low (a design choice). */
export function birdTimeFactor(localHour: number): number {
  if ((localHour >= 5 && localHour < 8) || (localHour >= 16 && localHour < 19)) return 1.4;
  if (localHour >= 8 && localHour < 16) return 1;
  return 0.4;
}

/** Probability that a session sees bird activity. Neutral 0.2 without a start time. */
export function birdActivityProbability(utcMs?: number, timeZone?: string): number {
  if (utcMs === undefined) return 0.2;
  const month = new Date(utcMs).getUTCMonth();
  return Math.max(0, Math.min(0.7, 0.3 * BIRD_MONTH_WEIGHT[month] * birdTimeFactor(localHourAt(utcMs, timeZone))));
}

const BIRD_PHRASES = ['flocks of small birds', 'a flock of geese', 'numerous flocks of ducks'];

/** Taxiways whose closure keeps every parking position connected to a hold of each active departure runway (and no one-way trap). */
const closableCache = new WeakMap<Airport, Map<string, string[]>>();

export function closableTaxiways(airport: Airport, active: { departing: string[]; landing: string[] }, alreadyClosed: readonly string[] = []): string[] {
  const key = `${[...active.departing].sort().join(',')}|${[...active.landing].sort().join(',')}|${[...alreadyClosed].sort().join(',')}`;
  let per = closableCache.get(airport);
  if (!per) closableCache.set(airport, (per = new Map()));
  const hit = per.get(key);
  if (hit) return hit;
  const out = computeClosableTaxiways(airport, active, alreadyClosed);
  per.set(key, out);
  return out;
}

function computeClosableTaxiways(airport: Airport, active: { departing: string[]; landing: string[] }, alreadyClosed: readonly string[]): string[] {
  const graph = airport.taxiwayGraph;
  const names = [...new Set(graph.edges.map((e) => e.taxiway.toUpperCase()).filter((t) => !/^RWY/i.test(t)))].sort();
  const runwayIds = airport.runways.map((r) => r.id);
  const ends = [...new Set([...active.departing, ...active.landing])];
  const out: string[] = [];
  for (const t of names) {
    if (alreadyClosed.includes(t)) continue;
    const avoid = new Set([...alreadyClosed, t]);
    let ok = true;
    for (const e of ends) {
      const g = findRunwayEnd(airport, e);
      if (!g) continue;
      const holds = runwayHoldCandidates(airport, g).filter((h) => !h.taxiways.some((x) => avoid.has(x.toUpperCase())));
      if (!holds.length) { ok = false; break; }
      for (const p of airport.parking) {
        const dm = shortestDistances(graph, p.nodeId, { allowedRunwayIds: runwayIds, avoidTaxiways: avoid });
        if (!holds.some((h) => dm.has(h.id))) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) out.push(t);
  }
  return out;
}

export function buildAirportEvents(airport: Airport, seed: number, o: AirportEventOptions): ScenarioEvent[] {
  const rng: Rng = mulberry32((seed ^ 0xa17b0e57) >>> 0);
  const events: ScenarioEvent[] = [];
  const setupRunways = new Set((o.closures ?? []).filter((c) => c.kind === 'RUNWAY').map((c) => airport.runways.find((r) => r.id === c.ident || r.ends.some((e) => e.id === c.ident))?.id));
  const setupTaxiways = (o.closures ?? []).filter((c) => c.kind === 'TAXIWAY').map((c) => c.ident.toUpperCase());

  // Runway inspection by airport operations (JO 7110.65 3-3-1 NOTE: only the airport management can close a runway).
  const candidates = airport.runways.filter((r) => !setupRunways.has(r.id));
  const roll = rng();
  const atMin = 8 + Math.floor(rng() * 28);
  const durMin = 4 + Math.floor(rng() * 5);
  const pick = rng();
  if (roll < 0.5 && candidates.length > 1) {
    const activeId = findRunwayEnd(airport, o.active.landing[0] ?? o.active.departing[0])?.runway.id;
    const inUse = candidates.find((r) => r.id === activeId);
    const others = candidates.filter((r) => r.id !== activeId);
    const rw = inUse && (pick < 0.6 || !others.length) ? inUse : others[Math.floor(rng() * others.length)] ?? inUse ?? candidates[0];
    events.push({
      atSec: atMin * 60, kind: 'closure', quiet: true,
      closure: { kind: 'RUNWAY', ident: rw.id, durationSec: durMin * 60, reason: 'runway inspection by airport operations' },
      text: `Airport operations is inspecting runway ${rw.id}: closed for about ${durMin} minutes (NOTAM).`,
    });
  }

  // Taxiway closure.
  const troll = rng();
  const tAtMin = 5 + Math.floor(rng() * 35);
  const tDurMin = 15 + Math.floor(rng() * 26);
  const tpick = rng();
  if (troll < 0.35) {
    const ok = closableTaxiways(airport, o.active, setupTaxiways);
    if (ok.length) {
      const twy = ok[Math.floor(tpick * ok.length)];
      events.push({
        atSec: tAtMin * 60, kind: 'closure',
        closure: { kind: 'TAXIWAY', ident: twy, durationSec: tDurMin * 60, reason: 'taxiway closed for maintenance' },
        text: `Taxiway ${twy} is closed for maintenance for about ${tDurMin} minutes (NOTAM).`,
      });
    }
  }

  // Bird activity (JO 7110.65 2-1-23, 2-9-3).
  const bRoll = rng();
  const bAtMin = 3 + Math.floor(rng() * 28);
  const bDurMin = 20 + Math.floor(rng() * 26);
  const bWhat = BIRD_PHRASES[Math.floor(rng() * BIRD_PHRASES.length)];
  if (bRoll < birdActivityProbability(o.startUtcMs, airport.timeZone)) {
    events.push({
      atSec: bAtMin * 60, kind: 'birds', detail: `${bWhat}, altitude unknown`, durationSec: bDurMin * 60,
      text: `Bird activity in the vicinity of the airport: ${bWhat}, altitude unknown.`,
    });
  }
  return events.sort((a, b) => a.atSec - b.atSec);
}
