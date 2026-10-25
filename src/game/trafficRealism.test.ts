/** Traffic mix per airport: GA share, pattern work and rates come from each airport's sourced traffic profile (ATADS / UK CAA, data/sources/README.md "Traffic volumes and mix"). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { airportOrDefault as loadAirport } from '../airport';
import { createEngine } from '../sim/engine';
import type { SpawnSpec, TrafficGenerator } from '../sim/traffic';
import { game } from './game';
import { PLAYABLE_RATE_CAP, profileFor, rateScaleFor, trafficDefaultsFor } from './airportProfile';
import { DENSITY_DAY_INTEGRAL, peakHourMovements } from './trafficDensity';
import { availableSpecialKinds, defaultSpecialTraffic } from './specialTraffic';

const ICAOS = ['KACY', 'KMHT', 'KBOS', 'KPHL', 'KPGD', 'EGLL'] as const;
const sourced = JSON.parse(readFileSync(new URL('../../data/sources/traffic-volumes.json', import.meta.url), 'utf8')) as {
  airports: Record<string, { atads?: Record<string, Record<string, number>>; caa?: Record<string, Record<string, number>> }>;
};

describe('traffic volumes are present and sourced', () => {
  for (const icao of ICAOS) {
    it(`${icao}: profile volumes match the recorded source`, () => {
      const v = profileFor(icao).volumes;
      expect(v.year).toBe(2025);
      expect(v.retrieved).toMatch(/^2026-\d\d-\d\d$/);
      const rec = icao === 'EGLL' ? sourced.airports.EGLL.caa![String(v.year)] : sourced.airports[icao].atads![String(v.year)];
      expect(v.source).toBe(icao === 'EGLL' ? 'UK CAA' : 'FAA ATADS');
      expect(v.total).toBe(rec.total);
      if (icao === 'EGLL') {
        expect(v.airCarrier).toBe(rec.airTransport);
        expect(v.gaItinerant).toBe(rec.privateFlights + rec.aeroClub + rec.businessAviation);
      } else {
        for (const k of ['airCarrier', 'airTaxi', 'gaItinerant', 'militaryItinerant', 'localCivil', 'localMilitary'] as const) expect(v[k]).toBe(rec[k]);
        // the categories add up to the facility total
        expect(v.airCarrier + v.airTaxi + v.gaItinerant + v.militaryItinerant + v.localCivil + v.localMilitary).toBe(v.total);
      }
    });
  }
});

describe('free-play defaults are derived from the volumes', () => {
  const share = (icao: string): number => {
    const v = profileFor(icao).volumes;
    return v.gaItinerant / (v.airCarrier + v.airTaxi + v.gaItinerant);
  };
  it('GA share = GA itinerant / (air carrier + air taxi + GA itinerant) for the new airports', () => {
    for (const icao of ['KBOS', 'KPHL', 'KPGD']) expect(trafficDefaultsFor(icao).gaFraction).toBeCloseTo(share(icao), 3);
    expect(trafficDefaultsFor('EGLL').gaFraction).toBe(0);
  });
  it('KACY and KMHT keep their tuned defaults', () => {
    for (const icao of ['KACY', 'KMHT']) expect(trafficDefaultsFor(icao)).toEqual({ gaFraction: 0.5, patternWork: true });
    expect(rateScaleFor('KACY')).toBe(1);
  });
  it('peak-hour rates = annual itinerant movements / 365 / day integral of the density curve / 2', () => {
    expect(DENSITY_DAY_INTEGRAL).toBeCloseTo(13.25, 6);
    for (const icao of ['KBOS', 'KPHL', 'KPGD', 'EGLL']) {
      const v = profileFor(icao).volumes;
      const itinerant = v.total - v.localCivil - v.localMilitary;
      const d = trafficDefaultsFor(icao);
      expect(d.peakArrivalsPerHour).toBe(Math.round(peakHourMovements(itinerant) / 2));
      expect(d.peakDeparturesPerHour).toBe(d.peakArrivalsPerHour);
    }
  });
  it('pattern work only where the national statistics count local operations or the tuned airports had it', () => {
    expect(trafficDefaultsFor('KBOS').patternWork).toBe(false);
    expect(trafficDefaultsFor('KPHL').patternWork).toBe(false);
    expect(trafficDefaultsFor('EGLL').patternWork).toBe(false);
    expect(trafficDefaultsFor('KPGD').patternWork).toBe(true);
    for (const icao of ['KBOS', 'KPHL', 'EGLL']) {
      const v = profileFor(icao).volumes;
      expect(v.localCivil).toBe(0);
    }
    expect(profileFor('KPGD').volumes.localCivil).toBeGreaterThan(50000);
  });
  it('flight training is offered by default only where pattern work is', () => {
    for (const icao of ICAOS) {
      const hasTraining = availableSpecialKinds(icao).includes('training');
      if (!trafficDefaultsFor(icao).patternWork) expect(hasTraining).toBe(false);
    }
    expect(defaultSpecialTraffic('KPGD').training).toBe(true);
    expect(profileFor('KPGD').special?.training?.gaShare).toBeCloseTo(0.3, 2);
  });
  it('quieter airports scale the generic rates, busy ones do not', () => {
    expect(rateScaleFor('KBOS')).toBe(1);
    expect(rateScaleFor('KPGD')).toBeCloseTo(8 / PLAYABLE_RATE_CAP, 6);
  });
});

describe('buildFreePlay follows the airport profile', () => {
  for (const icao of ICAOS) {
    it(`${icao}: scenario GA share and pattern work`, () => {
      const sc = game.buildFreePlay(loadAirport(icao), { seed: 1, weather: 'clear' });
      const d = trafficDefaultsFor(icao);
      const jets = profileFor(icao).airlines.length > 0;
      const gaOnly = profileFor(icao).gaTypes.length === 0;
      expect(sc.traffic!.gaFraction).toBe(gaOnly ? 0 : jets ? d.gaFraction : 1);
      expect(sc.traffic!.patternWork).toBe(d.patternWork ? undefined : false);
    });
  }
  it('KACY rates are unchanged (9 + 9 per hour on a typical day)', () => {
    const sc = game.buildFreePlay(loadAirport('KACY'), { seed: 1, weather: 'clear' });
    expect(sc.traffic).toMatchObject({ arrivalsPerHour: 9, departuresPerHour: 9, gaFraction: 0.5 });
  });
  it('KPGD typical-day rates follow its smaller traffic (peak 8 per hour)', () => {
    const sc = game.buildFreePlay(loadAirport('KPGD'), { seed: 1, weather: 'clear' });
    expect(sc.traffic!.arrivalsPerHour).toBe(Math.round(9 * rateScaleFor('KPGD')));
    expect(sc.traffic!.arrivalsPerHour).toBeLessThan(9);
  });
  it('the options still override the profile', () => {
    const sc = game.buildFreePlay(loadAirport('KBOS'), { seed: 1, weather: 'clear', gaFraction: 0.6, patternWork: true, arrivalsPerHour: 12 });
    expect(sc.traffic).toMatchObject({ gaFraction: 0.6, arrivalsPerHour: 12 });
    expect(sc.traffic!.patternWork).toBeUndefined();
  });
});

describe('the generator respects the GA share (2 simulated hours)', () => {
  function count(icao: string, seed: number): { ga: number; airline: number } {
    const airport = loadAirport(icao);
    const sc = game.buildFreePlay(airport, { seed, weather: 'clear', aircraftCount: 0, difficulty: 'normal', arrivalsPerHour: 30, departuresPerHour: 30, maxAircraft: 400 });
    sc.traffic = { ...sc.traffic!, flowControl: false };
    const inner = game.createTrafficGenerator(sc, airport);
    const out: SpawnSpec[] = [];
    const wrapped: TrafficGenerator = { update(state) { const s = inner.update(state); out.push(...s); return s; } };
    const e = createEngine({ airport, scenario: sc, trafficGenerator: wrapped });
    for (let i = 0; i < 7200 * 10; i++) e.step();
    const gaTypes = new Set(profileFor(icao).gaTypes.map(([t]) => t));
    const ga = out.filter((s) => gaTypes.has(s.type)).length;
    return { ga, airline: out.length - ga };
  }
  it('KBOS: almost all airline flights (profile GA share 1.9 %)', () => {
    const r = count('KBOS', 1);
    expect(r.ga + r.airline).toBeGreaterThan(60);
    expect(r.ga / (r.ga + r.airline)).toBeLessThan(0.08);
    expect(r.airline).toBeGreaterThan(60);
  }, 300000);
  it('KPGD: mostly general aviation (profile GA share 80 %)', () => {
    const r = count('KPGD', 1);
    expect(r.ga / (r.ga + r.airline)).toBeGreaterThan(0.6);
    expect(r.airline).toBeGreaterThan(3);
  }, 300000);
  it('KACY: the 50 % it was tuned to', () => {
    const r = count('KACY', 1);
    expect(r.ga / (r.ga + r.airline)).toBeGreaterThan(0.35);
    expect(r.ga / (r.ga + r.airline)).toBeLessThan(0.65);
  }, 300000);
});
