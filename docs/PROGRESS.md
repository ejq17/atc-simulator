# Progress

Honest status as of 2026-10-16. "Done" means it runs and is covered by tests.

## Done

**Data (verified, with provenance)** — `data/sources/`, `src/airport/`
- FAA NASR 2026-10-01 extracts for ACY: ARP, elevation 74.8 ft, variation 10°W, runways 13/31 (10,001×150) and 4/22 (6,145×150) with thresholds, true/magnetic headings, TDZE, lighting, ILS 13 (I-PVO 109.1) and 31 (I-ACY 109.1), no ILS on 4/22; frequencies; ACY VORTAC 117.15 (OPERATIONAL RESTRICTED); VCN/SIE/CYN; 36 fixes; tower 24 h; Class C; LAHSO; HS 1.
- FAA d-TPP cycle 2610: airport diagram, 13 IAPs, ATLANTIC CITY THREE DP, hot-spot/LAHSO/minimums pages; every PDF URL verified HTTP 200.
- OSM taxiway/apron/gate geometry reconciled with the FAA diagram: all 12 charted taxiway identifiers present; connected ground graph (746 nodes, 813 edges), 12 derived holding positions, 35 parking positions (10 OSM gate stands, rest synthetic in real aprons), runway polygons, crossing edges marked. Build script is deterministic (`scripts/build-kacy-airport.ts`), 57 tests.
- AWC API shape verified; CORS confirmed absent (backend proxy required).
- FAA JO 7110.65 paragraph numbers/titles verified (`docs/FAA-REFERENCES.md`).

**IFR operations (added 2026-10-17)** — `src/sim/navigation.ts`, `approach.ts`, `ifr.ts`; parser `rules-ifr.ts`; game `ifr.ts`; UI positions/strips
- Clearance Delivery: IFR departures request and read back a full clearance ("cleared to Philadelphia, Atlantic City Three departure, radar vectors, maintain two thousand, expect ... ten minutes after departure, departure one two four point six, squawk ...") with the DP name taken from the d-TPP data; the aircraft then retunes to Ground on its own. Takeoff without an IFR clearance is refused in training and scored otherwise.
- Departure: runway heading, climb to 2000 per the ATLANTIC CITY THREE, Tower handoff to Departure, check-in, radar contact, vectors, climbs, direct-to-fix (VCN/SIE/CYN by name), resume own navigation, exit of the area.
- Approach: arrivals fly verified fix routes (VCN→CARYL→MAYBN for ILS 13, STEVV→PRSTY for ILS 31, KOPCE→FLDER→EFEWY for RNAV 22, JEDOB→FASEN→TEMVE for RNAV 4); approach clearances validated against published procedures (no ILS on 4/22), intercept angle ≤ 30°, outside the FAF, visual only in VMC; "established" report, handoff to Tower, missed approach back to Approach, 3 nm in-trail check.
- Gameplay: career step 8 is a real IMC ILS session; steps 7/9/11 include IFR departures; lessons train-08 (IFR clearance) and train-09 (vectors to the ILS); free-play IFR flows option; objectives and debrief advice for IFR mistakes; 7110.65 chapter 4/5 references verified.
- UI: Clearance Delivery / Approach / Departure / combined position sets, per-aircraft frequency routing of transmissions, flight strips by frequency, procedure fixes and final approach course on the radar, squawk/nav mode in data blocks, 60 nm range.
- Voice: on-device Whisper provider (no cloud, audio never leaves the machine) and an automated fake-microphone browser test that speaks a real clearance into the push-to-talk pipeline and verifies the aircraft departs (see `e2e/voice.spec.ts`). Observed transcript: "Cessna 723 Echo Juliet runway 1 3 cleared for takeoff", ~1.3 s from key release to transcript.

**Simulation engine** — `src/sim`, `src/radio` (200 tests)
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

**UI** — `src/ui`, `e2e/` (see `src/ui/README.md`): setup (mode / scenario / weather / runways / **controller positions** with per-position explanations, the positions each scenario needs and an **IFR flows** option), simulator (surface + radar canvases with interpolation, aircraft list and **Strips** tab, aircraft details, radio panel with PTT, typed input and one live RX/TX chip per active frequency, comms log, alerts, charts/navaids/ATIS/weather/settings drawers, training banner), debrief. IFR support: eight position sets (CLNC, GND, TWR, TWR+GND, APP+DEP, DEP, APP+TWR, All) with each call applied on the addressed aircraft's frequency and a clear "Not on frequency" rejection; `fixes` passed to the parser; flight rules, squawk, route, navigation mode, IFR clearance, approach clearance / established state and request badges (REQ IFR CLNC, REQ APPROACH, CHECK-IN, REQ TAXI, ...) in the panels; radar with 60 NM range, procedure fixes and final course of the active landing runways, dashed selected-aircraft route, All fixes, squawk and V/R/A letters in data blocks; empty readbacks (radar contact) are never spoken. Screenshots in `docs/screenshots/` (`sim`, `radar`, `approach`, `strips`, `setup-ifr`, ...).

Totals: 1347 vitest tests in 67 files, 19 Playwright tests (14 chromium flows + 5 fake-microphone voice flows), type-check clean. Verified by the orchestrator on 2026-10-17.

## Known issues
- The microphone path is proven with Chromium's fake audio device and the on-device Whisper provider (five automated tests). A physical headset, the Chrome Web Speech service, and the Deepgram path (no key available) were not exercised; Web Speech is unavailable in headless Chromium and the app degrades gracefully there.
- Whisper decoding runs on the main thread (WASM), so the page can stutter for about a second after releasing push-to-talk; a Web Worker would fix that. The first use downloads ~40 MB of model files from huggingface.co. `vite build` copies a 27 MB ONNX runtime `.wasm` into `dist/assets` that is not used at runtime.
- A session without a Ground position strands landed aircraft at the runway exit (pilots told to contact an unworked frequency wait there); choose a position set that includes Ground, or Tower + Ground.
- Browser TTS cannot be routed through WebAudio, so the radio filter applies only to clicks/static, not the pilot voice.
- Career step 1 completes as soon as the takeoff clearance is accepted.
- Holding-position locations are derived (250 ft from centreline), not charted; OSM taxiway accuracy beyond runway endpoints is unassessed.
- Hot-spot text in the d-TPP ("Rwy 13-31 at Twy A and Rwy 04-22 at Twy B") is reproduced as published; the app marks HS 1 at the runway intersection as drawn on the diagram.
- Lint: 3 non-blocking warnings.

## Not yet implemented (goal.md phases 5–6 and beyond)
- IFR simplifications: no STARs (arrivals appear over the published IAF/IF such as CARYL, STEVV, KOPCE, JEDOB), no holding patterns, no per-fix altitude restrictions or published minimums, final approach course equals runway heading, missed-approach altitude fixed at 2000 ft, in-trail separation uses a single 3 nm figure.
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
