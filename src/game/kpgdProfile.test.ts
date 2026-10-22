import { describe, expect, it } from 'vitest';
import { loadKpgd } from '../airport';
import { AIRPORT_NAMES } from '../commands/airports';
import { getPerformance } from '../sim/performance';
import { mulberry32 } from '../sim/rng';
import { spokenAirportName, spokenCallsign } from '../radio/spoken';
import { ifrDestinationsFor } from './ifr';
import { pickFlight, profileFor, profileTypes } from './airportProfile';
import { bearingTo } from './world';

const kpgd = loadKpgd();

describe('KPGD traffic profile (flypgd.com airlines; fleet types from the airlines, UNVERIFIED per route)', () => {
  const rng = mulberry32(11);
  const flights = Array.from({ length: 3000 }, () => pickFlight(rng, 'KPGD')!);
  it('only Allegiant (A320, A319, B38M) and Sun Country (B738)', () => {
    expect(new Set(flights.map((f) => f.callsign.slice(0, 3)))).toEqual(new Set(['AAY', 'SCX']));
    expect(new Set(flights.map((f) => f.type))).toEqual(new Set(['A320', 'A319', 'B38M', 'B738']));
    expect(flights.filter((f) => f.callsign.startsWith('AAY')).length / flights.length).toBeGreaterThan(0.85);
    expect(profileTypes('KPGD')).toEqual(expect.arrayContaining(['A320', 'A319', 'B38M', 'B738', 'C172']));
  });
  it('every type is registered, every destination known to the parser and spoken, the cruise altitude within the service ceiling', () => {
    const known = new Set(AIRPORT_NAMES.map((n) => n.icao));
    for (const e of profileFor('KPGD').airlines) {
      for (const t of e.types) expect(getPerformance(t).type).toBe(t);
      expect(spokenCallsign(`${e.icao3}1234`).startsWith(e.telephony)).toBe(true);
      for (const d of e.destinations) {
        expect(known.has(d.icao), d.icao).toBe(true);
        expect(spokenAirportName(d.icao), d.icao).not.toMatch(/\d|^[A-Z][a-z]+ [a-z]+ [a-z]+ [a-z]+$/);
        for (const alt of d.altitudesFt) for (const t of e.types) expect(alt, `${d.icao} ${t}`).toBeLessThanOrEqual(getPerformance(t).serviceCeilingFt);
      }
    }
  });
  it('departures only get Allegiant / Sun Country destinations; neighbour spoken names match the radio table; bearings are plausible', () => {
    const dests = new Set(ifrDestinationsFor(kpgd).map((d) => d.icao));
    expect(dests.has('KMSP')).toBe(true);
    expect(dests.has('KBOS')).toBe(false);
    for (const [id, n] of Object.entries(profileFor('KPGD').neighbours)) expect(spokenAirportName(id), id).toBe(n.spoken);
    expect(bearingTo(kpgd, 'KFMY')).toBeGreaterThan(150); // Page Field is south-southeast
    expect(bearingTo(kpgd, 'KFMY')).toBeLessThan(200);
    expect(bearingTo(kpgd, 'KSRQ')).toBeGreaterThan(300); // Sarasota is northwest
  });
  it('Class D: VFR transitions and vehicles only (no flight-training share: no source)', () => {
    expect(profileFor('KPGD').special).toEqual({ transition: { perHour: 3 }, vehicles: { perHour: 3 } });
  });
});
