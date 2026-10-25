import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { loadKbos, loadKpgd, loadKphl } from '../airport';
import type { Airport } from '../sim/types';
import { runFreePlaySoak } from './freePlayHarness';
import type { SoakResult } from './freePlayHarness';

/**
 * All-AI free-play soak for the two newest airports (KBOS: six runways and four published runway configurations; KPHL: two configurations; KPGD: two crossing runways,
 * runway 9/27 excluded). Default traffic rates of the harness (10 + 10 per hour, 14 aircraft), pilot realism moderate (readback errors on).
 * KBOS runs each published configuration once, KPGD runs seeds 1-4 on the runway the weather chooses. 2 simulated hours each, only with
 * FREEPLAY_SOAK=1 (about 1 to 3 minutes of wall time per run; FREEPLAY_REPORT=1 prints the per-run table, FREEPLAY_REPORT_FILE=path appends it).
 * The short always-on smoke runs 20 simulated minutes at seed 1 per airport.
 *
 * Assertions: no stall (STALL_SEC without a landing or departure at 6+ aircraft), zero runway incursions, zero airborne proximity alerts,
 * no arrival is held in the approach phase without a procedure for HELD_MAX_SEC (10 minutes), every aircraft that landed more than PARK_BY_SEC ago reached its stand, every departure that appeared more than DEPART_BY_SEC before the end
 * took off, blocked-call share under 2 % (protocol of blockedRate.ts: share = blocked / (transmitted + blocked), first 300 s discarded) and the
 * run finishes inside the wall-time bound.
 */
const enabled = process.env.FREEPLAY_SOAK === '1';
const hours = Number(process.env.FREEPLAY_HOURS ?? 2);
const report = process.env.FREEPLAY_REPORT === '1';
const kpgdSeeds = (process.env.FREEPLAY_SEEDS ?? '1,2,3,4').split(',').map(Number);
/** Longest single wait (minutes) tolerated, same bar as freePlaySoak.test.ts. */
const MAX_WAIT_MIN = Number(process.env.FREEPLAY_MAX_WAIT_MIN ?? 20);
const WALL_BOUND_SEC = Number(process.env.FREEPLAY_WALL_SEC ?? 900);
const BLOCKED_MAX_SHARE = 0.02;
const DISCARD_SEC = 300;
/** A landed aircraft not on its stand this long after touchdown (an aircraft that taxied back and took off again, a pattern aircraft doing stop-and-go work, is not stuck), a departure not airborne this long after it appeared, is stuck. */
const PARK_BY_SEC = 1500;
const DEPART_BY_SEC = 2400;
/** An arrival in the INBOUND / APPROACH phase that is not flying an arrival route or a cleared approach is sequenced (cleared, slowed to a gap, sent to a hold that releases it) within this long. DESIGN VALUE. */
const HELD_MAX_SEC = 600;

interface Tracked { id: string; callsign: string; dep: boolean; firstSec: number; landedSec?: number; parked?: boolean; departed?: boolean }

interface RunSummary extends SoakResult {
  label: string;
  wallSec: number;
  blockedShare: number;
  blocked: number;
  keyed: number;
  airborneAlerts: string[];
  incursions: string[];
  stuckLanded: string[];
  stuckDepartures: string[];
}

function run(label: string, airport: Airport, seed: number, simHours: number, active?: { landing: string[]; departing: string[] }): RunSummary {
  const tracked = new Map<string, Tracked>();
  const wall0 = performance.now();
  const r = runFreePlaySoak(seed, 'moderate', simHours, {
    perSecond: (engine, _ai, now) => {
      for (const a of Object.values(engine.getState().aircraft)) {
        let t = tracked.get(a.id);
        if (!t) { t = { id: a.id, callsign: a.callsign, dep: a.isDeparture, firstSec: now }; tracked.set(a.id, t); }
        if (a.isDeparture) {
          if (['TAKEOFF_ROLL', 'INITIAL_CLIMB', 'DEPARTURE'].includes(a.phase)) t.departed = true;
        } else {
          if (t.landedSec === undefined && ['ROLLOUT', 'RUNWAY_EXIT', 'TAXI_TO_PARKING', 'ARRIVED'].includes(a.phase)) t.landedSec = now;
          if (a.phase === 'ARRIVED') t.parked = true;
        }
      }
    },
  }, { airport, ...(active ? { activeRunways: active } : {}), });
  const wallSec = (performance.now() - wall0) / 1000;
  const endSec = simHours * 3600;
  let transmitted = 0, blocked = 0;
  const airborneAlerts: string[] = [];
  const incursions: string[] = [];
  for (const e of r.events) {
    if (e.kind === 'SEPARATION_VIOLATION' && (e.data as { alertKind?: string } | undefined)?.alertKind === 'AIRBORNE_PROXIMITY') airborneAlerts.push(`${Math.round(e.timeSec)} ${e.text}`);
    if (e.kind === 'RUNWAY_INCURSION') incursions.push(`${Math.round(e.timeSec)} ${e.text}`);
    if (e.timeSec < DISCARD_SEC) continue;
    if (e.kind === 'TRANSMISSION' && e.speaker === 'PILOT') transmitted++;
    else if (e.kind === 'RADIO_BLOCKED') blocked += ((e.data as { callsigns?: string[] } | undefined)?.callsigns ?? []).length;
  }
  const keyed = transmitted + blocked;
  const all = [...tracked.values()];
  const stuckLanded = all.filter((t) => !t.dep && t.landedSec !== undefined && !t.parked && !t.departed && endSec - t.landedSec > PARK_BY_SEC).map((t) => `${t.callsign} landed t=${Math.round(t.landedSec!)}`);
  const stuckDepartures = all.filter((t) => t.dep && !t.departed && endSec - t.firstSec > DEPART_BY_SEC).map((t) => `${t.callsign} appeared t=${Math.round(t.firstSec)}`);
  return { ...r, label, wallSec, blockedShare: keyed ? blocked / keyed : 0, blocked, keyed, airborneAlerts, incursions, stuckLanded, stuckDepartures };
}

function line(x: RunSummary): string {
  const last = (a: number[]) => a[a.length - 1] ?? 0;
  return `| ${x.label} | ${last(x.landed)} | ${last(x.departed)} | ${x.incursions.length + x.airborneAlerts.length}/${x.safety.length} | ${x.maxWaitText || '-'} (held ${x.maxHeldText || '-'}) | ${x.goArounds} | ${(100 * x.blockedShare).toFixed(2)} % (${x.blocked}/${x.keyed}) | ${x.stuckLanded.length}/${x.stuckDepartures.length} | ${x.wallSec.toFixed(0)} s |`;
}
const HEADER = '| run | landings | departures | incursions+airborne / all safety | max wait | go-arounds | blocked | stuck landed/dep | wall |\n|---|---|---|---|---|---|---|---|---|';

function check(x: RunSummary, minutes: number, strict: boolean): void {
  if (process.env.FREEPLAY_REPORT_FILE) appendFileSync(process.env.FREEPLAY_REPORT_FILE, `${line(x)}\n`);
  if (report || x.stallDump) console.log(`${HEADER}\n${line(x)}\n${x.rows.join('\n')}\n${x.safety.join('\n')}\n${x.stuckLanded.join('\n')}\n${x.stuckDepartures.join('\n')}\n${x.longWaits.slice(0, 8).join('\n')}\n${x.stallDump ?? ''}`);
  expect(x.stallDump, x.rows.join('\n')).toBeUndefined();
  expect(x.incursions, 'runway incursions').toEqual([]);
  expect(x.airborneAlerts, 'airborne proximity alerts').toEqual([]);
  expect(x.stuckLanded, 'landed but never parked').toEqual([]);
  expect(x.stuckDepartures, 'departures that never took off').toEqual([]);
  expect(x.maxHeldSec, `an arrival was held in the approach phase without a procedure: ${x.maxHeldText}`).toBeLessThan(HELD_MAX_SEC);
  expect(x.wallSec).toBeLessThan(WALL_BOUND_SEC);
  if (!strict) return;
  const last = (a: number[]) => a[a.length - 1] ?? 0;
  expect(last(x.landed)).toBeGreaterThan(0);
  expect(last(x.departed)).toBeGreaterThanOrEqual(Math.round((minutes / 60) * 5));
  expect(x.blockedShare, `${x.blocked} of ${x.keyed} calls blocked`).toBeLessThan(BLOCKED_MAX_SHARE);
  expect(x.maxWaitSec, x.maxWaitText).toBeLessThan(MAX_WAIT_MIN * 60);
}

describe('new airports, 20 simulated minutes, seed 1 (smoke)', () => {
  it('KBOS northeast flow: no stall, no incursion, nothing stuck', () => {
    const kbos = loadKbos();
    const c = kbos.runwayConfigurations![0];
    check(run('KBOS ' + c.id + ' s1 20m', kbos, 1, 1 / 3, { landing: c.landing, departing: c.departing }), 20, false);
  }, 300000);
  it('KPGD wind-chosen runway: no stall, no incursion, nothing stuck', () => {
    check(run('KPGD s1 20m', loadKpgd(), 1, 1 / 3), 20, false);
  }, 300000);
});

describe.skipIf(!enabled)('new airports, all-AI free play, pilot realism moderate', () => {
  const kbos = loadKbos();
  for (const c of kbos.runwayConfigurations ?? []) {
    it(`KBOS ${c.id} (land ${c.landing.join('+')}, depart ${c.departing.join('+')}): ${hours} h`, () => {
      check(run(`KBOS ${c.id}`, kbos, 1, hours, { landing: c.landing, departing: c.departing }), hours * 60, true);
    }, 1800000);
  }
  const kphl = loadKphl();
  for (const c of kphl.runwayConfigurations ?? []) {
    for (const seed of [1, 2]) {
      it(`KPHL ${c.id} (land ${c.landing.join('+')}, depart ${c.departing.join('+')}) seed ${seed}: ${hours} h`, () => {
        check(run(`KPHL ${c.id} s${seed}`, kphl, seed, hours, { landing: c.landing, departing: c.departing }), hours * 60, true);
      }, 1800000);
    }
  }
  const kpgd = loadKpgd();
  for (const seed of kpgdSeeds) {
    it(`KPGD seed ${seed}: ${hours} h`, () => {
      check(run(`KPGD s${seed}`, kpgd, seed, hours), hours * 60, true);
    }, 1800000);
  }
});
