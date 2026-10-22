# src/ui - React application

Dark, ATC-styled single-page app. Everything the player sees is here; every simulation fact comes from the engine.

```
src/App.tsx             routes setup -> sim -> debrief from the store
src/ui/store/
  simStore.ts           zustand store; startSession / endSession / playAgain; owns ONE Session; strip actions (strike / drop)
  session.ts            framework-free Session: engine + rAF loop + render buffer + voice + AI controllers + strip board + ATIS + scenario-event runner
  uiStore.ts            drawer, layers, radar range, follow, typed-command draft, phone section / tab, viewBus (zoom shortcuts)
  layoutStore.ts        panel layout (persisted) + pop-out windows; see "Panels, layout and pop-out windows"
  voiceSettings.ts      the persisted voice settings store + hook
src/ui/commands/transmit.ts   text -> parseTransmission -> engine.applyCommand (voice AND typed)
src/ui/commands/landline.ts   text -> parseLandline -> engine.coordination.request / respond / rescind / inform (the landline)
src/ui/lib/landline.ts        pure view model of the Landline panel (incoming, asked, given, log, quick requests)
src/ui/display/
  surfaceRenderer.ts / radarRenderer.ts   pure Canvas 2D drawing (stub-context testable)
  surfaceStatic.ts      taxiway label placement, runway numbers, hold marks (per airport, cached)
  viewTransform.ts      world<->screen, zoom/pan/fit; labels.ts placement + hit tests; renderBuffer.ts interpolation
  SurfaceDisplay.tsx / RadarDisplay.tsx   canvases + overlay controls; useCanvasLoop.ts
src/ui/strips/stripModel.ts   pure strip board model (bays, print / move on handoff, marks from accepted clearances, sequence, strike, drop, notes)
src/ui/layout/         panel system: layoutModel.ts (pure model, presets, persistence format), panelMeta.ts (ids, titles, minimum sizes), panelRegistry.tsx
                        (id -> component), Workspace.tsx (desktop regions), GroupView.tsx (tabbed frame), MobileShell.tsx (phone), LayoutMenu.tsx,
                        PopoutHost.tsx / popupWindow.ts (pop-out windows), windows.ts (window registry), PopupNotices.tsx
src/ui/components/      TopBar, AircraftPanel, AircraftDetails, FlightStrips (the board), RadioPanel, LandlinePanel, CommsLog, AlertsStrip, Banners, VoiceSettingsForm, SpeakerIcon
src/ui/drawers/         Charts (ChartViewer), Navaids (NavaidPanel), Settings, ATIS, Weather and runways
src/ui/screens/         SetupScreen, SimScreen, DebriefScreen
src/ui/lib/             format.ts (data-block and heading/time formatting), geom.ts, provenance.ts, voiceStatus.ts,
                        positions.ts (controller position sets), ifr.ts (flight plan / nav / clearance / badge helpers),
                        procedures.ts (instrument-procedure geometry for the radar)
src/ui/references.ts    verified JO 7110.65 paragraph table (mirror of docs/FAA-REFERENCES.md)
```

## Panels, layout and pop-out windows (`ui/layout/`)

**Registry.** `PANEL_IDS` = `surface radar tower list strips details comms alerts landline radio charts navaids atis weather settings`. `panelMeta.ts` gives each an id, title, minimum
size, default pop-out size, home region and phone section; `panelRegistry.tsx` maps the id to its component. Every panel component reads the shared zustand stores (or the
session's engine) directly, so it renders identically in a docked tab, a pop-out window and a drawer. Inside a frame a `Panel` drops its own title (`PanelFrameContext`) and keeps only a slim readout row.

**Regions.** The main window below the top bar (which keeps the title, speed controls, status strip, **Layout** menu, Charts / Navaids / Settings, ATIS and Runways) has three regions:
a **main display** area, a **right column** and a **bottom row**. A region holds *groups*; a group is a set of tabs (`PanelGroup { tabs, active }`). In the right column groups stack
top to bottom (Aircraft / Strips, then Details, which stays collapsed under the strip board exactly as before: `details-toggle`); in the bottom row they sit side by side (Comms / Alerts, Radio).
Charts, Navaids, ATIS, Weather and Settings are hidden by default and open as drawers from the top bar; the same drawer has a pop-out button, and the Layout menu can dock them as tabs.
An alert count chip in the status strip (and a badge on the Alerts tab) keeps conflicts visible when the Alerts tab is not showing. The right column width and bottom row height are drag handles
(double-click resets).

**Layout menu** (`layout-menu`): presets **Tower cab** (Tower view + strips + radio), **Ground** (Surface + aircraft list + comms + radio), **TRACON** (Radar + strips + radio), **Everything**
(the original layout), a row per panel (checkbox = shown / hidden, region select, pop-out), Reopen windows, Dock all windows, Reset layout. Each frame also has a pop-out button and a "..." menu (move to
another region, pop out, hide). Keys **1 / 2 / 3** reveal Surface / Radar / Tower wherever they are (activate the tab, raise the window, or on a phone switch the bottom-bar section).

**Persistence.** The layout (`regions`, `sizes`, `popouts`) is saved to localStorage `kacy.layout.v1` on every change and validated on load (`parseLayout`: unknown panels dropped, duplicates removed,
sizes clamped, wrong version or bad JSON -> the default layout, at least one display always present). Bump `LAYOUT_VERSION` and the key suffix together when the format changes.

**Pop-out windows.** `layoutStore.popOut(id)` calls `window.open('', 'kacy-atc-<id>', 'popup,width=..,height=..,left=..,top=..')` from the click, writes a dark, full-height `#root` into the empty document, copies
every `<style>` and `<link rel=stylesheet>` from the main head and keeps them in sync with a MutationObserver (new nodes, changed text: Vite HMR and Tailwind's injected styles), and `PopoutHost` renders the panel into
that root with `createPortal`. The popup therefore shares the React tree, zustand stores and the single simulation of the main window: nothing is serialised or sent between windows. A popped-out panel disappears from
the main layout and returns to the region it came from when the window closes (`beforeunload` / `unload` / `pagehide`, with a `closed` poll as a Safari fallback) or when "Dock" is pressed. All pop-outs close when the
main window unloads and when the session ends.

* **Keyboard and push-to-talk in a popup.** `windows.ts` is a registry of every simulator window; `addWindowListener` / `onEachWindow` attach a handler to the main window and to each popup. The 1/2/3, +/-, Esc, P, Enter, S/X
  shortcuts, Esc in drawers, the PTT-key capture in Settings and the tower camera keys all use it. `PushToTalk.attachTarget(win)` (src/voice/ptt.ts) adds the same hold/toggle key handlers and blur release to a popup, wired in `SimScreen`.
* **Canvases in a popup.** `useCanvasLoop` and the tower view size the canvas against the *container's own window* (`ownerDocument.defaultView`): that window's `devicePixelRatio`, its `ResizeObserver` and its
  `requestAnimationFrame`. Pointer and wheel listeners are attached to the canvas element itself, so they work on any document. Limitation: the simulation clock and the render buffer run on the main window's frame loop, so keep the
  main window visible (not minimised or fully covered) while the popups are in use; browsers throttle timers in hidden windows.
* **Reopen windows.** The geometry (`x, y, w, h`) and home region of each open pop-out is saved. After a reload (or a new session) the panels are docked as usual and a notice offers **Reopen windows** (also in the Layout
  menu), because browsers refuse to open windows without a click. Browsers usually allow about one pop-up per click, so with several windows press it again for the rest.
* **Popup blocker.** `window.open` returning null shows the `popup-blocked` notice (allow pop-ups for this site and try again); the panel stays where it was.

## Landline panel (`components/LandlinePanel.tsx`, `lib/landline.ts`, `commands/landline.ts`)

Panel id `landline`, in the bottom row next to Comms / Alerts (Ground, Everything presets) or with Radio (Tower cab, TRACON); on a phone in the Comms section. Its tab shows an amber badge with the number of requests waiting for the player
(`landline-badge`), and an AI call for the player rings through the controller voice path (`AiTransmission.channel: 'landline'` -> `QueuedTransmission.channel`, a two-tone ring instead of the PTT clicks; `radioEffects.playLandline`,
WebAudio only). Sections: **Waiting for you** (`landline-incoming`: who asks what; Approve / Unable / Stand by, labelled Released / Hold for release for a departure release and Point out approved / Unable for a point out;
for a crossing a "behind the landing ..." select with **Approve after** for arrivals inbound; **Take back** for an approval or release you gave that nobody used), **You asked** (`landline-outgoing`: status pill per request - waiting, stand by, approved with seconds left, unable,
taken back, expired - plus one-click requests for aircraft that wait for a call you have not made: an aircraft at a hold line asking to cross, an IFR departure ready without a release), the **Log** (`landline-log`, "Mine" / "All calls", AI calls violet,
plain-words wording tagged "plain"), a typed call box (`landline-input`) and the **Landline mode** toggle.

* **Talking.** Hold the landline key (default `L`, `voiceSettings.landlineKey`, changed in Settings next to the PTT key; works in pop-out windows) and speak, or toggle Landline mode (everything spoken / typed goes to the landline),
  or just start a call with two position names - "Tower, Ground, ..." in the typed box or by voice is always a landline call (`looksLikeLandline`). The result line of the Radio panel says "Landline: ...".
* **Session API** (`session.ts`): `submitLandline(text, source)`, `getLandlineMode / setLandlineMode`, `answerRequest(id, answer, { afterAircraftId })`, `rescindRequest(id)`; the hook `onLandlineResult`. The session tells the engine who is human / AI (`coordination.setStaffing`).
* The AI's landline speech is audible only when it is for a position you work (or "Monitor all frequencies", quieter); it is in the transcript as `TWR (AI) > GND: ...`.

## Responsive shell

Below **1024 px** (`COMPACT_QUERY`, `useCompact`) the right column and bottom row collapse: the display fills the screen and a bottom tab bar switches one section at a time: **Display** (Surface / Radar / Tower tabs),
**Aircraft** (Aircraft / Strips / Details), **Comms** (Comms / Alerts), **Radio** (radio, PTT, command box). Test ids `mobile-shell`, `mtab-display|aircraft|comms|radio`. A large push-to-talk bar (`ptt-dock-button`, 56 px) and a
"Type" shortcut sit above the tab bar on every section except Radio; the Radio panel's own PTT is 48 px tall. The top bar becomes a title row plus a wrapping status strip, with Charts / Navaids / Settings / End session
in a Menu. The app root is as tall as `visualViewport.height` (CSS variable `--app-h`, falling back to `100dvh`), so the typed-command box stays above the on-screen keyboard; inputs are 16 px on coarse pointers so iOS does not zoom.
Setup and Debrief use 16 px gutters, single columns and no fixed widths below `sm`. At 1024 px and above the desktop regions are used; the layout was checked at 360, 390, 768, 1024, 1440 and 2560 px with no horizontal overflow.

**Touch.** Surface, Radar and Tower share `display/pointerGestures.ts` (Pointer Events only): one pointer drags (pan / look), two pointers pinch (Surface zoom about the midpoint, Radar steps the range, Tower field of view),
a short press selects (larger hit radius for touch); the mouse wheel and +/- keys are unchanged. Canvases use `touch-action: none`.

**Look.** Console chrome rather than web cards: gradient title bars with inset highlights (`.atc-titlebar`, `.atc-tab`, `.atc-iconbtn` in ui.css), square borders, uppercase small labels, tabular numerals, a status strip
under the title row, phosphor green / amber accents from the existing palette. `prefers-reduced-motion` stops blinking, pulsing and sliding.

## One authoritative state

The engine's `SimulationState` is mutated in place and is the only copy of aircraft data. React components read it through
`useSimState()` after subscribing to `rev`, a counter the session bumps about 10 times a second (and immediately after every
command). Nothing copies aircraft into `useState`. The canvases do not use React at all: every animation frame they read
`engine.getState()` directly.

**Smooth motion.** The engine steps at 10 Hz of sim time. `renderBuffer.ts` snapshots poses each time `clock.tick` changes and
the renderers draw the pose interpolated between the last two snapshots (heading along the shortest arc), one snapshot interval
behind the engine. The rAF loop caps the wall delta at 0.25 s; `engine.advance` does the fixed stepping and speed.

## Session start (`simStore.startSession`)

0. `unlockAudio()` first, synchronously inside the "Start session" click (before any await): resumes the page's AudioContext and primes
   speech synthesis with a silent utterance, because browsers refuse audio before a user gesture. "Play again" in the debrief is a click too.
1. Weather: live -> `fetchLiveMetar('KACY')`; failure -> simulated "Clear" preset plus a visible warning notice. Preset -> `getPresetWeather`.
   Scenario default -> the scenario's own weather (and `'live'` scenarios are treated as live). The METAR is applied with `engine.setWeather`
   because the engine substitutes calm weather for `'live'`.
2. `game.buildScenario` / `game.buildFreePlay` (both receive `playerPositions` = the positions the player picked) -> the `Scenario` is passed to
   `createEngine` AS-IS (it carries events, difficulty, aircraft types, `controllerPositions` = every position that exists, `playerPositions`)
   with `game.createTrafficGenerator`.
3. `createScenarioEventRunner` is updated once per frame; its pilot calls go to the same voice queue. A scripted wind shift re-issues the ATIS
   (when `atisNeedsUpdate`) and shows a notice; **active runways are never changed automatically** (top bar "Runways" opens the Weather and
   runways drawer, which calls `engine.setActiveRunways` and re-issues the ATIS).
4. ATIS: `generateAtis` ("Atlantic City", initial letter from the UTC hour, `nextAtisLetter` on change). Always labelled SIMULATED. "Listen" speaks
   it through the TTS provider.
5. Training: `game.createTrainingController(scenario)` gets every command outcome (`onCommand`) and state update; the banner shows prompt,
   explanation, reference, feedback and `TRAINING_DISCLAIMER`.
6. `endSession` -> `game.buildDebrief(state)`; career scenarios also `game.saveCareerResult`.

## "I work": one position for the player, AI for the rest (`lib/positions.ts`, `store/session.ts`)

Eight selectable sets, all frequencies read from `airport.frequencies` (never constants): Clearance Delivery (CLNC 127.85), Ground, Tower,
Tower + Ground, **Approach + Departure** (APP and DEP, both 124.6 at KACY; one chip labelled `APP/DEP`), Departure only, **Approach + Tower**
and **All positions** (TWR, GND, CLNC, APP, DEP). The first position of a set is the primary one given to the engine
(`setControllerPosition`). The choice is the **player's** positions (`scenario.playerPositions`). `scenario.controllerPositions` stays the
full set of positions that exist in the session; **every one of them the player does not work is run by an AI controller**
(`aiPositionsFor(controllerPositions, playerPositions)`), unless the setup checkbox "AI controllers work the other positions" is off (then
those frequencies stay empty and aircraft on them are "not on frequency", as before).

* **Setup** (section "I work"): lists each choice with what it does and its frequencies, says explicitly **"AI works: Tower, Approach/Departure"**
  for the selected scenario and choice (`data-testid="ai-works"`), tags every choice with what AI would take over ("AI works TWR"), and defaults to the
  position the scenario is about: ready-made career/training scenarios read `scenario.playerPositions` (`game.defaultPlayerPositions`, e.g.
  `train-02-taxi` and `career-05-ground-taxi` default to Ground only with AI Tower; `train-09-approach` / `career-08-ifr` to Approach + Departure);
  free play defaults to Tower with AI on the rest (`TWR` + AI `GND`; all five positions exist with **IFR flows**, which still adopt All positions).
  Any default can be overridden.
* **Session**: `session.ts` calls `createAiControllers({ engine, airport, positions: ai positions, playerPositions, onTransmission, seed })` (src/ai),
  calls `ai.update(state)` on **every engine step** (an `engine.subscribe` listener with a tick guard, so the AI's own commands never re-enter it)
  and disposes it with the session. Changing the position in the Radio panel rebuilds the AI for the new complement. A failure to create or update
  the AI shows a notice and the session continues.
* **Radio panel**: "I work" select; one chip per frequency **the player works** (the only workable ones); a small **Other positions (AI)** panel under
  it lists each AI position with its frequency and `ai.status()` text (`TWR·AI 120.3 TWR (AI): 2 aircraft, last: ...`; APP and DEP sharing 124.6 are one row).
  With no AI the panel is replaced by "No AI positions".
* **Comms log**: engine events carrying `aiPosition` are tagged `TWR·AI` (violet); the engine's frequency-change event that follows an AI "contact ..."
  call is tagged and prefixed `HANDOFF` (`aiHandoffs`). Aircraft on an AI frequency carry an `AI` tag in the Aircraft list.
* **Strips**: bays of AI positions are dimmed and titled `TWR·AI`, see "Flight strips".

The Radio panel shows one chip per distinct frequency of the active set. A chip lights `RX` (green: pilot call came in) or `TX`
(cyan: your transmission) for 6 s of sim time after the latest call on it, and the most recent one keeps a `last RX/TX` tag; the data comes
from the engine event log (`lastActivity`). With the microphone off (`Mic off`) the status and "Heard" lines are hidden.

## Pilot audio (what makes pilots audible)

The badge `MIC OFF` / `READY` / ... is about speech **input** only. Whether pilots are *heard* is the separate **Pilot audio: on/off** switch in the Radio
panel (speaker icon, lamps while a transmission plays; `data-testid="pilot-audio"`, `data-speaking`), which is `voiceSettings.ttsEnabled` (default **on**); next to it
**Monitor all** (`monitorAll`, default off) and, under the switch, a one-line state (`speaking · NKS451`, `muted`, `no voices loaded`, `no speech support`).
Settings has the same switch, "Monitor all frequencies", and a **Play test call** button that reports the number of voices.

* **Autoplay policy**: `unlockAudio()` runs inside the Start click (see "Session start"): AudioContext resumed, speech primed.
* **Voices load asynchronously in Chrome** (`getVoices()` is empty at first, `voiceschanged` later): the first `speak()` waits (bounded, 2 s) for them so every
  pilot gets its own voice profile (`assignVoice(voiceId)`: voice + rate + pitch, deterministic per aircraft).
* **Which frequencies are audible**: the queue is told the whole set at once (`setMonitoredFrequencies`): all of the player's frequencies (Tower + Ground
  together), plus, with Monitor all, every frequency of a position in the session, at volume `MONITOR_ALL_VOLUME` (0.45) times the user's volume. Previously
  each call retargeted a single monitored frequency, which dropped calls waiting on the other one.
* **AI controllers** speak through the same queue (`onTransmission` -> `spokenText`, `voiceId` e.g. `atc-twr`): audible when on a frequency the player works
  (e.g. AI Approach sharing 124.6 with a player's Departure) or with Monitor all. The pilots answering an AI also need Monitor all.
* **Stuck PTT**: `pilots.setControllerTransmitting(true)` cannot silence pilots forever: a key still down after 30 s is released by a watchdog, the voice status
  going `idle`/`error` releases it, and the PTT's own blur handler releases it when the window loses focus. Speech that never reports back is abandoned after 60 s.
* **No cancellation from React**: speech lives in the framework-free `Session` (nothing in a component calls `cancel`); only the Pilot audio switch (off),
  a step-on by the controller's own transmission, or leaving the session cut speech. In-flight utterances are also held in a module-level set (Chrome drops an
  utterance whose object was garbage collected, with no `end`).
* **Observable**: in non-production builds (and in production with localStorage `kacy.debug.tts=1`) `window.__kacyTts` records `voices`, `started` / `ended`
  (texts), `errors` and `spoken[]` (text, utterance, voice, rate, pitch, volume, start/end times, outcome). `e2e/pilot-tts.spec.ts` uses it in real Chrome.

## Flight strips (`strips/stripModel.ts`, `components/FlightStrips.tsx`)

The Strips tab is a strip board: **one bay per position** (CLNC, GND, TWR, APP/DEP; only positions that exist in the session). The player's bays carry a cyan rule and `you`;
AI bays are dimmed, violet and titled `TWR·AI`. The model is pure and framework-free (`createStripBoard`), kept per session in `session.strips` and updated with the
state (~10 Hz and after each command).

* **Print and move**: a strip is printed (short cyan highlight, `data-entry="print"`) into the bay of the frequency the aircraft is on when it first appears, and
  **moves** to the end of the new bay (slide-in with an amber flash, `data-entry="move"`, `fromBay`) when the aircraft changes frequency: a handoff by the player or by an AI.
  Aircraft already on the rack when the session opens are not animated. A strip whose aircraft left stays (greyed, `left`) at the bottom until dropped; finished strips
  are capped at 8 per bay.
* **Layout** (like an FAA strip): callsign, type/equipment (`C172/G`, `A320/L`, a simulator assumption), flight rules, squawk, print time (Zulu `HHMMZ`), origin → destination,
  assigned runway, assigned / requested altitude, route fixes, a request badge or the phase, the marks, and an inline **notes** field kept in the board for the session
  (survives handoffs and re-renders; uncontrolled input, `strip-notes-<callsign>`).
* **Marks** come from `Aircraft.clearances`, i.e. only what the engine accepted: `C 13` cleared for the approach, `CTL 13` cleared to land, `LAHSO 13`, `LUAW`, `CTO 13`,
  `T/O 1203Z` (liftoff, as seen by the board), `L 1210Z` (touchdown), `X 13/31` cross, `H/S 13` hold short, `TX A D`, `HDG 090`, `SPD 180`, `DCT VCN`, `GA`, `MA`, `HP`, `CLR`.
  Altitudes go in the altitude box, frequency changes move the strip. The **Strip marking** legend (button at the foot of the board, `STRIP_LEGEND`) lists them.
* **Controls**: click selects the aircraft; **drag the ⠿ grip** to resequence inside a bay (HTML5 drag and drop, drop on the upper / lower half; `Alt+↑/↓` on a focused strip does
  the same); **S** strikes the selected strip (strike-through, `handled`, drops to the bottom of its bay; again to restore); **X** drops a struck strip or one whose aircraft has left (otherwise a
  hint says why not). S and X work while the Strips tab shows. A dropped strip of an aircraft that is still there is not reprinted until the aircraft changes bay.
* Aircraft details sit behind a collapsed bar under the board (`details-toggle`) so the board gets the column.

## Special traffic setup

* **Setup** (free play, under "Aircraft types"): a "Special traffic" group with one checkbox per kind (`special-helicopter`, `special-military`, `special-transition`, `special-training`, `special-vehicles`), only the kinds `availableSpecialKinds(icao)` returns (KACY all five, KMHT and KPGD VFR transitions and vehicles). Labels and hints come from `SPECIAL_TRAFFIC_LABELS`; the initial state is the previous setup's `freePlay.specialTraffic`, else `defaultSpecialTraffic(icao)`, and it resets to the new airport's defaults when the airport changes. The selection goes out as `FreePlayOptions.specialTraffic` (`resolveSpecialTraffic`, so a kind the airport lacks is always off).
* **Tower view models, radar and surface symbols**: see the Displays section below and `tower/README.md`.

## Airport state in the UI (`lib/airportStatus.ts`, `components/AirportNotices.tsx`, `display/closureMarks.ts`)

* **Setup**: "Close a runway" / "Close a taxiway" (for the whole session; the recommended runway skips a closed one, its end options are disabled), "Airport events" (free play: seeded inspections, taxiway closures, bird activity, pilot light requests; on by default). They become `FreePlayOptions.closures` / `airportEvents`; the store copies the closures onto catalogue scenarios and passes `startUtcMs` for the season weighting of the bird event.
* **Session** (`store/session.ts`): `syncAirportOps` runs about once a second (and right after a `closure` / `birds` scenario event): when the runway in use is closed the active runways switch to the best open runway (`store/runwayConfig.ts`, a warning notice), and the ATIS gets a new letter when `atisUpdateReasons` (weather observation, runways, closures, braking action worse, bird activity, condition codes) says so. The hourly HH:55Z letter now runs only for simulated weather in real-time mode (live weather has real observation times: `weather/observation.ts`).
* **Strips**: a NOTAM bar above the bays lists active closures with the minutes left (`ClosureBar`); a STAR clearance prints `STAR` / `DV` (descend via) in the strip's instruction column. **Weather & Runways**: "Airport conditions" block (closures, derived runway condition, braking action, RVR, lights step, birds), closed ends are marked and "Use recommended" excludes them.
* **Surface view**: a closed runway has a yellow wash and a yellow X at each end (AC 150/5370-2G 2.18.2.1.2); a closed taxiway a yellow wash and X marks along it (`drawClosures`). **Tower view** (src/ui/tower/README.md): the same markings as flat meshes, and the runway edge light brightness follows the light step (`runwayLightLevel`).

## Transmission pipeline (`commands/transmit.ts`)

`transmit({engine, text, source, controller})`: parse with ALL aircraft and ALL fixes in the context (so "not on frequency" can be reported
and "proceed direct Cedar Lake / CARYL" resolves); if the callsign is ambiguous, retry with only aircraft on the controller's frequencies;
apply each command with `engine.applyCommand(cmd, {position, source, transmissionId})` (one id per transmission so the engine logs the ATC
call once); stop at the first `clarify`. The engine itself emits the pilot readback or "say again" through `onPilotTransmission`; the UI
never speaks them a second time. With several positions active, `positionFor` picks per command the position whose frequency the addressed
aircraft is tuned to (positions sharing a frequency, APP/DEP, are interchangeable). An aircraft on a frequency the player does not work is
sent to the primary position, so the engine rejects "Not on frequency: X is on 124.6 (APP); you are transmitting on 120.3 (TWR)" and the
Radio panel shows that rejection in bold red (`TransmitResult.offFrequency`, `data-off-frequency`). **An aircraft on a frequency an AI controller works**
(`ControllerSetup.aiPositions`, and not also one of the player's frequencies) is refused before the engine: "NKS451 is with AI Tower on 120.3; wait for the handoff."
(`TransmitResult.aiBlocked`, `data-ai-blocked`, violet; a SYSTEM warning in the log; no pilot reply, nothing scored). `fixList(state)` passes every navaid
and fix of `airport.navaids` (ids and names such as CEDAR LAKE) except ILS/LOC/DME entries to `parseTransmission`.
`RADAR_CONTACT` is accepted with an empty readback: the pilot says nothing, the session's pilot sink drops empty text (never queued for TTS),
and the engine log shows the ATC call only.

## Voice wiring

Per session: `createVoiceController` (PTT key/mode from settings, hold-to-talk button bound with `ptt.bindButton`), `createPilotVoice`
(browser TTS + radio clicks, see "Pilot audio"), `createTranscriptLog`. PTT down -> `pilots.setControllerTransmitting(true)`; final transcript -> `transmit()`.
Status (`unsupported`, `permission_denied`, `listening`, `processing`, `error`, off) is explained in plain language in the Radio panel
(`lib/voiceStatus.ts`). Typed input is always available and uses the same pipeline. With the microphone off (`Mic off`) nothing opens it; pilots are still heard unless Pilot audio is off.

## Displays

* **Surface** (north-up): aprons, taxiway pavement and centrelines (UNNAMED dimmer, toggleable), taxiway identifiers every ~400 m rotated to the line and
  de-duplicated, runway polygons tinted by occupancy (green free / amber occupied or cleared onto / red conflict), runway numbers at the correct thresholds
  (rotated along the runway axis, kept upright for legibility, not pilot-view), yellow hold lines with runway id, parking dots (names when zoomed in), HS 1, ARP,
  scale bar, compass, OSM attribution. Aircraft are oriented glyphs sized by category (true-to-scale when zoomed in), data labels with leader lines and greedy
  non-overlap placement, cyan selection ring, planned taxi route (bold for the selected aircraft, faint for others) with red hold-short markers, 60 s trails,
  conflict rings. Special traffic (`display/symbols.ts`, `specialMark`): the helicopter glyph is a slim cabin and tail boom with a rotor cross of two blade bars, the F-16 a cropped-delta silhouette outlined in the military gold (`C.military`), an airport vehicle a small chamfered box with a cab window and an amber dot; a flight of two shows `F16x2` in the label (`typeTag`). Wheel zoom (0.05-8 px/m), drag pan, click select, follow toggle, Fit.
* **Radar** (north-up TRUE, compass rose labelled MAGNETIC): 5/10/20/40/60 NM (60 shows VCN, SIE, ...), range rings, runways to scale, extended centrelines with 1 NM ticks for the active landing
  runways, ACY/VCN/SIE/CYN (and other VORs in range), approach fixes CARYL MAYBN STEVV PRSTY SMITS (all fixes optional), airborne data blocks
  (callsign/type, altitude in hundreds with trend arrow, ground speed, magnetic heading, phase), ground targets dimmed, history dots, cosmetic sweep drawn under the targets. Helicopters are a rotor disc with a cross instead of the square, military aircraft a double gold square; airport vehicles are never drawn or picked on the radar (`hitTestAircraft(..., includeVehicles = false)`).
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
* **Strips tab** (right column, next to "Aircraft"): the flight progress strip board, see "Flight strips". Test ids `fps-<callsign>`, `bay-<CLNC|GND|TWR|APPDEP>` (`data-owner` player / ai),
  `strip-notes-<callsign>`, `strip-grip-<callsign>`, `strip-mark` (the list keeps `strip-<callsign>`).

## Keyboard

PTT key (default Space, configurable) · Enter focus command box · Esc deselect / close drawer · 1 / 2 / 3 Surface / Radar / Tower (all of these also work while a pop-out window has focus) · + / - zoom (radar: range) · P pause · **S** strike / **X** drop the selected strip (Strips tab showing).

## Tests

`npm test -- src/ui src/game src/voice` (unit: layout model / store / pop-out helper, strip model, transmit AI refusal, session AI wiring and audio routing with a fake AI and a fake speech provider, comms-log AI tags,
positions, queue / TTS audibility) and `npx playwright test --project=chromium` (e2e, including `e2e/layout.spec.ts`: pop-out window, presets / moves, 390 px phone layout, touch gestures, overflow at 360 / 768 / 1024 / 1440 / 2560 px; starts `npm run dev` and `npm run server` unless already running).
When another session is editing `src/` the dev server hot-reloads and resets a running simulator; run against a production build instead (the live-weather calls then go through the preview
server's `/api` proxy because the backend allows only the 5173 origin):

```bash
VITE_API_BASE=http://localhost:5174 npx vite build
E2E_PREVIEW=1 E2E_PORT=5174 npx playwright test --project=chromium          # the app flows (strips, AI Tower / Ground-only, setup, IFR)
E2E_PORT=5174 npx playwright test --project=chrome-pilot-tts                  # pilots really spoken in installed Google Chrome (see src/voice/README.md)
```

`node e2e/shoot.mjs` / `node e2e/shoot-extra.mjs` / `node e2e/shoot-ifr.mjs` regenerate `docs/screenshots/` (`BASE_URL=...` picks the server; `shoot-ifr.mjs` makes `approach.png`, `strips.png`,
`strips-legend.png`, `setup-ifr.png`; `shoot.mjs` uses real Chrome with pilot audio on at volume 0). Playwright flows cover IFR free play on All positions, the Clearance Delivery lesson, the strip
board (marks and times, notes, S / X, drag resequencing, legend), the setup "I work" / "AI works" line and the **Ground-only session with AI Tower** (an arrival is printed in the `TWR·AI` bay, a call to it is
refused, the AI clears it to land and hands it off, the strip moves to the Ground bay with its note). Do not run the `chromium-fake-mic` project for UI work.

## Limitations

See "Not yet implemented" in docs/PROGRESS.md: no real-microphone automation, phone layout is a tab bar (one panel at a time), pilot voice not radio-filtered, no weather/airspace overlays on the radar.
IFR display: the radar draws only on-course fixes of one procedure per runway end (no feeders, holds, missed approaches or altitude restrictions); the final course
equals the runway heading (as the engine flies it); "established" is inferred by the UI from geometry; `nav.index` fixes behind the aircraft are not drawn.
