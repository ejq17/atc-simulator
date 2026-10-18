# Realism verification (KACY ATC simulator)

Retrieved **2026-10-17**. Scope: check the simulator's behavioural parameters (`src/sim/performance.ts`, `src/sim/README.md`, `src/sim/flightDynamics.ts`, `src/airport/kacy/build-report.md`) against public sources. This document is evidence only: no source code was edited. The recommended numbers are in `data/sources/aircraft-performance.json` (same 22 fields as `AircraftPerformance` plus a `_sources` block per type). Raw downloads are in `data/sources/raw/realism/`. Every fetch used a generic browser User-Agent; no personal identifier was sent.

Verdict vocabulary: **match**, **acceptable simplification**, **should change to X**, **UNVERIFIED** (no primary source retrieved).


> **Amendment (2026-10-17, orchestrator, from the final behaviour-accuracy review):** the wake-category assumption below (A320 as Category D, C172 as I, implying 5–6 NM) was wrong. Under FAA JO 7110.126A Appendix A the A320 is RECAT Category **F** and the C172 Category **I**; the 7110.65 5-5-4 wake table therefore gives 3 NM directly behind and 4 NM on approach for that pair, which the engine now applies (see docs/BEHAVIOUR-ACCURACY.md section 9).

## 0. Summary of discrepancies and recommended changes

| # | Item | Sim value | Source value | Verdict |
|---|---|---|---|---|
| 1 | Runway holding position distance (all four KACY runway ends) | 250 ft from centreline | AC 150/5300-13B Chg 1 Table G-9 (C/D/E-III, the A320 group): 250 ft in every visibility column; +1 ft per 100 ft above sea level (KACY 75 ft: +0) | **match** for 13/31 and 4/22 (see section 4; 4/22 does not need a different distance if the critical aircraft is ADG III) |
| 2 | A320 ground acceleration `accelKtPerSec` | 2.8 kt/s (gives 50 s, 5,900 ft roll to 140 kt) | Airbus chart: ~5,000 ft field length at ~68 t, ~6,000 ft at MTOW; typical roll ~35 s | **should change to ~4.0** (estimate, section 2) |
| 3 | A320 `takeoffDistanceFt` | 6,500 | Airbus AC chart ~4,000 ft (63 t) to ~6,000 ft (73.5 t MTOW); EUROCONTROL 7,185 ft at MTOW | **should change to ~5,000** (typical weight). At 6,500 the runway-length check rejects the A320 on KACY 4/22 (6,145 ft) even from the full length |
| 4 | C172 `maxSpeedKt` | 140 | Vno 129 KIAS, Vne 163 KIAS (EASA TCDS 172S); max cruise 124 ktas | **should change to 129** (minor) |
| 5 | C172 `groundTurnRateDegPerSec` | 40 | POH min turning radius ~27 ft -> 28 deg/s at 8 kt | **should change to 30** (minor) |
| 6 | C172 `climbRateFpm`, `takeoffDistanceFt`, `landingDistanceFt` | 700 / 1,600 / 1,300 | Textron: 730 fpm / 1,630 ft / 1,335 ft | **should change to 730 / 1,630 / 1,335** (trivial, brings them to the published figures) |
| 7 | A320 `climbSpeedKt` | 180 | EUROCONTROL initial climb 175 kt IAS | acceptable (175 recommended) |
| 8 | 3 nm in-trail minimum (all pairs) | 3 nm flat | JO 7110.65BB 5-5-4: 3 mi radar minimum, but wake tables require 5 mi (directly behind) / 6 mi (on approach) for a Category I aircraft behind a Category D aircraft; **the A320 = D assignment is not verified here** | **acceptable simplification** for medium-behind-anything; **should change** to a wake-aware 5-6 nm for a light behind a medium/large jet if realism of C172-behind-A320 matters |
| 9 | Airborne proximity alert 1.5 nm / 500 ft | 1.5 nm and 500 ft | Radar minimum 3 mi (5-5-4) or 1,000 ft vertical (4-5-1) | **acceptable simplification** only if labelled a near-miss / conflict-alert threshold, not the separation minimum |
| 10 | 3 degree glidepath, 50 ft TCH | 3.00 deg / 50 ft | AIM 1-1-9: normally 3 deg. Plates: TCH 13 ILS 58 (PAPI 71), 31 ILS 52 (PAPI 69), RNAV 04 47, RNAV 22 51; NASR TCH 50 / 51 / 71 / 69 | **acceptable simplification** (error 0-8 ft vs plates; 71/69 in NASR are PAPI, not ILS) |
| 11 | Jet speed cap 250 kt below 10,000 ft | 250 kt | 14 CFR 91.117(a) 250 kt; **(b) 200 kt at or below 2,500 ft AGL within 4 nm of a Class C primary airport (KACY is Class C)** | **match**; note (b) if jets are ever assigned speed in the terminal area |
| 12 | Final approach start distance (jets 7 nm, light 4 nm; 8 nm when approach-cleared) | 4-8 nm | ILS 13 FAF MAYBN at I-PVO 4.4 nm, IF/IAF CARYL at 10.5 nm | **acceptable simplification** (the sim "FINAL" begins at the intermediate segment) |
| 13 | Taxi speeds (C172 15/8 kt, A320 20/10 kt) | as left | A320: 30 kt max straight, ~10 kt in turns (secondary source only); C172: no number | **acceptable simplification**, primary source UNVERIFIED |
| 14 | Standard-rate turn 3 deg/s (C172), 2.5 deg/s (A320) | as left | SKYbrary/ICAO: rate one = 3 deg/s; ICAO holding turns "25 deg bank or rate one, whichever is lesser"; 25 deg bank = 2.0-3.4 deg/s at 250-150 kt | **match** / **acceptable** |

Everything else in `performance.ts` is a **match** or **acceptable simplification** (details per type below).

## 1. Cessna 172 (172S Skyhawk)

Sources, in order used:
1. **Textron Aviation, Cessna Skyhawk specifications** (official spec page): https://cessna.txtav.com/en/piston/cessna-skyhawk, retrieved 2026-10-17 (`raw/realism/textron_172.html`).
2. **Cessna Model 172S Information Manual, Rev 5 (19 Jul 2004)** stated on its cover to be "an exact duplicate of the official Pilot's Operating Handbook and FAA approved airplane flight manual" at issuance (a POH reproduction, not the current revision): https://www.befa.org/wp-content/uploads/2019/12/POH-Cessna-172S.pdf (`raw/realism/befa_POH_Cessna_172S.pdf`). A second reproduction (172SP POH, https://www.flygoodyear.com/images/downloads/Cessna%20CE-172SP%20POH.pdf) gives the same 15-knot crosswind.
3. **EASA TCDS IM.A.051 Issue 11 (17 Nov 2025), models 172R/172S**: https://www.easa.europa.eu/es/downloads/7423/en (`raw/realism/easa_tcds_IM.A.051_c172.pdf`). The FAA TCDS 3A12 itself (rgl.faa.gov / drs.faa.gov) was **not retrieved** (the rgl URL I tried returned no response; DRS requires a search session). EASA's sheet validates the same type design.
4. **EUROCONTROL Aircraft Performance Database, C172**: https://learningzone.eurocontrol.int/ilp/customs/ATCPFDB/details.aspx?ICAO=C172 (`raw/realism/eurocontrol_acd_C172.html`). Generic/legacy-172 data (MTOW 1,050 kg), so treated as a cross-check only.

| Parameter | Quoted value (source) | Sim value | Verdict |
|---|---|---|---|
| Rotation | "LIFT NOSE WHEEL (at 55 KIAS)", normal takeoff; short-field lift-off 51 KIAS (POH Sec 4 / Fig 5-5) | 55 | match |
| Best rate climb Vy, sea level | 74 KIAS (72 at 10,000 ft); Vx 62 (POH Sec 4) | `climbSpeedKt` 75 | match (POH normal climb-out 75-85) |
| Best rate climb rate, sea level | 730 fpm (Textron); 710 fpm at 20 C, 785 at 0 C (POH Fig 5-6) | 700 | should change to 730 (trivial) |
| Cruise | max 124 ktas (Textron), 126 kt sea level (POH); economy 109-117 KTAS at 65-75% (POH Fig 5-8) | 110 | acceptable simplification |
| Normal approach | flaps 30: 60-70 KIAS; flaps up: 65-75 KIAS; short field 61 KIAS (POH Sec 4) | 65 | match |
| Stall | flaps up 48 KIAS / 53 KCAS; flaps 30 40 KIAS / 48 KCAS, 2,550 lb power off (POH Fig 5-3; Textron 48 kcas) | `minSpeedKt` 45 | acceptable simplification |
| Touchdown speed | not published; ~1.1-1.15 x 48 KCAS = 53-55 kt (derived) | 55 | acceptable simplification |
| Takeoff roll / over 50 ft | 960 ft / 1,630 ft (Textron; POH Fig 5-5 interpolates to 960/1,632 at 15 C, sea level, 2,550 lb, zero wind) | `takeoffDistanceFt` 1,600; accel 2.8 kt/s gives a 912 ft roll to 55 kt | roll matches within 5%; distance should change to 1,630 |
| Landing roll / over 50 ft | 575 ft / 1,335 ft (Textron; max braking) | `landingDistanceFt` 1,300 | should change to 1,335 (trivial) |
| Max demonstrated crosswind | 15 knots, takeoff or landing, "not a limitation" (POH Sec 4, Fig 5-4) | not modelled | n/a |
| Service ceiling | 14,000 ft (Textron, POH) | 14,000 | match |
| Speed limits | Vno 129, Vne 163, Va 105, Vfe 85 KIAS (EASA TCDS) | `maxSpeedKt` 140 | should change to 129 |
| Length / wingspan | 27 ft 2 in (8.3 m) / 36 ft 1 in (11.00 m) (Textron); EUROCONTROL 8.2 m / 10.9 m | 8.3 | match |
| Wake | ICAO LIGHT (EUROCONTROL: WTC L); FAA same-runway-separation Category I | light | match |
| Ground turning | minimum turning radius ~27 ft (POH Sec 7, ground control; also Sec 1 dimensions note 5: 27 ft 5.5 in pivot point to wing tip) = 28 deg/s at 8 kt | `groundTurnRateDegPerSec` 40 | should change to 30 (minor) |
| Taxi speed | no published figure; POH: "speed and use of brakes be held to a minimum" | 15 / 8 kt | UNVERIFIED, acceptable |

Derived (`a = v^2 / 2d`): 55 kt = 92.8 ft/s over 960 ft gives 4.48 ft/s^2 = **2.66 kt/s** (sim 2.8: fine). Max-braking landing roll of 575 ft from 55 kt implies 4.4 kt/s; the sim's 3.0 kt/s models normal braking to an exit. Glidepath descent at 65 kt is ~345 fpm, so `descentRateFpm` 800 only matters off the glidepath.

## 2. Airbus A320 (A320-200 / CEO)

Sources:
1. **Airbus, A320 Aircraft Characteristics - Airport and Maintenance Planning, Rev 44, Jun 01/24**: https://aircraft.airbus.com/sites/g/files/jlcbta126/files/2024-06/AC_A320_0624.pdf (`raw/realism/airbus_AC_A320_0624.pdf`).
2. **EUROCONTROL Aircraft Performance Database, A320**: https://learningzone.eurocontrol.int/ilp/customs/ATCPFDB/details.aspx?ICAO=A320 (`raw/realism/eurocontrol_acd_A320.html`).
3. **14 CFR 91.117** (eCFR): https://www.ecfr.gov/current/title-14/part-91/section-91.117 (`raw/realism/ecfr_14cfr91_117.json`).
4. SKYbrary A320 page https://skybrary.aero/aircraft/a320 (curl is blocked by a JS challenge; read through the WebFetch summariser, so treated as secondary and matching EUROCONTROL's figures). FAA/EASA A320 TCDS was not retrieved (the Airbus AC covers the dimensions and weights needed).

| Parameter | Quoted value (source) | Sim value | Verdict |
|---|---|---|---|
| Rotation / V2 | V2 145 kt IAS at MTOW 73,900 kg (EUROCONTROL); VR is lower and weight-dependent | rotate 140 | match |
| Initial climb | 175 kt IAS, 2,500 ft/min to 5,000 ft; 290 kt / 2,000 fpm to FL150; 290 kt / 1,400 fpm to FL240 (EUROCONTROL) | climb 180 kt, 2,500 fpm | match (climb speed within 5 kt; 175 recommended) |
| Speed below 10,000 ft | 250 kt IAS max (14 CFR 91.117(a)); 200 kt at/below 2,500 ft AGL within 4 nm of a Class C/D primary airport (91.117(b)) | cap 250 | match; (b) applies around KACY |
| Approach speed | final approach speed 136 kt at MLW 66,000 kg, Aircraft Approach Category C (Airbus AC section 3-5-0); Vat 137 kt (EUROCONTROL) | 135 | match |
| Touchdown speed | not published; Vapp minus ~5 kt (derived) | 130 | acceptable simplification |
| Takeoff distance | EUROCONTROL 2,190 m (7,185 ft) at MTOW. Airbus Fig 3-3-1 (CFM56, ISA, sea level, chart-read +/-300 ft): ~4,000 ft at ~63.5 t, ~5,000 ft at ~68 t, ~6,000 ft at 73.5 t | 6,500 | should change to ~5,000 for a typical sector weight (6,500 is a near-MTOW figure) |
| Takeoff roll/accel | no published ground roll; estimated 3,800-4,100 ft to 140 kt (a = v^2/2d = 4.0-4.35 kt/s, ~35 s) | accel 2.8 kt/s = 50 s, 5,900 ft | should change to ~4.0 (ESTIMATE, labelled as such in the JSON) |
| Landing distance | Airbus Fig 3-4-1 (CFM56, ISA, sea level): landing field length ~4,800 ft at MLW 66 t, defined as actual distance / 0.6, so actual ~2,900 ft; EUROCONTROL 1,440 m (4,724 ft) | 4,500 | match (as a required runway length) |
| Rollout deceleration | not published; ~7 kt/s at max braking implied by the chart (derived) | 4.0 kt/s | acceptable simplification (normal rollout to a high-speed exit) |
| Length / wingspan | 37.57 m; 34.10 m (111.88 ft) without sharklets, 35.80 m with (Airbus AC 2-2-0) | length 37.6 | match |
| Wake category | ICAO MEDIUM (EUROCONTROL WTC M, RECAT-EU Upper Medium), Aircraft Approach Category C | medium / large | match |
| Service ceiling | FL390 (EUROCONTROL; SKYBRARY lists 410) | 39,000 | match |
| Ground turning | minimum turning radius, nose gear 13.4 m at 75 deg steering (Airbus AC 4-3-0) = 22 deg/s at 10 kt (theoretical) | 15 deg/s | acceptable simplification (conservative) |
| Taxi speed | 30 kt max on long straights, ~10 kt for turns of 90 deg or more: **secondary source only** (web-search summary of the Copenhagen 2012 A319 taxiway excursion report, which quotes the operator FCOM/FCTM). Primary Airbus FCOM/FCTM not retrieved | 20 / 10 kt | acceptable simplification; primary source UNVERIFIED |

Airbus AC 3-3-3: aerodrome reference code 3C at MTOW <= 73,500 kg (4C above). FAA airplane design group for the A320 is ADG III (wingspan 79 ft to under 118 ft; 111.9 ft, 114.9 ft with sharklets), which selects the "C/D/E-III" matrix used in section 4.

## 3. Taxi, turns, glidepath, wake and radar separation

**Taxi speeds (15-25 kt straight, 8-10 kt in turns).** See the rows above. Only secondary evidence exists for the A320 (30 kt / 10 kt). No FAA or Cessna figure exists for a C172. The sim's values are inside the plausible range; they are simplifications, not verified numbers.

**Standard-rate turn and airline bank limits.** SKYbrary, "Rate of Turn" (https://skybrary.aero/articles/rate-turn, retrieved 2026-10-17): "a rate one or standard rate turn is accomplished at 3 deg/second"; bank for rate one is approximately TAS/10 + 7 (17 deg at 100 kt, 23 deg at 160 kt, 31 deg at 240 kt); quoted ICAO holding guidance: "all turns in nil wind should be at a bank angle of 25 degrees or Rate One, whichever requires the lesser bank". The 25-30 deg typical airline bank limit is therefore only partly sourced (25 deg ICAO holding guidance); an Airbus-specific figure was not retrieved. Derived: at 25 deg bank the turn rate is 3.4 / 2.8 / 2.0 deg/s at 150 / 180 / 250 kt, so the sim's 2.5 deg/s for the A320 is a reasonable average and 3 deg/s for the C172 is exact rate one (about 17 deg at 100 kt). The sim's roll-in of 6 deg/s^2 (`ROLL_ACCEL_DEG_PER_SEC2`) is a design constant with no source.

**3 degree path and 50 ft TCH.** FAA AIM 1-1-9, https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap1_section_1.html (retrieved 2026-10-17): "The glide path projection angle is normally adjusted to 3 degrees above horizontal", and the published TCH "DOES NOT represent the height of the actual glide path on-course indication above the runway threshold"; "a comfortable wheel crossing height is approximately 20 to 30 feet". AC 150/5300-13B glossary: TCH is "the height of the glidepath above the threshold of the runway". KACY values (`data/sources/kacy-facility.json` NASR, and the d-TPP plates transcribed in `kacy-procedures.json`):

| End | NASR `threshold_crossing_height_ft` (VGSI) | Plate glidepath TCH | Sim | Error vs plate |
|---|---|---|---|---|
| 04 | 50 (PAPI) | RNAV (GPS) 47; VOR descent 3.05 deg TCH 47 | 50 | +3 |
| 22 | 51 (VASI) | RNAV (GPS) 51 | 50 | -1 |
| 13 | 71 (PAPI) | ILS Z 58, RNAV Y 58, RNP 58 (plate: "VGSI 3.00/TCH 71 not coincident") | 50 | -8 |
| 31 | 69 (PAPI) | ILS 31 52, RNAV Y 52, RNP 52 ("VGSI 3.00/TCH 69 not coincident") | 50 | -2 |

Verdict: **acceptable simplification**. If a per-end override is ever added, use the plate glidepath TCH (47 / 51 / 58 / 52), not the NASR VGSI TCH for 13/31, since the sim flies a glidepath, not a PAPI. Final-approach start: the ILS 13 plate puts the FAF at I-PVO 4.4 nm (MAYBN) and IF/IAF at 10.5 nm (CARYL); the sim starts FINAL at 7 nm (jets) / 4 nm (light), or inside 8 nm when approach-cleared, i.e. at the intermediate segment. Acceptable simplification. The 0.5 nm go-around decision point and the ground spacing rule (`1.5 x length + 20 m`) have no regulatory basis in what I retrieved; they are design heuristics. Stabilised-approach criteria were not retrieved.

**FAA JO 7110.65 radar separation (paragraph 5-5-4).** Fetched https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap5_section_5.html with a browser User-Agent on 2026-10-17 (`raw/realism/faa_7110_65_chap5_sec5.html`); the page header reads **7110.65BB**. Paragraph title verified: **"5-5-4. MINIMA"** ("Separate aircraft by the following minima"). Terminal, quoted: "Single Sensor ASR or Digital Terminal Automation System (DTAS)... When less than 40 miles from the antenna- 3 miles. When 40 miles or more from the antenna- 5 miles. For single sensor monopulse secondary surveillance radar (MSSR), when less than 60 miles from the antenna- 3 miles." Also "TERMINAL. FUSION: Fusion target symbol - 3 miles. When displaying ISR in the data block- 5 miles" and "STARS Multi-Sensor Mode - 5 miles". So the sim's 3 nm is the correct figure for the common radar-based terminal case (and 3 nm applies in FUSION), **but 5 miles applies in STARS multi-sensor mode or beyond 40 miles**, and wake minima override. In the same paragraph, "2.5 nautical miles (NM) separation is authorized between aircraft established on the final approach course within 10 NM of the landing runway when operating in FUSION, or single sensor slant range mode if the aircraft remains within 40 miles of the antenna" subject to documented conditions (wake separation per the tables, average runway occupancy of 50 s or less, CTRDs, turnoff points visible from the tower).

Wake separation (same page, terminal, tables as printed there, categories A-I): for the two tables ("Directly Behind", "On Approach") the cell for **leader Category D, follower Category I is 5 NM and 6 NM respectively**; leader D, follower B is 3 NM in both. Which FAA category the A320 and C172 fall in comes from FAA JO 7110.126 / JO 7360.1, which I did not retrieve. From memory of the FAA RECAT scheme the A320 is Category D and a C172 Category I, but that is **UNVERIFIED**. The simulator's ICAO light/medium/heavy `wakeCategory` is a simplification of the A-I scheme. Also: "Consider runways separated by less than 700 feet as a single runway because of the possible effects of wake turbulence."

Same-runway separation concepts the sim uses (3-9-6 departures, 3-10-3 arrivals, https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_9.html and ..._section_10.html, retrieved 2026-10-17): the next departure may not begin takeoff roll until the preceding aircraft "has departed and crossed the runway end or turned to avert any conflict"; where distances can be determined by landmarks the other aircraft needs only be airborne with **3,000 ft** (Category I behind I or II), **4,500 ft** (Category II involved) or **6,000 ft** (either is Category III). The note defines SRS Category I as small single-engine propeller aircraft of 12,500 lb or less (a C172), Category III as "all other aircraft" (an A320). An arrival may not cross the threshold until the preceding aircraft has landed and is clear of the runway (or the same distance minima apply in daylight). Wake-turbulence cautionary advisories are in 2-1-20 and 3-10-3. The sim's "arrival inside 2 nm final blocks takeoff" and "arrival within 3 nm blocks a crossing" are controller-judgment simplifications of these; they are not stated in 7110.65 and stay labelled as simplifications. Topics cited in the sim README (3-9-6, 3-10-3, 3-7-2, 3-9-8) match the paragraph titles seen in the fetched pages for 3-9-6 and 3-10-3; 3-7-2 and 3-9-8 were not re-checked.

Vertical: JO 7110.65 4-5-1 gives **1,000 ft** vertical separation up to FL410 (https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap4_section_5.html). The sim's AIRBORNE_PROXIMITY (< 1.5 nm and < 500 ft) is therefore a near-miss threshold well inside the 3 nm / 1,000 ft minima (acceptable if labelled as such).

## 4. Runway holding position distance

Source: **FAA AC 150/5300-13B, Airport Design, Change 1 (16 Aug 2024; errata 3 Apr 2025 corrected in the PDF; none touches holding positions)**, https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC-150-5300-13B-Airport-Design-Chg1-w-errata.pdf, linked from https://www.faa.gov/airports/resources/advisory_circulars/index.cfm/go/document.current/documentNumber/150_5300-13 (retrieved 2026-10-17; `raw/realism/faa_AC_150_5300_13B_chg1.pdf`, errata `..._errata.pdf`).

Important correction to the brief: the table that gives the runway-to-hold-line distance is no longer in chapter 3. In 13B, paragraph **3.18.1** says "The minimum runway to hold line separation in Appendix G or the online Runway Design Standards Matrix Tool derives from landing and takeoff profiles and physical performance characteristics of the critical aircraft." The values are the **"Holding Position"** row (under "RUNWAY SEPARATION, Runway centerline to:") of the Appendix G matrices, selected by aircraft approach category / airplane design group and approach visibility minimums:

| Matrix | Visual | Not lower than 1 mile | Not lower than 3/4 mile | Lower than 3/4 mile |
|---|---|---|---|---|
| Table G-2, A/B-I (a C172: AAC A, ADG I) | 200 ft | 200 ft | 200 ft | **250 ft** |
| Table G-7, C/D/E-I | 250 ft | 250 ft | 250 ft | 250 ft |
| Table G-8, C/D/E-II | 250 ft | 250 ft | 250 ft | 250 ft |
| **Table G-9, C/D/E-III (an A320: AAC C, ADG III)** | 250 ft | 250 ft | 250 ft | **250 ft** |
| Table G-10, C/D/E-IV | 250 ft | 250 ft | 250 ft | 250 ft |

Footnote 8 (applies to the G-9 holding-position row): "Increase this distance 1 foot (0.3 m) for each 100 feet (30.5 m) above sea level. For C-III aircraft, see footnote 7." Footnote 7: "Increase this distance 1 foot for each 100 feet above 5,100 feet above sea level." So for C-III aircraft the elevation adjustment starts at 5,100 ft; at KACY (75 ft) it is **zero** either way. (Footnote 6, the elevation adjustment of 100 ft and above, applies to taxiway separation, not the hold line.)

Applying to KACY (visibility minimums from `data/sources/kacy-procedures.json`):

| Runway | Lowest published visibility | Matrix column | Critical aircraft ADG III/C (A320) | If the critical aircraft were ADG I (A/B-I) |
|---|---|---|---|---|
| 13 | ILS Z: DA 275, RVR 1800 (below 3/4 mile) | Lower than 3/4 mile | **250 ft** | 250 ft |
| 31 | ILS: DA 264, RVR 4000 (200-3/4, not lower than 3/4 mile) | Not lower than 3/4 mile | **250 ft** | 200 ft |
| 4 | RNAV (GPS) LPV 300-1; LNAV/VNAV 500-1 5/8 (not lower than 3/4 mile) | Not lower than 3/4 mile | **250 ft** | 200 ft |
| 22 | RNAV (GPS) LNAV/VNAV 300-7/8; LPV 300-1 (not lower than 3/4 mile) | Not lower than 3/4 mile | **250 ft** | 200 ft |

**Conclusion.** 250 ft is the applicable standard for every KACY runway end if the runway's critical aircraft is C/D/E-III or larger (it is for a 10,001 ft runway with A320/B737 and military traffic, and the 6,145 ft runway 4/22 is also usable by an A320). The elevation adjustment is zero at 75 ft. Runway 4/22 would use a *shorter* 200 ft only if it were designed solely for ADG I airplanes (e.g. only C172-class), which the sim's A320 traffic contradicts; the sim's A320 is the right design aircraft, so **keep 250 ft (76.2 m) for 4/22 as well**. `build-report.md`'s 250 ft rule: **match**.

Caveats to carry into the airport build: (a) this is the *minimum design standard* from the runway centreline; real hold lines on the KACY diagram may be farther (e.g. conditional/ILS critical-area or POFZ holds, AC 13B figure 3-24 note 1 says "Two holding position lines are necessary" for POFZ vs mandatory holds), and the airport diagram and OSM publish no hold-line coordinates; (b) it is not an elevation- or ADG-specific number for KACY, only the table value for ADG III; (c) the AC is advisory design guidance, not a regulation, except where it is required by the airport's federal funding or approved ALP.

## 5. Items not verified / not attempted

* FAA TCDS 3A12 (rgl.faa.gov / drs.faa.gov): not retrieved; EASA TCDS IM.A.051 used instead.
* Airbus FCOM/FCTM taxi speed (30 / 10 kt) and any Airbus-specific bank limit: secondary sources only.
* A320 ground roll and braking: no published figure; the 4.0 kt/s accel and ~5,000 ft takeoff distance are estimates derived from Airbus chart reads (+/-300 ft). A320 VMO, minimum manoeuvre speed: not retrieved.
* FAA RECAT category assignments for the A320 and C172 (JO 7110.126 / JO 7360.1): not retrieved.
* Stabilised approach / go-around decision point: no source; 7110.65 5-9-1 final-approach intercept rules not retrieved.
* Phraseology/ATIS: out of scope (another agent).
* SKYbrary pages could not be fetched with curl (JS challenge); the A320 page was read via the WebFetch summariser (secondary).
* Textron's spec page is current marketing data (172S G1000 NXi) at max weight, sea level, ISA; the POH reproduction is Rev 5 (2004).

## 6. Files

* `data/sources/aircraft-performance.json` - recommended values and `_sources`.
* `data/sources/raw/realism/` - Textron page, EASA TCDS, 172S POH (two reproductions), EUROCONTROL ACD pages, Airbus AC PDF, FAA 7110.65 chapter pages (2-1, 3-9, 3-10, 4-5, 5-5), AIM 1-1, eCFR 91.117, AC 150/5300-13B Chg 1 PDF + errata + AC landing page.

## 7. Types added for the KMHT traffic profile (B738, BCS3, E175, CRJ9, B752, C208)

Added 2026-10-17 so Manchester-Boston Regional traffic (src/game/airportProfile.ts) looks like the real airport: Southwest (B738), Breeze "Moxy" (A220-300, ICAO BCS3), American Eagle regionals (PSA CRJ-900 "Blue Streak", Piedmont and Republic "Brickyard" E175), United Express (SkyWest E175, GoJet "Lindbergh" CRJ-900), UPS/FedEx B757-200 freighters, Wiggins Cessna 208 Caravan. Airline list from flymanchester.com "Airlines serving MHT" (checked 2026-10-17: Spirit, Delta and Avelo no longer serve MHT).

**Status: ESTIMATE for every number.** The entries were written without network access to the manufacturer documents, from rounded public figures at *typical operating weight* (not maximum weight). They are recorded, with `_sources` blocks citing the documents to check, in `data/sources/aircraft-performance.json`; the engine values in `src/sim/performance.ts` equal that file (a test compares them). None of the cited PDFs was retrieved here, so none of the figures is "verified" in the sense of sections 1-2.

| Type | takeoff ft | landing ft | Vapp kt | Vr kt | ceiling ft | Source to check |
|---|---|---|---|---|---|---|
| B738 | 6,000 | 4,700 | 140 | 145 | 41,000 | Boeing 737 Airplane Characteristics for Airport Planning D6-58325-6; EUROCONTROL ACD B738 |
| BCS3 | 4,900 | 4,300 | 133 | 135 | 41,000 | Airbus A220 Aircraft Characteristics (airport planning); EUROCONTROL ACD BCS3 |
| E175 | 5,000 | 4,000 | 128 | 132 | 41,000 | Embraer 170/175 airport planning manual; EUROCONTROL ACD E75L/E75S |
| CRJ9 | 5,500 | 4,200 | 135 | 138 | 41,000 | Bombardier CRJ700/900 airport planning manual; EUROCONTROL ACD CRJ9 |
| B752 | 6,800 | 5,000 | 140 | 150 | 42,000 | Boeing 757 Airplane Characteristics for Airport Planning D6-58327; EUROCONTROL ACD B752 |
| C208 | 2,300 | 1,900 | 85 | 75 | 25,000 | Textron Caravan / Grand Caravan EX specifications; Cessna 208B POH section 5 |

Conventions (all follow the existing file, not re-verified):

* Cruise speed 250 kt for the jets is the 14 CFR 91.117(a) limit below 10,000 ft, as for the A320; taxi speeds, turn rates and descent rates are the same gameplay simplifications as C172/A320 (section 3).
* SRS category (JO 7110.65 3-9-6): jets 3, C208 1 (single-engine propeller-driven turbine, 8,750 lb MTOW).
* RECAT (JO 7110.126A Appendix A, as used in `wakeRecatCategory`): B738, BCS3, E175, CRJ9 = F; C208 = I; B752 = E, following the file's existing "B757 = E" convention. The 7110.126A listing of the 757 was not re-fetched, so that assignment is **UNVERIFIED** (to check: Appendix A, category of B757).
* Runway fit: KMHT 17/35 is 9,250 ft and 6/24 is 7,651 ft; every added type's `takeoffDistanceFt` is below 7,651, so each can depart from the full length of every end (the generator also checks `runwayLongEnoughFor(type)` per active runway). On KACY's 6,145 ft runway 4/22 the B752 (6,800) and B738 (6,000, marginal) would be refused from an intersection exactly as the A320 is; KACY does not generate them.
* The C208 is category `light`, so it parks on the GA ramp / FBO, uses light-aircraft holding and speed rules, and arrives at 110 kt in IFR flows; the freighters park at the cargo apron (CARGO-N/S) when the airport has one.
* Wiggins' destination (Portland, KPWM) and the Sun Country charter legs are gameplay assumptions, not schedule data.
