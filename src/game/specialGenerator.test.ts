import { describe, expect, it } from 'vitest';
import { loadKacy, loadKmht } from '../airport';
import type { Airport, SimulationState } from '../sim/types';
import type { SpawnSpec } from '../sim/traffic';
import { game } from './game';
import { SPECIAL_LIMITS, TRANSIT_OFFSET_NM, TRANSIT_RADIUS_NM, isTrainingFlight, trainingCircuits } from './specialGenerator';
import { availableSpecialKinds, defaultSpecialTraffic, resolveSpecialTraffic } from './specialTraffic';
import { NM } from './world';
import { trueToMagnetic } from '../sim/geo';

const kacy = loadKacy();
const kmht = loadKmht();

/** A bare state: the generator reads the clock, the aircraft table, active runways, closures and the seed. */
function fakeState(airport: Airport, seed: number, timeSec: number, active: { departing: string[]; landing: string[] }): SimulationState {
  return {
    clock: { timeSec, dtSec: 0.1, speed: 1, tick: 0 }, aircraft: {}, activeRunways: active, seed, ops: { closures: [], braking: [], lightStep: {}, closureSeq: 0 },
    airport,
  } as unknown as SimulationState;
}

function generate(airport: Airport, opts: { seed?: number; hours?: number; specialTraffic?: Partial<ReturnType<typeof defaultSpecialTraffic>>; densityAt?: (s: SimulationState) => number; positions?: ('TWR' | 'GND' | 'APP')[] }) {
  const sc = game.buildFreePlay(airport, { seed: opts.seed ?? 7, weather: 'clear', aircraftCount: 0, maxAircraft: 60, specialTraffic: opts.specialTraffic ?? defaultSpecialTraffic(airport.icao) });
  if (opts.positions) sc.controllerPositions = opts.positions;
  const gen = game.createTrafficGenerator(sc, airport, { densityAt: opts.densityAt });
  const specs: SpawnSpec[] = [];
  for (let t = 0; t < (opts.hours ?? 10) * 3600; t += 5) specs.push(...gen.update(fakeState(airport, sc.seed, t, sc.activeRunways)));
  return specs;
}

const isHeli = (s: SpawnSpec) => s.type === 'H65';
const isF16 = (s: SpawnSpec) => s.type === 'F16';
const isVeh = (s: SpawnSpec) => s.type === 'VEH';
const isTransit = (s: SpawnSpec) => s.behavior?.kind === 'transit';

describe('special traffic profile', () => {
  it('KACY offers all five kinds, KMHT only VFR transitions and vehicles (no USCG / ANG, no sourced flight training)', () => {
    expect(availableSpecialKinds('KACY').sort()).toEqual(['helicopter', 'military', 'training', 'transition', 'vehicles']);
    expect(availableSpecialKinds('KMHT').sort()).toEqual(['transition', 'vehicles']);
    expect(resolveSpecialTraffic('KMHT', { helicopter: true, military: true, training: true, transition: true, vehicles: true })).toEqual({ helicopter: false, military: false, training: false, transition: true, vehicles: true });
  });
});

describe('special traffic shares', () => {
  const specs = generate(kacy, { hours: 20 });
  it('produces each kind at about its profile rate (rate x difficulty ramp 1.25 after the first minutes)', () => {
    const n = (p: (s: SpawnSpec) => boolean) => specs.filter(p).length;
    // helicopters 2/h, fighters 2/h, transits 4/h, vehicles 3/h over 20 h, thinned only by spawn constraints (parking, limits)
    expect(n(isHeli)).toBeGreaterThan(20);
    expect(n(isHeli)).toBeLessThan(70);
    expect(n(isF16)).toBeGreaterThan(20);
    expect(n(isF16)).toBeLessThan(70);
    expect(n(isTransit)).toBeGreaterThan(50);
    expect(n(isTransit)).toBeLessThan(130);
    expect(n(isVeh)).toBeGreaterThan(40);
    expect(n(isVeh)).toBeLessThan(110);
  });
  it('uses the callsign forms of JO 7110.65 2-4-20 / AC 150/5210-20A', () => {
    for (const s of specs.filter(isHeli)) expect(s.callsign).toMatch(/^CGD\d{5}$/);
    for (const s of specs.filter(isF16)) expect(s.callsign).toMatch(/^ANG\d{5}$/);
    for (const s of specs.filter(isVeh)) expect(s.callsign).toMatch(/^APT\d{1,2}$/);
  });
  it('mixes helicopter missions, fighter departures / overhead arrivals and formations of two', () => {
    const missions = new Set(specs.filter(isHeli).map((s) => (s.behavior as { mission?: string }).mission));
    expect(missions).toEqual(new Set(['DEPARTURE', 'ARRIVAL', 'REPOSITION']));
    const f = specs.filter(isF16);
    expect(f.some((s) => s.isDeparture)).toBe(true);
    expect(f.some((s) => !s.isDeparture && (s.behavior as { overhead?: boolean }).overhead)).toBe(true);
    const pairs = f.filter((s) => (s.behavior as { size?: number }).size === 2).length;
    expect(pairs / f.length).toBeGreaterThan(0.3);
    expect(pairs / f.length).toBeLessThan(0.7);
  });
  it('departs fighters from the ANG ramp and helicopters from the USCG helipads', () => {
    for (const s of specs.filter((x) => isF16(x) && x.isDeparture)) expect(s.start).toMatchObject({ kind: 'parked' });
    for (const s of specs.filter((x) => isF16(x) && x.isDeparture)) expect((s.start as { parkingId: string }).parkingId).toMatch(/^ANG-\d$/);
    for (const s of specs.filter((x) => isHeli(x) && x.start.kind === 'parked')) expect((s.start as { parkingId: string }).parkingId).toMatch(/^USCG-\d$/);
  });
  it('is deterministic for a seed', () => {
    const again = generate(kacy, { hours: 20 });
    expect(again.map((s) => `${s.callsign}@${s.atSec}`)).toEqual(specs.map((s) => `${s.callsign}@${s.atSec}`));
  });
  it('scales with the density curve', () => {
    const quiet = generate(kacy, { hours: 20, densityAt: () => 0.1 });
    expect(quiet.length).toBeLessThan(specs.length * 0.3);
    expect(quiet.length).toBeGreaterThan(0);
  });
  it('a kind that is switched off does not appear, and no kind appears without its controller position', () => {
    const off = generate(kacy, { hours: 10, specialTraffic: { helicopter: false, military: false, transition: false, training: false, vehicles: false } });
    expect(off.filter((s) => s.behavior)).toHaveLength(0);
    const noGround = generate(kacy, { hours: 10, positions: ['TWR'] });
    expect(noGround.filter(isVeh)).toHaveLength(0);
    expect(noGround.filter(isTransit).every((s) => s.initialFrequencyId === 'TWR')).toBe(true);
  });
  it('KMHT: transits and vehicles only', () => {
    const k = generate(kmht, { hours: 10, specialTraffic: { helicopter: true, military: true, training: true, transition: true, vehicles: true } });
    expect(k.filter(isHeli)).toHaveLength(0);
    expect(k.filter(isF16)).toHaveLength(0);
    expect(k.filter(isTransit).length).toBeGreaterThan(10);
    expect(k.filter(isVeh).length).toBeGreaterThan(10);
  });
  it('does not change the airline and GA traffic of a seed', () => {
    const plain = generate(kacy, { hours: 6, specialTraffic: { helicopter: false, military: false, transition: false, training: false, vehicles: false } }).filter((s) => !s.behavior);
    const withSpecial = generate(kacy, { hours: 6 }).filter((s) => !s.behavior || s.behavior.kind === 'training');
    const key = (s: SpawnSpec) => `${s.callsign}/${s.type}/${s.atSec}`;
    expect(withSpecial.map(key)).toEqual(plain.map(key));
  });
});

describe('VFR transit geometry (JO 7110.65 7-8, 14 CFR 91.159)', () => {
  const t = generate(kacy, { hours: 10 }).filter(isTransit);
  it('enters 22 nm out on a chord that passes 1-6 nm from the airport, at a VFR cruising altitude of its magnetic course, not below 5,500 ft', () => {
    expect(t.length).toBeGreaterThan(20);
    for (const s of t) {
      const st = s.start as { pos: { x: number; y: number }; altitudeFt: number; headingDeg: number };
      const ex = (s.behavior as { exitPos: { x: number; y: number } }).exitPos;
      expect(Math.hypot(st.pos.x, st.pos.y) / NM).toBeCloseTo(TRANSIT_RADIUS_NM, 0);
      // distance of the track from the airport reference point
      const dx = ex.x - st.pos.x;
      const dy = ex.y - st.pos.y;
      const off = Math.abs(st.pos.x * dy - st.pos.y * dx) / Math.hypot(dx, dy) / NM;
      expect(off).toBeGreaterThanOrEqual(TRANSIT_OFFSET_NM[0] - 0.01);
      expect(off).toBeLessThanOrEqual(TRANSIT_OFFSET_NM[1] + 0.01);
      const mag = (((trueToMagnetic(st.headingDeg, kacy.magneticVariationDeg) % 360) + 360) % 360);
      const thousandsPlus500 = (st.altitudeFt - 500) / 1000;
      expect(Number.isInteger(thousandsPlus500)).toBe(true);
      expect(thousandsPlus500 % 2 === 1).toBe(mag < 180); // odd thousands plus 500 for 0-179, even for 180-359
      expect(st.altitudeFt).toBeGreaterThanOrEqual(5500);
    }
  });
});

describe('flight training share', () => {
  it('about 40 % of the GA arrivals of KACY fly touch-and-go circuits (2 to 4), decided from the callsign', () => {
    const specs = generate(kacy, { hours: 20 }).filter((s) => !s.isDeparture && s.type === 'C172' && s.callsign.startsWith('N') && s.behavior?.kind !== 'transit');
    expect(specs.length).toBeGreaterThan(40);
    const tr = specs.filter((s) => s.behavior?.kind === 'training');
    expect(tr.length / specs.length).toBeGreaterThan(0.25);
    expect(tr.length / specs.length).toBeLessThan(0.55);
    for (const s of tr) {
      const c = (s.behavior as { circuits: number }).circuits;
      expect(c).toBeGreaterThanOrEqual(2);
      expect(c).toBeLessThanOrEqual(4);
    }
    expect(isTrainingFlight('N123AB', 0)).toBe(false);
    expect(trainingCircuits('N123AB')).toBe(trainingCircuits('N123AB'));
  });
  it('limits', () => {
    expect(SPECIAL_LIMITS.helicopter).toBe(2);
  });
});
