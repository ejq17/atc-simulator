import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadKacy, loadKmht } from '../airport';
import { AIRPORT_NAMES } from '../commands/airports';
import { AIRLINES as LEXICON_AIRLINES } from '../commands/lexicon';
import { parseTransmission } from '../commands';
import type { AircraftRef } from '../commands';
import { CTX } from '../commands/testkit';
import { createEngine } from '../sim/engine';
import { getPerformance, srsCategory, wakeRecatCategory } from '../sim/performance';
import { mulberry32 } from '../sim/rng';
import type { TrafficGenerator, SpawnSpec } from '../sim/traffic';
import type { AircraftPerformance, Scenario } from '../sim/types';
import { spokenAirportName, spokenCallsign } from '../radio/spoken';
import { game } from './game';
import { ifrDestinationsFor } from './ifr';
import { pickFlight, pickGaType, profileFor, profileTypes, resolveTypeSelection, entryWeight } from './airportProfile';
import { bearingTo, NEIGHBOURS, parkingPoolFor, randomAirlineCallsign } from './world';

const kacy = loadKacy();
const kmht = loadKmht();

const KMHT_NEW_TYPES = ['B738', 'BCS3', 'E175', 'CRJ9', 'B752', 'C208'] as const;

describe('KACY profile keeps its behaviour', () => {
  it('callsigns are the old Spirit 80 / American 20 sequence for the same random stream', () => {
    const old = (rng: () => number): string => {
      const spirit = rng() < 0.8;
      const num = spirit ? 100 + Math.floor(rng() * 1400) : 100 + Math.floor(rng() * 2900);
      return `${spirit ? 'NKS' : 'AAL'}${num}`;
    };
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      expect(randomAirlineCallsign(a)).toBe(old(b));
      if (i === 0) expect(randomAirlineCallsign(mulberry32(1), 'KACY')).toBe(old(mulberry32(1)));
    }
  });

  it('only A320 and C172, and the same neighbour table', () => {
    expect(profileTypes('KACY')).toEqual(['C172', 'A320']);
    const rng = mulberry32(3);
    for (let i = 0; i < 200; i++) expect(pickFlight(rng, 'KACY')!.type).toBe('A320');
    expect(pickGaType(rng, 'KACY')).toBe('C172');
    expect(Object.keys(NEIGHBOURS).sort()).toEqual(['26N', 'KMIV', 'KPHL', 'KTEB', 'KWWD']);
    expect(ifrDestinationsFor(kacy).map((d) => d.icao)).toContain('KBOS');
  });
});

describe('KMHT profile', () => {
  const rng = mulberry32(7);
  const flights = Array.from({ length: 4000 }, () => pickFlight(rng, 'KMHT')!);

  it('never produces Spirit, Delta or Avelo callsigns; only the airlines of the profile', () => {
    const prefixes = new Set(flights.map((f) => f.callsign.slice(0, 3)));
    for (const bad of ['NKS', 'DAL', 'VXP', 'JBU']) expect(prefixes.has(bad)).toBe(false);
    expect([...prefixes].sort()).toEqual(['AAL', 'FDX', 'GJS', 'JIA', 'MXY', 'PDT', 'RPA', 'SCX', 'SKW', 'SWA', 'UPS', 'WIG']);
  });

  it('weights follow the mix (Southwest about a third, Breeze about 15 %)', () => {
    const share = (p: string): number => flights.filter((f) => f.callsign.startsWith(p)).length / flights.length;
    expect(share('SWA')).toBeGreaterThan(0.3);
    expect(share('SWA')).toBeLessThan(0.4);
    expect(share('MXY')).toBeGreaterThan(0.11);
    expect(share('MXY')).toBeLessThan(0.19);
    expect(share('AAL')).toBeLessThan(0.09);
  });

  it('every type is registered with its own performance entry, every destination is known to the parser, every telephony is spoken and parsed', () => {
    const known = new Set(AIRPORT_NAMES.map((n) => n.icao));
    const parserWords = new Set(LEXICON_AIRLINES.values());
    for (const e of profileFor('KMHT').airlines) {
      for (const t of e.types) expect(getPerformance(t).type, t).toBe(t);
      for (const d of e.destinations) expect(known.has(d.icao), `${e.icao3} -> ${d.icao}`).toBe(true);
      // UPS is spoken letter by letter ("U P S") by the existing spoken table
      expect(spokenCallsign(`${e.icao3}1234`).replace(/ /g, '').startsWith(e.telephony.replace(/ /g, '')), e.icao3).toBe(true);
      // Sun Country is a two-word phrase handled by the lexicon PHRASES table; every other telephony is one word.
      if (e.icao3 !== 'SCX') expect(parserWords.has(e.icao3), e.icao3).toBe(true);
      for (const d of e.destinations) for (const alt of d.altitudesFt) expect(alt).toBeLessThanOrEqual(getPerformance(e.types[0]).serviceCeilingFt);
    }
  });

  it('generated departures only get KMHT destinations (never KBOS or the KACY hops KJFK/KEWR)', () => {
    const dests = new Set(ifrDestinationsFor(kmht).map((d) => d.icao));
    expect(dests.has('KBOS')).toBe(false);
    for (const e of profileFor('KMHT').airlines) for (const d of e.destinations) expect(dests.has(d.icao)).toBe(true);
    expect(dests.has('KJFK')).toBe(false);
    expect(dests.has('KEWR')).toBe(false);
  });

  it('neighbour spoken names match the radio table, and inbound bearings use the KMHT neighbours', () => {
    for (const [id, n] of Object.entries(profileFor('KMHT').neighbours)) expect(spokenAirportName(id), id).toBe(n.spoken);
    const brg = (id: string): number => bearingTo(kmht, id);
    expect(brg('KCON') > 340 || brg('KCON') < 20).toBe(true); // Concord is north
    expect(brg('KBED')).toBeGreaterThan(150);
    expect(brg('KBED')).toBeLessThan(200); // Hanscom is south-southeast of Manchester
    expect(brg('KEEN')).toBeGreaterThan(255);
    expect(brg('KEEN')).toBeLessThan(290); // Keene is west
    expect(brg('KPSM')).toBeGreaterThan(60);
    expect(brg('KPSM')).toBeLessThan(110); // Portsmouth is east
    // KACY scenarios keep their own table
    expect(() => bearingTo(kacy, 'KMIV')).not.toThrow();
  });

  it('the type selection resolves against the profile; an empty result means everything', () => {
    expect(resolveTypeSelection('KMHT', ['C172'])).toMatchObject({ ga: true, jets: false });
    expect(resolveTypeSelection('KMHT', ['B752'])).toMatchObject({ ga: false, jets: true });
    expect(resolveTypeSelection('KACY', ['B752'])).toEqual({ ga: true, jets: true });
    const rng2 = mulberry32(2);
    for (let i = 0; i < 100; i++) expect(pickFlight(rng2, 'KMHT', { allowedTypes: ['E175'] })!.type).toBe('E175');
    expect(pickFlight(rng2, 'KACY', { allowedTypes: ['B752'] })).toBeUndefined();
  });

  it('cargo is weighted to the night bank and the Caravan to the day', () => {
    const ups = profileFor('KMHT').airlines.find((e) => e.icao3 === 'UPS')!;
    const wig = profileFor('KMHT').airlines.find((e) => e.icao3 === 'WIG')!;
    expect(entryWeight(ups, 23)).toBeGreaterThan(entryWeight(ups, 12) * 5);
    expect(entryWeight(ups, 3)).toBe(ups.weight);
    expect(entryWeight(wig, 12)).toBeGreaterThan(entryWeight(wig, 23) * 5);
    expect(entryWeight(ups, undefined)).toBe(ups.weight);
    const r = mulberry32(5);
    const night = Array.from({ length: 3000 }, () => pickFlight(r, 'KMHT', { localHour: 23 })!).filter((f) => f.callsign.startsWith('UPS') || f.callsign.startsWith('FDX')).length;
    const day = Array.from({ length: 3000 }, () => pickFlight(r, 'KMHT', { localHour: 12 })!).filter((f) => f.callsign.startsWith('UPS') || f.callsign.startsWith('FDX')).length;
    expect(night).toBeGreaterThan(day * 4);
  });
});

describe('performance entries for the KMHT types', () => {
  const fields: (keyof AircraftPerformance)[] = [
    'type', 'category', 'wakeCategory', 'taxiSpeedKt', 'taxiTurnSpeedKt', 'accelKtPerSec', 'decelKtPerSec', 'rotateSpeedKt', 'climbSpeedKt', 'cruiseSpeedKt',
    'approachSpeedKt', 'touchdownSpeedKt', 'climbRateFpm', 'descentRateFpm', 'turnRateDegPerSec', 'groundTurnRateDegPerSec', 'minSpeedKt', 'maxSpeedKt',
    'serviceCeilingFt', 'takeoffDistanceFt', 'landingDistanceFt', 'lengthM',
  ];

  it.each(KMHT_NEW_TYPES)('%s is complete and sane', (t) => {
    const p = getPerformance(t);
    expect(p.type).toBe(t);
    for (const f of fields) expect(p[f], f).toBeDefined();
    expect(p.approachSpeedKt).toBeLessThan(p.cruiseSpeedKt);
    expect(p.minSpeedKt).toBeLessThan(p.approachSpeedKt);
    expect(p.touchdownSpeedKt).toBeLessThanOrEqual(p.approachSpeedKt);
    expect(p.rotateSpeedKt).toBeLessThan(p.climbSpeedKt);
    expect(p.climbSpeedKt).toBeLessThan(p.maxSpeedKt);
    expect(p.takeoffDistanceFt).toBeLessThan(9250);
    expect(p.landingDistanceFt).toBeLessThan(9250);
    // the 7,651 ft runway 6/24 can be used from full length, as the free-play runway choice assumes
    expect(p.takeoffDistanceFt).toBeLessThan(7651);
    expect(p.lengthM).toBeGreaterThan(10);
  });

  it('SRS and RECAT categories', () => {
    for (const t of ['B738', 'BCS3', 'E175', 'CRJ9']) {
      expect(srsCategory(t)).toBe(3);
      expect(wakeRecatCategory(t)).toBe('F');
    }
    expect(srsCategory('B752')).toBe(3);
    expect(wakeRecatCategory('B752')).toBe('E');
    expect(srsCategory('C208')).toBe(1);
    expect(wakeRecatCategory('C208')).toBe('I');
    expect(getPerformance('C208').category).toBe('light');
  });

  it('the TypeScript registry matches data/sources/aircraft-performance.json', () => {
    const json = JSON.parse(readFileSync('data/sources/aircraft-performance.json', 'utf8')) as Record<string, Record<string, unknown>>;
    for (const t of [...KMHT_NEW_TYPES, 'C172', 'A320']) {
      const p = getPerformance(t);
      const j = json[t];
      expect(j, t).toBeDefined();
      expect(j._sources, t).toBeDefined();
      for (const f of fields) if (t !== 'C172' && t !== 'A320') expect(j[f], `${t}.${f}`).toBe(p[f]);
    }
  });

  it('cargo types park at cargo spots, airliners at gates, the Caravan and GA on the ramp', () => {
    expect(parkingPoolFor(kmht, 'B752').every((p) => p.category === 'cargo')).toBe(true);
    expect(parkingPoolFor(kmht, 'B752').length).toBeGreaterThan(0);
    for (const t of ['B738', 'BCS3', 'E175', 'CRJ9']) expect(parkingPoolFor(kmht, t).every((p) => p.category === 'airline')).toBe(true);
    for (const t of ['C208', 'C172', 'PA28']) expect(parkingPoolFor(kmht, t).every((p) => p.category === 'ga' || p.category === 'fbo')).toBe(true);
    // an airport without a cargo apron falls back to gates
    expect(parkingPoolFor({ ...kacy, parking: kacy.parking.filter((p) => p.category !== 'cargo') }, 'B752').every((p) => p.category === 'airline')).toBe(true);
  });
});

describe('traffic generator at KMHT', () => {
  function run(over: { types?: string[]; ifr?: boolean; seed?: number; sec?: number }): SpawnSpec[] {
    const sc: Scenario = game.buildFreePlay(kmht, {
      seed: over.seed ?? 9, weather: 'clear', aircraftCount: 0, aircraftTypes: over.types, ifrFlows: over.ifr,
      arrivalsPerHour: 40, departuresPerHour: 40, gaFraction: 0.3, maxAircraft: 14,
    });
    const inner = game.createTrafficGenerator(sc, kmht);
    const recs: SpawnSpec[] = [];
    const wrapped: TrafficGenerator = { update(state) { const out = inner.update(state); recs.push(...out); return out; } };
    const engine = createEngine({ airport: kmht, scenario: sc, trafficGenerator: wrapped });
    for (let i = 0; i < (over.sec ?? 2400) * 10; i++) engine.step();
    return recs;
  }

  it('spawns the KMHT airline mix and several airliner types, never a Spirit', () => {
    const recs = run({ ifr: true, sec: 3600 });
    const types = new Set(recs.map((r) => r.type));
    expect(types.size).toBeGreaterThanOrEqual(4);
    expect(types.has('B738')).toBe(true);
    expect(recs.some((r) => r.callsign.startsWith('NKS'))).toBe(false);
    expect(new Set(recs.map((r) => r.callsign)).size).toBe(recs.length);
    const deps = recs.filter((r) => r.isDeparture && r.flightPlan);
    expect(deps.length).toBeGreaterThan(3);
    const allowed = new Set(ifrDestinationsFor(kmht).map((d) => d.icao));
    for (const d of deps) {
      expect(allowed.has(d.flightPlan!.destination), d.callsign).toBe(true);
      expect(d.remoteAirport).toBe(d.flightPlan!.destination);
    }
  });

  it('cargo departures park at cargo spots and the Caravan on the GA ramp', () => {
    const cargo = run({ types: ['B752'], ifr: true });
    const dep = cargo.filter((r) => r.isDeparture);
    expect(dep.length).toBeGreaterThan(2);
    for (const d of dep) {
      expect(d.type).toBe('B752');
      expect(/^(UPS|FDX)\d+$/.test(d.callsign)).toBe(true);
      expect((d.start as { parkingId: string }).parkingId).toMatch(/^CARGO-/);
    }
    const car = run({ types: ['C208'], ifr: true });
    const cdep = car.filter((r) => r.isDeparture);
    expect(cdep.length).toBeGreaterThan(2);
    for (const d of cdep) {
      expect(d.callsign.startsWith('WIG')).toBe(true);
      expect((d.start as { parkingId: string }).parkingId).toMatch(/^(GA|FBO)-/);
    }
  });

  it('VFR traffic is Cessna/Piper tails with KMHT neighbours as the other end', () => {
    const recs = run({ types: ['C172'] });
    expect(recs.length).toBeGreaterThan(5);
    const nb = new Set(Object.keys(profileFor('KMHT').neighbours));
    for (const r of recs) {
      expect(['C172', 'PA28']).toContain(r.type);
      expect(r.callsign).toMatch(/^N\d/);
      expect(nb.has(r.remoteAirport!), r.callsign).toBe(true);
    }
  });

  it('KACY still spawns only Spirit/American A320s and Cessnas', () => {
    const sc = game.buildFreePlay(kacy, { seed: 4, weather: 'clear', aircraftCount: 0, arrivalsPerHour: 40, departuresPerHour: 40, maxAircraft: 12 });
    const inner = game.createTrafficGenerator(sc, kacy);
    const recs: SpawnSpec[] = [];
    const engine = createEngine({ airport: kacy, scenario: sc, trafficGenerator: { update(state) { const o = inner.update(state); recs.push(...o); return o; } } });
    for (let i = 0; i < 1800 * 10; i++) engine.step();
    expect(recs.length).toBeGreaterThan(5);
    for (const r of recs) {
      expect(['C172', 'A320']).toContain(r.type);
      if (r.type === 'A320') expect(/^(NKS|AAL)\d+$/.test(r.callsign)).toBe(true);
      expect(r.remoteAirport).toBeUndefined();
    }
  });
});

describe('parser accepts the KMHT airline callsigns', () => {
  const refs: AircraftRef[] = [
    { callsign: 'SWA1234', spokenCallsign: spokenCallsign('SWA1234', 'B738'), type: 'B738' },
    { callsign: 'MXY512', spokenCallsign: spokenCallsign('MXY512', 'BCS3'), type: 'BCS3' },
    { callsign: 'RPA4521', spokenCallsign: spokenCallsign('RPA4521', 'E175'), type: 'E175' },
    { callsign: 'GJS3320', spokenCallsign: spokenCallsign('GJS3320', 'CRJ9'), type: 'CRJ9' },
    { callsign: 'WIG210', spokenCallsign: spokenCallsign('WIG210', 'C208'), type: 'C208' },
    { callsign: 'UPS918', spokenCallsign: spokenCallsign('UPS918', 'B752'), type: 'B752' },
    { callsign: 'JIA5120', spokenCallsign: spokenCallsign('JIA5120', 'CRJ9'), type: 'CRJ9' },
  ];
  const ctx = { ...CTX, aircraft: refs, runwayEnds: ['6', '24', '17', '35'] };
  const cases: [string, string][] = [
    ['Southwest 1234 runway one seven cleared for takeoff', 'SWA1234'],
    ['Southwest twelve thirty four runway one seven cleared for takeoff', 'SWA1234'],
    ['Moxy 512 runway one seven cleared for takeoff', 'MXY512'],
    ['Moxy five twelve runway one seven cleared for takeoff', 'MXY512'],
    ['Brickyard 4521 runway one seven cleared for takeoff', 'RPA4521'],
    ['Brickyard forty five twenty one runway one seven cleared for takeoff', 'RPA4521'],
    ['Lindbergh 3320 runway one seven cleared for takeoff', 'GJS3320'],
    ['Wiggins 210 runway one seven cleared for takeoff', 'WIG210'],
    ['UPS 918 runway one seven cleared for takeoff', 'UPS918'],
  ];
  it.each(cases)('%s', (say, callsign) => {
    const r = parseTransmission(say, ctx);
    expect(r.callsign).toBe(callsign);
    expect(r.commands.some((c) => c.kind === 'TAKEOFF')).toBe(true);
  });

  it('"Blue Streak 5120" resolves through the single word "streak" (the phrase table is outside this change)', () => {
    const r = parseTransmission('Blue Streak 5120 runway one seven cleared for takeoff', ctx);
    expect(r.callsign).toBe('JIA5120');
  });
});
