/** Free-play soak harness (test helper, not imported by production code): see freePlaySoak.test.ts. */
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { game } from '../game/game';
import { createAiControllers } from './index';
import type { Aircraft, SimEvent } from '../sim/types';

const kacy = loadKacy();

export interface SoakResult {
  rows: string[];
  landed: number[];
  departed: number[];
  msPerSimSec: number[];
  maxWaitSec: number;
  maxWaitText: string;
  stallDump?: string;
  safety: string[];
  finalCount: number;
  events: SimEvent[];
  /** Distinct (lander, departure) pairs that stood within `STUB_PAIR_M` of each other on a taxiway, one of them stopped, for `STUB_PAIR_SEC` (an exit stub shared by a lander and a departure). */
  stubPairs: string[];
  /** Pilot "nose to nose" calls (head-on on a shared lane). */
  noseToNose: number;
  /** Seconds each departure stood at a runway hold line (HOLDING_SHORT) before it was lined up or cleared. */
  holdWaitsSec: number[];
  goArounds: number;
  /** Aircraft the generator put into the sim: arrivals and departures (the offered traffic; the generator is state dependent through its flow control). */
  spawnedArrivals: number;
  spawnedDepartures: number;
  /** Every wait of 10 minutes or more (a waiting phase held without a break), longest first: "CALLSIGN PHASE seconds (ended at t)". */
  longWaits: string[];
  /** Landers per runway-exit hold line (the last node of the route they take off the runway). */
  exitHolds: Record<string, number>;
}

/** Lander and departure this close (m) on the taxiways, one of them stopped: they share a lane with no way past each other. */
export const STUB_PAIR_M = 70;
/** ... for this many seconds in a row (a lander and a departure that merely pass each other at a junction are not a conflict). */
export const STUB_PAIR_SEC = 30;

/** No landing or departure for this long with at least six aircraft in the sim is a stall (flow of 12.5 + 12.5 per hour: an empty quarter hour by chance is below 0.5 %). */
export const STALL_SEC = 900;

export type Realism = 'off' | 'moderate';

/** Phases in which an aircraft is waiting for the controllers (taxiing counts only when it stands still: see the wait test below). */
const WAIT_PHASES = ['PARKED', 'PUSHBACK', 'READY', 'HOLDING_SHORT', 'LINE_UP_AND_WAIT', 'INBOUND', 'APPROACH', 'HOLDING', 'TAXIING', 'TAXI_TO_PARKING', 'RUNWAY_EXIT'];

export interface SoakHooks {
  /** Called once per sim second after the step (diagnostics). */
  perSecond?: (engine: ReturnType<typeof createEngine>, ai: ReturnType<typeof createAiControllers>, nowSec: number) => void;
}

export function runFreePlaySoak(seed: number, realism: Realism, simHours: number, hooks: SoakHooks = {}): SoakResult {
  const sc = game.buildFreePlay(kacy, {
    seed, weather: 'clear', aircraftCount: 2, maxAircraft: 14, arrivalsPerHour: 10, departuresPerHour: 10, difficulty: 'normal', startingScenario: 'quiet',
    specialTraffic: { helicopter: false, military: false, transition: false, training: false, vehicles: false }, airportEvents: false, startUtcMs: Date.UTC(2026, 5, 1, 15),
  });
  sc.controllerPositions = ['CLNC', 'GND', 'TWR', 'APP', 'DEP'];
  sc.playerPositions = [];
  if (realism === 'off') sc.pilotBehaviour = { ground: { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 } };
  const engine = createEngine({
    airport: kacy, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, kacy), readbackErrorRate: realism === 'off' ? 0 : 0.04, utcStartMs: Date.UTC(2026, 5, 1, 15),
  });
  const ai = createAiControllers({ engine, airport: kacy, positions: ['CLNC', 'GND', 'TWR', 'APP', 'DEP'], playerPositions: [], seed: 5 });
  const events: SimEvent[] = [];
  let last = 0;
  engine.subscribe((s) => {
    ai.update(s);
    for (const e of s.events) {
      const n = Number(e.id.replace('ev-', ''));
      if (n > last) { events.push(e); last = n; }
    }
  });
  const landedIds = new Set<string>();
  const departedIds = new Set<string>();
  const phaseSince = new Map<string, { phase: string; since: number }>();
  const res: SoakResult = { rows: [], landed: [], departed: [], msPerSimSec: [], maxWaitSec: 0, maxWaitText: '', safety: [], finalCount: 0, events, stubPairs: [], noseToNose: 0, holdWaitsSec: [], goArounds: 0, spawnedArrivals: 0, spawnedDepartures: 0, longWaits: [], exitHolds: {} };
  const pairs = new Map<string, string>();
  const pairSince = new Map<string, number>();
  const waitLog: { sec: number; text: string }[] = [];
  const spawnedIds = new Set<string>();
  const total = Math.round(simHours * 3600);
  let wall0 = performance.now();
  let lastMove = 0;
  let lastMoveCount = 0;
  const describe = (a: Aircraft, now: number): string => {
    const cl = a.clearances.slice(-3).map((c) => `${c.kind}${c.runwayEnd ? ':' + c.runwayEnd : ''}${c.holdShort?.length ? ' hs' + c.holdShort.join('/') : ''}`).join(',');
    const ps = phaseSince.get(a.id);
    return `${a.callsign} ${a.type} ${a.isDeparture ? 'DEP' : 'ARR'} ${a.phase} for ${Math.round(now - (ps?.since ?? now))}s pos=(${Math.round(a.pos.x)},${Math.round(a.pos.y)}) alt=${Math.round(a.altitudeFt)} gs=${Math.round(a.groundSpeedKt)} f=${a.frequencyId ?? a.frequencyMhz} rwy=${a.assignedRunwayEnd ?? '-'} occ=${a.occupyingRunways.join('/')} req=${a.pendingRequest ? a.pendingRequest.kind + '@' + a.pendingRequest.sinceSec : '-'} route=${a.route ? a.route.nodeIds.length + ' nodes stop=' + a.route.stopAtNodeIds.join('/') : '-'} clr=[${cl}]`;
  };
  for (let t = 1; t <= total * 10; t++) {
    engine.step();
    if (t % 10 !== 0) continue;
    const s = engine.getState();
    const now = s.clock.timeSec;
    hooks.perSecond?.(engine, ai, now);
    {
      // Lander and departure within STUB_PAIR_M on the taxiways with one of them stopped, for STUB_PAIR_SEC in a row: they share a lane and one waits for the other.
      const all = Object.values(s.aircraft);
      const nowPairs = new Set<string>();
      for (const l of all) {
        if (l.isDeparture || !l.onGround || (l.phase !== 'ROLLOUT' && l.phase !== 'RUNWAY_EXIT' && l.phase !== 'TAXI_TO_PARKING')) continue;
        for (const d of all) {
          if (!d.isDeparture || !d.onGround || d.occupyingRunways.length > 0 || (d.phase !== 'TAXIING' && d.phase !== 'HOLDING_SHORT')) continue;
          if (Math.hypot(l.pos.x - d.pos.x, l.pos.y - d.pos.y) > STUB_PAIR_M || (l.groundSpeedKt >= 1 && d.groundSpeedKt >= 1)) continue;
          const key = `${l.callsign}|${d.callsign}`;
          nowPairs.add(key);
          const since = pairSince.get(key) ?? now;
          pairSince.set(key, since);
          if (now - since >= STUB_PAIR_SEC && !pairs.has(key)) pairs.set(key, `${key} from t=${Math.round(since)} lander ${l.phase} f=${l.frequencyId ?? '-'} dep ${d.phase} f=${d.frequencyId ?? '-'} pos=(${Math.round(d.pos.x)},${Math.round(d.pos.y)}) toHold=${d.route?.nodeIds[d.route.nodeIds.length - 1] ?? '-'}`);
        }
      }
      for (const k of [...pairSince.keys()]) if (!nowPairs.has(k)) pairSince.delete(k);
    }
    for (const a of Object.values(s.aircraft)) {
      if (!spawnedIds.has(a.id)) { spawnedIds.add(a.id); if (a.isDeparture) res.spawnedDepartures++; else res.spawnedArrivals++; }
      const ps = phaseSince.get(a.id);
      if (!ps || ps.phase !== a.phase) {
        if (ps && now - ps.since >= 600 && WAIT_PHASES.includes(ps.phase) && ps.phase !== 'PARKED') waitLog.push({ sec: now - ps.since, text: `${a.callsign} ${ps.phase} ${Math.round(now - ps.since)}s (ended t=${Math.round(now)})` });
        if (ps && a.isDeparture && ps.phase === 'HOLDING_SHORT') res.holdWaitsSec.push(now - ps.since);
        if (!a.isDeparture && a.phase === 'RUNWAY_EXIT' && a.route) { const h = a.route.nodeIds[a.route.nodeIds.length - 1]; res.exitHolds[h] = (res.exitHolds[h] ?? 0) + 1; }
        phaseSince.set(a.id, { phase: a.phase, since: now });
      }
      if (a.isDeparture ? ['TAKEOFF_ROLL', 'INITIAL_CLIMB', 'DEPARTURE'].includes(a.phase) : ['ROLLOUT', 'RUNWAY_EXIT', 'TAXI_TO_PARKING', 'ARRIVED'].includes(a.phase)) {
        (a.isDeparture ? departedIds : landedIds).add(a.id);
      }
      const waited = now - (phaseSince.get(a.id)?.since ?? now);
      const waiting = ['PARKED', 'PUSHBACK', 'READY', 'HOLDING_SHORT', 'LINE_UP_AND_WAIT', 'INBOUND', 'APPROACH', 'HOLDING'].includes(a.phase) || (a.phase === 'TAXIING' && a.groundSpeedKt < 0.5);
      if (waiting && waited > res.maxWaitSec && a.phase !== 'PARKED') { res.maxWaitSec = waited; res.maxWaitText = `${a.callsign} ${a.phase} ${Math.round(waited)}s at t=${Math.round(now)}`; }
    }
    {
      const moved = landedIds.size + departedIds.size;
      if (moved > lastMoveCount) { lastMoveCount = moved; lastMove = now; }
      else if (now % 60 === 0 && !res.stallDump && now - lastMove >= STALL_SEC && Object.keys(s.aircraft).length >= 6) {
        const ac = Object.values(s.aircraft);
        res.stallDump = [`FIRST STALL: no landing or departure since t=${lastMove}s (now ${now}s)`, ...ac.map((a) => '  ' + describe(a, now)), ...Object.entries(ai.status()).map(([k, v]) => `  ${k}: ${v}`)].join('\n');
      }
    }
    if (now % 600 === 0) {
      const ac = Object.values(s.aircraft);
      const hist: Record<string, number> = {};
      for (const a of ac) hist[a.phase] = (hist[a.phase] ?? 0) + 1;
      const open = (s.coordination?.requests ?? []).filter((r) => r.status === 'pending' || r.status === 'standby' || r.status === 'approved').length;
      const ms = (performance.now() - wall0) / 600;
      wall0 = performance.now();
      res.landed.push(landedIds.size);
      res.departed.push(departedIds.size);
      res.msPerSimSec.push(ms);
      res.rows.push(`t=${String(now / 60).padStart(3)}m n=${String(ac.length).padStart(2)} land=${landedIds.size} dep=${departedIds.size} hold=${hist.HOLDING_SHORT ?? 0} coord=${open} ms/s=${ms.toFixed(2)} ${Object.entries(hist).map(([k, v]) => `${k}:${v}`).join(' ')}`);
    }
  }
  for (const a of Object.values(engine.getState().aircraft)) {
    const ps = phaseSince.get(a.id);
    const now = engine.getState().clock.timeSec;
    if (ps && now - ps.since >= 600 && WAIT_PHASES.includes(ps.phase) && ps.phase !== 'PARKED') waitLog.push({ sec: now - ps.since, text: `${a.callsign} ${ps.phase} ${Math.round(now - ps.since)}s (still waiting at t=${Math.round(now)})` });
  }
  res.longWaits = waitLog.sort((x, y) => y.sec - x.sec).map((w) => w.text);
  res.stubPairs = [...pairs.values()];
  res.goArounds = events.filter((e) => e.kind === 'GO_AROUND').length;
  res.noseToNose = events.filter((e) => /nose to nose/i.test(e.text)).length;
  res.finalCount = Object.keys(engine.getState().aircraft).length;
  res.safety = events.filter((e) => e.kind === 'RUNWAY_INCURSION' || e.kind === 'SEPARATION_VIOLATION').map((e) => `${Math.round(e.timeSec)} ${e.kind} ${e.text}`);
  return res;
}

