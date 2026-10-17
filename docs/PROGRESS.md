# Progress

Honest status as of 2026-10-16. "Done" means it runs and is covered by tests.

## Done

**Data (verified, with provenance)** — `data/sources/`, `src/airport/`
- FAA NASR 2026-10-01 extracts for ACY: ARP, elevation 74.8 ft, variation 10°W, runways 13/31 (10,001×150) and 4/22 (6,145×150) with thresholds, true/magnetic headings, TDZE, lighting, ILS 13 (I-PVO 109.1) and 31 (I-ACY 109.1), no ILS on 4/22; frequencies; ACY VORTAC 117.15 (OPERATIONAL RESTRICTED); VCN/SIE/CYN; 36 fixes; tower 24 h; Class C; LAHSO; HS 1.
- FAA d-TPP cycle 2610: airport diagram, 13 IAPs, ATLANTIC CITY THREE DP, hot-spot/LAHSO/minimums pages; every PDF URL verified HTTP 200.
- OSM taxiway/apron/gate geometry reconciled with the FAA diagram: all 12 charted taxiway identifiers present; connected ground graph (746 nodes, 813 edges), 12 derived holding positions, 35 parking positions (10 OSM gate stands, rest synthetic in real aprons), runway polygons, crossing edges marked. Build script is deterministic (`scripts/build-kacy-airport.ts`), 57 tests.
- AWC API shape verified; CORS confirmed absent (backend proxy required).
- FAA JO 7110.65 paragraph numbers/titles verified (`docs/FAA-REFERENCES.md`).

**Simulation engine** — `src/sim`, `src/radio` (116 tests)
- Fixed-step deterministic loop, seeded PRNG, event log, subscribers.
- Taxi pathfinding with ordered `via`, hold-short stops, explicit runway crossing clearances, spacing, parking.
- Takeoff roll, climb, bank-limited turns, wind, 3° approach, flare, rollout, exit selection by type, automatic go-around without landing clearance, pattern basics.
- Runway occupancy, incursion / crossing-runway / proximity / unsafe-clearance detection; training mode refuses unsafe clearances with FAA references; free play flags and scores them.
- Command validation (phase, frequency, runway length, performance limits, confidence thresholds, duplicate filter, parking destination resolution), deterministic readbacks with callsign last, seeded readback errors, pilot-initiated calls, frequency handoffs, scoring.

**Command parser** — `src/commands` (307 tests): spoken numbers/phonetics, airline telephony, N-number abbreviations, multi-instruction transmissions, 20 instruction kinds, calibrated confidence, clarification on ambiguity, never guesses a callsign or runway.

**Voice** — `src/voice` (72 tests): configurable PTT (hold/toggle, button), Web Speech and Deepgram providers behind one interface, partial/final transcript handling, per-aircraft TTS voices, transmission queue (one speaker per frequency, stepped-on handling), WebAudio radio clicks/static, persisted settings and privacy notes, no stored recordings.

**Weather/ATIS/backend** — `src/weather`, `server/` (239 tests): METAR parser, 7 presets + random, runway recommendation by wind, ATIS text + spoken form with rotating letter and refresh rules, live METAR through the local proxy with caching/coalescing; chart PDF proxy with allow-list; Deepgram token endpoint.

**Charts** — `src/charts` (27 tests): official FAA chart index and pdf.js viewer (zoom/pan/fit/pages, night mode), navaid reference panel with provenance.

**Gameplay** — `src/game` (140 tests): 12 career steps, 7 training lessons with step tracking and references, 5 free-play presets with full option set, seeded traffic generator (rates, spacing, max aircraft, no spawn conflicts), scripted events (wind shift, emergency call), objectives, debrief with grade and improvement text, career progress persistence.

**UI** — `src/ui`, `e2e/` (74 unit tests, 11 Playwright flows): setup, simulator (surface + radar canvases with interpolation, aircraft list/details, radio panel with PTT and typed input, comms log, alerts, charts/navaids/ATIS/weather/settings drawers, training banner), debrief. Screenshots in `docs/screenshots/`.

Totals: 1031 vitest tests in 55 files, 11 Playwright tests, type-check clean.

## Known issues
- Real microphone speech and the Deepgram path were not exercised in automation (headless has no microphone, no Deepgram key available). Web Speech API behaviour in Chrome was reasoned from the spec; verify with a headset.
- Browser TTS cannot be routed through WebAudio, so the radio filter applies only to clicks/static, not the pilot voice.
- Career step 1 completes as soon as the takeoff clearance is accepted.
- Holding-position locations are derived (250 ft from centreline), not charted; OSM taxiway accuracy beyond runway endpoints is unassessed.
- Hot-spot text in the d-TPP ("Rwy 13-31 at Twy A and Rwy 04-22 at Twy B") is reproduced as published; the app marks HS 1 at the runway intersection as drawn on the diagram.
- Lint: 3 non-blocking warnings.

## Not yet implemented (goal.md phases 5–6 and beyond)
- Clearance Delivery and Approach positions have frequencies but no IFR clearance or radar-vector workflow behind them; arrivals are spawned on final or inbound bearings, not flown from STAR/fix to fix. Departures leave the area after handoff.
- Additional aircraft types (regional jets, helicopters, ANG F-16s), emergencies beyond a scripted pan-pan call, holding patterns, takeoff cancellation, LAHSO operations, wake-turbulence timing.
- Radio congestion/blocked transmissions beyond the controller stepping on a pilot; pilot clarification requests.
- Session replay from recorded events; 3D tower view; desktop (Tauri) packaging; additional airports (architecture allows it: everything airport-specific comes from the `Airport` object).
- Mobile layout; Firefox has no Web Speech recognition.
- Class C airspace shape, current (2026) magnetic declination (NASR epoch 1965 value used, as charted), UNICOM, traffic pattern altitude: not in the downloaded data and therefore not shown.

## Technical decisions
- See `docs/ARCHITECTURE.md`. Notable: Canvas 2D instead of PixiJS (no dependency, sufficient performance); Node `http` backend with no framework; pdf.js for charts; engine types are the single contract; OSM layer kept separate from FAA data for licensing.

## Data sources
- `data/sources/README.md` (provenance, cycles, licenses, everything that could not be verified).
- `src/airport/kacy/build-report.md` (graph construction, identifier inference, approximations).
- `docs/FAA-REFERENCES.md` (7110.65 paragraphs).

## Recommended next steps
1. Test the voice path with a real headset in Chrome (Web Speech) and with a Deepgram key; tune the aviation keyterms.
2. Add an IFR clearance delivery and simple radar vectoring so Approach/Clearance positions become playable.
3. Add regional jets and helicopters (USCG Air Station Atlantic City is on the field) to the performance tables.
4. Replace derived holding-position offsets with surveyed positions if a source becomes available.
5. Automate the 28-day data refresh (NASR + d-TPP) via `scripts/`.
