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

**Realism verification round (2026-10-17)** — `docs/REALISM-VERIFICATION.md`, `docs/PHRASEOLOGY-AUDIT.md`
- Aircraft performance re-sourced: C172 (Textron spec sheet, 172S POH, EASA TCDS) and A320 (Airbus A320 Aircraft Characteristics, EUROCONTROL) with a source per value in `src/sim/performance.ts` and `data/sources/aircraft-performance.json`. The A320 takeoff distance was corrected from 6,500 to ~5,000 ft, which fixed a real behavioural error (the engine refused valid A320 departures from runway 4/22).
- Runway holding-position distance (250 ft) confirmed against FAA AC 150/5300-13B Appendix G for all four KACY ends.
- Radar separation: 3 nm (7110.65 5-5-4, verified) plus 5 nm for a light aircraft behind a medium/large on the same final (simplified from the wake tables). Airborne proximity (1.5 nm / 500 ft) is labelled a near-miss alert, not a separation minimum.
- Published missed approaches flown from the plate text of all 13 KACY approaches (e.g. ILS 13: climb to 600, climbing left turn to 2000 on ACY R-090 to SMITS and hold); holding patterns (standard right turns, 1-minute legs, published holds at SMITS/RODDI/KOVEC/TUBER/CARYL/STEVV; direct entry only); HOLD and MISSED APPROACH commands; decision altitude/MDA from the plate minima with "runway not in sight" missed approaches in weather below minima.
- Phraseology: 109 phrases audited against FAA JO 7110.65, the AIM and the Pilot/Controller Glossary; 20+ corrections applied (Clearance Delivery name, "taxi" in taxi readbacks, "airport" and "departure frequency" in IFR clearances, destination in the ready-to-taxi call, "leaving ... climbing to" check-ins, miles as digits, ATIS hold-short readback line, lesson texts). Decisions on ambiguous items are recorded in the audit.
- Voice: Whisper decoding moved to a Web Worker (longest main-thread task during decode: 961 ms -> 0 ms; frame gap 950 ms -> 17 ms); production bundle 29 MB -> 3.8 MB.

**Accuracy review round (2026-10-17)** — `docs/BEHAVIOUR-ACCURACY.md`
- 60 simulated behaviours reviewed against the governing FAA text with measurements on the real KACY data: 21 accurate, 34 documented simplifications, 5 inaccurate; all 5 fixed and re-measured (rollout/exit, approach gate per 5-9-1/5-9-2, TUBER hold, departure frequency sectors, ATIS approaches).
- Same-runway separation now uses the 7110.65 3-9-6/3-10-3 categories (3,000/4,500/6,000 ft; C172 = Cat I, A320 = Cat III); intersecting-runway operations per 3-9-8/3-10-4 (release by crossing the intersection); 3-9-7 wake interval for intersection departures; holding entries (direct/parallel/teardrop per AIM 5-3-8) with wind correction; final approach courses from the NASR localizer course or FAF geometry; all 22 published holding patterns transcribed from the plates.
- Voice proven on three providers in automation: on-device Whisper (fake microphone), Chrome's Web Speech against Google's real service (headless Chrome 155, transcripts "Cessna 723 Echo Juliet Runway 13 cleared for takeoff", ~330 ms), and the Deepgram client protocol against a protocol-faithful mock (token grant, subprotocol upgrade, 16 kHz linear16 audio, interim/final results). Four Web Speech provider bugs found and fixed (continuous mode, result-list rebuilding, first-word clipping, fake-device capture).

**Simulation engine** — `src/sim`, `src/radio` (324 tests)
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

Totals: 1540 vitest tests in 76 files, 24 Playwright tests (14 chromium flows, 5 fake-microphone Whisper flows, 2 Web Speech flows in real Chrome, 3 Deepgram protocol flows), type-check clean, production build 3.8 MB. Verified by the orchestrator on 2026-10-17 after the accuracy review round.

## Known issues
- The microphone path is proven in automation for all three providers (fake audio device). Not exercised: a physical headset with a human voice, and Deepgram's own recognition accuracy (the client protocol is proven against a mock; a real key is needed for accuracy). Google's Web Speech service needs 1–3 s to open its stream, so speakers should pause a beat after keying; the app cannot buffer for it.
- Whisper's first use downloads ~40 MB of model files from huggingface.co and the ONNX runtime from a CDN; decoding adds ~1.5 s after key release.
- A session without a Ground position strands landed aircraft at the runway exit (pilots told to contact an unworked frequency wait there); choose a position set that includes Ground, or Tower + Ground.
- Browser TTS cannot be routed through WebAudio, so the radio filter applies only to clicks/static, not the pilot voice.
- Career step 1 completes as soon as the takeoff clearance is accepted.
- Holding-position locations are derived (250 ft from centreline), not charted; OSM taxiway accuracy beyond runway endpoints is unassessed.
- Hot-spot text in the d-TPP ("Rwy 13-31 at Twy A and Rwy 04-22 at Twy B") is reproduced as published; the app marks HS 1 at the runway intersection as drawn on the diagram.
- Lint: 3 non-blocking warnings.

## Not yet implemented (goal.md phases 5–6 and beyond)
- IFR simplifications: KACY has no published STARs (verified: none in the d-TPP), so arrivals appear over the published IAF/IF (CARYL, STEVV, KOPCE, JEDOB); no per-fix altitude restrictions; LAHSO not modelled; MVA approximated for the 20° intercept rule; no heavy/super wake categories (none of the simulated types are heavy).
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
