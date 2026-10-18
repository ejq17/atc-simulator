# src/ai - AI air traffic controllers

The player works ONE position (say Ground); AI controllers work every other position of the scenario (Clearance Delivery,
Ground, Tower, Approach, Departure) and hand aircraft to and from the player with the same `CONTACT_FREQUENCY` commands a human
would use. Pure TypeScript, no DOM, deterministic.

```ts
import { createAiControllers } from './ai';
const ai = createAiControllers({
  engine, airport,
  positions: ['CLNC', 'TWR', 'APP', 'DEP'],      // the AI works these
  playerPositions: ['GND'],                       // never transmitted on; aircraft are handed to / taken from it
  onTransmission: (t) => speak(t.spokenText, t.voiceId),   // controller voice, BEFORE the pilot's readback
  seed: scenario.seed,
});
engine.subscribe((s) => ai.update(s));            // once per step is fine: it acts on whole sim seconds
ai.status();                                      // { TWR: 'TWR (AI): 2 aircraft, next: NKS451 cleared for takeoff runway 13', ... }
ai.dispose();
```

The contract is `index.ts` (unchanged). `update()` is re-entrancy safe (`engine.applyCommand` notifies subscribers, which may call
`update()` again).

## Design

One rule-based agent per AI position. An agent is a pure function of the simulation state that returns the transmissions it could
make right now (`Plan`: key, priority, commands, phrase). `controllers.ts` runs this loop once per sim second for each agent:

1. Collect the agent's plans (readback corrections first), drop the ones in cooldown / back-off / already done.
2. If nothing is scheduled, schedule the best one after a **reaction delay** drawn from `reactionDelaySec` (default 2-6 s, seeded;
   go-arounds use the lower bound) and never sooner than **3 s after the position's previous transmission**. A plan that is much
   more urgent (priority +15) replaces a scheduled one.
3. When the delay is over, plan again; if the same plan (same `key`) is still the right thing it is performed, otherwise it is dropped
   (the situation changed while the controller was "thinking"). The AI does not key up over an aircraft that is still transmitting.
4. A transmission is performed through `engine.applyCommand(cmd, { position, source: 'ai', aiPosition: position, transmissionId })`.
   `onTransmission` fires first (so the voice layer plays controller, then the pilot's readback that the engine produces inside
   `applyCommand`). All commands of one transmission ("radar contact, climb and maintain 10000, proceed direct Cedar Lake") share one
   `transmissionId`, which makes the engine log exactly **one** ATC `TRANSMISSION` event, carrying `aiPosition`, per AI transmission.
5. A refused command is not repeated for 10 s (60 s after the third refusal in a row); the AI also pre-checks everything with the engine's
   own pure `assessClearanceSafety` so it practically never gets there (an unsafe attempt would be logged and scored against the player).

Randomness: the AI has its own seeded stream (`opts.seed`, default the scenario seed), so enabling the AI does not perturb the
engine's `random()` stream, and the same seed gives the same event log (tested).

AI positions whose frequencies are all shared with a player position (KACY: Approach and Departure are both 124.6 / 134.25) do not
transmit: the player's position covers them (`status()` says so). The AI never transmits on a frequency the player works.

## What each position does (only for aircraft tuned to its frequency)

| Position | Behaviour |
|---|---|
| **CLNC** | A pending `IFR_CLEARANCE` request is answered with a complete clearance: destination, DP, initial 2000, expect cruise, departure frequency by sector (`departureFrequencyFor`), a fresh squawk. "Spirit four fifty one, Atlantic City Clearance Delivery, cleared to Philadelphia airport, Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand, one zero minutes after departure, departure frequency one two four point six, squawk ...". |
| **GND** | Departure asking for taxi: route to the full-length entry of the first active departure runway that is long enough for the type (`runwayEntryNodes`; `via` list chosen so the engine's own target selection picks that hold; `holdShort` for every runway crossed, in order). A busy hold line is skipped (up to 3 deep queue per hold). No second release within 60 s / 300 m of a fresh one, no head-on routes. Crossing request: `CROSS_RUNWAY` when the runway AND runways intersecting it have no departure/landing/line-up and no cleared or final arrival within 90 s (plus the engine's check). Handoff to Tower ("contact tower one two zero point three") when nothing is left to cross and the aircraft is within 400 m of the hold (or at it), so it calls Tower "holding short, ready for departure". Arrival on Ground asking for taxi: nearest free parking of its natural category (gate for airline, ramp for GA) with a described route. When nobody works CLNC, Ground issues the IFR clearance. |
| **TWR** | Departures at the hold, first come first served per runway: `TAKEOFF` ("runway one three, fly runway heading, cleared for takeoff" for IFR) when the engine's check is safe AND every arrival is far enough out (`releaseSlackSec`: line-up + roll + 6,000 ft behind the departure, and 2.4 nm of lateral margin at lift-off; pattern traffic near the field blocks); `LINE_UP_AND_WAIT` only when takeoff is blocked by something else and the arrival is far out. Airborne departures (>= 400 ft AGL): `CONTACT_FREQUENCY DEP` ("contact departure" + the sector frequency of the clearance). Arrivals: "continue approach" to the pilot's check-in farther than 5 nm, `LAND` from 5 nm when the engine says safe and no earlier arrival will still occupy the runway (`blockedByLeader`), and landing clearances are held back for a pilot waiting at a hold line to cross; `GO_AROUND` inside 1 nm / 30 s when the runway will not be clear. Landed and clear: "contact ground point niner". Missed approach: IFR to Approach, VFR left downwind. Fallbacks: taxis arrivals itself when nobody works Ground. |
| **APP** | Arrivals: `RADAR_CONTACT` + descent to the lowest MVA-safe altitude (engine MVA check) at or above the published altitude of the initial fix of the preferred procedure (ILS, else RNAV, else VOR from `airport.procedures`/`fixAltitudes`); `DIRECT_FIX` to the nearest IAF/IF when the aircraft is not on a route that joins it; `APPROACH` when the engine's `assessApproach` finds it proper and the aircraft ahead is >= 5 nm ahead; otherwise `HOLD_AT_FIX ... as published` at the procedure's hold-in-lieu fix (gap < 3.5 nm) or `SPEED` 140 (3.5-5 nm). Established on final: "contact tower". A missed approach is climbed, sent direct to the initial fix and cleared again. When nobody works DEP, Approach also takes the departures. |
| **DEP** | Departures: `RADAR_CONTACT`, `ALTITUDE` to the filed cruise, `DIRECT_FIX` to the first fix of the route (IFR; VFR just get radar contact). |

Added after a real session (tests in `safetyGaps.test.ts`): Tower withholds a takeoff clearance to a faster departure behind a slower one
on the same track (`conflicts.departureTrailConflict`: the follower must not close inside 3 nm before the leader is 10 nm out, unless the
leader has turned 15 degrees or more; 7110.65 3-9-6 / 5-8-3), Approach judges spacing at the leader's threshold crossing
(`world.projectedGapNm`; needs max(5 nm, 80 s at the follower's approach speed) and never less than 3 nm, tries speed 160 then 140, then the
published hold), Tower sends a follower on final around at 3-4 nm when the in-trail gap is lost (`earlyGoAroundReason`), and an aircraft that
went around (`Aircraft.lastGoAroundSec`) gets no landing clearance until its approach is cleared again (`awaitingResequence`).

Faulty readbacks (`flags.readbackErrorPending`) are corrected by the issuing position: "negative, Spirit four fifty one, runway one three,
fly runway heading, cleared for takeoff".

## Files

| File | Role |
|---|---|
| `index.ts` | The contract (fixed). |
| `controllers.ts` | `createAiControllers`: scheduling, reaction delay, transmit, status. |
| `core.ts` | `Plan`, `AgentView`, memory, `mkCmd`. |
| `clnc.ts` `ground.ts` `tower.ts` `approach.ts` (APP and DEP) `corrections.ts` | The agents. |
| `world.ts` | Read-only world queries: ETA, taxi planning (mirrors `commandExecutor.planTaxi`), hold queues, opposing traffic. |
| `phrase.ts` | ATC phraseology, each phrase as `text` (digits) and `spokenText` (words); callsign first. |
| `testkit.ts`, `ai.test.ts` | Harness (real engine + KACY, seeded) and the scenarios below. |

## Tests (`npm test -- src/ai`)

1. Ground-only player: AI CLNC/TWR/APP/DEP take an IFR A320 from the gate (clearance, handed to the player with a taxi request, after
   the scripted handoff cleared for takeoff, handed to DEP, climbed direct Cedar Lake) and an A320 arrival at CARYL (ILS 13, Tower,
   landing clearance, handed to the player with "request taxi to parking"); no safety event, all in about 13 simulated minutes.
2. Tower-only player: AI Ground taxis two departures (different hold lines), crosses 4/22, hands them over; the "holding short ... ready
   for departure" call arrives on 120.3; AI Departure takes them; AI Ground parks the arrival.
3. Approach-only player: AI Tower/Ground/Clearance; Departure is reported as covered by the player's Approach.
4. Determinism: same seed, identical event log, transmissions and status.
5. Politeness: the AI never transmits on a player frequency, one ATC event per transmission, >= 3 s between transmissions, refused
   commands backed off >= 10 s, no clearance the engine would refuse.
Also: spacing (published hold, speed reduction), missed-approach recovery, readback-error corrections in career mode, no-player run, VFR departure.

## Known simplifications

* No inter-position coordination call: Ground decides crossings alone (it does look at the intersecting runway and at arrivals that
  are cleared or on final); Tower holds landing clearances while someone waits to cross. If the player is Tower, Ground still owns crossings.
* Tower hands departures to Departure as soon as they are airborne (400 ft AGL); VFR departures go to Departure too (the engine has no
  "frequency change approved" instruction and only counts a VFR departure as handled after a `CONTACT_FREQUENCY`).
* Approach hands arrivals to Tower when they are established (the sim's FINAL, inside 8 nm), not after the FAF, because that is when
  the pilot reports and waits.
* Approach never vectors with `HEADING` (it uses direct-to-fix, speed and published holds), so there are no intercept-geometry or
  approach-gate issues; spacing target is 5 nm (the engine minimum is 3 nm, 4 nm light behind jet).
* VFR arrivals are not sequenced against IFR arrivals except by go-arounds; pattern work is limited to `ENTER_PATTERN left_downwind`
  after a go-around.
* `LINE_UP_AND_WAIT` is used rarely on purpose (there is no "exit the runway" command).
* Combined transmissions are read back command by command by the engine's pilots.

## Engine gaps found while building this (not fixed: src/sim is out of scope)

See the report that accompanied this module; in short: TAKEOFF is accepted while an arrival is in the flare over the runway; LAND
is judged only against aircraft already on the ground (two arrivals 25 s apart are both cleared); CROSS_RUNWAY ignores traffic on the
intersecting runway; scoring cannot tell AI from player (`COMMAND_ACCEPTED` has no `aiPosition`, AI refusals hit the player's score and
rejected commands still log an ATC line); no dry-run validation call; READY aircraft block the lane behind them; C172 queues are 32 m
apart against the 30 m GROUND_PROXIMITY alert; landings on 22 exit onto hold B-1 and must re-cross 4/22; ENTER_PATTERN right after a
go-around can put the aircraft straight on final.
