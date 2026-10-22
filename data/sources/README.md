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
9. NASR: no displaced thresholds exist at KACY (all DISPLACED_THR fields blank); NASR also records no UNICOM, no TPA (the AIM 4-3-3 pattern altitude defaults apply, `Airport.trafficPatternAltitudeFt` is undefined).
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

---

# KMHT (Manchester-Boston Regional, NH) - verified source data

Built the same way as KACY, by `scripts/extract-nasr-airport.ts MHT KMHT` (NASR rows), `scripts/osm-overpass-to-geojson.ts` (OSM) and a plate transcription, then `npx tsx scripts/build-airport.ts KMHT`. Nothing was typed from memory; every value below was read from the downloaded files. The NASR CSV zips are the 2026-10-01 cycle files fetched on 2026-10-16 (shared with KACY, `raw/nasr_2026-10-01/`); the MHT rows were extracted, the OSM data fetched and the d-TPP charts checked on **2026-10-17**.

**FAA cycle:** NASR 28-day subscription effective **2026-10-01** (next 2026-10-29); d-TPP cycle **2610** (2026-10-01 0901Z to 2026-10-29 0901Z), volume **NE-1**.

## Files

| File | What | Source (URL) | Retrieved | FAA cycle | License |
|---|---|---|---|---|---|
| `kacy-plate-geometry.json` | Same as `kmht-plate-geometry.json` for the 13 KACY IAPs; the two USAF plates without a text layer (HI-ILS Y 13, HI-VOR or TACAN 31) were rendered and read visually | `public/charts/KACY/` (URLs in `kacy-procedures.json`) | 2026-10-18 | d-TPP 2610 | US Government work, public domain (FAA). Not for navigation. |
| `kmht-facility.json` | ARP, elevation, mag var, runways and runway ends (thresholds, displaced thresholds, TDZE, lighting, VGSI, declared distances), tower hours, remarks, Class C flag, ownership, ILS summary, arresting system | NASR CSV zips `https://nfdc.faa.gov/webContent/28DaySub/extra/01_Oct_2026_{APT,ATC,CLS_ARSP,ILS}_CSV.zip` (page `https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/2026-10-01/`); charted magnetic headings from the airport diagram | 2026-10-17 (zips 2026-10-16) | NASR 2026-10-01 | US Government work, public domain (FAA). Not for navigation. |
| `kmht-frequencies.json` | Every FRQ.csv row for MHT (tower, ground, clearance, ATIS, UNICOM, emergency, Boston TRACON approach/departure and Class C area frequencies), ATIS phone, radio calls, ATC remarks | `.../01_Oct_2026_FRQ_CSV.zip`, `ATC_CSV.zip` | 2026-10-17 | NASR 2026-10-01 | same |
| `kmht-navaids.json` | MHT DME, CON and GDM VOR/DMEs, ILS/LOC/GS/DME/marker components for runways 6, 17, 35, 41 fixes with lat/lon (26 on the approach plates, 15 more on the ROZZE TWO arrival) and the NASR charting list, fix roles from the plates | `.../01_Oct_2026_{NAV,ILS,FIX}_CSV.zip`; roles and minima read from the d-TPP plates | 2026-10-17 | NASR 2026-10-01 / d-TPP 2610 | same |
| `kmht-plate-geometry.json` | Per approach: glidepath / GS / VDA angle and TCH and the missed approach climb altitudes (initial climb, final altitude, plate text) for all 11 KMHT IAPs, structured form of figures read from the d-TPP 2610 plates | pdfjs-dist text extraction of the plate PDFs in `public/charts/KMHT/` (the URLs in `kmht-procedures.json`) | 2026-10-18 | d-TPP 2610 | US Government work, public domain (FAA). Not for navigation. |
| `kmht-procedures.json` | All 18 KMHT d-TPP PDFs (diagram, 11 IAPs, 2 DPs, 2 STAR pages, takeoff and alternate minimums pages) with URL, HTTP check and size; transcription of 7 approaches (fixes and roles, minima, missed approach), the diagram's taxiway identifiers and charted runway headings, the DPs, and the **ROZZE TWO arrival** (`stars[0].star`: five transitions, four runway legs, altitude / speed restrictions, legs with distance and track, the chart notes; see "ROZZE TWO ARRIVAL" below) | `https://aeronav.faa.gov/d-tpp/2610/xml_data/d-TPP_Metafile.xml` and `https://aeronav.faa.gov/d-tpp/2610/<pdf>`; page `https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/` | 2026-10-17 | d-TPP 2610 | same |
| `kmht-taxiways.geojson` | OSM aeroway features within 2 km of the ARP (226 features: 76 taxiways, 14 gates, 63 parking_position nodes, 13 aprons, 26 holding_position nodes, ...) | Overpass API `https://overpass-api.de/api/interpreter` (OSM base timestamp 2026-10-17T20:44:11Z); raw `raw/overpass_kmht_raw.json`; converted by `scripts/osm-overpass-to-geojson.ts` | 2026-10-17 | n/a (not FAA) | **ODbL 1.0, (c) OpenStreetMap contributors**: same terms as the KACY layer above (attribution required; the derived taxiway/apron dataset is share-alike; keep it separate from the FAA layers) |

Query used for OSM (radius 2000 m around the NASR ARP): `[out:json][timeout:90]; nwr["aeroway"~"^(runway|taxiway|apron|parking_position|holding_position|helipad|terminal|gate|taxilane|aerodrome|hangar|stopway|navigationaid|windsock)$"](around:2000,42.93280555,-71.43575); out geom;` (sent with a User-Agent and `Accept: application/json`).

PDF check: every URL got an HTTP HEAD (200, `application/pdf`, Content-Length) and a GET; each file starts with `%PDF` and has the HEAD size. Table: `raw/kmht_dtpp_http_head_checks.tsv` (18 rows, UTC times). The d-TPP metadata XML is saved as `raw/d-TPP_Metafile_2610.xml`.

## Key facts (NASR 2026-10-01 unless noted)

**Airport:** MANCHESTER BOSTON RGNL, FAA ID MHT, ICAO KMHT, Hillsborough County NH, publicly owned (City of Manchester). ARP **42.93280555 N, 71.43575 W** (42-55-58.1N, 071-26-8.7W; third-party survey 2014-03-12). Field elevation **266.4 ft**. Mag var **15 W, epoch 2020** (diagram: "VAR 15 W, JANUARY 2020, annual rate of change 0.1 E"). ARTCC ZBW. FAR 139 class "I C". **ATCT, FAA-operated, 24 hours** (TWR_HRS 24); ATIS 24 h, phone 603-626-6902. **Class C** (CLS_ARSP). Approach/departure control is the **Boston Consolidated TRACON (A90)**, radio call "BOSTON"; the tower radio call is "MANCHESTER". Beacon SS-SR, white/green; PCR 700 F/C/X/T on both runways; EMAS 300 x 170 ft at the departure end of runway 6 (NASR arresting-system remark).

### Runways
| Runway | Length x width (ft) | Surface | End | True hdg | Charted mag hdg (diagram) | Threshold (pavement end) lat, lon | Thr elev / TDZE (ft) | Displaced thr | Approach lights | ILS |
|---|---|---|---|---|---|---|---|---|---|---|
| 06/24 | 7651 x 150 | ASPH, grooved, fair, HIRL | 06 | 42 | 057 | 42.92829138, -71.44906066 | 220.9 / 223.7 | 442 ft | none (REIL) | ILS, I-MJE 109.95, CAT I |
| | | | 24 | 222 | 237 | 42.94378619, -71.42978836 | 241.5 / 241.5 | none | none (REIL) | none (RNAV GPS only) |
| 17/35 | 9250 x 150 | ASPH, grooved, fair, HIRL | 17 | 157 | 172 | 42.94176577, -71.43956863 | 216.1 / 229.1 | 336 ft | MALSR, TDZ + CL lights | ILS/DME, I-MNA 109.1, CAT I |
| | | | 35 | 337 | 352 | 42.91848847, -71.42581063 | 266.4 / 265.4 | 850 ft | ALSF-2, TDZ + CL lights | ILS/DME, I-MHT 109.1, CAT III |

NASR RWY_END_LAT/LONG is the pavement end; the displaced thresholds (NASR DISPLACED_THR_*: 06 442 ft, 17 336 ft, 35 850 ft) are modelled by the simulator since 2026-10-18 (landing threshold = pavement end + displacement; takeoff, rollout and occupancy use the full pavement; LDA / TORA are the declared distances; a measurement test checks the three landing thresholds against the NASR displaced lat/lon within 5 m). Declared distances (TORA/TODA/ASDA/LDA ft): 06 7650/7650/7650/7208, 24 7650/7650/6850/6850, 17 9250/9250/9250/8914, 35 9250/9250/8500/7650. VGSI: 06 and 24 P4L, 17 P4R, 35 P4L. No LAHSO (no NASR LAHSO fields for any end; no LAHSO page in the d-TPP metadata).

### Frequencies (MHz; UHF where stated)
| Function | VHF | Notes |
|---|---|---|
| ATIS | 119.55 | 24 h; phone 603-626-6902 (the MHT ASOS shares 119.55) |
| Clearance delivery | 135.9 | FRQ CD/P; printed on the diagram as CLNC DEL |
| Ground | 121.9 | FRQ GND/P |
| Tower | 121.3 (UHF 239.025) | FRQ LCL/P; "MANCHESTER TOWER" |
| Approach / departure | 124.9 (UHF 269.075) | Boston Consolidated TRACON (A90), "BOSTON APP CON" / "BOS DEP CON"; no sector bearings are published |
| Class C area frequencies | 124.9 (Manchester/Concord area), 125.05 (NH Seacoast), 134.75 (NH Lakes Region) | FRQ CLASS C rows, named by area; listed in the dataset as non-position ("OTHER") frequencies |
| UNICOM | 122.95 | FRQ row UNICOM |
| Emergency | 121.5 / 243.0 | |

### Navaids
There is **no VOR or VORTAC at MHT**: the airport's own navaid is the MHT DME (114.4 MHz, channel 91X, OPERATIONAL IFR, 42.86852991 N 71.3695345 W, about 4.8 NM from the ARP on true bearing about 143, computed). The plates use CONCORD CON VOR/DME 112.9 (76X, OPERATIONAL RESTRICTED) and GARDNER GDM VOR/DME 116.95 (116Y). ILS: runway 6 I-MJE 109.95 (course 057.42 mag, GS 3.00, 333.65, no DME), runway 17 I-MNA 109.1 (171.52, GS 3.10, 331.4, DME 28X), runway 35 I-MHT 109.1 (351.53, GS 3.00, 331.4, DME 28X, inner and middle marker). 41 fixes with NASR coordinates, 26 of them from the plates (PELAN, YOULL, MNTIN, XOHWI, SHOWZ, IHOBB, ELEEE, BLUUM, ORDIE, SITLE, BLSSM, LYLAC, PURBL, TEETO, PROES, JAAZZ, FITZY, KHRIS, FOSAN, HAKAM, CUXOV, PUTRE, FABIG, WAVBO, ONGEE, MANCH) and 15 from the ROZZE TWO arrival (PONCT, WOBLY, QUINZ, SMYTH, LUCIC, FLYZZ, FYSHR, ROZZE, MUCOW, FFATY, CRIBB, MONRC, NUUKM, PNARD, JSTNN); NASR FIX_CHRT lists every one of them as charted on an IAP or the STAR.

### Procedures
11 instrument approach charts: ILS or LOC 06 / 17 / 35, ILS 35 (SA CAT I), ILS 35 (CAT II and III), RNAV (GPS) 06 / 24 / Y 17 / Y 35, RNAV (RNP) Z 17 / Z 35. Departures: MANCHESTER ONE (radar vectors; "Maintain 3000"; turbojets turn on runways 6 and 17) and PPORT FOUR (RNAV, turbojets). STAR: ROZZE TWO (RNAV, two pages; transcribed, see below). The special-authorization ILS/RNP charts are listed but not transcribed. The 7 transcribed approaches carry fixes with roles, minima and the missed approach (see the files); missed-approach texts are written in the engine's grammar with the redundant "continue climb-in-hold to <alt>" dropped (the verbatim plate text is kept in `missed_approach_verbatim`).

### ROZZE TWO ARRIVAL (RNAV) (`kmht-procedures.json` `stars[0].star`, d-TPP cycle 2610)

Transcribed 2026-10-18 from `00246ROZZE.PDF` (chart: fixes, tracks, distances in parentheses, minimum en route altitudes along the legs, crossing restrictions) and `00246ROZZE_C.PDF` (the "ARRIVAL ROUTE DESCRIPTION" page), both rendered and read visually; chart header `ROZZE TWO ARRIVAL (RNAV) (ROZZE.ROZZE2) 17AUG17, AL-246 (FAA), NE-1, 01 OCT 2026 to 29 OCT 2026`.
Notes printed on the chart: RADAR required; RNAV 1; DME/DME/IRU or GPS required; Turbojet aircraft only; MUCOW and CRIBB transitions are ATC assigned.
* Transitions (all end at ROZZE): CRIBB (CRIBB, MONRC), MUCOW (MUCOW, FFATY, CRIBB, MONRC), PONCT (PONCT, WOBLY, QUINZ, LUCIC, FLYZZ, FYSHR), QUINZ (QUINZ, LUCIC, FLYZZ, FYSHR), SMYTH (SMYTH, QUINZ, LUCIC, FLYZZ, FYSHR).
* Runway legs from ROZZE (track 102): runway 6 PNARD (between 7000 and 9000 and 230K), then track 111 to TEETO (5000, 210K); runway 17 NUUKM (7000-9000), track 070 to PURBL (5000, 210K); runway 24 NUUKM, track 075 to JSTNN (5000, 210K), then heading 057, radar vectors; runway 35 NUUKM, track 111 to SHOWZ (5000, 210K). The chart tells pilots to expect the ILS / LOC (runways 6, 17, 35), an RNP approach (17, 35) or radar vectors to final.
* Restriction depiction read from the plate: a bar over an altitude = at or below, a bar under = at or above, both = at; single underlined FL190 (QUINZ, MUCOW), 16000 (LUCIC), 13000 (FLYZZ), 9000 (FYSHR, MONRC) are "at or above"; CRIBB 13000-16000, FFATY 16000-FL200; 280K at QUINZ and MUCOW. The altitudes printed along the legs (17000, 14000, 12000, 7000, 6000, 4000) are MEAs, kept as `mea_ft` and not used as restrictions.
* Verification: NASR 2026-10-01 `STAR_RTE.csv` lists exactly these five transitions and four runway bodies; every printed leg distance and magnetic track agrees with the great-circle values from the NASR `FIX_BASE.csv` coordinates (variation 15 W) to within 1 NM and 2 degrees (`src/airport/kmht/rozze.test.ts`, which also reads `STAR_RTE.csv` when the git-ignored download is present).
* The approach join fixes (`join_approach_fixes`: JAAZZ for runway 6; LYLAC, BLSSM, BLUUM for 17; IHOBB, ELEEE, YOULL for 35) are not on the arrival chart: they are the first fixes of the expected ILS plate after the IAF (roles from this file's `instrument_approaches`), added so that an approach clearance finds a route that joins the procedure.
* `scripts/extract-nasr-airport.ts` adds every STAR fix to `kmht-navaids.json`; `scripts/build-airport.ts` copies the transcription into `InstrumentProcedure.star` of the built airport.
* Not transcribed: the RNP (RNAV (RNP) Z) approaches the chart mentions for 17 and 35; anything after the last fix other than runway 24's heading.

## Taxiways: OSM versus the FAA airport diagram (00246AD.PDF, cycle 2610)

Diagram identifiers (read from the chart text and a render): A A1 A2 A3 A5 B C D E F G H J J1 K K1 K2 L M M1 N Z. Of those, **A5, C and K2 have no OSM way** with that ref; OSM has **D1** (two ways), which is not on the diagram (excluded). 30 of the 76 OSM taxiway ways have no ref: 10 are turn-on fillets that the build collapses (below), 13 take the identifier of the way they continue (no diagram label positions were georeferenced for KMHT), 7 stay unnamed. OSM maps each runway entrance as the straight crossing plus short untagged fillets to the centreline; the build collapses those fillets (they would be extra runway entries far from their hold line) and derives each hold line 250 ft from the centreline. OSM also has 26 `holding_position` nodes: on runway 17/35 ten of 11 derived hold lines fall within 2 m of one (on 6/24 the agreement is weaker), which supports the 250 ft simplification; they are compared in `src/airport/kmht/build-report.md`, not used as the source. Parking: the 14 terminal gates (OSM `gate` nodes refs 1-12, 14, 15, inside the terminal) are paired with the OSM `parking_position` node of the same ref; FBO and GA stands are OSM `parking_position` nodes inside the apron "FBO Ramp"; the four cargo spots are synthetic grid points inside the OSM cargo apron polygons.

## KACY layers with no KMHT equivalent (left empty, never invented)
- **LAHSO**: none in NASR or the d-TPP metadata for KMHT.
- **Hot spot**: no d-TPP hot-spot page; the diagram prints only "BE ALERT TO RUNWAY CROSSING CLEARANCES. READBACK OF ALL RUNWAY HOLDING INSTRUCTIONS IS REQUIRED."
- **MVA sectors**: the Boston Consolidated TRACON (A90) MVA chart was not downloaded; `mvaSectors` is absent.
- **Holding patterns and fix altitudes** of the approach plates: not transcribed; every KMHT IAP has empty `holdingPatterns` and `fixAltitudes` (the ROZZE TWO restrictions live in `InstrumentProcedure.star`).
- **Diagram label georeferencing** (used for KACY to name untagged ways by proximity): not done.

## Not verified (KMHT)
- Current (2026) magnetic declination; NASR variation is 15 W with epoch 2020.
- Class C dimensions (shape files not downloaded); traffic pattern altitude (blank in NASR); Chart Supplement text was not consulted (NASR CSV used).
- Plate transcriptions (fix roles, DA/MDA/RVR values, missed approaches, the order of fixes in the simulator route) are human readings of the rendered PDFs. The ILS 17 SITLE role ("LOC step-down fix") and which fixes the plates treat as localizer-only final approach fixes are the least certain.
- OSM: positional accuracy beyond the runway endpoints was not assessed; the OSM runway ways (with `displaced_threshold` segments) were not compared with NASR; the OSM gate positions are inside the terminal (level 2), the stands are the `parking_position` nodes.
- Taxiways A5, C and K2: on the diagram, absent from OSM.

## Raw files (`raw/`, not committed)
`nasr_2026-10-01/x_*_CSV/` (NASR CSVs, shared), `d-TPP_Metafile_2610.xml`, `kmht_dtpp_2610_pdfs/` (18 PDFs), `kmht_dtpp_http_head_checks.tsv`, `overpass_kmht_raw.json`.

## Plate geometry: glidepath TCH and missed approach altitudes (added 2026-10-18)

`kacy-plate-geometry.json` and `kmht-plate-geometry.json` (read by `scripts/build-airport.ts` through `profile.plateGeometryFile`) give every instrument approach a structured `glidepath` (`kind` GS / GP / VDA, `angleDeg`, `tchFt`) and `missedApproach` (`initialClimbFt`, `finalAltitudeFt`, `plateText`) in `InstrumentProcedure`.

* **Method**: the d-TPP 2610 PDF text layer was extracted with pdfjs-dist; the "MISSED APPROACH:" box and the "TCH n" / "GS|GP x.xx" labels were located by page position. The two USAF plates with no text layer (KACY HI-ILS Y OR LOC Y RWY 13, HI-VOR OR TACAN RWY 31) were rendered to images and read visually. All 24 values were compared with the earlier transcriptions in `*-procedures.json` (`plate_notes`, `missed_approach`): all agree. Four KMHT plates that file lists as not transcribed (RNP Z 17, RNP Z 35, ILS 35 CAT II-III, SA CAT I) now have their TCH and missed approach altitudes, read from the plate text layer (new: RNP Z 17 "Climb to 2100 on track 172 deg to YOULL and hold"; RNP Z 35 and the CAT II-III / SA CAT I ILS "Climb to 3000 on track 352 deg to BLUUM and hold" / "Climb to 4000 direct CON VOR/DME and hold").
* **TCH is the plate's glidepath TCH, not the VGSI TCH.** Several plates print both ("GS 3.00 TCH 58" and "VGSI Angle 3.00 / TCH 71 not coincident"); the first is `glidepath.tchFt`, the second is the NASR `threshold_crossing_height_ft` of the runway end, kept as `RunwayEnd.visualGlidepath` and used for visual approaches. VOR plates print a visual descent angle (VDA 3.05 deg TCH 47 on VOR 4, 3.12 / 52 on VOR 31). The COPTER ILS 13 plate prints HCH 58 (helicopter crossing height).
* **Fallbacks, labelled**: an instrument approach without a transcribed glidepath flies 3 deg / 50 ft (`glidePathFor(...).source === 'default'`); a missed approach without a published altitude climbs to 2,000 ft (`IFR_MISSED_APPROACH_FT`) with an INFO event.
* **Not verified**: the plates are a human / extracted transcription, not checked against the FAA digital procedures data; the cycle is 2610 (expires 2026-10-29).

## Traffic variety (added 2026-10-18)

No new geometry file: everything below is read from the datasets already in the repo plus the web sources listed. What exists, and why each kind is (not) generated:

| Kind | Evidence in the data | Used at |
|---|---|---|
| Coast Guard helicopters | KACY OSM `aeroway=helipad name=USCG` (4 features) -> parking positions `USCG-1..4` in `src/airport/kacy/kacy.airport.json` (category `military`, `scripts/airports/kacy.ts`). The 2 other OSM helipads are not USCG-tagged and are not used. The NASR private helipad H1 ("PVT - EXPERIMENTAL USE ONLY") is not used. The pads connect to the taxi graph through nodes AP021-AP024 (about 53 m). | KACY only |
| Air National Guard fighters | `ANG-1..6` (synthetic spots 30 m north of OSM hangars on the ANG ramp) and `ANG-PAD-1/2` (arm / dearm pad spots, not used for departures) in the same file; the README notes above say the ramp polygon is not in the dataset and taxiway G is absent from OSM, so the real nearest taxi nodes of the graph are used. The 177th Fighter Wing's F-16C/D and Atlantic City ANG base: public (af.mil / ang.af.mil, njmilitiamuseum.gov, Wikipedia search results 2026-10-18). Tail-number lists are photo databases, not used. | KACY only |
| Arresting gear BAK-14 / BAK-12B | `kacy-facility.json` (NASR). No source for the rigged / derigged state or its announcement: **informational only, no gameplay, no ATIS text**. | - |
| FAA ops 123.4 / ANG ops 140.7 | recorded as "not ATC" frequencies (OTHER); not used. | - |
| VFR transitions | Class C airspace flag of KACY (NASR, `airspaceClass` C) and KMHT (C); JO 7110.65 7-8, AIM 3-2-4. | KACY, KMHT |
| Flight training | No dataset or source names a flight school at KACY or KMHT. The pattern-work behaviour is generic (touch-and-go circuits of GA arrivals, JO 7110.65 3-8-2); the share (40 %) is a design value, enabled for KACY only (the task named training at KACY; KMHT has no source and gets none). | KACY |
| Airport vehicles | Every towered airport has them (AC 150/5210-20A); they park at the `fbo` / `cargo` positions (KACY FBO-1/2, FAA-1/2/3; KMHT FBO-1..3 and CARGO-*). No published vehicle crossing points exist in the data (no `vehicle crossing` feature in OSM, NASR or the diagram notes searched), so vehicle crossings use the ordinary taxiway-runway crossings of the graph. | KACY, KMHT |
| KMHT USCG / ANG | None found: no helipad or military ramp feature in the KMHT dataset and no unit sourced; KMHT gets neither kind. | - |

Web sources (retrieved 2026-10-18): USCG MH-65E fact sheet (dcms.uscg.mil, via search result text; HTTP 403 to scripts); Coast Guard Aviation Association MH-65C table (search result text); USAF F-16 fact sheets (af.mil and unit sites, via search result text); FAA JO 7110.65BB, AIM, AC 150/5210-20A and JO 7110.126A (fetched). Figures and verdicts: docs/REALISM-VERIFICATION.md section 9; callsign and phrase sources: docs/FAA-REFERENCES.md "Traffic variety".

The COPTER ILS 13 plate (HCH 58) in `kacy-procedures.json` is not flown: helicopters in the simulator are VFR and go straight to their pad.

Callsign digits of generated Coast Guard (`CGD#####`) and Air Guard (`ANG#####`) flights are generated, exactly as the N-numbers of generated GA traffic are; no real serial number is stored anywhere.

# KBOS (General Edward Lawrence Logan International, Boston MA) - verified source data

Added 2026-10-21 in four steps: d-TPP transcription (`kbos-procedures.json`, `kbos-plate-geometry.json`), `npx tsx scripts/extract-nasr-airport.ts BOS KBOS 2026-10-01 2026-10-21` (`kbos-facility.json`, `-frequencies.json`, `-navaids.json`), Overpass + `scripts/osm-overpass-to-geojson.ts` (`kbos-taxiways.geojson`) and the Massport runway-configuration sources (`kbos-runway-configurations.json`, embedded by the extractor as `facility.runway_configurations`). Nothing aeronautical was typed from memory. NASR 2026-10-01 CSVs are the shared `raw/nasr_2026-10-01/`; d-TPP cycle **2610** (volume NE-1).

| File | What | Source | Retrieved |
|---|---|---|---|
| `kbos-facility.json` | ARP, elevation, variation 15 W (2020), 6 runways / 12 ends (thresholds, displaced thresholds, LAHSO, declared distances, lighting), five ILS systems, Class B flag, `runway_configurations` | NASR APT/ATC/CLS_ARSP/ILS CSVs; charted magnetic headings from the diagram | 2026-10-21 |
| `kbos-frequencies.json` | All 26 FRQ.csv rows for BOS: D-ATIS 135.0 (arrival and departure), pre-taxi clearance 121.65, Ground 121.75 and 121.9, Tower 128.8 (WEST) / 132.225 (EAST) / 124.725 (HELICOPTERS), Ramp control 134.05, Boston Consolidated TRACON A90 sector rows (APCH/P NORTH 118.25, APCH/P IC WEST 120.6, APCH/P SOUTH 127.2, DEP/P 133.0, CLASS B 124.1 (091-269) and 124.4 (270-090), WOONS STAR 120.6), UNICOM, emergency | FRQ.csv | 2026-10-21 |
| `kbos-navaids.json` | BOS VOR/DME 112.7 (74X), GDM, LFV, PVD, ORW, JFK, five ILS/LOC DME systems (I-BOS 4R CAT III, I-MDC 15R, I-LQN 22L, I-LIP 33L CAT III, I-DGU 27), 107 fixes with NASR coordinates | NAV/ILS/FIX CSVs | 2026-10-21 |
| `kbos-procedures.json` | All 53 d-TPP metadata records (52 distinct PDFs) with URL and HTTP check; transcription of the airport diagram, 11 approach charts with fixes (5 ILS/LOC, RNAV (GPS) 4L, 4R, 15R, 27, 32, X 22L, Y 22L, Z 33L) and 4 more with minima only (SA CAT I and CAT II-III ILS 4R and 33L), RNP X 33L (not transcribed), LIGHT VISUAL 33L (listed), LOGAN FOUR and nine RNAV departures, the ROBUC THREE and JFUND TWO arrivals (`stars[].star`), hot spots and LAHSO | d-TPP metadata + PDFs `https://aeronav.faa.gov/d-tpp/2610/<pdf>` | 2026-10-21 |
| `kbos-plate-geometry.json` | Glidepath angle / TCH and missed-approach altitudes of 18 approach charts | the same PDFs | 2026-10-21 |
| `kbos-runway-configurations.json` | Five documented runway configurations with shares | Massport / FAA documents below | 2026-10-21 |
| `kbos-taxiways.geojson` | 697 OSM aeroway features within 3000 m of the ARP (147 taxiways, 108 taxilanes, 113 gates, 179 parking positions, 89 holding positions, ...) | Overpass `https://overpass-api.de/api/interpreter` (OSM base 2026-10-22T01:27:20Z); raw `raw/overpass_kbos_raw.json` | 2026-10-21; ODbL 1.0 (c) OpenStreetMap contributors |

Overpass query: `[out:json][timeout:120]; nwr["aeroway"~"^(runway|taxiway|apron|parking_position|holding_position|helipad|terminal|gate|taxilane|aerodrome|hangar|stopway|navigationaid|windsock)$"](around:3000,42.36294444,-71.00638888); out geom;` (User-Agent sent). PDF check: HEAD (200, application/pdf, Content-Length) and GET for all 52 URLs, table `raw/kbos_dtpp_http_head_checks.tsv`; PDFs in `raw/kbos_dtpp_2610_pdfs/`.

## Key facts
**Airport:** GENERAL EDWARD LAWRENCE LOGAN INTL, BOS / KBOS, Suffolk County MA, publicly owned (Massport). ARP **42.36294444 N, 71.00638888 W** (3rd-party survey 2008-11-15), elevation **19.1 ft**, variation **15 W epoch 2020**, ARTCC ZBW, FAR 139 "I E", ATCT FAA 24 h, **Class B** (CLS_ARSP), approach/departure control Boston Consolidated TRACON (A90, radio call "BOSTON"), tower radio call "BOSTON". D-ATIS phone 617-455-3003.

**Runways (NASR, charted magnetic heading from the diagram):** 04L/22R 7864 x 150 (035/215), 04R/22L 10006 x 150 (035/215), 09/27 7001 x 150 (092/272), 14/32 5000 x 100 (140/320), 15L/33R 2557 x 100 (150/330), 15R/33L 10083 x 150 (150/330). Displaced thresholds 22R 819, 04R 1155, 22L 1199, 15R 882 ft. LAHSO (NASR LAHSO_ALD equals the LAHSO page): 04L 5,250 ft hold short of 15L-33R; 15R 6,800 / 22L 6,400 ft hold short of 09-27; 27 5,650 ft hold short of 04R-22L. ILS: 4R I-BOS 110.3 CAT III, 15R I-MDC 110.7 CAT I, 22L I-LQN 110.3 CAT I, 27 I-DGU 111.3 CAT I, 33L I-LIP 110.7 CAT III; 4L, 22R, 9, 14, 15L, 32, 33R have no ILS (4L and 32 have RNAV GPS only).

## Procedure transcription: what was read from which PDF
Method: every PDF text-extracted with pdfjs-dist (positions grouped into lines); plates, STARs, SIDs and the diagram rendered with `pdftoppm` (200-400 dpi) and read visually; texts that exist in full in the text layer (STAR route descriptions, SID route descriptions, hot spot and LAHSO pages) were taken from it. Human transcription: spot-check before any real use.
* **Diagram** `00058AD.PDF`: charted headings, printed frequencies, the 31 taxiway identifiers (A A1 A2 B C C1 D D1 D2 E E1 E2 F G H J J1 K L M M1 N N1 N2 N3 P Q R T Y Z), hot spots HS 1-4, runway dimensions, PCR values.
* **ILS or LOC** 4R (`00058IL4R`), 15R (`IL15R`), 22L (`IL22L`), 27 (`IL27`), 33L (`IL33L`): LOC/DME ident, course, fixes with DME and roles (IAF/IF/FAF/step-down, GS intercept altitude), minima (DA, MDA, visibility), GS angle and TCH, missed approach text, notes. SA CAT I and CAT II-III plates of 4R and 33L (`I4RSAC1`, `I4RC2_3`, `I33LSAC1`, `I33LC2_3`): minima and missed approach (RA 168/14 and 99/12 on 4R, 166/14 and 116/12 on 33L).
* **RNAV (GPS)** 4L (`R4L`), 4R (`R4R`), 15R (`R15R`), 27 (`R27`), 32 (`R32`), X 22L (`RX22L`), Y 22L (`RY22L`), Z 33L (`RZ33L`): fixes and roles, LPV / LNAV-VNAV / LNAV minima, GP angle and TCH (32: VDA 2.91, TCH 45), missed approach. RNP X 33L (`RRX33L`, RNP AR) and LIGHT VISUAL 33L (`LIGHT_VIS33L`) are listed, fixes not transcribed.
* **Departures**: LOGAN FOUR (`00058LOGAN`, `LOGAN_C`: jet headings by runway, TOP ALTITUDE jets 5000 / props 3000, takeoff minimums, vector notes) and the nine RNAV SIDs BLZZR SIX, BRUWN SEVEN, CELTK SEVEN, HYLND SEVEN, LBSTA EIGHT, PATSS SEVEN, REVSS SIX, SSOXS SEVEN, WYLYY FIVE (`..._C.PDF` text layer: runway legs, "Maintain 5000", Boston Departure 133.0). The simulator flies the runway heading and then radar vectors, so only the first fixes of each SID are transcribed.
* **STARs**: ROBUC THREE (`00058ROBUC`, `ROBUC_C`, `ROBUC_C2`) and JFUND TWO (`00058JFUND`, `JFUND_C`, `JFUND_C2`) in full ROZZE TWO shape (transitions, a leg per runway end 4L 4R 15R 22L 22R 27 32 33L, altitude and speed restrictions, legs, chart notes). **Why these two:** both are RNAV 1 jet arrivals with a leg for every landing runway and between them they enter the Boston area from the south-west (New York) and the west; NASR STAR_APT assigns ROBUC, JFUND and OOSHN to every BOS runway end. **Their relative traffic is not sourced**, so "most used" is not claimed. OOSHN FIVE (oceanic EURRO) and WOONS TWO (props) are listed, not transcribed. Verification: fix sequences equal NASR `STAR_RTE.csv`; every printed leg distance and magnetic track agrees with the great-circle values from NASR fix coordinates (15 W) within 1.5 NM / 3 deg (checked 2026-10-21 for all 53 legs; legs without a printed distance read carry the computed distance and say so).
* **Hot spots / LAHSO**: `NE1HOTSPOT.PDF`, `NE1LAHSO.PDF` text layers (verbatim in `supporting_charts`).

## Build changes for KBOS (scripts/build-airport.ts, scripts/lib/planar.ts)
`includeTaxilanes` (OSM `taxilane` ways, the apron lanes, enter the graph as untagged ways), `dropIsolatedLanes` (lane islands touching no runway are listed in the report and dropped), `excludeOsmWays` (way/480497343 and /480497344: connectors at the 4R threshold whose hold line falls inside runway 14/32; way/678899871 and /24845102: taxiway Y, which merges into runway 15L/33R at a shallow angle so no hold line is possible; Y is therefore absent from the graph), `shortStubJunctionM` = 55 (holds on a stub whose junction is a real taxiway junction), taxiway ends within 1.5 m of a runway threshold merge into the threshold node, a parking connector shorter than 0.5 m moves its stand 0.6 m, and the half-runway exit check is a warning for runways under 6,000 ft (14/32, 15L/33R). KACY, KMHT and KPGD output is unchanged. Parking: gates = OSM `parking_position` ways with refs A/B/C/E + digits (no suffix variants), cargo = NC/SC refs, FBO and GA = synthetic spots in the OSM apron "Signature Ramp"; remote stands (hardstands 14A-M, H1-3, D1-3, J1-5) are not used; no Cape Air apron exists in OSM.

## Extractor changes (scripts/extract-nasr-airport.ts)
(1) runway-end keys keep the L/R/C letter (`4R`, not `4`) for charted headings, ILS lookups and plate data; (2) ATIS falls back to D-ATIS rows, clearance delivery to the `CD PRE TAXI CLNC` VHF row, and several GND/P and LCL/P rows are kept (`ground_all`, `tower_all`, `ramp_control`, `tracon_vhf_rows`, `class_b_frequencies`; the primary tower is the first row without HELICOPTERS); (3) a TRACON without a combined `APCH/P DEP/P` row gets `approach_departure.vhf = null`; (4) an optional `<slug>-runway-configurations.json` is embedded as `facility.runway_configurations`. KACY and KMHT output is byte-identical (KMHT only gains new optional fields, not committed).

## Runway configurations (sources retrieved 2026-10-21)
* Massport, "Boston Logan International Airport Operational Overview (Logan 101)", MCAC 2017-06-08, `https://massportcac.org/wp-content/uploads/2017/06/Final-BOS-Update-MCAC-Logan-101-060817.pdf`: CY2016 jet flights by flow NE 34%, SW 31%, NW 31%, SE 4%; runway lists of each flow; late-night opposite-direction configuration (arr 33L, dep 15R).
* FAA, Logan Runway 33L RNAV SID EA, Appendix A (2013), `https://www.faa.gov/sites/faa.gov/files/air_traffic/environmental_issues/ared_documentation/Appendix_A_Noise_Modeling_06032013.pdf`, Tables A.3/A.4: seven operating configurations incl. instrument-condition ones (4R only; 22L only) and 2009 shares.
* Massport MCAC briefing 2016-12-08 (`.../Massport-Briefing-to-MassportCAC-Annual-Mtg-12-08-2016.pdf`): the FAA lands and departs into the wind, weather is the primary factor.
No wind sector or tailwind limit is published in any of them, so those fields are absent (UNVERIFIED). Not retrieved: Massport monthly runway-use reports (links on the massport.com noise-abatement runway-use page), the FAA runway use program / PRAS text, the current Environmental Data Report.

## Live weather
`https://api.weather.gov/stations/KBOS/observations/latest` returns 200 with `access-control-allow-origin: *` (checked 2026-10-21, observation 2026-10-22T01:05Z); `rawMessage` is empty, as at KMHT, so the sim composes the METAR from the structured fields.

## Not verified (KBOS)
* Current magnetic declination (NASR 15 W, 2020); Class B dimensions; traffic pattern altitude (blank).
* All plate, STAR, SID and diagram readings are human transcriptions; the 31 taxiway letters were read on renders; RNAV 32 feeder joins near QUINC/BOATZ/FREDO/SCUPP are the least certain.
* LOGAN FOUR / SID maintain altitude: jets 5000, non-jets 3000 (the simulator stores the jet value only).
* Not transcribed: RNP X 33L fixes, OOSHN FIVE, WOONS TWO, SID legs after the first fixes, holding patterns and fix altitudes, MVA sectors, takeoff-minimums booklet.
* Usage of each STAR and the current runway-configuration shares; wind limits of every configuration.
* Raw documents: `raw/kbos_runway_use_docs/`.

## Aircraft performance: types added for KBOS, KPHL and EGLL (2026-10-21)

Types added to `src/sim/performance.ts` and `aircraft-performance.json` (entries `A319 A20N A21N A321 B737 B38M B739 E190 CRJ7 B762 B763 A306 B772 B77W B788 B789 A332 A333 A339 A359 A35K A388 B744 B748 MD11 DH8D BE20 BE9L PC12 C402 C56X CL35 GLF5 GLEX`; the block `_meta_kbos_kphl_egll` lists the source keys). Whether a given airline flies a type at each airport in 2026 is NOT checked here (that is the airport traffic profile's own sourcing): the entries only make the performance model complete.

Downloads (all retrieved 2026-10-21, `User-Agent: atc-simulator-research/1.0`):

| What | URL | HTTP | Raw copy |
|---|---|---|---|
| EUROCONTROL Aircraft Performance Database, one page per type (34 types) | `https://learningzone.eurocontrol.int/ilp/customs/ATCPFDB/details.aspx?ICAO=<TYPE>` (`https://contentzone.eurocontrol.int/aircraftperformance/details.aspx?ICAO=<TYPE>` answers 301 to it) | 200 | `raw/realism/eurocontrol_acd_<TYPE>.html` |
| FAA JO 7110.126A (09/28/2019), Appendix A TBL A-1 (page A1) | `https://www.faa.gov/documentLibrary/media/Order/JO_7110.126A.pdf` | 200 | `raw/realism/faa_JO_7110.126A.pdf` (listing from `pdftotext -layout`, confirmed on the page rendered with `pdftoppm -r 150`) |
| FAA JO 7110.65 chapter 2 section 4 (2-4-14 super / heavy in the identification, 2-4-20 aircraft types) | `https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap2_section_4.html` | 200 | `raw/realism/faa_7110_65_chap2_section_4.html` |
| Airbus A350 Aircraft Characteristics - Airport and Maintenance Planning, Jul 01/26 (A359 take-off and landing distance only) | `https://mediaassets.airbus.com/pm_38_916_916746-gxtwm2qvq4.pdf?fileName=a350-aircraft-characteristics-airport-and-maintenance-planning.pdf` (link from the Airbus "Aircraft Characteristics" page) | 200, 178 MB | not stored; section 3-3-0 (take-off weight vs runway length, ISA) and 3-4-0 (landing field length) read visually |

Read per type from the ACD "performance table": V2, take-off distance, WTC (ICAO L/M/H/J), RECAT-EU, MTOW, initial-climb IAS / ROC, climb-to-FL150 IAS / ROC, cruise TAS and ceiling, descent IAS / ROD, approach IAS / ROD, landing Vat and distance, APC, wing span, length, height, power plant. The ACD page says "All data presented is only indicative and should not be used operationally ... Copyright permission must be sought from EUROCONTROL": the figures are facts used as references with attribution; the raw pages are not committed.

Derivations (each repeated in the type's `_sources`): rotate = V2 - 5 kt; approach = Vat; touchdown = Vat - 5 kt; climb speed / rate = initial climb IAS / ROC; take-off and landing distance = ACD figures at MTOW (ft = m x 3.28084, rounded to 10); cruise 250 kt for jets (14 CFR 91.117(a)); `accelKtPerSec` = VR^2 / (2 x 0.8 x take-off distance) (ground roll 80 % of the distance, the A320 / B738 ratio); `maxSpeedKt` for jets = max(ACD climb IAS, descent IAS) + 30 kt; minimum speed = Vat - 15 kt. Taxi speeds, turn rates, braking and the 2,000 ft/min jet descent rate are DESIGN values (as for A320 / B738). Take-off distances are MTOW-basis: B77W (9,840 ft) fits only the longest ends (KBOS 4R/22L is 10,005 ft: the engine's check needs distance + 50 m, so it is marginal), B744 and B748 (10,830 / 10,470 ft) exceed it.

RECAT (TBL A-1, page A1): A = A388; B = A332 A333 A359 B744 B748 B772 B77W B788 B789; C = A306 B762 B763 MD11; D = A339; E = B752; F = A319 A321 B737 B739 DH8D E190 GLEX GLF5; G = CRJ7; H = C56X; I = C402 PC12 BE20. Derived (type absent from TBL A-1, UNVERIFIED as listings): A20N, A21N, B38M = F (sibling types), A35K = B (the A359 is B), BE9L = I (10,100 lb is within the Category I definition), CL35 = H (40,600 lb is within the Category H definition).

"super" / "heavy" in the callsign: Category A -> "super", B, C, D -> "heavy" (JO 7110.126A Appendix B amends JO 7110.65 2-4-14 / 2-1-20; 2-4-14: "The word heavy must be used as part of the identification in all communications with or about heavy aircraft", example "United Fifty-Eight Heavy"). The ICAO categories H / J in the ACD give the same set (A388 = J).

### Not verified / not added (aircraft performance, 2026-10-21)

- **Not added, no source for the figures**: `E75L` / `E75S` (no ACD page; the existing `E175` entry remains an ESTIMATE; both are RECAT G in TBL A-1), `AT76` (no ACD page; the ACD lists AT43, AT44, AT45, AT72 and AT75 only), `CL60` (ACD page has no take-off or landing distance). `B753`, `B77L`, `C680`, `C550` etc. were not requested.
- A359 take-off / landing distance: the ACD shows 888 m for both (a data error); the entry uses chart reads of the Airbus A350 AC (about 2,550 m take-off at 268 t, ISA, sea level; about 1,950 m landing field length at maximum landing weight, +/-150 m).
- The ACD figures are "indicative" and at MTOW / ISA / sea level; none is a certified performance figure. Some look odd and were taken as published: B38M take-off distance 2,500 m, C402 Vat 110 kt (a 2015 Cape Air training flashcard set, seen only as a web-search result, also lists 110 kt "Vref at threshold": a weak source), PC12 climb IAS 130 kt, A388 V2 150 kt. `cruiseSpeedKt` of DH8D / BE20 / BE9L / PC12 / C402 is an ACD climb or approach IAS, not a published cruise IAS.
- Wing span and height are recorded in `_not_in_type_shape` and in `src/ui/tower/aircraftModel.ts` (Tower view, 2D glyph); there is no stand-size model in the simulator, so the figures are not used for stand fit (parking has categories only).
- The KMHT types (B738, BCS3, E175, CRJ9, B752, C208) are still the 2026-10-17 ESTIMATEs; the ACD has pages for B738, BCS3, B752, C208 and CRJ9, so they can be cross-checked against it later (the ACD B738 Vat is 147 kt against the 140 kt in the file).
- Operator presence in 2026 (BA 747-400, UPS / FedEx MD-11 after the November 2025 accident, Q400 operators) is not checked.

## Runway configurations, time zone and non-FAA provenance (facility JSON, optional fields)

Hub airports run published runway configurations (which runways take arrivals, which take departures, in which wind). The facility JSON may carry
`runway_configurations`: a list in operator-preference order (ties and calm wind use the first usable entry), each `{ id, name, landing: [end ids],
departing: [end ids], wind_from_deg?, wind_to_deg?, max_tailwind_kt?, notes, source, url?, retrieved?, approximate? }`. End ids are the runway-end
identifiers ("4R", "27L"); the wind sector is magnetic, wind FROM, clockwise from `wind_from_deg` to `wind_to_deg` (may wrap through north).
Each entry must cite where the configuration is published (ATIS, airport operator, AIP); an airport with no sourced configuration omits the list and
the simulator falls back to one best-headwind runway for arrivals and departures. `airport.time_zone` (IANA, "Europe/London") is a sourced constant of
the profile, not extracted; absent means America/New_York. `airspace.class` gives the airspace class letter. For an airport built from a non-FAA
source (EGLL: UK AIP) `_provenance.source_name` / `source_url` in the facility JSON, and `source_name` / `source_url` in the procedures JSON
`_provenance`, replace the default NASR / d-TPP labels in the built provenance entries. The field list is also in `scripts/airports/types.ts`.

# KPGD (Punta Gorda Airport, FL) - verified source data

Third airport, built the KMHT way (`scripts/extract-nasr-airport.ts PGD KPGD 2026-10-01 2026-10-21`, `scripts/osm-overpass-to-geojson.ts`, a plate transcription, then `npx tsx scripts/build-airport.ts KPGD`). NASR CSVs: the 2026-10-01 cycle files shared with the other airports (`raw/nasr_2026-10-01/`); d-TPP metadata `raw/d-TPP_Metafile_2610.xml` (records `apt_ident="PGD"`, `icao_ident="KPGD"`, alnum 6178); charts checked and read on **2026-10-21** (HEAD times 2026-10-22 UTC in the TSV); OSM fetched 2026-10-21 (base timestamp 2026-10-22T02:12:13Z).

**FAA cycle:** NASR 2026-10-01 (next 2026-10-29); d-TPP 2610 (2026-10-01 0901Z to 2026-10-29 0901Z), volume **SE-3**.

## Files

| File | What | Source (URL) | Retrieved | Cycle | License |
|---|---|---|---|---|---|
| `kpgd-facility.json` | ARP, elevation, variation, runways (all three NASR runways incl. 09/27), ends, displaced threshold, tower hours, remarks, Class D flag and hours, ownership, ILS | NASR `01_Oct_2026_{APT,ATC,CLS_ARSP,ILS}_CSV.zip` | 2026-10-21 | NASR 2026-10-01 | US Government work, public domain. Not for navigation. After extraction two sourced constants were added by hand (`airport.time_zone` America/New_York, `airspace.class` D); re-running the extractor removes them. |
| `kpgd-frequencies.json` | every FRQ.csv row with FACILITY or SERVICED_FACILITY PGD (17 rows): PGD tower rows, the RSW TRACON rows serving PGD (127.05 / 306.2, PIKKR STAR 134.425 above 6000 ft), the FORT MYERS RCAG rows (Miami Center 134.75 / 322.5 when approach is closed), TPA LUBBR STAR rows (119.65 / 353.575) | `.../01_Oct_2026_FRQ_CSV.zip`, `ATC_CSV.zip` | 2026-10-21 | NASR | same |
| `kpgd-navaids.json` | I-PGD ILS/DME components, the RSW VORTAC, 45 fixes with NASR coordinates and plate roles | NAV / ILS / FIX zips | 2026-10-21 | NASR / d-TPP | same |
| `kpgd-procedures.json` | the 11 PGD d-TPP PDFs with URL and HTTP check; transcription of 5 approaches, the diagram, the obstacle takeoff page, the PGD bodies of 2 STARs | d-TPP | 2026-10-21 | d-TPP 2610 | same |
| `kpgd-plate-geometry.json` | GS / GP angle, TCH and missed approach altitude of the 5 IAPs | PDFs | 2026-10-21 | d-TPP 2610 | same |
| `kpgd-taxiways.geojson` | OSM aeroway features within 2 km of the ARP (169: 93 taxiways, 46 holding_position, 13 parking_position ways, 8 gates, 2 aprons, 3 runways, terminal, hangar, aerodrome, windsock) | Overpass `https://overpass-api.de/api/interpreter`; raw `raw/overpass_kpgd_raw.json` | 2026-10-21 | n/a | **ODbL 1.0, (c) OpenStreetMap contributors** (attribution; share-alike for the derived taxiway/apron layer) |

Overpass query (radius 2000 m around the NASR ARP): `[out:json][timeout:90]; nwr["aeroway"~"^(runway|taxiway|apron|parking_position|holding_position|helipad|terminal|gate|taxilane|aerodrome|hangar|stopway|navigationaid|windsock)$"](around:2000,26.9185925,-81.99088611); out geom;` (User-Agent and `Accept: application/json` sent).

PDF checks: `raw/kpgd_dtpp_http_head_checks.tsv` (11 rows: HEAD status, content type, length, GET size, `%PDF` magic, UTC time); all returned 200 `application/pdf` with GET size equal to the HEAD length. Downloads: `raw/kpgd_dtpp_2610_pdfs/` (git-ignored). Text was extracted with pdfjs-dist; every plate and the diagram were also rendered (pdftoppm) and read visually, because the plates' text layers are scrambled and the diagram has no text layer.

## Key facts (NASR 2026-10-01 unless noted)

**Airport:** PUNTA GORDA, FAA ID PGD, ICAO KPGD, Charlotte County FL, publicly owned (Charlotte County Airport Authority), ARP **26.9185925 N, 81.99088611 W**, elevation **25.5 ft**, variation **6 W (epoch 2020**; diagram: "VAR 6 W, JANUARY 2020, annual rate of change 0.1 W"), ARTCC ZMA, FAR 139 class "I B". **ATCT, contract tower (operator code FCT), hours 0600-2100** (TWR_HRS and the FRQ rows); **Class D service 0600-2100, other times Class E** (CLS_ARSP AIRSPACE_HRS). ATIS 24 h (ATC_ATIS), no phone listed. Approach / departure: **Fort Myers Approach**, provided by the Southwest Florida Intl TRACON (RSW) on 127.05 (UHF 306.2); when approach is closed Miami ARTCC on 134.75 / 322.5 (FORT MYERS RCAG, NASR remark); the primary provider is RSW, the secondary Miami ARTCC. Clearance delivery when the tower is closed: 127.05, monitored by Fort Myers approach (NASR remark; diagram "127.05 (When Tower Closed)"); airport remark: for CD when the tower is closed call Fort Myers approach, when approach is closed Miami Center (phone numbers in `kpgd-facility.json`). Time zone America/New_York: sourced constant (not NASR).

### Runways
| Runway | L x W (ft) | End | True hdg | Charted mag (diagram) | Threshold lat, lon (pavement end) | TDZE | Displaced | ILS |
|---|---|---|---|---|---|---|---|---|
| 04/22 | 7193 x 150 ASPH grooved, HIRL | 4 | 29 | 035 | 26.91018111, -81.99214583 | 23.5 | none | ILS/DME I-PGD 109.75 (CAT I, course 35.16, GS 3.00, 333.05, DME 34Y) |
| | | 22 | 209 | 215 | 26.92745786, -81.98138719 | 25.5 | none | none (RNAV only) |
| 15/33 | 6286 x 150 ASPH grooved, MIRL | 15 | 149 | 155 | 26.92367338, -81.9991883 | 21.6 | **271 ft** (LDA 6015) | none |
| | | 33 | 329 | 335 | 26.90882461, -81.98930466 | 23.5 | none | none |
| 09/27 | 2636 x 60 ASPH | 9 / 27 | 89 / 269 | 095 / 275 | 26.92350875, -81.99815797 / 26.92361327, -81.99006905 | 22.2 | none | none |

PAPI (P4L) on 4, 22, 15, 33; REIL on 4, 15, 22, 33 (NASR RWY_END_LGTS_FLAG); no approach lights. **Runway 09/27 is not in the built airport** (`AirportProfile.excludeRunways`): NASR remark "RWY 09/27 NOT AVBL FOR PART 121/PART 380 OPS WITH SKED PAX CARRYING OPS MORE THAN 9 PAX SEATS AND NON-SKED PAX CARRYING OPS MORE THAN 30 PAX SEATS. RSTRD TO ACFT LESS THAN 6000 LBS."; d-TPP takeoff minimums "Rwys 9, 27, NA - airport authority request"; the diagram "Not for Part 121/Part 380 Air Carrier Use or Foreign Air Carrier". The airline types the simulator generates cannot use it. No LAHSO fields in NASR. The 4/22 and 15/33 centrelines intersect (the build finds node `RWX-4-22x15-33`, 191 m from the runway 4 threshold and 1547 m from the runway 15 threshold; the diagram prints no hot spot there).

### Frequencies (MHz)
ATIS 135.675 (NASR ATIS and the ASOS row share it); **Clearance Delivery 119.55 and Ground 119.55** (NASR CD/P and GND/P, both on the diagram); Tower 121.0 (LCL/P, also CTAF when the tower is closed, "PUNTA GORDA TOWER 121.0 (CTAF)"); Fort Myers Approach/Departure 127.05 (306.2 UHF); UNICOM 122.975; extra NASR rows listed as non-position frequencies: Fort Myers Approach 134.425 for the PIKKR STAR "6000 FT & ABV" (127.05 is "5000 FT & BLO"), Miami Center 134.75 (FORT MYERS RCAG, "LOW"), Tampa Approach 119.65 (LUBBR STAR). No sector bearings are published. **Simulator note:** the engine resolves a frequency to the first position that owns it, so the built list puts GND before CLNC (`scripts/airports/kpgd.ts`).

### Navaids
No navaid at PGD itself in NASR. The plates use the LEE COUNTY VORTAC (RSW 114.15, chan 88Y, 26.52988669 N 81.7757685 W, NASR status OPERATIONAL RESTRICTED, variation 2 W epoch 1985) as IAF / feeder. ILS I-PGD runway 4: LOC 109.75, GS 333.05, DME 34Y, status OPERATIONAL IFR (NASR remark "ILS UNMON WHEN ATCT CLSD"). The plate DME values of ZEPIG 11.4, CISTS 6.2 and ISOXE 2.6 were recomputed from the NASR ILS_DME antenna and FIX_BASE coordinates (11.4 / 6.2 / 2.6 NM) and `src/airport/kpgd/kpgd.test.ts` checks them.

### Procedures (d-TPP 2610, SE-3)
* **IAPs, all transcribed (fixes with roles in route order, minima, missed approach verbatim and simplified, notes):** ILS or LOC RWY 4 (amdt 1 05SEP24: S-ILS DA 256 HAT 232, 300-3/4; S-LOC 480; with ISOXE DME fix 380-1), RNAV (GPS) RWY 4 (3 05SEP24), 15 (2 31DEC20), 22 (2A 30JAN20) and 33 (2 31DEC20). Glidepath: GS / GP 3.00 deg; TCH 50 (ILS 4), 50 (RNAV 4), 47 (15), 40 (22, the plate also prints VGSI TCH 31), 48 (33). Missed approach: 4: climb to 2000 direct DOGLE, track 087 to JOCKS and hold; 15: 2500 direct DODIK, track 203 to OWGAF; 22: 2000 direct BULOW; 33: 2000 direct APZUL. The simplified form is `Climb to ... direct ... and on track ... deg to ... and hold.` (the engine grammar; "087°" written "087 deg"). The ILS 4 plate marks CISTS as the FAF (FAF to MAP 4.8 NM, glideslope intercept 1600) and ISOXE as a step-down fix; VIOLA, ROGAN and PINTS are feeder-route fixes read from the plan-view arrows (checked numerically against NASR coordinates), not labelled IAF. Not transcribed as structured data: the plates' holding patterns (ZEPIG one-minute hold, 4 NM holds at BULOW and APZUL, missed approach holds) and fix altitudes.
* **Airport diagram** `06178AD.PDF`: taxiway identifiers A, A1, A2, A3, A4, B, C, D, E, E1, E2, E3, F, G, G1, G2, G3, H; charted magnetic headings 035 / 215 / 155 / 335 / 095 / 275; printed frequencies ATIS 135.675, Punta Gorda Tower 121.0, GND CON 119.55, CLNC DEL 119.55 (127.05 when tower closed); blast pad 200 x 200 near the runway 15 end; no hot spot.
* **Departures:** there is **no DP, SID or graphic departure** (no d-TPP DP record for PGD, no DP row in NASR `DP_CSV`). The only departure text is the takeoff-minimums page (`SE3TO.PDF`, AMDT 4 31DEC20, page 35 of the booklet): standard takeoff minimums on 4, 15, 22, 33 (no minima or climb gradient published; obstacle notes for the runway ends transcribed in `kpgd-procedures.json`), runways 9 and 27 NA. The simulator therefore uses its default initial altitude (`DEFAULT_INITIAL_ALTITUDE_FT`, 2000) in IFR clearances: this value is a simulator default, not a published PGD altitude.
* **STARs serving PGD:** two, both RNAV 1, jets and turboprops, serving several airports (NASR STAR_BASE `SERVED_ARPT`, STAR_APT `RWY_END_ID ALL` for PGD): **LUBBR FOUR** (`00640LUBBR.PDF` and `_C`, 19MAR26; transitions KRVUR (ATC assigned), KYYUU, SSPAZ; PGD body LUBBR ZEBON RUNNE BREKR WUDDY LYFIE ROSTY, cross ROSTY at or above 3000 and at 210K, then heading 150, radar vectors) and **PIKKR SEVEN** (`06020PIKKR.PDF`, 02DEC21; transitions CODGR (ATC assigned), PLYER, REMIS; PGD body PIKKR GUSEC then heading 118, radar vectors). Only the PGD bodies are transcribed; because the charts print no runway for PGD, the one leg is copied to runways 4, 22, 15 and 33. Every printed leg distance agrees with the NASR coordinates within 1 NM; LUBBR tracks agree within 2 degrees of true + 6 W, PIKKR tracks are a constant 3 degrees less than true + 6 W (the chart's own variation; recorded). `src/airport/kpgd/stars.test.ts` also reads NASR `STAR_RTE.csv` when present. The "3000" values along the LUBBR transition legs are read as MEAs; the "FL180 *1200" labels of PIKKR as MAA / MEA (not restrictions). **STAR traffic is not generated** at KPGD (the generator's entry fixes are KMHT's ROZZE TWO fixes, `STAR_SIM_ENTRY_FIXES`); "cleared LUBBR FOUR arrival" can still be assigned.
* Alternate minimums (`SE3ALT.PDF` p. 5): ILS or LOC 4 and the four RNAV (GPS) approaches have alternate-minimum footnotes only (NA when local weather not available; NA when control tower closed for ILS or LOC 4; Cat D 800-2 1/4); not used by the sim.

## Taxiways: OSM versus the FAA airport diagram
See `scripts/data/kpgd-diagram-comparison.md` and `src/airport/kpgd/build-report.md`. 12 of the 18 diagram identifiers exist in OSM; **A1, A3, A4, G1, G2, G3 have no OSM ref** (no label georeferencing was done, so the unnamed lanes were not assigned to them). 73 of the 93 OSM taxiway ways carry no ref: 8 turn-on fillets are collapsed, 6 took an identifier by continuity, 59 stay unnamed. For all 12 derived hold lines (250 ft from the centreline, documented simplification) an OSM `holding_position` node lies within 6.1 m (8 within 0.1 m).

## Parking
Ten airline stands: OSM `parking_position` ways with ref 1-10 (OSM `gate` nodes exist for refs 1, 2, 2A, 3-7; the stand is the lead-in end nearer the terminal; ways 7-10 are digitised outwards and reversed by the profile). Three OSM `parking_position` ways without a ref on the south ramp are GA stands. OSM has no FBO apron and no stand features on the west apron, so two FBO and five GA spots are SYNTHETIC grid points inside the OSM apron polygon west of the terminal (the diagram's NORTH RAMP), flagged `source: synthetic`, `approximate: true`. No cargo ramp, no Coast Guard or military ramp: none mapped or sourced.

## Traffic profile (gameplay data; `src/game/airportProfile.ts`)
Sources retrieved 2026-10-21: flypgd.com home page ("Sun Country and Allegiant provide low-cost, nonstop air service to more than 50 destinations"); flypgd.com/airlines/ (Allegiant destination list; Sun Country seasonal Minneapolis-St. Paul December to April); flypgd.com/destinations-map/ (50 airport codes); Wikipedia fleet tables (Allegiant: A319-100, A320-200, 737 MAX 200; Sun Country: 737-800, 737-900ER; dated Dec 2025 / Jan 2026). The airport pages name **no aircraft types and do not say which cities are nonstop in which season**: the types come from the airlines' fleets and are UNVERIFIED per route; the mix (Allegiant 92 %, Sun Country 8 %; A320, A319 and 737 MAX 8 as `B38M` equally likely) and the 21 destinations (a subset of the 50 codes with spoken names) are DESIGN VALUES. Flight schools: none sourced (flypgd.com mentions only Charlotte Technical College's new aviation training facility), so no flight-training traffic. Neighbours for VFR traffic (reference coordinates from NASR APT_BASE): KFMY, KVNC, KSRQ, KAPF, KIMM, KLAL. Special traffic: VFR transitions (Class D) and vehicles only (design rates).

## Live weather
`curl https://api.weather.gov/stations/KPGD/observations/latest` (2026-10-21): HTTP 200, a decoded observation (Clear, 22 C, wind 12.96 km/h) with an **empty `rawMessage`**; same behaviour as KMHT (the app rebuilds the METAR from the decoded fields; the sim's source `src/weather/liveWeather.ts` is airport-generic).

## Not verified (KPGD)
* Current (2026) magnetic declination (NASR 6 W, epoch 2020); Class D dimensions; traffic pattern altitude (blank in NASR); the Chart Supplement text.
* Plate transcriptions (fix roles, minima, missed approaches, route order) are human readings of rendered PDFs. The ILS 4 role of CISTS (FAF) versus ISOXE (step-down) follows the printed "FAF to MAP 4.8 NM"; the feeder roles of VIOLA, ROGAN and PINTS follow plan-view arrows.
* Which Allegiant aircraft type flies which route, which destinations are served in the simulated season, and the airline mix.
* OSM positional accuracy; taxiways A1, A3, A4, G1-G3 (absent from OSM); real FBO / GA stand positions; the real gate numbering (OSM refs 1-10, "2A" has only a gate node).
* The tower closes at 2100 local in reality; the simulator does not model it.

## Raw files (`raw/`, not committed)
`nasr_2026-10-01/`, `d-TPP_Metafile_2610.xml`, `kpgd_dtpp_2610_pdfs/` (11 PDFs), `kpgd_dtpp_http_head_checks.tsv`, `overpass_kpgd_raw.json`.

# KPHL (Philadelphia International, PA) - verified source data

Added 2026-10-21 the same way as KMHT: `scripts/extract-nasr-airport.ts PHL KPHL 2026-10-01 2026-10-21` (NASR rows), `scripts/osm-overpass-to-geojson.ts` (OSM), a transcription of the d-TPP plates, then `npx tsx scripts/build-airport.ts KPHL`. Nothing was typed from memory; every value was read from the downloaded files. NASR cycle 2026-10-01 (CSV zips of 2026-10-16, shared `raw/nasr_2026-10-01/`), d-TPP cycle **2610** (volume **NE-4**), all checks and downloads on **2026-10-21** (HTTP check times are UTC, 2026-10-22T01:13Z).

## Files

| File | What | Source (URL) | Retrieved | License |
|---|---|---|---|---|
| `kphl-facility.json` | ARP, elevation, variation, 4 runways / 8 ends (thresholds, displaced threshold 27L, TDZE, lighting, VGSI, declared distances), tower hours, Class B flag, 6 ILS summary, remarks; plus `airport.time_zone` and `runway_configurations` from `kphl-facility-extras.json` | NASR `01_Oct_2026_{APT,ATC,CLS_ARSP,ILS}_CSV.zip` (`https://nfdc.faa.gov/webContent/28DaySub/extra/`); charted magnetic headings from the diagram | 2026-10-21 | US Government work |
| `kphl-frequencies.json` | The 82 FRQ.csv rows with SERVICED_FACILITY = PHL (the PHL TRACON's rows for Newark, Teterboro, Trenton... are excluded), summarised by function, sectors kept | NASR `FRQ_CSV.zip`, `ATC_CSV.zip` | 2026-10-21 | same |
| `kphl-navaids.json` | 6 ILS systems (LOC/GS/DME), OOD, MXE, DQO, PTW, CYN, ARD, RBV and the STAR VORs (HAR, LRP, ETX, LVZ, PSB, JST, CFB, DNY, GVE), 84 fixes with NASR coordinates and plate roles | NASR `NAV/ILS/FIX_CSV.zip`; roles from the plates | 2026-10-21 | same |
| `kphl-procedures.json` | All 38 d-TPP records with URL and HTTP check (`raw/kphl_dtpp_http_head_checks.tsv`, 38 x 200 application/pdf, User-Agent atc-simulator-research/1.0); transcription of the diagram, 15 approaches, PHILADELPHIA FOUR, BOJID FOUR, PAATS FOUR, hot spots | `https://aeronav.faa.gov/d-tpp/2610/<pdf>`, metadata `https://aeronav.faa.gov/d-tpp/2610/xml_data/d-TPP_Metafile.xml` | 2026-10-21 | same |
| `kphl-plate-geometry.json` | Glidepath angle / TCH and missed approach altitudes for the 22 instrument approaches | the plates (visual read for 15, pdfjs-dist text layer for 7) | 2026-10-21 | same |
| `kphl-facility-extras.json` | Hand-added sourced constants: runway configurations (west / east flow) with quotes, the documented night preferential use (not used), time zone | PHL Noise Office `https://phl.org/Noise-Office`; Noise Exposure Maps Update 2010 `https://www.phl.org/drupalbin/media/2010%20Noise%20Exposure%20Maps%20Report_Part1.pdf` | 2026-10-21 | public documents of the airport |
| `kphl-taxiways.geojson` | 936 OSM aeroway features within 2500 m of the ARP (325 taxiways, 183 parking_position lines, 127 gates, 34 taxilanes, 21 aprons, 22 terminals, 8 hangars, 5 runway ways ...) | Overpass `https://overpass-api.de/api/interpreter` (OSM base 2026-10-22T01:42:36Z), raw `raw/overpass_kphl_raw.json` | 2026-10-21 | **ODbL 1.0, (c) OpenStreetMap contributors** |

OSM query (radius 2500 m): `[out:json][timeout:180]; nwr["aeroway"~"^(runway|taxiway|apron|parking_position|holding_position|helipad|terminal|gate|taxilane|aerodrome|hangar|stopway|navigationaid|windsock)$"](around:2500,39.87208388,-75.24066305); out geom;`.

## Key facts (NASR 2026-10-01 unless noted)

**Airport:** PHILADELPHIA INTL, PHL / KPHL, Philadelphia PA, FAR 139, ATCT-TRACON FAA 24 h (radio call "PHILADELPHIA"), **Class B** (CLS_ARSP). ARP **39.87208388 N, 75.24066305 W**, elevation 35.9 ft, variation **12 W (epoch 2020; the diagram prints VAR 12 W, JANUARY 2020, annual change 0.0)**.

| Runway | Size (ft) | Ends (true / charted mag) | Notes |
|---|---|---|---|
| 8/26 | 5001 x 150 | 8: 75 / 088, 26: 256 / 268 | ILS 26 I-LLH 111.55 (offset localizer, GS 3.15); no approach to 8 |
| 9L/27R | 9500 x 150 | 9L 75 / 087, 27R 255 / 267 | ILS I-VII 108.95 (9L), I-PDP 108.95 (27R); 27R LDA 8864 |
| 9R/27L | 12000 x 200 | 9R 75 / 087, 27L 255 / 267 | ILS I-PHL 109.3 (CAT IIIB, ALSF-2), I-GLC 109.3; **27L displaced threshold 1913 ft**, LDA 9912 |
| 17/35 | 6500 x 150 | 17: 159 / 171, 35: 339 / 351 | ILS Z 17 I-MYY 108.75 (OPERATIONAL RESTRICTED); 35 RNAV (GPS) only |

Frequencies (MHz): D-ATIS arr 133.4 / dep 135.925; Clearance 118.85; Ground 121.9 (GND/S 121.65); Tower 118.5 (8/26, 9L/27R, 17/35) and 135.1 (9R/27L); Approach 124.35 (APCH/P DEP/P initial contact); departure sectors DEP/P 119.75 (090-269, SOUTH DEP CON) and 124.35 (270-089, NORTH DEP CON); altitude-stratified approach sectors 123.8, 126.85, 127.35, 128.4, 133.875; Final 125.4; PRM 120.425 (27L), 123.6 (26); UNICOM 122.95. The simulator works ATIS, CLNC, GND, TWR, APP and the two DEP sectors; the rest are listed as non-position frequencies. The diagram, the plates and the DP chart print the same values (checked).

**Primary navaid:** there is none at the field (the PHL VOT 109.8 is a test signal): OOD VORTAC (WOODSTOWN, 112.8, 75X, NJ) is used because most KPHL plates hold the missed approach there.

## Plate transcription (what was read, from which PDF)

All 38 PDFs in `raw/kphl_dtpp_2610_pdfs/`, text layers (pdfjs-dist) in `raw/kphl_dtpp_2610_txt/` (the text layer of the plan views is fragmented, so the charts were rendered with pdftoppm at 240 dpi - the airport diagram at 450 dpi and rotated - and **read visually**; the text layer cross-checked numbers):

* **Airport diagram `00320AD.PDF`**: 62 taxiway identifiers (A A1 A2 A3 B D D1 D2 D4 E E1-E5 F G H J J1 K K1-K8 L M N P P2-P6 Q R S S1-S8 S11-S13 SS SS1 SS3 T TA U V W Y Z), charted headings, frequencies, pavement strength (PCR), lighting, caution note, hot spots HS 1 (Twy S7/Y at 9R-27L) and HS 2 (Twy K/D at 35 and 27R) circled; circled A4/A5/A symbols and P symbols are not taxiways (see `scripts/data/kphl-diagram-comparison.md`).
* **ILS / LOC**: `00320IL9L` (Amdt 5 24MAR22), `IL26` (4E), `IL27L` (16), `IL27R` (10J), `IZL17` (ILS Z 9A), `IZLZ9R` (ILS Z 9R, 10), `IV9RCON`, `IV17CON` (converging, simultaneous): fixes in route order with roles (IAF / IF / FAF / step-down / missed approach hold), minima summary, missed approach verbatim, plate notes, GS and TCH. **RNAV (GPS)**: `R17`, `R26`, `R27L`, `R27R`, `R35`, `RY9L` (Y), `RY9R` (Y). Special-authorization / CAT II-III (`IZ9RSAC1`, `I27RSAC1_2`, `IZ9RC2_3`, `I9LSAC2`, `I27LSAC2`) and RNP Z 9L / 9R are listed with TCH and missed approach text only; the three visual approaches (FREEDOM, LIBERTY, RIVER) are listed in `visual_approaches`.
* **PHILADELPHIA FOUR (`00320PHILADELPHIA` + `_C`)**: radar-vector departure, "Climb on heading assigned by ATC"; 27L/R 2200L-0600L climbing left turn heading 245; takeoff minimums (also `NE4TO.PDF`, entry AMDT 11 25FEB21); "TOP ALTITUDE: ASSIGNED BY ATC" (no maintain altitude is stated, so none is stored: the simulator's default initial altitude of 2000 ft is a design value); NORTH DEP CON 124.35 / SOUTH DEP CON 119.75 by first fix.
* **STARs**: see below. **`NE4HOTSPOT.PDF`**: HS 1 and HS 2 text.

### BOJID FOUR and PAATS FOUR (`stars[].star`, shape of ROZZE TWO)

Chosen because they are the two RNAV STARs that together cover every runway: **PAATS FOUR** (south / southwest: transitions BBDOL, GORDONSVILLE, HYTRA; the only RNAV STAR with JIIMS FOUR that serves 9L, 9R, 17, 26, 27L, 27R and 35) and **BOJID FOUR** (west / Harrisburg corridor: Johnstown and Philipsburg transitions; 9L/R and 27L/R). **No official statistic of STAR usage was found** (phl.org Noise Office, FAA documents and web searches 2026-10-21); a flight-simulation forum post calls BOJID the "probably the most used arrival" (anecdote, not a source), so "most used" is NOT established. Not transcribed: BUNTS THREE, JIIMS FOUR, SLATT SIX, SPUDS SEVEN (listed with URL).

* Each runway route is stored from the common fix (ESSSO for PAATS, HAR for BOJID) through the published runway body; the chart ends "then on track/heading N, expect RADAR vectors to final approach course"; `then_heading_mag_deg` is NOT set so that the simulator continues over the plate's join fixes (`join_approach_fixes`: the IF / first fixes of the ILS or RNAV plate, e.g. 27R MRTIN JALTO, 9L QWEST OBEKE ANNET, 35 JEPUG HARLU) as for KMHT's runway legs that have an approach.
* **Neither chart prints any altitude or speed crossing restriction** (only MEAs along the legs, the 210K hold speed, and "Expect 8000" at BUNTS), so `restrictions` is empty.
* Verification: every printed leg distance and magnetic track agrees with the NASR fix coordinates (variation 12 W) within 1.5 NM / 3 degrees (`src/airport/kphl/stars.test.ts`, which also reads NASR `STAR_RTE.csv` when the download is present: the runway bodies ESSSO-ERNYY / ESSSO-MKORD / ESSSO-TEBEE, HAR-FERUS / HAR-WHEYY and all five transitions match).
* Simulator entry fixes (`sim_entry_fixes` in the STAR data, read by `starArrival`; DESIGN VALUE, distances from the ARP): **PAATS FOUR: CANNY (about 49 NM) and HEDGE (about 61 NM)**, both on every transition; **BOJID FOUR: TRAGG (about 40 NM) and LRP (about 60 NM)**; spawn altitude 10000-12000 ft (no published window). The entry fixes are data, so `src/game/ifr.ts` needed no KPHL edit.

## Runway configurations (new facility field `runway_configurations`)

From `kphl-facility-extras.json` (quotes inside): west flow (arrivals 27R, 27L, 26, 35; departures 27L, 27R, 35; about 70 percent of operations per the Noise Office, 81 percent of the time in 2008) and east flow (arrivals 9R, 9L, 17; departures 9L, 9R, 8, 17), Noise Exposure Maps Update 2010 sections 2.5.2 and 3.3 and phl.org. 2008 utilisation (Table 3-3): 27L 34.7, 27R 30.1, 35 10.3, 9R 8.3, 9L 8.2, 26 5.6, 17 1.2, 8 1.6 percent of operations; 27R primary jet arrival runway, 27L primary jet departure runway, 26 and 35 for propeller and regional aircraft. Night preferential use (midnight to 6 am; NEM: 11 pm to 6 am) is documented but kept out of `runway_configurations` because the selection by wind has no time of day. **No wind limits or sectors are published, so none are stored** (the simulator selects by arrival headwind). The FAA Capacity Enhancement Program EIS / runway 17-35 documents were not downloaded; the NEM figures are 2008-2009 data.

## Changes to `scripts/extract-nasr-airport.ts`

Runway end keys keep the L/R suffix ("09L" -> "9L"); frequency rows are selected by SERVICED_FACILITY (a TRACON serving many airports); D-ATIS rows (ARR/DEP) are the ATIS; several LCL/P rows (second tower), GND/S, PRM, FINAL APCH, sectorized APCH/P and DEP/P, STAR frequencies and CLASS B rows are summarised in `summary_by_function`; `airspace.class` "B"; optional `<slug>-facility-extras.json` merged (time zone, runway configurations). KMHT output is unchanged except for one `"sectorization"` omission rule and two note wordings (not regenerated).

## Taxiways, parking and the build

57 of the 62 diagram identifiers are in the graph (K2, K3, P6, S12, S13 are not in OSM; A1 is mapped as an isolated loop and excluded: `profile.excludeOsmWays`; the resulting single entry on the east half of 8/26 is a documented `profile.knownGaps` item); OSM-only refs S9, S10 and "8" are geometry without identifier. One runway-runway crossing (9L/27R x 17/35, `RWX-9L-27Rx17-35`, hot spot HS 2). 59 derived holds (OSM has no holding_position nodes). Parking: 114 airline stands (terminals A West/East, B-F, OSM `parking_position` lines inside the terminal apron polygons within 100 m of the mapped network), 8 cargo stands (FedEx 1-5, UPS 3), 5 GA stands (North Apron), 3 FBO spots (synthetic, inside the OSM "Atlantic Aviation" apron); 29 airline gates and some cargo stands exceed the 150 m connector limit (flagged, because OSM has no taxilane network on the terminal aprons). Comparison and decisions: `scripts/data/kphl-diagram-comparison.md`, `src/airport/kphl/build-report.md`.

## Traffic (airportProfile.ts)

Airlines: those phl.org lists on `https://www.phl.org/about/airlines` (copy `raw/kphl_traffic/phl_airlines.html`): Aer Lingus, Aeromexico, Air Canada, Alaska, Allegiant, American, American Eagle, British Airways, Delta, Frontier, JetBlue, Lufthansa / Eurowings Discover, Qatar, Southwest, Sun Country, United. Routes: the Wikipedia PHL airlines-and-destinations table (2026-10-21). Fleets: Wikipedia fleet tables (American, Frontier, UPS Airlines, American Eagle); Delta, United, JetBlue, Alaska, Sun Country and Southwest are A320 / B738 **stand-ins** (not looked up). UPS: Wikipedia "regional cargo hub" / East Coast Region Air Hub; the destination (Louisville) is an ESTIMATE. FedEx is not listed for PHL: no flights (OSM maps FedEx stands). Not generated: all non-US airlines and long-haul widebody flights (no parser-known destination; types for those airlines' PHL routes not sourced), Allegiant (no destination in the parser), VFR Class B transitions (the engine models Class C service), military / Coast Guard (no unit sourced). Neighbours: NASR coordinates of KPNE, KLOM, KILG, KTTN, KVAY, KMIV, KMQS, KOQN, KDYL, KPTW. Weights are design values. Aircraft types of the KPHL airlines come from the 34-type performance model.

## Not verified (KPHL)

* Plate transcriptions are human readings of rendered PDFs (fix roles, DA / MDA / RVR, missed approach, the order of fixes in the simulator route); the RNAV 17 plate prints TDZE 10 where the ILS 17 plate prints 11.
* Which STAR is most used (see above); the OSM-only way "8" and the lone digit near taxiway H on the diagram; NASR variation epoch 2020; Class B dimensions (shape files not downloaded); traffic pattern altitude (blank in NASR).
* Runway configuration percentages are 2008 (and a 2013 forecast); current numbers and wind criteria were not found.
* Airline fleets of Delta, United, JetBlue, Alaska, Sun Country, Southwest; UPS route; all weights.
* OSM positional accuracy; taxiway identifiers inferred by continuity (200 ways, listed in the build report).

## Live weather

`curl https://api.weather.gov/stations/KPHL/observations/latest` returned 200 with an observation (2026-10-22T01:55Z: wind 340 at 7 kt, visibility 10 SM, 13 C, pressure 1019.3 hPa) and an empty `rawMessage`; the app builds the METAR from the decoded fields exactly as for KMHT (CORS is open on api.weather.gov; AWC is not).

## Raw files (`raw/`, not committed)

`kphl_dtpp_2610_pdfs/` (38 PDFs), `kphl_dtpp_2610_txt/`, `kphl_dtpp_http_head_checks.tsv`, `overpass_kphl_raw.json`, `kphl_runway_config/` (noise_office.html, nem2010_part1.pdf and its text, FAA ROA), `kphl_traffic/` (phl.org airlines and cargo pages).

# EGLL (London Heathrow) - hand-transcribed from the UK AIP

First airport outside the US. There is no FAA data and no machine-readable AIP licence, so the source files were **transcribed by hand from the UK AIP** (a script only extracted the text of
the eAIP pages and PDFs, and converted DMS coordinates to decimals; a person read the text and entered every value). Every field names its AIP section in a `*_source` or `note` field; fields with
no AIP equivalent are `null` with a note. Retrieved **2026-10-21**, then `npx tsx scripts/build-airport.ts EGLL`.

**Cycle:** UK AIP **AIRAC 10/2026, effective 01 OCT 2026** (GEN 0.2: amendment 10/2026 published 20 AUG 2026), next AIRAC 11/2026 effective 29 OCT 2026 (the offline index also lists 12/2026 on 26 NOV 2026).
Chart footers show AERO INFO dates between 05 NOV 25 and 20 APR 26 (the date of each chart's last change).

## Downloads (all HTTP 200, 2026-10-21)

| What | URL | Size / note |
|---|---|---|
| AIP index page (links to the current AIP, amendments, HTML and PDF downloads) | `https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/AIP/` | 20,010 bytes, saved `raw/egll/aip_index.html`; footer "(c) Copyright NATS Limited 2026" |
| eAIP front frameset (online version, dynamic path per AIRAC) | `https://www.aurora.nats.co.uk/htmlAIP/Publications/2026-10-01-AIRAC/html/index-en-GB.html` | |
| AD 2.EGLL | `.../2026-10-01-AIRAC/html/eAIP/EG-AD-2.EGLL-en-GB.html` | 739,746 bytes, `raw/egll/EG-AD-2.EGLL-en-GB.html` (+ `.txt` extracts) |
| GEN 0.1 (preface: publishing authority, terms), GEN 0.2 (record of amendments), GEN 1.7, GEN 2.2, GEN 3.5 (meteorology: QNH Q-group, ATIS) | `.../eAIP/EG-GEN-0.1-en-GB.html`, `-0.2`, `-1.7`, `-2.2`, `-3.5` | `raw/egll/` |
| ENR 4.1 (radio navigation aids - en-route), ENR 4.4 | `.../eAIP/EG-ENR-4.1-en-GB.html`, `EG-ENR-4.4-en-GB.html` | cross-check of OCK / BIG / LAM / BNN / LON |
| 62 chart PDFs AD 2-EGLL-2-1 ... 8-13 (links in AD 2.24) | `https://www.aurora.nats.co.uk/htmlAIP/Publications/2026-10-01-AIRAC/graphics/<id>.pdf` | each HTTP 200 `application/pdf`, sizes in `raw/egll/pdf_http_checks.tsv`, saved `raw/egll_aip_pdfs/` (git-ignored, for reading only) |
| NATS terms and conditions | `https://nats-uk.ead-it.com/cms-nats/opencms/en/agb/` | `raw/egll/nats_terms.txt` |
| Heathrow runway alternation page and 2026 programme PDF | `https://www.heathrow.com/company/local-community/noise/operations/runway-alternation`, `.../Heathrow_Runway_Alternation_Programme_2026.pdf` | operator publication, 177,157 bytes |
| Heathrow airline list | `https://www.heathrow.com/airline-contact-info` | ~90 airlines |
| CAP 413 Radiotelephony Manual Edition 24 (1 July 2026) | `https://www.caa.co.uk/publication/download/18165` | 2,989,016 bytes, `raw/cap413/`; the URL given in the task (`.../download/13339`) now serves another document |
| OpenStreetMap (Overpass) | `https://overpass-api.de/api/interpreter` | 903,015 bytes, `raw/overpass_egll_raw.json`, base timestamp 2026-10-22T01:17:10Z |
| AWC check | `https://aviationweather.gov/api/data/metar?ids=EGLL&format=json` | returned `METAR EGLL 220050Z AUTO 20008KT 9999 -RA FEW048 10/07 Q1007` |

## Licence and what is bundled

* AIP index page footer: **"(c) Copyright NATS Limited 2026"**. GEN 0.1 para 3.1: "AIS make Aeronautical Information Products (excl VFR Charts) freely available on the internet". GEN 0.1 para 5
  (UK Aeronautical Information Product Terms and Conditions): NATS "cannot guarantee the accuracy or completeness of content" and "accepts no liability for your use of UK Aeronautical Information Products";
  para 5.5: "Every data user is liable for any damages caused by any modification made by it to the data". The NATS terms page: by using any UK Aeronautical Information Products "you agree and accept to be bound by
  these Website Terms and Conditions", "© Copyright NATS Limited 2021".
* No licence granting redistribution was found (no Open Government Licence statement on the eAIP pages or the terms). **Conclusion:** the chart PDFs are **linked, not bundled**: the chart index
  (`src/charts/chartIndex.ts`) lists the official URLs with `linkOnly: true`, `isOfficialFaa: false`; the chart viewer shows the links (`LinkOnlyCharts.tsx`); `scripts/fetch-charts.ts` skips EGLL;
  nothing is proxied or cached. The facts transcribed from the AIP (frequencies, coordinates, procedure data) are kept with attribution in these files and in every `provenance` entry; the PDFs and the
  eAIP pages themselves are not committed (`data/sources/raw/` is git-ignored). The simulator is not an Aeronautical Information Product and does not claim to be one. The cycle-specific URLs
  expire with the AIRAC (29 OCT 2026); the chart panel says so and links the AIP index page.
* The operator pages (heathrow.com) carry no stated licence either; only short facts are used (runway alternation rule and table, airline names), each with its URL.

## Files

| File | What | Source |
|---|---|---|
| `egll-facility.json` | ARP, elevation 83 ft, variation 1.23 E (2027, annual change 0.17 E), Class D (AD 2.17), runways 09L/27R and 09R/27L (AD 2.12: bearings, dimensions, thresholds, elevations; AD 2.13 declared distances incl. intersection take-offs; AD 2.14 lighting, PAPI MEHT), ILS per end, `runway_configurations`, `alternation_programme_2026`, `noise_and_operating_rules`, remarks, unverified list | AD 2.2, 2.12-2.15, 2.17, 2.19-2.22; operator alternation programme |
| `egll-frequencies.json` | Heathrow Delivery / Ground / Tower / Director / Radar / Information / Fire, London Control per SID chart | AD 2.18, SID chart headers |
| `egll-navaids.json` | LON, OCK, BIG, LAM, BNN, DET, MID, SAM, CPT, BPK, EPM, CHT, WOD, BUR; four ILS/DME (localizer, glidepath, DME antenna coordinates); 42 fixes: 34 STAR waypoints from the coding tables + 8 DERIVED ILS DME fixes | AD 2.19, ENR 4.1, AD 2-EGLL-7-13..7-17, SID charts |
| `egll-procedures.json` | chart list with URLs and HTTP checks; 12 approach charts (the four ILS/DME transcribed: OCA, RDH, FAP, missed approach verbatim and simplified); aerodrome chart identifiers and hot spots HS1-HS5; 24 SIDs (NPR route text from AD 2.21, cap 6000 ft); 18 RNAV STARs transcribed from the coding tables (`sim_entry_fixes` are DESIGN VALUES) | AD 2.24 charts, AD 2.21, 2.22 |
| `egll-plate-geometry.json` | GS 3 deg, RDH (the UK plates print the ILS reference datum height where FAA plates print TCH) and missed approach of the four ILS plates | plates 8-1, 8-4, 8-7, 8-10 |
| `egll-holding-patterns.json` | missed-approach holds CHT / EPM (AD 2.22 para 2) and the four terminal holds (hold coding tables 7-18, 7-19), attached to each ILS entry | AD 2.22, 7-18/7-19 |
| `egll-stands.json` | stand numbers read from the four stand charts (T5 2-4, T4 and cargo 2-5, T3 2-6, T2 2-7) | AD 2-EGLL-2-4..2-7 |
| `egll-taxiways.geojson` | OSM aeroway features within **3000 m** of the ARP (1,457: 415 taxiway ways, 371 parking_position, 288 holding_position nodes, 148 gates, 38 aprons ...) | Overpass; **ODbL 1.0, (c) OpenStreetMap contributors**: attribution required, the derived layer is share-alike |

Overpass query: `[out:json][timeout:180];nwr["aeroway"~"^(runway|taxiway|apron|parking_position|holding_position|helipad|terminal|gate|taxilane|aerodrome|hangar|stopway|navigationaid|windsock)$"](around:3000,51.4775,-0.46138889);out geom;` (User-Agent sent).

## Key facts and how each was read

* **Runways (AD 2.12, 2.13).** 09L/27R 3901 x 50 m, asphalt grooved, PCR 1020/R/A/W; 09R/27L 3658 x 50 m, PCR 820/R/A/W. True bearings 089.67 / 269.71 and 089.68 / 269.72; the charts print 088 / 268 magnetic.
  TORA/TODA/ASDA/LDA: 09L 3901/3901/3901/3592 (displaced 309 m), 27R 3882/3960/3882/3882, 09R 3658/3658/3658/3350 (displaced 308 m), 27L 3658 all. **The AIP threshold coordinates of 09L and 09R are the displaced
  landing thresholds** (checked: the distance 09L THR - 27R THR is 3592.5 m = the 09L LDA; 09R THR - 27L THR 3350.6 m = the 09R LDA). The simulator wants the pavement end in `threshold`, so the pavement ends are
  **DERIVED**: the AIP threshold moved back 309 / 308 m along the reciprocal bearing (`threshold.note` says so). The 19 m by which 27R's declared distances are shorter than the pavement is unexplained in the AIP.
* **ILS (AD 2.19).** I-AA 09L and I-RR 27R 110.300 (DME 40X), I-BB 09R and I-LL 27L 109.500 (DME 32X), all CAT III, 3 deg, RDH 51 / 58 / 50 / 56 ft. The ILS DME reads zero at the landing threshold (AD 2.19 remark);
  the course in degrees is DERIVED (true bearing - 1.23 = 88.44 etc.; the plates print the rounded 088 / 268).
* **Derived DME fixes** (`AAIF`/`AAFAP`, `BBIF`/`BBFAP`, `LLIF`/`LLFAP`, `RRIF`/`RRFAP`): IF = D10 ("to be established on the localiser by I-xx D10", initial approach charts 7-20..7-26), FAF = D7.5 (the plate's FAP). The AIP names no
  waypoints on the ILS final; the simulator's on-course logic needs named fixes. Positions: D10 / D7.5 from the landing threshold along the reciprocal of the true bearing. **Check:** the distance of each D7.5 point to LON agrees
  with the "LON D8.2 / 8.8" printed on the plates within 0.05 NM, and D4 with "LON D4.7 / 4.8 / 5.4 / 5.3" (`egll.test.ts`).
* **Frequencies (AD 2.18).** Delivery 121.980; Ground 121.705 (alternates 121.855, 121.905); Tower 118.505 (118.705, 124.480); Director 119.730 (120.400, 127.525, 134.980 "when instructed by ATC"); Radar 125.625;
  ATIS "Heathrow Information" 128.080 (also on Bovingdon VOR 113.750 and Seaford VOR 117.000), departure ATIS 121.935. Departures go to London Control (134.125, 133.180, 118.825, 119.780, 120.530 by SID chart).
* **Airspace (AD 2.17).** LONDON CTR and CTA/C are **Class D** (SFC to 2500 ft AL, transition altitude 6000 ft, ATS unit "HEATHROW RADAR"), not Class A.
* **Navaids.** AD 2.19 lists LON, OCK, BIG, LAM, BNN as VOR/DME, ENR 4.1 lists them as DME with "No associated En-route VOR", and the SID charts say "LON VOR N/A, BIG VOR N/A" (RNAV substitution). Both are recorded; the type
  follows AD 2.19.
* **STARs.** 18 RNAV1/RNAV5 STARs (OTMET 1H, ROXOG 1H, ALESO 1H, LAM 1X, TANET 1Z, OCK 1Z, NUGRA 2H, LAM 1Z, HON 2H, BARMI 1H, LOGAN 2H, TOBID 1X, HAZEL 1H, BIG 1Z, LAM 1Y, FITBO 2H, SIRIC 1H, SIRIC 1Z), each ending at
  one of the four holds (OCK, BIG, LAM, BNN). Coordinates, tracks, distances, level and speed constraints are the coding-table values (text layer, parsed by script and cross-checked by `egll.test.ts`: every leg within 1 NM and
  2.5 deg of the great-circle values). Level depiction: a bare level in the table is an AT level (both bars checked on charts 7-1 and 7-8); the stack fix level FL070 is the minimum holding level (AT OR ABOVE). Only these two
  charts were checked at the bar level; the rest follow the same convention (UNVERIFIED per chart).
* **SIDs.** Six charts x four runway directions (AD 2-EGLL-6-1..6-6): CPT 5J/4K/3F/3G, MODMI 1J/1K and MAXIT 1F/1G, BPK 6J/5K/7F/7G, ULTIB 1J/1K and UMLAT 1F/1G, DET 1J/1K/2F/2G, GASGU 2J/2K and GOGSI 2F/2G. Route text is
  AD 2.21 sub-para 8 (noise preferential routes). `maintain_altitude_ft` 6000 is the cap printed on every chart ("Due to interaction with other routes do not climb above 6000 until cleared by ATC"); the AIP prints no "initial climb
  altitude". The simulator flies runway heading then vectors; the SID is only named in the clearance (hash of the callsign among the SIDs of the departure runway: DESIGN VALUE).
* **Runway configurations.** `W-ALT-27R`, `W-ALT-27L` (land one runway, depart the other; max tailwind 5 kt, AD 2.20 para 6), `E-SEG-09L` (land 09L, depart 09R). Alternation, Cranford ("has now ended" but alternation on easterly
  operations needs infrastructure works first) and TEAM are from the operator page, not the AIP. The weekly rule was checked against all 52 rows of the 2026 table (0 exceptions).
* **Stands.** OSM `parking_position` ways with a three-digit ref that appears on the AIP stand charts (195 stands: 183 airline in Terminals 2-5, 12 cargo). MARS L/R variants, unnumbered ways and stands 611-613, 703, 704 (not on the charts)
  are not used. Gates (OSM `gate` nodes) sit inside the terminals and are not used. The terminal of a stand follows the chart it is on.
* **Taxiways.** The 18 main taxiways exist in OSM as "Taxiway X" (profile maps to "X"); see `scripts/data/egll-diagram-comparison.md`. Identifiers with a suffix letter (A9E ...) and "Link nn" stubs are not named (the command
  parser takes a letter and up to two digits); numbered exits that exist in OSM (A1-A13, N1 ...) are named.
* **Hot spots.** HS1/HS2 (lookout, wing tip clearance), HS3 (Link 28 east of Taxiway Alpha not Code F compliant), HS4 (clearance to enter the runway before crossing the holding point), HS5 (mis-route after vacating): text of the aerodrome chart, no position.
* **Weather.** GEN 3.5 para 3.8.10: QNH in whole hPa, Q group; metres visibility; METAR example in this repo's test is the AWC record retrieved 2026-10-22.
* **Traffic.** Airlines: heathrow.com list (British Airways dominant). BA aircraft: BA "Fleet facts" page (A319, A320/A320neo, A321/A321neo, A350-1000, A380-800, 777-200/-300, 787-8/-9/-10, E190 not generated). Virgin
  Atlantic: its 2024 fleet press release (A330-900, A350-1000, 787-9). Other carriers' types, all weights and destinations: ESTIMATE / DESIGN VALUE. Telephony (Speedbird, Virgin, Shamrock, Lufthansa, Emirates, American, Delta, United):
  ICAO Doc 8585 words present in FAA JO 7340.2P chapter 3 (checked by search of the page text, retrieved 2026-10-21).

## Not verified (EGLL)

* The 2026 magnetic variation (the AIP prints the 2027 value); the PAPI threshold crossing height (only MEHT is published, `threshold_crossing_height_ft` is null); the ATIS phone number; UHF frequencies.
* The 19 m difference of 27R; the exact pavement ends of 09L and 09R (derived).
* STAR level-bar depiction beyond charts 7-1 and 7-8; the SID altitude constraints beyond the route text (the CPT, MODMI and MAXIT tables were read from renders, the others use AD 2.21 text); LOC/DME and RNP charts (listed, not read).
* Whether the VORs of LON / OCK / BIG / LAM / BNN are in service (AD 2.19 versus ENR 4.1 versus SID charts).
* OSM: positional accuracy, completeness of stand numbers, whether any OSM taxiway differs from the chart; 7 stands have connectors over 150 m (flagged in the build report); one hold (HP9R-27L-U-1, an unnamed exit)
  fails the hold-path check and is downgraded to a warning (`relaxedChecks.holdPath`).
* Aircraft types of carriers other than BA and Virgin; airline weights; destinations.
* The CAP 413 Supplementary Instructions issued after Edition 24 were not applied.

## Raw files (`raw/`, not committed)

`egll/` (eAIP pages, text extracts, pdf_http_checks.tsv, terms, runway alternation page and PDF), `egll_aip_pdfs/` (62 chart PDFs), `overpass_egll_raw.json`, `cap413/` (CAP 413 Edition 24 PDF and text).
