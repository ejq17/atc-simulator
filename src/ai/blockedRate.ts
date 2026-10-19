/**
 * Blocked-call measurement (docs/BEHAVIOUR-ACCURACY.md R9, README "Pilot realism"). Test helper, not imported by production code; the runner
 * is `blockedRate.test.ts` (opt-in, `BLOCKED_RATE=1`).
 *
 * PROTOCOL (the canonical one; every default below is part of it):
 *  - Airport / mode: KACY, free play (`game.buildFreePlay`), clear weather preset, simulated weather source, clock = the engine's fixed 0.1 s step
 *    (no real time), UTC start 2026-06-01 15:00, 'normal' difficulty, readback error rate 0.04 (the engine option).
 *  - Traffic: 24 arrivals + 24 departures per hour, `maxAircraft` 30, starting population 'mixed' with 6 aircraft, generator flow control ON
 *    (the default: arrival slots and the departure cap, src/game/traffic.ts), no special traffic (helicopters, fighters, transitions, training,
 *    vehicles all off), no airport events (closures, birds).
 *  - Pilot realism: the level under test (light / moderate / heavy); everything else is that level's design values.
 *  - Controllers: regime 'ai' = AI controllers on CLNC, GND, TWR, APP and DEP (no human); 'human-twr' = a scripted human Tower: the player works TWR
 *    (`playerPositions: ['TWR']`, so Ground / Departure coordinate with a human), landline requests to TWR are approved 3 s after they are made
 *    (the testkit.ts `humanAnswers: 'approve'` rule), and the Tower's own decisions are the AI Tower's with a 1-3 s reaction (a prompt human; the
 *    hand-written `towerPlayer` of ai.test.ts is single-runway and cannot work free play); AI controllers on the other four;
 *    'unattended' = no controller at all (nobody answers: reference only, see the report in docs).
 *  - A pilot call = one `TRANSMISSION` event with `speaker: 'PILOT'` (it reached the air), or one member of a `RADIO_BLOCKED` event (it was keyed and
 *    garbled). Readbacks (answers) and self-started calls (check-ins, requests, reports, re-asks, "say intentions") both count; a retry after a
 *    block is a new call keyed (one more TRANSMISSION or one more blocked member). Controller calls never count.
 *  - Blocked = every member of a collision: `RADIO_BLOCKED.data.callsigns.length` (two for the usual two-pilot collision), so a collision counts as
 *    two blocked calls and each blocked retry that collides again counts again. Share blocked = blocked / (transmitted + blocked), calls keyed.
 *  - Window: the first `DISCARD_SEC` (300 s) are discarded (start-up of the population), the next `spanSec` (7200 s = 2 h, about 300-650 pilot calls per run)
 *    are measured, by the event's time. The 35-minute window of the earlier measurements is `spanSec: 2100`. Seeds 1-3 (scenario and engine seed), AI seed 5. Every figure is deterministic: the same code gives the same count.
 */
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { game } from '../game/game';
import { createAiControllers } from './index';
import type { SimEvent, ControllerPositionId } from '../sim/types';
import type { PilotRealismLevel } from '../sim/pilotBehaviour';
import type { SimulationEngineExtras } from '../sim/engineExtras';
import { awaitingAnswer } from '../sim/coordination';
import { defaultSpecialTraffic } from '../game/specialTraffic';

export type BlockedRegime = 'ai' | 'human-twr' | 'unattended';

export interface BlockedOptions {
  seed: number;
  level: PilotRealismLevel;
  regime: BlockedRegime;
  discardSec?: number;
  spanSec?: number;
  /** Starting population. */
  aircraftCount?: number;
  startingScenario?: 'quiet' | 'busy_departures' | 'busy_arrivals' | 'mixed';
  maxAircraft?: number;
  arrivalsPerHour?: number;
  departuresPerHour?: number;
  /** false = no arrival slots / departure cap in the generator (the raw clocks). Default true (on). */
  flowControl?: boolean;
  /** Special traffic on (the setup screen's defaults) instead of none. */
  specialTraffic?: boolean;
  airportEvents?: boolean;
  /** Variations for the reconciliation only: IFR flows (CLNC / APP / DEP traffic) forced on or off; default = on, because the session lists CLNC / APP / DEP. */
  ifrFlows?: boolean;
  /** Variation: the controller positions of the session: all five (canonical) or TWR + GND only (what a free-play build lists by default). */
  positions?: 'all' | 'twr-gnd';
  readbackErrorRate?: number;
  /** Seconds a landline request waits before the scripted human approves it (human-twr). */
  humanAnswerSec?: number;
}

/** The canonical protocol values. */
export const PROTOCOL = {
  discardSec: 300, spanSec: 7200, aircraftCount: 6, startingScenario: 'mixed' as const, maxAircraft: 30, arrivalsPerHour: 24, departuresPerHour: 24,
  readbackErrorRate: 0.04, aiSeed: 5, humanAnswerSec: 3, seeds: [1, 2, 3], levels: ['light', 'moderate', 'heavy'] as PilotRealismLevel[],
  startUtcMs: Date.UTC(2026, 5, 1, 15),
};

export interface BlockedResult {
  /** Pilot calls that reached the air in the window. */
  transmitted: number;
  /** Blocked calls (every member of a collision). */
  blocked: number;
  /** Collisions (RADIO_BLOCKED events). */
  groups: number;
  /** Blocked calls that were answers to the controller (readbacks), the rest started by the pilot. */
  blockedAnswers: number;
  /** Calls keyed = transmitted + blocked. */
  keyed: number;
  /** Aircraft the generator added to the sim in the window's run (arrivals + departures offered), and what flew (landed / departed) in the whole run. */
  spawned: number;
  landed: number;
  departed: number;
  /** Controller transmissions in the window. */
  atcCalls: number;
  pairs: string[];
}

const ALL: ControllerPositionId[] = ['CLNC', 'GND', 'TWR', 'APP', 'DEP'];
const kacy = loadKacy();

export function measureBlocked(o: BlockedOptions): BlockedResult {
  const discard = o.discardSec ?? PROTOCOL.discardSec;
  const span = o.spanSec ?? PROTOCOL.spanSec;
  const sc = game.buildFreePlay(kacy, {
    seed: o.seed, weather: 'clear', aircraftCount: o.aircraftCount ?? PROTOCOL.aircraftCount, maxAircraft: o.maxAircraft ?? PROTOCOL.maxAircraft,
    arrivalsPerHour: o.arrivalsPerHour ?? PROTOCOL.arrivalsPerHour, departuresPerHour: o.departuresPerHour ?? PROTOCOL.departuresPerHour, difficulty: 'normal',
    pilotRealism: o.level, startingScenario: o.startingScenario ?? PROTOCOL.startingScenario,
    specialTraffic: o.specialTraffic ? defaultSpecialTraffic('KACY') : { helicopter: false, military: false, transition: false, training: false, vehicles: false, },
    ...(o.ifrFlows === undefined ? {} : { ifrFlows: o.ifrFlows }),
    airportEvents: o.airportEvents ?? false, startUtcMs: PROTOCOL.startUtcMs,
  });
  if (o.flowControl === false && sc.traffic) sc.traffic = { ...sc.traffic, flowControl: false };
  const staffed: ControllerPositionId[] = o.positions === 'twr-gnd' ? ['TWR', 'GND'] : ALL;
  sc.controllerPositions = staffed;
  const human: ControllerPositionId[] = o.regime === 'human-twr' ? ['TWR'] : [];
  sc.playerPositions = human;
  const engine = createEngine({
    airport: kacy, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, kacy), readbackErrorRate: o.readbackErrorRate ?? PROTOCOL.readbackErrorRate, utcStartMs: PROTOCOL.startUtcMs,
  });
  const aiPositions = staffed.filter((p) => !human.includes(p));
  const ais = o.regime === 'unattended' ? [] : [
    createAiControllers({ engine, airport: kacy, positions: aiPositions, playerPositions: human, seed: PROTOCOL.aiSeed }),
    ...(human.length ? [createAiControllers({ engine, airport: kacy, positions: human, playerPositions: [], seed: PROTOCOL.aiSeed + 1, reactionDelaySec: [1, 3] })] : []),
  ];
  const api = (engine as SimulationEngineExtras).coordination;
  const events: SimEvent[] = [];
  const seen = new Set<string>();
  const landed = new Set<string>();
  const departed = new Set<string>();
  let last = 0;
  engine.subscribe((s) => {
    for (const ai of ais) ai.update(s);
    if (human.length && api) {
      for (const pos of s.coordination?.human ?? human) {
        for (const r of awaitingAnswer(s, pos)) {
          if (r.status === 'pending' && s.clock.timeSec - r.lastAskSec >= (o.humanAnswerSec ?? PROTOCOL.humanAnswerSec)) api.respond(r.id, 'approve', { by: pos, source: 'player' });
        }
      }
    }
    for (const e of s.events) { const n = Number(e.id.replace('ev-', '')); if (n > last) { events.push(e); last = n; } }
    for (const a of Object.values(s.aircraft)) {
      seen.add(a.id);
      if (a.isDeparture ? ['TAKEOFF_ROLL', 'INITIAL_CLIMB', 'DEPARTURE'].includes(a.phase) : ['ROLLOUT', 'RUNWAY_EXIT', 'TAXI_TO_PARKING', 'ARRIVED'].includes(a.phase)) (a.isDeparture ? departed : landed).add(a.id);
    }
  });
  for (let t = 1; t <= (discard + span) * 10; t++) engine.step();
  const r: BlockedResult = { transmitted: 0, blocked: 0, groups: 0, blockedAnswers: 0, keyed: 0, spawned: seen.size, landed: landed.size, departed: departed.size, atcCalls: 0, pairs: [] };
  for (const e of events) {
    if (e.timeSec < discard || e.timeSec >= discard + span) continue;
    if (e.kind === 'TRANSMISSION' && e.speaker === 'PILOT') r.transmitted++;
    else if (e.kind === 'TRANSMISSION' && e.speaker === 'ATC') r.atcCalls++;
    else if (e.kind === 'RADIO_BLOCKED') {
      // `answers` / `texts` / `keyedAtSec` exist from afe19cd on; older commits only list the callsigns.
      const d = e.data as { callsigns: string[]; answers?: boolean[]; texts?: string[]; keyedAtSec?: number[] };
      r.blocked += d.callsigns.length; r.groups++;
      r.blockedAnswers += d.answers?.filter(Boolean).length ?? 0;
      const atc = events.filter((x) => x.kind === 'TRANSMISSION' && x.speaker === 'ATC' && x.timeSec <= e.timeSec && x.timeSec > e.timeSec - 12).map((x) => `ATC@${x.timeSec.toFixed(1)}:${(x.text ?? '').slice(0, 30)}`).join(' | ');
      r.pairs.push(`${atc} >> ${Math.round(e.timeSec)} ${(d.answers ?? []).map((a) => (a ? 'A' : 'P')).join('')} ${(d.keyedAtSec ?? []).join('/')} ${(d.texts ?? []).map((t) => `[${t.slice(0, 70)}]`).join(' ')}`);
    }
  }
  r.keyed = r.transmitted + r.blocked;
  return r;
}

export interface BlockedRow {
  line: string;
  blocked: number;
  keyed: number;
  pct: number;
  groups: number;
  perSeed: string;
  pairs: string[];
}

/** Sum of `measureBlocked` over the seeds, as one table row. */
export function measureRow(base: Omit<BlockedOptions, 'seed'>, seeds: number[], label: string): BlockedRow {
  let blocked = 0, keyed = 0, groups = 0, answers = 0, atc = 0, landed = 0, departed = 0;
  const per: string[] = [];
  const pairs: string[] = [];
  for (const seed of seeds) {
    const r = measureBlocked({ ...base, seed });
    blocked += r.blocked; keyed += r.keyed; groups += r.groups; answers += r.blockedAnswers; atc += r.atcCalls; landed += r.landed; departed += r.departed;
    per.push(`${seed}:${r.blocked}/${r.keyed}`);
    pairs.push(...r.pairs.map((x) => `s${seed} ${x}`));
  }
  const pct = keyed ? (100 * blocked) / keyed : 0;
  const line = `${label}: blocked ${blocked} of ${keyed} calls keyed = ${pct.toFixed(2)} % (collisions ${groups}, ${answers} of the blocked calls were readbacks; ATC calls ${atc}; landed ${landed} departed ${departed}; per seed ${per.join(' ')})`;
  return { line, blocked, keyed, pct, groups, perSeed: per.join(' '), pairs };
}
