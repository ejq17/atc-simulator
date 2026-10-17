# KACY ATC Simulator

A browser-based, single-player air traffic control simulator for **Atlantic City
International Airport (KACY)**, New Jersey. You work Tower and/or Ground, speak or
type clearances in real ATC phraseology, and simulated pilots read back, taxi on the
real taxiway layout, line up, take off, fly approaches and land.

This is entertainment and learning software. It is **not** ATC training and must never
be used for real-world operations. Nothing here connects to real radio frequencies,
ADS-B, or live traffic.

## What is real

| Data | Source | Cycle |
|---|---|---|
| Runways (dimensions, thresholds, true/magnetic headings, TDZE, lighting, ILS), field elevation, variation, tower hours, Class C, LAHSO, remarks | FAA NASR 28-day subscription CSVs | effective 2026-10-01 |
| ATC frequencies (ATIS 125.725, Clearance 127.85, Ground 121.9, Tower 120.3, Approach/Departure 124.6 and 134.25) | FAA NASR `FRQ.csv` | 2026-10-01 |
| ACY VORTAC 117.15 (operational restricted), ILS 13 I-PVO / ILS 31 I-ACY (both 109.1), nearby VORs, 36 approach fixes | FAA NASR NAV/ILS/FIX | 2026-10-01 |
| Airport diagram, 13 instrument approach charts, ATLANTIC CITY THREE departure, hot spot, LAHSO pages (viewed in-app from the official PDFs) | FAA d-TPP | cycle 2610, 2026-10-01 to 2026-10-29 |
| Taxiway and apron geometry, gates | OpenStreetMap, reconciled with the FAA airport diagram (all 12 charted taxiway identifiers A B C D G H J K L M N P present) | snapshot 2026-10-17 |
| Live weather (METAR/TAF) | Aviation Weather Center API via the local backend | live |
| Procedural references in training/debrief | FAA JO 7110.65 paragraph numbers and titles verified against the FAA web edition (`docs/FAA-REFERENCES.md`) | 2026-10-16 |

Behavioural realism is verified too: aircraft performance values carry a source each
(Textron/Cessna, Airbus, EASA, EUROCONTROL), the 250 ft holding-position distance matches
FAA AC 150/5300-13B, separation rules cite FAA JO 7110.65, published missed approaches and
holds are flown from the plate text, and 109 radio phrases were audited against the FAA
(`docs/REALISM-VERIFICATION.md`, `docs/PHRASEOLOGY-AUDIT.md`).

Everything approximate or simplified is documented: runway holding positions are derived
(250 ft from the centreline per the FAA design standard; the FAA data has no hold-line coordinates), most parking
spots other than the ten OSM gate stands are synthetic positions inside the real aprons,
aircraft performance is a simplified model (C172 and A320 only), and 32 short OSM apron
lanes could not be matched to a charted identifier. See `data/sources/README.md` and
`src/airport/kacy/build-report.md`. The OSM-derived layer is © OpenStreetMap
contributors, ODbL 1.0.

## Quick start

```bash
npm install
npm run server   # local backend on :8787 (AWC weather proxy, FAA chart proxy, optional Deepgram token)
npm run dev      # Vite on http://localhost:5173
```

Open the app, pick a mode (Free Play, Career, Training), a scenario, weather (live
KACY METAR or a preset), runway configuration and controller position, then Start.

* **Push-to-talk:** hold **Space** (configurable in Settings) and speak, e.g.
  "Cessna seven two three echo juliet, runway one three, cleared for takeoff".
* **Typed fallback:** press **Enter**, type the same transmission, Enter to send.
* **1 / 2** switch Surface and Radar views; **+ / −** zoom; **Esc** deselects.
* Charts, Navaids, ATIS, Weather & Runways and Settings open from the top bar.

Speech recognition providers: **Local Whisper** (on-device via transformers.js, no cloud,
~40 MB model downloaded once; proven end to end by the automated fake-microphone test),
the browser Web Speech API (zero setup; Chrome/Edge send audio to Google/Microsoft), or Deepgram streaming (set `DEEPGRAM_API_KEY` in `.env`,
see `.env.example`; about $0.0048 per audio minute at the time of writing). The key never
reaches the browser: the backend mints short-lived tokens. No recordings are stored.
Pilot voices use the browser's speech synthesis with per-aircraft voice/pitch variation.

## Commands

```bash
npm test          # vitest: engine, parser, airport data, weather, charts, voice, game, ui
npm run test:e2e  # playwright: 14 browser flows + 5 fake-microphone voice flows (starts dev server + backend)
npm run typecheck
npm run lint
npx tsx scripts/build-kacy-airport.ts   # regenerate the airport dataset from data/sources
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
instructions (as published or with radial/turns/legs/EFC), execute missed approach.
430+ parser test transmissions in `src/commands`. Positions: Clearance Delivery,
Ground, Tower, Approach/Departure, or any combination.

## Layout

```
src/sim        simulation engine        src/airport   verified KACY dataset + taxiway graph
src/commands   phraseology parser       src/radio     readbacks, frequencies
src/voice      PTT, STT, TTS, radio FX  src/weather   METAR, presets, ATIS, runway selection
src/charts     FAA chart viewer         src/game      scenarios, traffic, training, career, debrief
src/ui         React app               server/       weather/chart proxy, Deepgram token
data/sources   FAA/OSM/AWC extracts with provenance (raw downloads are git-ignored)
```
