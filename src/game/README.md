# src/game - gameplay layer

Scenarios, traffic generation, free play, career progression, training mode, objectives, scoring debrief. Pure TypeScript,
no DOM. The UI depends only on `index.ts` (`GameApi` and the related interfaces; `FreePlayOptions.ifrFlows` is the only addition, optional) plus a few extra exports from
`game.ts` listed below. Nothing in `src/sim` was modified; the engine is driven through its public API only (the IFR flows also import the engine's
read-only helpers `analyzeProcedure` / `matchingProcedures` / `findNavFix` so the fixes always come from `airport.procedures` and `airport.navaids`).

```ts
import { game, createScenarioEventRunner, scenarioWeatherSchedule, TRAINING_DISCLAIMER } from '../game';
const sc = game.buildScenario('career-03-single-landing', loadKacy());
const engine = createEngine({ airport, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, airport) });
const runner = createScenarioEventRunner(engine, sc, { onPilotTransmission: speak });   // scripted events (see below)
const training = game.createTrainingController(sc);                                     // null unless the scenario has steps
engine.subscribe((s) => { runner.update(); training?.update(s); if (game.isScenarioComplete(s)) showDebrief(game.buildDebrief(s)); });
```

## Files

| File | Role |
|---|---|
| `index.ts` | The contract (do not change signatures). Re-exports `game`. |
| `game.ts` | Assembles `game: GameApi`; re-exports the extras below. |
| `types.ts` | `GameScenario` = `Scenario` + optional extension fields (`events`, `difficulty`, `aircraftTypes`, `careerStep`, `briefing`, richer `training.steps`). All plain JSON. |
| `world.ts` | KACY helpers: runway-end geometry (TRUE heading, sin/cos from the threshold), holds, taxi-route planning that mirrors the engine, crossing detection, parking pools (GA ramp/FBO for light types incl. the C208, gates for airliners, the cargo apron for B752/B763/A306 when the airport has one), callsign generators (`randomAirlineCallsign(rng, icao?)` draws from the airport profile), `bearingTo` (neighbours of the session airport's profile). |
| `airportProfile.ts` | Airport traffic profiles keyed by ICAO: weighted airline entries (`icao3`, telephony, types, weight, destinations with cruise altitudes, flight-number range, `hours` 'day'/'night'/'any'), VFR neighbour table (lat/lon + spoken name), GA type variants, reference jet. KACY = Spirit 80 / American 20, A320 only (unchanged); KMHT = Southwest B738, Breeze BCS3, American regionals (PSA CRJ9, Piedmont/Republic E175), American A320, United Express (SkyWest E175, GoJet CRJ9), UPS/FedEx B752 (night bank), Wiggins C208 (day bank), Sun Country, GA C172/PA28. `pickFlight`, `pickLeg`, `resolveTypeSelection`. |
| `scenarios/career.ts` | The 12 career steps. |
| `scenarios/training.ts` | 10 training lessons (8 and 9 are IFR; 10 teaches the crossing coordination between Ground and Tower). |
| `ifr.ts` | IFR flows (also `starArrival` / `starArrivalSpawn` for KMHT's ROZZE TWO, `isTurbojet`): `arrivalProcedure(airport, runwayEnd)` (ILS 13 -> CARYL/VCN, ILS 31 -> STEVV, RNAV 22 -> KOPCE, RNAV 4 -> JEDOB, read from the data), `ifrFlightPlan`, `ifrArrivalSpawn`, `ifrDepartureSpawn`, `resolveIfrFlows`. |
| `scenarios/freeplay.ts` | `buildFreePlay`, weather/runway resolution (closed runways excluded), initial population, setup closures. |
| `scenarios/airportEvents.ts` | Seeded free-play airport events: runway inspection, taxiway closure, bird activity (`buildAirportEvents`, `closableTaxiways`, `birdActivityProbability`). |
| `scenarios/events.ts` | `scenarioWeatherSchedule`, `scenarioEvents`, `createScenarioEventRunner`. |
| `scenarios/index.ts`, `common.ts` | Catalogue + spawn builders. |
| `placement.ts` | Conflict-free arrival/departure placement shared by the generator and the free-play builder. |
| `traffic.ts` | `createTrafficGenerator(scenario, airport)`. |
| `training.ts` | `createTrainingController(scenario)`. |
| `objectives.ts` | Objective predicates keyed by `Scenario.objectives[].check` strings. |
| `debrief.ts` | `buildDebrief(state, startedAtSec?)`, `gradeFor`. |
| `career.ts` | `kacy.career` persistence, `isScenarioComplete`. |
| `references.ts` | Verified FAA JO 7110.65 paragraphs (number, title, URL), `TRAINING_DISCLAIMER`. |
| `testkit.ts` | Test helpers only (typed transmissions through the real parser into the real engine). |

## Scenario catalogue

Career (mode `career`, ids `career-NN-*`, ordered by `difficulty`; `careerStep` 1..12):

| # | id | What |
|---|---|---|
| 1 | `career-01-first-radio` | N723EJ (C172) holding short of 13 at Bravo. Objective: valid takeoff clearance. Tower only. |
| 2 | `career-02-single-takeoff` | N482KB parked GA-2. Taxi to 13 via Delta/Alpha (no crossing, intersection hold at Alpha), hold short, hand to Tower, takeoff. |
| 3 | `career-03-single-landing` | NKS451 (A320) on the 13 final at 8 nm. Clear to land, then contact Ground. |
| 4 | `career-04-multiple-departures` | Two C172 at the 13 holds (Bravo, Charlie) + NKS608 from Gate 4 at 60 s. |
| 5 | `career-05-ground-taxi` | Ground only: N301AC (GA-1 -> 13), N77RK (GA-2 -> 22 via Alpha, **crosses 13/31 at Alpha**), N620G (FBO-1 -> 13 via Bravo, **crosses 4/22 at Bravo**). Routes are computed from the graph and the builder throws if the Alpha crossing is not real. |
| 6 | `career-06-pattern` | Two C172 joining the 13 pattern (left, then right downwind). |
| 7 | `career-07-arrivals-departures` | 3 arrivals (NKS712 final, N35DM from Millville, AAL1201 from Philadelphia) + 2 departures, **NKS329 is an IFR departure to KPHL** (cruise 10,000; positions TWR, GND, CLNC, DEP). Objectives `ifr_clearance:NKS329`, `takeoff:`, `handled:NKS329`. |
| 8 | `career-08-ifr` | IMC preset, GA grounded, positions APP, DEP, TWR, GND. **Three A320 `at_fix` arrivals on the ILS 13 procedure**: NKS244 over CARYL, AAL1672 and NKS377 (6 min later) over VCN (route VCN, CARYL, MAYBN), plus NKS890 holding short on Tower. Objectives `approach:CS`, `landed:CS` per arrival, `takeoff:NKS890`, `no_conflicts`. |
| 9 | `career-09-mixed-performance` | Fast A320 12 nm behind a slow C172 on the same final; two departures, **NKS540 is an IFR departure to KEWR** (cruise 14,000). Objectives `ifr_clearance:NKS540`, `handled:NKS540`. |
| 10 | `career-10-runway-change` | Wind shifts to 300/14 at 600 s (`events`); post-shift traffic is placed for runway 31. Objective `active_runway:31`. |
| 11 | `career-11-complex` | Free-play density: 6 initial aircraft, 20+20 ops/h, max 14, hard ramp, crosswind. Positions TWR, GND, CLNC, DEP: **airline departures are IFR** (initial and generated), arrivals stay on final for Tower. Objective: handle >= 10. |
| 12 | `career-12-emergency` | Scripted pan-pan from NKS1180; objective: it lands before AAL1590 and N305SP. |

Training (mode `training`): `train-01-phraseology` (line up / takeoff / handoff), `train-02-taxi`, `train-03-runway-safety`,
`train-04-crossing` (hold-short readback, KACY diagram note), `train-05-sequencing`, `train-06-pattern`, `train-07-go-around`,
`train-08-ifr-clearance` (Clearance Delivery: wait for NKS451's call, read "cleared to Philadelphia airport via the Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand one zero minutes after departure, departure frequency one two four point six, squawk ...", expected command `IFR_CLEARANCE`; the explanation walks through each element in the order of 7110.65 4-2-1 / 4-3-2; the lesson ends when the pilot switches to Ground by itself),
`train-09-approach` (Approach: NKS451 over VCN at 4,000 ft, 4.3 nm right of the ILS 13 course; vector it to intercept at <= 30 degrees (`HEADING`), "maintain two thousand until established, cleared ILS runway one three approach" (`APPROACH`), wait for `established:NKS451`, hand it to Tower (`CONTACT_FREQUENCY`); explains the intercept angle, the FAF (MAYBN) and the simulator's simplification of the approach gate; the heading in the prompt is computed from the airport geometry).
Free play: `free-play`, `free-play-quiet`, `free-play-mixed`, `free-play-busy-departures`, `free-play-busy-arrivals`.

IFR career conventions: fixes and routes of IFR arrivals come from `airport.procedures` (`common.ts` `ifrArrival`, which throws when a runway has no procedure); an IFR departure is a
parked A320 with `flightPlan` (destination KPHL/KEWR/KBOS..., cruise 10,000-23,000 ft; C172 IFR 4,000-6,000 ft via `ifrFlightPlan`) that starts on `CLNC`; the player needs Ground whenever aircraft land or
taxi (an aircraft told to contact an unstaffed Ground frequency stays on the exit and blocks the next arrival), which is why step 8 lists GND.

Design rules every scenario follows (and `scenarios.test.ts` enforces): ids resolve against `loadKacy()`; only C172 and A320;
no helicopters (USCG) or fighters (ANG); an A320 never sits on a hold it cannot depart from (the engine needs the type's `takeoffDistanceFt`, 5,000 ft for the A320, against the declared runway length minus the entry distance: every 13/31 hold qualifies, on 4/22 only the full-length ends; scenarios keep jets on 13/31 by operator preference); airborne spawns are on the extended centreline at the runway end's TRUE heading
or on real bearings from KPHL (309), KMIV (257), KWWD (209); no two airborne spawns closer than 3 nm; 120 s in a real
engine produce no CONFLICT / INCURSION / SEPARATION events.

Airport facts that shape the scenarios: the terminal and GA ramp are south-west of 13/31; taxiway Bravo crosses 4/22 on the way
to the 13 threshold, and taxiway Alpha crosses 13/31 on the way to runway 22 (both are also the KACY hot spot HS 1).

## Player positions and AI (`FreePlayOptions.playerPositions`, `scenario.playerPositions`)

`scenario.controllerPositions` is the full set of positions that exist in the session (the traffic generator reads it for IFR flows). `scenario.playerPositions` (optional, default = all) is
the subset the human works; every other position is worked by an AI controller (src/ai, wired by the UI session). `game.buildScenario(id, airport, { playerPositions })` and
`game.buildFreePlay(airport, { playerPositions })` set it (de-duplicated; the positions are not forced to be a subset of `controllerPositions`, so a player may work a position
the scenario lists no traffic for). When the option is absent, **career and training scenarios default to the position they are about** (`DEFAULT_PLAYER_POSITIONS` / `defaultPlayerPositions(id)`):

| Scenario | Player works | AI works |
|---|---|---|
| career-03 single landing, career-04 multiple departures, career-06 pattern, train-03 / 05 / 06 / 07 | TWR | GND |
| career-05 ground taxi, train-02 taxi | GND | TWR |
| career-08 IFR, train-09 approach | APP + DEP | TWR, GND (train-09: TWR) |
| everything else (career 1, 2, 7, 9-12, train-01 / 04 / 08, free play) | unset = all they list | none |

Free play leaves it unset; the UI's default there is Tower with AI on the rest.

## Free play

`buildFreePlay(airport, options)` honours every `FreePlayOptions` field: `seed`, `weather` (preset id | `'random'` (seeded) | `'live'` |
a `Weather`), `activeRunways` (else `recommendRunways`, limited to ends the A320 can depart from, judged by `takeoffDistanceFt` vs `Runway.lengthFt` (all four ends at KACY); ties and calm wind go to the longer pair by operator preference, order 13, 31, 22, 4 - not a capability limit),
`aircraftCount` (initial parked departures + inbound arrivals, distinct parking, arrivals >= 3 nm apart, jets placed nearer than Cessnas),
`arrivalsPerHour`/`departuresPerHour`/`gaFraction`/`maxAircraft`, `difficulty` (default rates, max aircraft and the traffic ramp),
`aircraftTypes`, `startingScenario` (`quiet`, `busy_departures`, `busy_arrivals`, `mixed`), `ifrFlows`.

**`FreePlayOptions.ifrFlows?: boolean`** switches the IFR flows (below). `true`: the scenario lists `TWR, GND, CLNC, APP, DEP`, the opening population has the airline arrivals over the procedure fix on `APP` (the first at 0 s, the others 270 s apart so
each leader is about to land when the next checks in; Cessna arrivals are left to the generator in that case) and the airline departures as parked IFR departures on `CLNC`. `false`: classic Tower/Ground behaviour even if the positions include APP/CLNC.
Unset (default): free-play builds list only `TWR, GND` and behave classically; the **traffic generator** then decides from `scenario.controllerPositions` when it is created (APP -> IFR arrivals, CLNC -> IFR departures, independently),
so a UI that lets the player pick other positions either passes `ifrFlows: true` or sets `scenario.controllerPositions` before `createTrafficGenerator`. Scenario-level fields `ifrFlows` / `ifrArrivals` / `ifrDepartures` (`GameScenarioExtras`) carry the decision (career 11 uses departures only).
`scenario.weather === 'live'` stays `'live'`: **the engine substitutes calm default weather for `'live'`**, so the UI must fetch the METAR and call `engine.setWeather`.

## Traffic generator

`createTrafficGenerator(scenario, airport)` returns a null generator unless `scenario.traffic.enabled`. Otherwise (seeded from `scenario.seed`; deterministic):
independent exponential clocks for arrivals and departures at the hourly rates times a ramp (`easy 0.5->1.0 over 20 min`, `normal 0.6->1.25 / 15 min`,
`hard 0.8->1.8 / 10 min`, read from `scenario.difficulty`), a short opening lull, spawns released one at a time alternating arrival/departure, >= 45 s apart,
never above `maxAircraft`. Arrivals: 10-12 nm from the threshold of an active landing runway, half on the centreline and half on a base-leg offset of 20-50 degrees,
2,500-3,000 ft, 100 kt (C172) / 170 kt (A320), >= 3 nm from any other airborne aircraft (5 nm for a faster aircraft behind a slower one on the same final), initial frequency
`TWR` (or `APP` if the scenario has APP but not TWR). Departures: free parking (GA ramp/FBO for C172, gates for A320), initial frequency `GND`,
request `TAXI`; A320 departures are replaced by C172 (or skipped) only when no active departure runway is long enough for the type (never at KACY now: an A320 can use 4/22 from full length; the generator only chooses the gate, the runway entry is the player's and the engine refuses < 5,000 ft remaining). Callsigns: N-numbers in three formats and the airport profile's airline flight numbers (KACY Spirit 80 % / American 20 %; KMHT the mix in `airportProfile.ts`),
unique for the whole session and never ending in the same three characters as an active aircraft.

### Flow control (`traffic.ts`)

Design values (nothing in the FAA order fixes them); the hourly rates are never lowered, spawns wait instead: a due arrival is retried every 10 s, a departure likewise.

* `ARRIVAL_SLOT_SEC` = 200 (was 160; measured on the 2 h soak, 8 runs, docs/PROGRESS.md "Throughput": at 160 s three of the eight runs had a longest wait of 22, 36 and 50 minutes (departures wait for a gap that arrivals 160 s apart do not leave), at 180 s four runs were over 30 and one had 46 go-arounds, at 200 s every run is under 20 minutes; landings per run are within the spread of the Poisson clock): a new arrival is not generated while it would reach the threshold of its runway end within 200 s of another arrival (nominal 520 s for a light aircraft, 330 s for an airliner; other aircraft by distance / expected speed 70 / 145 kt; an aircraft in the pattern or on a missed approach counts as 150 s). One runway shared with departures, crossings and taxiing arrivals takes about one landing per 200 s at the closest spacing (the generated flow is 10 per hour, 360 s).
* `MAX_ARRIVALS_IN_FLIGHT` = 6 airborne arrivals not yet landed.
* `MAX_DEPARTURES_ON_GROUND` = 5 departures parked, pushing back, taxiing or at the hold: the next flight stays at the gate ("expect a delay").
* Measured: with these the 2 h soak at 10 + 10 per hour, 14 aircraft lands 13-22 and departs 12-20 aircraft per run (`src/ai/freePlaySoak.test.ts`).

### IFR flows (`ifr.ts`, applied by the generator and the free-play builder)

Active when `resolveIfrFlows(scenario)` says so (see `ifrFlows` above). GA C172 traffic is never IFR. Without APP (Tower or Tower + Ground sessions) arrivals keep appearing on final already inside the approach (Tower only issues landing clearances).
* **Arrivals**: airline (A320) arrivals are `at_fix` spawns on the procedure matching the active landing runway, read from `airport.procedures` / `navaids` through the engine's `analyzeProcedure`: ILS 13 via CARYL (or from the feeder VCN: route VCN, CARYL, MAYBN),
  ILS 31 via STEVV (STEVV, PRSTY), RNAV 22 via KOPCE (or PIDVE), RNAV 4 via JEDOB (or WYLEA); ILS is preferred, then RNAV. 3,000 ft (50 %), 4,000 (30 %), 5,000 (20 %), feeder starts +1,000 ft; 180 kt; initial frequency `APP`, request `APPROACH`; 25 % of the starts use the feeder when it is usable.
  Spacing: >= 90 s after the previous IFR arrival on the same runway end, >= 5 nm from every other airborne aircraft at the spawn fix, **and** no arrival of the runway within 3.5 nm (along the course) of the point where the engine measures the new aircraft's in-trail gap
  (`arrivalJoinNm`: the next straight-in fix for an IF start - MAYBN for ILS 13 - or the IF for a feeder start). The last rule works around the engine (below) so that an approach clearance at check-in is never flagged unsafe; it means a procedure without a feeder (ILS 31) admits the next arrival only when the leader is about to land.
* **Departures**: airline departures are parked IFR departures with a `flightPlan` (KPHL cruise 10-12,000, KBWI 14-16,000, KDCA 16-18,000, KEWR 12-14,000, KJFK 13-15,000, KBOS 21-23,000; exit fix CYN / ENO / COL when it exists in the dataset), initial frequency `CLNC`, request `IFR_CLEARANCE`.
  They call Clearance Delivery, then Ground by themselves after the clearance, and after takeoff Tower hands them to Departure.
* **Engine limitation worked around**: `assessApproachSeparation` (src/sim/conflicts.ts) measures an aircraft on a route at its *next fix* (`joinDM`), not at its own position. A follower that has just appeared over CARYL is measured at MAYBN (4.6 nm), so clearing it
  while a leader is established 2-7 nm out is flagged `UNSAFE_CLEARANCE` although they are 4-6 nm apart. Fixing it in the engine (use the aircraft's own distance when it is already on the course) would let the generator drop the 3.5 nm rule.

* **STAR arrivals (KMHT ROZZE TWO, `ifr.ts` `starArrival` / `starArrivalSpawn`)**: turbojet airline arrivals (the chart says "Turbojet aircraft only": Caravans and Cessnas keep the approach-fix flow above) appear as `at_fix` spawns with `start.star` over a STAR entry fix, already on the arrival route to the landing runway
  (e.g. runway 6: CRIBB, MONRC, ROZZE, PNARD, TEETO, JAAZZ; runway 17 ends PURBL, LYLAC, BLSSM, BLUUM; runway 35 SHOWZ, IHOBB, ELEEE, YOULL; runway 24 JSTNN, then heading 057). The published transitions start 47-100 nm out, beyond the 40 nm simulated area, so the simulator starts a flight where Boston Center would hand it to Approach:
  over **CRIBB** (entry fix of the CRIBB transition) or **FLYZZ** (on the QUINZ / PONCT / SMYTH transitions), at a whole-thousand altitude inside the published window of that fix (CRIBB 13,000-16,000; FLYZZ at or above 13,000, up to +2,000), 250 kt, frequency `APP`, request `APPROACH`. The aircraft checks in "level one five thousand" and the Approach controller (player or AI) says
  "radar contact, descend via the Rozze Two arrival"; the altitude and speed restrictions are flown after that (src/sim/README.md "STAR arrivals"). Spacing: >= 90 s after the previous IFR arrival on the runway and >= 5 nm from every other airborne aircraft at the entry fix. The initial population uses the same flow (staggered 270 s). KACY has no STAR: its flow is unchanged.

### Airport state: closures and seeded events (`scenarios/airportEvents.ts`, `scenarios/events.ts`)

* `FreePlayOptions.closures` (setup screen: "Close a runway", "Close a taxiway") become `scenario.closures`, in force from time 0; `recommendConfig` and the UI's runway helpers never select a closed runway; an explicit active runway on a closed runway is replaced by the recommended open one. `closures` also apply to catalogue scenarios (the store copies them onto the built scenario).
* `FreePlayOptions.airportEvents` (default true for free play; career 11 turns it off) adds the seeded events to `scenario.events` and `scenario.pilotRequests = { lights: true }`. `buildAirportEvents(airport, seed, { startUtcMs, active, closures })` is a pure function of the seed (own PRNG stream), so seeded runs replay: a **runway inspection** by airport operations (50 % of sessions; 8-35 min in; closes the runway in use 60 % of the time, else the other pair, for 4-8 min, applied only at a quiet time: `quiet: true`, the runner waits until nobody is on, cleared onto or within 8 nm final of the runway), a **taxiway closure** (35 %; 5-40 min in; 15-40 min; only a taxiway that keeps every parking position connected to a hold of the active runways, `closableTaxiways`) and **bird activity** (probability from `birdActivityProbability(startUtcMs)`: spring and fall migration months, dawn and dusk weigh most; 20 % without a start time; 20-45 min). Rates, durations and the bird weights are simulator design choices, not FAA statistics; the wording they trigger (2-1-23, 2-9-3, 3-3-1, 3-3-2) is FAA text.
* `ScenarioEvent` kinds `closure` (`closure: { kind, ident, durationSec?, reason? }`, `quiet?`) and `birds` (`detail`, `durationSec`) are applied by `createScenarioEventRunner` through the engine extras `addClosure` / `setBirdActivity` (src/sim/engineExtras.ts); a closure the engine refuses (unknown ident, the last open runway) is logged and dropped. Any scenario can script them.
* The UI session reacts to both: new ATIS letter and, when the runway in use closed, a switch to the best open runway (src/ui/README.md).

### Airport traffic profiles (`airportProfile.ts`)

Airline callsign, aircraft type, filed destination and cruise altitude come from the session airport's profile (unknown airports use KACY's). `pickFlight` draws a weighted
entry (then a flight number in the entry's range, then a type when the entry has several), `pickLeg` the destination/cruise (or a VFR neighbour for GA) and stamps it on the
spawn as `remoteAirport` so the radio says "request IFR to Charlotte" / "VFR to Nashua" and the aircraft's origin/destination match; without a route (KACY) nothing is stamped and
the engine keeps its legacy origin lists, so KACY seeded runs are unchanged. `hours` weights cargo ('night', 19:00-06:00 local, x0.1 outside) and the Caravan ('day') only in
real-time mode, where the generator knows the local hour (`options.densityAt` is set); otherwise every entry has full weight. The setup screen's type list is filtered by `profileTypes(airport)`;
`aircraftTypes` selects entries whose types are in the list ('C172' stands for GA); a selection that allows nothing at the airport means everything. An airliner departs only when
an active departure runway is long enough for its type (`runwayLongEnoughFor(type)`), otherwise another type or a GA aircraft is chosen. To change the KMHT mix edit the rows in
`airportProfile.ts` (weights are gameplay numbers, not statistics); a new type needs a performance entry (src/sim/performance.ts), an `AIRLINES` word in the parser lexicon,
an entry in `radio/spoken.ts` and, for destinations, a name in `commands/airports.ts`.

## Scenario events (wind shifts, emergency)

`Scenario` has no event schedule, so `GameScenario.events` (JSON) carries `ScenarioEvent`s:
`weather` (`weather`, `text`, `recommendedRunways`), `emergency` (`callsign`, `declaration`, `text`), `message`, `closure` and `birds` (see "Airport state" above).
* `scenarioWeatherSchedule(scenario): WeatherChange[]` - the timed weather changes (`career-10-runway-change`: one change at 600 s, plus a message at 540 s).
* `createScenarioEventRunner(engine, scenario, { onPilotTransmission?, onEvent? })` - call `runner.update()` every tick (or from `engine.subscribe`). It applies due events:
  weather -> `engine.setWeather` + a `SCENARIO` log entry (**the runway configuration is not changed; the player must switch it**; regenerate the ATIS yourself);
  emergency -> sets `aircraft.flags.emergency`, replaces `pendingRequest` with the declaration, logs a PILOT `TRANSMISSION` (`data.emergency`) and passes the text to `onPilotTransmission` for TTS;
  message -> `SCENARIO` log entry.

**What is scripted:** the engine has no emergency behaviour (`flags.emergency` is declared but unused and `SpawnSpec` cannot set it). Career 12 therefore spawns the
aircraft normally (it still makes the engine's own inbound call) and the runner mutates the live aircraft record 6 s later. The aircraft keeps flying a normal approach.

## Objectives

`Scenario.objectives[].check` strings are evaluated by `evaluateCheck(state, check)` (`objectives.ts` header lists them all): `cmd:KIND:CS`, `takeoff:CS`, `landed:CS`,
`vacated:CS` (left the landing runway, not merely the intersecting one), `parked:CS`, `taxied:CS`, `holding_short:CS`, `crossing_request:CS`, `crossed:CS:13/31`, `handoff:CS`,
`go_around:CS`, `landed_before:A:B`, `handled:>=N`, `score:>=N`, `coord:KIND:CS` (a landline message of that kind about CS: `CROSS_REQUEST`, `CROSS_APPROVED`, `CROSS_COMPLETE`, `RELEASE_REQUEST`, `RELEASED`, `ROLLING`, `POINT_OUT` ...), `no_coordination_errors`, `no_incursions`, `no_unsafe`, `no_separation`, `no_conflicts`, `active_runway:31`, `always`.
IFR checks: `handled:CS` (a callsign instead of a number: that aircraft was handled - IFR departures count after handoff, an altitude/direct instruction and leaving the area), `approach:CS` (an `APPROACH` was accepted without
`commError`/`unsafe`: a clearance flagged for intercept angle or inside the FAF does not count, a corrected one does), `established:CS` (the pilot's "established ILS runway ..." call, or FINAL reached after an accepted approach clearance), `ifr_request:CS` (the pilot called Clearance Delivery),
`ifr_clearance:CS` (`IFR_CLEARANCE` accepted), `departed_ifr:CS` (took off with an IFR clearance and a `HANDOFF` to a DEP/APP frequency followed).
They read `state.events` (engine log, capped at 2,000) and the score card. `allObjectivesDone` ignores scenarios whose only objectives are "guards" (`no_*`, `score:`)
so a clean-sheet objective cannot complete a scenario at t = 0.

## Training controller

`training.steps` entries are `{ id, prompt, expectCommand?, explanation, reference? }` plus optional `callsign`, `check`, `example`, `mistakes`. A step completes on an *accepted* outcome of
`expectCommand` for `callsign`, or when `check` (or the equivalent `cmd:` fact in the event log) holds; steps with only `check` are wait steps. Rejected/clarify outcomes for the step's
command or aircraft set `status: 'error'` and put the explanation, common mistakes and reference in `lastFeedback`. `prompt` includes an example transmission; `explanation` includes the common mistakes.
Training scenarios run the engine in `mode: 'training'` (readback errors off, unsafe clearances refused with the 7110.65 reference).

### FAA references

Only paragraphs in `references.ts` are cited. Each was confirmed on 2026-10-16 on https://www.faa.gov/air_traffic/publications/atpubs/atc_html/ (site edition JO 7110.65BB):
2-4-3 Pilot Acknowledgment/Read Back; 2-4-20 Aircraft Identification; 3-1-3 Use of Active Runways; 3-1-12 Visually Scanning Runways; 3-7-1 Ground Traffic Movement;
3-7-2 Taxi and Ground Movement Operations; 3-8-1 Sequence/Spacing Application; 3-9-4 Line Up and Wait (LUAW); 3-9-6 Same Runway Separation;
3-9-8 Intersecting Runway/Intersecting Flight Path Operations; 3-9-10 Takeoff Clearance; 3-10-3 Same Runway Separation; 3-10-5 Landing Clearance;
3-10-8 Withholding Landing Clearance; 3-10-9 Runway Exiting; 10-1-1 Emergency Determinations; IFR additions (same method, chapters 4 and 5, fetched with a browser User-Agent, 2026-10-16): 4-2-1 Clearance Items, 4-3-2 Departure Clearances, 4-8-1 Approach Clearance,
5-9-1 Vectors to Final Approach Course, 5-9-2 Final Approach Course Interception, 5-9-4 Arrival Instructions. Text is paraphrased, never quoted.
`TRAINING_DISCLAIMER` (not ATC training) is exported and used in the training debrief and the completion step.

## Debrief and career

`buildDebrief(state, startedAtSec = 0)`: grade A >= 90, B >= 80, C >= 70, D >= 60, else F; any runway incursion caps at C. `improvements` are derived from the counters and events
(unsafe takeoff/line-up/landing/crossing/intersecting-runway clearances with the right paragraph, incursions, separation, missed readbacks, communication errors by cause, coordination errors (an unapproved crossing: 3-1-3 / 3-1-4; an IFR takeoff without a release: 4-3-4), go-arounds without clearance, waits, unfinished objectives).
IFR advice: approach clearances refused (training) or flagged (other modes) for the intercept angle (5-9-2, 5-9-1), inside / intercepting inside the FAF (5-9-4, 5-9-1, 4-8-1), not heading for the course or the course > 10 nm ahead, a route that does not join the procedure; an approach clearance that
put an aircraft within 3 nm in trail (no paragraph cited: the 3 nm is a simplification); takeoff without an IFR clearance (4-2-1, 4-3-2); an IFR departure still on Tower more than 2 minutes after takeoff (`IFR_DEPARTURE_HANDOFF_LIMIT_SEC`).
`timeline` = warnings/critical + command accepted/rejected + clarifications + handoffs + go-arounds + scenario events, times relative to `startedAtSec`. `completed` = all objectives
(or the engine's `scenarioCompleted` when there are none).
`saveCareerResult` stores best score per scenario and, for `career-NN-*` ids with `completed` and grade A/B/C, marks the step complete and unlocks the next (max 12). Key `kacy.career`;
every storage access is try/caught and falls back to an in-memory copy (Node, private windows).
`isScenarioComplete`: all (non-guard) objectives done, `durationSec` elapsed, or the engine flagged completion (not for free play).

## Training lesson 10: crossing coordination (`train-10-coordination`)

The player works Ground (`DEFAULT_PLAYER_POSITIONS`), an AI controller works Tower, 13 and 22 are active and Cessna N60DX must cross 13/31 on its way to 22. Steps: taxi (hold short of 13), wait for the crossing request,
ask Tower on the landline (check `coord:CROSS_REQUEST:N60DX`; the prompt shows the phrase and the three ways to say it), wait for the approval (`coord:CROSS_APPROVED:N60DX`), cross (`CROSS_RUNWAY`; refused
with the 3-1-3 reason before the approval), watch the crossing (`crossed:N60DX:13/31`; the engine posts the completion). References 3-1-3, 3-1-4, 3-7-2, 3-1-12. `coordinationLesson.test.ts` completes it in the real engine with the real AI Tower.
Objectives: asked, crossed, `no_coordination_errors`.

## Tests

`npm test -- src/game` - `airportProfile.test.ts` (KACY unchanged, KMHT airlines/destinations/neighbour bearings, performance entries vs the JSON, cargo parking, generator at KMHT, parser callsigns), catalogue/spawn validation and a 120 s engine run of every scenario, 10-minute robustness run, scripted career steps 1 and 3 (and 2, 4, 5, 6, 12) through `parseTransmission` (`testkit.ts` passes `ctx.fixes` from `airport.navaids`),
all 10 training lessons completed in the engine (lesson 10 in `coordinationLesson.test.ts`; coordination scoring, objectives and debrief in `coordinationScoring.test.ts`) (`ifrCareer.test.ts`: lessons 8 and 9 use the example transmissions printed in their prompts, plus refusal paths), career step 8 played end to end (Approach, Tower, Ground), traffic generator rules over 30 simulated minutes,
`ifrFlows.test.ts` (IFR flows for landing runways 13, 31, 22 and 4: fixes, altitudes, 90 s / 5 nm / 3.5 nm spacing, Cessnas stay VFR, determinism, positions-based defaults and `ifrFlows: false`, generated aircraft worked through the parser without unsafe approach clearances, free play with `ifrFlows`, career 7 IFR departure through Clearance Delivery, Ground, Tower and Departure to `handled:`, the new objective checks on fabricated logs, debrief advice for each IFR mistake), free play options, objectives, debrief, career persistence (fake `localStorage`), scenario events.
Scripted tests pass `readbackErrorRate: 0`; with the default 8 % a pilot occasionally misreads a clearance and the controller has to correct it.

## Known limitations

* Engine pattern work starts from a nearby downwind (0.8 nm offset); pattern scenarios therefore spawn aircraft on the downwind leg instead of flying them in from a neighbouring field.
* `scenario.weather === 'live'` is not resolved here (see Free play). Winds in career scenarios are simulated.
* Objectives and the debrief read the engine's event log, which keeps the last 2,000 events; very long free-play sessions lose early timeline entries (score counters are unaffected).
* `GameScenario` extension fields (`events`, `difficulty`, `aircraftTypes`, richer training steps) survive JSON round trips but are lost if a caller rebuilds a `Scenario` from selected fields (the generator then assumes `normal` difficulty and both types).
* Helicopters (USCG) and fighters (ANG) are not spawned.
* IFR: aircraft that nobody clears fly the route to the last fix and then hold that heading (they leave the area; they do not hold); no STARs, so arrivals appear over the approach fix rather than at an arrival fix; the 3 nm in-trail rule and the "approach gate" are the engine's simplifications (the lesson says so).
* A session without a Ground position strands landed aircraft on the exit (the pilot switches to an unstaffed Ground frequency); career 8 therefore lists GND, and the free-play default positions for IFR flows list it too.
* IFR flows in the opening population: Cessna arrivals are skipped when airline arrivals appear at fixes, and the later jets appear 270 s apart (a result of the engine's in-trail check, see above).

## Pilot realism by scenario

`Scenario.pilotRealism` is set by the catalogue (`scenarios/index.ts buildCatalogueScenario`): training lessons `off` (a lesson that sets the field itself keeps it), career steps 1-2 off (introductory), 3-5 light, 6-9 moderate,
10-12 heavy (`careerRealism`; step 11 is built on the free-play builder but still follows the ramp), anything else from its `Difficulty` (`realismForDifficulty`: easy light, normal moderate, hard heavy).
Free play takes `FreePlayOptions.pilotRealism` (setup-screen selector "Pilot realism", default moderate). The traffic generator (`traffic.ts`) occasionally creates a flight whose callsign sounds like one
on the airport (`similarCallsignRate`), otherwise it avoids sound-alikes. Scripted flow tests build their scenarios with `pilotRealism: 'off'`.

## Special traffic (`specialTraffic.ts`, `specialGenerator.ts`, `airportProfile.ts` `special`)

Kinds: `helicopter` (USCG MH-65 at the helipads `USCG-1..4`), `military` (ANG F-16C from the `ANG-` ramp or arriving through the overhead maneuver), `transition` (VFR crossing the Class C), `training` (a share of the GA arrivals flies touch-and-go circuits), `vehicles` (runway / pavement inspections, errands). The setup screen has one checkbox per kind the airport offers (`availableSpecialKinds`; KACY all five, KMHT only `transition` and `vehicles`: no USCG / ANG unit and no sourced flight training there), passed as `FreePlayOptions.specialTraffic` and stored as `scenario.specialTraffic`. **Unset = none**: scripted scenarios, career and tests keep their traffic; the setup screen defaults to `defaultSpecialTraffic` (all offered kinds on).

* **Rates** (`AirportTrafficProfile.special`, design values, per hour at the peak bank): helicopters 2, fighters 2, transitions 4, vehicles 3, training share 0.4 of the GA arrivals, fighter flights of two 0.5. They are multiplied by the difficulty ramp and thinned by the free-play density curve exactly like the airline rates. Limits at one time: 2 helicopters, 2 fighters, 3 transits, 2 vehicles, all inside `maxAircraft`.
* **Own random stream** (`seed ^ 0x2d5e7a31`): switching a kind on or off never changes the airline and GA flights of a seed (tested). Training is decided from a hash of the callsign (no random number drawn).
* **Spawns**: helicopter missions DEPARTURE (parked on a free pad, calls Tower), ARRIVAL (8 nm out at 400 ft AGL on a bearing from the pad that crosses no extended runway centreline, `clearBearingFrom`) and REPOSITION (air taxi to another free pad, Ground); fighters depart from a free `ANG-` spot or arrive 10 nm out for the overhead (flights of two with probability 0.5); transits enter 22 nm out on a chord 1-6 nm from the airport at 5,500-8,500 ft (odd thousands + 500 eastbound, even + 500 westbound, 14 CFR 91.159); vehicles park at an FBO / cargo spot. No vehicle is generated without a Ground position; helicopter and fighter traffic needs Tower.
* Callsign digits are drawn (no real serial numbers are used): docs/FAA-REFERENCES.md "Traffic variety" lists what is not sourced.
* Tests: `specialGenerator.test.ts` (rates, kinds off, KMHT, determinism, density scaling, transit geometry, training share), `src/ai/specialSoak.test.ts` (2 h free play with all kinds and all AI controllers: every type appears, no vehicle incursion, no separation loss involving special traffic).
