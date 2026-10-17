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
src/ui/components/      TopBar, AircraftPanel, AircraftDetails, RadioPanel, CommsLog, AlertsStrip, Banners, VoiceSettingsForm
src/ui/drawers/         Charts (ChartViewer), Navaids (NavaidPanel), Settings, ATIS, Weather and runways
src/ui/screens/         SetupScreen, SimScreen, DebriefScreen
src/ui/lib/             format.ts (data-block and heading/time formatting), geom.ts, provenance.ts, voiceStatus.ts
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

## Transmission pipeline (`commands/transmit.ts`)

`transmit({engine, text, source, controller})`: parse with ALL aircraft in the context (so "not on frequency" can be reported); if the callsign is
ambiguous, retry with only aircraft on the controller's frequencies; apply each command with `engine.applyCommand(cmd, {position, source, transmissionId})`
(one id per transmission so the engine logs the ATC call once); stop at the first `clarify`. The engine itself emits the pilot readback or
"say again" through `onPilotTransmission`; the UI never speaks them a second time. Tower + Ground uses, per command, the position whose frequency
the addressed aircraft is on. Frequencies always come from `airport.frequencies`.

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
* **Radar** (north-up TRUE, compass rose labelled MAGNETIC): 5/10/20/40 NM, range rings, runways to scale, extended centrelines with 1 NM ticks for the active landing
  runways, ACY/VCN/SIE/CYN (and other VORs in range), approach fixes CARYL MAYBN STEVV PRSTY SMITS (all fixes optional), airborne data blocks
  (callsign/type, altitude in hundreds with trend arrow, ground speed, magnetic heading, phase), ground targets dimmed, history dots, cosmetic sweep drawn under the targets.

## Keyboard

PTT key (default Space, configurable) · Enter focus command box · Esc deselect / close drawer · 1 / 2 Surface / Radar · + / - zoom (radar: range) · P pause.

## Tests

`npm test -- src/ui` (unit) and `npx playwright test` (e2e; starts `npm run dev` and `npm run server` unless already running, so live weather and the chart proxy work).
`node e2e/shoot.mjs` / `node e2e/shoot-extra.mjs` regenerate `docs/screenshots/`.

## Limitations

See "Not yet implemented" in docs/PROGRESS.md: no real-microphone automation, no mobile layout, pilot voice not radio-filtered, no weather/airspace overlays on the radar.
