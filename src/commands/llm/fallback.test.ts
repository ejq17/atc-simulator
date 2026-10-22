import { describe, expect, it } from 'vitest';
import type { ParseResult, ParsedCommand } from '../../sim/types';
import { CTX } from '../testkit';
import { parseTransmission } from '..';
import { INTERPRETER_BELOW, adoptLlmCommands, mergeResults, needsInterpreter } from './fallback';
import type { LlmCommand, LlmParseResponse } from './contract';

const cmd = (over: Partial<ParsedCommand>): ParsedCommand => ({ kind: 'TAKEOFF', callsign: 'N723EJ', confidence: 0.99, rawText: 'x', normalizedText: 'x', issues: [], ...over });
const result = (commands: ParsedCommand[]): ParseResult => ({ commands, callsign: commands[0]?.callsign ?? null, rawText: 'x', normalizedText: 'x' });
const resp = (commands: LlmCommand[]): LlmParseResponse => ({ commands, model: 'test-model', latencyMs: 5 });
const TEXT = 'november seven two three echo juliet go ahead and cross thirteen';

describe('needsInterpreter', () => {
  it('is false for a clear instruction', () => {
    expect(needsInterpreter(parseTransmission('Cessna seven two three echo juliet, runway one three, cleared for takeoff', CTX))).toBe(false);
  });
  it('is true with no commands, an UNKNOWN command, or low confidence', () => {
    expect(needsInterpreter(result([]))).toBe(true);
    expect(needsInterpreter(result([cmd({ kind: 'UNKNOWN', confidence: 0.1 })]))).toBe(true);
    expect(needsInterpreter(result([cmd({}), cmd({ kind: 'HEADING', confidence: INTERPRETER_BELOW - 0.01 })]))).toBe(true);
  });
  it('is false exactly at the threshold', () => {
    expect(needsInterpreter(result([cmd({ confidence: INTERPRETER_BELOW })]))).toBe(false);
  });
  it('is true for a real unparseable transmission', () => {
    expect(needsInterpreter(parseTransmission('Cessna seven two three echo juliet, whenever you like go ahead and zoom off', CTX))).toBe(true);
  });
});

describe('adoptLlmCommands', () => {
  it('builds a full ParsedCommand: exact callsign, grammar fields, interpretedBy, confidence 0.9', () => {
    const r = adoptLlmCommands(resp([{ kind: 'CROSS_RUNWAY', callsign: 'N723EJ', runwayEnd: '13', crossRunwayId: '13/31' }]), TEXT, CTX)!;
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toMatchObject({ kind: 'CROSS_RUNWAY', callsign: 'N723EJ', runwayEnd: '13', interpretedBy: 'llm', confidence: 0.9, issues: [], rawText: TEXT });
    expect(r.commands[0].normalizedText).toBeTruthy();
    expect(r.callsign).toBe('N723EJ');
  });
  it('resolves a spoken callsign through the grammar resolver', () => {
    const r = adoptLlmCommands(resp([{ kind: 'GO_AROUND', callsign: 'Spirit four fifty one' }]), TEXT, CTX)!;
    expect(r.commands[0].callsign).toBe('NKS451');
  });
  it('matches the callsign case- and space-insensitively', () => {
    const r = adoptLlmCommands(resp([{ kind: 'GO_AROUND', callsign: 'nks 451' }]), TEXT, CTX)!;
    expect(r.commands[0].callsign).toBe('NKS451');
  });
  it('drops a command whose callsign is not active and records why on the survivors', () => {
    const r = adoptLlmCommands(resp([
      { kind: 'GO_AROUND', callsign: 'N99999' },
      { kind: 'HEADING', callsign: 'NKS451', headingDeg: 90 },
    ]), TEXT, CTX)!;
    expect(r.commands.map((c) => c.callsign)).toEqual(['NKS451']);
    expect(r.commands[0].issues.join(' ')).toContain('N99999');
    expect(r.commands[0].confidence).toBe(0.8);
  });
  it('drops a command with no callsign', () => {
    expect(adoptLlmCommands(resp([{ kind: 'GO_AROUND', callsign: null }]), TEXT, CTX)).toBeNull();
  });
  it('flags an unknown runway and takes 0.1 off per issue', () => {
    const r = adoptLlmCommands(resp([{ kind: 'TAKEOFF', callsign: 'N723EJ', runwayEnd: '27' }]), TEXT, CTX)!;
    expect(r.commands[0].issues).toEqual(['unknown runway 27']);
    expect(r.commands[0].confidence).toBe(0.8);
  });
  it('flags unknown taxiways, frequencies and fixes through validateFields', () => {
    const ctx = { ...CTX, fixes: [{ id: 'CARYL' }] };
    const r = adoptLlmCommands(resp([
      { kind: 'TAXI', callsign: 'N723EJ', route: ['Z'] },
      { kind: 'CONTACT_FREQUENCY', callsign: 'NKS451', frequencyMhz: 133.7 },
      { kind: 'DIRECT_FIX', callsign: 'AAL1234', fix: 'NOPEE' },
    ]), TEXT, ctx)!;
    expect(r.commands[0].issues).toContain('unknown taxiway Z');
    expect(r.commands[1].issues[0]).toMatch(/133.7/);
    expect(r.commands[2].issues).toContain('unknown fix NOPEE');
  });
  it('fills frequencyId from a known frequency', () => {
    const r = adoptLlmCommands(resp([{ kind: 'CONTACT_FREQUENCY', callsign: 'N723EJ', frequencyMhz: 121.9 }]), TEXT, CTX)!;
    expect(r.commands[0]).toMatchObject({ frequencyId: 'GND', confidence: 0.9 });
  });
  it('floors confidence at 0.5', () => {
    const r = adoptLlmCommands(resp([{ kind: 'TAXI', callsign: 'N723EJ', route: ['Q', 'R', 'S', 'T', 'U', 'V'] }]), TEXT, CTX)!;
    expect(r.commands[0].issues.length).toBeGreaterThan(4);
    expect(r.commands[0].confidence).toBe(0.5);
  });
  it('resolves behindCallsign and flags an unknown one', () => {
    const ok = adoptLlmCommands(resp([{ kind: 'CROSS_RUNWAY', callsign: 'N723EJ', runwayEnd: '13', behindCallsign: 'NKS451' }]), TEXT, CTX)!;
    expect(ok.commands[0].behindCallsign).toBe('NKS451');
    const bad = adoptLlmCommands(resp([{ kind: 'CROSS_RUNWAY', callsign: 'N723EJ', runwayEnd: '13', behindCallsign: 'N00000' }]), TEXT, CTX)!;
    expect(bad.commands[0].behindCallsign).toBeUndefined();
    expect(bad.commands[0].issues.join(' ')).toContain('N00000');
  });
  it('returns null for an empty response, UNKNOWN-only or malformed commands', () => {
    expect(adoptLlmCommands(resp([]), TEXT, CTX)).toBeNull();
    expect(adoptLlmCommands(resp([{ kind: 'UNKNOWN', callsign: 'N723EJ' }]), TEXT, CTX)).toBeNull();
    expect(adoptLlmCommands({ model: 'm', latencyMs: 1 } as unknown as LlmParseResponse, TEXT, CTX)).toBeNull();
  });
  it('marks groupSize on multi-command results', () => {
    const r = adoptLlmCommands(resp([{ kind: 'GO_AROUND', callsign: 'N723EJ' }, { kind: 'HEADING', callsign: 'N723EJ', headingDeg: 90 }]), TEXT, CTX)!;
    expect(r.commands.map((c) => c.groupSize)).toEqual([2, 2]);
  });
});

describe('mergeResults', () => {
  const grammar = result([cmd({ kind: 'UNKNOWN', confidence: 0.1 })]);
  it('prefers the interpreter result when it has commands', () => {
    const llm = result([cmd({ interpretedBy: 'llm' })]);
    expect(mergeResults(grammar, llm)).toBe(llm);
  });
  it('keeps a confident grammar command as parsed, even when the model words it differently', () => {
    const g = result([cmd({ kind: 'HEADING', headingDeg: 90, confidence: 0.95 }), cmd({ kind: 'UNKNOWN', confidence: 0.1 })]);
    const llm = result([
      cmd({ kind: 'HEADING', headingDeg: 270, interpretedBy: 'llm', confidence: 0.9 }),
      cmd({ kind: 'GO_AROUND', interpretedBy: 'llm', confidence: 0.9 }),
    ]);
    const m = mergeResults(g, llm);
    expect(m.commands.map((c) => c.kind)).toEqual(['HEADING', 'GO_AROUND']);
    expect(m.commands[0].headingDeg).toBe(90);
    expect(m.commands[0].interpretedBy).toBeUndefined();
    expect(m.commands[1].interpretedBy).toBe('llm');
    expect(m.commands.map((c) => c.groupSize)).toEqual([2, 2]);
  });
  it('still issues a confident grammar command the model left out', () => {
    const g = result([cmd({ kind: 'HEADING', headingDeg: 90, confidence: 0.95 }), cmd({ kind: 'ALTITUDE', confidence: 0.3 })]);
    const llm = result([cmd({ kind: 'GO_AROUND', interpretedBy: 'llm' })]);
    const m = mergeResults(g, llm);
    expect(m.commands.map((c) => c.kind).sort()).toEqual(['GO_AROUND', 'HEADING']);
  });
  it('uses the model result untouched when the grammar had nothing confident', () => {
    const llm = result([cmd({ interpretedBy: 'llm' })]);
    expect(mergeResults(result([cmd({ confidence: 0.3 })]), llm)).toBe(llm);
  });
  it('keeps the grammar result for null or empty', () => {
    expect(mergeResults(grammar, null)).toBe(grammar);
    expect(mergeResults(grammar, result([]))).toBe(grammar);
  });
});
