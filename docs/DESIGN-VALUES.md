# Design values: inventory and sourcing record

Rule of the project: real FAA / manufacturer data where it exists, a documented design value where it does not, nothing invented. This file lists
**every** value the code or the docs label a design value, UNVERIFIED, second-hand or secondary-source, what a source would have to say, and what the
sourcing pass of 2026-10-19 found. Retrieval date of every source named here: **2026-10-19** (downloaded with curl and a browser user agent; the
PDFs were read as text with `pdftotext`).

Status vocabulary: **SOURCED** (a retrieved document states the number or it is derived from one, derivation shown; value replaced or confirmed),
**CROSS-CHECKED** (a source bounds or corroborates the value, which stays a design value), **DESIGN** (nothing found; the search is recorded).

Inventory size: see the count at the end of section 0.

## 0. Sources retrieved in this pass

| Id | Document | URL | What it states that matters here |
|---|---|---|---|
| S1 | Prinzo, Hendrix, Hendrix, *The Outcome of ATC Message Complexity on Pilot Readback Performance*, DOT/FAA/AM-06/25, Nov 2006 (TRACON, 11,159 instructions / advisories from 5 facilities, 12,148 pilot transmissions) | https://libraryonline.erau.edu/online-full-text/faa-aviation-medicine-reports/AM06-25.pdf (FAA series, copy hosted by Embry-Riddle) | Table 10: readbacks in error per aviation topic: altimeter 3.26 %, **altitude 1.18 %**, altitude restriction 18.57 %, approach/departure 2.61 %, **heading 3.93 %**, **radio frequency 6.15 %**, route/position 2.13 %, speed 10.56 %, **transponder 2.50 %** (n = 40), all 3.26 %. Table 8: 6.2 % of pilot readbacks faulty (liberal scoring 1.3 %); below message complexity 10 the rate stays 2.3-6.1 %, at 11-13 it is 10.8-19.2 %, above 16 about 38 %. Table 6: **3.8 % of messages not acknowledged**. Call sign mismatch fell from 0.8 % to 0.3 % (Cardosi 1996 vs 2004 data). 4 events of the wrong aircraft accepting a clearance in about 50 h. 133 pilot requests to repeat or confirm in 11,159 transmissions. |
| S2 | Prinzo, Hendrix, Hendrix, *The Outcome of ATC Message Length and Complexity on En Route Pilot Readback Performance*, DOT/FAA/AM-09/2, Jan 2009 (51 h, 5 en route centers) | https://libraryonline.erau.edu/online-full-text/faa-aviation-medicine-reports/AM09-02.pdf | Unacknowledged ATC transmissions "slightly more than 3 %" in both studies; readback errors rise with message length. |
| S3 | Vu et al. (NASA Ames / CSULB), *Influence of UAS Pilot Communication and Execution Delay on Controller's Acceptability Ratings of UAS-ATC Interactions*, NASA NTRS 20140011009 | https://ntrs.nasa.gov/api/citations/20140011009/downloads/20140011009.pdf | Manned-aircraft verbal response latency (end of the clearance to the start of the readback) 0.78 s and 1.06 s in the two simulation conditions; en route recordings quoted from an earlier study: mean verbal delay 2.67-3.31 s with SD 4.6-6.3 s and 12 % of communications repeated by the controller; pilot verbal delays above 5 s rated unacceptable. |
| S4 | San Marino Civil Aviation Authority, Safety Notice 01/2026 Issue 01 "Adherence to Taxi Procedures and Recommended Taxi Speed Guidelines" | https://www.smar.aero/wp-content/uploads/2025/12/SN-01-2026-Issue-01-Adherence-to-Taxi-Speeds.pdf | Regulator guidance "unless the aircraft manufacturer specifies lower limits": 10 kt on non-active runways and taxiways, no more than 30 kt on straight taxiways, no more than 10 kt in turns, about 10 kt on aprons, 10 kt behind a follow-me. |
| S5 | FAA AC 90-48D *Pilots' Role in Collision Avoidance* (4/19/16) | https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_90-48D.pdf | Table 1: see object 0.1 s, recognise aircraft 1.0 s, become aware of collision course 5.0 s, decide 4.0 s, muscular 0.4 s, aircraft lag 2.0 s, total 12.5 s. |
| S6 | Madden, *Verifying Implementation of the Dryden Turbulence Model and MIL-F-8785 Gust Gradient*, NASA Langley, NTRS 20190000875 (quotes MIL-F-8785B/C and MIL-HDBK-1797) | https://ntrs.nasa.gov/api/citations/20190000875/downloads/20190000875.pdf | Free-atmosphere turbulence scale length L = 1,750 ft; in the boundary layer (h < L) L_u = L_v = L_FA^(2/3) h^(1/3); MIL-STD-8785C / HDBK-1797 define the boundary layer below 1,000 ft AGL. |
| S7 | EASA TCDS EASA.A.064 (A318-A321) Issue 62, 26 Jun 2026; EASA TCDS EASA.IM.A.226 (Cessna 208) Issue 15, 18 Sep 2025 | https://www.easa.europa.eu/en/downloads/16507/en ; https://www.easa.europa.eu/en/downloads/7230/en | Searched the text for "crosswind", "tailwind", "wind": **no entry** in either. |
| S8 | Earlier sources already cited in `REALISM-VERIFICATION.md` / `BEHAVIOUR-ACCURACY.md` (JO 7110.65, JO 7110.126A, AIM, AC 150/5300-13B Chg 1, AC 150/5210-20A, NASR, Airbus A320 airport-planning document, POH 172S) | see those files | unchanged |

Not reachable (HTTP 403 "Access Denied" to curl with a browser user agent, 2026-10-19): af.mil F-16 fact sheet (`/Article/104505/`), the 138th / 169th
Fighter Wing and Osan unit copies, nationalmuseum.af.mil, dcms.uscg.mil MH-65 page. The Lockheed Martin F-16 product page returned no specification
table. The F-16 and MH-65 figures therefore stay second-hand (read through search-result text), as recorded in section 9 of `REALISM-VERIFICATION.md`.

## 1. Pilot behaviour rates (`src/sim/pilotBehaviour.ts`, `PilotRealism`)

Readback errors: **SOURCED (S1) and replaced**. Levels after the change: moderate = the measured TRACON rate, light = half of it, heavy = twice it
(the study's own rates for complex messages run from 2x to 6x the average: 10.8-19.2 % at complexity 11-13, about 38 % above 16, so a factor 2 is a
conservative "busy frequency"). The factors 0.5 and 2 are design scaling; the moderate anchors are the measurements.

| Id | Value | Where used | Before (light / moderate / heavy) | After | What a source says | Status |
|---|---|---|---|---|---|---|
| P1 | `digitErrorRate` (runway or heading digit) | readback of runway, heading | 4 / 8 / 12 % | 2 / 4 / 8 % | S1 Table 10: heading 3.93 %, approach/departure (runway) 2.61 % | SOURCED, replaced (moderate 4 %) |
| P2 | `altitudeErrorRate` | altitude readback | 2 / 4 / 7 % | 0.6 / 1.2 / 2.4 % | S1: altitude 1.18 % (altitude restrictions 18.57 % are a different, rarer instruction) | SOURCED, replaced |
| P3 | `frequencyErrorRate` | frequency change readback | 2 / 4 / 7 % | 3 / 6 / 12 % | S1: radio frequency 6.15 % | SOURCED, replaced (it rises: the old value was too low) |
| P4 | `squawkErrorRate` | transponder code readback | 2 / 4 / 7 % | 1.2 / 2.5 / 5 % | S1: transponder 2.50 % (n = 40, small sample) | SOURCED, replaced |
| P5 | `noReadbackRate` | compliance without a readback | 2 / 4 / 7 % | 1.9 / 3.8 / 7.6 % | S1 Table 6: 3.8 % of messages not acknowledged; S2 "slightly more than 3 %" | SOURCED, replaced |
| P6 | `patternMisunderstandRate` | pattern entry / instruction misread (x students) | 3 / 5 / 8 % | unchanged | No topic "pattern" in S1 (tower and pattern traffic are not in the TRACON / en route samples) | DESIGN (searched S1, S2) |
| P7 | `wrongCallsignRate` (given a similar callsign on the frequency) | another aircraft answers | 15 / 30 / 50 % | unchanged | S1: call sign mismatch 0.3 % of transmissions (all transmissions, not conditional on a similar call sign) and four wrong-aircraft acceptances in about 50 h. The conditional probability is not published | DESIGN (S1 bounds the unconditional rate; the simulator only draws it when a similar callsign exists) |
| P8 | `similarCallsignRate` | generator creates a sound-alike | 4 / 10 / 20 % | unchanged | No traffic-generation statistic | DESIGN |
| P9 | `delayedResponseRate` (call missed, needs a second call) | pilot misses the call | 1.5 / 3 / 5 % | unchanged | S3: controllers repeated 12 % of communications in a recorded en route study (includes non-responses and other reasons); S1: 3.8 % not acknowledged (already used for P5). The 3 % stays inside both | CROSS-CHECKED |
| P10 | `responseDelaySec` airline / GA / student | end of instruction to readback | moderate 0.5-1.8 / 1-3.2 / 2-5 s | unchanged | S3: manned pilots 0.78-1.06 s (simulation), recordings mean 2.7-3.3 s (SD 4.6-6.3 s, heavy tail). The airline band (mean 1.15 s) matches the simulation, the GA / student bands the recorded mean. No split by crew type is published | CROSS-CHECKED |
| P11 | `sayAgainRate`, `sayAgainMinCommands`, student factor | "say again" on long transmissions | 15 / 25 / 35 %, N = 3 / 3 / 2 | unchanged | S1: 133 pilot requests (60 repeats, 73 confirmations) in 11,159 transmissions = 1.2 % overall; longer messages produce more, no per-length table found | DESIGN (S1 gives only the overall rate; the per-transmission rate for N >= 3 instructions is not published) |
| P12 | `blockWindowSec` (key-up overlap window) | blocked transmissions | 0.4 / 0.5 / 0.6 s | unchanged | No published blocked-transmission rate or overlap window found (S1 mentions stepped-on calls as a coincident factor only) | DESIGN. Measured output stays in README / BEHAVIOUR-ACCURACY R9 |
| P13 | `blockRetryMinSec`, `blockRetrySpreadSec`, `KEYUP_SPREAD_SEC` 12, `WAIT_SPREAD_SEC` 0.6, `STAGGER_MARGIN_SEC` 0.3, `RETRY_CLEARANCE_SEC` 0.5, `WAIT_GAP_SEC` 0.3, `BLOCKED_SQUEAL_SEC` 1.4, `MAX_BLOCK_RETRIES` 2 | `radioDiscipline.ts` | as listed | unchanged | Pilot behaviour on a blocked call is not specified by the FAA text | DESIGN |
| P14 | `novemberInitialRate`, `withYouRate`, `withBravoRate` | callsign / check-in style | 30-50 %, 20-40 % | unchanged | S1 reports call sign usage (full call sign in about 64 % of full readbacks, 2.3 % abbreviated after contact) but not the "November" or "with you" habits | DESIGN (S1 searched) |
| P15 | `studentShare`, `progressiveTaxiRate` | share of light VFR flown by students | 10 / 20 / 30 %, 40 / 50 / 60 % | unchanged | No count of student pilots in the KACY / KMHT GA traffic | DESIGN |
| P16 | `requests` (11 request codes) | pilot-initiated requests | 3-35 % per eligible aircraft | unchanged | S1: pilot requests are repeats / confirmations, not runway or pattern requests | DESIGN |
| P17 | `needMinuteSec` | "we need a minute" | 30-60 / 30-60 / 40-75 s | unchanged | none | DESIGN |
| P18 | `ground.holdShortOmitFraction` | hold-short left out of a taxi readback | 4 / 8 / 12 % | unchanged | S1 covers airborne instructions; no ground-control readback sample found | DESIGN |
| P19 | `ground.taxiwayErrorShare` | wrong taxiway as a share of the digit rate | 0.5 | unchanged (the absolute rate follows P1: 1 / 2 / 4 %) | S1 route/position 2.13 % (en route fixes, not taxiways) | DESIGN |
| P20 | `ground.unfamiliarFraction` | pilots unfamiliar with the airport | 5 / 10 / 15 % | unchanged | none | DESIGN |
| P21 | `ground.holdShortReadbackGraceSec` | charge window for a missing hold-short readback | 20 s | unchanged | none | DESIGN |
| P22 | `ground.pushbackSpeedMps` | tug push speed | 1.2 m/s (2.3 kt) | unchanged | Textron GSE TUG MT and other tug sheets give top speeds of 20-32 km/h (machine capability, not a push speed); Mototok towbarless tugs are reported at about 5.4 km/h in operation (an Iberia article, not a spec). No published operating push speed | DESIGN |
| P23 | `ground.pushStartDelaySec` 8, `pushSwingRateDegPerSec` 3, `pushSettleSec` 4, `PUSH_ACCEL_MPS2` 0.4 | pushback timeline | as listed | unchanged | none (airline ground-handling procedures are not public) | DESIGN |
| P24 | `ground.airlinerReadyAfterPushSec` 15-45 s, `gaStartSec` 8-25 s, `pushbackRepeatAfterSec` 90 s, `arrivedLingerSec` 120 s | start-up and turn timing | as listed | unchanged | none | DESIGN |
| P25 | `ground.taxiSpeedMinFactor` | seeded spread of taxi speeds | 0.85 | unchanged | none | DESIGN |
| P26 | `ground.taxilaneMaxKt` | taxilane speed cap | 13 kt | unchanged | AC 150/5300-13B Chg 1 glossary: taxilane "not more than 15 mph (13 kts)" | SOURCED earlier |
| P27 | `noAtisFraction` 0.4, `numbersRequestAfterSec` 20, `followMarginSec` 10 | pilot behaviour defaults | as listed | unchanged | none | DESIGN |
| P28 | `look.*` (pAhead .95, pSide .6, pBehind .2, aheadDeg 60, sideDeg 110, altDiffFt 3000, altFactor .5, farShare .6, farFactor .7, immediateShare .6, acquireMinSec 6, acquireSpreadSec 10, maxRangeSm 10) | acquiring described traffic (3-1-6, 7-2-1) | as listed | unchanged | S5 Table 1 gives the time from seeing an object to recognising it (0.1 + 1.0 s) and the whole avoidance chain (12.5 s), not the time to find a traffic call-out or a detection probability by angle | DESIGN (S5 searched; not the same quantity) |
| P29 | `TGO_DECEL_SEC` 3, `TGO_RECONFIGURE_SEC` 3 (touch-and-go), `HEAD_ON_CALL_AFTER_SEC` 4, `HEAD_ON_RECALL_SEC` 90, `HEAD_ON_RESUME_WINDOW_SEC` 300, lost-frequency delay 60-120 s | pilot actions | as listed | unchanged | none | DESIGN |
| P30 | Default digit error 8 % when the scenario sets no realism level (`readbackErrorRate`) | pre-realism behaviour kept so old scenarios replay | 8 % | unchanged on purpose (replay stability) | S1 gives 3.9 % for headings | DESIGN, kept for compatibility; the realism levels use P1 |

## 2. Wind (`src/sim/wind.ts`, `flightDynamics.ts`)

| Id | Value | Current | What a source would say | Status |
|---|---|---|---|---|
| W1 | `GUST_SPEED_TAU_SEC` | 8 s | Correlation time of turbulence = L / V. S6 (MIL-F-8785 / HDBK-1797): L = 1,750 ft in the free atmosphere, L_u = 1750^(2/3) h^(1/3) ft below 1,750 ft AGL (1,000 ft in the handbooks). At 130 kt (219 ft/s): free atmosphere 1750 / 219 = **8.0 s**; h = 500 ft: L = 145.0 x 7.94 = 1,151 ft, 5.3 s; h = 100 ft: 673 ft, 3.1 s | CROSS-CHECKED: 8 s equals the free-atmosphere value at approach speed and is the upper end; below 500 ft AGL on final the same source gives 3-5 s. Kept (a height- and speed-dependent time constant would be a model change; recorded as an option) |
| W2 | `GUST_DIR_TAU_SEC` 12 s | direction process | Dryden models give three components with the same scale (L_u = L_v); no separate direction constant | DESIGN |
| W3 | `GUST_SMOOTH_TAU_SEC` 2 s | numerical smoothing, no physical meaning | n/a | DESIGN (by construction) |
| W4 | `GUST_LULL_FRACTION` 0.5 | lull depth below the mean | METAR reports only the peak (`windGustKt`); AIM / FMH-1 define a gust as a peak with a lull of 10 kt or more between peaks; no ratio | DESIGN |
| W5 | `GUST_DIR_DEG_PER_KT` 0.6, `GUST_DIR_MAX_DEG` 10 | direction wander | none found | DESIGN |
| W6 | `GUST_LIFT_FPM_PER_KT` 25 | flare lift per kt of gust-added airspeed | none | DESIGN |
| W7 | `WIND_LIMIT_GOAROUND_SEC` 2, `WIND_GOAROUND_MARGIN_KT` 5 | go-around trigger over the demonstrated crosswind | demonstrated crosswind is not a limitation (14 CFR 23.233 / 25.237 are demonstration minima); no go-around rule | DESIGN |
| W8 | `maxCrosswindKt` / `maxTailwindKt` of A320, B738, E175, CRJ9, B752, BCS3, C208 | undefined (no limit) | A manufacturer or regulator document that states the figure. Searched: EASA TCDS EASA.A.064 Issue 62 (A320) and EASA.IM.A.226 Issue 15 (C208), S7: no wind entry; the Airbus airport-planning document (earlier pass): none; a TCDS search for B737 / E-Jet / CRJ / A220 returned no document that lists a value. Only forum, simulator and pilot-community figures (A320 38 kt, CRJ 27 kt, B757 40 kt) exist, which the user declined | DESIGN (no primary source; stay undefined as decided) |

## 3. Aircraft performance (`src/sim/performance.ts`)

| Id | Value | Current | What a source would say | Status |
|---|---|---|---|---|
| A1 | H65 cruise 148 kt, length 13.5 m, max speed 175 kt | cited | USCG MH-65E fact sheet, CGAA table | second-hand (dcms.uscg.mil 403 again on 2026-10-19) |
| A2 | H65 taxi 10 / 5 kt, accel 4, decel 5 kt/s, climb speed 80 kt, approach 70 kt, climb 1,500 / descent 800 fpm, turn 3 deg/s (standard rate), ground turn 20 deg/s, ceiling 10,000 ft | UNVERIFIED | HH-65 / MH-65 flight manual (not public) | DESIGN |
| A3 | H65 rotorcraft: `hoverTaxiMaxKt` 20 | **SOURCED** earlier (JO 7110.65 3-11-1) | | already sourced |
| A4 | H65 `airTaxiKt` 35, `hoverAglFt` 15, `verticalRateFpm` 500, `hoverTurnRateDegPerSec` 15, `AIR_TAXI_AGL_FT` 40 (inside 3-11-1: below 100 ft AGL, above 20 kt), `HELI_APPROACH_ANGLE_DEG` 6, `APPROACH_DECEL_MPS2` 1.2, `PAD_CAPTURE_M` 6 | design inside the 3-11-1 limits | a rotorcraft pad approach angle: AIM Chapter 5? Searched AIM 4-3 / 3-... for "approach angle" in helicopter procedures: nothing | DESIGN |
| A5 | F16 length 15.06 m, ceiling 50,000 ft, Mach 2 | cited | USAF fact sheet | second-hand (af.mil 403 again on 2026-10-19) |
| A6 | F16 taxi 20 / 8, accel 6, decel 5, rotate 150, climb speed 300, cruise 350, approach 160, touchdown 140, minSpeed 130, maxSpeed 450, climb 6,000 / descent 2,500 fpm, turn 8 deg/s (about 2.5 g at 300 kt: n = 2.5 gives 9.81 x sqrt(2.5^2 - 1) / 154 m/s = 0.146 rad/s = 8.4 deg/s), ground turn 18, takeoff 3,000 / landing 3,500 ft | UNVERIFIED | USAF / Lockheed Martin F-16 performance, NATOPS-style approach speeds (not public) | DESIGN (unreachable fact-sheet servers; the turn rate has a transparent physical derivation from the g assumed, which is itself unsourced) |
| A7 | F16 overhead: `OVERHEAD_INITIAL_NM` 3, break at mid-runway, `OVERHEAD_SPEED_KT` 200, fighter base turn 3.5 nm (`FIGHTER_BASE_ALONG_M`), 1,500 ft AGL | design inside AIM 4-3-3 and 14 CFR 91.117(b) | USAF AFI 11-2F-16 (not public) | DESIGN (the 200 kt and 1,500 ft are regulatory, already sourced) |
| A8 | VEH taxi 18 / 8 kt, accel 3, decel 5, length 5.5 m | UNVERIFIED | AC 150/5210-20A: speed limits are set by the airport operator (earlier pass); S: no airport rule published for KACY / KMHT | DESIGN |
| A9 | `ERRAND_DWELL_SEC` 40 (vehicles), vehicle task mix | design | none | DESIGN |
| A10 | Taxi speeds: C172 15 / 8 kt, light turboprops 15 / 8, jets 20 / 10 kt (A320 family, B738, E175, CRJ9, B752, BCS3) | design inside AC 150/5300-13B Chg 1: taxiway 15-35 mph (13-30 kt) | S4 (regulator guidance): no more than 30 kt on straight taxiways, no more than 10 kt in turns, about 10 kt on aprons. The Airbus FCOM / FCTM 30 / 10 kt (Copenhagen A319 2012 report, quoted second-hand) agrees with S4 | CROSS-CHECKED: the turn speed 10 kt and the 30 kt ceiling are confirmed by a regulator document and match AC 150/5300-13B; the cruise taxi speed 20 kt (15 kt for light aircraft) remains a design choice inside the range, and the C172 has no number |
| A11 | `accelKtPerSec`, `decelKtPerSec` of airliners (3.3-4.0 / 5.5-6.0) | design | Airbus / Boeing airport planning documents give no taxi acceleration | DESIGN |
| A12 | B752 RECAT E, `wakeCategory` fallback, "NOT listed in TBL A-1: kept F by the over-41,000-lb convention" for B738 | JO 7110.126A | already sourced; the convention remains | DESIGN (the type is absent from TBL A-1) |
| A13 | `TAXI_ACCEL_MPS2` 1.0, `TAXI_DECEL_CAP_MPS2` 1.2, `TAXI_DECEL_PLAN_MPS2` 0.9 (`groundMovement.ts`) | design | none | DESIGN |
| A14 | Added types (2026-10-21): taxi 20 / 10 kt (15 / 8 for the light turboprops and the C402), turn rate 2.5-3 deg/s, ground turn 8-25 deg/s, `decelKtPerSec` 6.0 jets / 5.5 heavies / 4.4-4.5 props, `descentRateFpm` 2,000 for jets (ACD descent ROD 1,500-3,500) | design | the ACD gives descent rates but no taxi, turn or braking figure | DESIGN |
| A15 | Added types: `accelKtPerSec` = VR^2 / (2 x 0.8 x `takeoffDistanceFt`) (ground roll taken as 80 % of the ACD 35 ft take-off distance; A320 and B738 give 0.83 / 0.80); `maxSpeedKt` = max(climb IAS, descent IAS) + 30 kt; minimum speed = Vat - 15 kt | derived | no source for the ground roll or the minimum manoeuvring speed | ESTIMATE |
| A16 | Added types: `cruiseSpeedKt` 250 kt for jets (14 CFR 91.117(a)); for the DH8D, BE20, BE9L, PC12 and C402 an ACD climb or approach IAS (210 / 230 / 200 / 180 / 150 kt) | SOURCED / derived | a published cruise IAS per type (POH / AFM) | the 250 kt is regulatory; the others ESTIMATE |
| A17 | RECAT of A20N, A21N, B38M (F), A35K (B), BE9L (I), CL35 (H): not in JO 7110.126A TBL A-1 | derived from siblings / weight definitions | an FAA aircraft-type database (`aircraft automation databases list all aircraft`, TBL A-1 note 2) | DESIGN (type absent from TBL A-1) |

## 4. Helicopter separation and rotorcraft (`helicopterSeparation.ts`, `rotorcraft.ts`)

| Id | Value | Current | What a source would say | Status |
|---|---|---|---|---|
| H1 | `HELI_LEVEL_AGL_FT` | 400 ft AGL | A primary figure for a helicopter altitude that separates it from a 500 ft AGL helicopter pattern and a 1,000 ft AGL fixed-wing pattern. AIM 4-3-3 states only the 500 ft AGL helicopter pattern (already cited). Searched FAA text for a separation altitude: none | DESIGN, kept as decided; **no better primary figure found** |
| H2 | `HELI_BAND_AGL_FT` 900, `HELI_LATERAL_NM` 1.8, `DEPARTURE_TRACK_NM` 4, `FINAL_TRACK_NM` 4 | the simulator's own near-miss alert (1.5 nm / 500 ft) plus margins | JO 7110.65 3-11-3 / 3-11-4 give the helicopter-versus-helicopter rules in terms of "has left the takeoff area" and a distance between touchdown points, not a track length | DESIGN |
| H3 | `HELI_CLIMBOUT_AGL_FT` = H1 | design | same as H1 | DESIGN |
| H4 | `AIRBORNE_PROXIMITY_NM` 1.5, `AIRBORNE_PROXIMITY_FT` 500 (alert) | near-miss alert | JO 7110.65 5-5-4 gives radar separation (3 nm / 1,000 ft); an alert distance of a "near miss" is not defined by the order (the FAA's loss-of-separation categories are for reporting, not this alert) | DESIGN |

## 5. Ground movement, head-on, exit choice, pushback, vehicles

| Id | Value | Current | What a source would say | Status |
|---|---|---|---|---|
| G1 | Ground spacing `1.5 x max length + 20 m`, leader within 250 m (`groundMovement.ts`) | design | A published taxi following distance. Searched AC 150/5300-13B (only object-free-area widths, lateral), JO 7110.65 3-7-2 (the controller keeps aircraft apart; no distance) | DESIGN |
| G2 | `HEAD_ON_LOOKAHEAD_M` 200, `HEAD_ON_LINGER_SEC` 40, `HEAD_ON_WAIT_EXTRA_M` 20, give-way order | `sim/headOn.ts` | JO 7110.65 3-7-2 gives no procedure for nose-to-nose traffic | DESIGN |
| G3 | `PULL_ASIDE_MAX_M` 150, `PULL_ASIDE_CLEAR_M` 6, `PULL_ASIDE_LANE_CLEAR_M` 25, `PULL_ASIDE_BRANCH_M` 80 (`ai/headOn.ts`), lane width 12 m (`LANE_WIDTH_M`) | design (the taxiway width itself is AC 150/5300-13B Design Group data) | wingtip clearance: AC 150/5300-13B TDG taxiway wingtip clearance table (Table 4-1 / 4-2 give clearances in feet per ADG); the 6 m is not derived from it | DESIGN (a derivation of `PULL_ASIDE_CLEAR_M` from the ADG wingtip clearance is possible but changes AI behaviour; recorded, not done) |
| G4 | Exit choice weights: `CROSSING_COST_M` 600, `IMMEDIATE_CROSSING_COST_M` 400, `IMMEDIATE_CROSSING_M` 250, `WRONG_SIDE_COST_M` 300, `RUNWAY_OCCUPANCY_COST` 0.5, `OCCUPANCY_GATE_M` 600, `BEYOND_GATE_COST_M` 2,500, `BLOCKED_COST_M` 5,000, `EXIT_STUB_M` 400, `STUB_LANE_M` 35 | design | AC 150/5300-13B 4.? and AC 150/5060-5 describe exit design (rapid exit taxiways at 30 degrees) not the cost an airline attaches to a crossing; none is published | DESIGN |
| G5 | `exitStubs.ts`: `STUB_HEAD_M` 25, `STUB_RESERVE_LEAD_M` 300 (about 45 s of taxi at 13 kt), `LANDER_STUB_NM` 2 | design | none | DESIGN |
| G6 | `turnAround.ts` `APRON_ROOM_M` 60 | design | AC 150/5300-13B turn dimensions (aircraft-specific); not used | DESIGN |
| G7 | `arrivalStand.ts` stand choice rule | design ("no FAA source") | none | DESIGN |
| G8 | `INTERSECTION_PASS_MARGIN_M` 60, `ROLL_START_DELAY_SEC` 2.5, `CROSSING_START_DELAY_SEC` 3, `CROSSING_WINGTIP_M` 10, `GROUND_PROXIMITY_M` 30, `VEHICLE_PROXIMITY_M` 5, `QUEUE_CREEP_KT` 8, `ARRIVAL_CLEAR_MARGIN_SEC` 3, `CROSSING_MARGIN_SEC` 4, `FINAL_LATERAL_M` 900, `TURNED_AWAY_M` 450, `FINAL_TAKEOFF_NM` 2, `FINAL_CROSSING_NM` 3, `FINAL_PROCEED_NM` 8, vehicle runway stay range (`conflicts.ts`) | engine conflict detection | The order's minima (3-9-6 etc.) are already implemented; these are detection margins | DESIGN |

## 6. AI controllers (`src/ai/*`, `src/sim/coordination.ts`)

| Id | Value | Current | What a source would say | Status |
|---|---|---|---|---|
| C1 | Coordination lifetimes (`COORDINATION_DESIGN`): crossing approval 60 s, release 120 s, release renewal 20 s before it lapses (`releaseRenewBeforeSec`), exit request 240 s, open request 240 s, re-ask 30 s, duplicate window 5 s, crossing closed 180 s, point-out 4 nm, release spacing 45 s | `sim/coordination.ts` | Letters of agreement set these locally; JO 7110.65 4-3-4 / 5-4-7 set none | DESIGN (letters of agreement for KACY / KMHT are not public) |
| C2 | `ai/coordination.ts`: `CROSSING_FINAL_NM` 3.5, `FOLLOW_ON_WINDOW_SEC` 150, `EXIT_INFO_NM` 4 | design | none | DESIGN |
| C3 | `DEPARTURE_WAIT_BOUND_SEC` 480 (fairness bound) | `ai/world.ts` | "not an FAA figure"; no published departure-delay tolerance for a non-towered-hub airport | DESIGN |
| C4 | `LANE_PLAN_SPEED_MPS` 6.7, `LANE_WINDOW_MARGIN_SEC` 15, `PUSHBACK_LEAD_IN_M` 70, `AVOID_EXTRA` 100, `MAX_QUEUE` 3, `MIN_SEGMENT_M` 60, `EXIT_AVOID_MIN_ALONG_M` 400 | `ai/world.ts` | none | DESIGN |
| C5 | `GROUND_PATIENCE_SEC`, `STOPPED_PATIENCE_SEC` (Infinity now), `ALT_ROUTE_AFTER_SEC` 300 (180 s and 120 s each gave one departure wait over the 20-minute bar in the eight KACY free-play runs; 300 s keeps all eight under it), `HEAD_ON_LATCH_SEC` 45, `RETREAT_CLEAR_M` 40, `RETREAT_MAX_M` 350, `BUSY_FREQUENCY_PATIENCE_SEC` 20 (`ai/controllers.ts`), `ALT_ROUTE_MAX_FACTOR` 3, `ALT_ROUTE_EXTRA_M` 500, `DELAY_CALL_AFTER_SEC` 180, `DELAY_CALL_EVERY_SEC` 300, `PARTNER_PATIENCE_SEC` 240, `PUSHBACK_LANE_CLEAR_M` 90, `TAXI_FOLLOW_SEC` 60, `TAXI_FOLLOW_M` 300, `HANDOFF_WITHIN_M` 400, `CROSSING_ARRIVAL_SEC` 60, `SEGMENT_LOOKAHEAD_M` 60 | `ai/ground.ts` | none | DESIGN |
| C6 | Tower: `LINE_UP_DELAY_SEC` 20, `RELEASE_MARGIN_SEC` 30, `DEPARTURE_PRIORITY_WAIT_SEC` 90, `CROSSING_PRIORITY_WAIT_SEC` 30, `CROSSING_WINDOW_SEC` 75, `DEPARTURE_CLEAR_M` 1,829 (6,000 ft, the 3-9-6 distance), `DIVERGE_TURN_DEG` 30 (5-8-3 needs 15), `LINEUP_EXTRA_SEC` 90, `LAND_CLEARANCE_NM` 5, `GO_AROUND_NM` 1.0, `GO_AROUND_SEC` 30, `DEP_HANDOFF_AGL_FT` 400, `EXIT_CALL_MAX_KT` 70, `PATTERN_BLOCK_NM` 3.5, `ARRIVAL_RUNWAY_GAP_SEC` 80, `EARLY_GO_AROUND_NM` 4, `EARLY_GAP_NM` 3 / 2, `GO_AROUND_RESEQUENCE_SEC` 600, `CROSSING_WINDOW_NM` 1.3, `CROSSING_WAIT_SEC` 15, `ALERT_PROJECTION_MARGIN_NM` 0.2 | `ai/tower.ts` | the order gives separation minima (implemented as such: 3-9-6 distances, 5-8-3 15 degrees); these are AI scheduling margins | DESIGN (`DIVERGE_TURN_DEG` and `DEPARTURE_CLEAR_M` are order figures plus a margin, already cited in the code) |
| C7 | `TOUCHDOWN_AFTER_THRESHOLD_SEC` 8 (flare and float, about 300 m at approach speed) | `ai/tower.ts` | AC 150/5300-13B Chg 1 exit-location tables assume a touchdown point and speed per approach category; it would give distance, not this time | DESIGN |
| C8 | `SEQ_MARGIN_SEC` 15, runway-window gap, `PATTERN_OFFSET_M` 0.8 nm, `MIN_SPEED_MPS` 50 kt, `EXTEND_LAST_CHANCE_M` 0.35 nm | `ai/sequence.ts` | none | DESIGN |
| C9 | Approach: `JOIN_FIX_PASSED_NM` 2.5 (a fix the aircraft is within 2.5 nm of is not the fix to join the approach at), the visual-approach height test (`tooHighForFaf`: 450 ft/nm + 1,000 ft against the runway end), `ARRIVAL_SPACING_NM` 5, `SLOW_SPEED_KT` 140, `SLOW_FROM_NM` 5, `SLOW_STEPS_KT` 160/140, `MIN_PROJECTED_GAP_NM` 3, `DESCENT_FT_PER_NM` 450 (1,050 fpm at 140 kt), `FAF_HIGH_MARGIN_FT` 1,000, `HOLD_SHORTFALL_NM` 1.5 | `ai/approach.ts` | JO 7110.65 5-7-1 speed adjustment ("do not assign speeds less than ... 5 nm from the runway" style limits) are already cited where used; these are the AI's choices | DESIGN |
| C13 | Departure gap (`ai/gap.ts`, `ai/gapActions.ts`, `sim/coordination.ts`, `sim/towerCommands.ts`): `GAP_REQUEST_WAIT_SEC` 150 (a ready departure that has stood at the hold this long asks), `GAP_USABLE_WITHIN_SEC` 150 (no ask when a window opens inside it), `GAP_HORIZON_SEC` 360, `GAP_PER_EXTRA_DEPARTURE_SEC` 60, `GAP_IFR_MIN_NM` 6 (5-7-1 says 5 nm / the FAF; a mile of margin), `GAP_VFR_MIN_NM` 4 (Tower's `STRAIGHT_IN_TO_PATTERN_MIN_NM`), gap speed (approach speed for light aircraft, +20 kt otherwise), `MIN_SPEED_GAIN_SEC` 15, `GAP_MAX_CIRCLES` 2, `CIRCLE_ROLL_IN_SEC` 6, `CIRCLE_CLEAR_NM` 2.5 / `CIRCLE_CLEAR_FT` 1,500, `GAP_HOLD_DELAY_SEC` 180, `COORDINATION_DESIGN.gapTtlSec` 360 and `gapRetrySec` 120, `SPACING_TURN_MIN_NM` 3, the one-click request after 60 s (`GAP_QUICK_WAIT_SEC`), `OVERDUE_IGNORE_STOPPED_SEC` 480 (= C3) | design | no paragraph words or times a gap request (3-8-1, 3-9-5, 2-1-14, 5-7-1, 5-6-1, 4-3-4 and JO 7210.3 4-3-1 are the grounds: docs/FAA-REFERENCES.md "Departure gap"; P/CG has no GAP entry); the real figures are a letter of agreement's | DESIGN |
| C12 | Sequence (`ai/sequence.ts`, `ai/tower.ts`): `LIGHT_OCCUPANCY_FLOOR_SEC` 140, `SEQ_MARGIN_SEC` 15 (unchanged), `PRIORITY_GO_AROUNDS` 2, `JET_WAIT_PRIORITY_SEC` 300, `JET_CLEAR_WINDOW_SEC` 240, `STRAIGHT_IN_TO_PATTERN_MIN_NM` 4, `DEPARTURE_PRIORITY_WAIT_SEC` 30 (was 90), `PATTERN_FINAL_HEADING_DEG` 40 (`sim/conflicts.ts`) | design | 140 s: the engine's rollout to the far exit of KACY 4/22 (123-137 s) plus a margin; 240 s: the wake minimum F to I on approach (TBL 5-5-4, 4 nm) at 65-70 kt; the rest none | DESIGN |
| C11 | `CORRECTION_PATIENCE_SEC` 5 (`controllers.ts`): a correction of a readback error waits at most this long for a pilot call that is only queued | design | none | DESIGN |
| C10 | `special.ts` `TERMINATE_NM` 8, `HOVER_HOLD_NM` 7, helicopter hover-hold distance 1 nm | `ai/special.ts` | none | DESIGN |

## 7. Traffic generator (`src/game/*`)

| Id | Value | Current | What a source would say | Status |
|---|---|---|---|---|
| T5 | `ARRIVAL_SLOT_BASE_SEC` 130, `ARRIVAL_SLOT_PER_DEPARTURE_SEC` 150 (at most 3 departures), `DEPARTURE_WAIT_FOR_SLOT_SEC` 120: the arrival slot while departures wait at the hold | `game/traffic.ts` | 130 s = the rollout of a light aircraft to the far exit at KACY 4/22; 150 s >= `neededEtaSec` 143 s of a jet behind a light arrival (the engine's numbers; a test asserts it) | DESIGN |
| T1 | `MIN_SPAWN_SPACING_SEC` 45, `ARRIVAL_SLOT_SEC` 200, `MAX_ARRIVALS_IN_FLIGHT` 6, `MAX_DEPARTURES_ON_GROUND` 5 | flow control | FAA AC 150/5060-5 *Airport Capacity and Delay* gives hourly runway capacity by mix and layout; it would bound the rate the free-play density curve may reach, not these slot lengths. The free-play rates (24 + 24 per hour) are a game setting | DESIGN |
| T2 | `NOMINAL_ETA_LIGHT_SEC` 520, `NOMINAL_ETA_JET_SEC` 330, `EXPECTED_SPEED_*`, `NEAR_FIELD_ETA_SEC` 150 | derived from spawn geometry | derived from the engine's own spawn distance and speeds | DESIGN (derived inside the engine) |
| T3 | `IFR_ARRIVAL_SPACING_SEC` 90, `IFR_ARRIVAL_SPACING_NM` 5, `IFR_FEEDER_START_SHARE` 0.25, `IFR_JOIN_CLEAR_NM` 3.5 | IFR spawn | the 3 nm / 5 nm radar minima are JO 7110.65 5-5-4, already used in `conflicts.ts` | DESIGN |
| T6 | Traffic mix and default rates per airport: `defaults.gaFraction` (KBOS 0.019, KPHL 0.032, KPGD 0.802, EGLL 0; KACY and KMHT 0.5 unchanged), `defaults.patternWork` (false at KBOS, KPHL, EGLL), `defaults.peakArrivalsPerHour` / `peakDeparturesPerHour` (KBOS 43, KPHL 33, KPGD 8, EGLL 50), KPGD training `gaShare` 0.30, `PLAYABLE_RATE_CAP` 18 and `rateScaleFor` = min(1, peak / 18) | `game/airportProfile.ts`, `game/trafficDensity.ts` (`peakHourMovements`: annual itinerant / 365 / 13.25 / 2) | **SOURCED inputs:** FAA ATADS calendar year 2025 operations by category (https://www.aspm.faa.gov/opsnet/sys/Airport.asp, retrieved 2026-10-22) and UK CAA UK Airport Data 2025 table 03.1 (Heathrow 479,996 movements), recorded in `data/sources/traffic-volumes.json`; derivation in data/sources/README.md "Traffic volumes and mix". **DESIGN VALUE conversions:** GA share counts itinerant GA only (local operations are the pattern work), air taxi counts as airline, the day shape is the existing diurnal curve, a training flight is about 6 local operations, the playable cap 18 per hour per direction (= the setup screen's Busy) | SOURCED inputs, DESIGN conversions |
| T4 | Special traffic rates (helicopters 2, fighters 2, transitions 4, vehicles 3 per hour at peak, training share 0.4, flights of two 0.5), `SPECIAL_LIMITS`, `TRANSIT_*`, `SPECIAL_SPAWN_CLEAR_NM` 5 | `game/airportProfile.ts`, `specialGenerator.ts` | FAA ATADS / the airport's published operations counts (the 5010 record in NASR carries annual operations by category) could give relative shares for KACY and KMHT; the NASR file in the repository was not re-read for this in this pass | DESIGN (candidate source recorded) |
| T7 | `TDZ_LENGTH_FT` 3,000 (touchdown zone = the first 3,000 ft or first third of the runway, whichever is less), `TDZ_TOLERANCE_M` 150: the landing that cannot touch down in the zone (floating past its end, or too high to reach the ground before it even at the fastest descent the guidance allows, 1.3 x the type's descent rate) is a go-around | `sim/flightDynamics.ts` (`cannotTouchDownInZone`) | 3,000 ft / one third: FAA Pilot/Controller Glossary "Touchdown Zone" (first 3,000 ft; retrieved 2026-10-22, https://www.faa.gov/air_traffic/publications/atpubs/pcg_html/glossary-t.html) and AC 91-79A Chg 1 definition i (TDZ 500-3,000 ft beyond the threshold, not beyond the first third of the runway; https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_91-79A_Chg_1.pdf, retrieved 2026-10-22); the same AC says an unstabilized approach is a go-around. (The task brief cited AIM 4-3-13; that paragraph is Traffic Control Light Signals, checked 2026-10-22.) The 150 m latitude for flare and float is not from a source | zone SOURCED, tolerance DESIGN |

## 8. Scoring, radio and other

| Id | Value | Current | Status |
|---|---|---|---|
| X1 | `SCORE_WEIGHTS`, `ACCEPTABLE_WAIT_SEC` 60, the garbled-call penalty | game design | DESIGN (a scoring scale has no real-world figure) |
| X2 | Realism-level scaling factors 0.5 / 1 / 2 around the measured moderate rate (section 1) | design scaling | DESIGN (labelled) |
| X3 | Voice levels / character (`src/voice/README.md`) | not listened to on a headset | DESIGN (an audio judgement, not a number) |

## 9. Counts and measurements

**Inventory:** 90 entries (rows P1-P30, W1-W8, A1-A13, H1-H4, G1-G8, C1-C10, T1-T7, X1-X3), covering about 200 named constants, fields and rates (several rows group a family of constants that share one source question).

| Outcome | Entries |
|---|---|
| SOURCED and replaced in code | 5 (P1-P5: the readback error rates, FAA DOT/FAA/AM-06/25) |
| Already sourced before this pass (kept, re-listed) | P26 (taxilane 13 kt), A3 (hover taxi 20 kt), A12 (RECAT categories), the cited H65 / F16 figures A1, A5 (second-hand) |
| CROSS-CHECKED, left as design values | 4 (P9, P10 response timing, A10 taxi speeds, W1 gust time constant) |
| DESIGN, search recorded | the rest |

**Behaviour change and measurements** (before = `b8b84fe`, after = this branch; scratch worktree of `b8b84fe` for the "before" runs).

Readback rates per level, settings and measured over 400 seeds per level (altitude / frequency / squawk / no readback, +-1.5 points): see `docs/BEHAVIOUR-ACCURACY.md` R3.

Blocked-transmission protocol (`BLOCKED_RATE=1 BLOCKED_REGIMES=ai,human-twr BLOCKED_FILE=... npx vitest run src/ai/blockedRate.test.ts --testTimeout=3600000`), blocked / pilot calls, three seeds, 2 h each:

| Regime | light before | light after | moderate before | moderate after | heavy before | heavy after |
|---|---|---|---|---|---|---|
| AI on every position | 2 / 1,581 = 0.13 % | 4 / 1,526 = 0.26 % | 14 / 1,356 = 1.03 % | 6 / 1,400 = 0.43 % | 10 / 1,753 = 0.57 % | 14 / 1,572 = 0.89 % |
| Human Tower, AI on the rest | 0 / 1,221 | 0 / 1,127 | 0 / 1,344 | 0 / 1,197 | 2 / 1,036 = 0.19 % | 0 / 1,136 |

Free-play soak (`FREEPLAY_SOAK=1 FREEPLAY_REPORT_FILE=... npx vitest run src/ai/freePlaySoak.test.ts --testTimeout=3600000`; KACY, 10 + 10 per hour, 14 aircraft, 2 h; landings / departures at 2 h / longest single wait; bar 20 min):

| seed | level | before | after |
|---|---|---|---|
| 1 | off | 18 / 24 / 15 min | 18 / 24 / 15 min |
| 2 | off | 17 / 22 / 9 min | 17 / 22 / 9 min |
| 3 | off | 19 / 23 / 9 min | 15 / 23 / 14 min |
| 4 | off | 12 / 26 / 8 min | 14 / 24 / 11 min |
| 1 | moderate | 15 / 27 / 9 min | 15 / 27 / 9 min |
| 2 | moderate | 18 / 22 / 9 min | 16 / 21 / 12 min |
| 3 | moderate | 16 / 17 / 9 min | 19 / 20 / **41 min, test fails** |
| 4 | moderate | 12 / 26 / 8 min | 14 / 24 / 11 min |

("off" in the soak only zeroes the digit rate and the ground rates; the scenario's normal difficulty still applies the other moderate readback errors, which is why that row moves too.)

The seed 3 moderate failure is a departure (NKS1210) that stood at the hold of runway 22 from t = 4064 s to 5971 s while five GA arrivals landed one after another; its departure release (120 s lifetime) expired at t = 5191 s and the next request was made at t = 5931 s. The cause is in the AI Tower's release handling, not in the pilot rates, and it is not new: the same soak on the unchanged baseline, seeds 5-12 at moderate, ends with stalls on 3 of 8 seeds (8, 10, 12: 98, 26 and 103 minutes), the changed code with 3 of 8 (5, 8, 12). The pilot-rate change only moved which seeds meet the pattern. It is recorded as an open item in `docs/PROGRESS.md`; no AI change was made in this pass.

### Release handling and the 24-run soak (second round, 2026-10-19)

Changes: (1) @ai/tower.ts@ asks Departure for the release as soon as the departure is first at the hold (it was asked for only when a takeoff or line-up would have been possible) and renews it when 20 s are left and the departure still waits (@sim/coordination.ts@ @releaseRenewBeforeSec@, @RequestInput.renew@, @CoordRequest.renewalOf@; @validApproval@ looks at every approved release of the aircraft; the takeoff clearance completes any other open release of it; renewals do not count for the 45 s stand-by of the next departure). JO 7110.65 4-3-4 (the release is Departure's, "released"); 3-9-5 / 3-9-6 / 3-10-3 stay in the takeoff clearance. (2) A departure that holds a release gets the next window in the landing sequence at once instead of after 90 s (@depWindows@, pattern traffic only; it changed no soak run). (3) @ai/requests.ts@: no visual approach is cleared to an aircraft that is too high for the runway end (@tooHighForFaf@, 450 ft per nm + 1,000 ft): in seed 12 an A320 cleared for the visual at 5,000 ft 5.7 nm out crossed the threshold at 2,350 ft and touched down 7.6 km along the runway, which stopped the whole airport at t = 943 s. Pilot timing is untouched, so the blocked-transmission protocol was not re-run; its figures above stand. A third attempt (withholding landing clearances for a departure that waited 480 s, as for a crossing) made 22 of 24 runs fail and was removed.

Soak, @FREEPLAY_SOAK=1 FREEPLAY_SEEDS=1,...,12 FREEPLAY_REALISM=off,moderate FREEPLAY_REPORT_FILE=<file> npx vitest run src/ai/freePlaySoak.test.ts --testTimeout=3600000@ (24 runs, KACY, 10 + 10 per hour, 14 aircraft, 2 h). Cell: landings / departures / longest single wait / safety events. Bar: no stall, longest wait under 20 min.

| seed | level | b8b84fe | 0242330 (rates only) | this change |
|---|---|---|---|---|
| 1 | off | 18 / 24 / 15 min / 6 | 18 / 24 / 15 min / 6 | 15 / 25 / 12 min / 20 |
| 2 | off | 17 / 22 / 9 min / 4 | 17 / 22 / 9 min / 4 | 17 / 22 / 9 min / 6 |
| 3 | off | 19 / 23 / 9 min / 14 | 15 / 23 / 14 min / 13 | 18 / 21 / 28 min / 11 **FAIL** |
| 4 | off | 12 / 26 / 8 min / 13 | 14 / 24 / 11 min / 11 | 14 / 23 / 11 min / 12 |
| 5 | off | 17 / 15 / 9 min / 2 | 17 / 15 / 9 min / 2 | 17 / 15 / 8 min / 7 |
| 6 | off | 20 / 22 / 12 min / 9 | 21 / 18 / 12 min / 10 | 20 / 23 / 12 min / 9 |
| 7 | off | 14 / 27 / 10 min / 5 | 14 / 27 / 10 min / 5 | 14 / 28 / 10 min / 7 |
| 8 | off | 18 / 22 / 14 min / 11 | 19 / 21 / 20 min / 11 **FAIL** | 16 / 25 / 8 min / 6 |
| 9 | off | 16 / 24 / 17 min / 7 | 15 / 27 / 17 min / 6 | 16 / 23 / 13 min / 4 |
| 10 | off | 18 / 19 / 13 min / 20 | 19 / 20 / 10 min / 13 | 17 / 22 / 11 min / 12 |
| 11 | off | 14 / 25 / 22 min / 10 **FAIL** | 13 / 26 / 15 min / 9 | 13 / 26 / 11 min / 9 |
| 12 | off | 2 / 1 / 102 min / 142 STALL **FAIL** | 2 / 1 / 102 min / 142 STALL **FAIL** | 14 / 7 / 72 min / 60 STALL **FAIL** |
| 1 | moderate | 15 / 27 / 9 min / 12 | 15 / 27 / 9 min / 12 | 18 / 22 / 16 min / 3 |
| 2 | moderate | 18 / 22 / 9 min / 1 | 16 / 21 / 12 min / 12 | 17 / 23 / 16 min / 16 |
| 3 | moderate | 16 / 17 / 9 min / 5 | 19 / 20 / 41 min / 10 **FAIL** | 15 / 20 / 20 min / 67 **FAIL** |
| 4 | moderate | 12 / 26 / 8 min / 10 | 14 / 24 / 11 min / 15 | 12 / 27 / 8 min / 14 |
| 5 | moderate | 13 / 13 / 14 min / 30 | 13 / 12 / 17 min / 27 STALL **FAIL** | 17 / 12 / 22 min / 9 **FAIL** |
| 6 | moderate | 17 / 18 / 14 min / 21 | 18 / 17 / 14 min / 22 | 19 / 18 / 14 min / 11 |
| 7 | moderate | 15 / 21 / 13 min / 9 | 16 / 21 / 13 min / 9 | 14 / 22 / 12 min / 6 |
| 8 | moderate | 10 / 4 / 98 min / 28 STALL **FAIL** | 10 / 4 / 98 min / 28 STALL **FAIL** | 19 / 16 / 55 min / 13 **FAIL** |
| 9 | moderate | 16 / 23 / 9 min / 10 | 16 / 22 / 9 min / 11 | 16 / 23 / 9 min / 8 |
| 10 | moderate | 16 / 16 / 26 min / 19 **FAIL** | 19 / 18 / 16 min / 7 | 19 / 17 / 9 min / 5 |
| 11 | moderate | 12 / 23 / 12 min / 8 | 14 / 20 / 13 min / 11 | 13 / 24 / 10 min / 6 |
| 12 | moderate | 2 / 1 / 102 min / 143 STALL **FAIL** | 2 / 1 / 102 min / 143 STALL **FAIL** | 15 / 9 / 62 min / 68 **FAIL** |
| total | | 347 / 461 / - / 539; fails 5, stalls 3 | 356 / 455 / - / 539; fails 6, stalls 4 | 385 / 493 / - / 389; fails 6, stalls 1 |

Totals (landings / departures / safety events): b8b84fe 347 / 461 / 539 with 5 failing runs (3 stalls); rates only 356 / 455 / 539, 6 failing (4 stalls); this change 385 / 493 / 389, 6 failing (1 stall). Landings, departures and safety events are all better than b8b84fe's; the bar (24 clean runs) is NOT met, and b8b84fe itself fails 5.

Why the six runs still fail (from the event logs of each run):
* seed 12 off (stall) and seed 12 moderate (62 min): with the long landing gone the airport fills with arrivals standing at the runway exits (8 aircraft in RUNWAY_EXIT, A320 NKS1027 among them) while departures hold at HP4-22-A-2: the exit-stub gridlock between Ground and Tower that PROGRESS "Throughput" lists as open (a lander and a departure on one single-width stub; Ground cannot instruct the one already handed to Tower).
* seed 8 moderate (55 min): NKS1337 got no readback to its RNAV approach clearance (`no_readback`, 3.8 % by the new rate), the clearance was dropped after the 20 s window, and Approach then repeats "proceed direct FLDER" every 30-100 s without ever re-issuing the approach clearance (the aircraft is already at FLDER: "reached the end of its route"); it flies on heading for 56 minutes.
* seed 3 off (28 min) and seed 5 moderate (22 min): a departure that needs no release (a VFR C172 at HP4-22-B-2, 1,491 s in seed 3) holds while landings follow each other with no gap that meets 3-9-5 / 3-9-6 (a GA rollout takes about 130 s, the arrival slot is 200 s); the release fix does not apply.
* seed 3 moderate (20 min, 67 safety events): the same stream plus go-arounds from runway 13 finals against landings on 22.
These are independent faults of the AI controllers (ground gridlock, a lost approach clearance, runway windows), not of the release rule; they are recorded in PROGRESS as open items.

### Third round: AI faults found by the soak (2026-10-19)

Changes: (1) @ai/corrections.ts@ re-issues every instruction kind the AI gives (hold at a fix, STAR, pushback, pattern entry, squawk had no case: a "hold at CARYL as published" without a readback was never repeated) and @ai/controllers.ts@ lets a correction (priority 95 and up) stop waiting for a QUEUED pilot call after 5 s (@CORRECTION_PATIENCE_SEC@): an unrelated pilot request queued up to 48 s kept Approach silent for the whole 23 s window of seed 8's approach clearance. Tests: @ai/approachRecovery.test.ts@ (every unacknowledged Approach instruction repeated within 12 s over 16 seeds with requests queued: 191 s on 1664e31; every arrival established on final over 12 seeds at heavy realism). (2) @ai/approach.ts@: the fix an aircraft is sent direct to in order to join the approach is the next one when it is within 2.5 nm of the nearest ("direct FLDER" completed the route at once and left the aircraft on a heading, repeated for 30-56 minutes). (3) @game/traffic.ts@: the arrival slot is @130 s + 150 s per waiting departure@ (at most three; @arrivalSlotSec@; a departure counts after 120 s ready at the hold) instead of 200 s, derived from the engine's own runway occupancy (a light aircraft rolls to the far exit at KACY 4/22, about 130 s) and @neededEtaSec@ (143 s for a jet behind a light arrival). Cause of the departure starvation (seeds 3, 5, 1): arrivals every 200-300 s, each holding the runway about 130 s and leaving a 20-50 s window in which a takeoff clearance, a 3 % missed call included, had to fit. The Tower's sequence (@sequence.ts@ @depWindows@) already gives every departure at the hold, VFR or IFR, a window after 90 s or at once with a release; it delays only pattern traffic, and the arrivals here are straight-in, so the gap is made upstream at the generator, where Approach would space them.

Tried and removed because the 24 runs got worse: a go-around (2-4 nm) for the arrival that is the gap of a departure waiting 480 s (373 landings / 496 departures / 504 safety events, 6 failures, a stall); withholding landing clearances for it (22 of 24 failed); a heavier runway-occupancy weight in the exit choice while a departure waits (changed no run: the exits the aircraft can make at KACY 4/22 are B at 837 m and A at 1,860 m and the near one is the departure's own hold stub).

Soak, same command as above (24 runs). Cell: landings / departures / longest single wait / safety events.

| seed | level | b8b84fe | 1664e31 | this change |
|---|---|---|---|---|
| 1 | off | 18 / 24 / 15 min / 6 | 15 / 25 / 12 min / 20 | 19 / 20 / 12 min / 11 |
| 2 | off | 17 / 22 / 9 min / 4 | 17 / 22 / 9 min / 6 | 17 / 24 / 9 min / 5 |
| 3 | off | 19 / 23 / 9 min / 14 | 18 / 21 / 28 min / 11 **FAIL** | 12 / 23 / 8 min / 4 |
| 4 | off | 12 / 26 / 8 min / 13 | 14 / 23 / 11 min / 12 | 13 / 24 / 12 min / 16 |
| 5 | off | 17 / 15 / 9 min / 2 | 17 / 15 / 8 min / 7 | 17 / 16 / 8 min / 6 |
| 6 | off | 20 / 22 / 12 min / 9 | 20 / 23 / 12 min / 9 | 21 / 23 / 14 min / 9 |
| 7 | off | 14 / 27 / 10 min / 5 | 14 / 28 / 10 min / 7 | 13 / 28 / 10 min / 8 |
| 8 | off | 18 / 22 / 14 min / 11 | 16 / 25 / 8 min / 6 | 17 / 17 / 14 min / 8 |
| 9 | off | 16 / 24 / 17 min / 7 | 16 / 23 / 13 min / 4 | 15 / 26 / 9 min / 5 |
| 10 | off | 18 / 19 / 13 min / 20 | 17 / 22 / 11 min / 12 | 17 / 22 / 11 min / 11 |
| 11 | off | 14 / 25 / 22 min / 10 **FAIL** | 13 / 26 / 11 min / 9 | 13 / 27 / 11 min / 11 |
| 12 | off | 2 / 1 / 102 min / 142 STALL **FAIL** | 14 / 7 / 72 min / 60 STALL **FAIL** | 15 / 10 / 61 min / 40 **FAIL** |
| 1 | moderate | 15 / 27 / 9 min / 12 | 18 / 22 / 16 min / 3 | 16 / 18 / 16 min / 13 |
| 2 | moderate | 18 / 22 / 9 min / 1 | 17 / 23 / 16 min / 16 | 16 / 23 / 11 min / 6 |
| 3 | moderate | 16 / 17 / 9 min / 5 | 15 / 20 / 20 min / 67 **FAIL** | 15 / 21 / 17 min / 9 |
| 4 | moderate | 12 / 26 / 8 min / 10 | 12 / 27 / 8 min / 14 | 12 / 25 / 12 min / 16 |
| 5 | moderate | 13 / 13 / 14 min / 30 | 17 / 12 / 22 min / 9 **FAIL** | 16 / 18 / 14 min / 6 |
| 6 | moderate | 17 / 18 / 14 min / 21 | 19 / 18 / 14 min / 11 | 18 / 17 / 14 min / 18 |
| 7 | moderate | 15 / 21 / 13 min / 9 | 14 / 22 / 12 min / 6 | 14 / 22 / 12 min / 6 |
| 8 | moderate | 10 / 4 / 98 min / 28 STALL **FAIL** | 19 / 16 / 55 min / 13 **FAIL** | 20 / 22 / 10 min / 6 |
| 9 | moderate | 16 / 23 / 9 min / 10 | 16 / 23 / 9 min / 8 | 14 / 25 / 9 min / 14 |
| 10 | moderate | 16 / 16 / 26 min / 19 **FAIL** | 19 / 17 / 9 min / 5 | 17 / 21 / 8 min / 4 |
| 11 | moderate | 12 / 23 / 12 min / 8 | 13 / 24 / 10 min / 6 | 13 / 26 / 11 min / 3 |
| 12 | moderate | 2 / 1 / 102 min / 143 STALL **FAIL** | 15 / 9 / 62 min / 68 **FAIL** | 13 / 11 / 55 min / 93 **FAIL** |
| total | | 347 / 461 / - / 539; fails 5, stalls 3 | 385 / 493 / - / 389; fails 6, stalls 1 | 373 / 509 / - / 328; fails 2, stalls 0 |

Totals (landings / departures / safety events): b8b84fe 347 / 461 / 539, 5 failing (3 stalls); 1664e31 385 / 493 / 389, 6 failing (1 stall); this change **373 / 509 / 328, 2 failing (0 stalls)**. The bar is NOT met in two respects: seed 12 (off and moderate) still exceeds 20 minutes, and landings are 12 below 1664e31 (departures +16, safety events -61; landings plus departures 882 against 878): the longer slot offers fewer arrivals while a departure waits.

Why seed 12 still fails (both levels, 61 and 55 minutes): the A320 NKS1027 is held in the approach phase flying "direct FLDER" at 1,800 ft and 145-165 kt for 13 to 30 minutes because Approach spaces it behind light GA aircraft at 55-60 kt (an A320 cannot build 5 nm behind a leader at 55 kt by slowing: its minimum is 140 kt), and those leaders are pattern aircraft that keep going around (N98VS 18 times, N479UW 13, N41ZP 12, each go-around for 3-10-3 spacing against a leader that lands in 174 s). No rule of the order puts a jet behind a slow single; the AI has no way to resequence the jet ahead or to vector the GA aircraft out. Open item in PROGRESS with this evidence. The exit-stub gridlock of the first diagnosis (8 aircraft in RUNWAY_EXIT) no longer occurs in any of the 24 runs after the visual-approach height test removed the 7.6 km landing that started it.

### Fourth round: runway-window sequencing (2026-10-19)

Cause found in the logs of seed 12 (the jet held 36 minutes at 1,800 ft; one Cessna 5-7 go-arounds): (1) @committedWindows@ used @projectArrival@, which measures the distance to the threshold along the runway axis only, so an arrival that was not on the extended centreline (the A320 circling in the approach phase) held a window that began "now" for as long as it circled: the pattern aircraft extended downwind behind a phantom, and the jet, held for spacing, never left. (2) The window of a light aircraft assumed the average rollout (109 s) while the aircraft that rolled to the far exit held the runway 123-137 s and the aircraft behind was sent around. (3) The landing check counted a pattern aircraft abeam the runway (lateral under 900 m, heading across or against the runway) as "ahead on the same final, lands now". (4) Apart from a go-around, the Tower had no tool for an aircraft that turned base into traffic. (5) A final of light aircraft 5 nm apart had no hole for a jet that cannot slow below 120-140 kt, and its approach clearance was refused by the engine's own check ("puts it 2.5 nm in trail of N41ZP, established on the same final").

Changes: @arrivalWindow@ (own speed, straight distance off the final), the 140 s floor, the pattern-heading condition in @precedingArrivalBlockers@, a left 360 for spacing on base before any go-around (twice at most, @spacingCircles@), @Aircraft.goAroundCount@ and @priorityArrival@ (an aircraft that has gone around twice is not sent around for spacing: @blockedByLeader@ and @earlyGoAroundReason@ skip it), a departure window after 30 s (was 90), and the jet priority (a light VFR straight-in aircraft within 240 s of the threshold time of a jet that has waited 300 s for its approach clearance is told to enter left downwind: @jetWaitingBehind@). The harness reports the most go-arounds of one aircraft per run (@max per aircraft@ in the soak report).

Tried and removed (24-run totals worse): a go-around for the arrival that is the gap of a departure waiting 480 s; sending every light straight-in aircraft that conflicts with an earlier window to the pattern (stalls, 6 landings in seed 3 moderate); a departure window that begins when the runway is free of committed windows (3 failures, 2 stalls); a per-departure slot of 180 s (367 / 544 / 331, 1 failure) and a jet-extra of 60 s (371 / 524 / 285, 4 failures); a larger sequence margin (45 s, more go-arounds).

Soak, same command as above (24 runs). Cell: landings / departures / longest single wait / safety events.

| seed | level | b8b84fe | 9e926d2 | this change |
|---|---|---|---|---|
| 1 | off | 18 / 24 / 15 min / 6 | 19 / 20 / 12 min / 11 | 18 / 24 / 11 min / 13 |
| 2 | off | 17 / 22 / 9 min / 4 | 17 / 24 / 9 min / 5 | 17 / 24 / 9 min / 5 |
| 3 | off | 19 / 23 / 9 min / 14 | 12 / 23 / 8 min / 4 | 12 / 23 / 8 min / 4 |
| 4 | off | 12 / 26 / 8 min / 13 | 13 / 24 / 12 min / 16 | 13 / 24 / 12 min / 16 |
| 5 | off | 17 / 15 / 9 min / 2 | 17 / 16 / 8 min / 6 | 17 / 16 / 8 min / 6 |
| 6 | off | 20 / 22 / 12 min / 9 | 21 / 23 / 14 min / 9 | 21 / 23 / 14 min / 9 |
| 7 | off | 14 / 27 / 10 min / 5 | 13 / 28 / 10 min / 8 | 13 / 28 / 10 min / 8 |
| 8 | off | 18 / 22 / 14 min / 11 | 17 / 17 / 14 min / 8 | 17 / 17 / 14 min / 8 |
| 9 | off | 16 / 24 / 17 min / 7 | 15 / 26 / 9 min / 5 | 15 / 26 / 9 min / 5 |
| 10 | off | 18 / 19 / 13 min / 20 | 17 / 22 / 11 min / 11 | 17 / 22 / 11 min / 11 |
| 11 | off | 14 / 25 / 22 min / 10 **FAIL** | 13 / 27 / 11 min / 11 | 13 / 27 / 11 min / 11 |
| 12 | off | 2 / 1 / 102 min / 142 STALL **FAIL** | 15 / 10 / 61 min / 40 **FAIL** | 16 / 17 / 25 min / 21 **FAIL** |
| 1 | moderate | 15 / 27 / 9 min / 12 | 16 / 18 / 16 min / 13 | 16 / 18 / 16 min / 13 |
| 2 | moderate | 18 / 22 / 9 min / 1 | 16 / 23 / 11 min / 6 | 16 / 23 / 11 min / 6 |
| 3 | moderate | 16 / 17 / 9 min / 5 | 15 / 21 / 17 min / 9 | 16 / 24 / 17 min / 14 |
| 4 | moderate | 12 / 26 / 8 min / 10 | 12 / 25 / 12 min / 16 | 12 / 25 / 12 min / 16 |
| 5 | moderate | 13 / 13 / 14 min / 30 | 16 / 18 / 14 min / 6 | 16 / 18 / 14 min / 6 |
| 6 | moderate | 17 / 18 / 14 min / 21 | 18 / 17 / 14 min / 18 | 19 / 16 / 14 min / 23 |
| 7 | moderate | 15 / 21 / 13 min / 9 | 14 / 22 / 12 min / 6 | 14 / 22 / 12 min / 6 |
| 8 | moderate | 10 / 4 / 98 min / 28 STALL **FAIL** | 20 / 22 / 10 min / 6 | 20 / 22 / 10 min / 6 |
| 9 | moderate | 16 / 23 / 9 min / 10 | 14 / 25 / 9 min / 14 | 14 / 25 / 9 min / 14 |
| 10 | moderate | 16 / 16 / 26 min / 19 **FAIL** | 17 / 21 / 8 min / 4 | 17 / 21 / 8 min / 4 |
| 11 | moderate | 12 / 23 / 12 min / 8 | 13 / 26 / 11 min / 3 | 13 / 26 / 11 min / 3 |
| 12 | moderate | 2 / 1 / 102 min / 143 STALL **FAIL** | 13 / 11 / 55 min / 93 **FAIL** | 14 / 17 / 19 min / 42 |
| total | | 347 / 461 / - / 539; fails 5, stalls 3 | 373 / 509 / - / 328; fails 2, stalls 0 | 376 / 528 / - / 270; fails 1, stalls 0 |

Totals (landings / departures / safety events): b8b84fe 347 / 461 / 539, 5 failing (3 stalls); 9e926d2 373 / 509 / 328, 2 failing; this change **376 / 528 / 270, 1 failing, 0 stalls**: all three totals better than 9e926d2's. Go-arounds in the 24 runs: 107 before, 58 after; the most by one aircraft in a run: **7 before (N338MX, seed 6 moderate), 4 after (N74ZP, seed 12; N61JY, seed 1)**; four runs have an aircraft with 3 or more in both. The bar is NOT met in two respects: seed 12 off still exceeds 20 minutes (25), and an aircraft still goes around 4 times (the cap of 2 applies to the spacing reasons; the engine's own landing check, a lander still on the runway at 3-10-3, still sends the aircraft around).

Why seed 12 off still fails: the jet no longer holds (NKS1027 is not among its longest waits; the slice test bounds it at 1,500 s, 2,240-2,693 s before). What is left is the departure queue at the hold of runway 22: departures stand 1,000-1,300 s (NKS1189 at the hold 1,018 s, N755NP 1,298 s) because the windows between landers are 20-50 s: a lander rolls to the far exit for 123-137 s and an A320 needs 143 s before the next arrival, 20 s to line up. Every departure waited for 2-3 cycles of 280 s. The arrival slot (130 + 150 s per waiting departure) and the departure window after 30 s do not close that gap in this seed; both were varied (above) without a better result over the 24 runs. Blocked-transmission protocol (AI timing changed): AI controllers 0.37 / 0.13 / 0.76 %, human Tower 0 / 0 / 0.58 %.



### Departure gap round (2026-10-20, task/departure-gap)

What was built: the coordination topic GAP (Tower asks Approach, plain words), `ai/gap.ts` (arrival slots by true ETA, the cheapest gap, delays of the arrivals behind it), `ai/gapActions.ts` (speed, a 360 for a VFR straight-in aircraft, a published hold and a later approach clearance for an IFR arrival), the engine 360 on the way in, the Landline request/answer for a person at either position, and two faults found on the way: a departure that took another aircraft's frequency change ("Spirit six zero three" read back by the wrong pilot) stood ready at the hold on Departure's frequency for 40 minutes (seed 12; Departure now sends a departure on the ground back to Tower or Ground), and a gap request is made with the runway END ("runway 22"), not the runway id.

What a first version got wrong, kept as evidence. The VFR straight-in aircraft of the free-play generator check in with TOWER (frequency 120.3), and the engine refuses an instruction to an aircraft on another frequency ("Not on frequency: N41ZP is on 120.30 (TWR); you are transmitting on 124.60 (APP)"). An Approach that "builds the gap" for them was therefore a no-op: the first soak (378 / 533 / 251) improved by chance. Tried and dropped: the VFR arrivals on the Approach frequency (as the base generator `sim/traffic.ts` does) handed to Tower 6 nm out (362 / 509 / 371, 4 failing, 1 stall, 94 go-arounds: Tower loses its lead time), and starting them 15-17 nm out with the handoff at 10.5 nm (385 / 446 / 326, 8 failing, 3 stalls: more aircraft in flight for longer); a vector to the left downwind instead of the 360 (188 go-arounds with a gap request after 90 s: the pattern is the congested place). Now each position speaks to the aircraft on its own frequency and both read the same plan.

Where the waiting is. Blocked seconds of the first departure at a hold (seeds 1-12, baseline): 42 % a lander still on the runway (rolls out 123-137 s, nothing shortens it), 45 % an arrival window the departure does not fit, 11 % other engine refusals, 2 % the AI's own slack. A gap can only act on the 45 %.

Measured on 48 runs (seeds 1-24, both realism levels; the harness reports `tower waits`: from the first second a departure stands at the hold of its own runway until its takeoff clearance). The baseline is not a fixed number: the same tree with another AI seed (reaction delays) gives 5 failing runs and 108 go-arounds instead of 2 and 72.

| configuration | mean tower wait | runs with a wait over 12 min | failing / stalls | go-arounds | safety events |
|---|---|---|---|---|---|
| cdcd09b (generator slot for waiting departures only) | 180 s | 15 | 2 / 0 | 72 | 465 |
| cdcd09b, AI seed 6 | 190 s | 20 | 5 / 1 | 108 | 574 |
| neither lever (slot extension off, no gap) | 211 s | 21 | 13 / 2 | 195 | 705 |
| gap only (slot extension off) | 184 s | 14 | 5 / 2 | 175 | 674 |
| **this change (both)** | **176 s** | **9** | 5 / 2 | 68 | 477 |

Which lever does the work: the generator's arrival slot for waiting departures (T5, `ARRIVAL_SLOT_BASE_SEC` / `PER_DEPARTURE`) still does most of the work on go-arounds and safety events (175 go-arounds without it); the gap is the second lever and replaces about two thirds of what the slot gives on waits and failures (neither: 211 s, 13 failing; gap only: 184 s, 5 failing), which is what it is for. Both together have the shortest tails. T5 stays.

Soak, same command as above (24 runs). Cell: landings / departures / longest single wait / safety events.

| seed | level | cdcd09b (before) | this change |
|---|---|---|---|
| 1 | off | 18 / 24 / 11 min / 13 | 18 / 22 / 13 min / 15 |
| 2 | off | 17 / 24 / 10 min / 5 | 15 / 23 / 9 min / 8 |
| 3 | off | 12 / 23 / 9 min / 4 | 15 / 25 / 11 min / 7 |
| 4 | off | 13 / 24 / 13 min / 16 | 12 / 25 / 12 min / 15 |
| 5 | off | 17 / 16 / 9 min / 6 | 17 / 17 / 9 min / 6 |
| 6 | off | 21 / 23 / 14 min / 9 | 16 / 27 / 18 min / 21 |
| 7 | off | 13 / 28 / 10 min / 8 | 13 / 28 / 11 min / 8 |
| 8 | off | 17 / 17 / 14 min / 8 | 17 / 18 / 12 min / 8 |
| 9 | off | 15 / 26 / 9 min / 5 | 15 / 26 / 9 min / 6 |
| 10 | off | 17 / 22 / 11 min / 11 | 18 / 22 / 28 min / 11 **FAIL** |
| 11 | off | 13 / 27 / 12 min / 11 | 13 / 26 / 12 min / 13 |
| 12 | off | 16 / 17 / 25 min / 21 **FAIL** | 17 / 20 / 13 min / 8 |
| 1 | moderate | 16 / 18 / 16 min / 13 | 17 / 20 / 13 min / 13 |
| 2 | moderate | 16 / 23 / 12 min / 6 | 16 / 23 / 13 min / 12 |
| 3 | moderate | 16 / 24 / 17 min / 14 | 17 / 22 / 17 min / 16 |
| 4 | moderate | 12 / 25 / 12 min / 16 | 12 / 25 / 12 min / 14 |
| 5 | moderate | 16 / 18 / 15 min / 6 | 17 / 15 / 15 min / 8 |
| 6 | moderate | 19 / 16 / 15 min / 23 | 19 / 16 / 15 min / 20 |
| 7 | moderate | 14 / 22 / 12 min / 6 | 14 / 22 / 12 min / 6 |
| 8 | moderate | 20 / 22 / 10 min / 6 | 19 / 24 / 12 min / 13 |
| 9 | moderate | 14 / 25 / 10 min / 14 | 15 / 23 / 17 min / 14 |
| 10 | moderate | 17 / 21 / 9 min / 4 | 17 / 21 / 9 min / 4 |
| 11 | moderate | 13 / 26 / 11 min / 3 | 13 / 25 / 10 min / 3 |
| 12 | moderate | 14 / 17 / 19 min / 42 | 17 / 11 / 53 min / 10 **FAIL** |
| total | | 376 / 528 / - / 270; fails 1, stalls 0 | 379 / 526 / - / 259; fails 2, stalls 0 |

Totals (landings / departures / safety events): cdcd09b 376 / 528 / 270, 1 failing; this change **379 / 526 / 259, 2 failing, 0 stalls**. Go-arounds 58 before, **36** after; the most by one aircraft 4 before, 3 after. Landings and safety events are better, departures are 2 lower (526 against 528), so the bar "totals not worse" is met except by those 2 departures. The bar "every run under 20 minutes" is NOT met: seed 12 off is closed (25 -> 13 min; the 22-hold departures now wait at most 463 s), but seed 10 off (28 min) and seed 12 moderate (53 min) fail, both ground-lane faults that this change only exposes by moving the timeline (the tower waits of those runs are 7 and 10 minutes): seed 10 off, a GA departure ready at the ramp for 27 minutes while arrivals bound for the same ramp stop on its lane one after another and the hold queue of runway 22 is full (`planDeparture` returns nothing or `opposingTraffic` names a taxiing arrival, in turn); seed 12 moderate, a student pilot on progressive taxi stopped nose to nose with two arrivals on lane L from t = 4,100 s (14 nose-to-nose calls, the pending request is gone, Ground has nothing to answer). Not fixed here.

Blocked-transmission protocol (AI timing changed, `BLOCKED_RATE=1 BLOCKED_REGIMES=ai,human-twr`): AI controllers 0.13 / 0.28 / 0.47 % (light / moderate / heavy; 0.37 / 0.13 / 0.76 % before), human Tower 0 / 0.35 / 0.47 % (0 / 0 / 0.58 % before).


#### Follow-up: the three faults the first version left (2026-10-20)

1. **Seed 12 moderate (53 min).** A student on progressive taxi and two arrivals bound for the ramp stood nose to nose on lane L; the follow-distance rule had stopped them, the head-on state had been cleared and nobody held a request. Two taxiing aircraft that stand still facing each other (closer than 2.5 head-on margins, headings more than 100 degrees apart) for `HEAD_ON_STUCK_SEC` = 30 s are now nose to nose (`sim/traffic.ts`, `rt.headOn.synthetic`): the pilot who must give way calls and calls again every 90 s, AI Ground resolves it with its pull-aside / one-eighty tools. Slice test `src/ai/groundSlices.test.ts`.
2. **Seed 10 off (28 min).** A GA departure ready at the ramp while later departures took every free place at the hold of 22 (the hold queue is 3 deep). A departure past `DEPARTURE_WAIT_BOUND_SEC` (480 s) that can be sent now (a hold with room, nothing opposing) is served before the others (`ground.ts` `overdueFirst`, `outranks`); the wait fell from 27 to 17 minutes. Arrivals are kept off a lane with an overdue departure by the existing `plannedOpposingTraffic`; no new rule for arrivals already on the lane.
3. **Seed 13 special soak (F-16).** A lined-up departure stood on runway 22 for 8 minutes: the sequencer's window for a waiting departure (`beyond6000` + 30 s) was shorter than the `neededEtaSec` of the takeoff clearance, so every aircraft it let turn base was inside the need when it was done and went around (an F-16 and a Cessna five times). The window is now the larger of the two, and a fighter after its break is sequenced like any pattern aircraft (`sequence.isSequenceable`: extend downwind, the 360). `specialSoak.test.ts` is back at seed 13 and passes at 13-18.

Soak, 24 runs after these changes (same command). Cell: landings / departures / longest single wait / safety events.

| seed | level | cdcd09b (before) | this change |
|---|---|---|---|
| 1 | off | 18 / 24 / 11 min / 13 | 18 / 22 / 13 min / 15 |
| 2 | off | 17 / 24 / 10 min / 5 | 15 / 23 / 9 min / 8 |
| 3 | off | 12 / 23 / 9 min / 4 | 15 / 25 / 11 min / 7 |
| 4 | off | 13 / 24 / 13 min / 16 | 12 / 25 / 12 min / 15 |
| 5 | off | 17 / 16 / 9 min / 6 | 17 / 17 / 9 min / 6 |
| 6 | off | 21 / 23 / 14 min / 9 | 16 / 27 / 18 min / 21 |
| 7 | off | 13 / 28 / 10 min / 8 | 13 / 28 / 11 min / 8 |
| 8 | off | 17 / 17 / 14 min / 8 | 17 / 18 / 12 min / 8 |
| 9 | off | 15 / 26 / 9 min / 5 | 15 / 26 / 9 min / 6 |
| 10 | off | 17 / 22 / 11 min / 11 | 17 / 22 / 17 min / 12 |
| 11 | off | 13 / 27 / 12 min / 11 | 13 / 26 / 12 min / 13 |
| 12 | off | 16 / 17 / 25 min / 21 **FAIL** | 17 / 15 / 10 min / 5 |
| 1 | moderate | 16 / 18 / 16 min / 13 | 17 / 20 / 13 min / 13 |
| 2 | moderate | 16 / 23 / 12 min / 6 | 16 / 23 / 13 min / 13 |
| 3 | moderate | 16 / 24 / 17 min / 14 | 17 / 23 / 17 min / 16 |
| 4 | moderate | 12 / 25 / 12 min / 16 | 12 / 25 / 12 min / 14 |
| 5 | moderate | 16 / 18 / 15 min / 6 | 16 / 16 / 15 min / 13 |
| 6 | moderate | 19 / 16 / 15 min / 23 | 19 / 17 / 15 min / 27 |
| 7 | moderate | 14 / 22 / 12 min / 6 | 14 / 22 / 12 min / 6 |
| 8 | moderate | 20 / 22 / 10 min / 6 | 19 / 23 / 14 min / 15 |
| 9 | moderate | 14 / 25 / 10 min / 14 | 15 / 23 / 17 min / 14 |
| 10 | moderate | 17 / 21 / 9 min / 4 | 17 / 21 / 9 min / 4 |
| 11 | moderate | 13 / 26 / 11 min / 3 | 13 / 25 / 12 min / 3 |
| 12 | moderate | 14 / 17 / 19 min / 42 | 16 / 22 / 12 min / 12 |
| total | | 376 / 528 / - / 270; fails 1, stalls 0 | 376 / 534 / - / 274; fails 0, stalls 0 |

Totals: cdcd09b 376 / 528 / 270, 1 failing; now **376 / 534 / 274, 0 failing, 0 stalls**. Landings equal, departures 6 more, safety events 4 more (274 against 270: chance level, the 48-run mean is below the baseline's). Go-arounds **41** against 58, the most by one aircraft **3** against 4. 48 runs (seeds 1-24): mean wait at the hold 179 s (baseline 180 s), runs with a wait over 12 minutes 11 (baseline 15); 3 failing runs, all in seeds 13-24 (16 and 20 moderate: stalls; 24 moderate: 23 min), the unperturbed baseline has 2 and the same tree with another AI seed 5. The blocked-transmission protocol was not re-run (pilot timing is unchanged; the figures of the first round stand).

### Multi-runway round (2026-10-21, task/multirunway-ops)

All of these serve the simulator's near-miss alert (1.5 nm and 500 ft, both aircraft airborne) on parallel runways; the order gives no figure for them.

| Value | Where | Meaning |
|---|---|---|
| `PROJECTION_MARGIN_NM` 0.2, `PROJECTION_MARGIN_FT` 100, `HORIZON_SEC` 240 | `ai/airbornePath.ts` | Margins added to the alert and the length of the departure projection. |
| 30 and 60 degrees | `airbornePath.divergenceOptions` | Departure divergences tried, away from a parallel runway first (5-8-3 needs 15). |
| `DEPENDENT_ALERT_MARGIN_NM` 0.2, `PARALLEL_PROJECTION_MARGIN_NM` 0.6 | `ai/world.ts` | The diagonal kept on adjacent finals is max(5-9-6, 1.5 + 0.2); the projection adds 0.6 nm along the course (flare float of the leader). |
| `NOMINAL_APPROACH_LIGHT_KT` 66, `NOMINAL_APPROACH_JET_KT` 150 | `game/placement.ts` | Mean speeds from 10 nm to the threshold used to project two arrivals at spawn. |
| `LEADER_ETA_FACTOR` 1.1 | `ai/tower.ts` | The leader on the adjacent final slows in the flare. |
| `QUEUE_PENALTY_M` 400 | `ai/world.ts` | One departure queued for a runway costs as much as 400 m (about a minute) of taxiing when Ground chooses the departure runway. |

