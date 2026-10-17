/**
 * Airport-module extensions of the core `Airport` contract (src/sim/types.ts).
 *
 * Everything here is a structural SUPERSET: a `KacyAirport` is assignable to
 * `Airport`, so consumers that only know the core contract keep working and can
 * ignore the extra fields. Nothing in src/sim/types.ts is modified.
 */
import type {
  Airport,
  DataProvenance,
  InstrumentProcedure,
  LatLon,
  ParkingPosition,
  Runway,
  RunwayEnd,
  TaxiEdge,
  TaxiNode,
  TaxiwayGraph,
  Vec2,
} from '../sim/types';

export interface LahsoInfo {
  availableLandingDistanceFt: number;
  /** Runway id (e.g. "4/22") the arriving aircraft must hold short of. */
  holdShortOfRunwayId: string;
  holdShortPoint: { latLon: LatLon; pos: Vec2 };
}

export type KacyRunwayEnd = RunwayEnd & {
  thresholdElevationFt?: number;
  approachLighting?: string | null;
  vgsi?: string | null;
  reil?: string | null;
  lahso?: LahsoInfo | null;
  /** Declared distances (ft) from NASR. */
  declaredDistancesFt?: { tora: number | null; toda: number | null; asda: number | null; lda: number | null };
};

export type KacyRunway = Runway & {
  ends: [KacyRunwayEnd, KacyRunwayEnd];
  /** Centreline length measured between the two NASR thresholds (ft); NASR length is `lengthFt`. */
  lengthBetweenThresholdsFt: number;
  provenance: DataProvenance;
};

export type KacyTaxiNode = TaxiNode & {
  /** true for derived / hand-simplified nodes (e.g. every holding position). */
  approximate?: boolean;
  notes?: string;
  /** For nodes on both runways (the HS 1 intersection) or runway nodes: all runways the node lies on. */
  runwayIds?: string[];
  /** For holding_position nodes: distance from the runway centreline (m) and the two candidate ends. */
  holdDistanceM?: number;
  /** For holding_position nodes: the runway node (entry point on the centreline) this hold line serves. */
  entryNodeId?: string;
  /** For runway nodes: distance from the runway-end thresholds in metres, keyed by end id. */
  distFromThresholdM?: Record<string, number>;
};

export type KacyEdgeKind = 'taxiway' | 'runway' | 'unnamed' | 'apron_connector';

export type KacyTaxiEdge = TaxiEdge & {
  /** `taxiway` is '' for unnamed lanes and apron connectors; filter on `kind`. */
  kind: KacyEdgeKind;
  osmWayIds?: number[];
  approximate?: boolean;
};

export type KacyParkingCategory = ParkingPosition['category'];

export type KacyParking = ParkingPosition & {
  /** Where the position came from: a real OSM feature, or a synthetic spot inside a real OSM apron polygon. */
  source: 'osm' | 'synthetic';
  approximate: boolean;
  /** Free-text zone: "Terminal", "GA ramp", "FBO", "USCG", "ANG", "FAA ramp". */
  zone: string;
  notes?: string;
  /** Length (m) of the apron connector edge to the taxi network; flagged when > 150 m or unconnected. */
  connectorLengthM?: number;
  connectorOverLimit?: boolean;
};

export interface KacyBuilding {
  id: string;
  kind: 'terminal' | 'hangar' | 'helipad';
  name?: string;
  osmId: number;
  polygon: Vec2[];
  provenance: DataProvenance;
}

/** MVA sector: `polygon` is the OUTER ring; `holes` are inner rings (other sectors inside it) that must be excluded from containment. */
export interface KacyMvaSector {
  id: string;
  /** Sector letter in the FAA chart ("A".."I"). */
  name?: string;
  polygon: Vec2[];
  holes?: Vec2[][];
  altitudeFt: number;
  remarks?: string;
  controllingObstruction?: string;
  provenance: DataProvenance;
}

export interface KacyTaxiwayGraph extends TaxiwayGraph {
  nodes: Record<string, KacyTaxiNode>;
  edges: KacyTaxiEdge[];
  /** OSM ways whose identifier could not be established (their edges have taxiway ''). */
  unresolvedWayIds: number[];
  /** OSM-only identifiers deliberately excluded (not on the FAA diagram), e.g. "I". */
  excludedOsmRefs: string[];
}

export interface KacyHotSpot {
  id: string;
  description: string;
}

export interface KacyAirport extends Airport {
  runways: KacyRunway[];
  mvaSectors?: KacyMvaSector[];
  taxiwayGraph: KacyTaxiwayGraph;
  parking: KacyParking[];
  procedures: InstrumentProcedure[];
  buildings: KacyBuilding[];
  /** Other published charts (hot spot, LAHSO, takeoff/alternate minimums) - not instrument procedures. */
  supportingCharts: { id: string; name: string; chartPdfUrl: string; provenance: DataProvenance }[];
  /** Airport remarks verbatim from NASR (useful for scenario / ATIS flavour text). */
  remarks: string[];
  /** Attribution required for the OSM-derived layer. */
  osmAttribution: string;
  /** Build metadata (source cycle, OSM timestamp, build script). */
  build: { script: string; osmBaseTimestamp: string; faaCycle: string; dtppCycle: string };
}
