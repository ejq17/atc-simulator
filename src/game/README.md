# src/game - gameplay layer

Scenarios, traffic generation, free play, career progression, training mode, objectives, scoring debrief. Pure TypeScript,
no DOM. The UI depends only on `index.ts` (`GameApi` and the related interfaces, unchanged) plus a few extra exports from
`game.ts` listed below. Nothing in `src/sim` was modified; the engine is driven through its public API only.

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
| `world.ts` | KACY helpers: runway-end geometry (TRUE heading, sin/cos from the threshold), holds, taxi-route planning that mirrors the engine, crossing detection, parking pools, callsign generators. |
| `scenarios/career.ts` | The 12 career steps. |
| `scenarios/training.ts` | 7 training lessons. |
| `scenarios/freeplay.ts` | `buildFreePlay`, weather/runway resolution, initial population. |
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
| 7 | `career-07-arrivals-departures` | 3 arrivals (NKS712 final, N35DM from Millville, AAL1201 from Philadelphia) + 2 departures. |
| 8 | `career-08-ifr` | IMC preset, three A320 on the ILS to 13, one A320 departure, GA grounded. |
| 9 | `career-09-mixed-performance` | Fast A320 12 nm behind a slow C172 on the same final; two departures. |
| 10 | `career-10-runway-change` | Wind shifts to 300/14 at 600 s (`events`); post-shift traffic is placed for runway 31. Objective `active_runway:31`. |
| 11 | `career-11-complex` | Free-play density: 6 initial aircraft, 20+20 ops/h, max 14, hard ramp, crosswind. Objective: handle >= 10. |
| 12 | `career-12-emergency` | Scripted pan-pan from NKS1180; objective: it lands before AAL1590 and N305SP. |

Training (mode `training`): `train-01-phraseology` (line up / takeoff / handoff), `train-02-taxi`, `train-03-runway-safety`,
`train-04-crossing` (hold-short readback, KACY diagram note), `train-05-sequencing`, `train-06-pattern`, `train-07-go-around`.
Free play: `free-play`, `free-play-quiet`, `free-play-mixed`, `free-play-busy-departures`, `free-play-busy-arrivals`.

Design rules every scenario follows (and `scenarios.test.ts` enforces): ids resolve against `loadKacy()`; only C172 and A320;
no helicopters (USCG) or fighters (ANG); an A320 never sits on a hold it cannot depart from (the engine needs 6,500 ft:
the full-length 13/31 holds and Charlie, never Alpha/4-22); airborne spawns are on the extended centreline at the runway end's TRUE heading
or on real bearings from KPHL (309), KMIV (257), KWWD (209); no two airborne spawns closer than 3 nm; 120 s in a real
engine produce no CONFLICT / INCURSION / SEPARATION events.

Airport facts that shape the scenarios: the terminal and GA ramp are south-west of 13/31; taxiway Bravo crosses 4/22 on the way
to the 13 threshold, and taxiway Alpha crosses 13/31 on the way to runway 22 (both are also the KACY hot spot HS 1).

## Free play

`buildFreePlay(airport, options)` honours every `FreePlayOptions` field: `seed`, `weather` (preset id | `'random'` (seeded) | `'live'` |
a `Weather`), `activeRunways` (else `recommendRunways`, limited to A320-capable ends when jets are in play, preferred order 13, 31, 22, 4),
`aircraftCount` (initial parked departures + inbound arrivals, distinct parking, arrivals >= 3 nm apart, jets placed nearer than Cessnas),
`arrivalsPerHour`/`departuresPerHour`/`gaFraction`/`maxAircraft`, `difficulty` (default rates, max aircraft and the traffic ramp),
`aircraftTypes`, `startingScenario` (`quiet`, `busy_departures`, `busy_arrivals`, `mixed`).
`scenario.weather === 'live'` stays `'live'`: **the engine substitutes calm default weather for `'live'`**, so the UI must fetch the METAR and call `engine.setWeather`.

## Traffic generator

`createTrafficGenerator(scenario, airport)` returns a null generator unless `scenario.traffic.enabled`. Otherwise (seeded from `scenario.seed`; deterministic):
independent exponential clocks for arrivals and departures at the hourly rates times a ramp (`easy 0.5->1.0 over 20 min`, `normal 0.6->1.25 / 15 min`,
`hard 0.8->1.8 / 10 min`, read from `scenario.difficulty`), a short opening lull, spawns released one at a time alternating arrival/departure, >= 45 s apart,
never above `maxAircraft`. Arrivals: 10-12 nm from the threshold of an active landing runway, half on the centreline and half on a base-leg offset of 20-50 degrees,
2,500-3,000 ft, 100 kt (C172) / 170 kt (A320), >= 3 nm from any other airborne aircraft (5 nm for a faster aircraft behind a slower one on the same final), initial frequency
`TWR` (or `APP` if the scenario has APP but not TWR). Departures: free parking (GA ramp/FBO for C172, gates for A320), initial frequency `GND`,
request `TAXI`; A320 departures are replaced by C172 (or skipped) when the active departure runway is 4/22. Callsigns: N-numbers in three formats and Spirit (80 %) / American flight numbers,
unique for the whole session and never ending in the same three characters as an active aircraft.

## Scenario events (wind shifts, emergency)

`Scenario` has no event schedule, so `GameScenario.events` (JSON) carries `ScenarioEvent`s:
`weather` (`weather`, `text`, `recommendedRunways`), `emergency` (`callsign`, `declaration`, `text`), `message`.
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
`go_around:CS`, `landed_before:A:B`, `handled:>=N`, `score:>=N`, `no_incursions`, `no_unsafe`, `no_separation`, `no_conflicts`, `active_runway:31`, `always`.
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
3-10-8 Withholding Landing Clearance; 3-10-9 Runway Exiting; 10-1-1 Emergency Determinations. Text is paraphrased, never quoted.
`TRAINING_DISCLAIMER` (not ATC training) is exported and used in the training debrief and the completion step.

## Debrief and career

`buildDebrief(state, startedAtSec = 0)`: grade A >= 90, B >= 80, C >= 70, D >= 60, else F; any runway incursion caps at C. `improvements` are derived from the counters and events
(unsafe takeoff/line-up/landing/crossing/intersecting-runway clearances with the right paragraph, incursions, separation, missed readbacks, communication errors by cause, go-arounds without clearance, waits, unfinished objectives).
`timeline` = warnings/critical + command accepted/rejected + clarifications + handoffs + go-arounds + scenario events, times relative to `startedAtSec`. `completed` = all objectives
(or the engine's `scenarioCompleted` when there are none).
`saveCareerResult` stores best score per scenario and, for `career-NN-*` ids with `completed` and grade A/B/C, marks the step complete and unlocks the next (max 12). Key `kacy.career`;
every storage access is try/caught and falls back to an in-memory copy (Node, private windows).
`isScenarioComplete`: all (non-guard) objectives done, `durationSec` elapsed, or the engine flagged completion (not for free play).

## Tests

`npm test -- src/game` - catalogue/spawn validation and a 120 s engine run of every scenario, 10-minute robustness run, scripted career steps 1 and 3 (and 2, 4, 5, 6, 12) through `parseTransmission`,
all 7 training lessons completed in the engine, traffic generator rules over 30 simulated minutes, free play options, objectives, debrief, career persistence (fake `localStorage`), scenario events.
Scripted tests pass `readbackErrorRate: 0`; with the default 8 % a pilot occasionally misreads a clearance and the controller has to correct it.

## Known limitations

* Engine pattern work starts from a nearby downwind (0.8 nm offset); pattern scenarios therefore spawn aircraft on the downwind leg instead of flying them in from a neighbouring field.
* `scenario.weather === 'live'` is not resolved here (see Free play). Winds in career scenarios are simulated.
* Objectives and the debrief read the engine's event log, which keeps the last 2,000 events; very long free-play sessions lose early timeline entries (score counters are unaffected).
* `GameScenario` extension fields (`events`, `difficulty`, `aircraftTypes`, richer training steps) survive JSON round trips but are lost if a caller rebuilds a `Scenario` from selected fields (the generator then assumes `normal` difficulty and both types).
* Helicopters (USCG) and fighters (ANG) are not spawned; there is no clearance-delivery or approach/departure position gameplay beyond frequency handoffs.
