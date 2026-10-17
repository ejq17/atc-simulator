# KACY (Atlantic City International, NJ) - verified source data

Retrieved **2026-10-16**. All values below were read from the downloaded official files (raw copies in `raw/`) by script or by reading the FAA chart PDFs. Nothing was filled in from memory. Anything not verifiable is listed in "Not verified" at the bottom and marked `UNVERIFIED` inside the JSON.

**FAA cycle used:** NASR 28-day subscription effective **2026-10-01** (next 2026-10-29). d-TPP cycle **2610**, effective **2026-10-01 0901Z to 2026-10-29 0901Z**, volume NE-2.

## Files

| File | What | Source (URL) | Retrieved | FAA cycle | License |
|---|---|---|---|---|---|
| `kacy-facility.json` | ARP, elevation, mag var, runways, runway ends, tower hours, remarks, Class C flag, owner/manager, ILS summary | NASR CSV zips `https://nfdc.faa.gov/webContent/28DaySub/extra/01_Oct_2026_{APT,ATC,CLS_ARSP,ILS}_CSV.zip` (linked from `https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/2026-10-01/`) | 2026-10-16 | NASR 2026-10-01 | US Government work, public domain (FAA); no restrictions stated on the NASR page. Not for navigation. |
| `kacy-frequencies.json` | Every FRQ.csv row for ACY plus ATIS phone, CTAF remark | `.../01_Oct_2026_FRQ_CSV.zip`, `ATC_CSV.zip` | 2026-10-16 | NASR 2026-10-01 | same |
| `kacy-navaids.json` | ACY VORTAC, ILS/LOC/GS/DME, nearby VOR/VORTACs, 36 fixes with lat/lon | `.../01_Oct_2026_{NAV,ILS,FIX}_CSV.zip`; roles and DAs read from d-TPP plates | 2026-10-16 | NASR 2026-10-01 / d-TPP 2610 | same |
| `kacy-procedures.json` | All KACY d-TPP charts, PDF URLs with HTTP check, approach fixes/minima, DP, hot spot, LAHSO | `https://aeronav.faa.gov/d-tpp/2610/xml_data/d-TPP_Metafile.xml` and `https://aeronav.faa.gov/d-tpp/2610/<pdf>`; page `https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/` | 2026-10-16 | d-TPP 2610 | same |
| `kacy-taxiways.geojson` | OSM aeroway features within 2 km of ARP (144 features) | Overpass API `https://overpass-api.de/api/interpreter` (OSM base timestamp 2026-10-17T01:46:26Z); raw `raw/overpass_kacy_raw.json` | 2026-10-16 | n/a (not FAA) | **ODbL 1.0, (c) OpenStreetMap contributors** - see below |
| `weather-api.md` | AWC METAR/TAF JSON shape, rate guidance, CORS check | `https://aviationweather.gov/api/data/{metar,taf}?ids=KACY&format=json`, `https://aviationweather.gov/data/api/` | 2026-10-16 | n/a | AWC/NOAA public data; follow the usage guidelines in the file |

Provenance of NASR: the per-file CSV zips were downloaded (no full 100 MB+ subscription zip was needed). Raw zips and their extracted CSVs are in `raw/nasr_2026-10-01/` (`x_<NAME>_CSV/`). Source used was NASR (not ADIP / Chart Supplement fallback).

### OSM attribution / license (required if the geometry is shipped)
Contains information from OpenStreetMap, (c) OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0: https://www.openstreetmap.org/copyright. The Overpass response itself states "The data is made available under ODbL." Anything derived from this file and published must carry that attribution and the derived database must stay ODbL (share-alike). The FAA data in the other files is not covered by ODbL; keep the OSM-derived layer separate from the FAA data layers.

## Key facts (all from NASR 2026-10-01 unless noted)

**Airport:** ATLANTIC CITY INTL, FAA ID ACY, ICAO KACY, Atlantic County NJ. ARP **39.45757583 N, 74.57715527 W** (39-27-27.273N, 074-34-37.759W; 3rd-party survey 2024-01-11) - matches the 39.4576, -74.5772 estimate. Field elevation **74.8 ft** (airport diagram prints 75). Mag var **10 deg W, epoch 1965** (diagram: "VAR 10 W, JANUARY 1965, annual rate of change 0.1 W"). ARTCC ZDC. Owner South Jersey Transportation Authority (publicly owned); airport manager Tim Kroll, operations manager Leon Cori, 609-645-7895. FAR 139 class "I C". Class C surface area (CLS_ARSP). ATCT-TRACON, FAA-operated, **24 hours** (TWR_HRS 24, approach/departure 24 h, ATIS 24 h). Beacon SS-SR, white/green. Arresting gear BAK-14/12B at both ends of 13/31 (Air National Guard / military ramps; remarks mention F-16 wing-tip clearance lines).

### Runways
| Runway | Length x width (ft) | Surface | End | True hdg | Charted mag hdg | Threshold lat, lon | Thr elev / TDZE (ft) | Approach lights | ILS | Displaced thr |
|---|---|---|---|---|---|---|---|---|---|---|
| 04/22 | 6145 x 150 | ASPH-CONC, grooved, good, HIRL | 04 | 28 | 038 | 39.44973666, -74.58516197 | 61.3 / 68.4 | none | none (RNAV GPS, VOR) | none recorded |
| | | | 22 | 208 | 218 | 39.46463163, -74.574946 | 67.1 / 67.6 | none | none (RNAV GPS) | none recorded |
| 13/31 | 10001 x 150 | ASPH, grooved, good, HIRL | 13 | 118 | 128 | 39.46426008, -74.5910113 | 74.8 / 74.8 | MALSR, TDZ + CL lights | ILS/DME, I-PVO 109.1, CAT I | none recorded |
| | | | 31 | 298 | 308 | 39.45137069, -74.55973902 | 63.1 / 63.4 | none (REIL) | ILS/DME, I-ACY 109.1, CAT I | none recorded |
| H1 | 102 x 102 | ASPH | H1 | - | - | 39.46483611, -74.565925 | 56 | - | - | - |

H1 is a private "experimental use only" helipad (NASR remark: "PVT - EXPERIMENTAL USE ONLY. CTC FAA TECH CENTER AT 609-485-6675"). LAHSO (NASR and NE2LAHSO.PDF agree): to land 04 hold short of 13-31 with 3550 ft; land 13 hold short of 04-22 with 3600 ft; land 31 hold short of 04-22 with 5750 ft. VGSI: 04 PAPI(4L), 22 VASI(4L), 13 and 31 PAPI(4L) (NASR codes P4L/V4L). Pavement: 04/22 PCR 480 R/B/W/T; 13/31 PCR 601 F/A/X/T.

### Frequencies (MHz; VHF / UHF)
| Function | VHF | UHF | Notes |
|---|---|---|---|
| ATIS | 125.725 | 316.15 | 24 h, phone 609-485-4444 |
| Clearance delivery | 127.85 | 353.775 | printed on airport diagram as CLNC DEL |
| Ground | 121.9 | 284.6 | |
| Tower (local) | 120.3 | 239.0 | CTAF 120.3 during ATC zero events |
| Approach/departure SOUTH (bearings 130-309) | 124.6 | 327.125 | "ATLANTIC CITY APP CON" on plates; "ACY SOUTH DEP CON" on DP chart; Class C |
| Approach/departure NORTH (bearings 310-129) | 134.25 | 292.2 | "ACY NORTH DEP CON"; Class C |
| FAA ops / ANG ops | 123.4 / 140.7 | - | not ATC |
| Emergency | 121.5 | 243.0 | |
| UNICOM | UNVERIFIED | | not in NASR CSV |

### Navaids
ACY VORTAC 117.15 / chan 118Y, 39.4558748 N, 74.57631472 W (about 664 ft SSE of ARP, computed), mag var 10W (1970), **status OPERATIONAL RESTRICTED** (VOR/DME/TACAN unusable sectors listed in kacy-navaids.json). Localizers: rwy 13 I-PVO 109.1 (course 128 mag, GS 3.00, 331.4), rwy 31 I-ACY 109.1 (course 308, GS 3.00, 331.4), both DME chan 28X. **No ILS/LOC on 04/22.** Plate decision altitudes: ILS Z 13 DA 275 (HAT 200, RVR 1800); ILS 31 DA 264 (HAT 200, RVR 4000). Key fixes (NASR coords in the JSON): CARYL, MAYBN (13); STEVV, PRSTY (31); SMITS (missed-approach hold, ACY R-090 / 11 DME); VCN (Cedar Lake), SIE (Sea Isle), CYN (Coyle) VORs.

### Procedures
13 instrument approach charts + airport diagram + 1 DP (list and URLs in `kacy-procedures.json`): ILS Z/LOC Z 13, HI-ILS Y/LOC Y 13, ILS/LOC-DME 31, COPTER ILS/LOC-DME 13, RNAV(GPS) Y 13/Y 31/4/22, RNAV(RNP) Z 13/Z 31 (authorization required), VOR 4, VOR 31, HI-VOR or TACAN 31. DP: ATLANTIC CITY THREE (radar vectors; runway heading then vectors, 2000 ft). No STARs, no SIDs. All 19 PDF URLs returned HTTP 200 `application/pdf` (HEAD and GET).

### Hot spots / LAHSO (from the d-TPP)
HS 1 (only one): NE2HOTSPOT.PDF text "Rwy 13-31 at Twy A and Rwy 04-22 at Twy B." The diagram shows HS 1 as a brown ellipse over the runway 04-22 / 13-31 intersection. Diagram caution: "BE ALERT TO RUNWAY CROSSING CLEARANCES. READBACK OF ALL RUNWAY HOLDING INSTRUCTIONS IS REQUIRED."

## Taxiway comparison: OSM vs the FAA airport diagram (00669AD.PDF, cycle 2610)

Diagram labels read with `pdftotext -bbox` and confirmed visually on a render (`raw/dtpp_2610_txt/AD-1.png`): taxiways **A, B, C, D, G, H, J, K, L, M, N, P**.
OSM taxiway `ref` values (90 taxiway ways: 24 with a ref, 66 with no ref): **A, B, C, D, H, I, J, K, L, M, N, P**.

- In both: A, B, C, D, H, J, K, L, M, N, P (11 of 12 diagram labels).
- On the diagram but **absent from OSM refs: G** (the diagram label sits by the ANG ramp southeast of the 04 end, estimated at about 39.4488 N, 74.5833 W from the diagram graticule; OSM has unlabelled taxiway ways near that spot, nearest ~130 ft, but none tagged `ref=G`).
- In OSM but **not on the diagram: I** (one way, ~2100 ft, southwest of runway 13-31 near the 31 end). FAA taxiway naming does not use I, so this is most likely a mis-tag of another taxiway or an unnamed taxiway; treat as untrustworthy.
- Taxiway segments are split unevenly in OSM (e.g. L has 6 ways, M 5, N 3, P 2; A, B, C, D are one way each, so A/B/C/D geometry is probably merged/simplified). 66 taxiway ways have no ref at all, so ref-based lookups will leave large parts of the surface unnamed. No `holding_position` features exist in OSM for ACY (0 found), so hold-short lines must be derived by the app, not taken from OSM.
- Other OSM feature counts: 2 runways (04/22, 13/31, endpoints agree with NASR thresholds within ~22 ft at 04 and ~1 ft at the other three), 3 apron ways + 1 multipolygon apron, 16 parking_position ways (refs 1-10 on 10 of them), 10 gate nodes, 2 terminal buildings, 13 hangars, 6 helipads (4 tagged USCG), 1 aerodrome polygon.
- OSM runway tags `heading=040;220` and `130;310` are rounded and do not match the charted magnetic 038/218/128/308; `ele` values (64 ft, 69 ft; aerodrome node ele "19") do not match NASR (74.8 ft field, ~61-75 ft at the thresholds). Do not use OSM tags for headings or elevations.

## Conflicts and surprises between sources
1. **Runway 31 TDZE:** ILS 31, VOR 31 and HI-VOR 31 plates print TDZE 64; RNAV (GPS) Y 31 and RNAV (RNP) Z 31 print 63; NASR TDZ_ELEV for 31 is 63.4 (63.1 at the threshold). Same runway, plates disagree by 1 ft.
2. **ILS exists on BOTH 13 and 31** (13: I-PVO MALSR; 31: I-ACY no approach lights), not just one runway. Both localizers are 109.1 MHz (interlocked), glideslopes both 331.4. 04/22 have no ILS/LOC.
3. **Mag var is stale:** 10 W with a 1965 epoch in NASR (airport), 1970 (VORTAC), and on the diagram. The d-TPP magnetic headings (038/218/128/308) are true+10. Current 2026 declination was not looked up (UNVERIFIED).
4. **ACY VORTAC status is "OPERATIONAL RESTRICTED"** (VOR unusable in several sectors; DME/TACAN unusable 270-290 beyond 10 NM and 305-340 beyond 20 NM below 1900 ft). Several VOR approaches rely on it.
5. **134.25/292.2 (north sector) does not appear on the standard (non-"HI") approach plates**, which print only "ATLANTIC CITY APP CON 124.6 327.125". It does appear on the DP chart and HI plates.
6. NASR lists 239.0 both as tower (LCL/P) and as secondary approach (APCH/S); CD/P and other rows in FRQ.csv with serviced facility 26N/WWD are other airports served by the ACY TRACON.
7. **Hot spot text** reads "Rwy 13-31 at Twy A and Rwy 04-22 at Twy B" (as published); the wording pairs each runway with a taxiway in a way that looks swapped relative to the geometry, so use the diagram ellipse location rather than the sentence.
8. **ATLANTIC CITY THREE** is a DP that is only runway-heading-then-vectors; it is not a SID with fixes.
9. NASR: no displaced thresholds exist (all DISPLACED_THR fields blank); NASR also records no UNICOM, no TPA.
10. OSM aerodrome/AWC elevations differ from NASR: AWC METAR station `elev` 18, lat/lon 39.452, -74.567 (station location, not ARP); OSM aerodrome `ele` 19.
11. d-TPP metadata `amdtdate` is blank for several charts; the amendment printed on each plate is recorded in `kacy-procedures.json` as `printed_amendment_on_plate`. High-altitude plates carry "[USAF]" and ident "KACY" instead of "ACY".

## Not verified (do not treat as fact)
- Current (2026) magnetic declination at KACY.
- Class C airspace dimensions (shelf altitudes/radii): only the fact that KACY is Class C is in NASR CSV; shape files (`class_airspace_shape_files.zip`) not downloaded.
- UNICOM frequency; traffic pattern altitude (blank in NASR); Chart Supplement text not consulted (NASR CSV used instead; remarks could differ slightly from the printed Chart Supplement).
- Meaning of the approach/departure sector bearings (130-309 / 310-129) - given exactly as NASR states; the reference point/direction convention is not defined in the CSV. Real sector-splitting practice and any LOA procedures are out of scope.
- Procedure details transcribed visually from the PDFs: IAF/IF/FAF/MAP roles, DA/MDA/RVR values, missed approaches, holding. They were read carefully from rendered pages but they are a human transcription (flagged in each record). In particular: the VDP/MAP interpretation of the "ACY 1.9" (VOR 31) and "ACY 1.7" (VOR 4) profile markers, the A-B / C-D / E column spans on the LNAV rows of the RNAV charts, and the exact MAP for ILS/LOC approaches (DA on the glideslope; LOC MAP DME not stated).
- Fix roles on the HI-altitude (USAF) plates were read at lower confidence.
- AWC: see `weather-api.md` "Not verified".
- OSM: positional accuracy not assessed beyond the runway endpoints; completeness of taxiway/apron/parking data unknown (this extract is a snapshot at 2026-10-17T01:46Z).
- Nothing about airline gate/stand assignments, ramp control or non-movement-area rules was researched.

## Raw files (`raw/`)
`nasr_index.html`, `nasr_2026-10-01.html` (cycle pages); `nasr_2026-10-01/*.zip` + `x_*/` (NASR CSVs; the SHA-256 of each zip can be recomputed); `d-TPP_Metafile_2610.xml` (15 MB), `kacy_dtpp_records_2610.json` (KACY extract), `dtpp_2610_pdfs/` (19 PDFs), `dtpp_2610_txt/` (pdftotext output, bbox of the diagram, rendered PNGs of the diagram and 13 plates), `dtpp_http_checks.tsv`, `dtpp_http_head_checks.txt`; `overpass_kacy_raw.json`; `awc_*` files.

Query used for OSM (radius 2000 m around the NASR ARP): `[out:json][timeout:90]; nwr["aeroway"~"^(runway|taxiway|apron|parking_position|holding_position|helipad|terminal|gate|taxilane|aerodrome|hangar|stopway|navigationaid|windsock)$"](around:2000,39.45757583,-74.57715527); out geom;`
Note: Overpass returned HTTP 406 until a User-Agent and Accept header were sent.
