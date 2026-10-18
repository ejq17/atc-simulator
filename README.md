# ATC Simulator (KACY and KMHT)

A browser-based, single-player air traffic control simulator for two real airports,
chosen on the setup screen: **Atlantic City International (KACY)**, New Jersey (the
default) and **Manchester-Boston Regional (KMHT)**, New Hampshire. You work Clearance
Delivery, Ground, Tower and/or Approach/Departure, speak or type clearances in real ATC
phraseology, and simulated pilots read back, taxi on the real taxiway layout, line up,
take off, fly approaches and land.

This is entertainment and learning software. It is **not** ATC training and must never
be used for real-world operations. Nothing here connects to real radio frequencies,
ADS-B, or live traffic.

**Live demo:** https://ejq17.github.io/atc-simulator/ (static GitHub Pages build; no backend). On the demo, **Deepgram is unavailable** (it
needs the local backend, `npm run server`), **live weather is unavailable** (aviationweather.gov sends no CORS headers, so a browser page
cannot read it; sessions use the simulated presets and the top bar shows **WX SIMULATED**), and the **FAA charts are bundled at build time**
from the public-domain d-TPP files. Speech input defaults to the browser's Web Speech API; **Local Whisper** and the **Local neural** pilot voice also work there (models come from
the Hugging Face CDN, the ONNX runtime from jsDelivr). For everything, run it locally (Quick start below).

## What is real

Each airport is built from its own verified source files by one script (`scripts/build-airport.ts <ICAO>`); the table
describes KACY, the KMHT counterparts follow it. Every airport-specific string the sim shows or speaks (facility call names,
ATIS, charts, navaids, runway ends, parking) comes from that airport's data.

| Data | Source | Cycle |
|---|---|---|
| Runways (dimensions, thresholds, true/magnetic headings, TDZE, lighting, ILS), field elevation, variation, tower hours, Class C, LAHSO, remarks | FAA NASR 28-day subscription CSVs | effective 2026-10-01 |
| ATC frequencies (ATIS 125.725, Clearance 127.85, Ground 121.9, Tower 120.3, Approach/Departure 124.6 and 134.25) | FAA NASR `FRQ.csv` | 2026-10-01 |
| ACY VORTAC 117.15 (operational restricted), ILS 13 I-PVO / ILS 31 I-ACY (both 109.1), nearby VORs, 36 approach fixes | FAA NASR NAV/ILS/FIX | 2026-10-01 |
| Airport diagram, 13 instrument approach charts, ATLANTIC CITY THREE departure, hot spot, LAHSO pages (viewed in-app from the official PDFs) | FAA d-TPP | cycle 2610, 2026-10-01 to 2026-10-29 |
| Taxiway and apron geometry, gates | OpenStreetMap, reconciled with the FAA airport diagram (all 12 charted taxiway identifiers A B C D G H J K L M N P present) | snapshot 2026-10-17 |
| Live weather (METAR/TAF) | Aviation Weather Center API via the local backend | live |
| Minimum vectoring altitudes (9 sectors) | FAA MVA/MIA digital product, Atlantic City ATCT/TRACON chart ACY_MVA_FUS3 | server date 2025-10-20 |
| LAHSO hold-short points and available landing distances; published fix altitudes and holding patterns | FAA NASR; d-TPP plates (transcribed, with provenance) | 2026-10-01 / cycle 2610 |
| Procedural references in training/debrief | FAA JO 7110.65 paragraph numbers and titles verified against the FAA web edition (`docs/FAA-REFERENCES.md`) | 2026-10-16 |

**KMHT (second airport)**, same sources and cycle (NASR 2026-10-01, d-TPP 2610, OSM snapshot 2026-10-17): runways 06/24 (7651 x 150 ft) and
17/35 (9250 x 150 ft) with displaced thresholds recorded, ILS on 6 (I-MJE 109.95), 17 (I-MNA 109.1) and 35 (I-MHT 109.1, CAT III), ATIS 119.55,
Clearance 135.9, Ground 121.9, Tower 121.3 (24 h, Class C), Boston Approach/Departure 124.9 (the Boston Consolidated TRACON), the MHT DME,
the CON and GDM VOR/DMEs, 41 fixes (26 on the approach plates, 15 on the ROZZE TWO arrival), the 18 d-TPP charts (diagram, 11 approaches of which 7 are transcribed, MANCHESTER ONE and
PPORT FOUR departures, the ROZZE TWO arrival (transcribed: five transitions, four runway legs, altitude and speed restrictions), minimums pages), 19 taxiway identifiers of the 22 on the diagram, 14 gates and 15 GA/FBO stands (OSM). KMHT
has **no** LAHSO, hot spot, MVA sectors, plate holding patterns or plate fix altitudes in the dataset: those layers are empty, not invented
(`data/sources/README.md`, "KACY layers with no KMHT equivalent"). The career steps and training lessons are written around KACY's
runway ends, taxiways and stands, so at KMHT the setup offers Free play (all five presets, custom traffic, IFR flows).

Behavioural realism is verified too: aircraft performance values carry a source each
(Textron/Cessna, Airbus, EASA, EUROCONTROL), the 250 ft holding-position distance matches
FAA AC 150/5300-13B, separation rules cite FAA JO 7110.65, published missed approaches and
holds are flown from the plate text, and 109 radio phrases were audited against the FAA
(`docs/REALISM-VERIFICATION.md`, `docs/PHRASEOLOGY-AUDIT.md`), and 60 simulated behaviours were
reviewed against the governing FAA text with measurements (`docs/BEHAVIOUR-ACCURACY.md`).

Everything approximate or simplified is documented: runway holding positions are derived
(250 ft from the centreline per the FAA design standard; the FAA data has no hold-line coordinates), most parking
spots other than the ten OSM gate stands are synthetic positions inside the real aprons,
aircraft performance is a simplified model (C172 and A320 only), and 32 short OSM apron
lanes could not be matched to a charted identifier. See `data/sources/README.md` and
`src/airport/kacy/build-report.md`. The OSM-derived layer is © OpenStreetMap
contributors, ODbL 1.0. FAA data (NASR, d-TPP charts, MVA) is a US government work in the public domain. The simulator code is MIT
licensed (`LICENSE`); see `CONTRIBUTING.md` to help out.

## Quick start

```bash
npm install
npm run server   # local backend on :8787 (AWC weather proxy, FAA chart proxy, optional Deepgram token)
npm run dev      # Vite on http://localhost:5173
```

Open the app, pick the airport (KACY by default, or KMHT), a mode (Free Play, Career,
Training; the last two are KACY-only), a scenario, weather (**live METAR of the chosen airport** is the
default; or a simulated preset), runway configuration and controller position, then Start.

**Wind.** Gusts in the METAR (or in a preset, e.g. *Gusty crosswind*) are flown: each aircraft sees its own seeded gust
sequence, so finals and takeoff rolls are unsteady and the float in the flare varies (gust model constants are design values,
not sourced). The **Weather and runways** panel lists head / tail and crosswind components per runway end, steady and at the
gust speed. Where a source exists for a type (only the Cessna 172: 15 kt demonstrated crosswind, 172S POH) the pilot says
"Unable, runway four, crosswind is above our limit, request runway three one" to a landing or takeoff clearance when the
effective crosswind (halfway between steady and gust, a design choice) exceeds it, and goes around only if the gusted
crosswind exceeds it by 5 kt or more for 2 s on final. Large and turbine-powered aircraft fly a 1,500 ft pattern, arrivals
use the glidepath angle and threshold crossing height of the cleared approach plate (or the runway's visual glide slope), go-arounds climb to the
published missed approach altitude, and the displaced thresholds at Manchester (6, 17, 35) are modelled and drawn.

**Real time by default.** The session clock is the real clock: sim time advances one second per wall-clock second
(corrected against `performance.now`, so it does not drift), the Zulu time, sunrise/sunset (DAY/NIGHT in the top bar) and
free-play traffic volume follow the real date and time at the airport (quiet overnight, busy morning and evening banks),
and the top bar shows **LIVE**. With live weather the airport's METAR is refreshed every 5 minutes (new observation times only),
the ATIS letter advances at every new hourly METAR / SPECI (JO 7110.65 2-9-2, even when no value changed; simulated weather: HH:55Z) and when the weather or the airport state changes materially, and the runway in use follows the wind. If the backend is
unreachable the last good METAR stays in use (**WX STALE**) or the session falls back to simulated weather (**WX SIMULATED**), and
the top bar says so. Pause is always available.

**Airport state.** The airport changes during a session: a **runway inspection** closes a runway for a few minutes at a quiet time, a **taxiway** can close, **bird activity** appears, and in rain or snow landing pilots report **braking action** (good, good to medium, medium, medium to poor, poor, nil). The ATIS reads closures as NOTAMs, gives RVR below 1 1/4 SM, runway condition codes and the latest braking action report, and bird activity; a closed runway is never selected, taxi routes avoid a closed taxiway, a clearance onto a closed runway is unsafe (training refuses it), and the Surface and Tower views mark closures with yellow Xs. At night or in low visibility a pilot may ask for the runway lights up or down; the Tower view dims and brightens the edge lights. The setup screen can close a runway or a taxiway for the whole session. At KMHT turbojet arrivals fly the published **ROZZE TWO** arrival from CRIBB or FLYZZ ("descend via the Rozze Two arrival", altitude and speed restrictions flown). Weather-derived values are simplifications and are listed in `docs/BEHAVIOUR-ACCURACY.md` (W11-W18, I17-I18, T18, S3); this is not ATC training.

**Sim speed (override).** The **2x / 4x** buttons ("Sim speed") release the real-time lock; the badge turns to **SIM 2x**. Press **1x**
to lock back to the wall clock. To start a session on the old sim clock instead, choose **Clock: Sim speed** on the setup screen.

* **Push-to-talk:** hold **Space** (configurable in Settings) and speak, e.g.
  "Cessna seven two three echo juliet, runway one three, cleared for takeoff".
* **Typed fallback:** press **Enter**, type the same transmission, Enter to send.
* **1 / 2 / 3** switch Surface, Radar and Tower views; **+ / −** zoom; **Esc** deselects.
* Charts, Navaids, ATIS, Weather & Runways and Settings open from the top bar.

Speech recognition providers, all three exercised end to end in automation: **Local Whisper**
(on-device via transformers.js, no cloud, ~40 MB model downloaded once), the browser **Web
Speech API** (zero setup; Chrome sends audio to Google; pause a beat after keying), or **Deepgram** streaming (set `DEEPGRAM_API_KEY` in `.env`,
see `.env.example`; about $0.0048 per audio minute at the time of writing). The key never
reaches the browser: the backend mints short-lived tokens. No recordings are stored.
Pilot voices: **Browser voices** (default, instant, clean) or **Local neural** (Settings > Pilot voice engine; machines with WebGPU see a one-time offer to enable it).
The neural voice runs in your browser tab, no cloud and no key: **Kokoro-82M** (`kokoro-js`, Apache-2.0) on WebGPU, or **Piper** (VITS, voice `en_US-libritts_r-medium`)
on WebAssembly when there is no WebGPU. One-time model download from the Hugging Face CDN: **326 MB on WebGPU, 79 MB on the CPU**, then kept in the browser's Cache API
(verified in Chrome with a persistent profile: the second visit makes no model request) and usable offline. First audio on an Apple-silicon Mac: about 0.5 to 1.8 s with
Kokoro on WebGPU, about 0.2 to 0.6 s with Piper on the CPU. It runs on the static GitHub Pages build too. Each aircraft gets its own voice, pace and pitch (from its callsign)
and its voice goes through the 300 to 3000 Hz radio chain with its own noise, compression, occasional mild over-modulation and a squelch tail; the signal turns weaker and
scratchier beyond about 30 nm. If the model is not ready, fails or is too slow, the call is spoken by the browser voice instead. Details and measurements: `src/voice/README.md`.
The Piper voice was trained on LibriTTS-R (CC BY 4.0, Koizumi et al., https://www.openslr.org/141/), voices from `rhasspy/piper-voices`.

## Deploying (GitHub Pages)

`.github/workflows/deploy.yml` runs on every push to `main`: `npm ci`, typecheck, tests, `npm run fetch-charts`, then
`GITHUB_PAGES=1 npm run build`, and publishes `dist/` with `actions/deploy-pages`. In the repository settings set
**Pages > Source: GitHub Actions** once.

* `GITHUB_PAGES=1` makes `vite.config.ts` use the base path `/atc-simulator/` (override with `VITE_BASE`, e.g. `VITE_BASE=/` for a custom domain)
  and sets `VITE_STATIC_HOSTING=1`, which tells the app there is no backend: it skips `/api` and the localhost backend, shows "needs the local
  backend (npm run server)" for Deepgram and live weather, and loads charts from the bundled files. The build also writes `dist/404.html`
  (a copy of `index.html`) so deep links open the app.
* `npm run fetch-charts` (`scripts/fetch-charts.ts`) downloads every d-TPP PDF the chart viewer references (about 8 MB for KACY and KMHT)
  into `public/charts/<ICAO>/`. The files are git-ignored and fetched fresh in CI. Chart loading order: bundled file, then the local `/api` proxy
  (not on Pages), then the direct FAA URL. d-TPP cycles last 28 days: after a new cycle the chart index (`data/sources/*-procedures.json`) must be
  refreshed or the bundled charts go out of date.
* Try the Pages build locally: `GITHUB_PAGES=1 npm run build && npm run fetch-charts && node scripts/serve-pages.mjs` then open
  http://localhost:4173/atc-simulator/ (`npm run preview:pages` serves an existing `dist/`).

## Panels, pop-out windows and multiple monitors

The simulator screen is built from panels (Surface, Radar, Tower, Aircraft, Strips, Details, Comms, Alerts, Radio, Charts, Navaids,
ATIS, Weather, Settings) arranged in three regions: the main display, a right column and a bottom row. The **Layout** menu in the
top bar has presets (**Tower cab**, **Ground**, **TRACON**, **Everything**), a show / hide and region choice per panel, and
**Reset**; the column and row splitters drag. Every panel (and every drawer) has a **pop-out** button that opens it in its own
browser window, so the radar can sit on one monitor, the tower view on another and the strips and radio on a third. Pop-outs share
the one running simulation (same page, no copying), keyboard shortcuts and push-to-talk work while a pop-out has focus, and a panel
returns to the main window when its window is closed. The layout and the open windows are remembered; after a reload, **Reopen
windows** brings them back (browsers only open windows from a click, so press it once per window). Keep the main window visible:
browsers throttle hidden windows and the clock runs there.

Below 1024 px (tablets and phones) the shell collapses to a full-screen display with a bottom tab bar (Display, Aircraft, Comms,
Radio), a large push-to-talk bar, and pinch / drag / tap on the canvases. See `src/ui/README.md` for the details.

## Tower view

The **Tower 3** tab is a 3D view from the control tower cab (three.js, loaded only when first opened, so Surface and Radar start-up is
unchanged). Runways with markings and numbers, taxiways with centrelines, hold lines, taxiway letters, aprons and buildings are all
built from the airport data; aircraft are procedural 3D models per type family (narrowbody, regional jet, bizjet, turboprop, GA high/low wing) sized from `src/sim/performance.ts`, with airline liveries by callsign, retracting gear, attitude and nav/strobe/beacon/landing lights (see `src/ui/tower/README.md`), and callsign tags that stay readable out to
the radar range. The sky follows the simulated UTC (day, dusk, night with runway, taxiway and aircraft lights), fog follows visibility, and a low
BKN/OVC ceiling draws an overcast deck. KACY has no tower in the OSM extract, so the cab is placed at the centroid of the terminal building
(eye height 30 m, an assumption); the view says so in its corner label.

| Control | Action |
| --- | --- |
| Drag | Look around (true bearing, shown as a magnetic heading strip along the top) |
| Wheel, **+ / −** | Zoom (field of view) |
| **[ / ]** or the RWY buttons | Snap to the previous / next runway end (**C**: first end) |
| **F** or Follow | Keep the selected aircraft in view (any drag cancels it) |
| **B** or Binoculars | Toggle a 7 degree binocular view |
| Arrow keys | Nudge the view |
| Click an aircraft | Select it (cyan ring and tag) |

The e2e test (`e2e/tower.spec.ts`) needs WebGL; headless Chromium uses SwiftShader (software GL), requested with
`--use-angle=swiftshader --enable-unsafe-swiftshader`. `node e2e/shoot-tower.mjs` captures screenshots (`TIME=2026-10-17T03:30:00Z` for a night view).

## Commands

```bash
npm test          # vitest: engine, parser, airport data, weather, charts, voice, game, ui
npm run test:e2e  # playwright: 24 browser flows incl. Whisper, Web Speech (real Chrome) and Deepgram-protocol voice tests
npm run typecheck
npm run lint
npm run fetch-charts                    # download the FAA chart PDFs into public/charts (used by the static build)
npm run build:airport -- KMHT           # regenerate an airport dataset from data/sources (KACY or KMHT); also: npx tsx scripts/build-airport.ts KACY
npx tsx scripts/build-kacy-airport.ts   # same as build-airport.ts KACY (kept)
```

## Architecture

See `docs/ARCHITECTURE.md` (module map and contracts) and `docs/PROGRESS.md`
(what is done, known issues, what is not implemented). Key properties:

* One authoritative, deterministic simulation (`src/sim`), fixed 0.1 s step, seeded
  randomness; UI subscribes and interpolates. Same scenario + seed + commands replays identically.
* Audio → transcription → normalisation → grammar parse → callsign resolution →
  engine validation (phase, frequency, runway, safety) → state transition → pilot
  readback. Low-confidence or ambiguous transmissions ask for clarification; nothing is guessed.
* Aircraft never invent clearances: they hold short until cleared to cross, line up or
  take off, and go around automatically without a landing clearance.
* Runway occupancy, incursions, crossing-runway conflicts (13/31 × 4/22) and unsafe
  clearances are detected and scored; training mode refuses unsafe clearances with an
  explanation referencing FAA JO 7110.65.

## Supported ATC instructions

Taxi (with via routes and hold-short), hold position, hold short, cross runway, line up
and wait, cleared for takeoff, cleared to land (incl. option / touch-and-go / low
approach), go around, continue approach, contact/monitor frequency, headings, altitudes,
speeds, pattern entries, IFR clearances (Clearance Delivery), approach clearances
(ILS/LOC/RNAV/VOR/visual), direct-to-fix, resume own navigation, radar contact, holding
instructions (as published or with radial/turns/legs/EFC), execute missed approach,
land-and-hold-short (LAHSO) clearances. Tower vocabulary: runway exit instructions ("turn left at Charlie, contact Ground point niner",
"hold short of runway 4" after landing), cancel takeoff clearance / abort, traffic information ("traffic, Cessna two-mile final"),
sequencing ("number two, follow the Skyhawk", extend downwind, turn base now, make short approach, make left three sixty), closed traffic,
touch-and-go / low approach / option, position reports ("report midfield downwind / base / two mile final"), "squawk VFR / squawk one two zero
zero", "frequency change approved", wind and altimeter with a clearance, line up and wait with traffic information.
660+ parser tests in `src/commands`. Positions: Clearance Delivery,
Ground, Tower, Approach/Departure, or any combination.

**Coordination between positions.** The positions you do not work are run by AI controllers, and the positions talk to each other the way a cab does over the
landline: Ground asks Tower before crossing an active runway (JO 7110.65 3-1-3: "cross runway one three at Alpha"), Tower asks Departure to release an IFR
departure ("Spirit four fifty one released", 4-3-4, a letter-of-agreement setting in the simulator), Departure and Approach point aircraft out to each other (5-4-3),
and "rolling" / "going around" are passed on. When an AI controller needs something from you, the **Landline** panel rings (Approve / Unable / Stand by,
"approve behind the landing ..."); to call another position hold **L** (configurable) or type "Tower, Ground, cross runway one three at Alpha with Cessna ...". Authorising a
crossing or an IFR takeoff without the approval is refused in training and scored as a coordination error (-3) in free play. If you work both positions of a pair there is nobody to call.

## Layout

```
src/sim        simulation engine        src/airport   verified KACY / KMHT datasets + taxiway graphs
src/commands   phraseology parser       src/radio     readbacks, frequencies
src/voice      PTT, STT, TTS, radio FX  src/weather   METAR, presets, ATIS, runway selection
src/charts     FAA chart viewer         src/game      scenarios, traffic, training, career, debrief
src/ui         React app               server/       weather/chart proxy, Deepgram token
data/sources   FAA/OSM/AWC extracts with provenance (raw downloads are git-ignored)
scripts        build-airport.ts <ICAO> (+ airports/<icao>.ts profiles), extract-nasr-airport.ts, osm-overpass-to-geojson.ts
```
