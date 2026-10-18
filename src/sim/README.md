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
| `flightDynamics.ts` | Takeoff roll, climb/descent, bank-limited turns, wind, approach guidance (plate / VGSI glidepath, displaced landing threshold), flare, rollout, exit, go-around |
| `wind.ts` | Steady wind vector, seeded per-aircraft gust model, wind components per runway end, crosswind / tailwind limit test |
| `runwayOccupancy.ts` | `computeRunwayActivity` (pure) + per-tick occupancy, enter/exit events, authorisation expiry |
| `conflicts.ts` | `assessClearanceSafety` (pure) + per-tick incursion/proximity detection |
| `commandExecutor.ts` | `applyCommand` implementation (validation, safety gate, commit, readback) |
| `traffic.ts` | Spawning (incl. `at_fix` arrivals and IFR departures), automatic pilot calls, frequency-change application, despawn, `TrafficGenerator` interface |
| `navigation.ts` | Lateral navigation over fixes: fix lookup (`Airport.navaids`), `distanceToFixNm`, `bearingToFixMag`, fly-by sequencing (`advanceNav`, `turnLeadM`) |
| `approach.ts` | Instrument / visual approach analysis: procedure classification, `assessApproach` (route join, intercept geometry, weather, range) |
| `missedApproach.ts` | Interpreter and guidance for the published missed approach text; published-hold lookup |
| `runwayTiming.ts` | Pure time projections: arrival threshold / touchdown / rollout-clear times, rollout distance vs time, crossing windows |
| `wake.ts` | JO 7110.65 5-5-4 wake tables (TBL 5-5-3 / 5-5-4) by RECAT category |
| `engineExtras.ts` | Types for engine methods beyond `api.ts`: `validateCommand` (dry run), airport state (`addClosure`, `removeClosure`, `setBirdActivity`, `setRunwayLightStep`, `reportBrakingAction`) |
| `airportOps.ts` | Airport operating state (`SimulationState.ops`): closures, braking action reports, bird activity, runway light steps; pure queries used by the executor, the safety check, taxi planning, the ATIS and the renderers |
| `star.ts` | STAR routes from the transcribed chart (`InstrumentProcedure.star`): `starRouteFrom`, `starProfile`, `findStar` |
| `solar.ts` | NOAA solar position at the airport: `isDaylight` / `sunriseSunsetUtc`, the engine epoch (`utcStartMs`) for sunrise-sunset rules |
| `mva.ts` | Minimum vectoring altitude lookup (`Airport.mvaSectors`, optional `holes`), 2 nm look-ahead, exemptions |
| `holding.ts` | Holding patterns with the AIM 5-3-8 direct / teardrop / parallel entries, `holdingText` parser |
| `minima.ts` | Approach minima from `minimaText`, runway-in-sight test for the decision altitude |
| `ifr.ts` | IFR clearance defaults (DP name from `airport.procedures`, squawk assignment) |
| `scoring.ts` | `ScoreCard` maintenance and the score formula |
| `geo.ts`, `rng.ts`, `performance.ts`, `runways.ts` | Math, mulberry32 PRNG, performance tables (+ `patternAltitudeFt`, cited wind limits), runway geometry (+ displaced thresholds, LDA / TORA) |
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
  departure or an arrival within 3 nm; and intersecting-runway operations (13/31 vs 4/22, see below).
  * `scenario.mode === 'training'`: rejected (`unsafe: true`), reason cites the JO 7110.65 topic.
  * otherwise: accepted, flagged (`RUNWAY_CONFLICT` + `UNSAFE_CLEARANCE` alerts, `CONFLICT` events), scored.
  * Topics cited (no text quoted): 3-9-6 same runway separation, 3-10-3 landing clearance,
    3-7-2 taxi and runway crossings, 3-9-8 intersecting runway separation. Verify numbering against the
    current edition before shipping; only the first three were specified by the product owner.
* **Dynamic detection** each tick: `RUNWAY_INCURSION` (taxiing/holding aircraft on a runway polygon without
  authorisation), `RUNWAY_CONFLICT` (2+ aircraft on a surface with high-speed traffic), `GROUND_PROXIMITY`
  (< 30 m, parked aircraft excluded), `AIRBORNE_PROXIMITY` (< 1.5 nm and < 500 ft: a **near-miss alert threshold**,
  not the separation minimum - the terminal radar minimum is 3 nm, JO 7110.65 5-5-4). Alerts are keyed so each
  episode emits one event.
* **Same-runway separation (JO 7110.65 3-9-6 departures, 3-10-3 arrivals, text fetched 2026-10-17)**: categorical distances
  (`srsMinimumFt`, categories from `srsCategory` in performance.ts: C172 = I, A320 = III, unknown light = I, other = III;
  II = small twin, none yet). Both Category I: 3,000 ft; the succeeding aircraft Category II (or both): 4,500 ft; Category I
  preceded by II: 3,000 ft; either Category III: 6,000 ft. In `assessClearanceSafety`:
  * TAKEOFF / LINE_UP: a preceding aircraft **on the ground** on the runway (rolling, cleared, in position, any occupant) is
    always unsafe. A preceding **airborne** departure (INITIAL_CLIMB / DEPARTURE / GO_AROUND) blocks only while it is on the
    runway (not past the runway end, not turned away: > 450 m off the centreline) and less than the categorical distance ahead of
    the succeeding aircraft's start of roll (its position along the runway). The text's alternative "has departed and crossed the
    runway end or turned to avert any conflict" is the "past the end / turned away" case; the distance alternative needs
    landmark-determinable distance, which the simulator always has.
  * LAND: a preceding aircraft on the ground on the runway (landed and not clear, rolling, cleared for takeoff, in position) is
    unsafe, except by the 3-10-3 sunrise-to-sunset exception (a landed aircraft need not be clear if its tail is 3,000 ft (Cat I
    follower) / 4,500 ft (Cat II follower) from the landing threshold; no figure for Cat III; daylight from `solar.ts`, see below). A preceding airborne departure blocks unless it has crossed the runway end /
    turned away or is the categorical distance (same figures, 3-10-3 b) beyond the landing threshold.
  * Anticipating separation (3-9-5 / 3-10-6) is the conservative version: only the separation that ALREADY exists counts, a
    clearance given while the leader is still rolling is refused (training; the other modes flag it as `UNSAFE_CLEARANCE`).
  * The per-tick surface-conflict check ignores aircraft that are already climbing out (they were judged at clearance time).
  Not modelled: helicopter / powered-lift visual separation, the 3-9-6 time intervals (wake, 2-3 minutes), arrivals judged against
  a preceding arrival that is still airborne (that is the approach-separation rule below), the "arrival inside 2 nm final blocks a
  takeoff" rule remains a controller-judgment simplification.
* **Intersecting runways (3-9-8 departures, 3-10-4 arrivals, text fetched 2026-10-17)**: judged by position, not by a height: a
  departure on one runway is blocked until the preceding departure on the other runway "has departed and passed the intersection"
  (its position along its runway beyond the centreline intersection + 60 m), or a preceding arrival there is clear of the runway /
  has passed the intersection (an arrival still rolling out before it blocks; the hold-short / exit-acknowledgement releases are
  not modelled; land and hold short is, see below). An arrival that is still airborne on final does NOT by itself make a departure unsafe: only if it would
  cross its threshold before the departure clears the intersection (arrival: distance / ground speed; departure: 2.5 s roll
  delay + `sqrt(2 d / a)` with the type's acceleration). Likewise an arrival clearance is unsafe only if the arrival would reach its
  threshold before a departing aircraft on the other runway passes the intersection; between two arrivals, only if the one that
  lands first would not have passed the intersection (touchdown speed / 2 over the roll) when the other crosses its threshold.
* **Wake turbulence time intervals (2-1-19, 3-9-6, 3-9-7, 3-9-8; P/CG AIRCRAFT WAKE CATEGORIES)**: A = A380, B/C/D = heavy, E = B757,
  F/G = other aircraft over 41,000 lb (the A320), H/I = under 41,000 lb (the C172). So the 3-9-6 and 3-9-8 time intervals (behind
  categories A-E only) never apply to the simulated types and are NOT modelled, nor are the 4- and 3-minute 3-9-7 intervals behind A-E.
  What applies is 3-9-7: a Category I aircraft (C172) departing from an intersection on the same runway (same or opposite direction;
  an intersection = more than 500 ft from the runway end) behind a departing Category F, G or H aircraft (the A320) must not start its roll
  until 3 minutes after the preceding aircraft took off (liftoff time from the `airborne` INFO event; the clearance's 2.5 s roll
  delay counts): refused in training with "hold for wake turbulence, 3 minutes required", flagged otherwise. The pilot-requested
  waiver is not modelled. A full-length departure behind an A320 has no time interval; the categorical distances above still apply.
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
                        - 2*commErrors - 3*coordinationErrors + 2*correctClearances + 5*aircraftHandled)
```

* incursion: `RUNWAY_INCURSION` event; unsafe: `CONFLICT` event with `alertKind = UNSAFE_CLEARANCE` (also when
  training refused it); separation: `SEPARATION_VIOLATION` (ground or airborne proximity);
  commErrors: rejected/clarified commands flagged `commError` (wrong frequency, unknown callsign, aircraft not
  in a position to comply); correct: accepted safe clearance; handled: arrival shut down at parking, or
  departure that left the area after a CONTACT_FREQUENCY handoff; coordinationErrors: `COORDINATION` events with `data.error` made by the player (a crossing or an IFR takeoff authorised
  without the approval / release below; free play and career only, training refuses). The weight 3 is a design value.
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
First call (instead of the standard "inbound" call): *"Atlantic City Approach, Spirit four fifty one, level five thousand,
information alpha."*, pending request `APPROACH`.

### IFR departures (Clearance Delivery -> Ground -> Tower -> Departure)

1. A parked departure whose `flightPlan.flightRules === 'IFR'` calls its spawn frequency (CLNC): *"Atlantic City Clearance Delivery,
   Spirit four fifty one, IFR to Philadelphia, with information alpha, ready to copy."* Pending `IFR_CLEARANCE`. VFR
   departures (and IFR specs without a flight plan) behave as before.
2. `IFR_CLEARANCE` (see `ifr.ts`): refused unless the aircraft is PARKED/READY, has an IFR flight plan, has a pending
   `IFR_CLEARANCE` request and no clearance yet. A stated destination must match the flight plan (K prefix ignored);
   `squawk` must be 4 octal digits, not 0000/1200/7500/7600/7700, not in use. Defaults: DP name = first `procedures[].type ===
   'DP'` without "DEPARTURE" (ATLANTIC CITY THREE), initial altitude 2000 (ATLANTIC CITY THREE says maintain 2000), expect =
   cruise, departure frequency = the DEP frequency whose `sectorBearings` (magnetic bearings from the airport) contain the bearing from
   the ARP to the first fix of the route (KACY: 310-129 north -> 134.25 [CYN, COL, RBV], 130-309 south -> 124.6 [VCN, SIE]), else the
   first DEP, else APP; a controller position covers all of its sector frequencies (the `DEP` controller can talk to an aircraft on
   `DEP-N`); squawk = seeded unused code. Stored on `flightPlan.ifrClearance` (`readBack:
   true`), `ac.squawk` set.
3. 15 s later (`IFR_TAXI_REQUEST_DELAY_SEC`) the pilot tunes Ground by itself and calls *"... Ground, Spirit four fifty one, at
   Gate one, ready to taxi, IFR to Philadelphia."* (pending `TAXI`).
4. `TAKEOFF` without an IFR clearance: training -> refused ("no IFR clearance on file"); otherwise accepted, an INFO event, and
   a communication error (`COMMAND_ACCEPTED` with `data.commError`, no "correct clearance" credit).
5. After takeoff: runway heading, climb to `ifrClearance.initialAltitudeFt`. Tower: `CONTACT_FREQUENCY` `frequencyId: 'DEP'` (for an IFR departure this resolves to the *sector* frequency of its clearance, see below)
   (resolves; the id the controller named is kept when APP and DEP share a frequency, so the pilot says "Departure"). Check-in:
   *"Atlantic City Departure, Spirit four fifty one, leaving one thousand two hundred, climbing to two thousand."* (pending `OTHER`).
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
* **Improper geometry** (aircraft on vectors, using the assigned heading): inside the FAF, intercept angle too large, heading
  that does not converge on the course, intercept point inside the FAF or the **approach gate**, or the course more than 10 nm ahead.
  Gate and angles per JO 7110.65 5-9-1 / 5-9-2 (TBL 5-9-1, text fetched 2026-10-17) and the P/CG definition: the *approach gate* is
  on the final approach course 1 nm outside the FAF and no closer than 5 nm to the threshold (KACY ILS 13: FAF 4.55 nm -> gate 5.55
  nm). Vectors must intercept at least 2 nm outside the gate (7.55 nm for ILS 13) at <= 30 degrees. Closer than 2 nm outside the gate
  (but not inside it) the maximum angle is 20 degrees and it needs ceiling >= MVA + 500 and visibility >= 3 sm (the MVA is not in
  the data: approximated by the simplified VMC of the visual approach, ceiling >= 1000 ft / 3 sm), and the relaxation does not apply
  to RNAV aircraft being vectored for an RNAV approach. Inside the gate (but outside the FAF) is allowed only on the pilot's request,
  which the simulator cannot express: improper. An aircraft already established on the course is exempt from the gate rule. Training:
  refused ("intercept angle too large", "inside the final approach fix"); other modes: accepted, an INFO event and a
  communication error (not credited as a correct clearance).
* **Separation** (`conflicts.ts`): 3 nm in trail *at the moment of joining* between the follower and every aircraft
  established on the same final (FINAL / LANDING, or aligned within 0.5 nm and 30 degrees). The follower is measured at its own
  distance to the threshold when it is already on (or within the on-course tolerance of) the course, otherwise at the projected
  join point (intercept point, or the first on-course fix it will fly). The leader is advanced by `groundspeed x
  (distance still to fly to the join point / follower groundspeed)`, floor 0. Too close -> `UNSAFE_CLEARANCE` (training refuses,
  other modes flag and score). 3 nm is the terminal radar minimum of JO 7110.65 5-5-4 MINIMA (single-sensor ASR/FUSION; 5 nm
  applies in STARS multi-sensor mode or beyond 40 mi, ignored). **Wake (`wake.ts`, JO 7110.65 5-5-4 TBL 5-5-3 / 5-5-4, cells read from
  the faa.gov HTML tables on 2026-10-17):** aircraft in trail on the same final are "on approach" (TBL 5-5-4); the minimum is
  `max(3 NM radar, table)` with the RECAT categories of JO 7110.126A Appendix A (`wakeRecatCategory`: A320 = F, C172 = I). F leader ->
  I follower is **4 NM** on approach (nothing directly behind); F->F, I->F and I->I have blank cells (3 NM radar minimum). The reason
  text cites "7110.65 5-5-4, TBL 5-5-4 on approach: Category F leader, Category I follower ... 4 NM". The whole tables are coded
  (A-E leaders, e.g. B->I 6 NM, A->I 8 NM) but the simulator's two types only exercise F and I. The 2.5 NM reduction is not modelled.

Procedure geometry (all relative to the runway end; no airport knowledge): *on-course* fixes (1-40 nm out, `|cross| <= 0.2 d +
0.3 nm`) form the straight-in segment (farthest = IF/IAF, the one closest but >= 3 nm out = FAF); fixes listed *before* the
last on-course fix are *feeders* (VCN for ILS 13); fixes listed after it or past the threshold (missed approach, holds) are
never flown.

Final approach course (`finalCourseTrue`, per procedure): ILS / LOC procedures use the NASR localizer course of the runway end
(`RunwayEnd.ils.courseDeg`, magnetic -> true; KACY 127.99 / 308.01); every other procedure uses the bearing from its FAF to the
runway threshold; the runway heading only when neither exists (e.g. an ILS-less runway whose procedure has no on-course fix). The
vector-intercept geometry, the capture / "established" test, the centreline guidance and the FINAL logic all work against this course
(`courseGeom`); touchdown and the rollout use the runway heading. On KACY this makes VOR 4 fly 36.8 degrees true (runway 28) and VOR 31
292.6 (runway 298); RNAV 22 comes out at 208.02 versus the runway's 208.00 because its FAF (EFEWY) lies on the extended centreline, and
the RNAV 4 / 13 / 31 courses are within 0.05 degrees of their runways (the test prints the table).

On acceptance (`rt.approach` is set; the clearance is `completeClearances`-ed when replaced, vectored off, or on go-around):

* aircraft on a route: `nav = { path, 0, 'approach' }` (feeders from the join fix + on-course fixes);
* aircraft on vectors: keeps the heading (`pendingCapture`); when the course is reached (the same capture cone as the legacy
  FINAL logic) it turns onto the centreline and `nav` becomes the on-course fixes still ahead;
* VISUAL (and legacy aircraft that navigate to the runway on their own): no route, runway guidance.

Vertical: with a published profile (`InstrumentProcedure.fixAltitudes`, see below) the approach descends along the plate; without one
the assigned altitude is held. Once established inbound on the straight-in segment (on course and no more than 1 nm outside the IF)
the aircraft intercepts the 3 degree path **from below** (level until the path arrives) or descends onto it from above at up to 1.3x
the descent rate. FINAL (the existing glidepath / decision-point logic)
starts when established inside **8 nm** (`APPROACH_FINAL_NM`; 7 nm jets / 4 nm light for aircraft without an approach
clearance), the assigned speed is dropped to approach speed. On Approach the pilot reports *"established on the ILS runway one three."*
(pending `FREQUENCY_CHANGE`); the controller hands off with `CONTACT_FREQUENCY TWR`; the pilot checks in with Tower *"Atlantic
City Tower, Spirit four fifty one, seven mile final runway one three, full stop."* (pending `LANDING`); `LAND` as before
(an approach-cleared aircraft keeps its route when LAND is issued; one that is not drops its route and flies to the runway).

### Published fix altitudes (`InstrumentProcedure.fixAltitudes`, `flightDynamics.profileAltitude`)

When an approach is accepted its `fixAltitudes` become `rt.approach.profile` (`fix`, `minAltitudeFt`, `maxAltitudeFt`,
`mandatoryAltitudeFt`; KACY has them on all 13 IAPs: RNAV 22 KOPCE 1800 / FLDER 1600 / EFEWY 1100, ILS Z 13 MAYBN 1600, ILS 31 PRSTY
1700). Along the fixes still ahead the aircraft flies the altitude implied by the restrictions: a *mandatory* altitude is met exactly,
a *maximum* is met (descend to it), a *minimum* is the lowest allowed (the pilot descends to it and stops). Between fixes the descent
is just in time at 80% of the type's descent rate, aiming to be at the fix altitude `PROFILE_LEAD_SEC` = 20 s before the fly-by
sequencing point (the 10 s vertical-speed controller lags a ramp by ~10 s), the ceiling being the minimum over all later restricted
fixes `reach_i + 0.8 * rate * (t_i - 20 s)`. The aircraft **never climbs** (target = min of the current altitude and that ceiling) and
never goes below the next minimum. On a non-precision approach the 3 degree path is intercepted at the FAF altitude: the descent
from the FAF fix starts `fafDM + 0.3 nm` out, replacing the old "hold the assigned altitude until established, then 3 degrees"
simplification; precision approaches (ILS) still capture the glidepath from the intercept altitude, with the fix altitudes honoured
before it. `INFO` events `"<cs> crossed <FIX> at <alt> ft"` carry `data.crossing = { fix, altitudeFt }`; they are also emitted for the
fixes passed while on FINAL (the route is not flown there but the fixes are still sequenced). Measured on real KACY RNAV 22 from PIDVE
at 4,000 ft, A320, 170 kt: KOPCE 1836 (plate 1800), FLDER 1621 (1600), EFEWY 1162 (1100): all within 100 ft, no climb above 10 ft.
Without a profile (the fixture's other procedures, other airports) behaviour is unchanged.

### Land and hold short (`commandExecutor.planLahso`, `flightDynamics.chooseExit`)

JO 7110.65 3-10-4 / 3-10-5, AIM 4-3-11, JO 7110.118 (the 7/14/00 edition was fetched; the AIM paragraph 4-3-11 and 7110.65 3-10-3
text were fetched from faa.gov on 2026-10-17). `LAND` with `holdShort` (`['RWY13']` or `['13/31']`) is validated in this order:
(1) the runway end has a NASR LAHSO entry (`RunwayEnd.lahso`) naming that runway, else "we can't hold short of runway ..." (KACY: 4
short of 13/31 ALD 3,550 ft; 13 short of 4/22 3,600 ft; 31 short of 4/22 5,750 ft); (2) `landingDistanceFt` of the type <= the
published ALD, else the pilot is unable ("we're unable to hold short of runway one three") and the clearance is NOT issued
(C172 1,335 ft yes, A320 4,500 ft no on runway 4); (3) conditions: ceiling >= 1,000 ft and visibility >= 3 sm (AIM 4-3-11 /
7110.118 11a), a dry runway (no precipitation phenomena RA DZ SN GR PL IC UP SG TS), tailwind on the other runway < 3 kt, and
**between sunrise and sunset** (NOAA solar position at the ARP, 0.833 degree refraction + disc, epoch `EngineOptionsExt.utcStartMs`,
default `Date.now()`). Training refuses with the reasons; other modes accept and flag it ("Improper instruction accepted"). Discrepancy
noted: 7110.118 does not forbid night LAHSO outright (it needs land-and-hold-short lights and, for air carriers, a visual glide-slope
indicator, 11c / 11d) but the airport data states neither, so the simulator keeps the coordinator's sunrise-sunset limit. Not
modelled: wind-shear reports, air-carrier minima (1,500 ft / 5 sm without PAPI/VASI), the appendix-1 aircraft list (the ALD test stands
in), the traffic-information exchange. Readback: *"Runway four, cleared to land, hold short of runway one three, <callsign>"*.
Effects: the clearance carries `holdShort`; the intersecting-runway issues (3-10-4) against the hold-short runway are not raised (either
way round: a departure on 13 is allowed while a LAHSO arrival is on 4); `rt.lahso` makes `chooseExit` drop exits beyond the hold-short
point and cap the stop target to `min(hold-short point, ALD) - length/2 - 10 m`. The C172 on KACY 4 stops with its nose at 3,411 ft,
the hold-short point being at 3,550 ft. If the nose passes the point (not reachable with the planner, but guarded), `detectConflicts`
raises a `RUNWAY_INCURSION` of the other runway.

### Minimum vectoring altitude (`mva.ts`, `conflicts.assessMva`)

JO 7110.65 5-6-1: vector aircraft "at or above the MVA or the minimum IFR altitude except as authorized for radar approaches, radar
departures, special VFR, VFR operations, or by paragraph 5-6-3". With `Airport.mvaSectors` present, an `ALTITUDE` assignment below the
MVA of the sector the aircraft is in or one it enters within 2 nm along its track (`MVA_LOOKAHEAD_NM`, sampled every 0.25 nm), or a
`HEADING` whose new track (magnetic -> true) enters a sector whose MVA is above `min(altitude, assigned altitude)`, is unsafe
(`UNSAFE_CLEARANCE`, reference `REF_MVA`): training refuses, free play accepts and scores it. Exempt: VFR, on the ground, INITIAL_CLIMB
(radar departure), FINAL / LANDING / ROLLOUT, and nav modes `approach` / `missed` / `holding` (a published procedure segment; an
aircraft still being vectored to intercept is not). Lookup: a point inside a sector's `holes` (inner rings, duck-typed) is not in it;
the smallest containing sector wins (equal area: the higher altitude); outside every sector there is no restriction. KACY: the ARP
resolves to 1,600 ft (sector A), a point in sector C to 2,500 ft. The approach-gate relaxation ("ceiling >= MVA + 500") still uses the
simplified VMC approximation.

### Same-runway landing behind a landed aircraft, daylight exception (3-10-3)

"Between sunrise and sunset, if you can determine distances by reference to suitable landmarks and the other aircraft has landed, it
need not be clear of the runway if the following minimum distance from the landing threshold exists: When a Category I aircraft is
landing behind a Category I or II - 3,000 feet. When a Category II aircraft is landing behind a Category I or II - 4,500 feet."
`conflicts.landedDistanceExceptionApplies`: the preceding aircraft must have landed (ROLLOUT / RUNWAY_EXIT / LANDING on the ground,
same runway end), the tail of the preceding aircraft (position - length / 2) must be at least 3,000 ft (subject Category I) or 4,500 ft
(subject Category II) from the subject's landing threshold, and it must be daytime (`solar.ts`, epoch `utcStartMs`). There is no figure
for Category III on either side, so the exception never applies to the A320. The "suitable landmarks" are assumed. The airborne case
(departed and crossed the runway end, or airborne beyond the categorical distance) has no daylight condition in the text and is
unchanged.

### Published missed approach (`missedApproach.ts`)

On any go-around of an IFR aircraft (no landing clearance, unstable, ATC `GO_AROUND`/`MISSED_APPROACH`, decision altitude) the
engine interprets `missedApproachText` of the cleared procedure (else an IAP of the runway end) with a small deterministic
grammar (the six verbatim KACY forms and all 13 transcribed texts are tested):

```
[Climb to <alt> then] climbing (left|right) turn to <alt> <legs> and hold.     Climb to <alt> <legs> and hold.
leg := (via|on) heading <deg> deg | (via|on) track <deg> deg to <FIX> | direct <FIX>
     | (via|on) <NAVAID> [VORTAC|VOR] R-<radial> to <FIX> [INT][/<NAVAID> <n> DME | /<n> DME]
```

Model (nav mode `'missed'`, phase GO_AROUND): climb straight ahead on the runway heading to the first altitude (400 ft above the
field if none), then turn in the stated direction (the short way round if the stated direction would loop more than 200 degrees)
and fly the legs: a heading until the next radial can be intercepted (lead = `turnLeadM`); a radial = intercept it from the named
navaid and track it outbound to the fix (cross-track gain, 45 degree cap); `direct` / `track .. to` = fly to the fix with
fly-by sequencing; the aircraft climbs to the final altitude (never descending to it) at climb speed, and at the last fix enters
the hold (`holding.ts`, nav mode `'holding'`, phase HOLDING). Headings / tracks / radials are magnetic.
Text that is missing, not in the grammar, or names an unknown fix: the plain go-around (runway heading, fixed altitude) and a
warning INFO event ("the published missed approach ... could not be interpreted"). VFR aircraft without an approach clearance
always use the plain go-around.

Pilot calls: *"..., going around runway one three, no landing clearance, flying the published missed approach."* (at the
decision altitude: *"..., going missed approach, runway not in sight, flying the published missed approach."*); on the same
frequency, once level: *"..., flying the published missed approach, level two thousand, request frequency change."*; after the
Tower hands it back (`CONTACT_FREQUENCY APP`): *"Atlantic City Approach, Spirit four fifty one, missed approach, climbing two
thousand, direct SMITS, request further clearance."* (or "holding at SMITS, two thousand" once in the hold).

### Holding (`holding.ts`)

Standard racetrack with the three AIM 5-3-8 entry procedures, chosen from the aircraft's ground track relative to the inbound course
when it reaches the fix (`rel` = track minus inbound course, positive right; mirrored for left-turn holds):
**direct** for -110 < rel < +70 (and within 5 degrees of the outbound course: already outbound), **parallel** for +70 to +175,
**teardrop** for -175 to -110 (the 70 degree sector on the holding side). Direct: turn onto the outbound heading in the pattern
direction. Teardrop: outbound 30 degrees off the outbound course toward the holding side for one leg, then turn in the pattern direction
to intercept the inbound course. Parallel: outbound parallel to the course for one leg, then turn toward the holding side (opposite
to the pattern turns, through more than 180 degrees) back to the fix, then the racetrack. The entry chosen is in the INFO event
("over TVO: parallel entry (track +130 deg from the inbound course, right turns; AIM 5-3-8)"). The inbound leg tracks the inbound
COURSE: cross-track correction up to a 45 degree intercept, the turn onto the inbound leg rolls out on the intercept track, and the
heading is wind-corrected (a 30 kt crosswind is a ~10 degree crab). Right turns
unless stated. Legs: the stated minutes or nm, else 1 minute at or below 14,000 ft and 1.5 minutes above; outbound timing starts
within 5 degrees of the outbound track. Hold speed 170 kt (jets) / 90 kt (light): a jet's racetrack is ~2.2 nm wide and the
whole pattern stays within ~4.5 nm of the fix for 1-minute legs (the 180 degree turns at a standard-rate turn of the type add
about a nautical mile beyond the leg); a parallel or teardrop entry stays within 6 nm. The aircraft stays until `DIRECT_FIX` /
`APPROACH` / `HEADING` / `RESUME_OWN_NAVIGATION` (an arrival returns to phase APPROACH).

Inbound course, in order: the instruction; the charted pattern (`InstrumentProcedure.holdingPatterns[]`, transcribed from the plates: inbound course, turns, leg length; TUBER 017 right 6 NM, SMITS 270, RODDI 218 right 5 NM, CARYL 128 one minute); the plate `holdingText` when it states one ("270 deg inbound"); for the hold at the end of
a published missed approach, the reciprocal of the radial it ends on (SMITS on ACY R-090 -> 270), the radial that any procedure
defines the fix on, or the stated track; otherwise the course from the previous route fix (or from the aircraft) to the fix. Every
case that is not stated by the instruction or the holding text records an `assumption` in the INFO event. Leg length / turns come
from `holdingText` ("CARYL: one-minute hold", "RODDI 5 NM hold") when the instruction says "as published" or does not state them.

`HOLD_AT_FIX` is valid for airborne aircraft in INBOUND / APPROACH / DEPARTURE / GO_AROUND / HOLDING (not on final), fix known.
`MISSED_APPROACH` is valid in FINAL / APPROACH and executes the published missed approach.

### Decision altitude (`minima.ts`)

`rt.approach` of an instrument approach carries minima resolved from `minimaText`: ILS -> `S-ILS` DA; LOC -> `S-LOC` MDA; RNAV -> LPV
DA, else LNAV MDA, else RNP / LNAV-VNAV DA; VOR -> the straight-in `S-<rwy>` line MDA; the first (lowest category) values; HAT
from "HAT n" or the bracketed height; visibility from the bracketed "(500-7/8)" pair, "MDA 480-1" or RVR/5280. Unreadable text:
200 ft HAT / 1/2 sm for ILS, 450 ft HAT / 1 sm otherwise, announced in an INFO event. When the aircraft reaches the DA/MDA on
FINAL (or LANDING) the runway is "in sight" only if visibility >= the minimum and the ceiling (lowest BKN/OVC/VV) >= HAT; if not
it executes the published missed approach even when cleared to land. The MDA is not levelled off at (the 3 degree path is followed
to the decision point) and the weather is the scenario's single METAR-like observation. Visual approaches have no DA.

### What the parser must provide

| Command | Fields consumed |
|---|---|
| `IFR_CLEARANCE` | `ifr` (all optional): `destination`, `departureProcedure`, `initialAltitudeFt`, `expectAltitudeFt`, `departureFrequencyMhz`, `squawk` |
| `APPROACH` | `approachType`, `runwayEnd` (or `runwayId`) |
| `DIRECT_FIX` | `fix` (identifier or navaid name) |
| `HOLD_AT_FIX` | `hold`: `fix`, `turns`, `asPublished`, optional `inboundCourseDeg` (magnetic, to the fix), `legMinutes`, `legNm`, `efcZulu` |
| `RESUME_OWN_NAVIGATION`, `RADAR_CONTACT`, `MISSED_APPROACH` | none |
| `CONTACT_FREQUENCY` | `frequencyId` `CLNC`/`GND`/`TWR`/`APP`/`DEP` (or `frequencyMhz`) |

## Runway traffic, AI scoring and dry runs (AI-controller round)

Gaps found by `src/ai` driving the engine with continuous traffic. Projections live in `runwayTiming.ts` (pure functions of the
state): an arrival crosses the threshold at `min(groundspeed, 1.15 x approach speed)` (when more than 2 nm out), touches down at the
typical point (390 m light / 490 m jets, later when high), then `projectRollout` runs the same exit selection as the flight
dynamics (`predictRolloutPlan` = `chooseExit`: normal then maximum braking to the first usable exit at its exit speed) and the exit
connector until the tail is off the runway polygon (no exit: stopped + 45 s). C172 on KACY 13 touching down at 390 m is clear ~29 s
after touchdown on the fixture; A320 ~30 s.

1. **Arrival over the runway blocks a departure.** `arrivalsOverRunway`: an airborne arrival (LANDING / FINAL / LAND clearance) inside
   the runway polygon at any height counts for `TAKEOFF` and `LINE_UP_AND_WAIT` (before only aircraft below 50 ft AGL or ground
   traffic did, and the 2 nm final rule stopped at 50 m past the threshold).
2. **Landing behind an airborne arrival (3-10-3).** `precedingArrivalBlockers`: for every arrival ahead on the same final (same
   runway end, within 900 m of the centreline) the follower's projected threshold crossing must be at least 3 s after the leader's
   projected "clear of the runway" time, or - by day, Cat I/II only - the leader must already be landed with its tail 3,000 / 4,500 ft
   from the threshold at that moment (`landedExceptionHolds`, the same daylight rule as for a leader on the ground). Training refuses,
   other modes flag. Example (fixture, two C172 on 13): 25 s apart -> "it would cross the threshold of runway 13 in 103 s, but L1 ahead
   on the same final lands in 88 s and is not clear of the runway until about 117 s"; the boundary is ~41 s of spacing. In flight, the
   decision point (0.5 nm) re-evaluates the same blockers and goes around ("traffic on the runway"), and a new last-chance check
   (cleared, inside 0.25 nm, still above 25 ft) goes around if an aircraft is physically on the runway (a leader that satisfies the
   daylight rule does not block).
3. **Crossings against intersecting-runway traffic (3-9-8 / 3-10-4).** The crossing aircraft is on the surface of the crossed runway
   for a window computed along its own route (`crossingPath` over the runway nodes, `surfaceWindow`: start delay 3 s, 0.6 x taxi speed,
   10 m of nose/wingtip margin). Traffic on a runway that crosses it is on that same surface when it passes the intersection point:
   departures rolling or cleared (line-up time included), arrivals rolling out, arrivals on final within 3 nm (projected touchdown and
   rollout), and aircraft standing on the surface there. `CROSS_RUNWAY` is unsafe if the traffic's time at the intersection +- 45 m
   (+ its length) overlaps the window by less than 4 s. Real KACY (C172 crossing 4/22 at Bravo, A320 landing 13): refused while the A320 would reach the
   intersection inside the crossing window (13-28 s from now; from about 0.3 nm out until it has passed) ("... L1 is rolling out on runway 13/31 and reaches the intersection in about 9 s"),
   accepted once it has passed. The reverse is checked too: a `TAKEOFF` / `LAND` is refused while an aircraft cleared across the
   intersecting runway would still be on it when the subject reaches the intersection.
4. **AI vs player.** `applyCommand(..., { aiPosition })`: COMMAND_ACCEPTED / COMMAND_REJECTED / CLARIFICATION / CONFLICT (unsafe
   clearance) / READBACK_ERROR events produced by that command carry `aiPosition` (`ctx.currentAi`); the pilot's readback does not.
   Scoring ignores those events: correct clearances, communication errors, unsafe instructions and the request-wait statistics count
   the player's own actions only; incursions and separation violations stay global. Once any AI command has been seen
   (`ctx.aiSeen`), `aircraftHandled` counts a DESPAWN only if the player gave that aircraft an accepted instruction
   (`DESPAWN.data.byPlayer`); with the AI doing everything the count is 0.
   `engine.validateCommand(cmd, opts)` (typed in `engineExtras.ts`; `createEngine` returns `SimulationEngine & SimulationEngineExtras`,
   `api.ts` is unchanged) is a dry run of `applyCommand`: same validation, safety gate and `CommandOutcome`, with no events, no pilot
   transmission, no alert, no score change, no state change, no duplicate-window entry. Training: unsafe -> `rejected` with
   `unsafe: true`; other modes -> `accepted` (the real call would flag it). The accepted clearance is a preview (`id: 'dry-run'`) and
   `readback` is the correct readback text.
5. **READY aircraft are not lane traffic.** `groundMovement.findLeader` skips aircraft that are READY or standing without a route on
   a parking position (within 8 m); only aircraft on the taxiway edges count for spacing.
6. **Ground proximity.** Alert below `min(30 m, 0.8 x (1.5 x longer length + 20 m))` (C172 pair 26.0 m, anything with an A320 30 m),
   critical below 15 m, and never for two aircraft standing still in the same queue (TAXIING / HOLDING_SHORT / READY, same heading, off
   the runway) unless they are closer than 15 m.
7. **Check-in near the hold.** A departure that checks in on Tower within 400 m (`HOLD_CHECKIN_RANGE_M`) of the departure hold at the
   end of its route says "holding short runway one three, ready for departure" when stopped at it, else "approaching the hold runway
   one three, ready for departure", with `pendingRequest = DEPARTURE` (the later standard hold call is not repeated).
8. **Line-up time.** A takeoff clearance given at the hold sets `rollAtSec = now + max(2.5, lineUpTimeSec)`: 3 s + path / line-up
   speed + the 90 degree turn, never less than 10 s (C172) / 17 s (A320). The aircraft really needs 25.7 s (C172) / 26.1 s (A320) from
   KACY HP13-31-C-1 to start rolling (measured); the intersecting-runway estimates (`intersectingIssues`) and the crossing checks use the
   same line-up time instead of 2.5 s, which makes a departure from the hold on 22 unsafe with a 13 arrival 3 nm out (67 s) where it
   was accepted before (about 70 s needed: 30 s line-up + 40 s to pass the intersection).
9. **Exits that avoid a re-crossing.** `chooseExit` takes the first reachable exit whose hold has a taxi route to parking without
   crossing any runway (`shortestDistances` never uses runway surfaces); if none of the reachable exits does, the first reachable exit
   is used and the aircraft stops at the hold (RUNWAY_EXIT) and asks for the crossing as before. On the unmodified KACY data every
   exit chosen for 4 / 22 / 13 / 31, both types and touchdown points of 250-800 m already has such a route (test); with Bravo cut
   off from parking the C172 on 22 skips Bravo for the next exit.

## Departure trail, go-around re-clearance and queue spacing (session fixes)

* `conflicts.departureTrailConflict` (TAKEOFF, citing 7110.65 3-9-6 / 5-8-3): an airborne departure ahead on the same runway end and track
  (within 15 degrees of the runway heading) that the follower out-climbs by 10 kt or more is judged at the clearance. The follower (line-up
  delay, roll, then its climb speed) must not be within 3 nm of the leader at the time the leader is 10 nm out. Equal or slower followers
  keep the plain airborne-distance rule. Refused in training, flagged otherwise.
* `Aircraft.lastGoAroundSec` is set by `initiateGoAround`. `LAND` for an aircraft on a missed approach (phase `GO_AROUND`, or `APPROACH` /
  `INBOUND` within 5 minutes of the go-around before a new approach clearance) is refused with "unable, we're going around" unless it is
  aligned within 15 degrees, no more than 300 ft above the 3 degree path and at least 2 nm out.
* `groundMovement.findLeader` also sees a STOPPED aircraft that lies on the follower's remaining route (12 m, next 250 m) whatever its heading,
  so a follower turning into a hold-short queue stops its following distance back instead of 13 m behind. `conflicts.sameQueue` also treats a
  follower creeping below 8 kt behind a stopped leader as queueing.

## Tower vocabulary (`towerCommands.ts`, `flightDynamics.ts`, `traffic.ts`)

Planners for the Tower instructions of the 2026-10-18 round, with the FAA source in each code comment (docs/FAA-REFERENCES.md,
docs/PHRASEOLOGY-AUDIT.md section G, docs/BEHAVIOUR-ACCURACY.md T8, T11, T13-T17, G9, F11). All seeded decisions use
`seeded01(aircraft.seed, label)` (`rng.ts`), never the shared generator, so existing runs keep their random sequence.

* **Runway exits (`EXIT_RUNWAY`, 3-10-9).** `runwayExits(ctx, g)` lists the exits of the landing runway (runway node, along distance,
  the hold nodes with their side: left/right of the landing direction). `chooseExit(..., exit, holdShortAlong)` takes the instructed
  exit (taxiway, side, "next", "to the end" = the last one) when the aircraft can slow to the exit speed within the maximum braking and
  returns `honoured: false` + `unableReason` otherwise. The command sets `rt.exit`; on the ground it replans the rollout at once (refused
  if not possible), on final the check is made at touchdown and the pilot calls "unable charlie, will exit at alpha"
  (`exitUnableCall`). "Hold short of runway N" during FINAL / LANDING / ROLLOUT (`planLandingHoldShort`) sets `rt.exitHoldShort`: the
  exits beyond that runway's surface are dropped and the no-exit stop line is 60 m + half the aircraft length short of it; refused
  ("we can't hold short of runway N") when `startAlong + v^2 / (2 x max braking)` would pass the line. "Contact Ground" in the same
  transmission sets `pendingFreq.afterClear`: `applyPendingFrequencyChanges` waits for the end of the rollout and the runway to be clear.
* **Cancel takeoff (`CANCEL_TAKEOFF`, 3-9-11).** `planCancelTakeoff`: CLEARED_FOR_TAKEOFF -> LINE_UP_AND_WAIT (new legal transitions in
  `stateMachines.ts`); TAKEOFF_ROLL -> LINE_UP_AND_WAIT with `rt.aborting` while `stepAbort` brakes at `MAX_BRAKE_FACTOR` x the landing
  deceleration along the centreline, then the pilot reports. Decision rule: airspeed below `rotateSpeedKt` (14 CFR 25.107(e)(1)(i): V1 <= VR;
  V1 itself is not tabulated) and `1.5 s x v + v^2 / (2a)` within the runway left less 60 m; otherwise "unable ..., continuing". After the
  roll started the instruction needs a reason or a hazard (another aircraft on the runway) else it is flagged (training: refused).
  `HOLD_POSITION` ("stop") in CLEARED_FOR_TAKEOFF / TAKEOFF_ROLL is routed to the same planner (the clearance's kind becomes CANCEL_TAKEOFF).
* **Traffic information (`TRAFFIC_ADVISORY`, `FOLLOW_TRAFFIC`, 3-1-6, 7-2-1, 3-8-1).** `matchTraffic` finds the described aircraft from the type
  words (`describeWords`: spoken callsign, callsign, type words) and `trafficGeometry` (pattern leg, final distance, on the runway ...);
  `lookForTraffic` gives the pilot's answer (range from the visibility, bearing from the nose, seeded chance); "looking" sets
  `rt.trafficLook` and `towerVocabularyCalls` (traffic.ts) makes the second call. A follow instruction needs the traffic in sight and sets
  `rt.follow`; `patternHeading` holds the base turn while the leader has not turned base / passed the join point (`followHolds`) and
  `followAdjustedSpeed` slows the follower so that it crosses the threshold `pilotBehaviour.followMarginSec` after the leader is clear. Pattern distances are measured from the landing threshold (`RunwayEndGeom.landingThreshold` / `displacedM`, so KMHT's displaced thresholds count) and the pattern altitude is `patternAltitudeFt` of the type (published TPA when the airport data has one).
* **Pattern (`PATTERN_INSTRUCTION`, `REPORT_POSITION`, closed traffic).** `rt.pattern` has legs UPWIND, CROSSWIND, DOWNWIND, BASE and the
  flags `extend`, `short`, `circle` (see `PatternState` in `context.ts`; AIM 4-3-2 / 4-3-3 geometry). ENTER_PATTERN from a go-around (or a low
  departure) starts on UPWIND. LAND carries the operation (`rt.landingOp`: full stop, touch-and-go, low approach, stop-and-go (= full stop),
  option (seeded touch-and-go or full stop)); a touch-and-go / low approach calls `continueInPattern` (LANDING -> PATTERN, UPWIND on the
  `rt.closedTraffic` side, left by default) and a departure with `rt.closedTraffic` joins the upwind leg at lift-off
  (`startClosedTrafficPattern`). Requested reports are `rt.reports`; `towerVocabularyCalls` fires them at midfield abeam (along <= half the
  runway), when `rt.pattern.leg` becomes BASE, or at the requested distance on final.
* **Frequency, squawk, information.** `FREQUENCY_CHANGE_APPROVED` (airborne VFR only): `handedOff`, then a silent `pendingFreq` with
  `NO_FREQUENCY_MHZ` (0): the aircraft is on no ATC frequency (the dataset has no advisory frequency for KACY / KMHT and none is invented),
  a HANDOFF event says it left the frequency, no check-in follows, the strip moves to the OTHER bay and it despawns as handled. `SQUAWK` sets
  `ac.squawk` (and the flight plan's). `info` (wind / altimeter) on a command or `AIRPORT_INFO`: `rt.haveNumbers`; a mismatch with the
  observation is an improper-instruction flag. Light VFR pilots (`pilotBehaviour.noAtisFraction`) do not give the ATIS code and, after
  `numbersRequestAfterSec` of waiting on Tower, ask once for wind and altimeter.
* **Touch-and-go ground roll.** At touchdown with a touch-and-go (or an option the pilot resolves that way) `touchdown()` checks the runway
  ahead: it must hold the type's `takeoffDistanceFt` and the whole roll (`touchAndGoRollM`), less 60 m. If not, the pilot says "unable touch and
  go, not enough runway, full stop" and rolls out normally. Otherwise the aircraft stays in ROLLOUT on the ground (`rt.tgo`, `stepTouchAndGo`):
  `TGO_DECEL_SEC` = 3 s of normal landing deceleration, `TGO_RECONFIGURE_SEC` = 3 s at that speed, then takeoff acceleration to
  `rotateSpeedKt`, lift-off and `continueInPattern` (ROLLOUT -> PATTERN). These two intervals are design values, not FAA figures. The runway
  is occupied for the whole roll (runway occupancy and same-runway separation see a landed aircraft on it); wind is ignored during the roll.
* **Pilot behaviour tuning (`pilotBehaviour.ts`, `Scenario.pilotBehaviour`).** The probabilities and times that make simulated pilots imperfect
  are DESIGN VALUES (the FAA text defines the situations, not the rates), gathered in one object with these defaults: `noAtisFraction` 0.4,
  `numbersRequestAfterSec` 20, `followMarginSec` 10, the `ground` block (see Ground operations below) and `look` { `maxRangeSm` 10, `pAhead` 0.95 within `aheadDeg` 60 of the nose, `pSide` 0.6 within
  `sideDeg` 110, `pBehind` 0.2, x`altFactor` 0.5 above `altDiffFt` 3000, x`farFactor` 0.7 beyond `farShare` 0.6 of the range, `immediateShare` 0.6
  of the probability seen at once, otherwise acquired `acquireMinSec` 6 + up to `acquireSpreadSec` 10 s later }. A scenario overrides any subset
  (`pilotBehaviour: { noAtisFraction: 0, look: { pAhead: 1 } }`) so a later task can scale them by difficulty. The touch-and-go roll intervals
  (`TGO_*`) and the 0.75 nm "turn base now" minimum are also design values but are constants in `flightDynamics.ts` / `towerCommands.ts`.
* **Ground operations (`pushback.ts`, `groundMovement.ts`, `traffic.ts`, `commandExecutor.ts`, values in `pilotBehaviour.ground`).**
  - *Pushback.* Phase `PUSHBACK` (PARKED -> PUSHBACK -> READY). Only non-light aircraft on `airline` / `cargo` stands (`pushbackStand`) push back; GA ramp aircraft refuse a PUSHBACK ("we'll taxi on our own power") and start up by themselves. `pushbackGeometry` takes the stand's lead-in edge (the `apron_connector` to the lane) as the path and its far node as the PUSH POINT (AC 150/5300-13B 5.17.1 item 2); the final nose heading is one lane direction at that node: the one whose tail (or nose) fits the requested `pushTailDeg` / `pushFaceDeg` within 70 degrees (else "we can only push tail <dir> from here"), or with no request the one with the shorter route to the active departure holds. `stepPushback` moves the aircraft opposite to its nose at `pushbackSpeedMps` 1.2 (0.4 m/s^2 ramps, `pushStartDelaySec` 8 s) and swings the nose at `pushSwingRateDegPerSec` 3 over the last stretch (it carries on in place if the lead-in is too short); `groundSpeedKt` is the speed of travel, `trackDeg` the direction of travel (opposite the heading). It waits while any other moving or lane aircraft is within half the two lengths + 8 m of the push point. The aircraft is in the normal `findLeader` cone logic throughout; a READY aircraft stays "not lane traffic" only while it has not been pushed back.
  - *Timing.* An airliner at a gate: `firstCallAtSec` (3-8 s) "request pushback" (ATIS code; IFR after its clearance and the Ground tune-in), repeated every `pushbackRepeatAfterSec` 90 s; a taxi instruction before the push is refused ("we need a pushback first", no score). After the push + `pushSettleSec` 4 + a seeded [15, 45] s (`airlinerReadyAfterPushSec`) it calls "pushed back from Gate N, ready to taxi" and goes READY. GA: `firstCallAtSec` + a seeded [8, 25] s (`gaStartSec`). `airlinerPushback: false` (the test fixtures) makes airliners taxi from the stand as before.
  - *Hold-short readback.* `buildReadback` leaves the hold-short out of a TAXI readback for the share `holdShortOmitFraction` (seeded `hs-omit:<clearance id>`); `markUnreadHoldShort` puts the first hold line and the named hold-short points in `route.unreadStopNodeIds` (hard stops that no authorisation lifts) and `rt.unreadHoldShort`; the pilot stops there and asks ("say again hold short instructions"); `READ_BACK_HOLD`, a re-issued HOLD_SHORT covering it, or a new TAXI resolves it (`resolveUnreadHoldShort`); `holdShortReadbackGraceSec` 20 s after the clearance a `READBACK_ERROR` with `commError` is emitted (score -2, once). A wrong taxiway in the route readback (`ReadbackError.kind 'taxiway'`, seeded `twy-err:<id>`, probability `readbackErrorRate x taxiwayErrorShare`) is corrected like a wrong runway. Both mistakes are off when `readbackErrorRate` is 0 unless the scenario sets the value explicitly (`groundBehaviour(ctx)`); training mode defaults them to 0.
  - *Route-less taxi.* A TAXI to a runway with no `route` (not CONTINUE, not a segment) is flagged (`3-7-2`, scored as a communication error); training refuses it; an unfamiliar pilot (`unfamiliarFraction` 0.1, seeded `unfamiliar`) refuses it in free play too with "Runway N, say route". *Progressive taxi*: unfamiliar pilots add "request progressive taxi" (`PendingRequest.progressive`); a TAXI with `segment: true` turns onto `route[0]` on the requested side of the heading (`firstTurnNode`) and goes to the point named (`destination: 'TWY<x>'`, the AI gives the exact node in `toNodeId`) or to the next intersection (`walkAlong`); an EXIT_RUNWAY with a taxiway on an aircraft that is not landing is read as that turn, and a "continue to Charlie" in the same transmission keeps it (`rt.segmentTurn`, 3 s). At the end of a segment the pilot asks for the next one.
  - *Speeds.* Cruise = type taxi speed x a seeded factor in [`taxiSpeedMinFactor` 0.85, 1]; 13 kt (`taxilaneMaxKt`) on parking / apron nodes; corner speed linear from full speed at 15 degrees to the turn speed at 90 degrees (`cornerSpeedMps`). Arrivals stay at the stand `arrivedLingerSec` 120 s after ARRIVED.
* **LUAW (3-9-4).** `luawTrafficIssue`: closest airborne arrival / pattern aircraft for the same runway within 6 nm (`LUAW_TRAFFIC_NM`)
  needs traffic information (`trafficAdvised`, or a traffic advisory in the last 15 s); free play flags, training refuses. After
  `LUAW_LIMIT_SEC` = 90 s lined up and stationary the pilot asks for intentions.

## Landing rollout and runway exit

Braking follows the sourced landing distances (A320 6 kt/s, C172 4.4 kt/s; maximum braking = 1.4x). At touchdown `chooseExit` takes the
FIRST exit (runway node beside a hold position of that runway) the aircraft can reach at that exit's safe speed braking no harder
than normal, else no harder than the maximum. Exit speed: 60 kt for a 30 degree connector falling to 30 kt for a 90 degree one, and
never more than the speed from which it can stop at the hold line (~22 kt for a 76 m connector). The aircraft brakes at least at the
planned rate, harder if it falls behind, and rolls at the exit speed to the exit. If no exit is reachable it stops short of the runway
end (60 m) and short of any intersecting runway's hold line (60 m + half its length): never in the intersection, and asks for taxi
instructions ("stopped on runway ..., unable to exit, request taxi instructions"). Measured on KACY in calm air (touchdown at
~1,284 / 1,601 ft): C172 13 exits at 2,017 ft, clear 14 s after touchdown; C172 31 2,200 ft / 17 s; C172 4 3,397 ft / 49 s; C172 22 2,748 ft
/ 31 s; A320 13 4,444 ft / 25 s; A320 31 5,557 ft / 34 s; A320 4 3,397 ft (taxiway B, braking ~7.8 kt/s) / 17 s; A320 22 6,101 ft / 38 s.

## Phraseology audit (docs/PHRASEOLOGY-AUDIT.md)

Applied in `src/radio`: R-F1 ("Clearance Delivery"), R-B1 (taxi readback "Runway one three, taxi via ..."), R-B2 / R-B2b / R-B2c (IFR
clearance: "Cleared to Philadelphia airport", "expect one zero thousand, one zero minutes after departure", "departure
frequency ..."), R-B3 (ready to taxi: "IFR to Philadelphia"), R-B5 ("leaving 1,200, climbing to 2,000" / "level 5,000" instead of
"passing"), R-B6 (mileages as digits: "one zero miles"), R-B7 ("established on the ILS runway one three"), R-S3 (leading-zero flight
numbers digit by digit), R-I1 (IFR clearance problems: "Unable, we filed to Philadelphia"; an unusable altitude / squawk /
frequency is a "Say again the squawk code", not "Unable"). **Not applied:** R-B4 ("with information X" is the common US form
and pilots and controllers use it; "information X received" would be more literal AIM 4-1-13) and R-S1 (the ATIS channel
125.725 is printed on the chart as such, so it is spoken in full; the controller rule of two decimals is not applied to readbacks).

## Airport state (`airportOps.ts`, `SimulationState.ops`)

Sources: JO 7110.65 2-9-3, 3-3-1, 3-3-2, 3-3-4, 3-3-5, 3-4-10, 3-4-11, 2-1-23; AC 150/5370-2G 2.18.2.1.2; AC 150/5200-30D (docs/FAA-REFERENCES.md).
* **Closures** (`Closure`: runway pair id or taxiway designator, `startSec`, optional `endSec`, reason, source). Added by `scenario.closures` (setup options, in force from t = 0), the scenario event runner (`engine.addClosure`) or tests; the engine announces a start and an end once each (`NOTAM: Runway 4/22 closed (...)`, `NOTAM cancelled: ...; reopened.`). `addClosure` refuses an unknown ident and the last open runway.
  Effects: (1) taxi routing: `findTaxiRoute` / `shortestDistances` / `pickRunwayHold` take `avoidTaxiways`; a closed taxiway is never in a route, "taxi via <closed taxiway>" and "taxi to <closed taxiway>" are refused (`Taxiway H is closed`, pilot: "unable, taxiway hotel is closed"), a taxi to a hold of a closed runway is refused, a runway exit onto a closed taxiway is not used for the rollout (`chooseExit`). A taxiway that closes under an aircraft already routed over it is handled by `enforceClosuresOnRoutes` (`airportOps.ts`, run each tick before ground movement): the aircraft stops at the last node before the closed segment (`rt.closedHold`), the pilot calls the hold with a pending TAXI request (plain English, non-standard), and AI Ground re-routes it around the closure (`ai/ground.ts`).
  (2) `assessClearanceSafety`: TAKEOFF, LINE_UP_AND_WAIT, LAND, APPROACH, ENTER_PATTERN to a closed runway is an `UNSAFE_CLEARANCE` naming the closure and 3-3-2 (training refuses it with that reason; other modes accept and score it as unsafe). (3) The runway selector never picks a closed end (`recommendRunways` `excludeEnds`); the UI session switches the active runways when the runway in use closes. (4) The ATIS reads closures as NOTAMs; the Surface and Tower views mark them; the strips and the Weather panel list them.
  Crossing a closed runway on a taxi route is still allowed (a taxi across a closed runway needs a clearance like any crossing).
* **Braking action**: a landing pilot on a wet / contaminated runway (derived from the weather, src/weather/runwayCondition.ts) reports after exiting: "<facility>, <callsign>, braking action medium." (3-3-4 terms; the RCAM row of the derived code, one step better or worse with probability 1/4 each from the seeded RNG; at most one report per runway end per 10 minutes unless worse; `traffic.ts` block 4c). The report is stored with the aircraft type (`BrakingReport`); the ATIS gives it as "Braking action medium, reported by a Boeing seven thirty seven" and the AI Tower includes the latest report (or "no braking action reports received for runway N") in a landing clearance while advisories are in effect (3-3-5).
* **Runway lights** (`RUNWAY_LIGHTS` command, `ops.lightStep`): HIRL steps 1-5 (both airports' runways are HIGH intensity in NASR). Default step from TBL 3-4-8 by visibility and daylight (`defaultLightStep`); lights are on at night and, by day, below 2 SM (3-4-10). A pilot request ("request lights up / down", free play only: `scenario.pilotRequests.lights`; about one arrival in eight at night or in low visibility, decided from the aircraft's own seed so no shared random number is drawn) is answered with `RUNWAY_LIGHTS` (one step up or down, or an explicit step); a closed runway's edge lights stay off (3-4-10: "Do not turn on the runway edge lights when a NOTAM closing the runway is in effect"). The Tower view reads `effectiveLightStep` per runway.
* **Bird activity** (`ops.birds`, 2-1-23 / 2-9-3): `ADVISORY` command (`advisory: 'BIRDS'`), acknowledged "Roger, we'll watch for the birds"; the ATIS says "Bird activity in the vicinity of the airport, ..." while it lasts.
* **LAHSO and the runway condition**: `planLahso` no longer carries its own precipitation list: a runway is "dry" when `runwayCondition(weather).code === 6` (any precipitation at the airport = not dry; vicinity (VC) precipitation no longer counts).

## STAR arrivals (`star.ts`, `Aircraft.star`; KMHT ROZZE TWO)

Sources: JO 7110.65 4-7-1 ("(STAR name and number) ARRIVAL, (transition name) TRANSITION"), 4-5-7 / 5-7-2 ("DESCEND VIA", speed restrictions apply regardless), AIM 5-4-1 (maintain the last assigned altitude until "descend via"; vectors or a deviation cancel the STAR with its restrictions).
* Data: `InstrumentProcedure.star` (data/sources/kmht-procedures.json, README "ROZZE TWO ARRIVAL"). KACY has no STARs.
* An arrival spawned with `start.star` (or cleared with the `STAR` command) has `ac.star = { procedureId, name, transition?, runwayEnd, descendVia }` and flies `nav` (mode route / direct) over the transition fixes, the runway leg and the expected approach's join fixes. `STAR` command (`planStar`): needs a published name (an unknown or wrong number is refused / not guessed by the parser), a runway leg for the aircraft's landing runway, and a way onto the route: it is already on it, one of its remaining route fixes is on it, or a transition is named (the route then starts at that entry fix). "Descend via" sets the target altitude to the lowest altitude of the remaining restrictions; a plain "cleared ROZZE TWO arrival" leaves the vertical state alone.
* Flown in `routeGuidance`: after "descend via" the altitude restrictions (`profileAltitudeFor`: descend just in time, never below the next at-or-above altitude, at-or-below altitudes met 200 ft low, never climbing); the speed restrictions whenever the aircraft is on the arrival (`starSpeedCap`: slows to a restricted speed over the distance the engine's deceleration needs plus 10 s, then holds it until the next restricted fix; 250 kt otherwise, 91.117(a)). The APPROACH phase's slower default speed does not apply until the approach is cleared.
* Ends: the last fix of the runway leg is the IAF; runway 24 ends "then on heading 057" (the pilot takes the heading, magnetic, and expects vectors). Cancelled by: vectors (`enterVectors`), direct to a fix not on the aircraft's route, the approach clearance. An altitude assignment ends "descend via" but keeps the speed restrictions and the route.
* AI Approach (`src/ai/approach.ts`): radar contact + "descend via the Rozze Two arrival", no separate descent or direct-to-IAF while the aircraft is before the IAF, then the approach clearance (the clearance cancels the STAR).
* Simplifications: the published transitions begin 47-100 nm out; the game layer starts flights at CRIBB or FLYZZ (src/game/README.md). No Mach, no pilot "request different altitude", no speed-restriction waiver. `LOST_AIRCRAFT_NM` removal now applies only to aircraft moving away (an arrival entering from a STAR fix beyond 40 nm is kept).

## Airport data contract

`checkAirportForSim(airport)` (see `airportCheck.ts`) reports what is missing. IFR operations additionally want CLNC and DEP/APP
frequencies and `procedures[].fixes` that exist in `navaids` (warnings only). In short: runway polygons;
for every runway end a `holding_position` node (runwayId set, optional `protectsRunwayEnd`) adjacent to a
`runway` node; exits = `runway` nodes adjacent to a `holding_position` of the same runway; edges on a runway
surface carry `onRunwayId`; parking nodes of kind `parking`; GND/TWR frequencies.

## Coordination between positions (`coordination.ts`, `state.coordination`)

A typed message channel between controller positions, replayable and deterministic (ids are counters, times are sim seconds, nothing random). `state.coordination`
= `{ requests, messages, human, staffed }`; every message is also a `COORDINATION` `SimEvent` (`data.msgKind`, `from`, `to`, `requestId`, `standard`), so a session replays from the log.

* **Requests** (`CoordRequest`): topic `CROSSING` (runway id, point), `RELEASE`, `POINT_OUT` (position text, altitude); status `pending -> standby | approved | denied`, `approved -> used | expired | rescinded`, `used -> completed`.
  A repeated request for the same aircraft / runway is the same request with `asks + 1` (a repeat inside 5 s is ignored); a request nobody answers is dropped (`expired`) 240 s after the last ask.
* **Messages** (`CoordMessage`): `CROSS_REQUEST / APPROVED / UNABLE / STANDBY / RESCINDED / COMPLETE`, `RELEASE_REQUEST / RELEASED / HOLD_FOR_RELEASE / RELEASE_STANDBY`, `POINT_OUT / POINT_OUT_APPROVED / POINT_OUT_UNABLE / TRAFFIC_OBSERVED`,
  `ROLLING`, `GOING_AROUND`, `TRAFFIC`, `TEXT`, each with `text` (digits), `spoken` (words), `standard` (the FAA's wording, 7110.65 3-1-3 / 4-3-4 / 5-4-3) and the `reference`. `describeMessage` builds them.
* **API** (`engine.coordination`, `engineExtras.ts`): `request`, `respond(id, 'approve' | 'deny' | 'standby', { by, source, afterAircraftId?, reason? })`, `rescind`, `inform`, `setStaffing(human, ai)`.
  The Landline panel, the landline parser (`src/commands/landline.ts`, `src/ui/commands/landline.ts`) and the AI (`src/ai/coordination.ts`) all use it; `source` is `player | ai | system`.
* **Who is staffed**: `setStaffing(human, ai)`; default = every position of `scenario.controllerPositions` staffed, `scenario.playerPositions` (default all) human. A person working both positions of a pair coordinates
  with himself (`sameController`): no rule, no message. An unstaffed position is never waited for.
* **Rules** (`crossingGate`, `releaseGate`, called by `planCross` and `planTakeoff`):
  * CROSS_RUNWAY issued as GND on a runway of the active configuration (`runwayIsActive`) needs Tower's current approval for that aircraft and runway (JO 7110.65 3-1-3). Training refuses (no pilot readback, not a communication error) with the reason and the paragraph; free play and career accept and emit a `COORDINATION` event with `data.error` (+1 coordination error, -3 points). An approval with `afterAircraftId` ("behind the landing X") is not usable until X is on the ground, clear of the runway and not rolling out (`afterAircraftClear`).
  * TAKEOFF issued as TWR to an IFR departure needs a current release from Departure (Approach when no Departure is staffed) unless the same person works both, or `Scenario.coordination.releasesRequired === false` (LOA concept, 4-3-4). Same consequences.
  * Lifetimes (`COORDINATION_DESIGN`, design values, not FAA numbers): crossing approval 60 s (restarts while a "behind the landing X" approval waits for X), release 120 s, open request 240 s, AI re-ask 30 s, duplicate window 5 s, crossing closed anyway 180 s after use, point-out geometry 4 nm, release spacing 45 s.
  * `updateCoordination` (once per tick): expires stale approvals / requests and aircraft that left, and when the crossed aircraft has left the runway marks the request `completed` and posts `CROSS_COMPLETE` as `system` (3-1-3: the ground controller advises Tower, verbally or by visual aid; the engine is the visual aid).
* Not modelled: vehicles, runway changes and intersection departures announced to Tower (3-1-4), radar handoffs between sectors, delegated airspace for point outs (information only).
Tests: `coordination.test.ts` (22).

## Known limitations

* Performance tables carry `source:` comments per changed value (data/sources/aircraft-performance.json, docs/REALISM-VERIFICATION.md); A320 roll ~35 s / ~1.3 km to rotation, takeoff distance 5,000 ft (refused from an intersection of KACY 4/22 with less remaining).
* Simplified physics: first-order heading/vertical dynamics, constant accelerations, no density altitude,
  steady wind (gusts ignored), no wake turbulence; braking action is reported and published but does not change the rollout.
* Rejected landings on the runway are not modelled (a rejected takeoff is, see Tower vocabulary); an aircraft told to line up cannot be
  told to exit the runway again except by a taxi instruction from the position it stopped in.
* Pattern work: upwind, crosswind, downwind, base, final with a fixed 0.8 nm offset and one pattern altitude (1,000 ft AGL) for every type; no overhead
  maneuver, no parallel-runway patterns; a touch-and-go is a low pass (no ground roll). Holding patterns are flown (holding.ts).
* Pushback moves the aircraft along the stand lead-in only (no tug, no wing-walker, no jet blast, engine start is a delay); shutdown is a phase change (the aircraft lingers 120 s). No vehicles, no de-icing, no helicopters.
* After a go-around the aircraft flies runway heading at a fixed altitude until instructed.
* IFR: no procedure turns, DME arcs; STARs only where transcribed (KMHT ROZZE TWO); published fix altitudes on approaches and the STAR restrictions are flown, approach speed restrictions are not; one transponder code per aircraft, no radar coverage model (everything is "radar
  contact" once identified); departure clearance has no void time; the missed approach is "2000 ft on runway heading" only when the plate text is unavailable or not interpretable.
* Free-play traffic generation still spawns arrivals on the extended centreline, not at fixes (scenarios use `at_fix`).
* `radioState` `RECEIVING` is not used (readbacks are instantaneous); no frequency congestion yet.


## Wind, gusts and runway-end physics (2026-10-18)

* **Gusts (`wind.ts`)**: with `Weather.windGustKt > windSpeedKt` every aircraft flies in its own seeded gust process (first-order Gauss-Markov, time constant 8 s, smoothed with 2 s, scaled by the gust spread; speed in [mean - 0.5 x spread, gust], direction wander up to 2 sigma, sigma = min(10 deg, 0.6 deg per kt of spread)). Seed = `hash(scenario seed, aircraft id)`: it never touches the shared `engine.random()` stream, so the same seed replays identically, spawn order does not matter, and every other random decision is unchanged. No gust, calm or VRB: exactly the steady wind and no draw. All constants are DESIGN VALUES (no source); see the header of `wind.ts`.
* **Effects**: the airborne kinematics use the gusted wind while the guidance (crab angle) assumes the steady wind, so gusts move the track; the change of the headwind component is added to the airspeed (ground speed is continuous) and the speed controller removes it at the type's accel / decel rate (`rt.gustAirKt`); in the takeoff roll the airspeed follows the gusted headwind (rotation time and ground run vary); in the flare the gust-added airspeed balloons the aircraft and a lull sinks it (25 ft/min per kt, `GUST_LIFT_FPM_PER_KT`), so the float and the touchdown point scatter. Touchdown ground speed = airspeed - effective headwind, so the rollout follows the wind component.
* **Limits**: `AircraftPerformance.maxCrosswindKt / maxTailwindKt` exist only where a source is cited (C172 15 kt, POH172S demonstrated; every other type undefined = no limit, see `docs/REALISM-VERIFICATION.md` section 8). `commandExecutor.windRefusal`: LAND or TAKEOFF onto an end whose EFFECTIVE component, steady + 0.5 x (gust - steady) (design decision: the C172's 15 kt is a demonstrated value, not a limitation), exceeds a limit is refused ("Unable, runway four, crosswind is above our limit, request runway three one, <callsign>", best other end within limits by headwind); not a controller communication error. On final (inside 1 nm, above 50 ft AGL) the instantaneous gusted component over the limit by 5 kt or more for 2 s is a go-around with the reason "crosswind exceeds our limit" / "tailwind exceeds our limit".
* **Glidepath (`glidePathFor`)**: a cleared instrument approach flies its plate angle and TCH (`InstrumentProcedure.glidepath`, from `data/sources/*-plate-geometry.json`); a visual approach or no approach flies the runway end's NASR VGSI angle and TCH (`RunwayEnd.visualGlidepath`), except light aircraft (50 ft, design); anything else the labelled 3 deg / 50 ft default. `glideAltitudeFt(elev, d, gp)`.
* **Missed approach altitude**: `publishedMissedAltitudeFt` (structured `InstrumentProcedure.missedApproach.finalAltitudeFt`, else the parsed text). `initiateGoAround` targets it for IFR aircraft, 2,000 ft only when the dataset has none. `parseMissedApproach` also reads the "CON VOR/DME R-154 to KHRIS/CON 21.3 DME" form of the KMHT plates.
* **Pattern altitude (`patternAltitudeFt`)**: AIM 4-3-3, propeller field + 1,000 ft; large or turbine-powered (`AircraftPerformance.propulsion`) field + 1,500 ft; `Airport.trafficPatternAltitudeFt` (none in the datasets) when published.
* **Displaced thresholds (`runways.ts`)**: `RunwayEnd.threshold` is the PAVEMENT end; `RunwayEndGeom.displacedM / landingThreshold` move the landing threshold. `courseGeom` rebases the approach frame (glidepath, decision point, capture) on it; takeoff, rollout, exits and occupancy stay on the pavement; `ldaM` / `toraM` are the NASR declared distances (declared LDA wins over the geometry); LAND is refused if `landingDistanceFt` exceeds the LDA; the takeoff run check uses TORA. The `touched down` INFO event reports `alongM` from the landing threshold (plus `alongPavementEndM`, `displacedM`).
* Spacing and timing: `projectArrival`, `timeToThreshold`, the intersecting-runway arrival check and the 3-10-3 landed-aircraft distance use the landing threshold (`displacedM`); pavement-end positions remain for takeoff, rollout and occupancy.
* Known simplifications: no turbulence or wind shear, no vertical gust component.

## Traffic variety: helicopters, vehicles, fighters, VFR transits, training (`rotorcraft.ts`, `vehicles.ts`, `special.ts`, `specialCommands.ts`)

New aircraft types (`performance.ts`): `H65` (`craft: 'rotorcraft'`), `F16` (`military`), `VEH` (`craft: 'vehicle'`); numbers and their sources in docs/REALISM-VERIFICATION.md section 9. Callsign tags `CGD#####` (spoken "Coast Guard ..."), `ANG#####` ("Air Guard ..."), `APT<n>` ("Airport <n> vehicle"); see docs/FAA-REFERENCES.md "Traffic variety". Spawns carry a `behavior` (`SpawnBehavior`, types.ts): `vehicle`, `transit`, `training`, `military`, `helicopter`; `spawnFromSpec` applies it (`initVehicle`, `initSpecial`).

* **Helicopters (`rotorcraft.ts`)**: hover taxi and air taxi are ground movements (JO 7110.65 3-11-1, AIM 4-3-17): the `AIR_TAXI` command is the taxi planner with `rt.heli.taxiMode`; the aircraft stays `onGround` on the graph (hold-short lines, runway authorisations, occupancy and incursions apply) while `updateRotorcraft` lifts it to 15 ft (hover) / 40 ft (air) and `groundMovement` flies it at 10 / 35 kt. `TAKEOFF` without a runway = lift-off from the present position (vertical rise, turn on the spot, then `flightDynamics`); `LAND` with a helipad destination = 6 degree descent, hover, vertical landing (phase LANDING -> ARRIVED, two new transitions in stateMachines.ts); `HOLD_POSITION` airborne = hover. `rotorOwnsMotion` makes flightDynamics skip a helicopter in those modes. Wind is not applied in hover / approach.
* **Vehicles (`vehicles.ts`)**: tasks `RUNWAY_INSPECTION`, `PAVEMENT_INSPECTION`, `ERRAND`. Calls are the AC 150/5210-20A templates; `PROCEED` (planner `planProceed`) drives the runway from the hold to the far exit (`runwayRun`: runway centreline nodes in order, hold to entry as for a line-up), authorises the intersecting runways (3-7-2), and `assessClearanceSafety` refuses it with traffic on the runway, a departure / landing / line-up, or an arrival within 8 nm or in the pattern (`FINAL_PROCEED_NM`). A runway inspection closure of the airport-events (`reason` contains "inspection") spawns an inspection vehicle for that runway (game/specialGenerator.ts). Ground alert distance for vehicles 5 m.
* **VFR transits, training, overhead (`special.ts`)**: a transit flies the straight chord from its spawn point to `exitPos` at a 91.159 altitude and is removed on arrival there; training aircraft count touch-and-go circuits (`flags.circuits`, decremented by `continueInPattern`); the overhead maneuver (`flags.overhead` INBOUND / INITIAL / BROKE) flies the extended centreline at pattern altitude and 200 kt, breaks over mid-runway into the pattern (`rt.pattern` DOWNWIND); fighters turn base 3.5 nm out. Formation: `Aircraft.formation = { size }` is one aircraft for control, separation and spacing (2-1-13).
* **Pilot calls** for all of these are in `src/radio/specialCalls.ts`, made from `traffic.ts updatePilotRequests` (vehicles and helicopters skip the aeroplane logic entirely).
* Tests: `rotorcraft.test.ts`, `vehicles.test.ts`, `special.test.ts`; behaviour table rows V1-V12 in docs/BEHAVIOUR-ACCURACY.md.
