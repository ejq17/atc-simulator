import { describe, expect, it } from 'vitest';
import { commandConfidence, type ConfidenceInputs } from './confidence';
import { parseTransmission } from './index';
import { AIRCRAFT, CTX } from './testkit';

const base: ConfidenceInputs = {
  kind: 'TAKEOFF', coverage: 1, callsignScore: 1, missingRequired: 0, conflicts: 0, unknownIds: 0, nonstandard: 0,
};

describe('commandConfidence', () => {
  it('is capped at 0.99 for a perfect parse', () => {
    expect(commandConfidence(base)).toBe(0.99);
  });

  it('drops with lower grammar coverage', () => {
    expect(commandConfidence({ ...base, coverage: 0.5 })).toBeLessThan(commandConfidence({ ...base, coverage: 0.9 }));
  });

  it('drops with a weaker callsign match', () => {
    const exact = commandConfidence({ ...base, callsignScore: 1 });
    const abbreviated = commandConfidence({ ...base, callsignScore: 0.8 });
    expect(abbreviated).toBeLessThan(exact);
    expect(abbreviated).toBeGreaterThan(0.8);
  });

  it('cannot exceed 0.4 without a callsign', () => {
    expect(commandConfidence({ ...base, callsignScore: null })).toBeLessThanOrEqual(0.4);
  });

  it('penalises missing and conflicting entities', () => {
    expect(commandConfidence({ ...base, missingRequired: 1 })).toBeLessThan(0.6);
    expect(commandConfidence({ ...base, conflicts: 1 })).toBeLessThan(0.7);
    expect(commandConfidence({ ...base, unknownIds: 1 })).toBeLessThan(0.9);
    expect(commandConfidence({ ...base, nonstandard: 1 })).toBeLessThan(0.95);
  });

  it('caps UNKNOWN commands at 0.1', () => {
    expect(commandConfidence({ ...base, kind: 'UNKNOWN' })).toBeLessThanOrEqual(0.1);
  });

  it('always stays inside [0, 1]', () => {
    const worst = commandConfidence({ ...base, coverage: 0, callsignScore: null, missingRequired: 5, conflicts: 5, unknownIds: 5, nonstandard: 5 });
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe('parse robustness', () => {
  const junk = [
    'runway', 'runway runway runway', 'taxi taxi taxi', 'via via', 'cross cross', 'hold short hold short',
    'cleared', 'cleared cleared to', 'contact contact', 'point point point', 'one one one one one one one one',
    'heading heading', 'turn left turn right', 'climb descend maintain', 'fl fl', 'wind', 'wind at', 'report',
    'n n n n', 'spirit', 'spirit spirit', 'delta delta delta', 'november', '...', '!!!', '12345', '.9 .9', 'a b c d e f',
    'Spirit 451 taxi to runway 99 via 7', 'Spirit 451 cleared for takeoff runway 0', 'N723EJ hold short of the',
  ];
  it.each(junk)('does not throw or invent a callsign for %j', (text) => {
    const r = parseTransmission(text, CTX);
    expect(r.commands.length).toBeGreaterThan(0);
    for (const c of r.commands) {
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
      if (c.callsign !== null) expect(AIRCRAFT.map((a) => a.callsign)).toContain(c.callsign);
    }
  });

  it('is deterministic', () => {
    const t = 'Spirit four fifty one, runway one three, cleared for takeoff';
    expect(parseTransmission(t, CTX)).toEqual(parseTransmission(t, CTX));
  });

  it('flags invalid runway numbers instead of inventing ends', () => {
    const r = parseTransmission('Spirit 451 cleared for takeoff runway 99', CTX);
    expect(r.commands[0].runwayEnd).toBeUndefined();
    expect(r.commands[0].issues.join()).toContain('invalid runway');
  });
});
