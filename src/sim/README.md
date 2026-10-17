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
| `missedApproach.ts` | Interpreter and guidance for the published missed approach text; published-hold lookup |
| `solar.ts` | NOAA solar position at the airport: `isDaylight` / `sunriseSunsetUtc`, the engine epoch (`utcStartMs`) for sunrise-sunset rules |
| `mva.ts` | Minimum vectoring altitude lookup (`Airport.mvaSectors`, optional `holes`), 2 nm look-ahead, exemptions |
| `holding.ts` | Holding patterns with the AIM 5-3-8 direct / teardrop / parallel entries, `holdingText` parser |
| `minima.ts` | Approach minima from `minimaText`, runway-in-sight test for the decision altitude |
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

## Airport data contract

`checkAirportForSim(airport)` (see `airportCheck.ts`) reports what is missing. IFR operations additionally want CLNC and DEP/APP
frequencies and `procedures[].fixes` that exist in `navaids` (warnings only). In short: runway polygons;
for every runway end a `holding_position` node (runwayId set, optional `protectsRunwayEnd`) adjacent to a
`runway` node; exits = `runway` nodes adjacent to a `holding_position` of the same runway; edges on a runway
surface carry `onRunwayId`; parking nodes of kind `parking`; GND/TWR frequencies.

## Known limitations

* Performance tables carry `source:` comments per changed value (data/sources/aircraft-performance.json, docs/REALISM-VERIFICATION.md); A320 roll ~35 s / ~1.3 km to rotation, takeoff distance 5,000 ft (refused from an intersection of KACY 4/22 with less remaining).
* Simplified physics: first-order heading/vertical dynamics, constant accelerations, no density altitude,
  steady wind (gusts ignored), no wake turbulence, no braking-action effects.
* Takeoff abort and rejected landings on the runway are not modelled; an aircraft told to line up cannot be
  told to exit the runway again (no such command yet).
* Pattern work is minimal (downwind -> base -> final, fixed 0.8 nm offset); holding patterns are not flown.
* Pushback is a state change only (no motion). No vehicles, no de-icing, no helicopters.
* After a go-around the aircraft flies runway heading at a fixed altitude until instructed.
* IFR: no procedure turns, DME arcs, STARs, speed restrictions per fix (published fix altitudes on approaches are flown); one transponder code per aircraft, no radar coverage model (everything is "radar
  contact" once identified); departure clearance has no void time; the missed approach is "2000 ft on runway heading" only when the plate text is unavailable or not interpretable.
* Free-play traffic generation still spawns arrivals on the extended centreline, not at fixes (scenarios use `at_fix`).
* `radioState` `RECEIVING` is not used (readbacks are instantaneous); no frequency congestion yet.
