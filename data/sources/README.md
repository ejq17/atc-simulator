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
