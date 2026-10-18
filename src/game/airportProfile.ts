/**
 * Airport traffic profiles: what the generated traffic at an airport looks like (airlines and their equipment, where they fly, which
 * neighbouring airfields VFR traffic comes from). Keyed by ICAO; unknown airports use the KACY profile.
 *
 * Gameplay data, not aeronautical data. KACY keeps exactly the behaviour it had before profiles existed: Spirit 80 % / American 20 %,
 * A320 only, the short-hop destinations of ifr.ts and the old neighbour table. KMHT mirrors the airlines serving Manchester-Boston
 * Regional per flymanchester.com "Airlines serving MHT" (checked 2026-10-17); weights are a gameplay mix, not traffic statistics.
 * The rows are the single place to change the mix (src/game/README.md).
 */

export type Hours = 'day' | 'night' | 'any';

export interface RouteDestination {
  /** ICAO of the other end of the leg; must be an airport the command parser knows (src/commands/airports.ts). */
  icao: string;
  /** Cruise altitude choices (ft) for this leg. */
  altitudesFt: readonly number[];
}

export interface AirlineEntry {
  /** ICAO three-letter designator used in the callsign ("SWA1234"). */
  icao3: string;
  /** Radio telephony ("Southwest"); the spoken form is also in src/radio/spoken.ts and the parser word in src/commands/lexicon.ts. */
  telephony: string;
  /** Aircraft types this airline operates here (each must be registered in src/sim/performance.ts). */
  types: readonly string[];
  weight: number;
  /** Flight-plan destinations; empty = the airport's legacy list (`ifrDestinationsFor`). */
  destinations: readonly RouteDestination[];
  /** Inclusive flight-number range. */
  flightNumbers: readonly [number, number];
  /** 'night' / 'day' entries are weighted down outside their hours when a local hour is known (cargo banks). Default 'any'. */
  hours?: Hours;
}

export interface Neighbour {
  name: string;
  lat: number;
  lon: number;
  /** How a pilot says the airport (also in src/radio/spoken.ts AIRPORT_CITIES; a test keeps them in sync). */
  spoken: string;
}

export interface AirportTrafficProfile {
  icao: string;
  airlines: readonly AirlineEntry[];
  /** VFR neighbours: approximate reference coordinates (~0.01 deg is plenty for choosing an inbound bearing). */
  neighbours: Readonly<Record<string, Neighbour>>;
  /**
   * Neighbours that generated GA traffic comes from / goes to (stamped on spawns as `remoteAirport`). Undefined = the engine's own
   * legacy origin list (KACY).
   */
  gaRemote?: readonly string[];
  /** GA type variants chosen with the 'C172' selection of the setup screen: [type, weight]. */
  gaTypes: readonly (readonly [string, number])[];
  /** Representative jet used to pick runways that "jets can use" (free play). */
  referenceJet: string;
}

/** Local hours (airport time) in which 'night' / 'day' flights are at full weight. Outside them the weight is `OFF_HOURS_FACTOR`. */
export const NIGHT_HOURS: readonly [number, number] = [19, 6];
export const DAY_HOURS: readonly [number, number] = [6, 18];
export const OFF_HOURS_FACTOR = 0.1;

function inWindow(hour: number, [from, to]: readonly [number, number]): boolean {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Weight of an entry at a local hour (undefined hour = full weight). */
export function entryWeight(e: AirlineEntry, localHour?: number): number {
  if (localHour === undefined || !e.hours || e.hours === 'any') return e.weight;
  return inWindow(localHour, e.hours === 'night' ? NIGHT_HOURS : DAY_HOURS) ? e.weight : e.weight * OFF_HOURS_FACTOR;
}

const dest = (icao: string, ...altitudesFt: number[]): RouteDestination => ({ icao, altitudesFt });

// ---------------------------------------------------------------------------
// KACY: unchanged behaviour
// ---------------------------------------------------------------------------

const KACY: AirportTrafficProfile = {
  icao: 'KACY',
  airlines: [
    { icao3: 'NKS', telephony: 'Spirit', types: ['A320'], weight: 80, destinations: [], flightNumbers: [100, 1499] },
    { icao3: 'AAL', telephony: 'American', types: ['A320'], weight: 20, destinations: [], flightNumbers: [100, 2999] },
  ],
  neighbours: {
    KPHL: { name: 'Philadelphia', lat: 39.872, lon: -75.241, spoken: 'Philadelphia' },
    KTEB: { name: 'Teterboro', lat: 40.85, lon: -74.061, spoken: 'Teterboro' },
    KWWD: { name: 'Cape May', lat: 38.999, lon: -74.908, spoken: 'Wildwood' },
    KMIV: { name: 'Millville', lat: 39.368, lon: -75.073, spoken: 'Millville' },
    '26N': { name: 'Ocean City', lat: 39.266, lon: -74.6, spoken: 'Ocean City' },
  },
  gaTypes: [['C172', 1]],
  referenceJet: 'A320',
};

// ---------------------------------------------------------------------------
// KMHT: Manchester-Boston Regional
// ---------------------------------------------------------------------------

const KMHT: AirportTrafficProfile = {
  icao: 'KMHT',
  airlines: [
    // Southwest: B737-700/-800/MAX 8 flown as the B738 (Baltimore, Chicago Midway, Nashville, Orlando, seasonal Tampa).
    { icao3: 'SWA', telephony: 'Southwest', types: ['B738'], weight: 34, flightNumbers: [100, 2999],
      destinations: [dest('KBWI', 16000, 18000), dest('KMDW', 28000, 30000, 32000), dest('KBNA', 30000, 32000, 34000), dest('KMCO', 32000, 34000, 36000), dest('KTPA', 32000, 34000, 36000)] },
    // Breeze Airways "Moxy": A220-300 (ICAO BCS3) to Charleston, Fort Myers, Myrtle Beach, Raleigh-Durham, Tampa, Orlando.
    { icao3: 'MXY', telephony: 'Moxy', types: ['BCS3'], weight: 15, flightNumbers: [100, 999],
      destinations: [dest('KCHS', 30000, 32000, 34000), dest('KRSW', 32000, 34000, 36000), dest('KMYR', 28000, 30000, 32000), dest('KRDU', 26000, 28000, 30000), dest('KTPA', 32000, 34000, 36000), dest('KMCO', 32000, 34000, 36000)] },
    // American Eagle regionals: PSA "Blue Streak" CRJ-900, Piedmont E175, Republic "Brickyard" E175 (also United Express to Dulles).
    { icao3: 'JIA', telephony: 'Blue Streak', types: ['CRJ9'], weight: 9, flightNumbers: [4300, 5999],
      destinations: [dest('KCLT', 30000, 32000, 34000), dest('KPHL', 20000, 22000, 24000), dest('KDCA', 22000, 24000, 26000)] },
    { icao3: 'PDT', telephony: 'Piedmont', types: ['E175'], weight: 8, flightNumbers: [4200, 6199],
      destinations: [dest('KCLT', 30000, 32000, 34000), dest('KPHL', 20000, 22000, 24000), dest('KDCA', 22000, 24000, 26000)] },
    { icao3: 'RPA', telephony: 'Brickyard', types: ['E175'], weight: 11, flightNumbers: [4300, 6499],
      destinations: [dest('KCLT', 30000, 32000, 34000), dest('KPHL', 20000, 22000, 24000), dest('KDCA', 22000, 24000, 26000), dest('KORD', 30000, 32000, 34000), dest('KIAD', 22000, 24000, 26000)] },
    // American mainline A320 (Charlotte), occasional.
    { icao3: 'AAL', telephony: 'American', types: ['A320'], weight: 5, flightNumbers: [1000, 2999],
      destinations: [dest('KCLT', 30000, 32000, 34000)] },
    // United Express to Washington Dulles: SkyWest, GoJet "Lindbergh".
    { icao3: 'SKW', telephony: 'SkyWest', types: ['E175'], weight: 4, flightNumbers: [3000, 6999], destinations: [dest('KIAD', 22000, 24000, 26000)] },
    { icao3: 'GJS', telephony: 'Lindbergh', types: ['CRJ9'], weight: 3, flightNumbers: [3000, 6999], destinations: [dest('KIAD', 22000, 24000, 26000)] },
    // Cargo: UPS and FedEx B757-200 mostly evening and night.
    { icao3: 'UPS', telephony: 'UPS', types: ['B752'], weight: 4, flightNumbers: [100, 999], hours: 'night', destinations: [dest('KSDF', 28000, 30000, 32000)] },
    { icao3: 'FDX', telephony: 'FedEx', types: ['B752'], weight: 3, flightNumbers: [100, 999], hours: 'night', destinations: [dest('KMEM', 30000, 32000, 34000)] },
    // Wiggins Airways Cessna 208 Caravan feeder flights by day (destination is an ESTIMATE).
    { icao3: 'WIG', telephony: 'Wiggins', types: ['C208'], weight: 3, flightNumbers: [100, 899], hours: 'day', destinations: [dest('KPWM', 8000, 10000)] },
    // Sun Country charters, rare.
    { icao3: 'SCX', telephony: 'Sun Country', types: ['B738'], weight: 1, flightNumbers: [100, 999], destinations: [dest('KMYR', 28000, 30000, 32000), dest('KMCO', 32000, 34000, 36000)] },
  ],
  neighbours: {
    KASH: { name: 'Nashua', lat: 42.78, lon: -71.51, spoken: 'Nashua' },
    KCON: { name: 'Concord', lat: 43.2, lon: -71.5, spoken: 'Concord' },
    KLCI: { name: 'Laconia', lat: 43.57, lon: -71.42, spoken: 'Laconia' },
    KPSM: { name: 'Portsmouth', lat: 43.08, lon: -70.82, spoken: 'Portsmouth' },
    KLWM: { name: 'Lawrence', lat: 42.72, lon: -71.12, spoken: 'Lawrence' },
    KBVY: { name: 'Beverly', lat: 42.58, lon: -70.92, spoken: 'Beverly' },
    KEEN: { name: 'Keene', lat: 42.9, lon: -72.27, spoken: 'Keene' },
    KBED: { name: 'Hanscom', lat: 42.47, lon: -71.29, spoken: 'Bedford' },
    KPWM: { name: 'Portland', lat: 43.65, lon: -70.31, spoken: 'Portland' },
    KBOS: { name: 'Boston', lat: 42.36, lon: -71.01, spoken: 'Boston' },
    KFIT: { name: 'Fitchburg', lat: 42.55, lon: -71.76, spoken: 'Fitchburg' },
  },
  gaRemote: ['KASH', 'KCON', 'KLCI', 'KPSM', 'KLWM', 'KBVY', 'KEEN', 'KBED', 'KFIT'],
  gaTypes: [['C172', 0.75], ['PA28', 0.25]],
  referenceJet: 'B738',
};

const PROFILES: Readonly<Record<string, AirportTrafficProfile>> = { KACY, KMHT };

/** The traffic profile of an airport (unknown ICAO: KACY's). */
export function profileFor(icao: string | undefined): AirportTrafficProfile {
  return (icao && PROFILES[icao.toUpperCase()]) || KACY;
}

/** Every neighbour of every profile, for lookups that name an airport without a session airport (KACY first). */
export function findNeighbour(icao: string | undefined, id: string): Neighbour | undefined {
  const own = profileFor(icao).neighbours[id];
  if (own) return own;
  for (const p of Object.values(PROFILES)) if (p.neighbours[id]) return p.neighbours[id];
  return undefined;
}

// ---------------------------------------------------------------------------
// Picking flights
// ---------------------------------------------------------------------------

export interface PickFlightOptions {
  /** Only these types may be generated (the setup screen's selection); an entry survives when it operates at least one. */
  allowedTypes?: ReadonlySet<string> | readonly string[];
  /** Local hour at the airport (0..24), for the day/night banks. Unset: full weight everywhere. */
  localHour?: number;
}

export interface Flight {
  callsign: string;
  type: string;
  /** The airline entry; undefined for a GA flight. */
  entry?: AirlineEntry;
}

/** The profile's airline entries that operate at least one allowed type. */
export function usableAirlines(profile: AirportTrafficProfile, allowed?: ReadonlySet<string> | readonly string[]): AirlineEntry[] {
  if (!allowed) return [...profile.airlines];
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  return profile.airlines.filter((e) => e.types.some((t) => set.has(t)));
}

/**
 * Weighted pick of an airline flight: callsign and aircraft type. KACY consumes exactly the random numbers it always did
 * (one for the airline, one for the flight number; a single-type entry draws nothing for the type).
 * Returns undefined when no entry operates an allowed type.
 */
export function pickFlight(rng: () => number, icao: string | undefined, o: PickFlightOptions = {}): Flight | undefined {
  const profile = profileFor(icao);
  const pool = usableAirlines(profile, o.allowedTypes);
  if (!pool.length) return undefined;
  const weights = pool.map((e) => entryWeight(e, o.localHour));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  let entry = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r < 0) {
      entry = pool[i];
      break;
    }
  }
  const [lo, hi] = entry.flightNumbers;
  const num = lo + Math.floor(rng() * (hi - lo + 1));
  const allowedSet = o.allowedTypes ? (o.allowedTypes instanceof Set ? o.allowedTypes : new Set(o.allowedTypes)) : undefined;
  const types = allowedSet ? entry.types.filter((t) => allowedSet.has(t)) : entry.types;
  const type = types.length > 1 ? types[Math.min(types.length - 1, Math.floor(rng() * types.length))] : types[0];
  return { callsign: `${entry.icao3}${num}`, type, entry };
}

/** Weighted pick of a GA type variant (KACY: always C172, no random number drawn). */
export function pickGaType(rng: () => number, icao: string | undefined): string {
  const list = profileFor(icao).gaTypes;
  if (list.length === 1) return list[0][0];
  const total = list.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [t, w] of list) {
    r -= w;
    if (r < 0) return t;
  }
  return list[list.length - 1][0];
}

/** A flight-plan destination and cruise altitude from an airline entry; undefined when the entry uses the airport's legacy list. */
export function pickRoute(rng: () => number, entry: AirlineEntry): { destination: string; cruiseAltitudeFt: number } | undefined {
  if (!entry.destinations.length) return undefined;
  const d = entry.destinations[Math.min(entry.destinations.length - 1, Math.floor(rng() * entry.destinations.length))];
  const alts = d.altitudesFt;
  return { destination: d.icao, cruiseAltitudeFt: alts[Math.min(alts.length - 1, Math.floor(rng() * alts.length))] };
}

/** A neighbouring airfield for generated VFR traffic, or undefined at airports that keep the legacy origin list. */
export function pickGaRemote(rng: () => number, icao: string | undefined): string | undefined {
  const list = profileFor(icao).gaRemote;
  if (!list?.length) return undefined;
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/** Union of the destinations every airline of the profile files to (first listing wins for the cruise altitudes). */
export function profileDestinations(profile: AirportTrafficProfile): RouteDestination[] {
  const seen = new Map<string, RouteDestination>();
  for (const e of profile.airlines) for (const d of e.destinations) if (!seen.has(d.icao)) seen.set(d.icao, d);
  return [...seen.values()];
}

/** Types that park at the cargo apron when the airport has one. */
export const CARGO_TYPES: ReadonlySet<string> = new Set(['B752', 'B763', 'A306']);
/** Telephony designators that are cargo operators (their arrivals taxi to the cargo apron). */
export const CARGO_PREFIXES: ReadonlySet<string> = new Set(['UPS', 'FDX']);

/** What the other end of a generated flight is: filed destination + cruise (airline legs) and the airfield stamped on the spawn. */
export interface Leg {
  destination?: string;
  cruiseAltitudeFt?: number;
  /** `ScenarioAircraftSpawn.remoteAirport`: undefined keeps the engine's legacy origin/destination pick (KACY). */
  remoteAirport?: string;
}

/** Picks the far end of a flight: a route of the airline entry, or a neighbouring airfield for GA. Draws no random number when the profile has none. */
export function pickLeg(rng: () => number, icao: string | undefined, flight: Flight): Leg {
  if (!flight.entry) {
    const remoteAirport = pickGaRemote(rng, icao);
    return remoteAirport ? { remoteAirport } : {};
  }
  const route = pickRoute(rng, flight.entry);
  return route ? { ...route, remoteAirport: route.destination } : {};
}

/**
 * The aircraft-type selection of the setup screen resolved against a profile. 'C172' (or any GA variant of the profile) stands for GA;
 * an airline type counts when some entry operates it. A selection that allows nothing at this airport means "everything" (as it always has).
 */
export function resolveTypeSelection(icao: string | undefined, requested?: readonly string[]): { allowed?: ReadonlySet<string>; ga: boolean; jets: boolean } {
  const profile = profileFor(icao);
  if (!requested?.length) return { ga: true, jets: true };
  const set = new Set(requested);
  const ga = profile.gaTypes.some(([t]) => set.has(t));
  const jets = usableAirlines(profile, set).length > 0;
  if (!ga && !jets) return { ga: true, jets: true };
  return { allowed: set, ga, jets };
}

/** Every type the profile can generate, GA token first: the free-play default selection. KACY: ['C172', 'A320']. */
export function profileTypes(icao: string | undefined): string[] {
  const p = profileFor(icao);
  return [...new Set(['C172', ...p.airlines.flatMap((e) => e.types)])];
}
