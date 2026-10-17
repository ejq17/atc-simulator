/**
 * Land and hold short (JO 7110.65 3-10-4 / 3-10-5, AIM 4-3-11, JO 7110.118) on real KACY.
 * KACY runway 4 has a NASR LAHSO entry: ALD 3,550 ft short of 13/31.
 */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { Scenario, Weather } from './types';
import { ARRIVING, cmd, find, makeScenario, pilotTexts, say } from './__fixtures__/testHelpers';
import { alongCross, findRunwayEnd } from './runways';
import { getPerformance } from './performance';
import { mToFt } from './geo';
import { detectConflicts } from './conflicts';
import type { SimContext } from './context';

const kacy = loadKacy();
const DAY = Date.UTC(2026, 9, 17, 16, 0, 0); // 12:00 EDT, sunrise ~11:11Z, sunset ~22:17Z
const NIGHT = Date.UTC(2026, 9, 17, 4, 0, 0); // midnight local

function make(type: string, over: { utcStartMs?: number; mode?: Scenario['mode']; weather?: Partial<Weather> } = {}): SimulationEngine {
  const base = makeScenario();
  return createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs: over.utcStartMs ?? DAY,
    scenario: makeScenario({
      mode: over.mode ?? 'training', activeRunways: { departing: ['4'], landing: ['4'] },
      weather: { ...(base.weather as Weather), ...over.weather },
      spawns: [ARRIVING('X1', '4', 4, type, 'TWR')],
    }),
  });
}

const land = (e: SimulationEngine, holdShort: string[] = ['RWY13']) => say(e, cmd('LAND', 'X1', { runwayEnd: '4', holdShort }), 'TWR');

describe('LAHSO validation on KACY runway 4 (hold short of 13/31)', () => {
  it('data: runway 4 has the NASR LAHSO entry (ALD 3,550 ft); C172 needs 1,335 ft, A320 4,500 ft', () => {
    expect(findRunwayEnd(kacy, '4')!.end.lahso?.availableLandingDistanceFt).toBe(3550);
    expect(getPerformance('C172').landingDistanceFt).toBeLessThan(3550);
    expect(getPerformance('A320').landingDistanceFt).toBeGreaterThan(3550);
  });

  it('C172 is accepted by day and reads back "Runway four, cleared to land, hold short of runway one three"', () => {
    const e = make('C172');
    const out = land(e);
    expect(out.status).toBe('accepted');
    const readback = pilotTexts(e, 'X1').join(' | ');
    expect(readback).toMatch(/Runway four, cleared to land, hold short of runway one three, /);
    expect(find(e, 'X1').clearances.some((c) => c.kind === 'LAND' && c.holdShort?.includes('13/31'))).toBe(true);
  });

  it('the pair form ["13/31"] is accepted too', () => {
    expect(land(make('C172'), ['13/31']).status).toBe('accepted');
  });

  it('A320 (4,500 ft) cannot hold short within the 3,550 ft ALD: the pilot is unable and the clearance is not LAHSO', () => {
    const e = make('A320');
    const out = land(e);
    expect(out.status).toBe('rejected');
    expect(pilotTexts(e, 'X1').join(' | ')).toMatch(/unable to hold short of runway one three/);
    expect(find(e, 'X1').clearances.some((c) => c.kind === 'LAND')).toBe(false);
    // the plain clearance (no hold short) is still fine
    expect(say(e, cmd('LAND', 'X1', { runwayEnd: '4' }), 'TWR').status).toBe('accepted');
  });

  it('a hold-short of a runway the NASR entry does not name is refused', () => {
    const e = make('C172');
    expect(land(e, ['RWY22']).status).toBe('rejected'); // own runway
    expect(land(make('C172'), ['RWY13']).status).toBe('accepted');
  });

  it('night: refused in training (sunrise-sunset only); free play accepts and flags it', () => {
    const t = make('C172', { utcStartMs: NIGHT });
    expect(land(t).status).toBe('rejected');
    const f = make('C172', { utcStartMs: NIGHT, mode: 'free_play' });
    const out = land(f);
    expect(out.status).toBe('accepted');
    expect(f.getState().events.some((x) => /Improper instruction accepted: Land and hold short not authorised.*sunrise and sunset/.test(x.text))).toBe(true);
  });

  it('wet runway (rain) is refused in training', () => {
    const e = make('C172', { weather: { phenomena: ['-RA'], visibilitySm: 6, clouds: [{ cover: 'OVC', baseFtAgl: 3000 }] } });
    expect(land(e).status).toBe('rejected');
  });

  it('ceiling below 1,000 ft or visibility under 3 sm is refused; a plain clearance is unaffected', () => {
    expect(land(make('C172', { weather: { clouds: [{ cover: 'OVC', baseFtAgl: 800 }] } })).status).toBe('rejected');
    expect(land(make('C172', { weather: { visibilitySm: 2 } })).status).toBe('rejected');
    const e = make('C172', { weather: { visibilitySm: 2 } });
    expect(say(e, cmd('LAND', 'X1', { runwayEnd: '4' }), 'TWR').status).toBe('accepted');
  });
});

describe('LAHSO rollout on KACY', () => {
  it('stops (or exits) before the hold-short point of runway 13/31, with no incursion', () => {
    const e = make('C172');
    const ac = find(e, 'X1');
    const g = findRunwayEnd(kacy, '4')!;
    const hs = alongCross(g, g.end.lahso!.holdShortPoint.pos).along;
    expect(land(e).status).toBe('accepted');
    let maxNose = -Infinity;
    for (let i = 0; i < 30000 && !(ac.phase === 'RUNWAY_EXIT' && ac.groundSpeedKt < 0.1); i++) {
      e.step();
      if (ac.onGround && ac.occupyingRunways.includes('4/22')) maxNose = Math.max(maxNose, alongCross(g, ac.pos).along + getPerformance('C172').lengthM / 2);
    }
    console.info(`LAHSO C172: hold-short point ${Math.round(mToFt(hs))} ft, furthest nose ${Math.round(mToFt(maxNose))} ft`);
    expect(maxNose).toBeLessThan(hs);
    expect(e.getState().events.some((x) => x.kind === 'RUNWAY_INCURSION')).toBe(false);
  });

  it('crossing the hold-short point is a runway incursion of the other runway (conflict detector unit test)', () => {
    const e = make('C172');
    const ac = find(e, 'X1');
    const g = findRunwayEnd(kacy, '4')!;
    land(e);
    for (let i = 0; i < 30000 && ac.phase !== 'ROLLOUT'; i++) e.step();
    expect(ac.phase).toBe('ROLLOUT');
    const hs = alongCross(g, g.end.lahso!.holdShortPoint.pos).along;
    // The rollout planner never gets here (and an exit node would snap the aircraft off first), so judge the detector on its own:
    // a context holding the LAHSO plan, with the aircraft's nose 60 m past the hold-short point.
    const state = e.getState();
    const ctx = {
      state, rng: () => 0.5, runtime: new Map([[ac.id, { lahso: { holdShortRunwayId: '13/31', holdShortAlongM: hs, stopAlongM: hs - 30 } }]]),
      eventSeq: 1000, clearanceSeq: 0, aircraftSeq: 0, alertSeq: 0, scoreQueue: [], recentCommands: new Map(), loggedTransmissions: new Set(),
      dynamicAlerts: new Map(), clearanceAlerts: [], waitStats: { count: 0, totalSec: 0, delaySec: 0 }, spawnedIdx: new Set(), readbackErrorRate: 0,
    } as unknown as SimContext;
    ac.pos = { x: g.end.threshold.x + g.dir.x * (hs + 60 - getPerformance('C172').lengthM / 2), y: g.end.threshold.y + g.dir.y * (hs + 60 - getPerformance('C172').lengthM / 2) };
    detectConflicts(ctx);
    const inc = state.events.find((x) => x.kind === 'RUNWAY_INCURSION' && /did not hold short of runway 13\/31/.test(x.text));
    expect(inc).toBeTruthy();
    expect((inc!.data as { runwayId: string }).runwayId).toBe('13/31');
  });

  it('a takeoff on 13 is not blocked by a LAHSO arrival on 4, but is by a plain arrival on 4 (3-10-4)', () => {
    const run = (withHold: boolean): number => {
      const e = createEngine({
        airport: kacy, readbackErrorRate: 0, utcStartMs: DAY,
        scenario: makeScenario({
          mode: 'training', activeRunways: { departing: ['13'], landing: ['4'] },
          spawns: [
            ARRIVING('X1', '4', 0.4, 'C172', 'TWR'),
            { atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: findHold13(), runwayEnd: '13' }, isDeparture: true, initialFrequencyId: 'TWR' },
          ],
        }),
      });
      say(e, cmd('LAND', 'X1', { runwayEnd: '4', ...(withHold ? { holdShort: ['RWY13'] } : {}) }), 'TWR');
      const out = say(e, cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13' }), 'TWR');
      return out.status === 'accepted' ? 1 : 0;
    };
    expect(run(true)).toBe(1);
    expect(run(false)).toBe(0);
  });
});

function findHold13(): string {
  const g = findRunwayEnd(kacy, '13')!;
  const nodes = Object.values(kacy.taxiwayGraph.nodes).filter((n) => n.kind === 'holding_position' && n.protectsRunwayEnd === '13');
  nodes.sort((a, b) => Math.hypot(a.pos.x - g.end.threshold.x, a.pos.y - g.end.threshold.y) - Math.hypot(b.pos.x - g.end.threshold.x, b.pos.y - g.end.threshold.y));
  return nodes[0].id;
}
