import { describe, expect, it } from 'vitest';
import { ARRIVING, cmd, find, GA_PARKED, HOLDING, makeEngine, run, runUntil } from './__fixtures__/testHelpers';
import type { ParsedCommand } from './types';

describe('command validation', () => {
  it('rejects commands on the wrong frequency ("not on frequency") and does not change the aircraft', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    const ac = find(e, 'N723EJ');
    run(e, 10);
    const before = JSON.stringify(ac.route);
    const out = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22' }), { position: 'TWR' });
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.reason).toMatch(/not on frequency/i);
      expect(out.reason).toMatch(/121\.9/);
      expect(out.pilotResponse).toBeUndefined(); // the pilot never heard it
    }
    expect(JSON.stringify(ac.route)).toBe(before);
    expect(ac.phase).toBe('READY');
    const ok = e.applyCommand(cmd('TAXI', 'N723EJ', { destination: 'RWY22', runwayEnd: '22' }), { position: 'GND' });
    expect(ok.status).toBe('accepted');
  });

  it('asks for clarification for a missing, ambiguous or unknown callsign', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    run(e, 3);
    expect(e.applyCommand(cmd('TAXI', null as unknown as string, { callsign: null }), { position: 'GND' }).status).toBe('clarify');
    const amb = e.applyCommand(cmd('TAXI', 'x', { callsign: null, callsignCandidates: ['N723EJ', 'N723EK'] }), { position: 'GND' });
    expect(amb.status).toBe('clarify');
    if (amb.status === 'clarify') expect(amb.question).toMatch(/N723EJ or N723EK/);
    const unk = e.applyCommand(cmd('TAXI', 'N999ZZ', { destination: 'RWY22' }), { position: 'GND' });
    expect(unk.status).toBe('clarify');
    expect(find(e, 'N723EJ').route).toBeUndefined();
  });

  it('low-confidence commands are never executed', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N723EJ', 'H13', '13')] } });
    run(e, 3);
    const low = e.applyCommand(cmd('TAKEOFF', 'N723EJ', { runwayEnd: '13', confidence: 0.55, issues: ['runway uncertain'] }));
    expect(low.status).toBe('clarify');
    if (low.status === 'clarify') expect(low.question).toBe('runway uncertain');
    expect(find(e, 'N723EJ').phase).toBe('HOLDING_SHORT');
    expect(find(e, 'N723EJ').clearances).toHaveLength(0);
    expect(e.getState().events.some((x) => x.kind === 'CLARIFICATION')).toBe(true);
    expect(e.getState().events.some((x) => x.speaker === 'PILOT' && /^Say again, Cessna seven two three echo juliet$/.test(x.text))).toBe(true);
  });

  it('medium confidence (0.6-0.8) is accepted only when every entity is explicit', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N723EJ', 'H13', '13')] } });
    run(e, 3);
    // runway missing -> would be inferred at high confidence, but not at medium confidence
    const med = e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N723EJ', { confidence: 0.7 }));
    expect(med.status).toBe('clarify');
    expect(find(e, 'N723EJ').phase).toBe('HOLDING_SHORT');
    const full = e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N723EJ', { confidence: 0.7, runwayEnd: '13' }));
    expect(full.status).toBe('accepted');
  });

  it('high confidence may infer the assigned runway; with none assigned it asks', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N723EJ', 'H13', '13'), GA_PARKED('N5AA')] } });
    run(e, 3);
    expect(e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N723EJ', { confidence: 0.9 })).status).toBe('accepted');
    const noRwy = e.applyCommand(cmd('TAKEOFF', 'N5AA', { confidence: 0.9 }), { position: 'GND' });
    expect(noRwy.status).toBe('clarify');
  });

  it('ignores an identical command repeated within 5 sim-seconds, then accepts it again later', () => {
    const dep = makeEngine({
      scenario: {
        spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: true, initialFrequencyId: 'TWR',
          start: { kind: 'airborne', pos: { x: 0, y: -18000 }, altitudeFt: 2000, headingDeg: 0, speedKt: 190, runwayEnd: '13' } }],
      },
    });
    const h = cmd('HEADING', 'NKS451', { headingDeg: 90 });
    expect(dep.applyCommand(h).status).toBe('accepted');
    const ac = find(dep, 'NKS451');
    const clearancesBefore = ac.clearances.length;
    run(dep, 2);
    const dup = dep.applyCommand(h);
    expect(dup.status).toBe('rejected');
    if (dup.status === 'rejected') expect(dup.reason).toMatch(/duplicate/i);
    expect(ac.clearances.length).toBe(clearancesBefore);
    const info = dep.getState().events.filter((x) => x.kind === 'INFO' && (x.data as { duplicate?: boolean } | undefined)?.duplicate);
    expect(info).toHaveLength(1);
    // no pilot readback for the duplicate
    expect(dep.getState().events.filter((x) => x.speaker === 'PILOT' && /heading/i.test(x.text))).toHaveLength(1);
    run(dep, 4);
    expect(dep.applyCommand(h).status).toBe('accepted');
    expect(ac.clearances.length).toBe(clearancesBefore + 1);
    // a different heading is not a duplicate
    expect(dep.applyCommand(cmd('HEADING', 'NKS451', { headingDeg: 120 })).status).toBe('accepted');
  });

  it('CONTACT_FREQUENCY switches frequency after the readback; the old frequency is then ignored', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N723EJ', 'H13', '13', 'C172', 'GND')] } });
    const ac = find(e, 'N723EJ');
    run(e, 3);
    const out = e.applyCommand(cmd('CONTACT_FREQUENCY', 'N723EJ', { frequencyMhz: 120.3, frequencyId: 'TWR' }), { position: 'GND' });
    expect(out.status).toBe('accepted');
    if (out.status === 'accepted') expect(out.readback).toBe('Tower one two zero point three, Cessna seven two three echo juliet');
    // still on the old frequency while reading back
    expect(ac.frequencyMhz).toBe(121.9);
    expect(runUntil(e, () => ac.frequencyMhz === 120.3, 15)).toBe(true);
    expect(ac.frequencyId).toBe('TWR');
    expect(e.getState().events.some((x) => x.kind === 'HANDOFF')).toBe(true);
    // Ground can no longer talk to it
    const old = e.applyCommand(cmd('HOLD_POSITION', 'N723EJ'), { position: 'GND' });
    expect(old.status).toBe('rejected');
    if (old.status === 'rejected') expect(old.reason).toMatch(/not on frequency/i);
    expect(e.applyCommand(cmd('LINE_UP_AND_WAIT', 'N723EJ', { runwayEnd: '13' }), { position: 'TWR' }).status).toBe('accepted');
    // pilot checks in on the new frequency
    run(e, 5);
    expect(e.getState().events.some((x) => x.speaker === 'PILOT' && x.frequencyMhz === 120.3)).toBe(true);
  });

  it('contact ground uses the abbreviated form; same frequency and nonsense frequency are rejected', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('NKS451', 'H13', '13', 'A320', 'TWR')] } });
    const ok = e.applyCommand(cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyMhz: 121.9, frequencyId: 'GND' }));
    expect(ok.status).toBe('accepted');
    if (ok.status === 'accepted') expect(ok.readback).toBe('Ground point niner, Spirit four fifty one');
    expect(e.applyCommand(cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyMhz: 120.3 })).status).toBe('rejected');
    expect(e.applyCommand(cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyMhz: 456.7 })).status).toBe('rejected');
  });

  it('rejects instructions the aircraft cannot follow in its current state', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED(), ARRIVING('N5AA', '13', 6)] } });
    run(e, 3);
    const rej = (c: ParsedCommand, p: 'GND' | 'TWR') => e.applyCommand(c, { position: p }).status;
    expect(rej(cmd('HEADING', 'N723EJ', { headingDeg: 90 }), 'GND')).toBe('rejected'); // on the ground
    expect(rej(cmd('ALTITUDE', 'N723EJ', { altitudeFt: 3000 }), 'GND')).toBe('rejected');
    expect(rej(cmd('LAND', 'N723EJ', { runwayEnd: '13' }), 'GND')).toBe('rejected');
    expect(rej(cmd('TAXI', 'N5AA', { destination: 'GA1' }), 'TWR')).toBe('rejected'); // airborne
    expect(rej(cmd('TAKEOFF', 'N5AA', { runwayEnd: '13' }), 'TWR')).toBe('rejected');
    expect(rej(cmd('GO_AROUND', 'N723EJ'), 'GND')).toBe('rejected');
    // pilot explains
    const out = e.applyCommand(cmd('TAKEOFF', 'N5AA', { runwayEnd: '13' }), { position: 'TWR' });
    expect(out.status === 'rejected' && out.pilotResponse).toBe(`Unable, we're airborne, ${find(e, 'N5AA').spokenCallsign}`);
  });

  it('UNKNOWN commands ask for clarification and SAY_AGAIN makes the pilot repeat', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    run(e, 10);
    expect(e.applyCommand(cmd('UNKNOWN', 'N723EJ', { issues: ['not understood'] }), { position: 'GND' }).status).toBe('clarify');
    const out = e.applyCommand(cmd('SAY_AGAIN', 'N723EJ'), { position: 'GND' });
    expect(out.status === 'rejected' && out.pilotResponse).toMatch(/ready to taxi/);
  });

  it('logs the controller transmission once per transmissionId and notifies subscribers', () => {
    const e = makeEngine({ scenario: { spawns: [GA_PARKED()] } });
    let n = 0;
    const un = e.subscribe(() => n++);
    run(e, 5);
    const before = n;
    expect(before).toBe(50);
    e.applyCommand(cmd('PUSHBACK', 'N723EJ', { rawText: 'N723EJ push back' }), { position: 'GND', transmissionId: 't1' });
    e.applyCommand(cmd('TAXI', 'N723EJ', { rawText: 'N723EJ push back', destination: 'RWY22', runwayEnd: '22' }), { position: 'GND', transmissionId: 't1' });
    expect(e.getState().events.filter((x) => x.speaker === 'ATC')).toHaveLength(1);
    un();
    run(e, 1);
    expect(n).toBe(before + 2);
  });
});
