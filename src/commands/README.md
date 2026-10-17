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
| hold short [of] runway N / taxiway X | `HOLD_SHORT` (`holdShort: ['RWY13']` or `['A']`, plus `runwayEnd`/`runwayId`) |
| cross runway N [at/via taxiway X] | `CROSS_RUNWAY` (`crossRunwayId: '13/31'`, `runwayEnd`, crossing taxiway in `route`) |
| line up and wait / position and hold / taxi into position | `LINE_UP_AND_WAIT` ("line up" alone is accepted but flagged) |
| cleared for takeoff (STT: take off, clear for) | `TAKEOFF`; "fly heading/runway heading" and "turn left heading" are separate `HEADING` commands |
| cleared to land / option / touch and go / stop and go / low approach | `LAND` (`destination: option, touch_and_go, stop_and_go, low_approach`) |
| go around | `GO_AROUND` |
| continue [approach] [expect late landing clearance] | `CONTINUE_APPROACH` |
| contact/monitor/switch to/change to ground, tower, approach, departure, clearance delivery [freq] | `CONTACT_FREQUENCY` (`frequencyId` GND/TWR/APP/DEP/CLNC, `frequencyMhz`); bare "point niner" leaves `frequencyMhz` undefined; "change to my frequency" -> `destination: 'MY_FREQUENCY'` |
| turn left/right heading N, fly heading N, fly runway heading | `HEADING` (`headingDeg` 1..360, 000 -> 360; "runway heading" -> `destination: 'RUNWAY_HEADING'`, "present heading" -> `'PRESENT_HEADING'`) |
| climb/descend/maintain [and maintain] [VFR at or below] N, flight level N | `ALTITUDE` (`altitudeFt`; FL180 -> 18000) |
| reduce speed to N, slow to N, speed N, maintain N knots, resume normal speed | `SPEED` (`speedKt`, or `destination: 'NORMAL_SPEED'`) |
| enter left/right downwind/base runway N, make straight in, make left traffic, report [N mile] final/downwind/base | `ENTER_PATTERN` (`patternLeg`, `turnDirection` = side, report forms set `destination: 'REPORT_...'`) |
| pushback approved | `PUSHBACK` |
| say again / repeat | `SAY_AGAIN` |
| cleared [for] [the] ILS / I-L-S / localizer / RNAV [GPS] / VOR / visual [approach] [runway] N [approach] | `APPROACH` (`approachType` ILS, LOC, RNAV, VOR, VISUAL; `runwayEnd`, `runwayId`). A bare `runway N` before/after attaches like other runway instructions. Needs approachType + runway |
| [when able] [proceed\|cleared\|fly] direct [to] <fix> | `DIRECT_FIX` (`fix` = fix id, see Fixes) |
| resume [your] own nav[igation], proceed on course | `RESUME_OWN_NAVIGATION` |
| radar contact [N miles <dir> of the field / from <fix>] | `RADAR_CONTACT` (position text consumed and ignored) |
| cleared to <airport> [via <DP / route>], maintain N, expect N [N minutes after departure], departure [frequency] X, squawk NNNN; "cleared [to X] as filed" | `IFR_CLEARANCE` (`ifr`, see below) |
| `maintain N until established [on the localizer]`, `until <fix>` | the normal `ALTITUDE`, plus `destination: 'UNTIL_ESTABLISHED'` or `'UNTIL_<FIX>'` (+ `fix`) |
| hold [at] <fix> [as published], hold <dir> of <fix> on the N radial \| localizer, right\|left turns, N minute \| N mile legs, expect further clearance [at] HHMM; "cleared to <fix>, hold ..." | `HOLD_AT_FIX` (`hold`, see below) |
| execute [the] [published] missed approach, fly the published missed approach, go missed, "go around, fly the published missed approach" | `MISSED_APPROACH` (the go-around prefix is absorbed, no separate `GO_AROUND`) |
| standalone squawk, ident, other "cleared ... approach" (NDB, TACAN), ambiguous `maintain 180` | `UNKNOWN` with an explanatory issue |
| anything else / empty | one `UNKNOWN` with `no recognised instruction` / `empty transmission` |

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

## Extending

* **New word / alias**: add to `lexicon.ts` (airlines, GA prefixes, STT fixes in `ALIASES`, multi-word `PHRASES`, `FILLERS`).
* **New instruction**: write a `Rule` (`(tokens, i) => Hit | null`) in a `rules-*.ts` file using `seq`, `skipWords` and `makeDraft`, add it to `buildRules` in `grammar.ts` (mind the ordering notes there), add required entities to `requirements.ts` and, if it takes a runway, to `acceptsRunway`/`lacksRunway`/`applyRunway` in `draft.ts`. Add table rows to `transmissions.test.ts`.
* **Airport-specific validation**: pass `taxiways`, `runwayEnds`, `frequencies` in the context; extend `validate.ts` for new id types.
* Tests: `npm test -- src/commands` (`transmissions.test.ts` for tower/ground, `ifr.test.ts` for approach / direct / IFR clearance; fixtures including `FIXES` in `testkit.ts`).

## Known limits

* `ParsedCommand` has no field for "at or below" altitude restrictions, pattern side on `base`, or runway-less "report" legs; these are encoded in `turnDirection`/`destination` or dropped (see report).
* Conditional clauses ("behind the landing traffic", "after departure") are not modelled; their words show up as `unrecognised words`.
* Two-letter taxiway names and runway designators with parallel suffixes are only lightly supported.
