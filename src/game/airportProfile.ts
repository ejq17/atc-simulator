/**
 * Airport traffic profiles: what the generated traffic at an airport looks like (airlines and their equipment, where they fly, which
 * neighbouring airfields VFR traffic comes from). Keyed by ICAO; unknown airports use the KACY profile.
 *
 * Gameplay data, not aeronautical data. KACY keeps exactly the behaviour it had before profiles existed: Spirit 80 % / American 20 %,
 * A320 only, the short-hop destinations of ifr.ts and the old neighbour table. KMHT mirrors the airlines serving Manchester-Boston
 * Regional per flymanchester.com "Airlines serving MHT" (checked 2026-10-17); KPHL per phl.org "Our Airlines" (2026-10-21); weights are a gameplay mix, not traffic statistics.
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

/** Annual operations by category as the national statistics return them (data/sources/traffic-volumes.json carries the same figures with their provenance). */
export interface TrafficVolumes {
  source: 'FAA ATADS' | 'UK CAA';
  year: number;
  retrieved: string;
  /** ATADS "AirCarrier" (UK CAA: air transport movements). */
  airCarrier: number;
  airTaxi: number;
  /** General aviation itinerant (UK CAA: private + aero club + business aviation). */
  gaItinerant: number;
  militaryItinerant: number;
  /** Local operations (aircraft staying in the traffic pattern or practice area): pattern work. */
  localCivil: number;
  localMilitary: number;
  total: number;
}

/** What free play starts with at the airport; the setup screen shows these and the player can override each. */
export interface TrafficDefaults {
  /** Share (0..1) of generated flights that are general aviation (the rest are airline flights). */
  gaFraction: number;
  /** Closed traffic allowed: GA pilots may ask for the option / to stay in the pattern, training flights fly circuits. False at hubs with no local operations. */
  patternWork: boolean;
  /** Peak-hour arrivals / departures (DESIGN VALUE derived from `volumes`); undefined = the generic free-play rates (START_PROFILE). */
  peakArrivalsPerHour?: number;
  peakDeparturesPerHour?: number;
  /** The generator keeps the GA / airline draw of a due flight until it is created (see `createTrafficGenerator`); unset for KACY and KMHT, whose seeded behaviour stays as tuned. */
  keepKindOnRetry?: boolean;
}

export interface AirportTrafficProfile {
  icao: string;
  volumes: TrafficVolumes;
  defaults: TrafficDefaults;
  airlines: readonly AirlineEntry[];
  /** VFR neighbours: approximate reference coordinates (~0.01 deg is plenty for choosing an inbound bearing). */
  neighbours: Readonly<Record<string, Neighbour>>;
  /**
   * Neighbours that generated GA traffic comes from / goes to (stamped on spawns as `remoteAirport`). Undefined = the engine's own
   * legacy origin list (KACY).
   */
  gaRemote?: readonly string[];
  /** GA type variants chosen with the 'C172' selection of the setup screen: [type, weight]. Empty = no GA traffic at the airport (EGLL). */
  gaTypes: readonly (readonly [string, number])[];
  /** Representative jet used to pick runways that "jets can use" (free play). */
  referenceJet: string;
  /**
   * Special traffic (specialTraffic.ts). A kind is present only when the airport has it for a documented reason (data/sources/README.md
   * "Traffic variety"); rates are design values at the peak bank, scaled by the free-play density curve like the airline rates.
   */
  special?: SpecialTrafficProfile;
}

export interface SpecialTrafficProfile {
  /** USCG MH-65 operations from the airport's helipads (parking category 'military', ids starting with `padPrefix`). */
  helicopter?: { perHour: number; padPrefix: string };
  /** Military fighters from a military ramp (parking ids starting with `rampPrefix`); `formationShare` of the sorties fly as a flight of two. */
  military?: { perHour: number; rampPrefix: string; formationShare: number };
  /** VFR aircraft crossing the Class C area on a transition (7110.65 7-8). */
  transition?: { perHour: number };
  /** Share (0..1) of generated GA flights that are flight-training pattern work. */
  training?: { gaShare: number };
  /** Airport vehicles asking for runway / taxiway access. */
  vehicles?: { perHour: number };
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
  // FAA ATADS calendar year 2025, retrieved 2026-10-22 (https://www.aspm.faa.gov/opsnet/sys/Airport.asp; data/sources/traffic-volumes.json).
  volumes: { source: 'FAA ATADS', year: 2025, retrieved: '2026-10-22', airCarrier: 6306, airTaxi: 4156, gaItinerant: 14394, militaryItinerant: 9590, localCivil: 9282, localMilitary: 7225, total: 50953 },
  // Unchanged behaviour: the 50 % GA share and the START_PROFILE rates are what this airport was tuned to (ATADS 2025 GA, itinerant + local, is 23,676 of 50,953 operations = 46.5 %, docs/DESIGN-VALUES.md).
  defaults: { gaFraction: 0.5, patternWork: true },
  // Existence: NJ ANG 177th Fighter Wing (F-16C) and Coast Guard Air Station Atlantic City (helipads USCG-1..4 from OSM), Class C airport (NASR);
  // FAA ops frequency 123.4 and ANG ops 140.7 are in the dataset. Rates are design values.
  special: {
    helicopter: { perHour: 2, padPrefix: 'USCG-' },
    military: { perHour: 2, rampPrefix: 'ANG-', formationShare: 0.5 },
    transition: { perHour: 4 },
    training: { gaShare: 0.4 },
    vehicles: { perHour: 3 },
  },
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
  // FAA ATADS calendar year 2025, retrieved 2026-10-22 (https://www.aspm.faa.gov/opsnet/sys/Airport.asp; data/sources/traffic-volumes.json).
  volumes: { source: 'FAA ATADS', year: 2025, retrieved: '2026-10-22', airCarrier: 18008, airTaxi: 11640, gaItinerant: 10991, militaryItinerant: 409, localCivil: 2725, localMilitary: 142, total: 43915 },
  // Unchanged behaviour: the 50 % GA share and the START_PROFILE rates are what this airport was tuned to (ATADS 2025 GA, itinerant + local, is 13,716 of 43,915 operations = 31.2 %, docs/DESIGN-VALUES.md).
  defaults: { gaFraction: 0.5, patternWork: true },
  // KMHT is a Class C airport (NASR) so VFR transitions apply; vehicles exist at every towered airport. No USCG or ANG unit, no flight-training
  // source: those kinds are left out (data/sources/README.md "Traffic variety").
  special: {
    transition: { perHour: 4 },
    vehicles: { perHour: 3 },
  },
};

// ---------------------------------------------------------------------------
// KBOS: General Edward Lawrence Logan International
// ---------------------------------------------------------------------------

/**
 * Sources: carrier shares of 2024 passengers (JetBlue ~27 %, Delta 22 %, American 14 %, United 11 %, Spirit 6 %, Southwest 4 %) from the
 * Road Genius aggregator page https://roadgenius.com/statistics/airports/usa/logan-bos-airport/ (secondary source, retrieved 2026-10-21; the
 * Boston Globe of 2025-03-20 calls JetBlue and Delta neck and neck); JetBlue focus city and Delta hub as stated in the task. Massport's
 * own airline page lists no airlines in its text and its page "nonstop international destinations" (retrieved 2026-10-21) lists 57
 * destinations without carriers; the international legs below are taken from that list (London, Frankfurt, Paris, Dublin, Amsterdam). Telephony
 * words: FAA JO 7340.2 chapter 3 section 1 (retrieved 2026-10-21). NOT SOURCED: the aircraft type each carrier uses at BOS (ESTIMATE from
 * the performance table's types), the regional carriers operating for Delta / American / United, the cargo carriers and the cruise altitudes
 * (DESIGN VALUE). Weights are a gameplay mix, not traffic statistics.
 */
const KBOS: AirportTrafficProfile = {
  icao: 'KBOS',
  airlines: [
    { icao3: 'JBU', telephony: 'JetBlue', types: ['A320', 'A321', 'E190', 'BCS3'], weight: 27, flightNumbers: [100, 2999],
      destinations: [dest('KJFK', 14000, 16000), dest('KDCA', 22000, 24000), dest('KMCO', 32000, 34000, 36000), dest('KFLL', 32000, 34000, 36000), dest('KTPA', 32000, 34000, 36000), dest('KRDU', 26000, 28000, 30000)] },
    { icao3: 'DAL', telephony: 'Delta', types: ['A321', 'B738', 'A319'], weight: 16, flightNumbers: [100, 2999],
      destinations: [dest('KATL', 32000, 34000, 36000), dest('KDTW', 28000, 30000, 32000), dest('KLGA', 12000, 14000), dest('KMCO', 32000, 34000, 36000), dest('KMIA', 32000, 34000, 36000)] },
    { icao3: 'DAL', telephony: 'Delta', types: ['B763', 'A333'], weight: 2, flightNumbers: [100, 499], destinations: [dest('EGLL', 34000, 36000, 38000), dest('EDDF', 34000, 36000, 38000)] },
    { icao3: 'SKW', telephony: 'SkyWest', types: ['E175', 'CRJ7', 'CRJ9'], weight: 4, flightNumbers: [3000, 6999], destinations: [dest('KDTW', 28000, 30000, 32000), dest('KLGA', 12000, 14000), dest('KPIT', 24000, 26000)] },
    { icao3: 'AAL', telephony: 'American', types: ['A321', 'A319', 'B738'], weight: 10, flightNumbers: [100, 2999],
      destinations: [dest('KCLT', 30000, 32000, 34000), dest('KORD', 30000, 32000, 34000), dest('KMIA', 32000, 34000, 36000), dest('KPHL', 20000, 22000, 24000), dest('KDCA', 22000, 24000, 26000)] },
    { icao3: 'RPA', telephony: 'Brickyard', types: ['E175'], weight: 4, flightNumbers: [4300, 6499], destinations: [dest('KPHL', 20000, 22000, 24000), dest('KDCA', 22000, 24000, 26000), dest('KCLT', 30000, 32000, 34000)] },
    { icao3: 'UAL', telephony: 'United', types: ['B738', 'A320', 'B739'], weight: 8, flightNumbers: [100, 2999],
      destinations: [dest('KEWR', 14000, 16000), dest('KORD', 30000, 32000, 34000), dest('KIAD', 22000, 24000, 26000)] },
    { icao3: 'NKS', telephony: 'Spirit', types: ['A320', 'A21N'], weight: 5, flightNumbers: [100, 1499], destinations: [dest('KFLL', 32000, 34000, 36000), dest('KMCO', 32000, 34000, 36000), dest('KDTW', 28000, 30000, 32000)] },
    { icao3: 'SWA', telephony: 'Southwest', types: ['B738', 'B38M'], weight: 4, flightNumbers: [100, 2999], destinations: [dest('KBWI', 16000, 18000), dest('KMDW', 28000, 30000, 32000), dest('KBNA', 30000, 32000, 34000)] },
    { icao3: 'KAP', telephony: 'Cair', types: ['C402'], weight: 2, flightNumbers: [100, 999], hours: 'day', destinations: [dest('KHYA', 4000, 6000), dest('KPVC', 4000, 6000)] },
    { icao3: 'BAW', telephony: 'Speedbird', types: ['B772', 'B789', 'A35K'], weight: 2, flightNumbers: [200, 299], destinations: [dest('EGLL', 34000, 36000, 38000)] },
    { icao3: 'DLH', telephony: 'Lufthansa', types: ['A333', 'A359'], weight: 1, flightNumbers: [400, 499], destinations: [dest('EDDF', 34000, 36000, 38000)] },
    { icao3: 'AFR', telephony: 'Airfrans', types: ['A359', 'B77W'], weight: 1, flightNumbers: [300, 399], destinations: [dest('LFPG', 34000, 36000, 38000)] },
    { icao3: 'EIN', telephony: 'Shamrock', types: ['A332', 'A321'], weight: 1, flightNumbers: [100, 199], destinations: [dest('EIDW', 34000, 36000, 38000)] },
    { icao3: 'FDX', telephony: 'FedEx', types: ['B763', 'MD11'], weight: 2, flightNumbers: [100, 999], hours: 'night', destinations: [dest('KMEM', 30000, 32000, 34000)] },
    { icao3: 'UPS', telephony: 'UPS', types: ['B763', 'B752'], weight: 2, flightNumbers: [100, 999], hours: 'night', destinations: [dest('KSDF', 28000, 30000, 32000)] },
  ],
  neighbours: {
    KBED: { name: 'Hanscom', lat: 42.46994444, lon: -71.289, spoken: 'Bedford' },
    KOWD: { name: 'Norwood', lat: 42.19052027, lon: -71.17293083, spoken: 'Norwood' },
    KBVY: { name: 'Beverly', lat: 42.58414138, lon: -70.91614444, spoken: 'Beverly' },
    KLWM: { name: 'Lawrence', lat: 42.71704222, lon: -71.12353333, spoken: 'Lawrence' },
    KPYM: { name: 'Plymouth', lat: 41.90878833, lon: -70.72762805, spoken: 'Plymouth' },
    KORH: { name: 'Worcester', lat: 42.26713888, lon: -71.87561111, spoken: 'Worcester' },
    KFIT: { name: 'Fitchburg', lat: 42.55384722, lon: -71.75917388, spoken: 'Fitchburg' },
    KPSM: { name: 'Portsmouth', lat: 43.07794444, lon: -70.82327777, spoken: 'Portsmouth' },
    KHYA: { name: 'Hyannis', lat: 41.66933722, lon: -70.28035916, spoken: 'Hyannis' },
    KPVC: { name: 'Provincetown', lat: 42.07227777, lon: -70.22072222, spoken: 'Provincetown' },
  },
  gaRemote: ['KBED', 'KOWD', 'KBVY', 'KLWM', 'KPYM', 'KORH', 'KFIT', 'KPSM'],
  gaTypes: [['C172', 0.75], ['PA28', 0.25]],
  referenceJet: 'A320',
  // FAA ATADS calendar year 2025, retrieved 2026-10-22 (https://www.aspm.faa.gov/opsnet/sys/Airport.asp; data/sources/traffic-volumes.json).
  volumes: { source: 'FAA ATADS', year: 2025, retrieved: '2026-10-22', airCarrier: 350190, airTaxi: 60940, gaItinerant: 7753, militaryItinerant: 199, localCivil: 0, localMilitary: 0, total: 419082 },
  // gaFraction = GA itinerant / (air carrier + air taxi + GA itinerant) = 7,753 / 418,883; no local operations are counted, so no pattern work.
  // Peak-hour arrivals and departures: DESIGN VALUE, 419,082 / 365 / 13.25 (density-curve day integral) / 2.
  defaults: { gaFraction: 0.019, patternWork: false, peakArrivalsPerHour: 43, peakDeparturesPerHour: 43, keepKindOnRetry: true },
  // Boston is Class B (NASR CLS_ARSP): VFR transitions need an ATC clearance and are rare, so a low design rate; airport vehicles exist at every
  // towered airport. No USCG or ANG unit was sourced (data/sources/README.md "Traffic variety").
  special: {
    transition: { perHour: 1 },
    vehicles: { perHour: 3 },
  },
};

// ---------------------------------------------------------------------------
// KPHL: Philadelphia International
// ---------------------------------------------------------------------------
// Airlines: the carriers phl.org lists on "Our Airlines" (https://www.phl.org/about/airlines, read 2026-10-21; copy in data/sources/raw/kphl_traffic/):
// Aer Lingus, Aeromexico, Air Canada, Alaska, Allegiant, American, American Eagle, British Airways, Delta, Frontier, JetBlue, Lufthansa /
// Eurowings Discover, Qatar, Southwest, Sun Country, United. Destinations: the Wikipedia "Philadelphia International Airport" airlines and
// destinations table (read 2026-10-21). Widebody international flights (Aer Lingus, BA, Lufthansa/Discover, Qatar, Aeromexico, American to
// Europe) are not generated: the parser knows no transatlantic destination. UPS Airlines is the PHL cargo operator named by Wikipedia ("regional cargo
// hub"; East Coast Region Air Hub in the UPS Airlines article; B767-300F / B757-200PF / A300-600F in its fleet table, March 2026); FedEx is not listed
// for PHL there, so there is no FedEx flight although OSM maps FedEx stands. Aircraft types: American (A319 126, A320 48, A321 203, A321neo 74, B738 303,
// B737 MAX 8 103 in service, June 2026), Frontier (A320neo, A321neo, A320ceo), PSA (CRJ700, CRJ900) and UPS come from the Wikipedia fleet tables;
// Delta, United, JetBlue, Alaska, Sun Country and Southwest use A320 / B738 as stand-ins (their fleets were not looked up). Weights are a gameplay mix,
// not traffic statistics.

const KPHL: AirportTrafficProfile = {
  icao: 'KPHL',
  airlines: [
    // American Airlines mainline (PHL hub), types repeated in proportion to the fleet.
    { icao3: 'AAL', telephony: 'American', types: ['A319', 'A319', 'A320', 'A321', 'A321', 'A321', 'A21N', 'B738', 'B738', 'B738', 'B738', 'B38M'], weight: 30, flightNumbers: [100, 2999],
      destinations: [dest('KCLT', 30000, 32000, 34000), dest('KORD', 30000, 32000, 34000), dest('KDFW', 32000, 34000, 36000), dest('KMIA', 32000, 34000, 36000), dest('KBOS', 20000, 22000, 24000), dest('KMCO', 32000, 34000, 36000), dest('KATL', 30000, 32000, 34000), dest('KPIT', 22000, 24000, 26000), dest('KDEN', 32000, 34000, 36000)] },
    // American Eagle regionals (PSA "Blue Streak" CRJ-900, Republic "Brickyard" and Envoy E175).
    { icao3: 'JIA', telephony: 'Blue Streak', types: ['CRJ9', 'CRJ7'], weight: 9, flightNumbers: [4300, 5999],
      destinations: [dest('KPIT', 22000, 24000, 26000), dest('KDCA', 22000, 24000, 26000), dest('KBOS', 20000, 22000, 24000), dest('KRDU', 26000, 28000, 30000), dest('KDTW', 28000, 30000, 32000)] },
    { icao3: 'RPA', telephony: 'Brickyard', types: ['E175'], weight: 10, flightNumbers: [4300, 6499],
      destinations: [dest('KBNA', 28000, 30000, 32000), dest('KMEM', 30000, 32000, 34000), dest('KSDF', 26000, 28000, 30000), dest('KMHT', 20000, 22000, 24000), dest('KATL', 30000, 32000, 34000)] },
    { icao3: 'ENY', telephony: 'Envoy', types: ['E175'], weight: 8, flightNumbers: [3000, 4999],
      destinations: [dest('KPIT', 22000, 24000, 26000), dest('KDCA', 22000, 24000, 26000), dest('KBOS', 20000, 22000, 24000), dest('KDTW', 28000, 30000, 32000), dest('KRDU', 26000, 28000, 30000)] },
    // Southwest (B737): Chicago Midway, Denver, Nashville, Orlando, St. Louis, Baltimore.
    { icao3: 'SWA', telephony: 'Southwest', types: ['B738'], weight: 9, flightNumbers: [100, 2999],
      destinations: [dest('KMDW', 28000, 30000, 32000), dest('KDEN', 32000, 34000, 36000), dest('KBNA', 30000, 32000, 34000), dest('KMCO', 32000, 34000, 36000), dest('KSTL', 30000, 32000, 34000)] },
    // Frontier (A320 family): Atlanta, Charlotte, Chicago O'Hare, Denver, Dallas/Fort Worth, Orlando, Miami, Tampa.
    { icao3: 'FFT', telephony: 'Frontier', types: ['A20N', 'A20N', 'A21N', 'A320'], weight: 8, flightNumbers: [100, 2999],
      destinations: [dest('KATL', 30000, 32000, 34000), dest('KCLT', 30000, 32000, 34000), dest('KORD', 30000, 32000, 34000), dest('KDEN', 32000, 34000, 36000), dest('KMCO', 32000, 34000, 36000), dest('KMIA', 32000, 34000, 36000), dest('KTPA', 32000, 34000, 36000)] },
    // Delta: Atlanta, Detroit, Minneapolis/St. Paul, Salt Lake City.
    { icao3: 'DAL', telephony: 'Delta', types: ['A320', 'B738'], weight: 7, flightNumbers: [100, 2999],
      destinations: [dest('KATL', 30000, 32000, 34000), dest('KDTW', 28000, 30000, 32000), dest('KMSP', 32000, 34000, 36000), dest('KSLC', 34000, 36000, 38000)] },
    // United: Chicago O'Hare, Denver, Houston, San Francisco; United Express (SkyWest E175) to Houston and Dulles.
    { icao3: 'UAL', telephony: 'United', types: ['A320', 'B738'], weight: 5, flightNumbers: [100, 2999],
      destinations: [dest('KORD', 30000, 32000, 34000), dest('KDEN', 32000, 34000, 36000), dest('KIAH', 32000, 34000, 36000), dest('KSFO', 34000, 36000, 38000)] },
    { icao3: 'SKW', telephony: 'SkyWest', types: ['E175'], weight: 3, flightNumbers: [3000, 6999], destinations: [dest('KIAD', 22000, 24000, 26000), dest('KIAH', 32000, 34000, 36000)] },
    // JetBlue: Boston, Fort Lauderdale (and San Juan, not in the parser).
    { icao3: 'JBU', telephony: 'JetBlue', types: ['A320'], weight: 3, flightNumbers: [100, 2999],
      destinations: [dest('KBOS', 20000, 22000, 24000), dest('KFLL', 32000, 34000, 36000)] },
    // Alaska (Seattle) and Sun Country (Minneapolis, seasonal): rare.
    { icao3: 'ASA', telephony: 'Alaska', types: ['B738'], weight: 1, flightNumbers: [100, 2999], destinations: [dest('KSEA', 34000, 36000, 38000)] },
    { icao3: 'SCX', telephony: 'Sun Country', types: ['B738'], weight: 1, flightNumbers: [100, 999], destinations: [dest('KMSP', 32000, 34000, 36000)] },
    // UPS Airlines (regional cargo hub), mostly night. fleet B767-300F / B757-200PF / A300-600; the destination (Louisville, UPS's
    // national hub) is an ESTIMATE, the sources give no UPS route.
    { icao3: 'UPS', telephony: 'UPS', types: ['B763', 'B752', 'A306'], weight: 6, flightNumbers: [100, 999], hours: 'night', destinations: [dest('KSDF', 28000, 30000, 32000)] },
  ],
  // Neighbours: NASR ARP coordinates (APT_BASE.csv, 2026-10-01).
  neighbours: {
    KPNE: { name: 'Northeast Philadelphia', lat: 40.082, lon: -75.011, spoken: 'Northeast Philadelphia' },
    KLOM: { name: 'Wings Field', lat: 40.138, lon: -75.265, spoken: 'Wings Field' },
    KILG: { name: 'Wilmington', lat: 39.679, lon: -75.607, spoken: 'Wilmington' },
    KTTN: { name: 'Trenton', lat: 40.277, lon: -74.813, spoken: 'Trenton' },
    KVAY: { name: 'Mount Holly', lat: 39.943, lon: -74.846, spoken: 'Mount Holly' },
    KMIV: { name: 'Millville', lat: 39.368, lon: -75.072, spoken: 'Millville' },
    KMQS: { name: 'Coatesville', lat: 39.979, lon: -75.865, spoken: 'Coatesville' },
    KOQN: { name: 'Brandywine', lat: 39.99, lon: -75.582, spoken: 'Brandywine' },
    KDYL: { name: 'Doylestown', lat: 40.333, lon: -75.122, spoken: 'Doylestown' },
    KPTW: { name: 'Heritage Field', lat: 40.24, lon: -75.557, spoken: 'Heritage Field' },
    KABE: { name: 'Allentown', lat: 40.652, lon: -75.44, spoken: 'Allentown' },
  },
  gaRemote: ['KPNE', 'KLOM', 'KILG', 'KTTN', 'KVAY', 'KMIV', 'KMQS', 'KOQN', 'KDYL', 'KPTW'],
  gaTypes: [['C172', 0.75], ['PA28', 0.25]],
  referenceJet: 'A320',
  // FAA ATADS calendar year 2025, retrieved 2026-10-22 (https://www.aspm.faa.gov/opsnet/sys/Airport.asp; data/sources/traffic-volumes.json).
  volumes: { source: 'FAA ATADS', year: 2025, retrieved: '2026-10-22', airCarrier: 237832, airTaxi: 73921, gaItinerant: 10181, militaryItinerant: 165, localCivil: 0, localMilitary: 0, total: 322099 },
  // gaFraction = 10,181 / (237,832 + 73,921 + 10,181); no local operations. Peak: DESIGN VALUE, 322,099 / 365 / 13.25 / 2.
  defaults: { gaFraction: 0.032, patternWork: false, peakArrivalsPerHour: 33, peakDeparturesPerHour: 33, keepKindOnRetry: true },
  // KPHL is a Class B airport (NASR). The engine's VFR-transition flow is Class C service (7110.65 7-8); Class B transitions need an explicit
  // Class B clearance (7-9) that is not modelled, so there are none. Vehicles exist at every towered airport. No military or Coast Guard unit,
  // no flight-training source (data/sources/README.md "Traffic variety").
  special: {
    vehicles: { perHour: 3 },
  },
};

// ---------------------------------------------------------------------------
// KPGD: Punta Gorda Airport (Allegiant base)
// ---------------------------------------------------------------------------

/**
 * Sources (retrieved 2026-10-21): flypgd.com home page ("Sun Country and Allegiant provide low-cost, nonstop air service to more than 50
 * destinations"), flypgd.com/airlines/ (Allegiant destination list; Sun Country seasonal Minneapolis-St. Paul December to April) and
 * flypgd.com/destinations-map/ (50 airport codes). The airport pages name no aircraft types: the types come from the airlines' fleets
 * (Wikipedia, retrieved 2026-10-21: Allegiant A319-100 28, A320-200 79, 737 MAX 16; Sun Country 737-800 43, 737-900ER 3) and are UNVERIFIED
 * per route. The 737 MAX 200 is flown as B38M, the 737-800 / -900ER as B738. Weights are a gameplay mix (DESIGN VALUE): Allegiant dominates.
 * The destinations are a subset of the 50 codes with spoken names (src/radio/spoken.ts); which are served in a given season is not checked.
 */
const KPGD_DESTINATIONS: readonly RouteDestination[] = [dest('KABE', 32000, 34000, 36000), dest('KACY', 28000, 30000, 32000), dest('KALB', 32000, 34000, 36000), dest('KAVL', 28000, 30000, 32000), dest('KBNA', 30000, 32000, 34000), dest('KCVG', 32000, 34000, 36000), dest('KPVD', 34000, 36000, 38000), dest('KPIT', 32000, 34000, 36000), dest('KSDF', 30000, 32000, 34000), dest('KMDW', 34000, 36000, 38000), dest('KMCI', 34000, 36000, 38000), dest('KGRR', 34000, 36000, 38000), dest('KROC', 34000, 36000, 38000), dest('KSYR', 34000, 36000, 38000), dest('KTTN', 32000, 34000, 36000), dest('KIAD', 30000, 32000, 34000), dest('KPSM', 34000, 36000, 38000), dest('KLEX', 30000, 32000, 34000), dest('KCAK', 32000, 34000, 36000), dest('KTYS', 28000, 30000, 32000), dest('KMDT', 32000, 34000, 36000)];

const KPGD: AirportTrafficProfile = {
  icao: 'KPGD',
  airlines: [
    { icao3: 'AAY', telephony: 'Allegiant', types: ['A320', 'A319', 'B38M'], weight: 92, flightNumbers: [100, 1999], destinations: KPGD_DESTINATIONS },
    { icao3: 'SCX', telephony: 'Sun Country', types: ['B738'], weight: 8, flightNumbers: [100, 999], destinations: [dest('KMSP', 34000, 36000, 38000)] },
  ],
  // Reference coordinates: NASR APT_BASE ARP of each airport (2026-10-01).
  neighbours: {
    KFMY: { name: 'Page Field', lat: 26.587, lon: -81.863, spoken: 'Page Field' },
    KVNC: { name: 'Venice', lat: 27.071, lon: -82.44, spoken: 'Venice' },
    KSRQ: { name: 'Sarasota', lat: 27.395, lon: -82.554, spoken: 'Sarasota' },
    KAPF: { name: 'Naples', lat: 26.152, lon: -81.776, spoken: 'Naples' },
    KIMM: { name: 'Immokalee', lat: 26.434, lon: -81.4, spoken: 'Immokalee' },
    KLAL: { name: 'Lakeland', lat: 27.988, lon: -82.019, spoken: 'Lakeland' },
  },
  gaRemote: ['KFMY', 'KVNC', 'KSRQ', 'KAPF', 'KIMM', 'KLAL'],
  gaTypes: [['C172', 0.75], ['PA28', 0.25]],
  referenceJet: 'A320',
  // FAA ATADS calendar year 2025, retrieved 2026-10-22 (https://www.aspm.faa.gov/opsnet/sys/Airport.asp; data/sources/traffic-volumes.json).
  volumes: { source: 'FAA ATADS', year: 2025, retrieved: '2026-10-22', airCarrier: 13258, airTaxi: 2034, gaItinerant: 61942, militaryItinerant: 376, localCivil: 55011, localMilitary: 226, total: 132847 },
  // gaFraction = GA itinerant / (air carrier + air taxi + GA itinerant) = 61,942 / 77,234. The 55,011 civil local operations are the pattern work
  // (flight training share below). Peak: DESIGN VALUE, itinerant 77,610 / 365 / 13.25 / 2.
  defaults: { gaFraction: 0.802, patternWork: true, peakArrivalsPerHour: 8, peakDeparturesPerHour: 8, keepKindOnRetry: true },
  // Class D (NASR CLS_ARSP): VFR transitions (JO 7110.65 7-6) and vehicles. Flight training: ATADS counts 55,011 civil local operations at PGD
  // in 2025 (pattern work and practice), 41 % of all its operations; no flight school is named by a source, the share is a conversion of that count.
  special: {
    transition: { perHour: 3 },
    // 55,011 civil local operations in ATADS 2025 against 61,942 itinerant GA operations: a training flight flies 2 to 4 circuits (trainingCircuits),
    // about 6 local operations each, so 55,011 / 6 = 9,170 flights against 61,942 / 2 = 30,970 GA arrivals = 0.30. DESIGN VALUE conversion.
    training: { gaShare: 0.3 },
    vehicles: { perHour: 3 },
  },
};


// ---------------------------------------------------------------------------
// EGLL: London Heathrow
// ---------------------------------------------------------------------------

/**
 * Airlines: heathrow.com "Airline contact information" (https://www.heathrow.com/airline-contact-info, retrieved 2026-10-21) lists ~90 carriers; British
 * Airways is dominant, then Virgin Atlantic, then the main European and long-haul carriers. Aircraft types: British Airways from its own "Fleet facts"
 * page (A319, A320 / A320neo, A321 / A321neo, A350-1000, A380-800, 777-200 and -300, 787-8 / -9 / -10, E190 of BA CityFlyer - not generated);
 * Virgin Atlantic from its 2024 fleet press release (A330-900, A350-1000, 787-9; the A330-300 is being retired). The types of the other carriers and
 * every weight and destination are ESTIMATEs / DESIGN VALUES (no operator source read for them). Telephony: ICAO Doc 8585 as listed in FAA JO 7340.2P
 * chapter 3 (SPEEDBIRD, VIRGIN, SHAMROCK, LUFTHANSA, EMIRATES, AMERICAN, DELTA, UNITED). Light aircraft are not permitted (AD 2.20 para 1):
 * no GA, no VFR neighbours; airport vehicles exist.
 */
const EGLL: AirportTrafficProfile = {
  icao: 'EGLL',
  airlines: [
    { icao3: 'BAW', telephony: 'Speedbird', types: ['A319', 'A320', 'A321', 'A20N', 'A21N'], weight: 32, flightNumbers: [1, 999],
      destinations: [dest('LFPG', 24000, 28000), dest('EHAM', 24000, 28000), dest('EDDF', 28000, 32000), dest('EIDW', 24000, 28000), dest('LEMD', 32000, 36000)] },
    { icao3: 'BAW', telephony: 'Speedbird', types: ['A35K', 'B772', 'B77W', 'B788', 'B789', 'A388'], weight: 24, flightNumbers: [1, 299],
      destinations: [dest('KJFK', 34000, 36000, 38000), dest('KBOS', 34000, 36000, 38000), dest('KORD', 34000, 36000, 38000), dest('OMDB', 36000, 38000, 40000)] },
    { icao3: 'VIR', telephony: 'Virgin', types: ['A339', 'A35K', 'B789'], weight: 8, flightNumbers: [1, 399],
      destinations: [dest('KJFK', 34000, 36000, 38000), dest('KBOS', 34000, 36000, 38000)] },
    { icao3: 'EIN', telephony: 'Shamrock', types: ['A320', 'A321'], weight: 4, flightNumbers: [100, 999], destinations: [dest('EIDW', 24000, 28000)] },
    { icao3: 'DLH', telephony: 'Lufthansa', types: ['A320', 'A321'], weight: 4, flightNumbers: [900, 999], destinations: [dest('EDDF', 28000, 32000)] },
    { icao3: 'UAE', telephony: 'Emirates', types: ['A388', 'B77W'], weight: 3, flightNumbers: [1, 99], destinations: [dest('OMDB', 36000, 38000, 40000)] },
    { icao3: 'AAL', telephony: 'American', types: ['B772'], weight: 2, flightNumbers: [50, 99], destinations: [dest('KORD', 34000, 36000, 38000)] },
    { icao3: 'DAL', telephony: 'Delta', types: ['A333'], weight: 2, flightNumbers: [1, 99], destinations: [dest('KJFK', 34000, 36000, 38000)] },
    { icao3: 'UAL', telephony: 'United', types: ['B772'], weight: 2, flightNumbers: [900, 999], destinations: [dest('KORD', 34000, 36000, 38000)] },
  ],
  neighbours: {},
  gaTypes: [],
  referenceJet: 'A320',
  // UK CAA UK Airport Data 2025 table 03.1 (https://www.caa.co.uk/data-and-analysis/uk-aviation-market/airports/uk-airport-data/uk-airport-data-2025/annual-2025/,
  // retrieved 2026-10-22): 479,996 movements, 477,917 air transport, 47 air taxi, 310 private, 2 military. Light aircraft are not permitted (AD 2.20).
  volumes: { source: 'UK CAA', year: 2025, retrieved: '2026-10-22', airCarrier: 477917, airTaxi: 47, gaItinerant: 310, militaryItinerant: 2, localCivil: 0, localMilitary: 0, total: 479996 },
  // Peak: DESIGN VALUE, 479,996 / 365 / 13.25 / 2.
  defaults: { gaFraction: 0, patternWork: false, peakArrivalsPerHour: 50, peakDeparturesPerHour: 50, keepKindOnRetry: true },
  special: { vehicles: { perHour: 3 } },
};

const PROFILES: Readonly<Record<string, AirportTrafficProfile>> = { KACY, KMHT, KBOS, KPGD, KPHL, EGLL };

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
export const CARGO_TYPES: ReadonlySet<string> = new Set(['B752', 'B763', 'A306', 'MD11']);
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
  const gaAllowed = profile.gaTypes.length > 0; // EGLL: light aircraft are not permitted (AD 2.20 para 1)
  if (!requested?.length) return { ga: gaAllowed, jets: true };
  const set = new Set(requested);
  const ga = profile.gaTypes.some(([t]) => set.has(t));
  const jets = usableAirlines(profile, set).length > 0;
  if (!ga && !jets) return { ga: gaAllowed, jets: true };
  return { allowed: set, ga, jets };
}

/** Every type the profile can generate, GA token first: the free-play default selection. KACY: ['C172', 'A320']. */
export function profileTypes(icao: string | undefined): string[] {
  const p = profileFor(icao);
  return [...new Set([...(p.gaTypes.length ? ['C172'] : []), ...p.airlines.flatMap((e) => e.types)])];
}

/** The free-play defaults of an airport (unknown ICAO: KACY's). */
export function trafficDefaultsFor(icao: string | undefined): TrafficDefaults {
  return profileFor(icao).defaults;
}

/** Arrivals per hour the Tower and player can work on the busiest airports (src/game/README.md ARRIVAL_SLOT_SEC): DESIGN VALUE, equal to the setup screen's "Busy". */
export const PLAYABLE_RATE_CAP = 18;

/**
 * Factor on the generic free-play rates (the setup screen's 5 / 10 / 18 per hour, START_PROFILE): 1 for KACY and KMHT and for every airport whose peak hour
 * is at least `PLAYABLE_RATE_CAP`, below 1 for a quieter airport (KPGD peak 8 per hour -> 0.44). DESIGN VALUE.
 */
export function rateScaleFor(icao: string | undefined): number {
  const peak = trafficDefaultsFor(icao).peakArrivalsPerHour;
  return peak === undefined ? 1 : Math.min(1, peak / PLAYABLE_RATE_CAP);
}
