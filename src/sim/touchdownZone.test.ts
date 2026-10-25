/** Long / floated landings are go-arounds (touchdown zone: FAA Pilot/Controller Glossary, AC 91-79A Chg 1): an aircraft never lands beyond the zone, let alone beyond the pavement. */
import { describe, expect, it } from 'vitest';
import { loadKacy, loadKpgd } from '../airport';
import { createEngine } from './engine';
import { ARRIVING, cmd, find, makeScenario } from './__fixtures__/testHelpers';
import { findRunwayEnd } from './runways';
import { TDZ_TOLERANCE_M, cannotTouchDownInZone, touchdownZoneEndM } from './flightDynamics';
import { ftToM } from './geo';

const kacy = loadKacy();
const kpgd = loadKpgd();

describe('touchdown zone length (Pilot/Controller Glossary, AC 91-79A)', () => {
  it('is 3,000 ft on a long runway and a third of the usable length on a short one', () => {
    const g13 = findRunwayEnd(kacy, '13')!; // 10,000 ft
    expect(touchdownZoneEndM(g13)).toBeCloseTo(ftToM(3000), 1);
    const g22 = findRunwayEnd(kpgd, '22')!;
    expect(touchdownZoneEndM(g22)).toBeCloseTo(Math.min(ftToM(3000), (g22.lengthM - g22.displacedM) / 3), 3);
    const short = { ...g13, lengthM: 600, displacedM: 0 };
    expect(touchdownZoneEndM(short)).toBe(200);
  });
});

describe('cannotTouchDownInZone', () => {
  const g = findRunwayEnd(kacy, '13')!;
  it('a stable 3 degree approach over the threshold can land', () => {
    expect(cannotTouchDownInZone(g, 0, 50, 1064, 135)).toBe(false);
    expect(cannotTouchDownInZone(g, -900, 280, 1064, 135)).toBe(false);
  });
  it('1,200 ft high half a mile out cannot get down even at the fastest descent', () => {
    expect(cannotTouchDownInZone(g, -900, 1200, 1064, 125)).toBe(true);
  });
  it('still flying past the end of the zone cannot, whatever the height', () => {
    expect(cannotTouchDownInZone(g, touchdownZoneEndM(g) + TDZ_TOLERANCE_M + 10, 5, 300, 120)).toBe(true);
    expect(cannotTouchDownInZone(g, touchdownZoneEndM(g), 5, 300, 120)).toBe(false);
  });
});

describe('a landing that is too high goes around instead of touching down down the runway', () => {
  for (const [label, type, speed] of [['A320', 'A320', 160], ['C172', 'C172', 70]] as const) {
    it(`${label} cleared to land 1.5 nm out at 1,800 ft above the field`, () => {
      const spawn = ARRIVING('HI1', '13', 1.5, type, 'TWR');
      if (spawn.start.kind === 'airborne') { spawn.start.altitudeFt = 1900; spawn.start.speedKt = speed; }
      const e = createEngine({ airport: kacy, readbackErrorRate: 0, scenario: makeScenario({ spawns: [spawn] }) });
      const ac = find(e, 'HI1');
      e.applyCommand(cmd('LAND', 'HI1', { runwayEnd: '13' }));
      const g = findRunwayEnd(kacy, '13')!;
      let goAroundAt = -1;
      for (let i = 0; i < 3000 && !ac.onGround; i++) {
        e.step();
        if (goAroundAt < 0 && ac.phase === 'GO_AROUND') goAroundAt = e.getState().clock.timeSec;
      }
      const goAround = e.getState().events.find((x) => x.kind === 'GO_AROUND' && x.callsign === 'HI1');
      expect(goAround, 'the pilot goes around').toBeDefined();
      expect(e.getState().events.some((x) => x.kind === 'TRANSMISSION' && x.speaker === 'PILOT' && /going around/.test(x.text)), 'with the radio call').toBe(true);
      expect(e.getState().events.some((x) => /touched down runway 13/.test(x.text) && Number(/(\d+) m from/.exec(x.text)?.[1]) > touchdownZoneEndM(g) + TDZ_TOLERANCE_M)).toBe(false);
      expect(goAroundAt).toBeGreaterThan(0);
    });
  }
});
