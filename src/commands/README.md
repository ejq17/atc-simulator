# src/commands - aviation command interpretation

Pure TypeScript, no DOM, no dependencies. Turns STT output or typed text into
`ParseResult` (`src/sim/types.ts`). The parser never mutates anything; the
engine validates and executes.

```ts
import { parseTransmission } from './commands';
const r = parseTransmission('Spirit four fifty one, runway one three, cleared for takeoff',
  { aircraft, taxiways, runwayEnds, frequencies });
// r.commands[0] -> { kind: 'TAKEOFF', callsign: 'NKS451', runwayEnd: '13', runwayId: '13/31', confidence: 0.99, issues: [] }
```

## Pipeline

`normalize.ts` -> `callsign.ts` -> `grammar.ts` (rules, built per parse by `buildRules(ctx)` because some need `ctx.fixes`) -> `assemble.ts` -> `validate.ts` -> `confidence.ts`; orchestrated by `parse.ts`.

1. **normalize** lower-cases, strips punctuation, converts spoken numbers
   (`tree fife niner`, `two thousand five hundred`, `one two one point niner`,
   `four fifty one`), NATO letters, airline telephony (`Spirit` -> `NKS`), GA type
   words (`Cessna` -> gaPrefix token). Homophones `to/too/for/fore` are digits only
   next to other number words or after a callsign word (`spirit for fifty one`,
   but not `cleared for takeoff`). `delta`/`november` are airline/N-prefix or
   letter by context. Speech disfluencies (`um`, `uh`) are dropped. Every token
   keeps its raw word range; `rawSlice()` recovers the original text.
2. **callsign** finds callsign-shaped phrases, scores them against the active
   aircraft (1.0 full, ~0.9 last-3 abbreviation, 0.97 N-number without prefix,
   <0.75 near miss) and returns `null` unless score >= 0.75 and no other aircraft is
   within 0.1. Candidates are always returned so the UI can ask "did you mean".
3. **grammar** scans the remaining tokens left to right; the first matching rule
   at each position wins (`RULES` in `grammar.ts`; order is documented there).
   Rules use `seq(tokens, i, 'cleared|clear for|to? the? takeoff')` patterns
   (`a|b` alternatives, `?` optional) plus entity parsers in `entities.ts`.
4. **assemble** attaches positional `runway N` (and `via A B`) elements to the
   next instruction that needs one and still lacks it, else the previous one,
   and collapses duplicates ("go around, go around").
5. **validate** reports identifiers unknown to `ctx` as issues and fills
   `frequencyId` from a spoken frequency.
6. **confidence** see below.

## Supported instructions (-> `kind`)

| Phrasing | Output |
|---|---|
| taxi [to] runway N / ramp / parking / general aviation / FBO / gate N [via A B] [hold short of X] | `TAXI` (`destination: RWY<end>`, `route`, `holdShort`) or `TAXI_TO_PARKING` (`destination`: RAMP, PARKING, GA, FBO, TERMINAL, CARGO, HANGAR, APRON, GATE<n>) |
| hold position / hold your position / stop | `HOLD_POSITION` (bare "hold" accepted, flagged non-standard) |
| hold short [of] runway N / N / taxiway X [on\|at taxiway Y] | `HOLD_SHORT` (`holdShort: ['RWY13']` or `['A']`, plus `runwayEnd`/`runwayId`). Inside a hold-short object the word "runway" may be left out: a bare 1-2 digit number (optional left\|right\|center or L\|R\|C) that is in `ctx.runwayEnds` is the runway ("hold short of 31 on Bravo"); without `runwayEnds` a bare number is never a runway. A trailing "on\|at <taxiway>" after a runway names where to hold; it is consumed (no field stores it, no unrecognised-words penalty) |
| cross runway N [at/via taxiway X] | `CROSS_RUNWAY` (`crossRunwayId: '13/31'`, `runwayEnd`, crossing taxiway in `route`) |
| line up and wait / position and hold / taxi into position | `LINE_UP_AND_WAIT` ("line up" alone is accepted but flagged) |
| cleared for takeoff (STT: take off, clear for) | `TAKEOFF`; "fly heading/runway heading" and "turn left heading" are separate `HEADING` commands |
| cleared to land / option / touch and go / stop and go / low approach | `LAND` (`destination: option, touch_and_go, stop_and_go, low_approach`) |
| LAHSO: cleared to land runway N, hold short of runway M \| taxiway X [, traffic landing runway M] | ONE `LAND` with `holdShort: ['RWY13']` (same format as taxi hold-short; `runwayEnd` stays the landing runway). The trailing traffic advisory is consumed and ignored. A "hold short" with no resolvable point is left to the separate `HOLD_SHORT` rule (flagged as missing) |
| go around | `GO_AROUND` |
| continue [approach] [expect late landing clearance] | `CONTINUE_APPROACH` |
| contact/monitor/switch to/change to ground, tower, approach, departure, clearance delivery [freq] | `CONTACT_FREQUENCY` (`frequencyId` GND/TWR/APP/DEP/CLNC, `frequencyMhz`); bare "point niner" leaves `frequencyMhz` undefined; "change to my frequency" -> `destination: 'MY_FREQUENCY'` |
| turn left/right heading N, fly heading N, fly runway heading | `HEADING` (`headingDeg` 1..360, 000 -> 360; "runway heading" -> `destination: 'RUNWAY_HEADING'`, "present heading" -> `'PRESENT_HEADING'`) |
| climb/descend/maintain [and maintain] [VFR at or below] N, flight level N | `ALTITUDE` (`altitudeFt`; FL180 -> 18000) |
| reduce speed to N, slow to N, speed N, maintain N knots, resume normal speed | `SPEED` (`speedKt`, or `destination: 'NORMAL_SPEED'`) |
| enter left/right downwind/base runway N, make straight in, make left traffic | `ENTER_PATTERN` (`patternLeg`, `turnDirection` = side) |
| pushback [and start] approved [, tail <compass point> \| face\|facing\|nose <compass point>] | `PUSHBACK` (`pushTailDeg` / `pushFaceDeg`, compass point as a true heading; always marked non-standard: JO 7110.65 has no pushback phrase) |
| read back [hold short] instructions, readback hold short | `READ_BACK_HOLD` (3-7-2 "READ BACK HOLD INSTRUCTIONS.") |
| continue [straight] [on\|via X] to Y | `TAXI` with `segment: true`, `destination: 'TWY<Y>'`, `route: [X]` (progressive taxi step, non-standard without "taxiing"). "turn left on Bravo" before it is the `EXIT_RUNWAY` rule below; the engine reads it as a taxi turn once the aircraft is taxiing |
| say again / repeat | `SAY_AGAIN` |
| cleared [for] [the] ILS / I-L-S / localizer / RNAV [GPS] / VOR / visual [approach] [runway] N [approach] | `APPROACH` (`approachType` ILS, LOC, RNAV, VOR, VISUAL; `runwayEnd`, `runwayId`). A bare `runway N` before/after attaches like other runway instructions. Needs approachType + runway |
| [when able] [proceed\|cleared\|fly] direct [to] <fix> | `DIRECT_FIX` (`fix` = fix id, see Fixes) |
| resume [your] own nav[igation], proceed on course | `RESUME_OWN_NAVIGATION` |
| radar contact [N miles <dir> of the field / from <fix>] | `RADAR_CONTACT` (position text consumed and ignored) |
| cleared to <airport> [via <DP / route>], maintain N, expect N [N minutes after departure], departure [frequency] X, squawk NNNN; "cleared [to X] as filed" | `IFR_CLEARANCE` (`ifr`, see below) |
| `maintain N until established [on the localizer]`, `until <fix>` | the normal `ALTITUDE`, plus `destination: 'UNTIL_ESTABLISHED'` or `'UNTIL_<FIX>'` (+ `fix`) |
| hold [at] <fix> [as published], hold <dir> of <fix> on the N radial \| localizer, right\|left turns, N minute \| N mile legs, expect further clearance [at] HHMM; "cleared to <fix>, hold ..." | `HOLD_AT_FIX` (`hold`, see below) |
| execute [the] [published] missed approach, fly the published missed approach, go missed, "go around, fly the published missed approach" | `MISSED_APPROACH` (the go-around prefix is absorbed, no separate `GO_AROUND`) |
| [cleared] [the] <STAR name> <number> arrival [<fix> transition]; descend via [the] <STAR name> <number> [arrival] | `STAR` (`starName` = the airport's identifier, e.g. `ROZZE2`; `starTransition` when the transition is a known fix of that arrival; `descendVia`). The names come from `ParseContext.arrivals` (matched phonetically like fixes); a wrong number leaves `starName` unset, with an issue, so the command is incomplete and never executes (rules-airport.ts, 7110.65 4-7-1, 4-5-7) |
| [caution] bird[s] activity ..., flock[s] of geese / ducks / small birds ... | `ADVISORY` (`advisory: 'BIRDS'`; the tail words are consumed; 2-1-23) |
| braking action <good \| good to medium \| medium \| medium to poor \| poor \| nil> [reported by a <type>]; braking action advisories are in effect; no braking action reports received [for runway N] | `ADVISORY` (`advisory: 'BRAKING'`, `brakingTerm`; 3-3-4, 3-3-5) |
| runway N RVR <value> [more / less than] [rollout / mid ...] | information only (consumed; 2-8-3) |
| increase / raise / brighten, decrease / reduce / lower / dim, turn [up / down], bring, set the [runway / edge] lights [up / down / to step N], lights up / down | `RUNWAY_LIGHTS` (`lightsDirection` UP / DOWN, or `lightStep` 1-5; a step outside 1-5 is an issue; 3-4-10 d, 3-4-11) |
| turn left\|right [at] <taxiway>, exit [left\|right] [at] <taxiway>, turn right next taxiway, if able turn left at C, left on C, continue to the end (non-standard) | `EXIT_RUNWAY` (`turnDirection`, `exitTaxiway`, `ifAble`; `destination: 'NEXT'` or `'END'`). A bare "turn left" stays an incomplete `HEADING`. 7110.65 3-10-9. "..., contact ground point niner" and "..., hold short of runway 4" are separate commands in the same transmission |
| cancel takeoff clearance [reason], abort [the] takeoff, abort abort, reject takeoff | `CANCEL_TAKEOFF` (`reason` = the words spoken after it: "traffic on the runway"). A bare "stop" stays `HOLD_POSITION` (the engine reads it as a cancellation during the takeoff roll). 7110.65 3-9-11 |
| traffic, [clock] [a] <type words> <position>: "two mile final", "on left base", "left downwind", "departing", "in position" | `TRAFFIC_ADVISORY` (`traffic: { desc, position, side, distanceNm }`; `desc` = the type words lower-case, "boeing 737"). The merged number "seven thirty seven six mile final" -> 7376 is split into type 737 and 6 nm. After "line up and wait" the traffic is part of the `LINE_UP_AND_WAIT` (`trafficAdvised`, `traffic`). 7110.65 3-1-6, 2-1-21, 3-9-4 |
| [number N,] follow [the] <type> [position] | `FOLLOW_TRAFFIC` (`sequenceNumber`, `traffic`). 3-8-1 |
| extend [your] downwind [I'll call your base], turn base [now], base now, make short approach, make [a] left\|right three sixty \| two seventy \| 360 \| 270, remain in closed traffic, make left closed traffic, left closed traffic approved | `PATTERN_INSTRUCTION` with `destination` `EXTEND_DOWNWIND`, `TURN_BASE_NOW`, `SHORT_APPROACH`, `CIRCLE` (`turnDirection`, `turnDegrees`), `CLOSED_TRAFFIC` (`turnDirection`). 3-8-1, 3-10-11 |
| report [abeam] [midfield] downwind, report base, report N mile final, report final | `REPORT_POSITION` (`destination` `REPORT_MIDFIELD_DOWNWIND`, `REPORT_BASE`, `REPORT_FINAL` + `distanceNm`). Replaces the old `ENTER_PATTERN` with `REPORT_...`. 3-10-1 |
| squawk VFR, squawk one two zero zero, squawk 4321 | `SQUAWK` (`squawk` four digits 0-7, `destination: 'VFR'` for "squawk VFR" = 1200); a bad code is an issue (`invalid squawk code`). "squawk ident" stays `UNKNOWN`. 5-2-1, AIM 4-1-20 |
| [radar service terminated,] frequency change approved, change to advisory frequency approved | `FREQUENCY_CHANGE_APPROVED`. 7-6-11 |
| wind one three zero at eight [gusts 15], wind calm, altimeter three zero one zero \| 30.10 | `AIRPORT_INFO` (`info: { windDirDeg, windSpeedKt, windGustKt, calm, altimeterInHg }`) when alone; with another instruction the information is merged into that command's `info` (`assemble.ts`) and is not a command of its own. 3-9-1, 3-10-1 |
| standalone ident, other "cleared ... approach" (NDB, TACAN), ambiguous `maintain 180` | `UNKNOWN` with an explanatory issue |
| anything else / empty | one `UNKNOWN` with `no recognised instruction` / `empty transmission` |

**Hold-short safety.** A taxi (`TAXI` / `TAXI_TO_PARKING`) whose hold-short clause is spoken but whose point cannot be read is not a plain taxi: the clause is consumed (no separate `HOLD_SHORT`), the command carries the issue `missing hold short point (runway or taxiway)` and counts as a missing required entity (`requirements.ts`), so confidence falls to about 0.5, below the 0.70 execute threshold, and the engine asks for a say-again.

Runway numbers: `runway four` and `runway zero four` both give end `4`; ids are
derived from the end (`4/22`, `13/31`). Taxiways: `alpha` -> `A`, `alpha one` -> `A1`.

### IFR clearance (`IFR_CLEARANCE`)

One command per clearance; elements may come in any order and any may be missing (the engine fills
the rest). Fields in `ParsedCommand.ifr`:

| Field | Spoken |
|---|---|
| `destination` | known airport name (Philadelphia/Philly KPHL, Newark KEWR, Kennedy/JFK KJFK, LaGuardia KLGA, Boston/Logan KBOS, Washington National/Reagan KDCA, Dulles KIAD, Baltimore/BWI KBWI, Teterboro KTEB, Charlotte KCLT, Atlanta KATL, Orlando KMCO, Fort Lauderdale KFLL, Myrtle Beach KMYR, Atlantic City KACY), typed `KPHL`, spoken ICAO `kilo papa hotel lima`, or a 3-letter code from that table (`PHL`). Table in `airports.ts`. Unknown name -> issue `unknown destination X`; missing destination -> `missing destination airport` |
| `routeText` | raw phrase after `via` up to the next element ("Atlantic City Three departure, radar vectors, then as filed"); `as filed` for "cleared to X as filed" |
| `departureProcedure` | `<name words> <digit> departure` -> `ATLANTIC CITY THREE` |
| `initialAltitudeFt` | `maintain` / `climb and maintain` N or flight level. `climb via` is not supported (issue) |
| `expectAltitudeFt` | `expect one zero thousand`, `expect flight level two three zero` (23000); a trailing "N minutes after departure" is consumed and dropped |
| `departureFrequencyMhz` | `departure frequency 124.6` or `departure 124.6` (108-137 MHz). `contact departure ...` stays a separate `CONTACT_FREQUENCY` |
| `squawk` | four digits 0-7 as a string (`"4215"`); wrong length or digits 8/9 give an issue and no `squawk` |

Only `destination` is required for confidence. A standalone `squawk` (outside a clearance) is still `UNKNOWN`.

### Holding (`HOLD_AT_FIX`)

`ParsedCommand.hold` (`Partial<HoldingInstruction>`), elements in any order; only `hold.fix` is required for confidence
(resolved with `ctx.fixes` exactly like `DIRECT_FIX`, unknown -> raw token + `unknown fix X`). Bare "hold",
"hold position" and "hold short of ..." are not claimed by this rule; it fires on `hold at|as published|<compass>|<known fix>`
and on `cleared|proceed [to|direct] <fix> [and|then] hold`.

* `asPublished`: always set (`true` for "as published", else `false`).
* `turns`: `left`/`right`; defaults to `'right'` when not stated. The issue `standard right turns assumed` is added only when
  turns were not stated and the hold is not as published.
* `inboundCourseDeg`: from "on the N radial", converted to the INBOUND course to the fix: `(radial + 180) mod 360`, 0 -> 360
  (`hold east of SMITS on the 090 radial` -> 270). "On the localizer" leaves it undefined.
* The compass word (north ... northwest; "southwest" is also the airline token) is only a consistency check: more than 45 degrees
  from the radial gives the issue `inconsistent hold: ...` (and a conflict penalty).
* `legMinutes` / `legNm`: "one minute legs", "five mile legs".
* `efcZulu`: "expect further clearance [at] one two four five" -> `"1245"` (3 digits are zero-padded, an optional `zulu` is
  dropped, invalid times give an issue).

### Fixes (`ParseContext.fixes`)

`fixes?: { id; name?; spoken? }[]` drives `DIRECT_FIX`, `until <fix>` and position text. A phrase of up to
4 words matches case-insensitively and exactly against `name`, `spoken` or `id` (so "Cedar Lake", "Sea Isle",
"Atlantic City VOR", spelled letters "sierra india echo"). Otherwise a loose phonetic match applies to `id`
and `spoken`: Levenshtein distance / length <= 0.34 after a rough phonetic respelling (c->k, y->i, ph->f,
doubled letters collapsed), so "carol" ~ CARYL, "maybin" ~ MAYBN, "stev" ~ STEVV. Two different fixes at
equal distance -> `ambiguous fix: A or B` (no `fix`, counts as a conflict). Nothing matches -> the raw
token goes in `fix` with issue `unknown fix X` (counts as an unknown id). Without `ctx.fixes`, one spoken
word is accepted as the fix with no validation. Pass `spoken` hints for 5-letter fixes whose pronunciation is
far from the spelling.

### STT repair in normalisation

* **Phrases and aliases** (`lexicon.ts`): "hold shore", "whole chore", "whole shore", "hole short" -> `hold short`; "tax it" -> `taxi`; "around way" -> `to runway`; taxa, chaxi, taxee -> `taxi`; vialima -> `via lima`; aravo, baravo -> `bravo`. A phrase target with spaces expands to several words sharing the raw range. "via a Lima": a lower-case raw "a" between `via` and a spelled NATO word is dropped (typed "via a b" is untouched).
* **Fuzzy correction** (`fuzzyCorrect` in `normalize.ts`, after `repairNato`): an unknown alphabetic word of 4+ letters within Levenshtein distance 1 (4-5 letters) or 2 (6+) of exactly one core keyword (taxi, runway, hold, short, via, contact, tower, ground, cleared, cross, continue, position, parking, ramp, terminal, gate, takeoff, land, line, wait) is replaced by it; ties change nothing. `via`+NATO fusions ("viaalpha") split. A NATO word is a target only right after a NATO word or a route-context word (via, taxiway, and, then, on, taxi ...), never right after a number or callsign lead word; november and delta are never targets.
* **Never fuzzed**: digits, lexicon words, fillers, facility and callsign-prefix words, the grammar/common-English list `FUZZ_PROTECTED` (make, like, late ...), and the words of the active callsigns and fixes (`NormalizeOptions.protectedWords`, built in `parse.ts`). Raw word ranges are kept, so `rawSlice` still works.

* **Foxtrot drift** (`foxtrotDrift`, normalize.ts; needs `ctx.taxiways` containing F): in a taxiway context (after via/on/at/cross/and/taxi or a spelled letter) `fox|fucks|fux|folks|fax` + one unknown short word ("fox drive", "fucks truck", "fox shot", "fox stop"), or one fused word starting fox/fux/fucks ("foxdrought", "fuckstrapped"), becomes `foxtrot` (F). Runs before NATO repair and fuzzing so "shot" is not turned into "short".
* **Callsign letter repair** (`repairNato`): a 3-5 letter unknown word right after a callsign digit run (preceded by november/number/remember/an airline/cessna ...) within edit distance 1 of a NATO word is repaired ("kila" -> kilo, "xra" -> xray); 3-letter words only as a prefix of the NATO word.
* **Homophone digit before a spelled letter**: "november 1 to x-ray sierra" -> 12 (the `to`/`for` digit rule also fires before a phrase-built letter like x-ray).
* **Dotted digits**: "american 3.23" is flight 323 and "runway 1.7" is runway 17 (a dot after a callsign lead word or `runway` is not a decimal); dashes ("3-6-19", "1-7") already split into one digit run.
* **Multi-word fixes** (`PHRASES`): "run away" -> runway, "tax it" -> taxi, "that was" is dropped as filler (an empty phrase target drops the phrase).
* **Cross cleanup** (`crossCleanup`): "cross <taxiway> cross <runway>" drops the first cross and letter; "cross 35" with 35 in `ctx.runwayEnds` regains the word "runway".
* **Taxiway + digit**: "alpha 2", "alpha alpha 2" (A, A2) was already handled by `parseTaxiways`; unchanged.
* **Dropped-digit flight number** (`callsign.ts`): heard "Spirit 43" is accepted as NKS483 at score 0.8 only when exactly one active aircraft of that airline has the heard digits plus one more digit, in order, AND no other active aircraft of that airline is within edit distance 2 of the heard digits (NKS487 vs 43 -> stays "callsign not recognised").

* **Session lines (2026-10-18)**: "be on / be in / bee a / V a" -> `via` (phrases), "been" -> `via`, "limo" -> lima, "aplha" -> alpha, "tax in" -> `taxi to`; a lower-case raw "a" / "an" after via / on / at / onto before a NATO word is dropped ("on an Alpha"); "air national guard" and "national guard" -> ANG; "airport vehicle one" -> "airport one" (the vehicle word is dropped between `airport` and a number, so both word orders give APT1).
* **Runway exit with a lead-in** (`ruleExitRunway`): "continue down [the] runway [22]" before an exit instruction is part of it (one `EXIT_RUNWAY`, non-standard: 3-10-9 has only "turn left/right (taxiway)"); alone it is the exit at the end (`destination: 'END'`); "turn right at the next taxiway" is `NEXT`. For an aircraft standing on a runway `transmit.ts` issues the exit before a preceding bare "cross runway N" so the crossing has a route.
* **Departure heading with the takeoff clearance** (`assemble.ts`; JO 7110.65 5-8-2 INITIAL HEADING "FLY RUNWAY HEADING. TURN LEFT/RIGHT, HEADING (degrees)", 3-9-10 for the runway-then-clearance order, both read on faa.gov 2026-10-18): "fly heading one eight zero, runway one three, cleared for takeoff", "turn left heading 270, cleared for takeoff runway 13" and "cleared for takeoff runway 13, turn right heading 090" are ONE `TAKEOFF` with `departureHeading` (magnetic) and `turnDirection`; "fly runway heading" adds nothing. The engine remembers it (`AircraftRuntime.departureHeading`) and turns to it at 400 ft AGL (`flightDynamics.ts`; AIM 5-2-9: departures climb to 400 ft above the departure end elevation before the initial turn), the readback is "Heading one eight zero, runway one three, cleared for takeoff, ...", the strip shows `CTO 13 H180` / `L270`.
* **One taxi, one hold short** (`assemble.ts`): a non-progressive TAXI directly followed by a HOLD_SHORT (the route words could not be read) takes the hold short, so the pilot reads back once.
* **One transmission, one readback**: a progressive step ("turn left on Bravo, continue to Charlie, hold short of runway four") stays three commands (`EXIT_RUNWAY` / turn, `TAXI` segment, `HOLD_SHORT`, so each keeps its own engine effect); `ParsedCommand.groupSize` and the shared `transmissionId` let the engine join their readbacks into one pilot call (`sim/radioDiscipline.ts addReadbackFragment`). The readback of a segment is "Left on Bravo", "continue to Charlie" (`radio/readback.ts`).

### Numbers and punctuation

A comma/period/semicolon after a raw word now ends a spoken-number run, so "Spirit four fifty one, four miles"
is `NKS 451`, `4 miles` (typed STT punctuation matters). Before "minutes", `one zero thousand one zero` is split
into 10000 and 10.

## Confidence

```
Fg = coverage ^ 0.75              coverage = fraction of tokens consumed by recognised structure
Fc = 0.40                         no callsign resolved (missing, ambiguous or score < 0.75)
     0.85 + 0.15*(score-0.75)/0.25  otherwise
Fe = 0.55 ^ missing required entities (runway, value, hold-short point, approachType + runway for APPROACH,
             fix for DIRECT_FIX, ifr.destination for IFR_CLEARANCE ...; see requirements.ts)
Fx = 0.60 ^ conflicting entities (two runways, several callsigns, frequency/facility mismatch)
Fu = 0.85 ^ identifiers invalid or unknown to ctx
Fn = 0.90 ^ non-standard phraseology ("line up" without "and wait", bare "hold")
confidence = min(0.99, Fg*Fc*Fe*Fx*Fu*Fn)      UNKNOWN: 0.1*Fg
```
A missing callsign can never exceed 0.40, so the engine's "below threshold =>
clarify" rule handles it. Suggested engine threshold: execute at >= 0.70.
Constants live in `confidence.ts` and `callsign.ts` (`CALLSIGN_ACCEPT`).

## Landline (coordination) phraseology (`landline.ts`, `parseLandline`)

A landline call is "<called position>, <calling position>, <message>" and is parsed separately from radio calls (a radio call starts with a callsign; `looksLikeLandline` is true when the text starts with two
position names, so the typed box and the voice path route it without a mode). `parseLandline(text, { aircraft, runwayEnds, taxiways, fixes })` reuses the normaliser, callsign matcher and the runway / taxiway readers and
returns one `LandlineCommand` (`kind`, `to`, `from`, `callsign`, `runwayId` / `runwayEnd`, `point`, `afterCallsign`, `positionText`, `altitudeFt`, `text`, `confidence`, `nonStandard`, `issues`).

| Phrasing | `kind` | Standard? |
|---|---|---|
| Tower, Ground, [request [to]] cross runway one three at Alpha with Cessna ... | `REQUEST_CROSS` (Ground calling) | request wording is not prescribed (non-standard, 0.9) |
| Ground, Tower, cross runway one three at Alpha | `APPROVE` | 3-1-3 phraseology CROSS (runway) AT (point/intersection) |
| ... cross ... behind / after the landing Spirit [four fifty one] | `APPROVE` + `afterCallsign` | non-standard |
| cross approved, approved, unable, hold short [runway N], stand by / standby, unable ..., I'll call you back | `APPROVE`, `UNABLE`, `HOLD_SHORT`, `STANDBY` ("call you back" wins over "unable") | non-standard |
| Tower, Ground, Cessna ... across runway one three / crossing complete | `CROSS_COMPLETE` | non-standard |
| Departure, Tower, release Spirit four fifty one | `REQUEST_RELEASE` | non-standard |
| Tower, Departure, Spirit four fifty one released / release approved | `RELEASED` | 4-3-4 "(aircraft identification) RELEASED" |
| ... hold for release | `HOLD_FOR_RELEASE` | 4-3-4 |
| ... rolling / going around / on the go | `ROLLING`, `GOING_AROUND` | non-standard |
| [Approach, Departure,] point out, two miles west of Cedar Lake, three thousand, Cessna ... | `POINT_OUT` (`positionText` as spoken, `altitudeFt` = first round number of 3+ digits; the two positions may be left out) | 5-4-3 |
| ... point out approved / unable / traffic observed | `POINT_OUT_APPROVED`, `POINT_OUT_UNABLE`, `TRAFFIC_OBSERVED` | 5-4-3 |
| ... traffic, ... / anything else between two positions | `TRAFFIC`, `TEXT` (confidence capped at 0.75) | non-standard |

The calling position may be left out when the player works exactly one position (`LandlineContext.playerPositions`): "Tower, cross runway four at Bravo with Spirit ten thirty three" is that position calling Tower; "with", "for" or nothing may precede the callsign, which may also come first ("Tower, Spirit ten thirty three, request to cross ..."). `looksLikeLandline` is true for two position names, and for ONE position name followed by "cross ... runway", "point out" or "release": a controller addresses aircraft by callsign, so such a transmission on the radio path goes to the landline parser (and `transmit()` refuses to execute it as a clearance).

Whether a call asks or answers follows the direction: Ground to Tower with "cross runway ..." is the request, Tower to Ground the authorisation. Confidence = 0.97, x0.55 per missing item (runway, callsign, positions), x0.45 when a position is missing,
x0.9 non-standard, x0.85 per unknown runway / taxiway; below 0.6 the pipeline asks for a repeat (like the radio path). STT repairs: tour / power -> tower, grounds / round -> ground, departures, enable -> unable, standby, pointed out / point-out,
realised -> released, and everything the shared normaliser already fixes (NATO letters, spoken numbers, `november seven two three ...`). Tests: `landline.test.ts` (28), `sessionBugs.test.ts` (the session lines). The resolution to engine calls is in `src/ui/commands/landline.ts`.

## Extending

* **New word / alias**: add to `lexicon.ts` (airlines, GA prefixes, STT fixes in `ALIASES`, multi-word `PHRASES`, `FILLERS`).
* **New instruction**: write a `Rule` (`(tokens, i) => Hit | null`) in a `rules-*.ts` file using `seq`, `skipWords` and `makeDraft`, add it to `buildRules` in `grammar.ts` (mind the ordering notes there), add required entities to `requirements.ts` and, if it takes a runway, to `acceptsRunway`/`lacksRunway`/`applyRunway` in `draft.ts`. Add table rows to `transmissions.test.ts`.
* **Airport-specific validation**: pass `taxiways`, `runwayEnds`, `frequencies` in the context; extend `validate.ts` for new id types.
* Tests: `npm test -- src/commands` (`transmissions.test.ts` for tower/ground, `towerVocab.test.ts` for exit / cancel / traffic / pattern / report / squawk / information, `ifr.test.ts` for approach / direct / IFR clearance; fixtures including `FIXES` in `testkit.ts`).

## Known limits

* `ParsedCommand` has no field for "at or below" altitude restrictions or pattern side on `base`; these are encoded in `turnDirection`/`destination` or dropped. Not parsed: "circle the airport", "cleared ... , traffic holding in position" as an instruction of its own, the pilot's "have numbers".
* Traffic descriptions are matched by the engine, not the parser: the parser only keeps the words ("boeing 737", "skyhawk") and the position clause.
* Conditional clauses ("behind the landing traffic", "after departure") are not modelled; their words show up as `unrecognised words`.
* Two-letter taxiway names and runway designators with parallel suffixes are only lightly supported.

## Pilot realism additions

* `callsign.ts`: `AircraftRef.contacted` (set from `Aircraft.flags.inContact`, only with pilot realism): an abbreviated civil callsign ("three echo juliet", at least three characters, the
  existing suffix rule) for an aircraft that has not called yet scores 0.25 lower and is not accepted (AIM 4-2-4: abbreviate only after communications are established). `CallsignResolution.abbreviated`
  and `ParsedCommand.callsignAbbreviated` tell the engine that the controller abbreviated, so the pilot may too.
* `ParsedCommand.groupSize`: the number of instructions in the transmission (set for multi-instruction transmissions); long ones draw "say again" at higher pilot realism.
* New commands: `DID_YOU_COPY` ("did you copy", "do you copy", "how do you hear me"; the controller calls an aircraft that did not answer) and `UNABLE` ("unable", "request denied", "not approved"; takes only its own clause - up to the next comma
  (`Token.comma`, from the raw word) - and only when that clause holds no instruction word: "unable, traffic on the runway" is not read as instructions, "unable, runway one three cleared to land" is an UNABLE and a landing clearance). Neither is an FAA phraseology item; they are plain controller language.

## Traffic variety grammar (`rules-special.ts`)

`ruleAirTaxi` ("air taxi via alpha to the Coast Guard ramp", "hover taxi to Coast Guard helipad three"), `makeProceedRule` ("proceed on runway one three, report runway inspection complete" = PROCEED, "proceed on the taxiways", "proceed to runway ... via ..." = the taxi rule), `ruleHeliTakeoff` ("[pad,] make right turn for southeast departure, cleared for takeoff [from present position]"), `ruleHeliLand` ("make straight-in approach to Coast Guard helipad two, cleared to land"), `ruleOverhead` ("runway N, wind ..., pattern altitude N, right turns, report initial", "break at midfield, report break"), `ruleTrafficDirection` ("make right traffic", 3-10-1). Callsigns: "Coast Guard" and "Air Guard" are two-word telephony (`lexicon.ts` PHRASES) followed by 5 digits; "Airport <n> vehicle" (the word "airport" is a callsign only before a number); "flight of two / three / four" is dropped. "Proceed as requested" is deliberately not parsed (3-1-5 NOTE). Tests: `special.test.ts`.


### Exit request and one eighty (exit-choice round)

* Landline `REQUEST_EXIT`: "Tower, Ground, have Spirit ten thirty three exit left at Charlie" / "... hold short of runway four after landing" (`exitSide`, `point`, `holdShortAfterLanding` + `runwayId`). 7110.65 3-1-4 asks for the exchange but prescribes no wording: `nonStandard`, confidence x0.9. `looksLikeLandline` is true for one position name followed by "have ... exit ..." or "hold short ... after landing". Tests: `exitRequest.test.ts`.
* Radio `TURN_AROUND` (`ruleTurnAround`, rules-ground.ts): "make a one eighty", "do a 180", "turn around", "turn back", "reverse course". No 7110.65 phrase exists for an aircraft on a taxiway (3-7-2 gives step-by-step directions and directional turns): non-standard, confidence x0.9, the issue text says so. Executed by `sim/turnAround.ts`.

## Phrase interpreter (fallback) (`llm/`)

The grammar is the fast path and handles almost everything locally. When it is unsure, the session may ask a language model, through the local backend, to read the transmission. Nothing here changes `parseTransmission`; the fallback sits around it.

* **Trigger** (`needsInterpreter`, `fallback.ts`): the grammar found no command, any command is `UNKNOWN`, or any command's confidence is below `INTERPRETER_BELOW` (0.6, the engine's own "ask again" floor; values that low come from unrecognised words, missing entities, an unresolved callsign, or stacked conflicts/unknown ids). Merely non-standard wording stays above it. Landline calls never use it.
* **Flow** (`ui/store/session.ts submit`): `parseForTransmit` -> if needed, an INFO event "Checking that phrasing with the phrase interpreter…" and `POST /api/llm/parse` (`client.ts`, contract in `contract.ts`, 8 s timeout) -> `adoptLlmCommands` -> `mergeResults` -> the normal `transmit` path, once. Because the call is slow, `submit` returns a provisional `Interpreting…` result and delivers the real one through `hooks.onTransmitResult`; unsure-free calls stay synchronous. Failure, timeout or no usable answer keeps the grammar result and logs one short reason; a 503 `LLM_NOT_CONFIGURED` switches the fallback off for the session.
* **Validation of model output**: the model is never trusted. The callsign must be an active aircraft (exact match, else the grammar's `resolveCallsign`); a command naming anything else is dropped and the reason is added as an issue to the survivors. Runway ends, taxiways, frequencies (fills `frequencyId`) and fixes go through `validateFields`, the same check the grammar uses. `rawText`, `normalizedText` and `issues` are filled in here, `interpretedBy` is `'llm'`, and `confidence` = 0.9 minus 0.1 per issue, floored at 0.5 (so four or more issues makes the engine ask for clarification). Nothing usable -> null -> the grammar result stands. An executed interpreter command is labelled in the result line ("Issued: ... (phrase interpreter, 1.2 s)").
* **Setting**: Settings > Phrase interpreter (`VoiceSettings.interpreterEnabled`, default on). The form shows whether the backend has a key (`/api/health` `llmConfigured`, `llmModel`) and is unavailable on the static hosted site.
* **Privacy**: only when the grammar is unsure, the transmission text (never audio) plus the aircraft callsigns/types and the airport's runway ends, taxiways, frequencies, fixes and arrivals are sent through the local backend to the model provider's API. Clear instructions never leave the browser. Turn the setting off to keep everything local (`VOICE_PRIVACY_NOTES.interpreter`).
