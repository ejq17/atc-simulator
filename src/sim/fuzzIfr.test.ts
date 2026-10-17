import { describe, expect, it } from 'vitest';
import type { ApproachType, ClearanceKind, ControllerPositionId, ParsedCommand } from './types';
import { createEngine } from './engine';
import { createTestAirport } from './__fixtures__/testAirport';
import { ALL_POSITIONS, AT_FIX, cmd, IFR_DEPARTURE, IFR_HOLDING, makeScenario } from './__fixtures__/testHelpers';
import { mulberry32 } from './rng';

const KINDS: ClearanceKind[] = [
  'IFR_CLEARANCE', 'APPROACH', 'APPROACH', 'DIRECT_FIX', 'RESUME_OWN_NAVIGATION', 'RADAR_CONTACT', 'TAKEOFF', 'LAND', 'HEADING', 'ALTITUDE', 'SPEED',
  'CONTACT_FREQUENCY', 'CONTACT_FREQUENCY', 'GO_AROUND', 'CONTINUE_APPROACH', 'TAXI', 'LINE_UP_AND_WAIT', 'ENTER_PATTERN',
];
const FIXES = ['TVO', 'FX13A', 'FX13B', 'FX13M', 'FX22A', 'TARR', 'TSE', 'Testville', 'NOWHERE'];
const TYPES: ApproachType[] = ['ILS', 'LOC', 'RNAV', 'VOR', 'VISUAL'];

describe('fuzz: random IFR instruction streams never crash or corrupt state', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}`, () => {
      const rng = mulberry32(seed * 104729);
      const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
      const e = createEngine({
        airport: createTestAirport(),
        scenario: makeScenario({
          seed,
          mode: seed % 2 ? 'free_play' : 'training',
          controllerPositions: ALL_POSITIONS,
          spawns: [
            IFR_DEPARTURE('NKS451', 'GATE-1'), IFR_DEPARTURE('AAL12', 'GATE-2'), IFR_HOLDING('DAL9', 'H13', '13'),
            AT_FIX('UAL1', 'TARR', ['TARR', 'FX13A', 'FX13B'], '13', {}, 4000), AT_FIX('JBU2', 'FX22A', ['FX22A', 'FX22B', 'FX22C'], '22', {}, 3000, 160),
            AT_FIX('SWA3', 'TARR', ['TARR', 'TVO'], '13', { atSec: 60 }, 6000),
          ],
          traffic: { enabled: true, arrivalsPerHour: 30, departuresPerHour: 20, gaFraction: 0.5, maxAircraft: 10 },
        }),
        readbackErrorRate: 0.3,
      });
      const calls = ['NKS451', 'AAL12', 'DAL9', 'UAL1', 'JBU2', 'SWA3', 'N404XX'];
      for (let i = 0; i < 6000; i++) {
        if (i % 20 === 0) {
          const kind = pick(KINDS);
          const c: ParsedCommand = cmd(kind, pick(calls), {
            runwayEnd: rng() < 0.8 ? pick(['13', '31', '4', '22']) : undefined,
            approachType: rng() < 0.85 ? pick(TYPES) : undefined,
            fix: rng() < 0.8 ? pick(FIXES) : undefined,
            ifr: rng() < 0.6 ? { squawk: rng() < 0.5 ? pick(['4215', '7700', '1234', '12']) : undefined, initialAltitudeFt: rng() < 0.4 ? Math.floor(rng() * 6000) : undefined, destination: rng() < 0.2 ? 'KBOS' : undefined } : undefined,
            destination: rng() < 0.4 ? pick(['RWY13', 'RWY22', 'GA1']) : undefined,
            headingDeg: Math.floor(rng() * 380),
            altitudeFt: Math.floor(rng() * 14000),
            speedKt: Math.floor(100 + rng() * 200),
            frequencyId: rng() < 0.7 ? pick(['GND', 'TWR', 'APP', 'DEP', 'CLNC']) : undefined,
            confidence: rng() < 0.9 ? 0.95 : 0.7,
          });
          e.applyCommand(c, { position: pick(ALL_POSITIONS as readonly ControllerPositionId[]) });
        }
        e.step();
        if (i % 100 === 0) {
          const squawks = new Set<string>();
          for (const ac of Object.values(e.getState().aircraft)) {
            expect(Number.isFinite(ac.pos.x) && Number.isFinite(ac.pos.y)).toBe(true);
            expect(Number.isFinite(ac.altitudeFt) && Number.isFinite(ac.airspeedKt) && Number.isFinite(ac.headingDeg)).toBe(true);
            expect(ac.altitudeFt).toBeGreaterThanOrEqual(74);
            if (ac.nav) {
              expect(ac.nav.index).toBeGreaterThanOrEqual(0);
              expect(ac.nav.index).toBeLessThanOrEqual(ac.nav.fixes.length);
            }
            if (ac.squawk) {
              expect(ac.squawk).toMatch(/^[0-7]{4}$/);
              expect(squawks.has(ac.squawk)).toBe(false);
              squawks.add(ac.squawk);
            }
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
