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
| `traffic.ts` | Spawning, automatic pilot calls, frequency-change application, despawn, `TrafficGenerator` interface |
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
5. **flight dynamics** (airborne aircraft + takeoff roll + landing rollout)
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

## Parking destinations

`parkingResolver.ts` resolves a `TAXI`/`TAXI_TO_PARKING` destination by exact id, id without punctuation
("GATE1" -> "GATE-1"), name, then category keyword (GATE/TERMINAL=airline; RAMP/GA/GENERAL AVIATION=ga; FBO;
CARGO/FAA=cargo; ANG/MILITARY=military). A category, "PARKING" or no destination picks the nearest (by taxi
route) UNOCCUPIED spot: the requested category, else the spawn category, else the aircraft's natural one
(airline callsign / large type -> airline, N-number -> ga). Spots occupied by, or already assigned to, another
aircraft are skipped. The chosen id is stored in `Clearance.destination`; the readback says "gate three" or "the ramp".

## Airport data contract

`checkAirportForSim(airport)` (see `airportCheck.ts`) reports what is missing. In short: runway polygons;
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
* `radioState` `RECEIVING` is not used (readbacks are instantaneous); no frequency congestion yet.
