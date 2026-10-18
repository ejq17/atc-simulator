/** Parser: pushback with a direction, "read back hold instructions" (JO 7110.65 3-7-2) and progressive-taxi segments. */
import { describe, expect, it } from 'vitest';
import { parseTransmission } from './index';
import { CTX } from './testkit';

describe('ground operations phraseology', () => {
  it('"read back hold instructions" and its variants', () => {
    for (const t of ['Spirit four fifty one, read back hold instructions', 'Spirit four fifty one, read back hold short instructions', 'Spirit four fifty one, readback hold short']) {
      const r = parseTransmission(t, CTX);
      expect(r.commands.map((c) => c.kind), t).toEqual(['READ_BACK_HOLD']);
      expect(r.commands[0].issues, t).toEqual([]);
    }
  });

  it('pushback with a tail or nose direction is parsed and marked non-standard (JO 7110.65 has no pushback phrase)', () => {
    const tail = parseTransmission('Spirit four fifty one, pushback approved, tail east', CTX).commands[0];
    expect(tail).toMatchObject({ kind: 'PUSHBACK', pushTailDeg: 90 });
    const face = parseTransmission('Spirit four fifty one, push back approved, face south', CTX).commands[0];
    expect(face).toMatchObject({ kind: 'PUSHBACK', pushFaceDeg: 180 });
    expect(tail.issues.join(' ')).toMatch(/no pushback phrase/);
    expect(tail.confidence).toBeLessThan(1);
  });

  it('"turn left on Bravo, continue to Charlie, hold short of runway four" is a turn, a segment and a hold short', () => {
    const r = parseTransmission('Spirit four fifty one, turn left on bravo, continue to charlie, hold short of runway four', CTX);
    expect(r.commands.map((c) => c.kind)).toEqual(['EXIT_RUNWAY', 'TAXI', 'HOLD_SHORT']);
    expect(r.commands[0]).toMatchObject({ turnDirection: 'left', exitTaxiway: 'B' });
    expect(r.commands[1]).toMatchObject({ segment: true, destination: 'TWYC' });
    expect(r.commands[1].issues.join(' ')).toMatch(/non-standard/);
    expect(r.commands[2].holdShort).toEqual(['RWY4']);
  });

  it('"continue taxiing via bravo to charlie" keeps its 3-7-2 form', () => {
    const r = parseTransmission('Spirit four fifty one, continue taxiing via bravo to charlie', CTX);
    expect(r.commands[0].kind).toBe('TAXI');
    expect(r.commands[0].route).toEqual(['B']);
  });
});
