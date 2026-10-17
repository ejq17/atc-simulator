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
  displacedThresholdFt?: number;
  tdzeFt?: number;
  ils?: { ident: string; frequencyMhz: number; courseDeg: number; glideslopeDeg?: number } | null;
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
  provenance: DataProvenance;
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
  airspaceClass?: 'B' | 'C' | 'D' | 'E' | 'G';
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
}

export type FlightRules = 'VFR' | 'IFR';

export type DeparturePhase =
  | 'PARKED' | 'READY' | 'TAXIING' | 'HOLDING_SHORT' | 'LINE_UP_AND_WAIT'
  | 'CLEARED_FOR_TAKEOFF' | 'TAKEOFF_ROLL' | 'INITIAL_CLIMB' | 'DEPARTURE';

export type ArrivalPhase =
  | 'INBOUND' | 'APPROACH' | 'FINAL' | 'LANDING' | 'ROLLOUT'
  | 'RUNWAY_EXIT' | 'TAXI_TO_PARKING' | 'ARRIVED';

export type FlightPhase = DeparturePhase | ArrivalPhase | 'GO_AROUND' | 'PATTERN' | 'HOLDING';

export type ClearanceKind =
  | 'TAXI' | 'HOLD_POSITION' | 'HOLD_SHORT' | 'CROSS_RUNWAY' | 'LINE_UP_AND_WAIT'
  | 'TAKEOFF' | 'LAND' | 'GO_AROUND' | 'CONTINUE_APPROACH' | 'CONTACT_FREQUENCY'
  | 'HEADING' | 'ALTITUDE' | 'SPEED' | 'ENTER_PATTERN' | 'PUSHBACK' | 'TAXI_TO_PARKING';

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
  altitudeFt?: number;
  speedKt?: number;
  frequencyMhz?: number;
  frequencyId?: string;
  patternLeg?: 'left_downwind' | 'right_downwind' | 'straight_in' | 'base';
  /** Set when the engine finished executing the clearance. */
  completedAtSec?: number;
}

export type RadioState = 'IDLE' | 'RECEIVING' | 'TRANSMITTING' | 'WAITING_FOR_READBACK';

export interface PendingRequest {
  kind: 'TAXI' | 'DEPARTURE' | 'LANDING' | 'FREQUENCY_CHANGE' | 'CROSSING' | 'PATTERN' | 'OTHER';
  text: string;
  sinceSec: number;
}

export interface GroundRoute {
  nodeIds: string[];               // path through the taxiway graph
  taxiways: string[];              // human route, e.g. ["A","B"]
  /** Node ids where the aircraft must stop until explicitly cleared. */
  stopAtNodeIds: string[];
  progressIndex: number;           // index of the node the aircraft is heading to
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
  radioState: RadioState;
  pendingRequest?: PendingRequest;
  /** Ids of runways the aircraft currently occupies (polygon test). */
  occupyingRunways: string[];
  /** Ids of runways this aircraft has been explicitly cleared to cross/enter/use. */
  runwayAuthorizations: string[];
  spawnedAtSec: number;
  history: Vec2[];                 // recent positions for trails
  voiceId: string;                 // which synthetic pilot voice
  flags: { emergency?: boolean; holdingPosition?: boolean; readbackErrorPending?: boolean };
  seed: number;
}

// ---------------------------------------------------------------------------
// Commands (output of the parser, input to the engine)
// ---------------------------------------------------------------------------

export type CommandKind = ClearanceKind | 'SAY_AGAIN' | 'UNKNOWN';

export interface ParsedCommand {
  kind: CommandKind;
  /** Callsign as resolved against the active aircraft list (null if not resolved). */
  callsign: string | null;
  callsignCandidates?: string[];   // when ambiguous
  runwayEnd?: string;
  runwayId?: string;
  route?: string[];
  holdShort?: string[];
  crossRunwayId?: string;
  destination?: string;
  headingDeg?: number;             // magnetic
  turnDirection?: 'left' | 'right';
  altitudeFt?: number;
  speedKt?: number;
  frequencyMhz?: number;
  frequencyId?: string;
  patternLeg?: Clearance['patternLeg'];
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
// Events, scenarios, scoring
// ---------------------------------------------------------------------------

export type SimEventKind =
  | 'TRANSMISSION' | 'COMMAND_ACCEPTED' | 'COMMAND_REJECTED' | 'CLARIFICATION'
  | 'PHASE_CHANGE' | 'RUNWAY_ENTERED' | 'RUNWAY_EXITED' | 'RUNWAY_INCURSION'
  | 'CONFLICT' | 'SEPARATION_VIOLATION' | 'GO_AROUND' | 'SPAWN' | 'DESPAWN'
  | 'HANDOFF' | 'READBACK_ERROR' | 'SCENARIO' | 'INFO';

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
    | { kind: 'airborne'; pos: Vec2; altitudeFt: number; headingDeg: number; speedKt: number; runwayEnd?: string; distanceNm?: number };
  isDeparture: boolean;
  initialFrequencyId: string;
  initialRequest?: PendingRequest['kind'];
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  mode: GameMode;
  seed: number;
  weather: Weather | 'live';
  activeRunways: { departing: string[]; landing: string[] };
  controllerPositions: ControllerPositionId[];
  spawns: ScenarioAircraftSpawn[];
  /** Continuous traffic generation settings (free play). */
  traffic?: { enabled: boolean; arrivalsPerHour: number; departuresPerHour: number; gaFraction: number; maxAircraft: number };
  objectives?: { id: string; text: string; check: string }[];
  training?: { steps: { id: string; prompt: string; expectCommand?: CommandKind; explanation: string; reference?: string }[] };
  durationSec?: number;
}

export interface ScoreCard {
  aircraftHandled: number;
  correctClearances: number;
  communicationErrors: number;
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
}
