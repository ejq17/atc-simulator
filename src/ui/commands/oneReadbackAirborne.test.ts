/**
 * One transmission, one readback for airborne and clearance instructions (AIM 4-4-7 b, JO 7110.65 2-4-3): vector plus altitude,
 * approach clearance plus "contact Tower", takeoff with "fly runway heading", a full IFR clearance. Each command keeps its own effect and readback error.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../sim/engine';
import { loadKacy } from '../../airport';
import type { ExtendedEngine } from '../../sim/engineExtras';
import { ALL_POSITIONS, ARRIVING, AT_FIX, IFR_DEPARTURE, IFR_HOLDING, cmd, find, makeScenario, run, runUntil } from '../../sim/__fixtures__/testHelpers';
import type { ControllerPositionId, ParsedCommand, ScenarioAircraftSpawn } from '../../sim/types';
import type { PilotRealismLevel } from '../../sim/pilotBehaviour';
import { transmit } from './transmit';

const kacy = loadKacy();
const CLEAN = { delayedResponseRate: 0, noReadbackRate: 0, sayAgainRate: 0, digitErrorRate: 0, altitudeErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, patternMisunderstandRate: 0, wrongCallsignRate: 0 };

function engineWith(spawns: ScenarioAircraftSpawn[], realism: PilotRealismLevel | undefined, over: Record<string, unknown> = {}, rates: Record<string, number> = {}): ExtendedEngine {
  return createEngine({
    airport: kacy, readbackErrorRate: 0, utcStartMs: Date.UTC(2026, 9, 17, 16),
    scenario: makeScenario({
      mode: 'free_play', controllerPositions: ALL_POSITIONS, playerPositions: ALL_POSITIONS, activeRunways: { departing: ['13'], landing: ['13'] }, spawns,
      ...(realism ? { pilotRealism: realism, pilotBehaviour: { noAtisFraction: 0, ground: { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 }, realism: { ...CLEAN, ...rates } } } : {}),
      ...over,
    }),
  }) as ExtendedEngine;
}
const pilot = (e: ExtendedEngine, since: number, cs: string) => e.getState().events.filter((x) => x.kind === 'TRANSMISSION' && x.speaker === 'PILOT' && x.callsign === cs && x.timeSec >= since - 1e-9 && x.data?.readback).map((x) => x.text);
/** Let the aircraft's own first calls finish, so the readback is not queued behind them. */
const settle = (e: ExtendedEngine, sec = 45) => run(e, sec);
const say = (e: ExtendedEngine, text: string, pos: ControllerPositionId) => transmit({ engine: e, text, source: 'typed', controller: { positions: [pos] } });

describe.each<[string, PilotRealismLevel | undefined]>([['realism off', undefined], ['heavy realism', 'heavy']])('%s', (_n, realism) => {
  it('climb and maintain three thousand, turn left heading two seven zero: three-element vector and altitude, one readback', () => {
    const e = engineWith([ARRIVING('N723EJ', '13', 12)], realism);
    settle(e);
    const since = e.getState().clock.timeSec;
    const r = say(e, 'Cessna seven two three echo juliet, climb and maintain three thousand, turn left heading two seven zero', 'TWR');
    expect(r.commands.map((c) => c.kind)).toEqual(['ALTITUDE', 'HEADING']);
    expect(r.results.map((x) => x.outcome.status)).toEqual(['accepted', 'accepted']);
    run(e, 40);
    const rb = pilot(e, since, 'N723EJ');
    expect(rb).toHaveLength(1);
    expect(rb[0]).toMatch(/three thousand.*heading two seven zero, Cessna seven two three echo juliet$/);
    expect((rb[0].match(/Cessna seven two three echo juliet/g) ?? []).length).toBe(1);
    expect(find(e, 'N723EJ').target.altitudeFt).toBe(3000);
  });

  it('cleared ILS runway one three approach, contact tower: one readback, both effects', () => {
    const e = engineWith([AT_FIX('NKS451', 'CARYL', ['CARYL', 'MAYBN'], '13', {}, 3000)], realism);
    settle(e);
    const since = e.getState().clock.timeSec;
    const r = say(e, 'Spirit four fifty one, cleared ILS runway one three approach, contact tower one two zero point three', 'APP');
    expect(r.commands.map((c) => c.kind)).toEqual(['APPROACH', 'CONTACT_FREQUENCY']);
    expect(r.results.map((x) => x.outcome.status)).toEqual(['accepted', 'accepted']);
    run(e, 12);
    const rb = pilot(e, since, 'NKS451');
    expect(rb).toHaveLength(1);
    expect(rb[0]).toMatch(/ILS runway one three.*tower one two zero point three, Spirit four fifty one$/i);
  });

  it('runway one three, fly runway heading, cleared for takeoff: one readback', () => {
    const e = engineWith([IFR_HOLDING('NKS451', 'HP13-31-B-1', '13')], realism);
    settle(e);
    const since = e.getState().clock.timeSec;
    const r = say(e, 'Spirit four fifty one, runway one three, fly runway heading, cleared for takeoff', 'TWR');
    expect(r.commands.map((c) => c.kind)).toEqual(['TAKEOFF']);
    expect(r.results.every((x) => x.outcome.status === 'accepted')).toBe(true);
    run(e, 12);
    const rb = pilot(e, since, 'NKS451');
    expect(rb).toHaveLength(1);
    expect(rb[0]).toMatch(/cleared for takeoff/i);
    expect((rb[0].match(/Spirit four fifty one/g) ?? []).length).toBe(1);
  });

  it('a full IFR clearance followed by "contact ground": one readback', () => {
    const e = engineWith([IFR_DEPARTURE()], realism);
    expect(runUntil(e, () => find(e, 'NKS451').pendingRequest?.kind === 'IFR_CLEARANCE', 60)).toBe(true);
    run(e, 25);
    const since = e.getState().clock.timeSec;
    const cs = 'NKS451';
    const cmds: ParsedCommand[] = [
      cmd('IFR_CLEARANCE', cs, { ifr: {} }),
      cmd('CONTACT_FREQUENCY', cs, { frequencyId: 'GND' }),
    ].map((c) => ({ ...c, groupSize: 2 }));
    for (const c of cmds) e.applyCommand(c, { position: 'CLNC', transmissionId: 'tx-ifr' });
    run(e, 15);
    const rb = pilot(e, since, cs);
    expect(rb).toHaveLength(1);
    expect(rb[0]).toMatch(/^Cleared to Philadelphia airport.*squawk .*ground.*, Spirit four fifty one$/i);
    expect((rb[0].match(/Spirit four fifty one/g) ?? []).length).toBe(1);
  });
});

describe('a readback error inside a joined readback', () => {
  it('is recorded for the right clearance, and re-issuing that instruction alone is corrected (what the AI correction logic does)', () => {
    const e = engineWith([ARRIVING('N723EJ', '13', 12)], 'heavy', {}, { altitudeErrorRate: 1 });
    settle(e);
    const since = e.getState().clock.timeSec;
    const r = say(e, 'Cessna seven two three echo juliet, climb and maintain three thousand, turn left heading two seven zero', 'TWR');
    expect(r.results.map((x) => x.outcome.status)).toEqual(['accepted', 'accepted']);
    run(e, 40);
    const rb = pilot(e, since, 'N723EJ');
    expect(rb).toHaveLength(1);
    expect(rb[0]).not.toMatch(/three thousand/); // the altitude was read back wrong, inside the one call
    expect(rb[0]).toMatch(/heading two seven zero/);
    const ac = find(e, 'N723EJ');
    expect(ac.flags.readbackErrorPending).toBe(true);
    expect(ac.flags.readbackErrorKind).toBe('altitude');
    // the issuing position re-issues the instruction (src/ai/corrections.ts: one command, "negative, ..."): the pilot corrects it
    const t2 = e.getState().clock.timeSec;
    e.applyCommand(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), { position: 'TWR', transmissionId: 'fix-1' });
    run(e, 20);
    expect(find(e, 'N723EJ').flags.readbackErrorPending).toBe(false);
    expect(pilot(e, t2, 'N723EJ').some((t) => /three thousand/.test(t))).toBe(false); // corrections carry data.correction, not data.readback
    expect(e.getState().events.some((x) => x.kind === 'READBACK_ERROR' && x.data?.corrected && x.timeSec >= t2)).toBe(true);
  });
});
