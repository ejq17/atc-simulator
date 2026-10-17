import { describe, expect, it } from 'vitest';
import { createEngine } from '../../sim/engine';
import { loadKacy, runwayEntryNodes } from '../../airport';
import { getPresetWeather } from '../../weather/presets';
import { run, runUntil, say } from '../../game/testkit';
import type { Aircraft, Clearance, Scenario, ScenarioAircraftSpawn, SimulationState } from '../../sim/types';
import { BAY_ORDER, bayForFrequency, bayListFor, bayWorkedByPlayer, createStripBoard, displayOrder, markForClearance, zuluHm } from './stripModel';

const airport = loadKacy();
const freq = (id: string) => airport.frequencies.find((f) => f.id === id)!.mhz;
const nodeId = (e: unknown) => (e as { node?: { id: string }; id?: string }).node?.id ?? (e as { id: string }).id;
const START = Date.UTC(2026, 9, 17, 12, 0, 0);

function clr(kind: Clearance['kind'], extra: Partial<Clearance> = {}): Clearance {
  return { id: `c-${kind}-${Math.random()}`, kind, issuedAtSec: 5, byPosition: 'TWR', ...extra };
}

/** A hand-built state: just enough aircraft data for the board. */
function fakeState(aircraft: Partial<Aircraft>[], timeSec = 0): SimulationState {
  const map: Record<string, Aircraft> = {};
  for (const a of aircraft) {
    const full = {
      id: a.callsign, callsign: a.callsign, type: 'A320', flightRules: 'IFR', origin: 'KPHL', destination: 'KACY', isDeparture: false, onGround: false,
      phase: 'FINAL', frequencyMhz: freq('TWR'), clearances: [], assignedRunwayEnd: '13', ...a,
    } as Aircraft;
    map[full.id] = full;
  }
  return { clock: { timeSec, dtSec: 0.1, speed: 1, tick: 0 }, airport, aircraft: map } as unknown as SimulationState;
}

describe('bay assignment', () => {
  it('maps every KACY frequency to the bay of its position', () => {
    expect(bayForFrequency(airport, freq('CLNC'))).toBe('CLNC');
    expect(bayForFrequency(airport, freq('GND'))).toBe('GND');
    expect(bayForFrequency(airport, freq('TWR'))).toBe('TWR');
    expect(bayForFrequency(airport, freq('APP'))).toBe('APPDEP');
    expect(bayForFrequency(airport, freq('DEP'))).toBe('APPDEP');
    expect(bayForFrequency(airport, 100.0)).toBe('OTHER');
    expect(bayForFrequency(airport, freq('ATIS'))).toBe('OTHER');
  });

  it('player bays versus AI bays follow the player positions; APP/DEP is the player\'s if either is', () => {
    expect(bayWorkedByPlayer('GND', ['GND'])).toBe(true);
    expect(bayWorkedByPlayer('TWR', ['GND'])).toBe(false);
    expect(bayWorkedByPlayer('APPDEP', ['DEP'])).toBe(true);
    expect(bayWorkedByPlayer('CLNC', ['TWR', 'GND'])).toBe(false);
  });

  it('a session shows the bays of its positions, in board order', () => {
    expect(bayListFor(['TWR', 'GND'])).toEqual(['GND', 'TWR']);
    expect(bayListFor(['DEP', 'CLNC', 'TWR', 'GND'])).toEqual(['CLNC', 'GND', 'TWR', 'APPDEP']);
    expect(BAY_ORDER).toEqual(['CLNC', 'GND', 'TWR', 'APPDEP']);
  });
});

describe('printing and movement', () => {
  it('prints a strip into the bay of the frequency the aircraft is on, once', () => {
    const board = createStripBoard({ startUtcMs: START, wallNow: () => 1000 });
    board.update(fakeState([{ callsign: 'NKS451' }, { callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', frequencyMhz: freq('GND') }]));
    expect(board.bay('TWR').map((s) => s.callsign)).toEqual(['NKS451']);
    expect(board.bay('GND').map((s) => s.callsign)).toEqual(['N723EJ']);
    board.update(fakeState([{ callsign: 'NKS451' }, { callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', frequencyMhz: freq('GND') }]));
    expect(board.all()).toHaveLength(2);
    expect(board.get('NKS451')!.fields.typeEquip).toBe('A320/L');
    expect(board.get('N723EJ')!.fields.typeEquip).toBe('C172/G');
  });

  it('highlights a strip printed during play but not the ones already on the rack at session start', () => {
    let wall = 5000;
    const board = createStripBoard({ startUtcMs: START, wallNow: () => wall });
    board.update(fakeState([{ callsign: 'A1' }]));
    wall = 9000;
    board.update(fakeState([{ callsign: 'A1' }, { callsign: 'A2' }], 30));
    expect(board.get('A1')!.bayEnteredWall).toBe(0);
    expect(board.get('A2')!.bayEnteredWall).toBe(9000);
    expect(board.get('A2')!.entry).toBe('print');
    expect(board.get('A2')!.printedSec).toBe(30);
  });

  it('moves the strip to the next bay on a frequency change and puts it at the end of that bay', () => {
    let wall = 1;
    const board = createStripBoard({ startUtcMs: START, wallNow: () => wall });
    board.update(fakeState([{ callsign: 'NKS451' }, { callsign: 'N1', type: 'C172', frequencyMhz: freq('GND') }]));
    board.update(fakeState([{ callsign: 'NKS451' }, { callsign: 'N1', type: 'C172', frequencyMhz: freq('GND') }]));
    board.strike('NKS451');
    wall = 777;
    board.update(fakeState([{ callsign: 'NKS451', frequencyMhz: freq('GND'), phase: 'RUNWAY_EXIT' }, { callsign: 'N1', type: 'C172', frequencyMhz: freq('GND') }], 200));
    const s = board.get('NKS451')!;
    expect(s.bay).toBe('GND');
    expect(s.fromBay).toBe('TWR');
    expect(s.path).toEqual(['TWR', 'GND']);
    expect(s.entry).toBe('move');
    expect(s.bayEnteredWall).toBe(777);
    expect(s.struck).toBe(false); // the receiving position starts with a live strip
    expect(board.bay('TWR')).toHaveLength(0);
    expect(board.bay('GND').map((x) => x.callsign)).toEqual(['N1', 'NKS451']);
  });

  it('keeps the strip, greyed, when the aircraft leaves; it can only be dropped once struck or gone', () => {
    const board = createStripBoard({ startUtcMs: START });
    board.update(fakeState([{ callsign: 'A1' }, { callsign: 'A2' }]));
    expect(board.drop('A1')).toBe(false); // still active
    board.update(fakeState([{ callsign: 'A2' }], 60));
    expect(board.get('A1')!.gone).toBe(true);
    expect(board.bay('TWR').map((s) => s.callsign)).toEqual(['A2', 'A1']); // gone strips sink
    expect(board.drop('A1')).toBe(true);
    expect(board.get('A1')).toBeUndefined();
    board.update(fakeState([{ callsign: 'A2' }], 61));
    expect(board.all().map((s) => s.callsign)).toEqual(['A2']);
  });

  it('a dropped strip of an aircraft still on frequency stays dropped, and is reprinted after its next handoff', () => {
    const board = createStripBoard({ startUtcMs: START });
    board.update(fakeState([{ callsign: 'A1' }]));
    board.strike('A1');
    expect(board.drop('A1')).toBe(true);
    board.update(fakeState([{ callsign: 'A1' }], 5));
    expect(board.all()).toHaveLength(0);
    board.update(fakeState([{ callsign: 'A1', frequencyMhz: freq('GND') }], 10));
    expect(board.bay('GND').map((s) => s.callsign)).toEqual(['A1']);
  });

  it('keeps only the most recent finished strips per bay', () => {
    const board = createStripBoard({ startUtcMs: START, maxFinishedPerBay: 2 });
    const ids = ['A1', 'A2', 'A3', 'A4'];
    board.update(fakeState(ids.map((callsign) => ({ callsign }))));
    board.update(fakeState([], 10));
    expect(board.bay('TWR').map((s) => s.callsign)).toEqual(['A3', 'A4']);
  });
});

describe('ordering, strike, drag and notes', () => {
  const three = () => {
    const board = createStripBoard({ startUtcMs: START });
    board.update(fakeState([{ callsign: 'A1' }, { callsign: 'A2' }, { callsign: 'A3' }]));
    return board;
  };
  const order = (b: ReturnType<typeof three>) => b.bay('TWR').map((s) => s.callsign);

  it('new strips go to the end of the sequence', () => expect(order(three())).toEqual(['A1', 'A2', 'A3']));

  it('reorder puts a strip before another one, or at the end', () => {
    const b = three();
    expect(b.reorder('A3', 'A1')).toBe(true);
    expect(order(b)).toEqual(['A3', 'A1', 'A2']);
    expect(b.reorder('A3')).toBe(true);
    expect(order(b)).toEqual(['A1', 'A2', 'A3']);
    expect(b.reorder('A1', 'A3')).toBe(true);
    expect(order(b)).toEqual(['A2', 'A1', 'A3']);
  });

  it('reorder refuses unknown strips and strips of another bay', () => {
    const b = createStripBoard({ startUtcMs: START });
    b.update(fakeState([{ callsign: 'A1' }, { callsign: 'G1', frequencyMhz: freq('GND') }]));
    expect(b.reorder('A1', 'G1')).toBe(false);
    expect(b.reorder('nope')).toBe(false);
    expect(b.bay('TWR').map((s) => s.callsign)).toEqual(['A1']);
  });

  it('nudge moves a strip one place and stops at the ends', () => {
    const b = three();
    expect(b.nudge('A2', -1)).toBe(true);
    expect(order(b)).toEqual(['A2', 'A1', 'A3']);
    expect(b.nudge('A2', -1)).toBe(false);
    expect(b.nudge('A3', 1)).toBe(false);
  });

  it('a new strip is appended after a manual reorder', () => {
    const b = three();
    b.reorder('A3', 'A1');
    b.update(fakeState([{ callsign: 'A1' }, { callsign: 'A2' }, { callsign: 'A3' }, { callsign: 'A4' }]));
    expect(order(b)).toEqual(['A3', 'A1', 'A2', 'A4']);
  });

  it('striking marks a strip handled and sends it to the bottom; striking again restores it', () => {
    const b = three();
    expect(b.strike('A1')).toBe(true);
    expect(order(b)).toEqual(['A2', 'A3', 'A1']);
    expect(b.get('A1')!.struck).toBe(true);
    expect(b.strike('A2')).toBe(true);
    expect(order(b)).toEqual(['A3', 'A1', 'A2']); // struck strips keep the order they were struck in
    expect(b.strike('A1')).toBe(false);
    expect(order(b)).toEqual(['A1', 'A3', 'A2']);
    expect(b.strike('missing')).toBeUndefined();
  });

  it('struck strips cannot be dragged; X drops a struck strip', () => {
    const b = three();
    b.strike('A2');
    expect(b.reorder('A2', 'A1')).toBe(false);
    expect(b.drop('A2')).toBe(true);
    expect(order(b)).toEqual(['A1', 'A3']);
  });

  it('notes are kept on the strip for the session, across updates and handoffs', () => {
    const b = three();
    b.setNotes('A1', 'wants ILS');
    b.update(fakeState([{ callsign: 'A1', frequencyMhz: freq('GND') }, { callsign: 'A2' }, { callsign: 'A3' }], 20));
    expect(b.get('A1')!.notes).toBe('wants ILS');
    expect(b.get('A1')!.bay).toBe('GND');
  });

  it('version changes when the board changes and not when nothing happened', () => {
    const b = three();
    const v = b.version();
    b.update(fakeState([{ callsign: 'A1' }, { callsign: 'A2' }, { callsign: 'A3' }], 1));
    expect(b.version()).toBe(v);
    b.setNotes('A1', 'x');
    expect(b.version()).toBeGreaterThan(v);
  });

  it('displayOrder: active in sequence, struck next, gone last', () => {
    const b = three();
    b.strike('A1');
    b.update(fakeState([{ callsign: 'A1' }, { callsign: 'A2' }], 5)); // A3 leaves
    expect(displayOrder(b.all()).map((s) => s.callsign)).toEqual(['A2', 'A1', 'A3']);
  });
});

describe('clearance abbreviations', () => {
  const m = (c: Clearance) => markForClearance(c)?.text ?? null;

  it('writes the standard marks the controller would', () => {
    expect(m(clr('APPROACH', { runwayEnd: '13', approachType: 'ILS' }))).toBe('C 13');
    expect(m(clr('LINE_UP_AND_WAIT', { runwayEnd: '13' }))).toBe('LUAW');
    expect(m(clr('TAKEOFF', { runwayEnd: '13' }))).toBe('CTO 13');
    expect(m(clr('LAND', { runwayEnd: '22' }))).toBe('CTL 22');
    expect(m(clr('LAND', { runwayEnd: '4', holdShort: ['13/31'] }))).toBe('LAHSO 13');
    expect(m(clr('CROSS_RUNWAY', { runwayId: '13/31' }))).toBe('X 13/31');
    expect(m(clr('HOLD_SHORT', { holdShort: ['13/31'] }))).toBe('H/S 13');
    expect(m(clr('HOLD_SHORT', { runwayEnd: '13' }))).toBe('H/S 13');
    expect(m(clr('TAXI', { route: ['A', 'D'] }))).toBe('TX A D');
    expect(m(clr('GO_AROUND'))).toBe('GA');
    expect(m(clr('HEADING', { headingDeg: 90 }))).toBe('HDG 090');
    expect(m(clr('DIRECT_FIX', { fix: 'VCN' }))).toBe('DCT VCN');
  });

  it('writes nothing for an altitude (it goes in the altitude box) or a frequency change (the strip moves)', () => {
    expect(m(clr('ALTITUDE', { altitudeFt: 2000 }))).toBeNull();
    expect(m(clr('CONTACT_FREQUENCY', { frequencyId: 'GND' }))).toBeNull();
  });

  it('formats Zulu times as HHMMZ', () => {
    expect(zuluHm(START, 0)).toBe('1200Z');
    expect(zuluHm(START, 3 * 60 + 59)).toBe('1203Z');
    expect(zuluHm(START, 70 * 60)).toBe('1310Z');
  });

  it('records marks once, from the aircraft clearance history', () => {
    const board = createStripBoard({ startUtcMs: START });
    const c = clr('APPROACH', { runwayEnd: '13', approachType: 'ILS' });
    const st = fakeState([{ callsign: 'NKS451', clearances: [c] }]);
    board.update(st);
    board.update(st);
    expect(board.get('NKS451')!.marks.map((x) => x.text)).toEqual(['C 13']);
  });

  it('shows a landing time once the arrival is on the ground', () => {
    const board = createStripBoard({ startUtcMs: START });
    board.update(fakeState([{ callsign: 'NKS451' }], 100));
    board.update(fakeState([{ callsign: 'NKS451', onGround: true, phase: 'ROLLOUT' }], 3 * 60 + 10));
    expect(board.get('NKS451')!.marks.map((x) => x.text)).toEqual(['L 1203Z']);
  });
});

describe('with the real engine', () => {
  function engineWith(spawns: ScenarioAircraftSpawn[]) {
    const scenario: Scenario = {
      id: 'strip-test', name: 'Strip test', description: '', mode: 'training', seed: 9, weather: getPresetWeather('clear'),
      activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR', 'GND'], spawns,
    };
    return createEngine({ airport, scenario, readbackErrorRate: 0 });
  }

  it('a departure: LUAW, CTO 13 and the takeoff time appear as the engine accepts the clearances', () => {
    const hold13 = nodeId(runwayEntryNodes(airport, '13')[0]);
    const engine = engineWith([{ atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: hold13, runwayEnd: '13' }, isDeparture: true, initialFrequencyId: 'TWR', initialRequest: 'DEPARTURE' }]);
    const board = createStripBoard({ startUtcMs: START });
    run(engine, 8);
    board.update(engine.getState());
    expect(board.bay('TWR')[0].marks).toEqual([]);
    say(engine, 'Cessna seven two three echo juliet, runway one three, line up and wait', 'TWR');
    board.update(engine.getState());
    expect(board.get(Object.keys(engine.getState().aircraft)[0])!.marks.map((x) => x.text)).toEqual(['LUAW']);
    run(engine, 6);
    say(engine, 'Cessna seven two three echo juliet, runway one three, cleared for takeoff', 'TWR');
    expect(runUntil(engine, (s) => Object.values(s.aircraft).some((a) => !a.onGround), 90)).toBe(true);
    board.update(engine.getState());
    const texts = board.bay('TWR')[0].marks.map((x) => x.text);
    expect(texts[0]).toBe('LUAW');
    expect(texts[1]).toBe('CTO 13');
    expect(texts[2]).toMatch(/^T\/O \d{4}Z$/);
  });

  it('a refused clearance leaves no mark', () => {
    const hold13 = nodeId(runwayEntryNodes(airport, '13')[0]);
    const engine = engineWith([{ atSec: 0, callsign: 'N723EJ', type: 'C172', flightRules: 'VFR', start: { kind: 'holding_short', nodeId: hold13, runwayEnd: '13' }, isDeparture: true, initialFrequencyId: 'TWR', initialRequest: 'DEPARTURE' }]);
    const board = createStripBoard({ startUtcMs: START });
    run(engine, 8);
    // Ground cannot clear a Tower aircraft for takeoff: "not on frequency", nothing recorded.
    const out = say(engine, 'Cessna seven two three echo juliet, runway one three, cleared for takeoff', 'GND');
    expect(out.outcomes[0].status).toBe('rejected');
    board.update(engine.getState());
    expect(board.bay('TWR')[0].marks).toEqual([]);
  });
});
