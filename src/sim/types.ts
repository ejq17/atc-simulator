/**
 * Core simulation contracts shared by every subsystem.
 *
 * Coordinate conventions
 * ----------------------
 * - Geographic input data is WGS84 lat/lon in decimal degrees.
 * - The simulation runs in a LOCAL frame: metres east (x) and north (y) of the
 *   airport reference point (ARP), with altitude in feet MSL. See
 *   `src/airport/projection.ts` for the conversion.
 * - Headings/courses stored in state are degrees TRUE (0..360). Controllers and
 *   pilots speak MAGNETIC headings; conversion uses the airport's magnetic
 *   variation (`Airport.magneticVariationDeg`, east-positive).
 * - Speeds: `airspeedKt` is indicated/true airspeed (simplified, treated as one
 *   value); `groundSpeedKt` includes wind. Taxi speeds are in knots too.
 * - Time: `SimClock.timeSec` is seconds since scenario start. The engine ticks
 *   at a fixed `dtSec` and the renderer interpolates.
 */

export type Vec2 = { x: number; y: number }; // metres east/north of ARP
export type LatLon = { lat: number; lon: number };

// ---------------------------------------------------------------------------
// Airport data model (populated from verified FAA/NASR + OSM data)
// ---------------------------------------------------------------------------

export interface DataProvenance {
  source: string;          // e.g. "FAA NASR 28-day subscription"
  url?: string;
  retrievedOn: string;     // ISO date
  effectiveFrom?: string;  // FAA cycle effective date
  effectiveTo?: string;
  notes?: string;
  approximate?: boolean;   // true if this element is simplified/hand-digitised
}

export interface RunwayEnd {
  id: string;              // "13", "31", "4", "22"
  threshold: Vec2;         // local metres (from NASR threshold lat/lon)
  thresholdLatLon: LatLon;
  trueHeadingDeg: number;  // NASR "true alignment"
  magneticHeadingDeg: number;
  /**
   * Length (ft) of the displaced landing threshold from NASR (DISPLACED_THR_LEN). `threshold` is always the PAVEMENT end; the landing
   * threshold is `displacedThresholdFt` further along the runway (takeoff and rollout use the full pavement, landings aim for the landing threshold).
   */
  displacedThresholdFt?: number;
  /** Declared distances (ft) from NASR: TORA, TODA, ASDA, LDA (null: not published). */
  declaredDistancesFt?: { tora: number | null; toda: number | null; asda: number | null; lda: number | null };
  /** Visual glide slope (VGSI) angle and threshold crossing height from NASR (RWY_END VGSI / THR_CROSSING_HGT); used for visual approaches. */
  visualGlidepath?: { angleDeg: number; tchFt: number };
  tdzeFt?: number;
  ils?: { ident: string; frequencyMhz: number; courseDeg: number; glideslopeDeg?: number } | null;
  /** NASR LAHSO: available landing distance when holding short of the intersecting runway, and the hold-short point. */
  lahso?: { availableLandingDistanceFt: number; holdShortOfRunwayId: string; holdShortPoint: { latLon: LatLon; pos: Vec2 } } | null;
}

export interface Runway {
  id: string;              // "4/22", "13/31"
  ends: [RunwayEnd, RunwayEnd];
  lengthFt: number;
  widthFt: number;
  surface: string;
  /** Rectangle polygon in local metres, used for occupancy/incursion detection. */
  polygon: Vec2[];
}

export type TaxiNodeKind =
  | 'taxiway'            // ordinary taxiway centreline vertex
  | 'intersection'       // junction between taxiways
  | 'holding_position'   // runway holding position (hold-short line)
  | 'runway'             // vertex on a runway centreline (entry/exit/crossing)
  | 'parking'            // parking position / gate / tie-down
  | 'apron';

export interface TaxiNode {
  id: string;
  kind: TaxiNodeKind;
  pos: Vec2;
  latLon: LatLon;
  /** Taxiway identifiers this node belongs to (e.g. ["A"], ["A","B"] at a junction). */
  taxiways: string[];
  /** For holding_position / runway nodes: which runway (e.g. "13/31"). */
  runwayId?: string;
  /** For runway nodes where two runways cross: every runway whose surface the node lies on (`runwayId` is one of them). */
  runwayIds?: string[];
  /** For holding_position: which runway end it protects when departing (e.g. "13"). */
  protectsRunwayEnd?: string;
  /** For parking nodes: human name (e.g. "GA Ramp 3", "Gate 2"). */
  name?: string;
}

export interface TaxiEdge {
  id: string;
  from: string;            // TaxiNode id
  to: string;
  taxiway: string;         // identifier ("A", "B", ..., or "RWY13/31")
  lengthM: number;
  oneWay?: boolean;
  /** Edge lies ON a runway surface (crossing or back-taxi). */
  onRunwayId?: string;
}

export interface TaxiwayGraph {
  nodes: Record<string, TaxiNode>;
  edges: TaxiEdge[];
  /** Full taxiway centreline geometry for rendering, keyed by identifier. */
  taxiwayPolylines: Record<string, Vec2[][]>;
  aprons: Vec2[][];
  provenance: DataProvenance;
}

export interface ParkingPosition {
  id: string;
  name: string;
  nodeId: string;          // TaxiNode of kind 'parking'
  pos: Vec2;
  category: 'ga' | 'airline' | 'cargo' | 'military' | 'fbo' | 'other';
  headingDeg?: number;
}

export interface RadioFrequency {
  id: string;              // "ATIS" | "CLNC" | "GND" | "TWR" | "APP" | "DEP" ...
  name: string;            // "Atlantic City Tower"
  mhz: number;
  position: ControllerPositionId | 'ATIS' | 'OTHER';
  /** Sectorization from NASR (e.g. KACY approach/departure south 130-309, north 310-129), magnetic bearings from the airport. */
  sectorBearings?: { fromDeg: number; toDeg: number };
  provenance: DataProvenance;
}

export type ControllerPositionId = 'CLNC' | 'GND' | 'TWR' | 'APP' | 'DEP';

export interface NavigationAid {
  id: string;              // "ACY"
  type: 'VORTAC' | 'VOR' | 'VOR/DME' | 'NDB' | 'ILS' | 'LOC' | 'DME' | 'FIX' | 'WAYPOINT';
  name?: string;
  frequencyMhz?: number;
  latLon: LatLon;
  pos: Vec2;
  provenance: DataProvenance;
}

export interface InstrumentProcedure {
  id: string;              // "ILS-OR-LOC-RWY-13"
  name: string;            // "ILS OR LOC RWY 13"
  type: 'IAP' | 'DP' | 'STAR' | 'DIAGRAM' | 'OTHER';
  runwayEnd?: string;
  chartPdfUrl: string;     // official FAA d-TPP URL
  fixes?: string[];        // named fixes in order (IAF..MAP) where verified
  /** DP only: the altitude a clearance using this DP says to maintain ("Maintain 3000 or as assigned"); absent = the engine default. */
  maintainAltitudeFt?: number;
  /** Transcribed from the plate (human transcription; see data/sources/README.md). */
  missedApproachText?: string;
  holdingText?: string;
  minimaText?: string;
  /** Published glidepath / visual descent angle and its threshold crossing height, transcribed from the plate (data/sources/<slug>-plate-geometry.json). */
  glidepath?: { kind: 'GS' | 'GP' | 'VDA'; angleDeg: number; tchFt: number };
  /** Published missed approach climb altitudes, transcribed from the plate (structured form of `missedApproachText`). */
  missedApproach?: { initialClimbFt?: number; finalAltitudeFt: number; plateText: string };
  /** Published altitudes at fixes on the plate profile view (human transcription). */
  fixAltitudes?: { fix: string; minAltitudeFt?: number; maxAltitudeFt?: number; mandatoryAltitudeFt?: number; note?: string }[];
  /** Published holding patterns read from the plate depiction (human transcription). */
  holdingPatterns?: {
    fix: string;
    inboundCourseDeg: number;        // magnetic
    turns: 'left' | 'right';
    legNm?: number;
    legMinutes?: number;
    role: 'missed_approach' | 'hold_in_lieu' | 'arrival';
    maxSpeedKt?: number;
  }[];
  /** STAR only: the transcribed procedure (see `StarProcedure`); absent on chart-only entries and continuation pages. */
  star?: StarProcedure;
  provenance: DataProvenance;
}

/** Transcription of a standard terminal arrival chart (KMHT ROZZE TWO; data/sources/kmht-procedures.json `stars[].star`). */
export interface StarProcedure {
  /** Computer code identifier without the dot, e.g. "ROZZE2" (FAA id "ROZZE.ROZZE2"). */
  ident: string;
  /** Name as spoken in a clearance ("ROZZE TWO", 7110.65 4-7-1: name and number, without the parenthesised "(RNAV)"). */
  spokenName: string;
  /** Transition entries: the fixes flown from the transition fix to the common fix (inclusive). */
  transitions: { name: string; fixes: string[] }[];
  /** Per landing runway end: the fixes flown from the common fix (inclusive) to the end of the procedure (the IAF of the expected approach). */
  runways: {
    runwayEnd: string;
    fixes: string[];
    /** Fixes of the expected approach that continue the route from the IAF to the approach's feeder / initial fix (from the IAP chart). */
    joinApproachFixes?: string[];
    /** The chart ends with "then on heading N": magnetic heading flown after the last fix (JSTNN -> 057 for runway 24). */
    thenHeadingMagDeg?: number;
    expect: string;
  }[];
  /** Published restrictions by fix (the chart's altitude and speed depiction). */
  restrictions: { fix: string; atOrAboveFt?: number; atOrBelowFt?: number; atFt?: number; speedKt?: number }[];
  /** Leg data for integrity checks (magnetic track, distance, MEA as printed). */
  legs?: { from: string; to: string; trackMagDeg?: number; distanceNm: number; meaFt?: number }[];
  notes: string[];
}

export interface HotSpot {
  id: string;              // "HS 1"
  description: string;
  pos?: Vec2;
  provenance: DataProvenance;
}

export interface Airport {
  icao: string;            // "KACY"
  faaId: string;           // "ACY"
  name: string;
  arp: LatLon;
  elevationFt: number;
  magneticVariationDeg: number; // east positive (west variation is negative)
  runways: Runway[];
  taxiwayGraph: TaxiwayGraph;
  parking: ParkingPosition[];
  frequencies: RadioFrequency[];
  navaids: NavigationAid[];
  procedures: InstrumentProcedure[];
  hotSpots: HotSpot[];
  towerHours?: string;
  /** Published traffic pattern altitude (ft MSL) when the dataset has one (NASR carries none for KACY / KMHT: the AIM 4-3-3 defaults apply). */
  trafficPatternAltitudeFt?: number;
  airspaceClass?: 'B' | 'C' | 'D' | 'E' | 'G';
  /** Minimum vectoring altitude sectors from the FAA MVA/MIA digital product (polygons in local metres). */
  mvaSectors?: { id: string; polygon: Vec2[]; altitudeFt: number; provenance: DataProvenance }[];
  provenance: DataProvenance[];
}

// ---------------------------------------------------------------------------
// Aircraft
// ---------------------------------------------------------------------------

export type AircraftTypeCode = 'C172' | 'A320' | string;

export interface AircraftPerformance {
  type: AircraftTypeCode;
  category: 'light' | 'large' | 'heavy';
  wakeCategory: 'light' | 'medium' | 'heavy';
  /** Simplified, believable limits — not flight-sim physics. */
  taxiSpeedKt: number;
  taxiTurnSpeedKt: number;
  accelKtPerSec: number;        // ground acceleration during takeoff roll
  decelKtPerSec: number;        // braking on landing roll
  rotateSpeedKt: number;
  climbSpeedKt: number;
  cruiseSpeedKt: number;
  approachSpeedKt: number;
  touchdownSpeedKt: number;
  climbRateFpm: number;
  descentRateFpm: number;
  turnRateDegPerSec: number;    // standard-rate-ish in the air
  groundTurnRateDegPerSec: number;
  minSpeedKt: number;
  maxSpeedKt: number;
  serviceCeilingFt: number;
  takeoffDistanceFt: number;
  landingDistanceFt: number;
  lengthM: number;              // for ground spacing
  /** Engine type: AIM 4-3-3 pattern altitude (propeller 1,000 ft AGL; large / turbine-powered 1,500 ft AGL). Unknown: derived from `category`. */
  propulsion?: 'piston' | 'turboprop' | 'turbofan';
  /** Cited maximum (demonstrated) crosswind component, kt. Undefined = no citable figure: the simulator applies no limit. */
  maxCrosswindKt?: number;
  /** Cited maximum tailwind component for takeoff / landing, kt. Undefined = no citable figure: no limit applied. */
  maxTailwindKt?: number;
  /**
   * What the machine is: undefined = fixed-wing aeroplane; 'rotorcraft' flies the helicopter model (src/sim/rotorcraft.ts: hover, hover / air taxi,
   * point-to-point departures and arrivals); 'vehicle' is an airport ground vehicle (src/sim/vehicles.ts) that moves on the taxiway graph.
   */
  craft?: 'rotorcraft' | 'vehicle';
  /** Military aircraft: callsign form of JO 7110.65 2-4-20 ("Air Guard" + serial digits), overhead pattern, formation flights. */
  military?: boolean;
  /** Rotorcraft data. Hover / air taxi altitude limits come from JO 7110.65 3-11-1 and AIM 4-3-17; speeds are design values unless a source is named in performance.ts. */
  rotorcraft?: {
    /** Hover taxi: slow movement above the surface, "normally below 20 knots and in ground effect" (JO 7110.65 3-11-1). */
    hoverTaxiMaxKt: number;
    /** Air taxi speed the simulator flies ("above 20 knots", below 100 ft AGL: JO 7110.65 3-11-1, AIM 4-3-17). */
    airTaxiKt: number;
    /** Hover height AGL (ft) in ground effect. */
    hoverAglFt: number;
    /** Vertical climb / descent rate used for lift-off and landing (fpm). */
    verticalRateFpm: number;
    /** Heading change rate in the hover (deg/s). */
    hoverTurnRateDegPerSec: number;
  };
}

export type FlightRules = 'VFR' | 'IFR';

export type DeparturePhase =
  | 'PARKED' | 'PUSHBACK' | 'READY' | 'TAXIING' | 'HOLDING_SHORT' | 'LINE_UP_AND_WAIT'
  | 'CLEARED_FOR_TAKEOFF' | 'TAKEOFF_ROLL' | 'INITIAL_CLIMB' | 'DEPARTURE';

export type ArrivalPhase =
  | 'INBOUND' | 'APPROACH' | 'FINAL' | 'LANDING' | 'ROLLOUT'
  | 'RUNWAY_EXIT' | 'TAXI_TO_PARKING' | 'ARRIVED';

export type FlightPhase = DeparturePhase | ArrivalPhase | 'GO_AROUND' | 'PATTERN' | 'HOLDING';

export type ClearanceKind =
  | 'TAXI' | 'HOLD_POSITION' | 'HOLD_SHORT' | 'CROSS_RUNWAY' | 'LINE_UP_AND_WAIT'
  | 'TAKEOFF' | 'LAND' | 'GO_AROUND' | 'CONTINUE_APPROACH' | 'CONTACT_FREQUENCY'
  | 'HEADING' | 'ALTITUDE' | 'SPEED' | 'ENTER_PATTERN' | 'PUSHBACK' | 'TAXI_TO_PARKING'
  // IFR operations (Clearance Delivery / Approach / Departure positions)
  | 'IFR_CLEARANCE'        // "cleared to <dest> via <DP/route>, maintain <alt>, expect <alt>, departure <freq>, squawk <code>"
  | 'APPROACH'             // "cleared ILS/RNAV/VOR/visual runway <end> approach"
  | 'DIRECT_FIX'           // "proceed direct <fix>"
  | 'RESUME_OWN_NAVIGATION'// "resume own navigation" after vectors
  | 'RADAR_CONTACT'        // "radar contact" (informational; marks the aircraft as identified)
  | 'HOLD_AT_FIX'          // "hold at SMITS as published" / "hold east of SMITS on the 090 radial, right turns, one minute legs"
  | 'MISSED_APPROACH'      // "execute missed approach" / "go around, fly the published missed approach"
  | 'STAR'                 // "cleared ROZZE TWO arrival" / "descend via the ROZZE TWO arrival" (7110.65 4-7-1, 4-5-7)
  // Airport state (src/sim/airportOps.ts)
  | 'ADVISORY'             // informational advisory the pilot acknowledges: "caution, bird activity ..." (2-1-23), braking action (3-3-4)
  | 'RUNWAY_LIGHTS'       // runway edge light intensity request/answer ("lights up / lights down", 3-4-10, 3-4-11, 3-4-14)
  // Tower vocabulary (JO 7110.65 3-10-9, 3-9-11, 3-1-6, 3-8-1, 3-10-11, 7-6-11, 5-2-1; see docs/FAA-REFERENCES.md)
  | 'EXIT_RUNWAY'         // "turn left at Charlie" / "exit right Bravo" / "continue to the end" (+ optional "hold short of runway N")
  | 'CANCEL_TAKEOFF'      // "cancel takeoff clearance" / "abort takeoff"
  | 'TURN_AROUND'         // "make a one eighty" (NON-STANDARD, no 7110.65 phrase): the aircraft on a taxiway stops and turns 180 degrees where there is room
  | 'TRAFFIC_ADVISORY'    // "traffic, Cessna two-mile final"
  | 'FOLLOW_TRAFFIC'      // "number two, follow the Skyhawk on base"
  | 'PATTERN_INSTRUCTION' // destination EXTEND_DOWNWIND | TURN_BASE_NOW | SHORT_APPROACH | CIRCLE | CLOSED_TRAFFIC
  | 'REPORT_POSITION'     // destination REPORT_MIDFIELD_DOWNWIND | REPORT_BASE | REPORT_FINAL (+ distanceNm)
  | 'FREQUENCY_CHANGE_APPROVED' // "squawk VFR, frequency change approved"
  | 'SQUAWK'              // "squawk 1200" / "squawk VFR"
  | 'AIRPORT_INFO'        // "wind one three zero at eight, altimeter three zero one zero"
  // Traffic variety (JO 7110.65 3-7-2 / 3-1-3 vehicles, 3-11 helicopters, 3-10-12 overhead maneuver, 7-8 Class C; see docs/FAA-REFERENCES.md)
  | 'PROCEED'             // vehicle: "proceed on runway one three, report runway inspection complete" (3-7-2 "proceed" for vehicles, 3-1-3)
  | 'AIR_TAXI'            // helicopter: "air taxi via Alpha to the Coast Guard ramp" / "hover taxi to ..." (3-11-1)
  | 'OVERHEAD';           // "runway 13, pattern altitude one thousand five hundred, right turns, report initial" (3-10-12)

/** Traffic described by the controller ("Cessna two-mile final", "the Skyhawk on base"). */
export interface TrafficRef {
  /** Spoken description words before the position clause, lower case ("cessna", "boeing 737", "skyhawk"); may be empty. */
  desc: string;
  position?: 'final' | 'base' | 'downwind' | 'upwind' | 'crosswind' | 'departing' | 'in_position' | 'on_runway' | 'ahead';
  side?: 'left' | 'right';
  distanceNm?: number;
}

/** Surface wind / altimeter given by the controller (JO 7110.65 3-9-1, 3-10-1); wind direction is magnetic as spoken. */
export interface AirportInfo {
  calm?: boolean;
  windDirDeg?: number;
  windSpeedKt?: number;
  windGustKt?: number;
  altimeterInHg?: number;
}

export interface HoldingInstruction {
  fix: string;
  /** Inbound course to the fix, magnetic degrees. */
  inboundCourseDeg?: number;
  turns: 'left' | 'right';
  legMinutes?: number;
  legNm?: number;
  asPublished: boolean;
  /** Expect-further-clearance time, "HHMM" Zulu, when given. */
  efcZulu?: string;
}

export type ApproachType = 'ILS' | 'LOC' | 'RNAV' | 'VOR' | 'VISUAL';

/** IFR clearance elements (Clearance Delivery). */
export interface IfrClearanceDetails {
  destination: string;             // ICAO, e.g. "KPHL"
  routeText: string;               // e.g. "ATLANTIC CITY THREE departure, radar vectors, then as filed"
  departureProcedure?: string;     // "ATLANTIC CITY THREE"
  initialAltitudeFt: number;       // "maintain 2000" (ATLANTIC CITY THREE: 2000)
  expectAltitudeFt?: number;       // "expect <cruise> ten minutes after departure"
  departureFrequencyMhz: number;   // from airport.frequencies (DEP / APP)
  squawk: string;                  // 4-digit octal transponder code
}

export interface FlightPlan {
  flightRules: FlightRules;
  origin: string;
  destination: string;
  cruiseAltitudeFt: number;
  /** Named fixes the aircraft will fly, in order (verified fixes from the airport dataset or the exit fix). */
  route: string[];
  departureProcedure?: string;
  arrivalApproach?: { type: ApproachType; runwayEnd: string; procedureId?: string };
  squawk?: string;
  ifrClearance?: IfrClearanceDetails & { readBack: boolean; issuedAtSec: number };
}

export interface Clearance {
  id: string;
  kind: ClearanceKind;
  issuedAtSec: number;
  byPosition: ControllerPositionId;
  runwayEnd?: string;            // "13"
  runwayId?: string;             // "13/31" for crossing / hold short
  route?: string[];              // taxiway identifiers in order
  holdShort?: string[];          // runway ids to hold short of
  destination?: string;          // parking id or "RWY13"
  headingDeg?: number;           // magnetic
  turnDirection?: 'left' | 'right';
  /** TAXI segment: the taxiway the pilot is told to turn onto ("left on Bravo"), for the readback. */
  turnTaxiway?: string;
  altitudeFt?: number;
  speedKt?: number;
  frequencyMhz?: number;
  frequencyId?: string;
  patternLeg?: 'left_downwind' | 'right_downwind' | 'straight_in' | 'base';
  /** Tower vocabulary fields (see the matching ParsedCommand fields). */
  exitTaxiway?: string;
  ifAble?: boolean;
  traffic?: TrafficRef;
  sequenceNumber?: number;
  distanceNm?: number;
  turnDegrees?: number;
  squawk?: string;
  info?: AirportInfo;
  /** TRAFFIC_ADVISORY / FOLLOW_TRAFFIC: what the pilot answered ("traffic in sight", "looking for traffic", "negative contact"). */
  trafficResponse?: 'in_sight' | 'looking' | 'negative';
  /** IFR / radar fields. */
  approachType?: ApproachType;
  fix?: string;                    // DIRECT_FIX target
  ifr?: IfrClearanceDetails;       // IFR_CLEARANCE
  hold?: HoldingInstruction;       // HOLD_AT_FIX
  /** PUSHBACK: requested tail direction / nose ("face") direction, true degrees. */
  pushTailDeg?: number;
  pushFaceDeg?: number;
  /** TAXI: a progressive-taxi segment (turn, then follow the taxiway to a point). */
  segment?: boolean;
  starName?: string;               // STAR
  starTransition?: string;
  descendVia?: boolean;
  advisory?: 'BIRDS' | 'BRAKING';
  brakingTerm?: BrakingTerm;
  lightsDirection?: 'UP' | 'DOWN';
  lightStep?: number;
  /** PROCEED: report when the runway is clear / the inspection is complete ("report runway inspection complete"). */
  reportClear?: boolean;
  /** AIR_TAXI: 'hover' for a hover taxi (below 20 kt in ground effect), otherwise an air taxi (above 20 kt, below 100 ft AGL) (3-11-1). */
  taxiMode?: 'air' | 'hover';
  /** Set when the engine finished executing the clearance. */
  completedAtSec?: number;
}

export type RadioState = 'IDLE' | 'RECEIVING' | 'TRANSMITTING' | 'WAITING_FOR_READBACK';

export interface PendingRequest {
  kind: 'TAXI' | 'PUSHBACK' | 'DEPARTURE' | 'LANDING' | 'FREQUENCY_CHANGE' | 'CROSSING' | 'PATTERN' | 'IFR_CLEARANCE' | 'APPROACH' | 'OTHER';
  text: string;
  sinceSec: number;
  /** Which pilot-initiated request this is (pilotBehaviour.ts `PilotRequestCode`), for the controller / AI to answer. */
  request?: import('./pilotBehaviour').PilotRequestCode;
  /** Fix named by the request (DIRECT_FIX). */
  fix?: string;
  /** Runway end named by the request (RUNWAY_CHANGE, TAXI_BACK). */
  runwayEnd?: string;
  /** TAXI: the pilot asked for progressive taxi instructions (JO 7110.65 3-7-2; AIM 4-3-18). */
  progressive?: boolean;
  /** The call that made this request was blocked (RADIO_BLOCKED) and the retry has not been heard yet: the controller has not received it, so the strips and labels do not show it. */
  unheard?: boolean;
  /** TAXI: the aircraft stands clear after a head-on or a one eighty and asks Ground to route it again from where it is (ai/ground.ts). */
  resume?: boolean;
  /** TAXI: id of the aircraft this one stands nose to nose with (sim/headOn.ts). */
  headOnWith?: string;
}

export interface GroundRoute {
  nodeIds: string[];               // path through the taxiway graph
  taxiways: string[];              // human route, e.g. ["A","B"]
  /** Node ids where the aircraft must stop until explicitly cleared. */
  stopAtNodeIds: string[];
  progressIndex: number;           // index of the node the aircraft is heading to
  /** Nodes the aircraft will not pass because the pilot did not read back the hold-short instruction (JO 7110.65 2-4-3, 3-7-2): the first hold line and the hold-short points. */
  unreadStopNodeIds?: string[];
}

export interface Aircraft {
  id: string;
  callsign: string;                // "N723EJ", "NKS451"
  spokenCallsign: string;          // "Cessna seven two three echo juliet"
  type: AircraftTypeCode;
  flightRules: FlightRules;
  origin: string;                  // ICAO
  destination: string;
  isDeparture: boolean;
  pos: Vec2;                       // local metres
  headingDeg: number;              // TRUE heading of the nose
  trackDeg: number;                // TRUE ground track
  altitudeFt: number;              // MSL
  airspeedKt: number;
  groundSpeedKt: number;
  verticalSpeedFpm: number;
  onGround: boolean;
  phase: FlightPhase;
  assignedRunwayEnd?: string;
  frequencyMhz: number;
  frequencyId?: string;
  clearances: Clearance[];         // history; last of each kind is current
  activeClearanceId?: string;
  route?: GroundRoute;
  /** Current targets the autopilot/pilot is flying toward. */
  target: { headingDeg?: number; altitudeFt?: number; speedKt?: number };
  /** IFR flight plan and lateral navigation state (airborne routing over named fixes). */
  flightPlan?: FlightPlan;
  /** Active lateral navigation: flying toward `fixes[index]`; undefined while on vectors/heading. */
  nav?: { fixes: string[]; index: number; mode: 'route' | 'direct' | 'approach' | 'vectors' | 'holding' | 'missed' };
  /** Standard terminal arrival the aircraft is flying (KMHT ROZZE TWO); cleared on spawn, `descendVia` once the controller says "descend via". */
  star?: { procedureId: string; name: string; transition?: string; runwayEnd: string; descendVia: boolean };
  /** Transponder code and radar identification state. */
  squawk?: string;
  radarIdentified?: boolean;
  radioState: RadioState;
  pendingRequest?: PendingRequest;
  /** Ids of runways the aircraft currently occupies (polygon test). */
  occupyingRunways: string[];
  /** Ids of runways this aircraft has been explicitly cleared to cross/enter/use. */
  runwayAuthorizations: string[];
  spawnedAtSec: number;
  /** Sim time of the aircraft's latest go-around / missed approach (undefined: none). Controllers must not clear it to land again until it is re-established. */
  lastGoAroundSec?: number;
  history: Vec2[];                 // recent positions for trails
  voiceId: string;                 // which synthetic pilot voice
  flags: { /** Pilot realism: the pilot has made at least one call (communications established, AIM 4-2-4). Unset without realism. */ inContact?: boolean; emergency?: boolean; holdingPosition?: boolean; /** Flight-training pilot (touch-and-go circuits, then "taxi back"). */ training?: boolean; /** Touch-and-go circuits left including the one being flown (training pilots). */ circuits?: number; /** Helicopter: parking id of the pad it flies to / wants to air taxi to. */ padId?: string; /** Vehicle task in progress (vehicles.ts). */ vehicleTask?: string; /** Parking id a vehicle returns to. */ vehicleHome?: string; /** VFR transition through the Class C (special.ts). */ transit?: boolean; /** Overhead maneuver stage: the aircraft is not cleared to land before the break. */ overhead?: 'INBOUND' | 'INITIAL' | 'BROKE'; readbackErrorPending?: boolean; /** The clearance that was misread back (so a correction re-issues it, not a later companion command). */ readbackErrorClearanceId?: string; /** What kind of mistake the pending readback error is (`ReadbackError.kind`: runway, heading, altitude, frequency, squawk, taxiway, pattern, callsign, no_readback). */ readbackErrorKind?: string };
  seed: number;
  /** Formation flight of this many aircraft handled as ONE aircraft (JO 7110.65 2-1-13: "Control formation flights as a single aircraft"). Undefined = single ship. */
  formation?: { size: number };

  /** Flown by a student pilot: slower, wordier, asks for progressive taxi, says "student pilot" on initial contact (AIM 4-2-4). Read by the ground task. */
  student?: boolean;
  /**
   * An arrival's parking stand (`parkingResolver.refreshArrivalStands`): the nearest free stand of the category it parks in, assigned in the engine while it
   * is inbound and re-resolved when something else takes the stand. The exit prediction and AI Ground's taxi-in use it instead of a guess from the type.
   * `category` is the intent the spawn carried (the generator's cargo / military choice), else the type's natural category.
   */
  assignedStand?: { parkingId: string; category: ParkingPosition['category'] };
  /** The category the spawn says this arrival parks in (a Caravan on a cargo flight: 'cargo'). Unset: `naturalCategory`. */
  parkingIntent?: ParkingPosition['category'];
}

// ---------------------------------------------------------------------------
// Commands (output of the parser, input to the engine)
// ---------------------------------------------------------------------------

/** SAY_AGAIN: the controller asks the pilot to repeat. DID_YOU_COPY: the controller calls an aircraft that has not answered. UNABLE: the controller denies a pilot request. READ_BACK_HOLD: see the hold-short readback challenge. */
export type CommandKind = ClearanceKind | 'SAY_AGAIN' | 'DID_YOU_COPY' | 'UNABLE' | 'READ_BACK_HOLD' | 'UNKNOWN';

export interface ParsedCommand {
  kind: CommandKind;
  /** Callsign as resolved against the active aircraft list (null if not resolved). */
  callsign: string | null;
  callsignCandidates?: string[];   // when ambiguous
  /** The controller addressed the aircraft by an abbreviated callsign (AIM 4-2-4: prefix and last three characters). */
  callsignAbbreviated?: boolean;
  /** Number of instructions in the transmission this command came from (long transmissions draw "say again"). */
  groupSize?: number;
  runwayEnd?: string;
  runwayId?: string;
  route?: string[];
  holdShort?: string[];
  crossRunwayId?: string;
  destination?: string;
  headingDeg?: number;             // magnetic
  /** TAKEOFF: heading to fly after liftoff, magnetic (JO 7110.65 5-8-2 departure instruction given with the takeoff clearance); `turnDirection` is the turn to it. */
  departureHeading?: number;
  turnDirection?: 'left' | 'right';
  altitudeFt?: number;
  speedKt?: number;
  frequencyMhz?: number;
  frequencyId?: string;
  patternLeg?: Clearance['patternLeg'];
  exitTaxiway?: string;
  ifAble?: boolean;
  traffic?: TrafficRef;
  sequenceNumber?: number;
  distanceNm?: number;
  turnDegrees?: number;
  squawk?: string;
  info?: AirportInfo;
  /** CANCEL_TAKEOFF: the controller gave a reason ("traffic on the runway"). LINE_UP_AND_WAIT: traffic information was issued with it (3-9-4). */
  reason?: string;
  trafficAdvised?: boolean;
  approachType?: ApproachType;
  fix?: string;
  ifr?: Partial<IfrClearanceDetails>;
  hold?: Partial<HoldingInstruction>;
  /** PUSHBACK: "tail east" -> 90, "face south" -> nose 180 (compass points as true headings; the sim does not apply magnetic variation to them). */
  pushTailDeg?: number;
  pushFaceDeg?: number;
  /** TAXI: one segment of a progressive taxi ("turn left on Bravo, continue to Charlie"). */
  segment?: boolean;
  /** TAXI segment issued by an AI controller: the exact graph node the segment ends at (the intersection where the next taxiway begins). Not parsed from speech. */
  toNodeId?: string;
  /** STAR: spoken procedure name as parsed ("ROZZE2"), optional transition fix, and whether the clearance is "descend via". */
  starName?: string;
  starTransition?: string;
  descendVia?: boolean;
  /** ADVISORY: which advisory ('BIRDS' 2-1-23, 'BRAKING' 3-3-4/3-3-5) and, for braking action, the term. */
  advisory?: 'BIRDS' | 'BRAKING';
  brakingTerm?: BrakingTerm;
  /** RUNWAY_LIGHTS: `UP` / `DOWN` (one step) or an explicit intensity step. */
  lightsDirection?: 'UP' | 'DOWN';
  lightStep?: number;
  reportClear?: boolean;
  taxiMode?: 'air' | 'hover';
  /** 0..1, calibrated from grammar match quality and entity resolution. */
  confidence: number;
  rawText: string;
  normalizedText: string;
  /** Why confidence is low / what is missing (used to ask for clarification). */
  issues: string[];
}

export interface ParseResult {
  commands: ParsedCommand[];       // a transmission may carry multiple instructions
  callsign: string | null;
  rawText: string;
  normalizedText: string;
}

export type CommandOutcome =
  | { status: 'accepted'; clearance: Clearance; readback: string }
  | { status: 'rejected'; reason: string; pilotResponse?: string; unsafe?: boolean }
  | { status: 'clarify'; question: string };

// ---------------------------------------------------------------------------
// Weather / ATIS
// ---------------------------------------------------------------------------

export interface Weather {
  source: 'simulated' | 'live';
  observedAt?: string;             // METAR time if live
  rawMetar?: string;
  windDirDeg: number | 'VRB';      // magnetic for ATIS/tower, true in METAR (we store TRUE)
  windSpeedKt: number;
  windGustKt?: number;
  visibilitySm: number;
  clouds: { cover: 'SKC' | 'CLR' | 'FEW' | 'SCT' | 'BKN' | 'OVC' | 'VV'; baseFtAgl: number }[];
  temperatureC: number;
  dewpointC: number;
  altimeterInHg: number;
  phenomena: string[];             // ["RA", "TSRA", "BR"]
  flightCategory: 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
}

export interface Atis {
  letter: string;                  // "A".."Z"
  text: string;
  issuedAtSec: number;
  activeRunways: { departing: string[]; landing: string[] };
  simulated: true;
}

// ---------------------------------------------------------------------------
// Airport operating state (NOTAM-style closures, braking action, birds, lights)
// ---------------------------------------------------------------------------

export type ClosureKind = 'RUNWAY' | 'TAXIWAY';
export type ClosureSource = 'setup' | 'freeplay' | 'scenario' | 'player';

/** A NOTAM-style closure. `ident` is a runway id ("13/31") or a taxiway designator ("B"). Active while `startSec <= now < endSec`. */
export interface Closure {
  id: string;
  kind: ClosureKind;
  ident: string;
  startSec: number;
  /** Undefined = closed for the rest of the session. */
  endSec?: number;
  /** Why, in words ("runway inspection by airport operations"). */
  reason: string;
  source: ClosureSource;
}

/** Closure as written in a scenario / setup option; `startSec` defaults to 0. `ident` may be a runway end ("13") or pair ("13/31"). */
export interface ClosureSpec {
  kind: ClosureKind;
  ident: string;
  startSec?: number;
  endSec?: number;
  reason?: string;
}

/** The six terms of JO 7110.65 3-3-4 / AC 150/5200-30D. */
export type BrakingTerm = 'good' | 'good to medium' | 'medium' | 'medium to poor' | 'poor' | 'nil';

/** A pilot braking action report (3-3-4: quality, type of aircraft). */
export interface BrakingReport {
  /** Runway end the report is for. */
  runwayEnd: string;
  term: BrakingTerm;
  aircraftType: string;
  /** Spoken aircraft description for the broadcast ("a Boeing Seven Thirty-Seven"). */
  aircraftSpoken: string;
  atSec: number;
}

export interface AirportOps {
  closures: Closure[];
  /** Newest last. */
  braking: BrakingReport[];
  /** Bird activity advisory (2-1-23 / 2-9-3): text for the ATIS, in force until `untilSec`. */
  birds?: { text: string; untilSec: number };
  /** Runway edge light intensity override per runway id ("13/31") set on a pilot request; absent = the 3-4-x table default. */
  lightStep: Record<string, number>;
  closureSeq: number;
}

// ---------------------------------------------------------------------------
// Events, scenarios, scoring
// ---------------------------------------------------------------------------

export type SimEventKind =
  | 'TRANSMISSION' | 'COMMAND_ACCEPTED' | 'COMMAND_REJECTED' | 'CLARIFICATION'
  | 'PHASE_CHANGE' | 'RUNWAY_ENTERED' | 'RUNWAY_EXITED' | 'RUNWAY_INCURSION'
  | 'CONFLICT' | 'SEPARATION_VIOLATION' | 'GO_AROUND' | 'SPAWN' | 'DESPAWN'
  | 'HANDOFF' | 'READBACK_ERROR' | 'SCENARIO' | 'INFO' | 'RADIO_BLOCKED'
  /** A message on the coordination channel between positions (src/sim/coordination.ts), or a coordination error (`data.error`). */
  | 'COORDINATION';

export interface SimEvent {
  id: string;
  timeSec: number;
  kind: SimEventKind;
  aircraftId?: string;
  callsign?: string;
  text: string;
  severity: 'info' | 'warning' | 'critical';
  /** Transmission metadata. */
  frequencyMhz?: number;
  speaker?: 'ATC' | 'PILOT' | 'SYSTEM';
  /** Set when an AI controller (not the player) made this transmission or decision. */
  aiPosition?: ControllerPositionId;
  data?: Record<string, unknown>;
}

export interface RunwayOccupancy {
  runwayId: string;
  occupants: string[];             // aircraft ids on the surface
  departingId?: string;            // cleared for takeoff / rolling
  landingId?: string;              // cleared to land / on short final
  lineUpId?: string;
  crossingIds: string[];
  holdingShortIds: string[];
}

export interface ConflictAlert {
  id: string;
  kind: 'RUNWAY_INCURSION' | 'RUNWAY_CONFLICT' | 'GROUND_PROXIMITY' | 'AIRBORNE_PROXIMITY' | 'UNSAFE_CLEARANCE';
  aircraftIds: string[];
  runwayId?: string;
  text: string;
  severity: 'warning' | 'critical';
  sinceSec: number;
}

export type GameMode = 'free_play' | 'career' | 'training';

export interface ScenarioAircraftSpawn {
  atSec: number;
  callsign: string;
  type: AircraftTypeCode;
  flightRules: FlightRules;
  /** 'parked' at a parking id, 'holding_short' at a holding-position node, or airborne. */
  start:
    | { kind: 'parked'; parkingId: string }
    | { kind: 'holding_short'; nodeId: string; runwayEnd: string }
    | { kind: 'airborne'; pos: Vec2; altitudeFt: number; headingDeg: number; speedKt: number; runwayEnd?: string; distanceNm?: number }
    | { kind: 'at_fix'; fix: string; altitudeFt: number; speedKt: number; route: string[]; runwayEnd?: string; star?: { procedureId: string; transition?: string } };
  isDeparture: boolean;
  /** Flown by a student pilot (forces it; otherwise a seeded share of light VFR aircraft at higher pilot realism). */
  student?: boolean;
  initialFrequencyId: string;
  initialRequest?: PendingRequest['kind'];
  /** IFR flight plan (destination, cruise, requested route). Departures without one are VFR. */
  flightPlan?: Omit<FlightPlan, 'ifrClearance'>;
  /** Where a generated flight comes from (arrivals) / goes to (departures), ICAO. Unset: the engine picks from its own origin lists (KACY). */
  remoteAirport?: string;
  /** Arrivals: the kind of stand this flight parks at (the generator's choice: cargo apron for a freighter or a Caravan on a cargo flight). Unset: by type. */
  parkingCategory?: ParkingPosition['category'];
  /** Special traffic behaviour (src/sim/specialTraffic.ts): vehicle task, VFR transit, flight training, formation / overhead, helicopter mission. */
  behavior?: SpawnBehavior;
}

/** What a special-traffic spawn does beyond the ordinary arrival / departure (see `src/sim/specialTraffic.ts`). */
export type SpawnBehavior =
  | { kind: 'vehicle'; task: 'RUNWAY_INSPECTION' | 'PAVEMENT_INSPECTION' | 'ERRAND'; runwayId?: string; errandCategory?: ParkingPosition['category'] }
  /** VFR transition through the Class C (7110.65 7-8): flies the straight track from its spawn point to `exitPos` at `altitudeFt`. */
  | { kind: 'transit'; exitPos: Vec2; altitudeFt: number }
  /** Flight training: `circuits` touch-and-goes (the option) before a full stop and "taxi back". */
  | { kind: 'training'; circuits: number }
  /** Fighter: `size` aircraft (2 = flight of two, handled as one aircraft: 2-1-13); `overhead` = arrives through the overhead maneuver (3-10-12). */
  | { kind: 'military'; size?: number; overhead?: boolean }
  /** Helicopter at a helipad (parking id `padId`): departs from the pad or arrives to it. */
  | { kind: 'helicopter'; padId: string; mission?: 'DEPARTURE' | 'ARRIVAL' | 'REPOSITION' };

export interface Scenario {
  id: string;
  name: string;
  description: string;
  mode: GameMode;
  seed: number;
  weather: Weather | 'live';
  activeRunways: { departing: string[]; landing: string[] };
  controllerPositions: ControllerPositionId[];
  /** Positions the human player works; every other position in `controllerPositions` is worked by an AI controller. Defaults to all. */
  playerPositions?: ControllerPositionId[];
  /** Design values for the simulated pilots (ATIS reporting, visual acquisition, follow spacing); see `pilotBehaviour.ts`. Defaults when absent. */
  pilotBehaviour?: import('./pilotBehaviour').PilotBehaviourOverride;
  /** How imperfect the pilots are (readback errors, timing, blocked calls, callsign habits, students, requests): off / light / moderate / heavy. Absent = the pre-realism behaviour (digit errors only). See pilotBehaviour.ts. */
  pilotRealism?: import('./pilotBehaviour').PilotRealismLevel;
  /**
   * Coordination rules between positions (src/sim/coordination.ts). `crossingApprovalRequired`: Ground needs Tower's approval for an active runway
   * (JO 7110.65 3-1-3); `releasesRequired`: Tower needs a release from Departure/Approach for an IFR departure (LOA concept, 4-3-4). Both default on;
   * neither applies when one person works both positions or the other position does not exist.
   */
  coordination?: { crossingApprovalRequired?: boolean; releasesRequired?: boolean };
  spawns: ScenarioAircraftSpawn[];
  /** Continuous traffic generation settings (free play). */
  traffic?: { enabled: boolean; arrivalsPerHour: number; departuresPerHour: number; gaFraction: number; maxAircraft: number; /** false = no arrival slots / departure cap in the generator (stress tests of the raw clocks); default on, see src/game/README.md "Flow control". */ flowControl?: boolean };
  /** Runway / taxiway closures in force from the start of the session (setup-screen options, scenario scripts). See `Closure`. */
  closures?: ClosureSpec[];
  /** Pilot-initiated requests beyond the basic calls (free play): `lights` = arrivals at night / in low visibility may ask for the runway lights up or down. Off by default. */
  pilotRequests?: { lights?: boolean };
  objectives?: { id: string; text: string; check: string }[];
  training?: { steps: { id: string; prompt: string; expectCommand?: CommandKind; explanation: string; reference?: string }[] };
  durationSec?: number;
}

export interface ScoreCard {
  aircraftHandled: number;
  correctClearances: number;
  communicationErrors: number;
  /** Runway crossings / IFR takeoffs authorised without the coordination the order requires (3-1-3, 4-3-4); see scoring.ts. */
  coordinationErrors?: number;
  runwayIncursions: number;
  separationViolations: number;
  unsafeInstructions: number;
  missedReadbackErrors: number;
  averageWaitSec: number;
  totalDelaySec: number;
  scenarioCompleted: boolean;
  score: number;                   // 0..100, safety-weighted
}

export interface SimClock {
  timeSec: number;
  dtSec: number;                   // fixed step
  speed: number;                   // 0 paused, 1 realtime, 2, 4...
  tick: number;
}

export interface SimulationState {
  clock: SimClock;
  airport: Airport;
  aircraft: Record<string, Aircraft>;
  weather: Weather;
  atis: Atis;
  activeRunways: { departing: string[]; landing: string[] };
  runwayOccupancy: Record<string, RunwayOccupancy>;
  conflicts: ConflictAlert[];
  events: SimEvent[];
  controllerPosition: ControllerPositionId;
  controllerFrequencyMhz: number;
  scenario: Scenario;
  score: ScoreCard;
  seed: number;
  selectedAircraftId?: string;
  /** Coordination channel between positions (requests, approvals, message log). Always present once the engine created the state. */
  coordination?: import('./coordination').CoordinationState;
  /** Airport operating state: closures, braking action reports, bird activity, runway light settings (src/sim/airportOps.ts). */
  ops: AirportOps;
}
