# KACY ATC Simulator — Architecture

Single-player, browser-based, local-first ATC simulator for Atlantic City
International Airport (KACY). This document is deliberately short: it records
the decisions and contracts that every module must respect. Progress and known
gaps live in `docs/PROGRESS.md`; data provenance lives in `data/sources/README.md`.

## Stack

| Concern | Choice | Why |
|---|---|---|
| UI | React 19 + TypeScript + Vite + Tailwind v4 | Requested; fast dev loop |
| Simulation | Pure TypeScript, no DOM dependency (`src/sim`) | Independently testable, deterministic, replayable |
| State | Engine owns one authoritative `SimulationState`; React subscribes via a thin zustand store | Avoids aircraft state scattered across components |
| Rendering | Canvas 2D (surface + radar displays) with requestAnimationFrame interpolation | No heavy dependency; smooth at 60 fps with dozens of aircraft |
| Speech-to-text | Provider abstraction: browser Web Speech API (free, default) and Deepgram (streaming, keyed via backend) | Works with zero setup; upgradeable |
| Command interpretation | Deterministic grammar/entity parser; optional LLM fallback must return a constrained `ParsedCommand` | No LLM may mutate aircraft state |
| Text-to-speech | Browser `speechSynthesis` with per-aircraft voice selection and optional radio filter via WebAudio | Zero cost; provider interface allows cloud TTS later |
| Weather | Aviation Weather Center API via local backend proxy with caching | AWC does not allow browser CORS |
| Backend | Tiny Node `http` server in `server/` (no framework) | Only for AWC proxy and provider key exchange; keys never reach the browser |
| Persistence | IndexedDB/localStorage for settings, career progress, session reports | No accounts, no paid DB |
| Tests | Vitest (engine, parser, airport graph), Playwright (gameplay flows) | Required |

## Module map

```
src/sim/        types.ts (contracts), api.ts (engine interface), engine.ts, aircraft physics,
                state machines, runway occupancy, conflicts, pathfinding, scoring hooks
src/airport/    projection (lat/lon <-> local metres), KACY dataset loader, taxiway graph
                builder (OSM + FAA diagram reconciliation), validation
src/commands/   normalisation (spoken numbers, phonetics), grammar, entity resolution,
                callsign matching, confidence, clarification
src/radio/      frequencies, who-hears-what, transmission queue, readback generation
src/voice/      push-to-talk, STT providers, TTS providers, radio audio effects
src/weather/    METAR parsing, simulated weather presets, ATIS generation
src/charts/     FAA d-TPP chart index and viewer, navaid reference
src/game/       scenarios, traffic generation, free play/career/training, scoring, debrief
src/ui/         React app shell, panels, canvas displays
src/ui/tower/   3D Tower tab (lazy chunk). Pure, unit-tested: geometry.ts (polygon/ribbon/extrusion meshes, runway markings,
                lights, hold bars, taxiway signs), aircraftModel.ts (class, low-poly parts, placement/pitch, billboard scale),
                cameraMath.ts (look-at, drag/zoom/snap/follow, compass), skyMath.ts (sun, sky, fog, cloud deck),
                towerPosition.ts (cab site). Only towerScene.ts imports three.js (the GPU boundary; owns and disposes every
                resource); TowerDisplay.tsx is the React shell and reads the store per animation frame like the Surface view
server/         AWC proxy + cache, optional Deepgram token endpoint
data/sources/   verified FAA/NASR/d-TPP/OSM extracts with provenance (raw/ is git-ignored)
```

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
variation comes from NASR for ACY. Altitudes in feet MSL; field elevation from NASR.

## Realism boundaries (documented, not hidden)

* Aircraft performance is simplified (constant accelerations, standard-rate turns).
* Taxiway geometry comes from OpenStreetMap reconciled against the official FAA
  airport diagram; anything hand-digitised is flagged `approximate: true`.
* No connection to real radio, ADS-B, or live traffic. Live weather is an input only.
* This is entertainment/learning software, not ATC training.
