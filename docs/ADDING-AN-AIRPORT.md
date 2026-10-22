# Adding an airport

Every airport is data: a built `Airport` object (`src/sim/types.ts`) produced by `npx tsx scripts/build-airport.ts <ICAO>` from source files in
`data/sources/` and a per-airport profile in `scripts/airports/`. The two worked examples are KACY and KMHT; `git show --stat 8cccc26` lists every
file the second airport touched. This page is the checklist and the rules that apply to airports with more than two runways.

Data rule: no aeronautical value is typed from memory. Every runway, frequency, navaid, fix, procedure, heading, altitude, stand name, airline and
aircraft figure is read from a downloaded official source and carries provenance (source, URL, retrieved date, cycle). What cannot be sourced is
omitted and listed under "Not verified" in `data/sources/README.md`. Gameplay tuning values are labelled DESIGN VALUE.

## Steps

1. **d-TPP metafile and procedures JSON.** Find the airport's charts in `data/sources/raw/d-TPP_Metafile_<cycle>.xml`, download every PDF from
   `https://aeronav.faa.gov/d-tpp/<cycle>/<pdf>` (send a User-Agent), HTTP-check each URL, and write `data/sources/<slug>-procedures.json`
   (chart list with URLs, airport diagram taxiway identifiers and charted runway headings, `_provenance`). Non-FAA airports (EGLL, UK AIP): the same
   file shape with the AIP chart list; set `_provenance.source_name` / `source_url` (see "Provenance" below).
2. **Plate transcription.** Extract PDF text with pdfjs-dist, read the plate, record what was read and from which PDF
   (`<slug>-plate-geometry.json`: glidepath angle, TCH, missed approach altitudes; transcribed approaches / STARs inside the procedures JSON).
   Document it in the airport's section of `data/sources/README.md`.
3. **NASR extraction.** `npx tsx scripts/extract-nasr-airport.ts <FAA_ID> <ICAO>` writes `<slug>-facility.json`, `<slug>-frequencies.json`,
   `<slug>-navaids.json` from the NASR CSVs in `data/sources/raw/nasr_<cycle>/`. Values are copied verbatim.
4. **OpenStreetMap.** Overpass query for aeroway features within 2 km of the ARP (query in `data/sources/README.md`; User-Agent required), raw
   response under `data/sources/raw/` (git-ignored), then `npx tsx scripts/osm-overpass-to-geojson.ts <raw> data/sources/<slug>-taxiways.geojson <date> <lat> <lon>`.
   ODbL: attribution required, the derived taxiway/apron data is share-alike.
5. **Facility JSON extras (sourced constants, added by hand next to the NASR fields; see "New fields" below):** `airport.time_zone`,
   `airspace.class`, `runway_configurations`, `_provenance.source_name` / `source_url`.
6. **Profile.** `scripts/airports/<slug>.ts` implements `AirportProfile` (`scripts/airports/types.ts`): taxiway identifiers from the diagram, parking
   stands, frequency names, optional MVA, hot spot, notes. `crossing` is optional and only for KACY / KMHT (see below). Register it in `PROFILES` in
   `scripts/build-airport.ts`.
7. **Build.** `npx tsx scripts/build-airport.ts <ICAO>` writes `src/airport/<slug>/<slug>.airport.json`, `build-report.md` and `debug-graph.svg`.
   Read the report: hard errors stop the build, warnings list every simplification.
8. **Loader.** `src/airport/<slug>/index.ts` (copy `src/airport/kmht/index.ts`; it holds the synchronous `loadXxx()` and the async `preloadXxx()` that fills its cache through `import('./<slug>.airport.json')`, so Rollup emits the dataset as its own lazy chunk; never import the JSON statically). Its `rehydrate` sanity check tests the ICAO and the runway count of
   that airport (KACY and KMHT check `runways.length !== 2`; a new loader checks its own count or only the ICAO). Never edit the JSON by hand.
9. **Registry.** In `src/airport/index.ts` add one import line (`import { loadXxx, preloadXxx } from './<slug>';`, plus the matching `export`) and one entry in `AIRPORTS`: `XXXX: { name: '<JSON name>', load: loadXxx, preload: preloadXxx },`. The setup-screen selector (`listAirportOptions()`) picks it up without loading any data, and `src/airport/preload.test.ts` checks `name` against the JSON. `getAirport` / `airportOrDefault` stay synchronous but throw until `await preloadAirport('XXXX')` has resolved: the setup screen and `startSession` do this, and the Vitest setup file `src/test/preloadAirports.ts` calls `preloadAllAirports()` so tests need nothing. Do not add a Rollup `codeSplitting` group for `airport.json` in `vite.config.ts` (it would merge the per-airport chunks).
10. **Shared files, per airport** (each has a KACY and KMHT entry to copy): charts index `src/charts/chartIndex.ts` (`DATASETS`), navaid panel
    `src/charts/navaidData.ts` (`AIRPORTS`), traffic profile `src/game/airportProfile.ts` (airlines, aircraft types, neighbours, special traffic;
    the IFR destinations of `src/game/ifr.ts` then follow the profile), spoken airport names `src/radio/spoken.ts` (`AIRPORT_CITIES`), the command
    parser's airport names `src/commands/airports.ts`, `scripts/fetch-charts.ts` (`AIRPORTS`), `README.md` and the `data/sources/README.md` section.
11. **Tests.** A dataset test (`src/airport/<slug>/<slug>.test.ts`, copy `kmht.test.ts`), an engine smoke test (departure with a runway crossing if
    the airport has one, arrival), an AI test, a charts test, a scenarios test; the multi-runway behaviour has its own fixture tests (below).
12. Run `npm run typecheck`, `npm run lint`, `npx vitest run`; before merging changes that touch AI ground / tower behaviour also
    `FREEPLAY_SOAK=1 npx vitest run src/ai/freePlaySoak.test.ts`.

## New fields of the facility JSON

Read by `scripts/build-airport.ts` (all optional; absent means the NASR / KACY behaviour, so KACY and KMHT output is byte-identical):

| Field | Meaning |
|---|---|
| `_provenance.source_name`, `_provenance.source_url` | Label and URL stored in every facility-derived provenance entry (default: FAA NASR 28-day subscription, cycle 2026-10-01). The procedures JSON `_provenance.source_name` / `source_url` do the same for chart entries (default `FAA d-TPP cycle <cycle>`). |
| `airport.time_zone` | IANA zone ("Europe/London") -> `Airport.timeZone`; drives the time-of-day traffic density and bird activity. Absent: America/New_York. Sourced constant of the airport, not extracted. |
| `airspace.class` | "B" / "C" / "D" / "E" / "G" -> `Airport.airspaceClass` (else the legacy NASR `airspace.class_c` flag). |
| `runway_configurations` | Published runway configurations -> `Airport.runwayConfigurations` (below). |

`runway_configurations`: list in operator-preference order, each `{ id, name, landing: ["4R"], departing: ["4L","9"], wind_from_deg?, wind_to_deg?,
max_tailwind_kt?, notes, source, url?, retrieved?, approximate? }`. Ends are runway-end ids; the wind sector is magnetic, wind FROM, clockwise
(may wrap north). Each entry cites where it is published. The build fails if a configuration names an end that is not in the facility data.

## Runways: any number, crossings found automatically

* `build-airport.ts` finds every graph node where two or more runway centrelines meet (`scripts/lib/crossings.ts`). Zero is allowed (parallel
  runways only, EGLL). Each becomes a node with `runwayIds` of all runways on it and the id `RWX-<a>x<b>`, runway ids with "/" written "-"
  (4L/22R x 9/27 -> `RWX-4L-22Rx9-27`), name `Runway 4L/22R x 9/27 intersection`. The crossing of `runways[0]` and `runways[1]` takes id / name / notes
  from `profile.crossing` when the profile has one (KACY `HS1-X`, KMHT `RWX-X`), which keeps those two airports' ids stable.
* The engine works on runway ids and `runwayIds` of nodes; hold-short, "cross runway", occupancy, intersecting-runway timing (JO 7110.65 3-9-8,
  3-10-4) and LAHSO apply at every crossing (`crossingRunways` finds every runway whose surface overlaps).
* The tower camera starts looking along the far threshold of the longest runway when the airport has more than two.

## Runway configurations in operation

* **Selection** (`src/weather/runwayConfigurations.ts`): calm wind (under 5 kt or variable, JO 7110.65 3-5-1) -> the first usable configuration
  in list order; otherwise the configuration whose arrival runways have the best headwind component (within 1 kt = tie), then the one whose wind sector
  contains the wind, then the first listed. A configuration that exceeds its `max_tailwind_kt` is passed over unless none remains. A configuration
  using a closed runway end is never chosen. Airports without configurations behave exactly as before (best-headwind single runway).
* **Setup screen / weather drawer:** a "Runway configuration" selector replaces the landing / departing selectors when the airport has configurations.
  The ATIS reads multiple runways ("Landing runway 4R, departing runways 4L and 9").
* **Traffic:** each generated arrival goes to one of the landing runways that can take its type (declared LDA), preferring runways with an IFR
  procedure for airliners when IFR flows are on, and whose arrival slot is free; departures are taxied by AI Ground to a departing runway with enough
  length for the type (`planDeparture`, `runwayLongEnoughFor`). The AI Tower works every active runway. A runway in `landing` but not `departing` still
  accepts a takeoff clearance the player gives: only the AI follows the configuration.
* **Parallel runways:** runways whose surfaces do not overlap do not block each other, so a clearance on one is not held by traffic on the other.
  JO 7110.65 (faa.gov, read 2026-10-21): the 3-9 wake-turbulence departure intervals apply to "the same runway or a parallel runway separated by
  less than 2,500 feet"; 5-8-3 allows simultaneous same-direction departures from parallel runways at least 2,500 ft apart when the courses diverge
  (10 / 15 degrees; the divergence rule is not simulated); 5-9-6 gives the dependent parallel approach stagger (1 nm diagonal for centrelines 2,500
  to 3,600 ft apart, 1.5 nm for 3,600 to 8,300 ft, 2 nm for 8,300 to 9,000 ft, 3 nm or 1,000 ft during turn-on), which the AI Approach applies to
  IFR arrivals on adjacent finals (`DEPENDENT_MARGIN_NM` of 1 nm is a DESIGN VALUE). VFR arrivals to parallel runways are not staggered by the AI.
* **Fixture:** `src/sim/__fixtures__/multiRunwayAirport.ts` (two parallels 4,003 ft apart, a runway crossing both, a short runway, four
  configurations) with tests in `src/sim/multiRunway.test.ts`, `src/game/multiRunwayTraffic.test.ts`, `src/weather/runwayConfigurations.test.ts`,
  `src/ai/multiRunwaySoak.test.ts`.

## Provenance for non-FAA airports

`_provenance.source_name` and `source_url` replace the NASR wording of every provenance entry derived from the facility, frequency and navaid files;
the procedures file's own `source_name` / `source_url` replace the d-TPP wording. The build still expects `faa_cycle_effective` (cycle label) and
`retrieved` in the facility `_provenance` and `effective_from` / `effective_to` / `cycle` / `volume` in the procedures `_provenance`; for a non-FAA
source put the AIRAC cycle dates there and say so in `source_name`.
