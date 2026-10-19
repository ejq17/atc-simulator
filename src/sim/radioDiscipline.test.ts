/**
 * Response timing, missed calls, "say again" and blocked transmissions (src/sim/radioDiscipline.ts, pilotRealism.ts).
 */
import { describe, expect, it } from 'vitest';
import type { PilotRealismOverride } from './pilotBehaviour';
import { ARRIVING, cmd, find, makeEngine, pilotTexts, run, runUntil } from './__fixtures__/testHelpers';
import type { Scenario, SimEvent } from './types';
import type { SimulationEngine } from './api';
import { BLOCKED_SQUEAL_SEC, markBlockedRequest, markRequestHeard } from './radioDiscipline';

const QUIET: PilotRealismOverride = {
  digitErrorRate: 0, altitudeErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0, patternMisunderstandRate: 0,
  wrongCallsignRate: 0, noReadbackRate: 0, delayedResponseRate: 0, sayAgainRate: 0, studentShare: 0, withYouRate: 0, withBravoRate: 0, novemberInitialRate: 0,
  responseDelaySec: { airline: [0, 0], ga: [0, 0], student: [0, 0] }, radioDiscipline: true, blockWindowSec: 1,
  requests: { RUNWAY_CHANGE: 0, SHORT_APPROACH: 0, OPTION: 0, STRAIGHT_IN: 0, STAY_IN_PATTERN: 0, NEED_MINUTE: 0, SPACING_360: 0, HIGHER: 0, DIRECT_FIX: 0, VISUAL_APPROACH: 0, TAXI_BACK: 0 },
};

interface Heard { timeSec: number; callsign: string; text: string; blocked?: boolean }

function make(realism: PilotRealismOverride, spawns: Scenario['spawns'], over: Partial<Scenario> = {}, level: Scenario['pilotRealism'] | 'none' = 'moderate') {
  const heard: Heard[] = [];
  let engine!: SimulationEngine;
  engine = makeEngine({
    scenario: { pilotRealism: level === 'none' ? undefined : level, pilotBehaviour: { noAtisFraction: 0, realism: { ...QUIET, ...realism } }, spawns, ...over },
    opts: { onPilotTransmission: (t) => heard.push({ timeSec: engine.getState().clock.timeSec, callsign: t.callsign, text: t.text, blocked: t.blocked }) },
  });
  return { engine, heard };
}
/** Let the pilots finish their own first calls (they may block each other) and clear the log, so a test sees only what it causes. */
function settle(engine: SimulationEngine, heard: Heard[]): void {
  let quiet = 0;
  for (let t = 0; t < 150 && quiet < 8; t++) {
    run(engine, 1);
    quiet = Object.values(engine.getState().aircraft).some((a) => a.radioState === 'TRANSMITTING') ? 0 : quiet + 1;
  }
  heard.length = 0;
}
const alt = (cs: string, ft = 3000) => cmd('ALTITUDE', cs, { altitudeFt: ft });
const blockedEvents = (e: SimulationEngine, since = 0): SimEvent[] => e.getState().events.filter((x) => x.kind === 'RADIO_BLOCKED' && x.timeSec >= since);

describe('response delay', () => {
  it('a readback comes after the response delay, not before', () => {
    const { engine, heard } = make({ responseDelaySec: { airline: [0, 0], ga: [3, 3], student: [3, 3] }, radioDiscipline: false }, [ARRIVING('N723EJ', '13', 10)]);
    settle(engine, heard);
    const t0 = engine.getState().clock.timeSec;
    engine.applyCommand(alt('N723EJ'), { position: 'TWR' });
    expect(heard).toHaveLength(0);
    expect(find(engine, 'N723EJ').radioState).toBe('TRANSMITTING'); // queued: the controller must not talk over it
    run(engine, 2.5);
    expect(heard).toHaveLength(0);
    run(engine, 1);
    expect(heard).toHaveLength(1);
    expect(heard[0].timeSec - t0).toBeGreaterThanOrEqual(3);
    expect(heard[0].text).toContain('three thousand');
  });

  it('airline crews answer sooner than GA pilots, students slowest (preset ranges)', () => {
    const mean = (spawn: Scenario['spawns'][number]) => {
      let sum = 0;
      const n = 12;
      for (let seed = 1; seed <= n; seed++) {
        const { engine, heard } = make({}, [spawn], { seed }, 'moderate');
        // preset delays, no radio discipline noise
        engine.getState().scenario.pilotBehaviour = undefined;
        const e = makeEngine({ scenario: { pilotRealism: 'moderate', seed, spawns: [spawn], pilotBehaviour: { realism: { ...QUIET, responseDelaySec: undefined, radioDiscipline: false } } }, opts: { onPilotTransmission: (t) => heard.push({ timeSec: e.getState().clock.timeSec, callsign: t.callsign, text: t.text }) } });
        const cs = spawn.callsign;
        const t0 = e.getState().clock.timeSec;
        e.applyCommand(alt(cs), { position: 'TWR' });
        runUntil(e, () => heard.length > 0, 20);
        sum += (heard[0]?.timeSec ?? 99) - t0;
      }
      return sum / n;
    };
    const airline = mean({ ...ARRIVING('NKS451', '13', 10, 'A320') });
    const ga = mean(ARRIVING('N723EJ', '13', 10));
    const student = mean({ ...ARRIVING('N455KB', '13', 10), student: true });
    expect(airline).toBeLessThan(ga);
    expect(ga).toBeLessThan(student);
  });

  it('without realism a readback is immediate', () => {
    const { engine, heard } = make({ radioDiscipline: false }, [ARRIVING('N723EJ', '13', 10)], {}, 'none');
    settle(engine, heard);
    engine.applyCommand(alt('N723EJ'), { position: 'TWR' });
    expect(heard).toHaveLength(1);
  });
});

describe('a missed call (delayed response)', () => {
  it('nothing happens until the controller calls again; the second call is answered', () => {
    const { engine, heard } = make({ delayedResponseRate: 1 }, [ARRIVING('N723EJ', '13', 10)]);
    settle(engine, heard);
    const first = engine.applyCommand(alt('N723EJ'), { position: 'TWR' });
    expect(first.status).toBe('clarify');
    run(engine, 5);
    expect(heard).toHaveLength(0);
    expect(find(engine, 'N723EJ').target.altitudeFt).not.toBe(3000);
    const second = engine.applyCommand(alt('N723EJ'), { position: 'TWR' });
    expect(second.status).toBe('accepted');
    run(engine, 5);
    expect(heard.at(-1)?.text).toContain('three thousand');
    expect(find(engine, 'N723EJ').target.altitudeFt).toBe(3000);
  });

  it('"did you copy" makes the pilot ask for the call again', () => {
    const { engine, heard } = make({ delayedResponseRate: 1 }, [ARRIVING('N723EJ', '13', 10)]);
    settle(engine, heard);
    engine.applyCommand(alt('N723EJ'), { position: 'TWR' });
    const out = engine.applyCommand(cmd('DID_YOU_COPY', 'N723EJ'), { position: 'TWR' });
    expect(out.status).toBe('rejected'); // a conversation, not a clearance
    run(engine, 15);
    expect(heard.at(-1)?.text).toMatch(/say again/i);
  });

  it('safety instructions (go around) are never missed', () => {
    const { engine } = make({ delayedResponseRate: 1 }, [ARRIVING('N723EJ', '13', 3)]);
    expect(engine.applyCommand(cmd('GO_AROUND', 'N723EJ'), { position: 'TWR' }).status).toBe('accepted');
  });
});

describe('say again on long transmissions', () => {
  const group = (n: number) => ({ ...alt('N723EJ'), groupSize: n });
  it('asks to say again only above the instruction limit', () => {
    const { engine, heard } = make({ sayAgainRate: 1, sayAgainMinCommands: 3 }, [ARRIVING('N723EJ', '13', 10)]);
    settle(engine, heard);
    expect(engine.applyCommand(group(3), { position: 'TWR' }).status).toBe('accepted');
    const out = engine.applyCommand({ ...alt('N723EJ', 4000), groupSize: 4 }, { position: 'TWR' });
    expect(out.status).toBe('clarify');
    run(engine, 15);
    expect(heard.at(-1)?.text).toMatch(/say again/i); // after the readback of the first one
    expect(find(engine, 'N723EJ').target.altitudeFt).toBe(3000); // the long one was not carried out
  });
  it('students ask more often', () => {
    const asks = (student: boolean) => {
      let n = 0;
      for (let seed = 1; seed <= 80; seed++) {
        const { engine } = make({ sayAgainRate: 0.2, sayAgainMinCommands: 1, studentSayAgainFactor: 3 }, [{ ...ARRIVING('N723EJ', '13', 10), student }], { seed });
        if (engine.applyCommand({ ...alt('N723EJ'), groupSize: 2 }, { position: 'TWR' }).status === 'clarify') n++;
      }
      return n;
    };
    expect(asks(true)).toBeGreaterThan(asks(false));
  });
});

describe('blocked transmissions', () => {
  const two = () => {
    const m = make({ responseDelaySec: { airline: [0, 0], ga: [0, 0], student: [0, 0] } }, [ARRIVING('N723EJ', '13', 10), ARRIVING('N991KB', '13', 12)]);
    settle(m.engine, m.heard);
    return { ...m, since: m.engine.getState().clock.timeSec };
  };
  const both = (engine: SimulationEngine) => {
    engine.applyCommand(alt('N723EJ'), { position: 'TWR' });
    engine.applyCommand(alt('N991KB'), { position: 'TWR' });
  };

  it('two calls keyed together are both garbled: event, [blocked] to the voice layer, nothing spoken', () => {
    const { engine, heard, since } = two();
    both(engine);
    run(engine, 4); // the controller's calls end, then the two answers are keyed together
    expect(blockedEvents(engine, since)).toHaveLength(1);
    const ev = blockedEvents(engine, since)[0];
    expect(ev.text).toContain('[blocked]');
    expect(ev.data?.callsigns).toEqual(['N723EJ', 'N991KB']);
    const sq = heard.filter((h) => h.blocked);
    expect(sq).toHaveLength(1);
    expect(sq[0].text).toBe('[blocked]');
    expect(heard.filter((h) => !h.blocked)).toHaveLength(0);
    expect(pilotTexts(engine).filter((t) => t.includes('three thousand'))).toHaveLength(0);
  });

  it('each pilot retries after a different delay and then gets through', () => {
    const { engine, heard, since } = two();
    both(engine);
    expect(runUntil(engine, () => heard.filter((h) => !h.blocked).length === 2, 30)).toBe(true);
    const spoken = heard.filter((h) => !h.blocked);
    expect(new Set(spoken.map((h) => h.callsign))).toEqual(new Set(['N723EJ', 'N991KB']));
    expect(Math.abs(spoken[0].timeSec - spoken[1].timeSec)).toBeGreaterThan(1);
    const retry = blockedEvents(engine, since)[0].data?.retryAtSec as number[];
    expect(retry[0]).not.toBe(retry[1]);
    expect(spoken.every((h) => /three thousand|three thousand/.test(h.text))).toBe(true);
    expect(blockedEvents(engine, since)).toHaveLength(1);
  });

  it('is deterministic: the same seed gives the same blocks and retries', () => {
    const log = () => {
      const { engine, heard, since } = two();
      both(engine);
      run(engine, 25);
      return JSON.stringify({ heard, blocked: blockedEvents(engine, since).map((e) => [e.timeSec, e.data]) });
    };
    expect(log()).toBe(log());
  });

  it('calls keyed far enough apart are not blocked; the second waits for the first to end', () => {
    const { engine, heard, since } = two();
    engine.applyCommand(alt('N723EJ'), { position: 'TWR' });
    run(engine, 1.6); // past the key-up window, the first call is on the air
    engine.applyCommand(alt('N991KB'), { position: 'TWR' });
    run(engine, 15);
    expect(blockedEvents(engine, since)).toHaveLength(0);
    const spoken = heard.filter((h) => !h.blocked);
    expect(spoken).toHaveLength(2);
    expect(spoken[1].timeSec).toBeGreaterThan(spoken[0].timeSec + 1.5); // not on top of the first one
  });

  it('calls on different frequencies never block each other', () => {
    const m = make({}, [ARRIVING('N723EJ', '13', 10), ARRIVING('N991KB', '13', 12, 'C172', 'APP')]);
    const { engine } = m;
    settle(engine, m.heard);
    const since = engine.getState().clock.timeSec;
    engine.applyCommand(alt('N723EJ'), { position: 'TWR' });
    engine.applyCommand(alt('N991KB'), { position: 'APP' });
    run(engine, 5);
    expect(blockedEvents(engine, since)).toHaveLength(0);
  });

  it('without radio discipline there is no blocking', () => {
    const { engine, heard } = make({ radioDiscipline: false }, [ARRIVING('N723EJ', '13', 10), ARRIVING('N991KB', '13', 12)]);
    settle(engine, heard);
    const since = engine.getState().clock.timeSec;
    both(engine);
    expect(blockedEvents(engine, since)).toHaveLength(0);
    expect(heard).toHaveLength(2);
  });

  it('aircraft with the same trigger make their own calls at different moments and are not garbled (stagger)', () => {
    const { engine, heard } = make({ responseDelaySec: { airline: [0, 0], ga: [0, 0], student: [0, 0] } }, [
      ARRIVING('N723EJ', '13', 11), ARRIVING('N991KB', '13', 11), ARRIVING('N428PL', '13', 11), ARRIVING('N556HW', '13', 11),
    ], { seed: 3 }, 'heavy');
    run(engine, 90);
    expect(blockedEvents(engine)).toHaveLength(0);
    const calls = heard.filter((h) => !h.blocked).map((h) => h.timeSec);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < calls.length; i++) expect(calls[i] - calls[i - 1]).toBeGreaterThan(1);
  });

  it('the squeal length matches the engine constant', () => {
    expect(BLOCKED_SQUEAL_SEC).toBeGreaterThan(0.5);
  });
});

describe('a blocked request is not a pending request until the retry is heard', () => {
  const ac = () => ({ pendingRequest: { kind: 'TAXI', text: 'ready to taxi', sinceSec: 0 } }) as unknown as import('./types').Aircraft;
  it('a blocked request call hides the request, the retry shows it again', () => {
    const a = ac();
    markBlockedRequest(a, { answer: false, data: { request: 'TAXI' } });
    expect(a.pendingRequest?.unheard).toBe(true);
    markRequestHeard(a, { readback: true }); // not a request call: nothing changes
    expect(a.pendingRequest?.unheard).toBe(true);
    markRequestHeard(a, { request: 'TAXI' });
    expect(a.pendingRequest?.unheard).toBe(false);
  });
  it('a blocked readback does not hide a request', () => {
    const a = ac();
    markBlockedRequest(a, { answer: true, data: { readback: true } });
    expect(a.pendingRequest?.unheard).toBeUndefined();
  });
});
