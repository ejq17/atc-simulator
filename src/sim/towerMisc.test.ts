/** LUAW rules (3-9-4), departure / landing information (3-9-1, 3-10-1), squawk and frequency change approved (5-2-1, 7-6-11). */
import { describe, expect, it } from 'vitest';
import { ARRIVING, cmd, find, HOLDING, makeEngine, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import { pilotNeedsNumbers } from './traffic';

describe('line up and wait (JO 7110.65 3-9-4)', () => {
  const luaw = (nm: number, mode: 'free_play' | 'training' = 'free_play') => makeEngine({ scenario: { mode, spawns: [HOLDING('N1AA', 'H13', '13'), ARRIVING('N5CC', '13', nm)] } });

  it('traffic within 6 miles for the same runway and no traffic information: accepted but flagged in free play', () => {
    const e = luaw(5);
    run(e, 2);
    expect(say(e, cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
    expect(e.getState().events.some((x) => /Improper instruction accepted: line up and wait on runway 13 without traffic information: N5CC is 5\.\d nm/.test(x.text))).toBe(true);
  });

  it('... and refused with an explanation in training mode', () => {
    const e = luaw(5, 'training');
    run(e, 2);
    const out = say(e, cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13' }), 'TWR');
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.reason).toMatch(/3-9-4: inform the aircraft of the closest traffic within 6 miles/);
    expect(find(e, 'N1AA').phase).toBe('HOLDING_SHORT');
  });

  it('with the traffic information in the instruction it is clean', () => {
    const e = luaw(5, 'training');
    run(e, 2);
    expect(say(e, cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13', trafficAdvised: true }), 'TWR').status).toBe('accepted');
    expect(e.getState().events.some((x) => /Improper instruction/.test(x.text))).toBe(false);
  });

  it('a traffic advisory just before the line-up counts as the information', () => {
    const e = luaw(5, 'training');
    run(e, 2);
    say(e, cmd('TRAFFIC_ADVISORY', 'N1AA', { traffic: { desc: 'cessna', position: 'final', distanceNm: 5 } }), 'TWR');
    expect(say(e, cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
  });

  it('traffic beyond 6 miles needs no information', () => {
    const e = luaw(8, 'training');
    run(e, 2);
    expect(say(e, cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
  });

  it('after 90 seconds in position the pilot asks for intentions (and again 90 s later)', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N1AA', 'H13', '13')] } });
    run(e, 2);
    say(e, cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13' }), 'TWR');
    const ac = find(e, 'N1AA');
    expect(runUntil(e, () => ac.phase === 'LINE_UP_AND_WAIT' && ac.groundSpeedKt === 0 && !ac.route, 60)).toBe(true);
    const lined = e.getState().clock.timeSec;
    const asked = () => pilotTexts(e, 'N1AA').filter((t) => /say intentions/.test(t));
    run(e, 80);
    expect(asked()).toHaveLength(0);
    expect(runUntil(e, () => asked().length === 1, 40)).toBe(true);
    expect(e.getState().clock.timeSec - lined).toBeGreaterThanOrEqual(90);
    expect(e.getState().clock.timeSec - lined).toBeLessThan(100);
    expect(asked()[0]).toMatch(/holding in position runway one three, say intentions/);
    expect(runUntil(e, () => asked().length === 2, 100)).toBe(true);
    expect(e.getState().events.some((x) => (x.data as { luawTimeout?: boolean } | undefined)?.luawTimeout)).toBe(true);
  });
});

describe('departure and landing information (3-9-1, 3-10-1)', () => {
  const wx = { source: 'simulated' as const, windDirDeg: 118 + 12, windSpeedKt: 8, visibilitySm: 10, clouds: [{ cover: 'SKC' as const, baseFtAgl: 0 }], temperatureC: 15, dewpointC: 5, altimeterInHg: 30.1, phenomena: [], flightCategory: 'VFR' as const };

  /** A seed for which the VFR light aircraft N1AA did not report the ATIS (so it needs the numbers). */
  function seedNeeding(needs: boolean): number {
    for (let seed = 1; seed < 200; seed++) {
      const e = makeEngine({ scenario: { seed, weather: wx, spawns: [HOLDING('N1AA', 'H13', '13')] } });
      if (pilotNeedsNumbers(find(e, 'N1AA')) === needs) return seed;
    }
    throw new Error('no seed');
  }

  it('wind and altimeter spoken with a clearance: accepted, the pilot has the numbers; wrong numbers are flagged', () => {
    const e = makeEngine({ scenario: { weather: wx, spawns: [HOLDING('N1AA', 'H13', '13')] } });
    run(e, 2);
    // 130 true is 142 magnetic here (12 W variation is added to a true bearing... the fixture variation is -12): magnetic = true + 12
    const good = say(e, cmd('LINE_UP_AND_WAIT', 'N1AA', { runwayEnd: '13', info: { windDirDeg: 142, windSpeedKt: 8, altimeterInHg: 30.1 } }), 'TWR');
    expect(good.status).toBe('accepted');
    expect(e.getState().events.some((x) => /Improper instruction/.test(x.text))).toBe(false);
    const bad = say(e, cmd('TAKEOFF', 'N1AA', { runwayEnd: '13', info: { altimeterInHg: 29.92 } }), 'TWR');
    expect(bad.status).toBe('accepted');
    expect(e.getState().events.some((x) => /Improper instruction accepted: information does not match the current observation: altimeter 29\.92 \(observed 30\.10\)/.test(x.text))).toBe(true);
  });

  it('a standalone information transmission is acknowledged with the altimeter read back', () => {
    const e = makeEngine({ scenario: { weather: wx, spawns: [HOLDING('N1AA', 'H13', '13')] } });
    run(e, 2);
    const out = say(e, cmd('AIRPORT_INFO', 'N1AA', { info: { windDirDeg: 142, windSpeedKt: 8, altimeterInHg: 30.1 } }), 'TWR');
    expect(out.status === 'accepted' && out.readback).toBe('Altimeter three zero one zero, Cessna one alpha alpha');
  });

  it('a pilot who did not report the ATIS and is not given the numbers asks for wind and altimeter, once', () => {
    const seed = seedNeeding(true);
    const e = makeEngine({ scenario: { seed, weather: wx, spawns: [HOLDING('N1AA', 'H13', '13')] } });
    const asked = () => pilotTexts(e, 'N1AA').filter((t) => /request wind and altimeter/.test(t));
    run(e, 15);
    expect(asked()).toHaveLength(0);
    expect(runUntil(e, () => asked().length === 1, 30)).toBe(true);
    run(e, 60);
    expect(asked()).toHaveLength(1);
    // once the controller gives the numbers the pilot has them
    expect(say(e, cmd('AIRPORT_INFO', 'N1AA', { info: { windDirDeg: 142, windSpeedKt: 8, altimeterInHg: 30.1 } }), 'TWR').status).toBe('accepted');
  });

  it('numbers given before the pilot asks: no request', () => {
    const seed = seedNeeding(true);
    const e = makeEngine({ scenario: { seed, weather: wx, spawns: [HOLDING('N1AA', 'H13', '13')] } });
    run(e, 3);
    say(e, cmd('AIRPORT_INFO', 'N1AA', { info: { windDirDeg: 142, windSpeedKt: 8, altimeterInHg: 30.1 } }), 'TWR');
    run(e, 60);
    expect(pilotTexts(e, 'N1AA').some((t) => /request wind and altimeter/.test(t))).toBe(false);
  });

  it('a pilot who reported the ATIS never asks', () => {
    const seed = seedNeeding(false);
    const e = makeEngine({ scenario: { seed, weather: wx, spawns: [HOLDING('N1AA', 'H13', '13')] } });
    run(e, 90);
    expect(pilotTexts(e, 'N1AA').some((t) => /request wind and altimeter/.test(t))).toBe(false);
  });

  it('arrivals: the inbound call includes "with information" only for pilots who have the ATIS', () => {
    const calls = [true, false].map((needs) => {
      const e = makeEngine({ scenario: { seed: seedNeeding(needs), weather: wx, spawns: [{ ...ARRIVING('N1AA', '13', 8), initialFrequencyId: 'TWR' }] } });
      run(e, 10);
      return pilotTexts(e, 'N1AA').find((t) => /inbound for landing/.test(t)) ?? '';
    });
    expect(calls[0]).not.toMatch(/with information/);
    expect(calls[1]).toMatch(/with information/);
  });
});

describe('squawk and frequency change approved (5-2-1, 7-6-11)', () => {
  const departure = () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('N1AA', 'H13', '13')] } });
    run(e, 2);
    e.applyCommand(cmd('TAKEOFF', 'N1AA', { runwayEnd: '13' }));
    const ac = find(e, 'N1AA');
    runUntil(e, () => !ac.onGround && ac.altitudeFt > 500, 120);
    return { e, ac };
  };

  it('"squawk 1200" sets the code; "squawk VFR" is 1200 (AIM 4-1-20); a reserved emergency code is refused', () => {
    const { e, ac } = departure();
    const out = say(e, cmd('SQUAWK', 'N1AA', { squawk: '4321' }), 'TWR');
    expect(ac.squawk).toBe('4321');
    expect(out.status === 'accepted' && out.readback).toBe('Squawk four three two one, Cessna one alpha alpha');
    expect(say(e, cmd('SQUAWK', 'N1AA', { squawk: '1200', destination: 'VFR' }), 'TWR').status).toBe('accepted');
    expect(ac.squawk).toBe('1200');
    expect(say(e, cmd('SQUAWK', 'N1AA', { squawk: '7700' }), 'TWR').status).toBe('rejected');
    expect(ac.squawk).toBe('1200');
  });

  it('frequency change approved: the VFR departure leaves the frequency without a handoff and counts as handled', () => {
    const { e, ac } = departure();
    expect(say(e, cmd('FREQUENCY_CHANGE_APPROVED', 'N1AA'), 'TWR').status).toBe('accepted');
    expect(runUntil(e, () => ac.frequencyMhz === 0, 20)).toBe(true);
    expect(pilotTexts(e, 'N1AA').at(-1)).toMatch(/^Frequency change approved, good day, Cessna one alpha alpha/);
    expect(e.getState().events.some((x) => x.kind === 'HANDOFF' && x.callsign === 'N1AA' && /left the frequency/.test(x.text))).toBe(true);
    run(e, 10);
    expect(pilotTexts(e, 'N1AA').filter((t) => /Cessna one alpha alpha, level/.test(t))).toHaveLength(0); // no check-in after leaving
    expect(runUntil(e, () => !Object.values(e.getState().aircraft).some((a) => a.callsign === 'N1AA'), 1500)).toBe(true);
    const despawn = e.getState().events.find((x) => x.kind === 'DESPAWN' && x.callsign === 'N1AA');
    expect(despawn).toBeDefined();
    expect((despawn!.data as { handled?: boolean }).handled).toBe(true);
  });

  it('not for an IFR aircraft and not on the ground', () => {
    const e = makeEngine({ scenario: { spawns: [HOLDING('NKS1', 'H13', '13', 'A320')] } });
    run(e, 2);
    expect(say(e, cmd('FREQUENCY_CHANGE_APPROVED', 'NKS1'), 'TWR').status).toBe('rejected');
    const f = makeEngine({ scenario: { spawns: [HOLDING('N1AA', 'H13', '13')] } });
    run(f, 2);
    expect(say(f, cmd('FREQUENCY_CHANGE_APPROVED', 'N1AA'), 'TWR').status).toBe('rejected');
  });
});

describe('pilotBehaviour tuning (design values, pilotBehaviour.ts)', () => {
  it('noAtisFraction 0 / 1: no light VFR pilot / every one needs the numbers', () => {
    for (const [fraction, expected] of [[0, false], [1, true]] as const) {
      for (let seed = 1; seed < 6; seed++) {
        const e = makeEngine({ scenario: { seed, pilotBehaviour: { noAtisFraction: fraction }, spawns: [HOLDING('N1AA', 'H13', '13')] } });
        const asked = () => pilotTexts(e, 'N1AA').some((t) => /request wind and altimeter/.test(t));
        run(e, 60);
        expect(asked()).toBe(expected);
      }
    }
  });

  it('look.maxRangeSm: a pilot whose range is 1 nm cannot see traffic 3 nm ahead even in unlimited visibility', () => {
    const spawn = (cs: string, nm: number) => ({ ...ARRIVING(cs, '13', nm), initialFrequencyId: 'TWR' });
    const e = makeEngine({ scenario: { pilotBehaviour: { look: { maxRangeSm: 1 } }, spawns: [spawn('N1AA', 6), spawn('N2BB', 3)] } });
    const out = say(e, cmd('TRAFFIC_ADVISORY', 'N1AA', { traffic: { desc: 'cessna', position: 'final', distanceNm: 3 } }), 'TWR');
    expect(out.status === 'accepted' && out.readback).toMatch(/^Negative contact/);
  });
});
