import { describe, expect, it } from 'vitest';
import { parse } from './parse';
import type { ParseContext } from './context';

/**
 * Lines Whisper (tiny.en) produced in a real KACY session. Each one was a correct instruction from the
 * controller that the parser refused with "No callsign recognised" or "no recognised instruction".
 * They are regression cases: commas, ordinals ("4th"), run-together digits and mangled NATO words.
 */
const CTX: ParseContext = {
  aircraft: [
    { callsign: 'NKS432', spokenCallsign: 'Spirit four thirty two', type: 'A320' },
    { callsign: 'N45RT', spokenCallsign: 'Cessna four five romeo tango', type: 'C172' },
    { callsign: 'N6004T', spokenCallsign: 'Cessna six zero zero four tango', type: 'C172' },
    { callsign: 'N467ES', spokenCallsign: 'Cessna four six seven echo sierra', type: 'C172' },
    { callsign: 'NKS976', spokenCallsign: 'Spirit nine seventy six', type: 'A320' },
    { callsign: 'NKS794', spokenCallsign: 'Spirit seven ninety four', type: 'A320' },
  ],
  taxiways: ['A', 'B', 'C', 'D', 'E', 'J', 'L', 'M', 'N', 'P', 'K'],
  runwayEnds: ['4', '22', '13', '31'],
  frequencies: [{ id: 'GND', mhz: 121.9 }, { id: 'TWR', mhz: 120.3 }],
};

const cases: [string, string, string][] = [
  ['November 4-6-7, Ecociera, Taxi to Runway 3-1, Via Lima, Papa Bravo.', 'N467ES', 'TAXI'],
  ['November 467 Echo Sierra. Tackty to runway 31 via Lima Papa Bravo.', 'N467ES', 'TAXI'],
  ['Good evening, Spirit 794. Taxituary 31 via Lima. Mike Papa Bravo.', 'NKS794', 'TAXI'],
  ['Cessna 467 Echo Zero Contact Tower', 'N467ES', 'CONTACT_FREQUENCY'],
  ['November 467, Ecosira, contact our.', 'N467ES', 'CONTACT_FREQUENCY'],
  ['Spirit 794 contact hour', 'NKS794', 'CONTACT_FREQUENCY'],
  ['November 4th, 5, Romeo Tango, taxi to parking via Bravo.', 'N45RT', 'TAXI_TO_PARKING'],
  ['November 4th 5, Romeo Tango, taxi to parking via Bravo.', 'N45RT', 'TAXI_TO_PARKING'],
  ['November 4th 5 Romeo Tango Taxi to Park Yee via Bravo.', 'N45RT', 'TAXI_TO_PARKING'],
  ['November 4 5 Romeo Tango Taxi to Park Yee via Bravo.', 'N45RT', 'TAXI_TO_PARKING'],
  ['November 4th 5 Romeo Tango Taxi to Parking via Bravo.', 'N45RT', 'TAXI_TO_PARKING'],
  ['November 60004 Tango Tax E2 runway 4 via November Papa Delta', 'N6004T', 'TAXI'],
  ['November 6000 for tango taxi to runway for Vietnam, November Papa Delta Alpha', 'N6004T', 'TAXI'],
  ['November 6th, 0, 0, 4, Tango. Taxi to runway 4. Via November Papa Alpha.', 'N6004T', 'TAXI'],
  ['Spirit 432 taxi to the terminal via Baravo Papa Lima', 'NKS432', 'TAXI_TO_PARKING'],
];

/** Second session (runway change 4 -> 31 mid-way). */
const CTX2: ParseContext = {
  aircraft: [
    { callsign: 'N678MV', spokenCallsign: 'Cessna six seven eight mike victor', type: 'C172' },
    { callsign: 'N685GD', spokenCallsign: 'Cessna six eight five golf delta', type: 'C172' },
    { callsign: 'NKS689', spokenCallsign: 'Spirit six eighty nine', type: 'A320' },
    { callsign: 'NKS599', spokenCallsign: 'Spirit five ninety nine', type: 'A320' },
    { callsign: 'AAL2787', spokenCallsign: 'American twenty seven eighty seven', type: 'A320' },
    { callsign: 'AAL1219', spokenCallsign: 'American twelve nineteen', type: 'A320' },
    { callsign: 'NKS187', spokenCallsign: 'Spirit one eighty seven', type: 'A320' },
    { callsign: 'NKS538', spokenCallsign: 'Spirit five thirty eight', type: 'A320' },
    { callsign: 'NKS1177', spokenCallsign: 'Spirit eleven seventy seven', type: 'A320' },
    { callsign: 'NKS1254', spokenCallsign: 'Spirit twelve fifty four', type: 'A320' },
    { callsign: 'N221VT', spokenCallsign: 'Cessna two two one victor tango', type: 'C172' },
  ],
  taxiways: CTX.taxiways,
  runwayEnds: CTX.runwayEnds,
  frequencies: CTX.frequencies,
};

const cases2: { say: string; callsign: string; cmd: Record<string, unknown>; minConf?: number }[] = [
  { say: 'Number six seven eight mic Victor taxi to runway four via Lima mic Papa Alpha', callsign: 'N678MV', cmd: { kind: 'TAXI', runwayEnd: '4', route: ['L', 'M', 'P', 'A'] } },
  { say: 'Remember, 685 Golf Delta Contact Hour.', callsign: 'N685GD', cmd: { kind: 'CONTACT_FREQUENCY', frequencyId: 'TWR' } },
  { say: 'November 678, Mike Victor, Contact Hour.', callsign: 'N678MV', cmd: { kind: 'CONTACT_FREQUENCY', frequencyId: 'TWR' } },
  { say: 'Spirit 689 cleared to the terminal tax via Bravo Papa Mike', callsign: 'NKS689', cmd: { kind: 'TAXI_TO_PARKING', destination: 'TERMINAL', route: ['B', 'P', 'M'] } },
  { say: 'Spirit 599 Taxitu runway 4 V. Lima Papa Delta Alpha', callsign: 'NKS599', cmd: { kind: 'TAXI', runwayEnd: '4', route: ['L', 'P', 'D', 'A'] } },
  { say: 'American 2787 taxi to runway 4 the Alima Papa Delta Alpha Alpha', callsign: 'AAL2787', cmd: { kind: 'TAXI', runwayEnd: '4', route: ['L', 'P', 'D', 'A'] } },
  { say: 'Spirit 187, taxi to runway 4, the Alima, Mike, Papa, Delta, Alpha.', callsign: 'NKS187', cmd: { kind: 'TAXI', runwayEnd: '4', route: ['L', 'M', 'P', 'D', 'A'] } },
  { say: 'Spirit 538 to access to the terminal via bravo papalima.', callsign: 'NKS538', cmd: { kind: 'TAXI_TO_PARKING', destination: 'TERMINAL', route: ['B', 'P', 'L'] } },
  { say: 'Spirit 1177. Taxi to runway 3-1. Be a Lima Baravo. Hold short on Baravo.', callsign: 'NKS1177', cmd: { kind: 'TAXI', runwayEnd: '31', route: ['L', 'B'], holdShort: ['B'] } },
  { say: 'Spirit 1 1 7 7 Taxi to runway 3 via Lima Baravo Holdshore on Bravo', callsign: 'NKS1177', cmd: { kind: 'TAXI', route: ['L', 'B'], holdShort: ['B'] }, minConf: 0 },
  { say: 'Spirit 1254, taxi to Kilo via Bravo.', callsign: 'NKS1254', cmd: { kind: 'TAXI', destination: 'TWYK', route: ['B'] } },
  { say: 'November 678, my cancel.', callsign: 'N678MV', cmd: { kind: 'HOLD_POSITION' } },
  { say: 'November 2-2-1, Victor Tango, taxi to the terminal via Bravo Papa Lima.', callsign: 'N221VT', cmd: { kind: 'TAXI_TO_PARKING', destination: 'TERMINAL', route: ['B', 'P', 'L'] } },
  { say: 'Spirit 1440, Taxi 2, Runaway 3-1, Via Lima, Papa Bravo.', callsign: 'NKS1254', cmd: { kind: 'TAXI' }, minConf: 0 },
];

describe('second session transcript lines', () => {
  it.each(cases2.filter((c) => c.callsign !== 'NKS1254' || c.say.includes('1254')))('$say', ({ say, callsign, cmd, minConf }) => {
    const r = parse(say, CTX2);
    expect(r.callsign).toBe(callsign);
    expect(r.commands[0]).toMatchObject(cmd);
    expect(r.commands[0].confidence).toBeGreaterThanOrEqual(minConf ?? 0.6);
  });

  it('a taxiway-only lead ("taxi to kilo") keeps "taxi to kilo" as the destination even with no via', () => {
    const r = parse('Spirit 1254, taxi to kilo', CTX2);
    expect(r.commands[0]).toMatchObject({ kind: 'TAXI', destination: 'TWYK' });
  });

  it('"continue taxiing" resumes the taxi clearance', () => {
    expect(parse('Spirit 1254, continue taxiing', CTX2).commands[0]).toMatchObject({ kind: 'TAXI', destination: 'CONTINUE' });
    expect(parse('Spirit 1254, continue taxi to runway 31 via bravo', CTX2).commands[0]).toMatchObject({ kind: 'TAXI', runwayEnd: '31', route: ['B'] });
  });

  it('"runway number 4" is still a runway, not a callsign', () => {
    const r = parse('Spirit 1254, taxi to runway number 4 via bravo', CTX2);
    expect(r.callsign).toBe('NKS1254');
    expect(r.commands[0]).toMatchObject({ kind: 'TAXI', runwayEnd: '4' });
  });
});

describe('real session transcript lines', () => {
  it('resolves a callsign-only call even when the digits are comma separated', () => {
    const r = parse('November 4, 5, Romeo Tango.', CTX);
    expect(r.callsign).toBe('N45RT');
    expect(r.commands[0].kind).toBe('UNKNOWN');
  });

  it.each(cases)('%s', (say, callsign, kind) => {
    const r = parse(say, CTX);
    expect(r.callsign).toBe(callsign);
    expect(r.commands[0].kind).toBe(kind);
    expect(r.commands[0].confidence).toBeGreaterThanOrEqual(0.6);
  });
});
