import { describe, expect, it } from 'vitest';
import { loadKbos } from '../airport';
import { game } from './game';
import { arrivalProcedure, ifrDestinationsFor, ifrFlightPlan, starArrival } from './ifr';
import { profileFor, profileDestinations, pickFlight } from './airportProfile';
import { getPerformance } from '../sim/performance';
import { AIRLINES } from '../commands/lexicon';
import { AIRPORT_NAMES } from '../commands/airports';
import { mulberry32 } from '../sim/rng';
import { selectRunwayConfiguration } from '../weather/runwayConfigurations';

const kbos = loadKbos();

describe('KBOS scenario catalogue', () => {
  it('free play only; every scenario builds against the KBOS data with runway ends and gates that exist', () => {
    expect(new Set(game.listScenarios('KBOS').map((s) => s.mode))).toEqual(new Set(['free_play']));
    const ends = new Set(kbos.runways.flatMap((r) => r.ends.map((e) => e.id)));
    for (const s of game.listScenarios('KBOS')) {
      const sc = game.buildScenario(s.id, kbos, { seed: 3 });
      for (const r of [...sc.activeRunways.departing, ...sc.activeRunways.landing]) expect(ends.has(r), `${s.id} ${r}`).toBe(true);
      for (const sp of sc.spawns) if (sp.start.kind === 'parked') expect(kbos.parking.some((p) => p.id === (sp.start as { parkingId: string }).parkingId)).toBe(true);
    }
  });
});

describe('KBOS traffic profile', () => {
  const profile = profileFor('KBOS');
  it('every aircraft type has a performance entry, every airline word is known to the parser, every destination is a known airport', () => {
    const known = new Set(AIRPORT_NAMES.map((n) => n.icao));
    for (const e of profile.airlines) {
      expect([...AIRLINES.values()], e.icao3).toContain(e.icao3);
      for (const t of e.types) expect(getPerformance(t).type, t).toBe(t);
      for (const d of e.destinations) expect(known.has(d.icao), `${e.icao3} -> ${d.icao}`).toBe(true);
    }
    for (const n of Object.keys(profile.neighbours)) expect(known.has(n), n).toBe(true);
  });

  it('JetBlue and Delta carry the largest weights; Cape Air flies the C402; heavies exist for the international legs', () => {
    const w = (icao3: string) => profile.airlines.filter((e) => e.icao3 === icao3).reduce((a, e) => a + e.weight, 0);
    expect(w('JBU')).toBeGreaterThan(w('DAL') - 1);
    expect(w('DAL')).toBeGreaterThan(w('AAL'));
    expect(profile.airlines.find((e) => e.icao3 === 'KAP')!.types).toEqual(['C402']);
    expect(profile.airlines.flatMap((e) => e.types).some((t) => getPerformance(t).wakeCategory === 'heavy')).toBe(true);
    const f = pickFlight(mulberry32(4), 'KBOS')!;
    expect(f.callsign).toMatch(/^[A-Z]{3}\d+$/);
  });

  it('IFR destinations come from the profile; departures file to them with no exit fix', () => {
    expect(ifrDestinationsFor(kbos).map((d) => d.icao)).toEqual(profileDestinations(profile).map((d) => d.icao));
    expect(ifrDestinationsFor(kbos).map((d) => d.icao)).toContain('EGLL');
    const fp = ifrFlightPlan(kbos, mulberry32(5), 'A320');
    expect(fp.origin).toBe('KBOS');
    expect(fp.route).toEqual([]);
  });

  it('Class B: VFR transitions are rare; no helicopter or military kinds', () => {
    expect(profile.special).toEqual({ transition: { perHour: 1 }, vehicles: { perHour: 3 } });
  });
});

describe('KBOS arrival procedures and runway configurations', () => {
  it('IFR arrivals fly the published ILS fixes (4R GOSHI..MILTT, 22L NOLEY..VOCUS) and RNAV on 4L / 32', () => {
    expect(arrivalProcedure(kbos, '4R')).toMatchObject({ approachType: 'ILS', fafFix: 'MILTT' });
    expect(arrivalProcedure(kbos, '22L')).toMatchObject({ approachType: 'ILS', fafFix: 'VOCUS' });
    expect(arrivalProcedure(kbos, '27')?.fafFix).toBe('RIPIT');
    expect(arrivalProcedure(kbos, '33L')?.fafFix).toBe('NIMOY');
    expect(arrivalProcedure(kbos, '15R')?.fafFix).toBe('MALDY');
    expect(arrivalProcedure(kbos, '4L')?.approachType).toBe('RNAV');
    expect(arrivalProcedure(kbos, '32')?.approachType).toBe('RNAV');
    expect(arrivalProcedure(kbos, '9')).toBeUndefined();
  });

  it('turbojets reach every runway end with an approach over the entries of both STARs', () => {
    for (const e of ['4L', '4R', '22L', '22R', '27', '32', '33L']) expect(starArrival(kbos, e)!.entries.map((x) => x.ref!.star.ident).sort(), e).toEqual(['JFUND2', 'JFUND2', 'ROBUC3', 'ROBUC3']);
    // runway 15R: AUTUM is not on the JFUND TWO runway 15R body (JFUND, BADCA, WACHU, SSAAM, AADMS)
    expect(starArrival(kbos, '15R')!.entries.map((x) => x.fix)).toEqual(['PROVI', 'JOODY', 'JFUND']);
  });

  it('configuration selection: northeast wind -> NE flow; southwest -> SW; northwest -> NW; calm -> the first (NE)', () => {
    const pick = (dir: number, kt: number) => selectRunwayConfiguration(kbos.runwayConfigurations, { windDirDeg: dir, windSpeedKt: kt, windGustKt: undefined }, kbos)?.config.id;
    expect(pick(30, 12)).toBe('NE-4R4L-9');
    expect(pick(230, 12)).toBe('SW-22L27');
    expect(pick(300, 12)).toBe('NW-33L27');
    expect(pick(150, 12)).toBe('SE-15R-9');
    expect(pick(0, 2)).toBe('NE-4R4L-9');
  });
});
