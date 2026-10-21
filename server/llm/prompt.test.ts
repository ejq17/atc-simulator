import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMAND_KINDS, LLM_RESPONSE_SCHEMA, SYSTEM_PROMPT, parseWireResponse, toLlmCommand } from './prompt';

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
  it('respects the structured-output rules: all properties required, no optional or constraint keywords, few unions', () => {
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(Object.keys(item.properties));
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

describe('parseWireResponse / toLlmCommand', () => {
  it('rejects unknown kinds and missing arrays', () => {
    expect(() => parseWireResponse('{"note":null}')).toThrow();
    expect(() => parseWireResponse('{"commands":[{"kind":"FLY_AWAY"}],"note":null}')).toThrow();
    expect(parseWireResponse('{"commands":[],"note":"  "}')).toEqual({ commands: [], note: null });
  });
  it('regroups ifr and info fields', () => {
    const c = toLlmCommand({ kind: 'IFR_CLEARANCE', callsign: 'NKS451', ifrDestination: 'KPHL', ifrSquawk: '4215', ifrInitialAltitudeFt: 2000, ifrExpectAltitudeFt: -1, windDirDeg: 130, calm: false } as never);
    expect(c).toEqual({ kind: 'IFR_CLEARANCE', callsign: 'NKS451', ifr: { destination: 'KPHL', squawk: '4215', initialAltitudeFt: 2000 }, info: { windDirDeg: 130 } });
  });
});
