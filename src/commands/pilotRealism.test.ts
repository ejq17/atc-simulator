/** Parser side of pilot realism: abbreviated callsigns (AIM 4-2-4), "unable", "did you copy", transmission size. */
import { describe, expect, it } from 'vitest';
import { parse } from './parse';
import { resolveCallsign } from './callsign';
import { normalize } from './normalize';
import { AIRCRAFT, CTX } from './testkit';
import type { AircraftRef } from './callsign';

describe('abbreviated civil callsigns', () => {
  it('"Cessna three echo juliet" resolves to N723EJ and is flagged as abbreviated', () => {
    const r = resolveCallsign(normalize('Cessna three echo juliet').tokens, AIRCRAFT);
    expect(r.callsign).toBe('N723EJ');
    expect(r.abbreviated).toBe(true);
    const full = resolveCallsign(normalize('Cessna seven two three echo juliet').tokens, AIRCRAFT);
    expect(full.abbreviated).toBe(false);
    const airline = resolveCallsign(normalize('Spirit four fifty one').tokens, AIRCRAFT);
    expect(airline.abbreviated).toBe(false);
  });
  it('the parsed command carries callsignAbbreviated', () => {
    const p = parse('Cessna three echo juliet, runway one three, cleared for takeoff', CTX);
    expect(p.commands[0].kind).toBe('TAKEOFF');
    expect(p.commands[0].callsignAbbreviated).toBe(true);
    const f = parse('Cessna seven two three echo juliet, runway one three, cleared for takeoff', CTX);
    expect(f.commands[0].callsignAbbreviated).toBeUndefined();
  });
  it('is not accepted for an aircraft that has not called yet (communications not established)', () => {
    const fresh: AircraftRef[] = AIRCRAFT.map((a) => (a.callsign === 'N723EJ' ? { ...a, contacted: false } : a));
    expect(resolveCallsign(normalize('three echo juliet').tokens, fresh).callsign).toBeNull();
    expect(resolveCallsign(normalize('Cessna seven two three echo juliet').tokens, fresh).callsign).toBe('N723EJ'); // full callsign always works
    const contacted: AircraftRef[] = AIRCRAFT.map((a) => (a.callsign === 'N723EJ' ? { ...a, contacted: true } : a));
    expect(resolveCallsign(normalize('three echo juliet').tokens, contacted).callsign).toBe('N723EJ');
  });
});

describe('talking to the pilot', () => {
  it.each([
    ['N723EJ, unable', 'UNABLE'],
    ['N723EJ, unable closed traffic', 'UNABLE'],
    ['Cessna seven two three echo juliet, request denied', 'UNABLE'],
    ['N723EJ, did you copy', 'DID_YOU_COPY'],
    ['N723EJ, do you copy', 'DID_YOU_COPY'],
    ['N723EJ, how do you hear me', 'DID_YOU_COPY'],
  ])('%s', (say, kind) => {
    const p = parse(say, CTX);
    expect(p.commands).toHaveLength(1);
    expect(p.commands[0].kind).toBe(kind);
    expect(p.commands[0].callsign).toBe('N723EJ');
    expect(p.commands[0].confidence).toBeGreaterThan(0.8);
  });
  it('"unable" swallows its explanation instead of reading it as instructions', () => {
    const p = parse('N723EJ, unable, runway one three is closed to landing traffic', CTX);
    expect(p.commands.map((c) => c.kind)).toEqual(['UNABLE']);
  });
});

describe('transmission size', () => {
  it('every command of a multi-instruction transmission carries the instruction count', () => {
    const p = parse('N723EJ, turn left heading two seven zero, climb and maintain three thousand, reduce speed to one zero zero', CTX);
    expect(p.commands.length).toBeGreaterThanOrEqual(3);
    for (const c of p.commands) expect(c.groupSize).toBe(p.commands.length);
  });
  it('a single instruction has none', () => {
    expect(parse('N723EJ, climb and maintain three thousand', CTX).commands[0].groupSize).toBeUndefined();
  });
});
