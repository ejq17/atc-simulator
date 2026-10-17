# src/ui - React application

Dark, ATC-styled single-page app. Everything the player sees is here; every simulation fact comes from the engine.

```
src/App.tsx             routes setup -> sim -> debrief from the store
src/ui/store/
  simStore.ts           zustand store; startSession / endSession / playAgain; owns ONE Session
  session.ts            framework-free Session: engine + rAF loop + render buffer + voice + ATIS + scenario-event runner
  uiStore.ts            view, drawer, layers, radar range, follow, typed-command draft, viewBus (zoom shortcuts)
  voiceSettings.ts      the persisted voice settings store + hook
src/ui/commands/transmit.ts   text -> parseTransmission -> engine.applyCommand (voice AND typed)
src/ui/display/
  surfaceRenderer.ts / radarRenderer.ts   pure Canvas 2D drawing (stub-context testable)
  surfaceStatic.ts      taxiway label placement, runway numbers, hold marks (per airport, cached)
  viewTransform.ts      world<->screen, zoom/pan/fit; labels.ts placement + hit tests; renderBuffer.ts interpolation
  SurfaceDisplay.tsx / RadarDisplay.tsx   canvases + overlay controls; useCanvasLoop.ts
src/ui/components/      TopBar, AircraftPanel, AircraftDetails, FlightStrips, RadioPanel, CommsLog, AlertsStrip, Banners, VoiceSettingsForm
src/ui/drawers/         Charts (ChartViewer), Navaids (NavaidPanel), Settings, ATIS, Weather and runways
src/ui/screens/         SetupScreen, SimScreen, DebriefScreen
src/ui/lib/             format.ts (data-block and heading/time formatting), geom.ts, provenance.ts, voiceStatus.ts,
                        positions.ts (controller position sets), ifr.ts (flight plan / nav / clearance / badge helpers),
                        procedures.ts (instrument-procedure geometry for the radar)
src/ui/references.ts    verified JO 7110.65 paragraph table (mirror of docs/FAA-REFERENCES.md)
```

## One authoritative state

The engine's `SimulationState` is mutated in place and is the only copy of aircraft data. React components read it through
`useSimState()` after subscribing to `rev`, a counter the session bumps about 10 times a second (and immediately after every
command). Nothing copies aircraft into `useState`. The canvases do not use React at all: every animation frame they read
`engine.getState()` directly.

**Smooth motion.** The engine steps at 10 Hz of sim time. `renderBuffer.ts` snapshots poses each time `clock.tick` changes and
the renderers draw the pose interpolated between the last two snapshots (heading along the shortest arc), one snapshot interval
behind the engine. The rAF loop caps the wall delta at 0.25 s; `engine.advance` does the fixed stepping and speed.

## Session start (`simStore.startSession`)

1. Weather: live -> `fetchLiveMetar('KACY')`; failure -> simulated "Clear" preset plus a visible warning notice. Preset -> `getPresetWeather`.
   Scenario default -> the scenario's own weather (and `'live'` scenarios are treated as live). The METAR is applied with `engine.setWeather`
   because the engine substitutes calm weather for `'live'`.
2. `game.buildScenario` / `game.buildFreePlay` -> the `Scenario` is passed to `createEngine` AS-IS (it carries events, difficulty, aircraft types)
   with `game.createTrafficGenerator`.
3. `createScenarioEventRunner` is updated once per frame; its pilot calls go to the same voice queue. A scripted wind shift re-issues the ATIS
   (when `atisNeedsUpdate`) and shows a notice; **active runways are never changed automatically** (top bar "Runways" opens the Weather and
   runways drawer, which calls `engine.setActiveRunways` and re-issues the ATIS).
4. ATIS: `generateAtis` ("Atlantic City", initial letter from the UTC hour, `nextAtisLetter` on change). Always labelled SIMULATED. "Listen" speaks
   it through the TTS provider.
5. Training: `game.createTrainingController(scenario)` gets every command outcome (`onCommand`) and state update; the banner shows prompt,
   explanation, reference, feedback and `TRAINING_DISCLAIMER`.
6. `endSession` -> `game.buildDebrief(state)`; career scenarios also `game.saveCareerResult`.

## Controller positions (`lib/positions.ts`)

Eight selectable sets, all frequencies read from `airport.frequencies` (never constants): Clearance Delivery (CLNC 127.85), Ground, Tower,
Tower + Ground, **Approach + Departure** (APP and DEP, both 124.6 at KACY; one chip labelled `APP/DEP`), Departure only, **Approach + Tower**
and **All positions** (TWR, GND, CLNC, APP, DEP). The first position of a set is the primary one given to the engine
(`setControllerPosition`). The setup screen lists each choice with what it does and its frequencies, shows the positions the selected
scenario needs (`scenario.controllerPositions`, read with `game.buildScenario`), defaults to `suggestPosition(...)` = the smallest set that
covers them, and flags choices that miss a needed position. Custom free play reads its positions from `game.buildFreePlay(..., {ifrFlows})`;
ticking **IFR flows** (bound to `FreePlayOptions.ifrFlows`, also on ready-made free-play scenarios) switches to All positions unless the
current choice already covers Clearance Delivery.

The Radio panel shows one chip per distinct frequency of the active set. A chip lights `RX` (green: pilot call came in) or `TX`
(cyan: your transmission) for 6 s of sim time after the latest call on it, and the most recent one keeps a `last RX/TX` tag; the data comes
from the engine event log (`lastActivity`). With voice off the status and "Heard" lines are hidden (the badge already says VOICE OFF).

## Transmission pipeline (`commands/transmit.ts`)

`transmit({engine, text, source, controller})`: parse with ALL aircraft and ALL fixes in the context (so "not on frequency" can be reported
and "proceed direct Cedar Lake / CARYL" resolves); if the callsign is ambiguous, retry with only aircraft on the controller's frequencies;
apply each command with `engine.applyCommand(cmd, {position, source, transmissionId})` (one id per transmission so the engine logs the ATC
call once); stop at the first `clarify`. The engine itself emits the pilot readback or "say again" through `onPilotTransmission`; the UI
never speaks them a second time. With several positions active, `positionFor` picks per command the position whose frequency the addressed
aircraft is tuned to (positions sharing a frequency, APP/DEP, are interchangeable). An aircraft on a frequency the player does not work is
sent to the primary position, so the engine rejects "Not on frequency: X is on 124.6 (APP); you are transmitting on 120.3 (TWR)" and the
Radio panel shows that rejection in bold red (`TransmitResult.offFrequency`, `data-off-frequency`). `fixList(state)` passes every navaid
and fix of `airport.navaids` (ids and names such as CEDAR LAKE) except ILS/LOC/DME entries to `parseTransmission`.
`RADAR_CONTACT` is accepted with an empty readback: the pilot says nothing, the session's pilot sink drops empty text (never queued for TTS),
and the engine log shows the ATC call only.

## Voice wiring

Per session: `createVoiceController` (PTT key/mode from settings, hold-to-talk button bound with `ptt.bindButton`), `createPilotVoice`
(browser TTS + radio clicks), `createTranscriptLog`. PTT down -> `pilots.setControllerTransmitting(true)`; final transcript -> `transmit()`.
Status (`unsupported`, `permission_denied`, `listening`, `processing`, `error`, off) is explained in plain language in the Radio panel
(`lib/voiceStatus.ts`). Typed input is always available and uses the same pipeline. With voice off nothing opens the microphone.

## Displays

* **Surface** (north-up): aprons, taxiway pavement and centrelines (UNNAMED dimmer, toggleable), taxiway identifiers every ~400 m rotated to the line and
  de-duplicated, runway polygons tinted by occupancy (green free / amber occupied or cleared onto / red conflict), runway numbers at the correct thresholds
  (rotated along the runway axis, kept upright for legibility, not pilot-view), yellow hold lines with runway id, parking dots (names when zoomed in), HS 1, ARP,
  scale bar, compass, OSM attribution. Aircraft are oriented glyphs sized by category (true-to-scale when zoomed in), data labels with leader lines and greedy
  non-overlap placement, cyan selection ring, planned taxi route (bold for the selected aircraft, faint for others) with red hold-short markers, 60 s trails,
  conflict rings. Wheel zoom (0.05-8 px/m), drag pan, click select, follow toggle, Fit.
* **Radar** (north-up TRUE, compass rose labelled MAGNETIC): 5/10/20/40/60 NM (60 shows VCN, SIE, ...), range rings, runways to scale, extended centrelines with 1 NM ticks for the active landing
  runways, ACY/VCN/SIE/CYN (and other VORs in range), approach fixes CARYL MAYBN STEVV PRSTY SMITS (all fixes optional), airborne data blocks
  (callsign/type, altitude in hundreds with trend arrow, ground speed, magnetic heading, phase), ground targets dimmed, history dots, cosmetic sweep drawn under the targets.
  IFR additions: the **instrument procedure of each active landing runway** (`lib/procedures.ts`: ILS first, then RNAV/LOC/VOR; ILS 13 CARYL MAYBN,
  ILS 31 STEVV PRSTY, RNAV 22 KOPCE FLDER EFEWY, RNAV 4 JEDOB FASEN TEMVE) is drawn as the on-course fixes (filled triangles, IF / FAF tags, feeders such
  as VCN stay ordinary navaids) with the extended final approach course out to the IF, labelled with the procedure ("ILS 13"). The **selected
  aircraft's active route** is a dashed violet line through the fixes still ahead (faint on vectors). Data blocks add the squawk once assigned and a
  mode letter: **V** vectors (incl. an IFR aircraft on a heading), **R** route / direct, **A** approach (cleared or flying it). A radar-identified target
  carries a centre dot. The top-left **All fixes** button (also in Layers) shows every fix in the data; layers "Procedure fixes" and "Selected aircraft
  route" can be switched off. **MVA layer** (`airport.mvaSectors`, polygons in local metres): sector outlines with the altitude in hundreds at the centroid, drawn at 20 NM and wider when the layer is on and the airport data has sectors (nothing is drawn when the field is absent; the KACY dataset has none yet).

* **Surface**: NASR LAHSO hold-short points (`RunwayEnd.lahso.holdShortPoint.pos`, KACY runways 4, 13, 31) are short magenta ticks across the landing runway labelled "LAHSO" (`lahsoMarks`).

## Aircraft panels

* **Aircraft list**: callsign, type, DEP/ARR, IFR/VFR, squawk, frequency, phase, nav letter, RADAR ID mark, IFR clearance / approach summary, and a
  descriptive blinking badge for the pending request: REQ IFR CLNC, REQ APPROACH, CHECK-IN (`OTHER`), REQ TAXI, REQ DEPARTURE, REQ LANDING,
  REQ FREQ CHG (`lib/ifr.ts requestBadge`).
* **Aircraft details**: flight rules, squawk, radar identification, next fix and navigation ("Route to CARYL", "Direct VCN", "Approach ILS 13 (MAYBN)",
  "Vectors, heading 105 · intercepting ILS 13"), the approach clearance with its **established** state (derived from the open APPROACH clearance and the
  final-course geometry; the engine keeps `approach` private), the issued **IFR clearance** (destination, DP, maintain, expect, departure frequency,
  squawk), the flight plan route with the current fix highlighted, active clearances and the pending request.
* **Cleared approach**: published fix altitudes from `procedure.fixAltitudes` (matching the cleared approach type/runway) are listed in the approach box ("CARYL at or above 2,000 · MAYBN at 1,500"); nothing shows when the data has none. A landing clearance that carries `holdShort` shows a magenta badge "LAHSO: hold short 13/31, 3,550 ft available" (`RunwayEnd.lahso`).
* **Strips tab** (right column, next to "Aircraft"): flight-progress-strip view grouped in one bay per frequency (CLNC, GND, TWR, APP/DEP; bays you do not
  work are dimmed and tagged "not worked"): callsign, type, rules, squawk, origin to destination, runway, mode letter, phase or request badge and the
  clearance summary / route. Test ids `fps-<callsign>` and `bay-<mhz>` (the list keeps `strip-<callsign>`).

## Keyboard

PTT key (default Space, configurable) · Enter focus command box · Esc deselect / close drawer · 1 / 2 Surface / Radar · + / - zoom (radar: range) · P pause.

## Tests

`npm test -- src/ui` (unit) and `npx playwright test` (e2e; starts `npm run dev` and `npm run server` unless already running, so live weather and the chart proxy work).
`node e2e/shoot.mjs` / `node e2e/shoot-extra.mjs` / `node e2e/shoot-ifr.mjs` regenerate `docs/screenshots/` (the dev server and backend must be running;
`shoot-ifr.mjs` makes `approach.png`, `strips.png`, `setup-ifr.png`). Playwright flows cover IFR free play on All positions (Approach check-in, ILS clearance
readback, radar contact with no pilot reply), the Clearance Delivery lesson (`train-08-ifr-clearance`: IFR clearance readback with the departure and squawk,
then "Not on frequency" once the pilot is on Ground) and the Strips tab / 60 NM radar / All fixes. Do not run the `chromium-fake-mic` project for UI work.

## Limitations

See "Not yet implemented" in docs/PROGRESS.md: no real-microphone automation, no mobile layout, pilot voice not radio-filtered, no weather/airspace overlays on the radar.
IFR display: the radar draws only on-course fixes of one procedure per runway end (no feeders, holds, missed approaches or altitude restrictions); the final course
equals the runway heading (as the engine flies it); "established" is inferred by the UI from geometry; `nav.index` fixes behind the aircraft are not drawn.
