import { describe, expect, it } from 'vitest';
import type { ClearanceKind, ParsedCommand } from './types';
import { createEngine } from './engine';
import { createTestAirport } from './__fixtures__/testAirport';
import { ARRIVING, cmd, GA_PARKED, HOLDING, makeScenario } from './__fixtures__/testHelpers';
import { mulberry32 } from './rng';

const KINDS: ClearanceKind[] = [
  'TAXI', 'HOLD_POSITION', 'HOLD_SHORT', 'CROSS_RUNWAY', 'LINE_UP_AND_WAIT', 'TAKEOFF', 'LAND', 'GO_AROUND', 'CONTINUE_APPROACH',
  'CONTACT_FREQUENCY', 'HEADING', 'ALTITUDE', 'SPEED', 'ENTER_PATTERN', 'PUSHBACK', 'TAXI_TO_PARKING',
];

describe('fuzz: random instruction streams never crash or corrupt state', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}`, () => {
      const rng = mulberry32(seed * 7919);
      const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
      const e = createEngine({
        airport: createTestAirport(),
        scenario: makeScenario({
          seed,
          mode: seed % 2 ? 'free_play' : 'training',
          spawns: [GA_PARKED('N1AA', 'GA1'), GA_PARKED('N2BB', 'GA2'), HOLDING('N3CC', 'H13', '13'), HOLDING('NKS451', 'D_h13S', '13', 'A320'), ARRIVING('N5DD', '13', 5), ARRIVING('NKS777', '22', 8, 'A320')],
          traffic: { enabled: true, arrivalsPerHour: 40, departuresPerHour: 40, gaFraction: 0.6, maxAircraft: 10 },
        }),
        readbackErrorRate: 0.3,
      });
      const calls = ['N1AA', 'N2BB', 'N3CC', 'NKS451', 'N5DD', 'NKS777', 'N404XX'];
      for (let i = 0; i < 4000; i++) {
        if (i % 25 === 0) {
          const kind = pick(KINDS);
          const c: ParsedCommand = cmd(kind, pick(calls), {
            runwayEnd: rng() < 0.7 ? pick(['13', '31', '4', '22']) : undefined,
            runwayId: rng() < 0.3 ? pick(['13/31', '4/22']) : undefined,
            crossRunwayId: rng() < 0.3 ? pick(['13/31', '4/22']) : undefined,
            holdShort: rng() < 0.3 ? [pick(['13/31', '4/22'])] : undefined,
            destination: rng() < 0.6 ? pick(['RWY22', 'RWY4', 'RWY13', 'RWY31', 'GA1', 'GA2', 'GA3', 'nowhere']) : undefined,
            route: rng() < 0.5 ? [pick(['A', 'B', 'C', 'D', 'Z'])] : undefined,
            headingDeg: Math.floor(rng() * 380),
            turnDirection: rng() < 0.3 ? pick(['left', 'right'] as const) : undefined,
            altitudeFt: Math.floor(rng() * 20000),
            speedKt: Math.floor(40 + rng() * 300),
            frequencyMhz: rng() < 0.5 ? pick([121.9, 120.3, 124.6, 125.0]) : undefined,
            frequencyId: rng() < 0.3 ? pick(['GND', 'TWR', 'APP']) : undefined,
            patternLeg: rng() < 0.5 ? pick(['left_downwind', 'right_downwind', 'straight_in', 'base'] as const) : undefined,
            confidence: rng() < 0.9 ? 0.95 : 0.7,
          });
          e.applyCommand(c, { position: pick(['GND', 'TWR', 'APP'] as const) });
        }
        e.step();
        if (i % 200 === 0) {
          for (const ac of Object.values(e.getState().aircraft)) {
            expect(Number.isFinite(ac.pos.x) && Number.isFinite(ac.pos.y)).toBe(true);
            expect(Number.isFinite(ac.altitudeFt) && Number.isFinite(ac.airspeedKt) && Number.isFinite(ac.headingDeg)).toBe(true);
            expect(ac.headingDeg).toBeGreaterThanOrEqual(0);
            expect(ac.headingDeg).toBeLessThan(360);
            expect(ac.altitudeFt).toBeGreaterThanOrEqual(74);
            expect(ac.history.length).toBeLessThanOrEqual(60);
          }
          const s = e.getState().score;
          expect(s.score).toBeGreaterThanOrEqual(0);
          expect(s.score).toBeLessThanOrEqual(100);
        }
      }
      expect(e.getState().events.length).toBeLessThanOrEqual(2000);
    });
  }
});
