# src/sim - deterministic simulation engine

Pure TypeScript (no DOM). `createEngine(opts)` implements `SimulationEngine` from `api.ts` over the
shared contracts in `types.ts`. Everything airport-specific comes from the `Airport` object; nothing in
here knows about KACY. Tests run against the synthetic `__fixtures__/testAirport.ts` (placeholder data).

## Files

| File | Role |
|---|---|
| `engine.ts` | `createEngine`: fixed-step loop, accumulator, event log (cap 2000), subscribers |
| `context.ts` | `SimContext` + per-aircraft `AircraftRuntime` (engine-private bookkeeping), `emitEvent`, `pilotSay`, `setPhase` |
| `stateMachines.ts` | Explicit departure/arrival transition table; `canTransition`, `assertTransition` (throws), `tryTransition`, `transitionPath` |
| `pathfinding.ts` | Dijkstra over `TaxiwayGraph` honouring an ordered `via` list; `validateRoute`, `nearestNode`, hold/runway helpers |
| `groundMovement.ts` | Continuous taxi: bounded accel/braking, corner speeds, stop nodes, spacing, parking |
| `flightDynamics.ts` | Takeoff roll, climb/descent, bank-limited turns, wind, approach guidance, flare, rollout, exit, go-around |
| `runwayOccupancy.ts` | `computeRunwayActivity` (pure) + per-tick occupancy, enter/exit events, authorisation expiry |
| `conflicts.ts` | `assessClearanceSafety` (pure) + per-tick incursion/proximity detection |
| `commandExecutor.ts` | `applyCommand` implementation (validation, safety gate, commit, readback) |
| `traffic.ts` | Spawning (incl. `at_fix` arrivals and IFR departures), automatic pilot calls, frequency-change application, despawn, `TrafficGenerator` interface |
| `navigation.ts` | Lateral navigation over fixes: fix lookup (`Airport.navaids`), `distanceToFixNm`, `bearingToFixMag`, fly-by sequencing (`advanceNav`, `turnLeadM`) |
| `approach.ts` | Instrument / visual approach analysis: procedure classification, `assessApproach` (route join, intercept geometry, weather, range) |
| `ifr.ts` | IFR clearance defaults (DP name from `airport.procedures`, squawk assignment) |
| `scoring.ts` | `ScoreCard` maintenance and the score formula |
| `geo.ts`, `rng.ts`, `performance.ts`, `runways.ts` | Math, mulberry32 PRNG, C172/A320 tables, runway geometry |
| `airportCheck.ts` | `checkAirportForSim(airport)`: validates the data contract below |
| `../radio/` | `readback.ts` (phraseology), `spoken.ts` (numbers), `frequencies.ts` (who hears what) |

## The loop

`step()` advances exactly one fixed step (`clock.dtSec`, default 0.1 s). `advance(wallSec)` adds
`wallSec * clock.speed` to an accumulator and runs whole steps (max 2000 per call); subscribers are
notified once per `step()`, once per `advance()` that ran steps, and after every command.

Per tick, in order:

1. due scenario spawns + `TrafficGenerator.update(state)` spawns
2. pending frequency changes applied (CONTACT_FREQUENCY, after the readback delay)
3. **pilot requests** (`traffic.updatePilotRequests`): radio state, missed-readback-error timer, scripted calls
4. **ground movement** (all `onGround` aircraft except TAKEOFF_ROLL / ROLLOUT)
5. **flight dynamics** (airborne aircraft + takeoff roll + landing rollout; fix navigation is part of the airborne step)
6. **runway occupancy**
7. **conflicts**
8. lifecycle (despawn arrivals, departures leaving the area, lost aircraft)
9. **scoring** (consumes the events emitted this tick)
10. clock tick, 1 Hz position history (last 60 kept)

All randomness comes from one `mulberry32(scenario.seed)` stream (`engine.random()`), iteration order is
insertion order, and nothing reads wall-clock time, so `(airport, scenario, seed, command script)` replays
identically (tested: identical state JSON after 600 steps).

## Conventions

* Local frame: x east, y north, metres; altitude ft MSL; headings in state are **TRUE**.
* `Aircraft.target.headingDeg` is a TRUE heading (the executor converts the controller's magnetic heading
  with `Airport.magneticVariationDeg`, east positive: `true = magnetic + variation`).
* Spawn `headingDeg` (airborne) is interpreted as TRUE.
* On the ground `airspeedKt === groundSpeedKt`; after touchdown speeds are ground speeds.
* Taxi graph usage: `holding_position` nodes carry `runwayId` (+ optional `protectsRunwayEnd`),
  `runway` nodes are centreline vertices, edges across/along a runway carry `onRunwayId`; a taxiway named
  `RWY...` means runway travel (back-taxi) and is only routed when named in `via`.

## How to add a command

1. Add the `ClearanceKind`/`CommandKind` to `types.ts` (cross-team change, announce it in `docs/PROGRESS.md`).
2. `commandExecutor.ts`: add required entities to `missingEntities`, write `planX(env): PlanResult`
   returning `{ plan: { patch, commit } }` (validated, not yet applied) or `unable(env, reason, pilotPhrase)`,
   and register it in `PLANNERS`. Mutate state **only** inside `commit`, and change phase only via
   `setPhase`/`advancePhase`.
3. If it can be unsafe, extend `assessClearanceSafety` in `conflicts.ts`.
4. Add readback phraseology in `../radio/readback.ts` (callsign last).
5. Add a test next to the existing ones (`commands.test.ts`, `ground.test.ts`, `flight.test.ts`...).

`applyCommand` pipeline: log ATC transmission -> resolve callsign (null/ambiguous/unknown => `clarify`) ->
frequency check ("Not on frequency" rejection; frequency equality is the rule, so a combined GND/TWR
frequency just works) -> `confidence < 0.6` => clarify; `0.6-0.8` => accept only if every required entity is
explicit; `>= 0.8` may infer the assigned runway -> readback-error correction -> duplicate filter (identical
command within 5 sim-s is ignored with an INFO event and no pilot reply) -> planner -> safety gate -> commit ->
pilot readback (`onPilotTransmission` fires; callers must NOT speak the returned text again).

## Safety model

* **No invented clearances.** Phase changes go through the transition table. `HOLDING_SHORT` can only leave
  via `LINE_UP_AND_WAIT`/`TAKEOFF` (which add the runway to `runwayAuthorizations`) or a new `TAXI`.
* **Runway crossings are explicit.** A `TAXI` route's `stopAtNodeIds` contains every hold position from
  which the route goes ONTO a runway (plus the route end). The aircraft halts there (phase `HOLDING_SHORT`
  for departures) until `CROSS_RUNWAY` for that runway removes the stops and authorises it. A second line of
  defence in `groundMovement` refuses to enter any `runway` node whose runway is not authorised.
  Authorisations expire when the aircraft has used and left the runway.
* **Arrivals** that reach 0.5 nm without a `LAND` clearance (or with another aircraft on the runway, or
  unstable) go around automatically and announce it.
* **Pre-execution assessment** (`assessClearanceSafety`, pure): TAKEOFF / LINE_UP while the runway is
  occupied, another departure rolling / in position, a crossing aircraft cleared, or (TAKEOFF) an arrival
  inside 2 nm final; LAND with the runway occupied / departing / in position; CROSS_RUNWAY in front of a
  departure or an arrival within 3 nm; and simultaneous use of intersecting runways (13/31 vs 4/22).
  * `scenario.mode === 'training'`: rejected (`unsafe: true`), reason cites the JO 7110.65 topic.
  * otherwise: accepted, flagged (`RUNWAY_CONFLICT` + `UNSAFE_CLEARANCE` alerts, `CONFLICT` events), scored.
  * Topics cited (no text quoted): 3-9-6 same runway separation, 3-10-3 landing clearance,
    3-7-2 taxi and runway crossings, 3-9-8 intersecting runway separation. Verify numbering against the
    current edition before shipping; only the first three were specified by the product owner.
* **Dynamic detection** each tick: `RUNWAY_INCURSION` (taxiing/holding aircraft on a runway polygon without
  authorisation), `RUNWAY_CONFLICT` (2+ aircraft on a surface with high-speed traffic), `GROUND_PROXIMITY`
  (< 30 m, parked aircraft excluded), `AIRBORNE_PROXIMITY` (< 1.5 nm and < 500 ft). Alerts are keyed so each
  episode emits one event.
* Ground spacing: stop at `1.5 * max(length) + 20 m` behind an aircraft ahead on the same path.

## Pilot behaviour and readback errors

Scripted calls (all via `radio/readback.ts`): ready to taxi (parked departure, after 3-8 s), holding short
(ready for departure on TWR), holding short of a runway for crossing, inbound with ATIS letter, established on
final, going around, established after a go-around, clear of runway (+ request frequency change / taxi to
parking), check-in after a frequency change. `pendingRequest` is set so the UI can show who is waiting; the
age of the request at the time of the answer feeds `averageWaitSec`.

Readback mistakes (wrong runway or heading digit) are injected from the seeded stream at
`readbackErrorRate` (default 0 in training, 0.08 otherwise; `EngineOptionsExt.readbackErrorRate`). They set
`flags.readbackErrorPending` and `radioState = WAITING_FOR_READBACK`. Re-issuing the correct instruction clears it
(the pilot reads back correctly, no new clearance is created). After 20 s uncorrected it is scored as missed.
The aircraft always executes the clearance that was actually issued.

## Scoring

```
score = clamp(0, 100, 100 - 25*incursions - 15*unsafe - 10*separation - 5*missedReadbacks
                        - 2*commErrors + 2*correctClearances + 5*aircraftHandled)
```

* incursion: `RUNWAY_INCURSION` event; unsafe: `CONFLICT` event with `alertKind = UNSAFE_CLEARANCE` (also when
  training refused it); separation: `SEPARATION_VIOLATION` (ground or airborne proximity);
  commErrors: rejected/clarified commands flagged `commError` (wrong frequency, unknown callsign, aircraft not
  in a position to comply); correct: accepted safe clearance; handled: arrival shut down at parking, or
  departure that left the area after a CONTACT_FREQUENCY handoff.
* `averageWaitSec` = mean age of a pilot request when answered; `totalDelaySec` = sum of waits above 60 s.
* `scenarioCompleted` when `durationSec` elapsed or all scripted traffic has been handled.

* A `COMMAND_ACCEPTED` event with `data.commError` (accepted but improper: takeoff without an IFR clearance outside training,
  approach clearance with improper intercept geometry outside training) adds a communication error and no correct-clearance credit.
* IFR departure handled = left the area after a handoff **and** an altitude / direct / resume instruction (see IFR section).

## Parking destinations

`parkingResolver.ts` resolves a `TAXI`/`TAXI_TO_PARKING` destination by exact id, id without punctuation
("GATE1" -> "GATE-1"), name, then category keyword (GATE/TERMINAL=airline; RAMP/GA/GENERAL AVIATION=ga; FBO;
CARGO/FAA=cargo; ANG/MILITARY=military). A category, "PARKING" or no destination picks the nearest (by taxi
route) UNOCCUPIED spot: the requested category, else the spawn category, else the aircraft's natural one
(airline callsign / large type -> airline, N-number -> ga). Spots occupied by, or already assigned to, another
aircraft are skipped. The chosen id is stored in `Clearance.destination`; the readback says "gate three" or "the ramp".

## IFR operations (Clearance Delivery, Approach, Departure)

Everything is driven by `Airport.navaids` (fixes / VORs with a local-frame `pos`) and `Airport.procedures`
(IAPs with `runwayEnd` + ordered `fixes`, one `DP`). The synthetic fixture has fixes and procedures of the same
shape (`TVO` VOR, `FX13A/B`, `FX22A-C`, ...); `kacyIfr.test.ts` runs the same flows on the real KACY dataset.

### Aircraft state

* `Aircraft.nav = { fixes, index, mode }`: `route` | `direct` | `approach` | `vectors`. `HEADING` sets `mode = 'vectors'`
  and keeps the fix list; `DIRECT_FIX` and `RESUME_OWN_NAVIGATION` re-engage it. `undefined` = no route (holding a heading).
* `flightPlan` (IFR / VFR, origin, destination, cruise, route, `ifrClearance`), `squawk`, `radarIdentified`.
* Engine-private (`AircraftRuntime`): `approach` (cleared approach), `navBeforeVectors`, `passedFixes`, `taxiRequestAtSec`.

### Lateral navigation (`navigation.ts`, used by `flightDynamics.routeGuidance`)

* Flown in phases INBOUND, APPROACH, INITIAL_CLIMB, DEPARTURE, GO_AROUND when `nav.mode !== 'vectors'`.
  Desired heading = bearing to `fixes[index]`, wind-corrected (`headingForTrack`); the turn is the normal bank-limited one.
* Fly-by sequencing: next fix when within `lead = max(0.3 nm, R * tan(turn / 2))`, `R = V / omega` (airspeed, standard turn
  rate of the type), `turn` = angle between the course to the fix and the course fix -> next fix (0 for the last fix). A fix
  behind the aircraft within 2 nm is also sequenced. Unknown fixes are skipped.
* Route exhausted: the aircraft holds its last heading (`target.headingDeg = heading`, `navMode = HEADING`, an INFO event).
  Exception: an exhausted *approach* route hands over to the runway guidance (centreline + glidepath).
* `RESUME_OWN_NAVIGATION`: after vectors, back to what was flown (stored `nav` + `navBeforeVectors`); otherwise the filed
  `flightPlan.route` from the first fix not yet sequenced.
* `DIRECT_FIX`: the fix is looked up by identifier or navaid name ("Cedar Lake" -> VCN). If it is on the current route the
  route is kept (flown on from that fix); otherwise only that fix is flown. Direct to a fix that is not part of a cleared
  approach cancels the approach clearance. Allowed in INBOUND/APPROACH/INITIAL_CLIMB/DEPARTURE/GO_AROUND (a go-around aircraft
  is re-sequenced to APPROACH).

### Arrivals at a fix

`start: { kind: 'at_fix', fix, altitudeFt, speedKt, route, runwayEnd? }`: the aircraft appears over the fix, pointed at
`route[1]`, `nav = { fixes: route, index: 1, mode: 'route' }`, phase INBOUND (-> APPROACH inside 25 nm of the runway end),
on `initialFrequencyId` (APP), IFR with `flightPlan` from the spec (default: IFR, route = spec route, cruise = spawn
altitude), a squawk from the seeded stream, `target.altitudeFt = altitudeFt` (held until cleared otherwise).
First call (instead of the standard "inbound" call): *"Atlantic City Approach, Spirit four fifty one, five thousand,
information alpha."*, pending request `APPROACH`.

### IFR departures (Clearance Delivery -> Ground -> Tower -> Departure)

1. A parked departure whose `flightPlan.flightRules === 'IFR'` calls its spawn frequency (CLNC): *"Atlantic City Clearance,
   Spirit four fifty one, IFR to Philadelphia, with information alpha, ready to copy."* Pending `IFR_CLEARANCE`. VFR
   departures (and IFR specs without a flight plan) behave as before.
2. `IFR_CLEARANCE` (see `ifr.ts`): refused unless the aircraft is PARKED/READY, has an IFR flight plan, has a pending
   `IFR_CLEARANCE` request and no clearance yet. A stated destination must match the flight plan (K prefix ignored);
   `squawk` must be 4 octal digits, not 0000/1200/7500/7600/7700, not in use. Defaults: DP name = first `procedures[].type ===
   'DP'` without "DEPARTURE" (ATLANTIC CITY THREE), initial altitude 2000 (ATLANTIC CITY THREE says maintain 2000), expect =
   cruise, departure frequency = DEP else APP, squawk = seeded unused code. Stored on `flightPlan.ifrClearance` (`readBack:
   true`), `ac.squawk` set.
3. 15 s later (`IFR_TAXI_REQUEST_DELAY_SEC`) the pilot tunes Ground by itself and calls *"... Ground, Spirit four fifty one, at
   Gate one, ready to taxi, IFR departure."* (pending `TAXI`).
4. `TAKEOFF` without an IFR clearance: training -> refused ("no IFR clearance on file"); otherwise accepted, an INFO event, and
   a communication error (`COMMAND_ACCEPTED` with `data.commError`, no "correct clearance" credit).
5. After takeoff: runway heading, climb to `ifrClearance.initialAltitudeFt`. Tower: `CONTACT_FREQUENCY` `frequencyId: 'DEP'`
   (resolves; the id the controller named is kept when APP and DEP share a frequency, so the pilot says "Departure"). Check-in:
   *"Atlantic City Departure, Spirit four fifty one, one thousand two hundred climbing two thousand."* (pending `OTHER`).
6. `RADAR_CONTACT` is informational: `radarIdentified = true`, INFO event, **no pilot transmission** (the outcome's `readback` is
   `''`), clears the pending request. Then `ALTITUDE`, `HEADING`, `DIRECT_FIX`, `RESUME_OWN_NAVIGATION` as usual.
7. Leaving the area: a DEPARTURE with an IFR flight plan is removed when it is more than 15 nm from the ARP **and** (above
   6000 ft **or** on a `route`/`direct` nav moving away from the ARP). It counts as *handled* only if it was handed off and then
   received an altitude, direct or resume instruction (`depInstructed`); otherwise it just leaves (not penalised) - or is
   removed as "left the simulation area" at 40 nm. VFR departures keep the old rule (15 nm).

### Approach clearances (`APPROACH`, position APP)

`approachType` ILS | LOC | RNAV | VOR | VISUAL + `runwayEnd` (inferred from the aircraft's runway at confidence >= 0.8).
`approach.ts` decides, in this order:

* **Hard refusals** (every mode, `commError`): aircraft on the ground / not inbound (a go-around aircraft is fine); no matching
  published IAP for that runway end (`procedures[]` of type IAP whose name contains ILS / LOC / RNAV / VOR, copter variants
  ignored, HI- variants last); more than 30 nm from the threshold; VISUAL unless the weather is VFR or MVFR with ceiling (lowest
  BKN/OVC/VV) >= 1000 ft AGL and visibility >= 3 sm (simplified VMC); an aircraft on a route that does not join the procedure.
* **Improper geometry** (aircraft on vectors, using the assigned heading): inside the FAF, intercept angle > 30 degrees, heading
  that does not converge on the course, intercept point inside the FAF, or the course more than 10 nm ahead. Training:
  refused ("intercept angle too large", "inside the final approach fix"); other modes: accepted, an INFO event and a
  communication error (not credited as a correct clearance).
* **Separation** (`conflicts.ts`): the clearance must not put the aircraft within 3 nm in trail (distance along the course at
  the join point vs. every aircraft established on the same final) -> `UNSAFE_CLEARANCE` (training refuses, other modes flag
  and score). The reference text says only "radar separation minima" (FAA JO 7110.65): no paragraph is cited because none is
  verified in `docs/FAA-REFERENCES.md`; 3 nm is a simplification.

Procedure geometry (all relative to the runway end; no airport knowledge): *on-course* fixes (1-40 nm out, `|cross| <= 0.2 d +
0.3 nm`) form the straight-in segment (farthest = IF/IAF, the one closest but >= 3 nm out = FAF); fixes listed *before* the
last on-course fix are *feeders* (VCN for ILS 13); fixes listed after it or past the threshold (missed approach, holds) are
never flown. Final approach course = runway heading for every type (simplification; RNAV 22 / VOR 4 are really a few degrees
off).

On acceptance (`rt.approach` is set; the clearance is `completeClearances`-ed when replaced, vectored off, or on go-around):

* aircraft on a route: `nav = { path, 0, 'approach' }` (feeders from the join fix + on-course fixes);
* aircraft on vectors: keeps the heading (`pendingCapture`); when the course is reached (the same capture cone as the legacy
  FINAL logic) it turns onto the centreline and `nav` becomes the on-course fixes still ahead;
* VISUAL (and legacy aircraft that navigate to the runway on their own): no route, runway guidance.

Vertical: the assigned altitude is held. Once established inbound on the straight-in segment (on course and no more than 1 nm
outside the IF) the aircraft intercepts the 3 degree path **from below** (level until the path arrives) or descends onto it from
above at up to 1.3x the descent rate; no per-fix altitude restrictions. FINAL (the existing glidepath / decision-point logic)
starts when established inside **8 nm** (`APPROACH_FINAL_NM`; 7 nm jets / 4 nm light for aircraft without an approach
clearance), the assigned speed is dropped to approach speed. On Approach the pilot reports *"established ILS runway one three."*
(pending `FREQUENCY_CHANGE`); the controller hands off with `CONTACT_FREQUENCY TWR`; the pilot checks in with Tower *"Atlantic
City Tower, Spirit four fifty one, seven mile final runway one three, full stop."* (pending `LANDING`); `LAND` as before
(an approach-cleared aircraft keeps its route when LAND is issued; one that is not drops its route and flies to the runway).

Missed approach (automatic go-around, e.g. no landing clearance): the approach clearance and route are cancelled; IFR aircraft
climb to 2000 ft (never lower than 1500 ft above the field; never descending to it) on runway heading and call *"... runway
heading, level two thousand, request vectors for another approach."* (published missed approach altitudes are not in the
dataset). Tower hands back with `CONTACT_FREQUENCY APP`; the check-in is *"... Approach, ..., missed approach, two thousand."*
(pending `APPROACH`). Approach vectors / `DIRECT_FIX` (-> APPROACH) / `APPROACH` again.

### What the parser must provide

| Command | Fields consumed |
|---|---|
| `IFR_CLEARANCE` | `ifr` (all optional): `destination`, `departureProcedure`, `initialAltitudeFt`, `expectAltitudeFt`, `departureFrequencyMhz`, `squawk` |
| `APPROACH` | `approachType`, `runwayEnd` (or `runwayId`) |
| `DIRECT_FIX` | `fix` (identifier or navaid name) |
| `RESUME_OWN_NAVIGATION`, `RADAR_CONTACT` | none |
| `CONTACT_FREQUENCY` | `frequencyId` `CLNC`/`GND`/`TWR`/`APP`/`DEP` (or `frequencyMhz`) |

## Airport data contract

`checkAirportForSim(airport)` (see `airportCheck.ts`) reports what is missing. IFR operations additionally want CLNC and DEP/APP
frequencies and `procedures[].fixes` that exist in `navaids` (warnings only). In short: runway polygons;
for every runway end a `holding_position` node (runwayId set, optional `protectsRunwayEnd`) adjacent to a
`runway` node; exits = `runway` nodes adjacent to a `holding_position` of the same runway; edges on a runway
surface carry `onRunwayId`; parking nodes of kind `parking`; GND/TWR frequencies.

## Known limitations

* Simplified physics: first-order heading/vertical dynamics, constant accelerations, no density altitude,
  steady wind (gusts ignored), no wake turbulence, no braking-action effects.
* Takeoff abort and rejected landings on the runway are not modelled; an aircraft told to line up cannot be
  told to exit the runway again (no such command yet).
* Pattern work is minimal (downwind -> base -> final, fixed 0.8 nm offset); holding patterns are not flown.
* Pushback is a state change only (no motion). No vehicles, no de-icing, no helicopters.
* After a go-around the aircraft flies runway heading at a fixed altitude until instructed.
* IFR: no holding patterns, procedure turns, DME arcs, STARs, speed/altitude restrictions per fix or minimums; the final approach
  course is always the runway heading; one transponder code per aircraft, no radar coverage model (everything is "radar
  contact" once identified); departure clearance has no void time; the missed approach is "2000 ft on runway heading".
* Free-play traffic generation still spawns arrivals on the extended centreline, not at fixes (scenarios use `at_fix`).
* `radioState` `RECEIVING` is not used (readbacks are instantaneous); no frequency congestion yet.
