import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_KINDS, FIELD_TABLE, LLM_RESPONSE_SCHEMA, SYSTEM_PROMPT, parseWireResponse, resetFieldWarnings, toLlmCommand } from './prompt';

const README = readFileSync(fileURLToPath(new URL('../../src/commands/README.md', import.meta.url)), 'utf8');
const TYPES = readFileSync(fileURLToPath(new URL('../../src/sim/types.ts', import.meta.url)), 'utf8');

describe('response schema', () => {
  const item = LLM_RESPONSE_SCHEMA.properties.commands.items;
  it('kind enum contains every CommandKind', () => {
    expect(item.properties.kind.enum).toEqual(COMMAND_KINDS);
    // The ClearanceKind members are written as `| 'NAME'` in types.ts; every one of them must be listed.
    const declared = [...TYPES.slice(TYPES.indexOf('export type ClearanceKind'), TYPES.indexOf('/** Traffic described')).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(30);
    for (const k of declared) expect(COMMAND_KINDS).toContain(k);
    for (const k of ['SAY_AGAIN', 'DID_YOU_COPY', 'UNABLE', 'READ_BACK_HOLD', 'UNKNOWN']) expect(COMMAND_KINDS).toContain(k);
  });
  it('every kind is in the grammar README and in the prompt catalogue', () => {
    for (const k of COMMAND_KINDS) {
      // Some kinds are documented there only through their rule name (ruleAirTaxi, ruleOverhead).
      const camel = 'rule' + k.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join('');
      expect(README.includes(k) || README.includes(camel), k).toBe(true);
      expect(SYSTEM_PROMPT, k).toContain(k);
    }
  });
  it('respects the structured-output rules: all properties required, no constraints, at most 16 unions', () => {
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(Object.keys(item.properties));
    expect(item.properties.fields.items.required).toEqual(['name', 'value']);
    const text = JSON.stringify(LLM_RESPONSE_SCHEMA);
    expect(text).not.toMatch(/minLength|maxLength|minimum|maximum|minItems|maxItems/);
    expect((text.match(/anyOf/g) ?? []).length).toBeLessThanOrEqual(16);
  });
  it('the prompt is frozen text with 8 to 12 worked examples', () => {
    const examples = SYSTEM_PROMPT.split('# Examples')[1].split('\n').filter((l) => /^\d+\. "/.test(l));
    expect(examples.length).toBeGreaterThanOrEqual(8);
    expect(examples.length).toBeLessThanOrEqual(12);
    expect(SYSTEM_PROMPT).toContain('behindCallsign');
  });
});

describe('FIELD_TABLE', () => {
  const block = TYPES.slice(TYPES.indexOf('export interface ParsedCommand'), TYPES.indexOf('export interface ParseResult'));
  const fieldNames = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  // Filled by the browser, not the model, or grouped through dotted names / sentinels.
  const NOT_FROM_MODEL = new Set(['kind', 'callsign', 'callsignCandidates', 'callsignAbbreviated', 'groupSize', 'toNodeId', 'confidence', 'rawText',
    'normalizedText', 'issues', 'interpretedBy', 'traffic', 'info', 'ifr', 'hold']);
  it('has every ParsedCommand field the model can set', () => {
    expect(fieldNames.length).toBeGreaterThan(40);
    for (const f of fieldNames) if (!NOT_FROM_MODEL.has(f)) expect(Object.keys(FIELD_TABLE), f).toContain(f);
  });
  it('every table name is taught in the prompt and nested names are dotted', () => {
    for (const name of Object.keys(FIELD_TABLE)) expect(SYSTEM_PROMPT, name).toContain(name);
    for (const group of ['traffic', 'info', 'ifr', 'hold']) expect(Object.keys(FIELD_TABLE).some((n) => n.startsWith(group + '.'))).toBe(true);
  });
});

describe('parseWireResponse / toLlmCommand', () => {
  beforeEach(() => resetFieldWarnings());
  const cmd = (kind: string, callsign: string, ...f: [string, string][]) => ({ kind, callsign, fields: f.map(([name, value]) => ({ name, value })) }) as never;

  it('rejects unknown kinds and missing arrays', () => {
    expect(() => parseWireResponse('{"note":null}')).toThrow();
    expect(() => parseWireResponse('{"commands":[{"kind":"FLY_AWAY"}],"note":null}')).toThrow();
    expect(parseWireResponse('{"commands":[],"note":"  "}')).toEqual({ commands: [], note: null });
  });
  it('coerces numbers, booleans, lists and enums and maps an empty callsign to null', () => {
    const c = toLlmCommand(cmd('TAXI', '', ['route', 'A, C'], ['altitudeFt', '3000'], ['ifAble', 'true'], ['patternLeg', 'base'], ['frequencyMhz', '120.9']));
    expect(c).toEqual({ kind: 'TAXI', callsign: null, route: ['A', 'C'], altitudeFt: 3000, ifAble: true, patternLeg: 'base', frequencyMhz: 120.9 });
  });
  it('drops invalid enum, number and boolean values and empty values with a warning', () => {
    const warn: string[] = [];
    const c = toLlmCommand(cmd('HEADING', 'X1', ['turnDirection', 'up'], ['headingDeg', 'abc'], ['segment', 'yes'], ['fix', ''], ['reason', 'traffic']), (m) => warn.push(m));
    expect(c).toEqual({ kind: 'HEADING', callsign: 'X1', reason: 'traffic' });
    expect(warn).toHaveLength(3);
  });
  it('drops unknown names, logging each name once', () => {
    const warn: string[] = [];
    const w = (m: string) => warn.push(m);
    toLlmCommand(cmd('TAXI', 'X1', ['wat', '1'], ['toNodeId', 'n1']), w);
    toLlmCommand(cmd('TAXI', 'X1', ['wat', '2'], ['__proto__', 'x']), w);
    expect(warn.filter((m) => m.includes('"wat"'))).toHaveLength(1);
    expect(warn.some((m) => m.includes('toNodeId'))).toBe(true);
  });
  it('regroups nested ifr, info, traffic and hold fields', () => {
    const c = toLlmCommand(cmd('IFR_CLEARANCE', 'NKS451', ['ifr.destination', 'KPHL'], ['ifr.squawk', '4215'], ['ifr.initialAltitudeFt', '2000'], ['info.windDirDeg', '130'], ['info.calm', 'false'], ['hold.turns', 'left'], ['traffic.desc', 'cessna'], ['traffic.side', 'left']));
    expect(c).toEqual({
      kind: 'IFR_CLEARANCE', callsign: 'NKS451',
      ifr: { destination: 'KPHL', squawk: '4215', initialAltitudeFt: 2000 }, info: { windDirDeg: 130, calm: false },
      hold: { turns: 'left', asPublished: false }, traffic: { desc: 'cessna', side: 'left' },
    });
  });
});
