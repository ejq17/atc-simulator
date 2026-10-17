/**
 * Minimum vectoring altitude, JO 7110.65 5-6-1 (faa.gov): "Vector aircraft ... At or above the MVA or the minimum IFR altitude except
 * as authorized for radar approaches, radar departures, special VFR, VFR operations, or by paragraph 5-6-3, Vectors Below Minimum Altitude."
 */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { mvaAltitudeAt as airportMvaAltitudeAt } from '../airport/mva';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { Airport, Scenario, Vec2 } from './types';
import { createTestAirport } from './__fixtures__/testAirport';
import { AT_FIX, ALL_POSITIONS, cmd, find, makeScenario, run, say } from './__fixtures__/testHelpers';
import { mvaAltitudeAt, mvaSectorAt } from './mva';
import { trueToMagnetic } from './geo';
import { REF_MVA } from './conflicts';

const sq = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const prov = { source: 'test', retrievedAt: '2026-01-01' } as never;

/** Fixture with two synthetic sectors: west (x < 0) MVA 2,000 ft, east (x >= 0) MVA 3,000 ft. */
function mvaFixture(): Airport {
  return {
    ...createTestAirport(),
    mvaSectors: [
      { id: 'W', polygon: sq(-60000, -60000, 0, 60000), altitudeFt: 2000, provenance: prov },
      { id: 'E', polygon: sq(0, -60000, 60000, 60000), altitudeFt: 3000, provenance: prov },
    ],
  };
}

function make(airport: Airport, mode: Scenario['mode'], over: { alt?: number; type?: string; flightRules?: 'IFR' | 'VFR' } = {}): SimulationEngine {
  return createEngine({
    airport, readbackErrorRate: 0,
    scenario: makeScenario({
      controllerPositions: ALL_POSITIONS, mode,
      spawns: [AT_FIX('NKS451', 'TVO', ['TVO'], '13', { ...(over.type ? { type: over.type } : {}), ...(over.flightRules ? { flightRules: over.flightRules } : {}) }, over.alt ?? 5000, 200)],
    }),
  });
}

/** Put the aircraft at (x, y) flying true heading `hdg` at `alt`, on its own (no route, no approach). */
function place(e: SimulationEngine, x: number, y: number, hdg: number, alt: number) {
  const ac = find(e, 'NKS451');
  run(e, 1);
  ac.nav = undefined;
  ac.pos = { x, y };
  ac.headingDeg = hdg;
  ac.trackDeg = hdg;
  ac.altitudeFt = alt;
  ac.target.altitudeFt = alt;
  ac.target.headingDeg = hdg;
  return ac;
}

describe('MVA lookup (sector with holes; smallest containing sector)', () => {
  it('fixture: west 2,000, east 3,000', () => {
    const a = mvaFixture();
    expect(mvaAltitudeAt(a, { x: -5000, y: 0 })).toBe(2000);
    expect(mvaAltitudeAt(a, { x: 5000, y: 0 })).toBe(3000);
    expect(mvaAltitudeAt(a, { x: 90000, y: 0 })).toBeUndefined();
  });

  it('a point inside a hole is NOT in that sector; the smallest containing sector wins', () => {
    const holed = { mvaSectors: [
      { id: 'OUT', polygon: sq(-10000, -10000, 10000, 10000), altitudeFt: 1600, provenance: prov, holes: [sq(-2000, -2000, 2000, 2000)] },
      { id: 'IN', polygon: sq(-2000, -2000, 2000, 2000), altitudeFt: 2500, provenance: prov },
    ] } as Pick<Airport, 'mvaSectors'>;
    expect(mvaSectorAt(holed, { x: 0, y: 0 })?.id).toBe('IN');
    expect(mvaAltitudeAt(holed, { x: 5000, y: 0 })).toBe(1600);
    // nested without a hole: the smallest containing sector wins
    const nested = { mvaSectors: [
      { id: 'BIG', polygon: sq(-10000, -10000, 10000, 10000), altitudeFt: 4000, provenance: prov },
      { id: 'SMALL', polygon: sq(-1000, -1000, 1000, 1000), altitudeFt: 1500, provenance: prov },
    ] } as Pick<Airport, 'mvaSectors'>;
    expect(mvaSectorAt(nested, { x: 0, y: 0 })?.id).toBe('SMALL');
    expect(mvaSectorAt(nested, { x: 5000, y: 0 })?.id).toBe('BIG');
  });
});

describe('ALTITUDE assignment against the MVA (fixture sectors W 2,000 / E 3,000)', () => {
  it('below the MVA of the sector it is in: refused in training with the 5-6-1 reference', () => {
    const e = make(mvaFixture(), 'training');
    place(e, -20000, 0, 180, 5000);
    const r = say(e, cmd('ALTITUDE', 'NKS451', { altitudeFt: 1800 }), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') {
      expect(r.reason).toContain('minimum vectoring altitude of 2000 ft');
      expect(r.reason).toContain(REF_MVA);
    }
    expect(say(e, cmd('ALTITUDE', 'NKS451', { altitudeFt: 2500 }), 'APP').status).toBe('accepted');
  });

  it('a sector entered within 2 nm along the track counts; 2.5 nm away it does not', () => {
    const near = make(mvaFixture(), 'training');
    place(near, -3000, 0, 90, 5000); // 3,000 m = 1.6 nm west of the boundary, heading east
    expect(say(near, cmd('ALTITUDE', 'NKS451', { altitudeFt: 2500 }), 'APP').status).toBe('rejected'); // east sector: 3,000
    expect(say(near, cmd('ALTITUDE', 'NKS451', { altitudeFt: 3000 }), 'APP').status).toBe('accepted');
    const far = make(mvaFixture(), 'training');
    place(far, -4700, 0, 90, 5000); // 2.5 nm away
    expect(say(far, cmd('ALTITUDE', 'NKS451', { altitudeFt: 2500 }), 'APP').status).toBe('accepted');
  });

  it('free play accepts and flags it as an unsafe clearance (scored)', () => {
    const e = make(mvaFixture(), 'free_play');
    place(e, -20000, 0, 180, 5000);
    expect(say(e, cmd('ALTITUDE', 'NKS451', { altitudeFt: 1800 }), 'APP').status).toBe('accepted');
    expect(e.getState().events.some((x) => x.kind === 'CONFLICT' && /minimum vectoring altitude/.test(x.text) && (x.data as { prevented?: boolean }).prevented === false)).toBe(true);
    expect(e.getState().conflicts.some((c) => c.kind === 'UNSAFE_CLEARANCE')).toBe(true);
  });

  it('exempt: VFR aircraft, an aircraft on a published approach segment, and an airport without sectors', () => {
    const vfr = make(mvaFixture(), 'training', { type: 'C172', flightRules: 'VFR' });
    place(vfr, -20000, 0, 180, 5000);
    expect(say(vfr, cmd('ALTITUDE', 'NKS451', { altitudeFt: 1800 }), 'APP').status).toBe('accepted');
    const onApp = make(mvaFixture(), 'training');
    const ac = place(onApp, -20000, 0, 180, 5000);
    ac.nav = { fixes: ['TVO'], index: 0, mode: 'approach' }; // flying the published procedure
    expect(say(onApp, cmd('ALTITUDE', 'NKS451', { altitudeFt: 1800 }), 'APP').status).toBe('accepted');
    const none = make(createTestAirport(), 'training');
    place(none, -20000, 0, 180, 5000);
    expect(say(none, cmd('ALTITUDE', 'NKS451', { altitudeFt: 1800 }), 'APP').status).toBe('accepted');
  });
});

describe('HEADING vector against the MVA', () => {
  it('a heading that points an aircraft at 2,500 ft toward the 3,000 ft sector within 2 nm is refused; away from it is fine', () => {
    const a = mvaFixture();
    const e = make(a, 'training');
    place(e, -3000, 0, 0, 2500); // heading north, 3,000 m west of the boundary
    const east = trueToMagnetic(90, a.magneticVariationDeg);
    const west = trueToMagnetic(270, a.magneticVariationDeg);
    const r = say(e, cmd('HEADING', 'NKS451', { headingDeg: Math.round(east) }), 'APP');
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toContain(REF_MVA);
    expect(say(e, cmd('HEADING', 'NKS451', { headingDeg: Math.round(west) }), 'APP').status).toBe('accepted');
  });

  it('an aircraft high enough (3,500 ft) can be vectored into the higher sector', () => {
    const a = mvaFixture();
    const e = make(a, 'training');
    place(e, -3000, 0, 0, 3500);
    expect(say(e, cmd('HEADING', 'NKS451', { headingDeg: Math.round(trueToMagnetic(90, a.magneticVariationDeg)) }), 'APP').status).toBe('accepted');
  });
});

describe('real KACY MVA (ACY_MVA_FUS3)', () => {
  const kacy = loadKacy();
  /** A point strictly inside the sector (grid search over its bounding box, away from other sectors' holes). */
  const interior = (id: string): Vec2 => {
    const s = kacy.mvaSectors!.find((x) => x.id === id)!;
    const xs = s.polygon.map((p) => p.x), ys = s.polygon.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (let i = 1; i < 40; i++) for (let j = 1; j < 40; j++) {
      const q = { x: x0 + ((x1 - x0) * i) / 40, y: y0 + ((y1 - y0) * j) / 40 };
      if (mvaSectorAt(kacy, q)?.id === id) return q;
    }
    throw new Error(`no interior point found for ${id}`);
  };

  it('the ARP resolves to 1,600 ft (sector A) and a point in sector C to 2,500 ft; same answers as the airport package lookup', () => {
    expect(mvaAltitudeAt(kacy, { x: 0, y: 0 })).toBe(1600);
    expect(mvaAltitudeAt(kacy, interior('ACY-MVA-C'))).toBe(2500);
    for (const s of kacy.mvaSectors!) {
      const q = interior(s.id);
      expect(mvaAltitudeAt(kacy, q)).toBe(s.altitudeFt);
      expect(mvaAltitudeAt(kacy, q)).toBe(airportMvaAltitudeAt(kacy, q));
    }
  });

  it('an IFR arrival near the field cannot be assigned 1,500 ft (MVA 1,600); 2,000 ft is accepted', () => {
    const k = createEngine({
      airport: kacy, readbackErrorRate: 0,
      scenario: makeScenario({ controllerPositions: ALL_POSITIONS, mode: 'training', activeRunways: { departing: ['22'], landing: ['22'] },
        spawns: [AT_FIX('NKS451', 'PIDVE', ['PIDVE'], '22', {}, 5000, 200)] }),
    });
    const ac = place(k, 3000, 3000, 180, 5000);
    expect(mvaAltitudeAt(kacy, ac.pos)).toBe(1600);
    expect(say(k, cmd('ALTITUDE', 'NKS451', { altitudeFt: 1500 }), 'APP').status).toBe('rejected');
    expect(say(k, cmd('ALTITUDE', 'NKS451', { altitudeFt: 2000 }), 'APP').status).toBe('accepted');
  });
});
