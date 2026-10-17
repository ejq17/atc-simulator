# KACY ATC Simulator — project goal
## Complete Project Goal & Development Instructions

### 1. Project Overview

I want you to design, architect, and develop a realistic, modern, interactive **Air Traffic Control (ATC) simulation game**, initially focused exclusively on **Atlantic City International Airport (KACY)** in New Jersey.

This should be a high-quality aviation simulation that combines:

- Realistic air traffic control procedures.
- Accurate, real-world airport layouts.
- Advanced voice-to-text recognition.
- Natural aviation phraseology understanding.
- Intelligent AI-controlled aircraft.
- Realistic pilot radio communications.
- Interactive radar and airport surface displays.
- Actual FAA charts and navigation information.
- Weather, ATIS, and changing airport conditions.
- Training scenarios and progressively challenging gameplay.

The ultimate goal is to create an experience where I can sit at my computer, put on a headset, launch the simulator, and realistically operate as an air traffic controller at KACY.

**This should be a functioning aviation simulator, not a website that merely looks like an ATC system.**

The aircraft must actually move, react to instructions, communicate over simulated radio frequencies, follow airport procedures, and interact with one another.

I should be able to use my voice as the primary way to control aircraft.

The experience should emphasize aviation realism, but it should remain accessible and enjoyable as a game.

This is a single-player simulation intended for entertainment and learning, not certified ATC training or operational aviation use.

---

# 2. Core Development Philosophy

Follow these principles throughout development.

### Realism First

Use real FAA data wherever practical.

KACY must not be represented by an invented airport layout.

Real runways, taxiways, intersections, navigation aids, frequencies, airport features, and procedures should be incorporated into the simulation.

If certain information is unavailable, investigate alternative reliable sources rather than inventing it.

Clearly identify any simplified or approximate elements.

### Functionality Over Appearance

An attractive interface is important, but functionality takes priority.

A beautiful radar screen with aircraft that cannot properly respond to ATC instructions is not an acceptable finished product.

Likewise, a working microphone that converts speech to text but cannot control aircraft is not sufficient.

The core gameplay loop must function.

### Modularity

Build the application using a modular architecture.

Separate the following systems:

- Aircraft simulation
- Airport data
- Air traffic control logic
- Speech recognition
- Command interpretation
- Pilot responses
- Voice synthesis
- Radar rendering
- Ground movement
- Weather
- Scenarios
- Scoring and training

Avoid large files containing unrelated systems.

Each component should be independently testable.

### Performance

The simulator must run smoothly on modern Windows and macOS computers.

The rendering engine must not interfere with voice processing or aircraft simulation.

Avoid unnecessary dependencies, excessive server infrastructure, and expensive API usage.

### Extensibility

KACY is our only initial airport.

However, the architecture should eventually support additional airports without requiring us to rewrite the core simulation engine.

Do not build multi-airport support yet. Simply avoid unnecessary assumptions that would prevent it later.

---

# 3. Platform and Technology

## Recommended Platform

Build the first version as a browser-based application.

The experience should primarily target desktop computers.

A native desktop version may eventually be created using Tauri, but this is not a priority.

### Preferred Technology Stack

| System | Technology |
|---|---|
| Frontend | React |
| Language | TypeScript |
| Build system | Vite |
| Styling | Tailwind CSS |
| Simulation engine | TypeScript |
| 2D visualization | PixiJS or Canvas |
| 3D visualization | Three.js, eventually |
| Real-time communication | WebSockets where necessary |
| Speech recognition | Deepgram or equivalent |
| AI interpretation | Deterministic parser + optional LLM |
| Speech synthesis | Browser TTS initially, cloud TTS optional |
| Local storage | IndexedDB |
| Testing | Vitest and Playwright |

These are starting preferences, not mandatory dependencies.

Evaluate the technical requirements before selecting additional libraries.

Keep the architecture as lightweight as possible.

### Local-First Simulation

Aircraft movement, traffic logic, runway occupancy, and most gameplay systems should run locally.

Do not require a cloud backend simply to simulate aircraft positions.

Cloud services should primarily handle optional speech recognition, advanced AI interpretation, or high-quality speech synthesis.

The game should remain usable with typed commands if speech services are unavailable.

---

# 4. Realistic KACY Airport Implementation

Our first airport is:

**Atlantic City International Airport — KACY**

The airport must be modeled using authoritative information.

## Airport Data Requirements

Research, retrieve, and validate the following:

1. Airport coordinates and elevation.
2. Runway 04/22.
3. Runway 13/31.
4. Runway thresholds and headings.
5. Runway dimensions.
6. Taxiway names and geometry.
7. Runway holding positions.
8. Runway intersections.
9. Airport parking and apron areas.
10. Relevant airport buildings.
11. Airport hot spots.
12. Instrument approach procedures.
13. Navigational aids and fixes.
14. ATC communication frequencies.
15. Relevant airport operational information.

Use the current applicable FAA publications.

### Official Sources

Start with:

**FAA Terminal Procedures and Airport Diagrams**

https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/

**FAA Aeronautical Data and Products**

https://www.faa.gov/data/aero_data

**FAA NASR Data**

https://www.faa.gov/air_traffic/flight_info/aeronav/Aero_Data/NASR_Subscription/

**FAA Digital Chart Supplement**

https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dafd/

**FAA ATC Procedures**

https://www.faa.gov/air_traffic/publications/atpubs/atc_html/

The system should record the source, publication date, and effective date of airport information.

### Important Airport Geometry Requirements

A static FAA airport diagram is not enough to support realistic aircraft movement.

Create an actual geographical representation of the airport.

The data model should contain:

- Runway centerlines and boundaries.
- Taxiway centerlines and segments.
- Taxiway intersections.
- Holding positions.
- Parking positions.
- Runway entry and exit points.
- Runway-crossing points.

Construct a connected ground-movement graph.

Aircraft must follow valid taxi routes rather than moving in straight lines between arbitrary points.

Use geographic coordinates and convert them into a consistent local coordinate system for simulation.

If a complete machine-readable KACY taxiway dataset is unavailable, investigate reputable open geospatial sources and reconcile them with the FAA diagram.

Where necessary, create a manually verified dataset from the official diagram.

Do not fabricate missing taxiways.

Document any geometry that remains approximate.

---

# 5. Airport Visualization

Develop a professional interactive airport display.

This will be one of the application's main interfaces.

## Surface Display

The airport surface display should include:

- Accurate runway geometry.
- Accurate taxiway geometry.
- Taxiway identifiers.
- Runway numbers.
- Parking locations.
- Moving aircraft.
- Aircraft labels.
- Ground movement routes.
- Holding positions.
- Runway occupancy indicators.
- Selected aircraft information.
- Conflict notifications.

The display should support:

- Zooming.
- Panning.
- Clicking aircraft.
- Following selected aircraft.
- Displaying planned taxi routes.
- Showing aircraft movement history.
- Switching visual layers.

Aircraft should be positioned using their actual simulated coordinates.

Movement should be smooth rather than jumping between predefined points.

## Radar Display

Create a separate radar-inspired view.

Features should include:

- Aircraft target symbols.
- Callsigns.
- Altitude.
- Groundspeed.
- Heading.
- Vertical trend.
- Ground tracks.
- Range rings.
- Selected aircraft highlighting.
- Traffic information.
- Approach paths.

The display should support different ranges and configurable information layers.

It should resemble a functional ATC radar display rather than a decorative circular animation.

Historical radar sweeps may be added for visual realism, but they must not reduce usability.

---

# 6. Voice Communication System

**This is one of the highest-priority components in the entire project.**

The game needs to reliably understand aviation instructions spoken into a microphone.

Ordinary dictation is not sufficient.

The voice system needs to recognize and interpret ATC phraseology.

## Push-to-Talk

Implement a configurable push-to-talk system.

Example:

Hold a keyboard key to transmit.

While transmitting:

- Capture microphone audio.
- Display the active transmission state.
- Show live or partial transcription.
- Recognize when the transmission ends.
- Interpret the completed instruction.
- Send the command to the simulation engine.

The default control should be configurable.

The system must gracefully handle microphone permission errors and unsupported devices.

## Speech Recognition

Research available speech recognition services, including:

- Deepgram.
- OpenAI realtime transcription.
- Local Whisper-based models.
- Browser-native transcription where supported.

Evaluate accuracy, latency, cost, and suitability for ATC speech.

Prioritize recognizing:

- Aircraft callsigns.
- Aviation phonetic alphabet.
- Numbers spoken in aviation phraseology.
- Runway identifiers.
- Taxiway identifiers.
- Headings.
- Altitudes.
- Frequencies.
- Clearances.
- Common aviation terminology.

Build a speech recognition provider abstraction so the transcription engine can be replaced without rewriting the rest of the application.

## Aviation Command Interpretation

After transcription, interpret the instruction.

Example transmission:

> "Spirit four fifty one, runway one three, cleared for takeoff."

Expected structured interpretation:

```json
{
  "callsign": "NKS451",
  "command": "TAKEOFF_CLEARANCE",
  "runway": "13",
  "confidence": 0.98
}
```

The confidence value is illustrative. The system must calculate or calibrate confidence appropriately rather than fabricate a value.

Another example:

> "Cessna seven two three Echo Juliet, taxi to runway two two via Alpha, hold short of runway one three."

Expected interpretation:

```json
{
  "callsign": "N723EJ",
  "command": "TAXI",
  "destination": "RWY22",
  "route": ["A"],
  "holdShort": ["RWY13"]
}
```

This example is illustrative, not a verified KACY taxi route. Actual route names and validity must be checked against the imported airport geometry.

### Command Processing Pipeline

Implement the following:

**Audio → Transcription → Normalization → Command Parsing → State Validation → Execution → Pilot Response**

The command parser must understand multiple valid variations of ATC instructions.

Do not implement the entire command system using hardcoded exact sentence matches.

Use a structured grammar with aviation-specific entities and aliases.

An LLM may assist with ambiguous or unfamiliar phrasing, but it must return a constrained structured command.

The deterministic simulation engine must validate the command before execution.

Never allow an LLM to directly modify aircraft position or override safety rules.

If the system cannot confidently interpret a command, ask for clarification.

Never silently guess a runway, callsign, or clearance.

## Initial Supported Commands

Implement support for:

- Taxi instructions.
- Hold position.
- Hold short.
- Runway crossing clearance.
- Line up and wait.
- Cleared for takeoff.
- Cleared to land.
- Go around.
- Continue approach.
- Contact Ground.
- Contact Tower.
- Frequency changes.
- Basic heading instructions.
- Basic altitude instructions.
- Speed adjustments where applicable.

Some commands will require additional simulation functionality and can be implemented after the initial gameplay loop.

Each command should have clear validation rules.

---

# 7. Aircraft Simulation Engine

Aircraft must operate as simulated entities.

Do not represent aircraft as icons that simply follow pre-scripted animations.

Each aircraft should have an actual state.

## Aircraft Data

Each aircraft needs:

- Unique identifier.
- Callsign.
- Aircraft type.
- Origin.
- Destination.
- Current position.
- Current heading.
- Current altitude.
- Current airspeed and groundspeed.
- Vertical speed.
- Flight phase.
- Assigned runway.
- Current frequency.
- Current clearance.
- Active route.
- Pilot communication state.
- Aircraft performance parameters.

## Initial Aircraft

Start with:

**Cessna 172**

For general aviation and traffic pattern operations.

**Airbus A320**

For commercial arrival and departure operations.

Additional aircraft should eventually include regional jets, helicopters, and military aircraft.

Do not attempt to recreate full flight simulator physics.

Use believable simplified aircraft performance models.

## Aircraft Movement

Aircraft must realistically accelerate, decelerate, turn, taxi, take off, climb, descend, approach, land, and stop.

Movement should be continuous.

Aircraft should not instantly rotate to a new heading or jump to a destination.

Use simplified performance limitations for different aircraft types.

### Departure State Machine

```text
PARKED
   ↓
PUSHBACK / READY
   ↓
TAXIING
   ↓
HOLDING SHORT
   ↓
LINE UP AND WAIT
   ↓
CLEARED FOR TAKEOFF
   ↓
TAKEOFF ROLL
   ↓
INITIAL CLIMB
   ↓
DEPARTURE
```

### Arrival State Machine

```text
INBOUND
   ↓
APPROACH
   ↓
FINAL
   ↓
LANDING CLEARANCE
   ↓
LANDING
   ↓
ROLLOUT
   ↓
RUNWAY EXIT
   ↓
GROUND CONTROL
   ↓
TAXI TO PARKING
```

Actual aircraft behavior must depend on the issued clearance and current conditions.

Not every phase should require a new instruction, but aircraft must never invent clearances they have not received.

---

# 8. Ground Control Simulation

Ground control should eventually become a substantial part of the game.

An aircraft should be able to begin at a valid parking location and request taxi instructions.

The controller must issue a route using actual KACY taxiways.

## Ground Routing

Implement pathfinding over the airport's taxiway graph.

Requirements:

- Follow valid taxiway connections.
- Respect taxiway direction restrictions where applicable.
- Avoid inaccessible surfaces.
- Stop at holding positions.
- Recognize aircraft ahead.
- Prevent ground collisions.
- Account for runway crossings.
- Respect assigned routes.
- Stop when instructed.

An aircraft must not automatically cross a runway simply because that runway lies along its taxi route.

Runway crossing clearances must be explicit and associated with a specific runway.

## Runway Safety

Develop a runway occupancy model.

Track:

- Aircraft entering runways.
- Aircraft waiting for departure.
- Aircraft taking off.
- Aircraft landing.
- Aircraft exiting runways.
- Aircraft crossing runways.
- Aircraft holding short.

The game must identify conflicting operations.

Implement alerts for potential runway incursions.

Unsafe instructions should be identified by the simulation engine, with appropriate behavior depending on whether the user is playing in training or challenge mode.

Refer to FAA JO 7110.65 for relevant procedural requirements.

---

# 9. Intelligent Pilot Communications

Aircraft should communicate naturally with the controller.

Pilot voices must not all sound identical.

Different aircraft should be able to request different actions depending on their current state.

## Examples

An aircraft may call:

> "Atlantic City Ground, Cessna seven two three Echo Juliet, at general aviation parking, ready to taxi, VFR departure."

After receiving a taxi instruction:

> "Runway two two via Alpha, hold short of runway one three, Cessna seven two three Echo Juliet."

When ready:

> "Atlantic City Tower, Cessna seven two three Echo Juliet, holding short runway two two, ready for departure."

The exact communications should follow valid phraseology and reflect the scenario.

## Pilot Response System

Use a hybrid architecture.

Routine communications should be generated through deterministic templates and structured aircraft state.

Optional AI-generated responses may add variety.

However, generated responses must remain consistent with aircraft state and assigned clearances.

Pilots should not spontaneously claim they received instructions that were never issued.

## Pilot Readbacks

Aircraft should repeat important clearance details.

Implement validation for:

- Callsigns.
- Runway assignments.
- Hold-short instructions.
- Takeoff clearances.
- Landing clearances.
- Headings.
- Altitudes.
- Frequencies.

Eventually, introduce occasional realistic readback mistakes.

The controller should be expected to identify and correct them.

---

# 10. Radio System

Implement a simulated ATC radio communication system.

KACY should have appropriately configured communication frequencies using verified airport data.

Include:

- ATIS.
- Ground.
- Tower.
- Clearance Delivery.
- Approach.
- Departure, where appropriate.

Frequencies must come from verified airport data rather than invented values.

## Frequency Behavior

Aircraft should only hear relevant transmissions on their assigned frequencies.

Controllers must be able to switch frequencies.

An aircraft transferred from Tower to Departure should no longer respond to Tower instructions after completing the handoff.

Implement radio communication states:

```text
IDLE
RECEIVING
TRANSMITTING
WAITING_FOR_READBACK
```

Later, add:

- Radio congestion.
- Simultaneous transmissions.
- Blocked transmissions.
- Missed calls.
- Pilot clarification requests.

## Voice Output

Use speech synthesis for pilot communications.

Initially, browser TTS is acceptable.

However, the architecture should support higher-quality cloud speech synthesis later.

Voice output should include optional:

- Radio frequency filtering.
- Subtle background static.
- Transmission start/end sounds.
- Different pilot voices.

Do not sacrifice speech clarity for sound effects.

All communication must remain entirely inside the simulator. Never connect to or transmit on real aviation radio frequencies.

---

# 11. Weather and ATIS

Implement realistic aviation weather.

The simulator should support:

1. Simulated weather.
2. Optional live KACY weather.

## Live Weather

Use the Aviation Weather Center API.

Documentation:

https://aviationweather.gov/data/api/

Retrieve appropriate KACY METAR information.

Display:

- Wind direction.
- Wind speed.
- Gusts.
- Visibility.
- Cloud conditions.
- Altimeter setting.
- Temperature.
- Relevant weather phenomena.

Respect API rate limits and use backend requests or caching where necessary.

The Aviation Weather Center API does not currently permit browser CORS requests, so design the integration accordingly.

Live observations should be treated as inputs to the simulation, not evidence that the simulation represents live airport operations.

## Simulated Weather

Allow players to choose weather conditions.

Examples:

- Clear weather.
- Light crosswinds.
- Strong winds.
- Low visibility.
- Rain.
- Thunderstorms.
- Instrument meteorological conditions.

Weather should influence aircraft behavior and available gameplay options.

## Simulated ATIS

Generate a simulated ATIS broadcast from the game's current weather and runway configuration.

Include a rotating information identifier.

Display the current ATIS information in the interface.

The player should be able to listen to the broadcast.

Clearly label it as simulated rather than live airport ATIS.

---

# 12. FAA Charts and Navigation Aids

Implement a chart-viewing system.

The user should be able to access real FAA aeronautical charts relevant to KACY.

Initially support:

- Airport diagram.
- Instrument approach charts.
- Relevant departure procedures.
- Relevant arrival information.
- Airport information.

Later expand to:

- Sectional charts.
- Enroute charts.
- Additional procedure references.

The chart viewer should support zooming, panning, and navigation between documents.

## Navigation Aids

Include verified nearby navigation aids and instrument approach elements.

Examples of supported categories:

- VORs.
- DMEs.
- ILS facilities.
- Localizers.
- RNAV waypoints.
- Instrument approach fixes.

Only display facilities and capabilities that have been verified from appropriate aeronautical data.

Do not assume that every KACY runway has an ILS or that every historical navigation aid remains operational.

Initially, navigation aids can be displayed as reference information.

Later, they should become part of the aircraft routing and approach simulation.

---

# 13. User Interface and Visual Design

I want the simulator to feel like a professional aviation application.

Avoid generic SaaS dashboard styling.

The interface should be visually immersive, functional, and realistic.

## Visual Direction

Use a dark ATC-inspired appearance.

Recommended elements:

- Dark charcoal backgrounds.
- Muted radar greens.
- Aviation cyan.
- Amber or yellow warnings.
- Red critical alerts.
- High-contrast text.
- Precise typography.
- Minimal decorative elements.

Use color intentionally to communicate aircraft status and operational information.

### Main Layout

The application should include:

**Top Bar**

Airport name, simulation time, weather, ATIS information, runway configuration, and session controls.

**Main Display**

Radar or airport surface visualization.

**Aircraft Panel**

A list of active aircraft, including callsigns, states, and pending requests.

**Radio Panel**

Current frequency, microphone status, push-to-talk controls, and received transmissions.

**Aircraft Details**

Selected aircraft information, including active clearance and assigned route.

**Communications History**

A chronological log of transmitted and received messages.

**Chart Viewer**

A way to open FAA airport diagrams and procedures without leaving the simulator.

### Interaction

Clicking an aircraft should select it.

Selected aircraft should be highlighted across all displays.

The interface should make it easy to inspect an aircraft while continuing to monitor traffic.

Support multiple panels without overwhelming the user.

The first version should prioritize desktop use, while remaining reasonably responsive on smaller displays.

---

# 14. Game Modes

Implement the following modes progressively.

## Free Play

The player can configure:

- Aircraft count.
- Traffic density.
- Weather.
- Runway configuration.
- Aircraft types.
- Starting scenario.
- Difficulty.
- Simulation speed.

The experience should run continuously until the player ends the session.

## Career Mode

Create progressively more challenging scenarios.

Example progression:

1. First radio transmission.
2. Single-aircraft takeoff.
3. Single-aircraft landing.
4. Multiple departures.
5. Ground taxi procedures.
6. Traffic pattern operations.
7. Multiple arrivals and departures.
8. IFR traffic.
9. Mixed aircraft performance.
10. Runway changes.
11. Complex airport traffic.
12. Emergency scenarios.

## Training Mode

Create an educational mode.

Training should explain:

- Correct phraseology.
- Clearance requirements.
- Runway safety.
- Communication procedures.
- Aircraft sequencing.
- Common mistakes.

When the player makes an error, explain why.

Where possible, reference the relevant FAA procedures.

Do not present simplified simulation behavior as a substitute for real-world ATC training.

---

# 15. Traffic Generation

Build a traffic generation system.

The simulator should generate believable aircraft operations.

Traffic should include:

- Arrivals.
- Departures.
- General aviation.
- Commercial aircraft.
- Eventually military aircraft.

Aircraft should not all appear simultaneously.

Traffic should develop naturally based on the scenario.

For example:

An arriving aircraft contacts Approach.

Another aircraft requests taxi.

A departing aircraft reports ready.

A landing aircraft needs to exit the runway.

The controller must manage the interactions between these aircraft.

## Traffic Difficulty

Traffic intensity should increase progressively.

Start with one or two aircraft.

Eventually support larger traffic loads where controller workload becomes a meaningful challenge.

Aircraft spawning must not create unavoidable conflicts.

---

# 16. Scoring and Session Debriefing

Implement meaningful performance tracking.

Measure:

- Aircraft handled.
- Correct clearances.
- Communication errors.
- Runway incursions.
- Separation violations.
- Unnecessary delays.
- Average aircraft wait time.
- Incorrect readbacks missed.
- Unsafe instructions.
- Scenario completion.

Prioritize safety over efficiency.

At the end of each session, generate a report.

The report should summarize performance and identify opportunities for improvement.

Include an event timeline that allows important moments to be reviewed.

Eventually support replaying recorded sessions.

---

# 17. Simulation Architecture

Create a deterministic simulation engine.

Use a fixed simulation update interval with interpolation for rendering.

Do not tie simulation correctness to browser frame rate.

## Main Entities

Define structured models for:

```text
Airport
Runway
Taxiway
TaxiwayNode
HoldingPosition
ParkingPosition
NavigationAid
Aircraft
AircraftPerformance
FlightPlan
Clearance
RadioFrequency
ControllerPosition
Weather
SimulationEvent
Scenario
```

## Simulation State

Maintain one authoritative simulation state.

Avoid duplicated aircraft state scattered across React components.

The UI should subscribe to simulation state updates.

## Command Processing

All actions should pass through a centralized command processor.

Example:

```text
User Transmission
        ↓
Speech Recognition
        ↓
Command Interpretation
        ↓
Aircraft Identification
        ↓
Clearance Validation
        ↓
State Transition
        ↓
Aircraft Behavior
        ↓
Pilot Readback
        ↓
UI Update
```

Implement robust error handling.

Every accepted, rejected, or ambiguous command should produce an appropriate response.

## Deterministic Behavior

Support reproducible scenarios using seeded randomness.

This will make it possible to recreate bugs and test complex traffic situations.

---

# 18. Security and Privacy

Protect user data and API credentials.

Requirements:

- Never expose cloud API secrets in frontend code.
- Use a lightweight backend for sensitive provider authentication.
- Use HTTPS for deployed microphone features.
- Do not store microphone recordings by default.
- Make any recording or transcription history controls explicit.
- Provide a fallback if transcription services fail.
- Avoid unnecessary tracking.
- Avoid third-party analytics initially.
- Document external services and potential costs.
- Respect rate limits for public aviation data sources.
- Review licensing and redistribution conditions for downloaded data.

The application should be usable locally during development.

Never ask the user to commit API keys to Git.

---

# 19. Testing Requirements

Testing is critical because the application combines voice recognition, aviation instructions, aircraft movement, and safety logic.

Implement automated tests for the simulation engine.

## Command Parsing Tests

Test:

- Callsign recognition.
- Spoken numbers.
- Runway identifiers.
- Taxiway identifiers.
- Altitudes.
- Headings.
- Multiple commands.
- Incorrect phraseology.
- Ambiguous instructions.
- Missing callsigns.
- Invalid commands.

Include at least 100 representative aviation phraseology examples in the parser test suite.

## Aircraft Behavior Tests

Verify:

- Aircraft follow authorized routes.
- Aircraft stop at holding positions.
- Aircraft obey runway assignments.
- Aircraft respond to takeoff clearances.
- Aircraft respond to landing clearances.
- Aircraft obey go-around instructions.
- Aircraft respect performance limits.
- Aircraft do not teleport between positions.

## Safety Tests

Verify:

- Conflicting runway operations are identified.
- An aircraft does not cross a runway without specific clearance.
- Invalid taxi routes are rejected.
- Aircraft cannot execute impossible state transitions.
- Duplicate or stale commands do not accidentally execute twice.
- Uncertain voice interpretations do not become clearances automatically.

## Interface Tests

Use browser automation to verify essential gameplay workflows.

Test real interactions, not just isolated components.

---

# 20. Development Phases

I do not want you to attempt every feature simultaneously.

Develop the project incrementally, but build toward the complete vision.

## Phase 1 — Foundation

Create the application architecture.

Implement:

- React frontend.
- TypeScript simulation engine.
- Core aircraft model.
- KACY airport configuration.
- Basic airport visualization.
- Simulation clock.
- Aircraft movement.
- Basic communication panel.
- Typed commands.
- Automated tests.

**Goal:** A working airport display with aircraft that respond to typed clearances.

## Phase 2 — Voice Control

Implement:

- Microphone access.
- Push-to-talk.
- Streaming transcription.
- Aviation-specific phrase interpretation.
- Callsign identification.
- Command validation.
- Pilot readbacks.
- Speech synthesis.

**Goal:** Control an aircraft entirely through spoken ATC instructions.

## Phase 3 — Ground and Tower Operations

Implement:

- Verified airport taxiway graph.
- Ground routing.
- Hold-short points.
- Runway crossing clearances.
- Takeoff operations.
- Landing operations.
- Runway occupancy.
- Conflict detection.
- Multiple aircraft.

**Goal:** Run realistic KACY Tower and Ground sessions.

## Phase 4 — Airport Systems

Implement:

- FAA chart viewer.
- Navigation aid information.
- Live weather integration.
- Simulated weather.
- ATIS.
- Frequency management.
- IFR operations.
- Arrival and departure routing.

**Goal:** Make the simulation feel like operating at the actual airport.

## Phase 5 — Gameplay

Implement:

- Free Play.
- Training Mode.
- Career Mode.
- Traffic generation.
- Difficulty progression.
- Scoring.
- Session debriefing.
- Scenario management.

**Goal:** Turn the simulator into an enjoyable, replayable game.

## Phase 6 — Advanced Features

Consider:

- Three-dimensional tower view.
- More aircraft types.
- Military operations.
- Emergency scenarios.
- Improved pilot AI.
- Advanced radio behavior.
- Replay tools.
- Desktop packaging.
- Additional airports.

These features are not necessary for the initial release.

---

# 21. First Playable Milestone

The first important milestone is a complete voice-controlled takeoff interaction.

### Scenario

Load KACY with a Cessna 172 holding short of a departure runway.

The player opens the microphone and says:

> "Cessna seven two three Echo Juliet, runway one three, cleared for takeoff."

The system must:

1. Capture the microphone transmission.
2. Transcribe the spoken instruction.
3. Identify N723EJ.
4. Recognize the takeoff clearance.
5. Identify Runway 13.
6. Check the aircraft's position and readiness.
7. Verify that the clearance can be safely executed.
8. Apply the clearance.
9. Generate a realistic pilot readback.
10. Begin the aircraft's runway-entry and takeoff behavior as appropriate.
11. Animate the takeoff roll.
12. Transition the aircraft to initial climb.
13. Update the radar display.
14. Record the event in the communications and simulation logs.

The player should then be able to clear another aircraft to land.

### Milestone Success Criteria

The first version is successful when:

- KACY loads with verified runway geometry.
- At least two aircraft can be simulated.
- Aircraft move smoothly.
- The microphone works.
- Spoken instructions can be interpreted.
- Commands modify the actual simulation.
- Pilot readbacks are generated.
- Runway occupancy is tracked.
- Invalid clearances are identified.
- The experience can be completed without using a command menu.

A typed-command fallback must remain available.

The simulator should work without requiring user accounts or a paid database.

---

# 22. Quality Expectations

The application should feel like a serious independent software project.

I expect:

- Clean, maintainable code.
- Consistent UI design.
- Accurate aviation terminology.
- Realistic interactions.
- Good performance.
- Appropriate automated testing.
- Helpful error messages.
- Clear documentation.
- No unnecessary infrastructure.
- No fabricated aeronautical information.

Do not create fake functionality merely to make a demonstration appear complete.

If a button is visible, it should do something meaningful.

If an aircraft receives a clearance, it should react appropriately.

If a chart is labeled as an official FAA chart, it must actually represent the official source.

If a feature is not implemented, clearly mark it as unavailable rather than pretending it works.

---

# 23. Your Instructions as the Development Agent

You are responsible for taking this project from concept to a functioning application.

**Do not simply respond with a development plan and stop. Begin implementation.**

Follow this workflow:

### Step 1 — Inspect the Environment

Determine whether an existing project or codebase is present.

If one exists, inspect the architecture, dependencies, existing functionality, and current development status before modifying anything.

Do not overwrite an existing project unnecessarily.

If the repository is empty, initialize a new application.

### Step 2 — Research

Research the relevant FAA data, KACY airport geometry, navigation information, simulation requirements, and available development libraries.

Prefer official sources.

Identify any technical limitations or data availability issues.

Do not fabricate sources, airport geometry, or operational procedures.

### Step 3 — Architecture

Create a concise architectural document describing:

- Major components.
- Data models.
- Simulation engine.
- Voice processing pipeline.
- Rendering approach.
- Development phases.
- External services.
- Important technical decisions.

Explain significant tradeoffs.

Avoid spending excessive effort documenting features that are not yet implemented.

### Step 4 — Implement

Begin creating the actual application.

Start with the first playable milestone.

Build real functionality rather than placeholders.

Implement the simulation engine independently from the visual interface.

Use testable modules.

### Step 5 — Test

Run available automated tests.

Fix errors rather than leaving them unresolved.

Test the application in a browser when the development environment permits.

Check that the interface is usable and that aircraft state changes are reflected visually.

### Step 6 — Iterate

Continue through the planned development phases.

Prioritize functionality that improves the core ATC experience.

Do not prioritize decorative features over broken simulation behavior.

### Step 7 — Document Progress

Maintain a project progress document containing:

- Completed features.
- Current work.
- Known issues.
- Features not yet implemented.
- Technical decisions.
- Data sources.
- Recommended next steps.

Clearly distinguish completed work from planned functionality.

---

# 24. Definition of Done

The eventual complete simulator should allow me to launch the application, select KACY, configure a scenario, connect my microphone, and operate as a simulated air traffic controller.

I should be able to communicate with aircraft using recognizable aviation phraseology.

Aircraft should respond verbally and physically execute valid clearances.

The airport's runways and taxiways should accurately represent KACY.

I should be able to manage departures, arrivals, taxiing, runway crossings, and aircraft sequencing.

The simulator should contain authentic FAA charts, navigation information, realistic weather, and simulated airport communications.

The system should recognize incorrect instructions, identify safety conflicts, and provide useful feedback.

The gameplay should become progressively more challenging without sacrificing realism.

**Most importantly, it must feel like I am controlling aircraft at a real airport, rather than clicking buttons in a fictional aviation-themed interface.**

---

## Final Instruction

Start by researching and validating the KACY airport data, establishing the technical architecture, and implementing the first playable prototype.

Make sensible technical decisions independently.

Avoid unnecessary complexity, expensive infrastructure, and excessive dependencies.

Prioritize:

**Real airport → Real aircraft movement → Working voice control → Real ATC instructions → Realistic aircraft responses → Complete gameplay.**

Do not stop at mockups, documentation, or theoretical architecture.

Build a working simulator, test it, and progressively expand its functionality.

---