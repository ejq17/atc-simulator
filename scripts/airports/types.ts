/**
 * Per-airport build profile for scripts/build-airport.ts.
 *
 * The generic build owns everything that is the same for every airport: runways from NASR, the OSM taxiway network
 * (planarised, identifiers inferred, hold lines derived, parking attached), validation and the report. A profile supplies
 * only what is genuinely airport specific: which source files to read, the FAA diagram's taxiway identifiers, where the
 * parking stands come from, how the frequencies are named, and optional layers (MVA sectors, diagram labels, hot spot).
 * A profile may only read source data; it never invents values.
 */
import type { DataProvenance, LatLon, RadioFrequency, Vec2 } from '../../src/sim/types.ts';
import type { KacyMvaSector, KacyParking } from '../../src/airport/types.ts';
import type { P } from '../lib/geom.ts';
import type { DiagramLabel } from '../lib/inference.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type J = any;

/** One parking record while the graph is being built (the generic build attaches it to the taxi network). */
export interface ParkRec {
  id: string;
  name: string;
  pos: P;
  category: KacyParking['category'];
  headingDeg?: number;
  source: 'osm' | 'synthetic';
  approximate: boolean;
  zone: string;
  notes?: string;
  /** polyline from the lane (first) to the stop point (last); for point stands / synthetic spots just [stop]. */
  leadIn: P[];
  node: number;
  connectorLengthM: number;
  connected: boolean;
}

export interface BuildingRec {
  id: string;
  kind: 'terminal' | 'hangar' | 'helipad';
  name?: string;
  osmId: number;
  polygon: Vec2[];
}

export interface ApronRec {
  osmId: number;
  name: string | null;
  ring: P[];
}

/** What the generic build hands to `AirportProfile.parking`. */
export interface ParkingCtx {
  /** OSM features of one aeroway kind (taxiway, gate, parking_position, helipad, ...). */
  featsOf(aeroway: string): J[];
  /** GeoJSON [lon, lat] list -> local metres. */
  toLocalPts(coords: [number, number][]): P[];
  loc(lat: number, lon: number): P;
  ringsOf(feature: J): P[][];
  buildings: BuildingRec[];
  apronRecs: ApronRec[];
  apronOf(osmId: number): ApronRec;
  /** All non-helipad building polygons (local metres). */
  buildingPolys: P[][];
  parkRecs: ParkRec[];
  /** Distance (m) from a point to the nearest non-runway taxi/apron edge. */
  networkDistance(p: P): number;
  sampleSpots(poly: P[], opts: { spacing: number; margin: number; avoidBuildingsM: number; accept: (p: P) => boolean }): P[];
  pickSpots(cands: P[], n: number, minSep: number, maxNet: number): P[];
  addSynthetic(ids: { id: string; name: string; category: KacyParking['category']; zone: string; notes: string }, p: P): void;
  warn(message: string): void;
  syntheticSpotSpacingM: number;
  parkingConnectMaxM: number;
}

/** Everything the frequency hook may read (all values come from the source JSON). */
export interface FrequencyCtx {
  freqSrc: J;
  /** "Atlantic City" / "Manchester": the tower radio call, title-cased. */
  callName: string;
  /** Radio call of the approach/departure facility, title-cased ("Atlantic City", "Boston"). */
  approachCallName: string;
  mk(id: string, name: string, vhf: string, position: RadioFrequency['position'], note: string, sectorBearings?: string): RadioFrequency;
}

export interface MvaResult {
  sectors: KacyMvaSector[];
  /** Provenance entry listed in airport.provenance. */
  provenance: DataProvenance;
  /** Report paragraph(s) printed under "Minimum vectoring altitude sectors". */
  reportIntro: string;
}

export interface AirportProfile {
  icao: string;
  /** Lower-case file prefix: data/sources/<slug>-*.json and src/airport/<slug>/. */
  slug: string;
  /** Text stored as airport.build.script and printed in the report ("scripts/build-kacy-airport.ts"). */
  buildCommand: string;
  /** Taxiway identifiers printed on the FAA airport diagram. OSM refs outside this set are kept as geometry but unnamed. */
  taxiwayIds: readonly string[];
  /** Airport-diagram PDF name used in provenance strings ("00669AD.PDF"). */
  diagramPdf: string;
  /** Charted magnetic heading of a runway end (the build checks it against true alignment and the NASR variation). */
  chartedMagneticHeading(endId: string, ctx: { procSrc: J; endSrc: J }): number;
  /** Text appended to each runway's provenance note about where the charted magnetic heading comes from. */
  headingSourceNote: string;
  /** Names of optional plate-transcription files (relative to data/sources); absent = that layer is empty. */
  holdingPatternsFile?: string;
  fixAltitudesFile?: string;
  /** Per-approach glidepath angle / TCH and missed approach climb altitudes (data/sources/<slug>-plate-geometry.json). */
  plateGeometryFile?: string;
  /** FAA airport-diagram label positions (taxiway identifier words georeferenced to lat/lon), when available. */
  diagramLabels?(): { labels: { id: string; lat: number; lon: number; ptX: number; ptY: number }[]; from: string; note: string };
  /** Parking stands, GA/FBO/cargo spots. Returns the OSM parking ways deliberately not used (for the report). */
  parking(ctx: ParkingCtx): { unusedParkingWays: string[]; reportParagraph: string; approximateSummary: string[] };
  /** The frequency list (names, positions, notes). */
  frequencies(ctx: FrequencyCtx): RadioFrequency[];
  /** MVA sectors, when the FAA MVA product is part of the dataset. */
  mva?(helpers: { loc(lat: number, lon: number): P; pr(p: P): Vec2 }): MvaResult;
  /** Hot spot (from the d-TPP hot-spot text) - only when the source file has `supporting_charts.hot_spot_text`. */
  hotSpotProvenanceNote?: string;
  /** NASR runway ids left out of the built airport (KPGD 09/27: not available to Part 121 operations, takeoffs not authorised, restricted to aircraft under 6000 lb). Documented in the airport's README section. */
  excludeRunways?: readonly string[];
  /**
   * Id / name / notes of the crossing of runways[0] and runways[1]. Optional: only the first two airports (KACY, KMHT) set it so
   * their built ids stay stable. Every runway-runway intersection of any airport is found automatically and gets the id
   * `RWX-<a>x<b>` (runway ids with "/" written "-": "RWX-4L-22Rx9-27"); an airport with parallel runways only has none.
   */
  crossing?: { nodeId: string; name: string; notes: string };
  /** Validation checks (matched by a substring of the check name) that fail because of a documented gap in the source data: reported as warnings with the reason instead of stopping the build. */
  knownGaps?: { check: string; reason: string }[];
  /** File with the OSM-versus-diagram comparison appended to the report (relative to scripts/data). */
  diagramComparisonFile?: string;
  /** Sentence about diagram label words that are not taxiway labels (report only). */
  diagramLabelNote?: string;
  /** Sentence fragment appended to the "Taxiway geometry in general" bullet (OSM runway endpoint offsets vs NASR), e.g. " (the OSM runway endpoints differ ...)". */
  runwayEndpointNote: string;
  /** Extra "Approximate elements" bullets specific to this airport. */
  extraApproximate?: string[];
  /** Spoken airport name from the NASR name; default: INTL -> International, RGNL -> Regional, title-cased. */
  spokenName?(nasrName: string): string;
  /** Treat OSM `aeroway=taxilane` ways (apron lanes between stands) as untagged taxiway ways in the graph (KBOS: terminal aprons are mapped as taxilanes only). */
  includeTaxilanes?: boolean;
  /** OSM ways left out of the graph, each with the reason (reported as "dropped as abandoned"; e.g. a connector whose hold line would lie inside another runway). */
  excludeOsmWays?: readonly { id: number; reason: string }[];
  /** A junction at least this far (m) from the runway centreline is a real taxiway junction, not a mapped fillet: the hold is placed on the stub (60 %) instead of beyond the junction on the through taxiway (default: walk on past any junction before 250 ft). */
  shortStubJunctionM?: number;
  /** Drop OSM ways that form islands touching no runway (isolated mapped lanes), listed in the report. */
  dropIsolatedLanes?: boolean;
  /** Remove degree-2 OSM vertices between a runway node and its hold line (densely digitised entrances), so the hold is adjacent. */
  simplifyEntryChains?: boolean;
  /** One-line notes for the airport.provenance entries (source file summaries with counts). */
  provenanceNotes: { navaids: string; procedures: string; osm: string; diagramReconciliation: string };
}

/**
 * Optional facility-JSON fields read by the generic build (data/sources/<slug>-facility.json), beyond the NASR-extractor fields:
 *
 *   _provenance.source_name   label stored in every facility-derived provenance entry (default "FAA NASR 28-day subscription (cycle 2026-10-01)")
 *   _provenance.source_url    URL stored with it (default: the NASR subscription page). EGLL sets both to the UK AIP.
 *   airport.time_zone         IANA zone ("Europe/London"); default (absent) = America/New_York at runtime.
 *   airspace.class            "B" | "C" | "D" | "E" | "G"; absent = legacy `airspace.class_c` flag.
 *   runway_configurations     [{ id, name, landing: ["4R"], departing: ["4L","9"], wind_from_deg?, wind_to_deg? (magnetic sector, wind FROM,
 *                             clockwise, may wrap north), max_tailwind_kt?, notes, source, url?, retrieved?, approximate? }]
 *                             Runway END ids as in `runways[].ends[].id`. List order = operator preference (ties and calm wind).
 * The procedures JSON `_provenance.source_name` (default "FAA d-TPP cycle <cycle>") and `_provenance.source_url` do the same for chart provenance.
 * Nothing in these fields is invented by the build; each value must come from the cited source.
 */

export type { DiagramLabel, LatLon };
