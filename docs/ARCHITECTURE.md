# ATC Simulator (KACY, KMHT, KBOS, KPHL, KPGD, EGLL) — Architecture

Single-player, browser-based, local-first ATC simulator for six airports: Atlantic City
International (KACY, default), Manchester-Boston Regional (KMHT), Boston Logan (KBOS), Philadelphia International (KPHL), Punta Gorda (KPGD) and London Heathrow (EGLL,
built from the UK AIP). This document is deliberately short: it records
the decisions and contracts that every module must respect. Progress and known
gaps live in `docs/PROGRESS.md`; data provenance lives in `data/sources/README.md`.

## Stack

| Concern | Choice | Why |
|---|---|---|
| UI | React 19 + TypeScript + Vite + Tailwind v4 | Requested; fast dev loop |
| Simulation | Pure TypeScript, no DOM dependency (`src/sim`) | Independently testable, deterministic, replayable |
| State | Engine owns one authoritative `SimulationState`; React subscribes via a thin zustand store | Avoids aircraft state scattered across components |
| Rendering | Canvas 2D (surface + radar displays) with requestAnimationFrame interpolation | No heavy dependency; smooth at 60 fps with dozens of aircraft |
| Speech-to-text | Provider abstraction: browser Web Speech API (free, default), Local Whisper (transformers.js in a worker, on-device) and Deepgram (streaming, keyed via backend) | Works with zero setup; upgradeable |
| Command interpretation | Deterministic grammar/entity parser first; optional LLM fallback (`src/commands/llm`, `POST /api/llm/parse`) used only when the grammar is unsure, returns constrained commands that are validated like the grammar's | No LLM may mutate aircraft state; a confident grammar parse is never overridden |
| Text-to-speech | Browser `speechSynthesis` with per-aircraft voice selection and optional radio filter via WebAudio; optional local neural voices (Kokoro on WebGPU, Piper on WebAssembly, in workers) | Zero cost; no cloud TTS |
| Weather | Aviation Weather Center API via the local backend proxy with caching; National Weather Service API (`api.weather.gov`) called from the browser when the backend is unreachable and on the static build (US stations only: EGLL live weather needs the backend) | AWC does not allow browser CORS; NWS does |
| Backend | Tiny Node `http` server in `server/` (no framework), port 8787, reached through the Vite `/api` proxy | AWC weather proxy, FAA chart PDF proxy, Deepgram token, phrase interpreter; keys never reach the browser |
| Persistence | `localStorage` for settings, layout and career progress (no IndexedDB); model files in the browser Cache API | No accounts, no paid DB |
| Tests | Vitest (engine, parser, airport graph), Playwright (gameplay flows) | Required |

## Module map

```
src/sim/        types.ts (contracts), api.ts (engine interface), engine.ts, aircraft physics,
                state machines, runway occupancy, conflicts, pathfinding, scoring hooks
src/airport/    projection (lat/lon <-> local metres), per-airport dataset loaders (kacy/, kmht/, kbos/, kphl/, kpgd/, egll/; each loads its JSON through a dynamic import) and the registry
                (`getAirport`, `preloadAirport`, `listAirportOptions`, `listAirports`), graph queries
src/commands/   normalisation (spoken numbers, phonetics), grammar, entity resolution,
                callsign matching, confidence, clarification
src/radio/      frequencies, who-hears-what, transmission queue, readback generation
src/voice/      push-to-talk, STT providers, TTS providers, radio audio effects
src/weather/    METAR parsing, simulated weather presets, ATIS generation
src/charts/     chart index and viewer (FAA d-TPP PDFs; EGLL: link-only UK AIP list), navaid reference
src/game/       scenarios, traffic generation, free play/career/training, scoring, debrief
src/ui/         React app shell, panels, canvas displays
src/ui/tower/   3D Tower tab (lazy chunk). Pure, unit-tested: geometry.ts (polygon/ribbon/extrusion meshes, runway markings,
                lights, hold bars, taxiway signs), aircraftModel.ts (class, low-poly parts, placement/pitch, billboard scale),
                cameraMath.ts (look-at, drag/zoom/snap/follow, compass), skyMath.ts (sun, sky, fog, cloud deck),
                towerPosition.ts (cab site). Only towerScene.ts imports three.js (the GPU boundary; owns and disposes every
                resource); TowerDisplay.tsx is the React shell and reads the store per animation frame like the Surface view
server/         AWC proxy + cache, FAA chart proxy, optional Deepgram token endpoint, optional phrase interpreter route (server/llm)
data/sources/   verified FAA/NASR/d-TPP/OSM extracts with provenance (raw/ is git-ignored)
scripts/        build-airport.ts <ICAO>: one deterministic build for every airport (NASR/d-TPP JSON, or the hand-transcribed UK AIP JSON for EGLL, + OSM GeoJSON ->
                src/airport/<icao>/<icao>.airport.json, build-report.md, debug-graph.svg); airports/<icao>.ts holds only what is
                airport specific (taxiway identifiers of the diagram, parking-stand rules, frequency naming, MVA, hot spot)
```

## Airports

An airport is data, not code: a `src/sim/types.ts` `Airport` (runways, taxiway graph, parking, frequencies, navaids, procedures) produced by
the build from `data/sources/<icao>-*.json` and `<icao>-taxiways.geojson`. Adding one means: extract the NASR rows
(`scripts/extract-nasr-airport.ts`), fetch the OSM features (`scripts/osm-overpass-to-geojson.ts`), transcribe the plates into
`<icao>-procedures.json`, write a profile `scripts/airports/<icao>.ts`, build, add a loader in `src/airport/<icao>/` and register it in
`src/airport/index.ts` (`docs/ADDING-AN-AIRPORT.md` has the full checklist). Everything the UI, the engine, the AI controllers and the readbacks say about the airport is derived from that object:

* **Data flow.** `data/sources/<icao>-*.json` + `-taxiways.geojson` -> `scripts/build-airport.ts` (profile `scripts/airports/<icao>.ts`) -> `src/airport/<icao>/<icao>.airport.json` -> loader
  `src/airport/<icao>/index.ts` -> registry `AIRPORTS` in `src/airport/index.ts`. The JSON is **lazy**: `preloadXxx()` fills the loader's cache through `import('./<icao>.airport.json')`, so
  Rollup emits one chunk per airport and a first visit downloads only the chosen one. The registry keeps the display name beside the loader, so the airport selector (`listAirportOptions()`)
  needs no data. `getAirport` / `airportOrDefault` stay synchronous and throw until `await preloadAirport(icao)` resolved; the setup screen shows "Loading airport data..." while it does,
  `startSession` awaits it, and the Vitest setup file `src/test/preloadAirports.ts` preloads every airport so tests stay synchronous.
* **Charts.** `charts/chartIndex.ts` builds the chart list from `<icao>-procedures.json`. FAA airports bundle the d-TPP PDFs at build time (`scripts/fetch-charts.ts`, loading order bundled file,
  `/api` proxy, FAA URL). An airport whose procedures `_provenance.link_only` is true (EGLL, UK AIP, copyright NATS Limited) gets `ChartEntry.linkOnly`: `ChartViewer` renders `LinkOnlyCharts`
  (list plus the official URL, no PDF fetch), the backend never proxies it and `fetch-charts` skips it.
* **Runway configurations, time zone and units.** `Airport.runwayConfigurations` (KBOS 4, KPHL 2, EGLL 3; absent at KACY, KMHT, KPGD) drive the setup-screen selector, `weather/runwayConfigurations.ts` and the AI;
  `Airport.timeZone` (KACY and KMHT default to America/New_York, EGLL Europe/London) drives the local-time traffic density, sunrise and the ATIS clock; `Airport.altimeterUnit` 'hPa' (EGLL) switches QNH and metric visibility.

* Facility call names come from the frequency names in the data (`radio/frequencies.ts`: tower "Manchester", approach "Boston"), so a TRACON
  with another city's radio call is spoken correctly; the ATIS, charts panel (`charts/chartIndex.ts`, `navaidData.ts` per ICAO) and live METAR use the airport's ICAO.
* The default IFR initial altitude is the departure procedure's own (`InstrumentProcedure.maintainAltitudeFt`, KMHT MANCHESTER ONE: 3000), else 2000.
* Runway preference in calm wind is `preferredEndOrder` (KACY keeps its documented order; others: longest runway, ILS ends first).
* Career steps and training lessons name KACY's runway ends, taxiways and stands: scenario summaries carry `airports: ['KACY']`
  and `game.listScenarios(icao)` hides them elsewhere; free play is airport-agnostic.
* Graph contract the build guarantees: every holding position is adjacent to its runway node (the engine's rollout exit and entry rely on it);
  KMHT's densely digitised OSM entrances need the `simplifyEntryChains` profile option and fillet collapsing to meet it.

* KPGD (third airport) is the first with an excluded NASR runway (`AirportProfile.excludeRunways`: 09/27) and a **shared Clearance Delivery / Ground frequency**
  (119.55); the engine routes a radio call by the position the aircraft needs (`aircraftPosition`, `src/radio/frequencies.ts`), not by the first row that owns the frequency. Tower hours (0600-2100) are not simulated: the setup screen shows them and notes when the real clock is outside them. STAR arrivals are generated
  for any airport whose STARs are transcribed with a runway leg: the entry fixes come from `StarProcedure.simEntryFixes` (data), else `STAR_SIM_ENTRY_FIXES_BY_STAR` in `src/game/ifr.ts` (ROZZE2, ROBUC3, JFUND2), else the first two fixes after the common fix of the runway leg (KPGD: ZEBON, RUNNE, GUSEC); with several STARs on a runway end `starArrival` returns the entries of all of them.

* EGLL (fourth airport, first non-US) is built from hand-transcribed UK AIP data (`_provenance.source_name` / `source_url` labels instead of NASR / d-TPP), has two parallel runways and
  no runway crossing, `Airport.timeZone` Europe/London, `Airport.altimeterUnit` 'hPa' (QNH and metres in the ATIS, displays, AI phrases and the parser), published runway configurations
  (segregated mode), SIDs that each serve one runway end (`InstrumentProcedure.runwayEnd`, `departureProcedureFor` in `src/sim/ifr.ts`), a per-frequency radio call
  (`RadioFrequency.callName`: "Heathrow Director") and link-only charts (`ChartEntry.linkOnly`, `isOfficialFaa: false`). Profile hooks added for it: `osmRef` (OSM "Taxiway A" -> "A") and
  `relaxedChecks` (no GA ramp, hold path) in `scripts/airports/types.ts`. STARs end at the OCK / BIG / LAM / BNN holding fixes and are not assigned by the traffic generator
  (more than one STAR): arrivals use the ILS procedure with derived DME fixes (`LLIF`, `LLFAP` ...) as feeder, IF and FAF.

## Key contracts

* `src/sim/types.ts` — all entity models. Changing a type is a cross-team change: announce it in `docs/PROGRESS.md`.
* `src/sim/api.ts` — `SimulationEngine`. UI/voice/game code calls `applyCommand(parsedCommand)` and `subscribe()`; nothing else mutates state.
* Parser output is `ParseResult`/`ParsedCommand` (confidence + issues). The engine, not the parser, decides safety.

## Command pipeline

```
PTT audio -> STT provider -> raw text -> normalise -> parse (grammar) -> resolve callsign
  -> ParsedCommand[] -> engine.applyCommand -> validate (phase, position, runway, safety)
  -> state transition -> pilot readback (template) -> TTS -> event log -> UI
```
Rules: confidence below threshold => `clarify`, never execute. Unresolved callsign => `clarify`.
Unsafe clearances (e.g. takeoff with runway occupied) are detected; in training mode the
engine refuses and explains; in challenge/free play the clearance is issued and the
conflict is scored.

## Simulation loop

Fixed step `dtSec = 0.1` s. `advance(wallSec * speed)` accumulates and runs whole
steps; the renderer interpolates between the last two positions. Seeded PRNG
(`mulberry32`) for all randomness so a scenario + seed replays identically.

**Real time (session level, not engine).** The engine is unchanged: it never reads the wall clock after creation, tests step it
directly and `createEngine` still takes an explicit `utcStartMs`. `src/ui/store/realtimeClock.ts` decides how much to feed
`advance()` each frame. LIVE mode feeds the deficit `(performance.now - lockedAt) - alreadyFed`, so sim time always equals elapsed wall
time to within one step (no frame counting; bounded catch-up of 10 s of sim per frame, gaps over 300 s are dropped with a notice).
Pause keeps the lock; resuming at 1x, or choosing 1x after 2x/4x, re-locks and moves the UTC epoch (`setSimulationEpoch`) so `epoch + timeSec`
is the real UTC again; past times keep their own epoch (`utcAt`). Free-play traffic is thinned by `src/game/trafficDensity.ts`
(local-time curve, see its header); the live METAR feed is `src/weather/liveFeed.ts` and the hourly ATIS cycle `src/weather/atisCycle.ts`.

## Coordinates

WGS84 -> local tangent plane (equirectangular about the ARP) in metres, x east, y
north. Headings in state are TRUE; controllers/pilots speak MAGNETIC. Magnetic
variation comes from NASR per airport (KACY 10 W, KMHT 15 W, KBOS 15 W, KPHL 12 W, KPGD 6 W, EGLL 1.23 E as printed in the AIP). Altitudes in feet MSL; field elevation from NASR.

## Realism boundaries (documented, not hidden)

* Aircraft performance is simplified (constant accelerations, standard-rate turns).
* Taxiway geometry comes from OpenStreetMap reconciled against the official FAA
  airport diagram; anything hand-digitised is flagged `approximate: true`.
* No connection to real radio, ADS-B, or live traffic. Live weather is an input only.
* This is entertainment/learning software, not ATC training.
- Traffic variety (src/sim/{rotorcraft,vehicles,special}.ts, src/game/specialGenerator.ts, src/ai/special.ts): see src/sim/README.md and src/game/README.md.
* KBOS (fourth airport, six runways): see `docs/ADDING-AN-AIRPORT.md`. Profile options added for it: `includeTaxilanes` (OSM `taxilane` ways = apron lanes), `dropIsolatedLanes`, `excludeOsmWays` (with reasons), `shortStubJunctionM` (hold at 60 % of a stub whose junction is a real taxiway junction), plus: a taxiway that ends within 1.5 m of a runway threshold joins the threshold node; the half-runway exit check is a warning for runways under 6,000 ft.
