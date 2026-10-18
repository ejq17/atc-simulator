# FAA JO 7110.65 references used by the simulator

Verified on 2026-10-16 against the official HTML edition at
https://www.faa.gov/air_traffic/publications/atpubs/atc_html/ (chapter 3 sections 7, 9, 10; chapter 4 sections 2, 3, 8 and chapter 5 section 9 verified 2026-10-17; the Tower vocabulary paragraphs of the table's last block, with their phraseology, were read on 2026-10-18 from chapter 2 section 1, chapter 3 sections 1, 8, 9, 10, chapter 5 section 2, chapter 7 sections 2 and 6; 2-1-17, 2-4-17, 2-4-19, 2-9-3, 3-9-3, 4-3-3, 5-7-2 re-read for the phraseology audit, see docs/PHRASEOLOGY-AUDIT.md).
Only paragraph numbers and titles were verified; the simulator paraphrases the topic and does
not quote text. This software is not ATC training.

| Paragraph | Title | Used for |
|---|---|---|
| 2-1-17 | RADIO COMMUNICATIONS | Frequency change ("Contact Tower", "Contact Ground Point Seven") |
| 2-4-17 | NUMBERS USAGE | How every number is spoken (altitudes, headings, runways, frequencies, squawk, wind, altimeter) |
| 2-4-19 | FACILITY IDENTIFICATION | Facility names ("Boston Departure", "LaGuardia Clearance Delivery", "O'Hare Ground") |
| 2-9-3 | CONTENT | ATIS content and order |
| 3-9-3 | DEPARTURE CONTROL INSTRUCTIONS | "Departure frequency ..., squawk ..." |
| 4-3-3 | ABBREVIATED DEPARTURE CLEARANCE | Destination on first call, "cleared to ... airport, ... departure, then as filed" |
| 5-7-2 | METHODS | Speed adjustment phraseology |
| 3-5-1 | SELECTION (runway in use) | Wind runway at 5 kt or more; calm-wind runway below 5 kt |
| 3-7-1 | GROUND TRAFFIC MOVEMENT | Ground control basics |
| 3-7-2 | TAXI AND GROUND MOVEMENT OPERATIONS | Taxi clearances, explicit runway crossing clearances, hold-short readback |
| 3-7-4 | RUNWAY PROXIMITY | Hold positions |
| 3-9-4 | LINE UP AND WAIT (LUAW) | LUAW validation; traffic information ("closest traffic within 6 flying miles" requesting a landing operation on the same runway) is required with the instruction; NOTE "an aircraft should not be in LUAW status for more than 90 seconds without additional instructions" |
| 3-9-5 | ANTICIPATING SEPARATION | Departure sequencing |
| 3-9-6 | SAME RUNWAY SEPARATION | Takeoff clearance with runway occupied |
| 3-9-8 | INTERSECTING RUNWAY/INTERSECTING FLIGHT PATH OPERATIONS | 13/31 vs 4/22 simultaneous departures |
| 3-9-10 | TAKEOFF CLEARANCE | Takeoff clearance phraseology/validation |
| 3-9-11 | CANCELLATION OF TAKEOFF CLEARANCE | `CANCEL TAKEOFF CLEARANCE (reason)`; once the roll has started only for safety (NOTE: never for traffic management / EDCT). Implemented (`planCancelTakeoff`) |
| 3-10-3 | SAME RUNWAY SEPARATION | Landing clearance with runway occupied |
| 3-10-4 | INTERSECTING RUNWAY/INTERSECTING FLIGHT PATH OPERATIONS | Arrivals on intersecting runways |
| 3-10-5 | LANDING CLEARANCE | Landing clearance validation |
| 3-10-6 | ANTICIPATING SEPARATION | Arrival sequencing |
| 3-10-8 | WITHHOLDING LANDING CLEARANCE | Continue approach / go-around |
| 3-10-9 | RUNWAY EXITING | `TURN LEFT/RIGHT (taxiway/runway)`, `IF ABLE, TURN LEFT/RIGHT ...`, `HOLD SHORT OF (runway)`; examples "turn right next taxiway ... contact ground point seven", "turn left at Charlie, hold short of Runway 27 Right"; read back of hold-short instructions. Implemented (`EXIT_RUNWAY`) |
| 2-1-21 | TRAFFIC ADVISORIES | Wording of a traffic call (type, position, direction, altitude); the pilot's "traffic in sight" / "negative contact" |
| 3-1-6 | TRAFFIC INFORMATION | "Traffic, United Airbus Three Twenty-one on downwind leg to your left", "... on 2-mile final": description by position relative to the pilot |
| 3-8-1 | SEQUENCE/SPACING APPLICATION | `EXTEND DOWNWIND`, `MAKE SHORT APPROACH`, `NUMBER (n), FOLLOW (description and location of traffic)`, `MAKE LEFT/RIGHT THREE-SIXTY/TWO SEVENTY`, `CLEARED TO LAND / TOUCH-AND-GO / STOP-AND-GO / LOW APPROACH`, `CLEARED FOR THE OPTION` |
| 3-8-2 | TOUCH-AND-GO OR STOP-AND-GO OR LOW APPROACH | Such an aircraft is an arrival until it touches down (low approach: crosses the threshold) and a departure afterwards |
| 3-9-1 | DEPARTURE INFORMATION | Runway, surface wind, altimeter unless the pilot states the ATIS code or "have numbers" |
| 3-10-1 | LANDING INFORMATION | Pattern information (`ENTER LEFT/RIGHT BASE`, `MAKE STRAIGHT-IN`, `RIGHT TRAFFIC`, `CONTINUE`), runway, wind, altimeter unless the code or "have numbers" is given; requests for additional position reports |
| 3-10-11 | CLOSED TRAFFIC | `LEFT/RIGHT CLOSED TRAFFIC APPROVED. REPORT (position)`, `UNABLE CLOSED TRAFFIC` |
| 5-2-1 | ASSIGNMENT CRITERIA | `SQUAWK (code)` |
| 7-2-1 | VISUAL SEPARATION | Pilot-applied visual separation: traffic called, pilot reports it in sight, controller instructs to maintain visual separation (the simulator needs the traffic in sight before a "follow" is accepted) |
| 7-6-11 | TERMINATION OF SERVICE (Class C services) | `SQUAWK VFR, FREQUENCY CHANGE APPROVED`; `RADAR SERVICE TERMINATED, SQUAWK ONE TWO ZERO ZERO` |
| 4-2-1 | CLEARANCE ITEMS | IFR clearance elements (Clearance Delivery) |
| 4-3-2 | DEPARTURE CLEARANCES | IFR departure clearance with DP |
| 4-8-1 | APPROACH CLEARANCE | Instrument approach clearance |
| 4-8-9 | MISSED APPROACH | Missed approach handling |
| 5-9-1 | VECTORS TO FINAL APPROACH COURSE | Vectoring arrivals to the ILS/RNAV final |
| 5-9-2 | FINAL APPROACH COURSE INTERCEPTION | Intercept angle / distance from the FAF |
| 5-9-4 | ARRIVAL INSTRUCTIONS | Approach clearance with altitude until established |

Page URLs (the FAA site returns 403 to non-browser user agents; fetch with a normal browser UA):
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap2_section_1.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap2_section_4.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap2_section_9.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_1.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_5.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_7.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_8.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_9.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_10.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap4_section_2.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap4_section_3.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap4_section_8.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap5_section_2.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap5_section_7.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap5_section_9.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap7_section_2.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap7_section_6.html

## Other official data products used

| Product | Source | Used for |
|---|---|---|
| FAA MVA/MIA digital product, Atlantic City ATCT/TRACON chart `ACY_MVA_FUS3` (KML/AIXM/PDF) | https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/mva_mia/mva/ (geometry https://aeronav.faa.gov/MVA_Charts/kmz/ACY_MVA_FUS3.kml) | Minimum vectoring altitude sectors (visual reference only per the FAA memo; not for navigation) |
| FAA AC 150/5300-13B Chg 1, Appendix G | https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC-150-5300-13B-Airport-Design-Chg1-w-errata.pdf | Runway holding position distance (250 ft) |
| AIM 5-3-8 Holding | https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap5_section_3.html | Holding entries, speeds, leg timing |
| AIM 4-3-11 LAHSO | https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_3.html | Land-and-hold-short operations |
| 14 CFR 91.117 | https://www.ecfr.gov/current/title-14/part-91/section-91.117 | Speed limits below 10,000 ft and in Class C |
| AIM 4-3-2 / 4-3-3 Traffic Patterns | https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_3.html | Departure/upwind/crosswind/downwind/base legs; pattern altitude 1,000 ft AGL for propeller aircraft; crosswind turn beyond the departure end within 300 ft of pattern altitude; turn to final at least 1/4 mile out |
| AIM 4-1-20 Transponder and ADS-B Out Operation | https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_1.html | `SQUAWK VFR` = code 1200 (or other appropriate VFR code) |
| AIM 4-1-13 (ATIS) and 4-1-8 | https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_1.html | "Pilot use of 'have numbers' does not indicate receipt of the ATIS broadcast" (wind, runway, altimeter only) |
| AIM 4-1-18 Terminal Radar Services for VFR Aircraft | same page | "When a flight is positioned behind a preceding aircraft and the pilot reports having that aircraft in sight, the pilot will be instructed to follow the preceding aircraft"; the instruction to follow does not authorise the pilot to comply with clearances issued to the preceding aircraft |
| 14 CFR 25.107(e)(1)(i) | https://www.ecfr.gov/current/title-14/part-25/section-25.107 | VR may not be less than V1, so V1 <= VR: the rotation speed (`rotateSpeedKt`, verified per type) is the latest point at which a rejected takeoff can be decided; the type's V1 itself is not tabulated in the simulator |
| FAA AC 120-62 (Takeoff Safety Training Aid) and the Pilot Guide to Takeoff Safety | https://www.faa.gov/regulations_policies/advisory_circulars/index.cfm/go/document.information/documentID/23202 | V1 described as the maximum speed at which a rejected takeoff can be started and the airplane stopped on the runway; no fixed speed taken from it |
| P/CG: NEGATIVE CONTACT, TRAFFIC ADVISORIES | https://www.faa.gov/air_traffic/publications/atpubs/pcg_html/glossary-t.html | "Negative contact" refers to Traffic Advisories; the pilot's traffic acknowledgement |

### Tower vocabulary: what is NOT in the FAA text (documented, not hidden)

Checked against the pages above on 2026-10-18 and **not found**, therefore marked non-standard or pilot colloquialism in the simulator:
* "continue to the end" (runway exit): 3-10-9 has no such phraseology; the parser accepts it with the non-standard confidence factor.
* "abort takeoff" / "stop" as controller phrases: 3-9-11 gives only `CANCEL TAKEOFF CLEARANCE (reason)`; the others are accepted as synonyms.
* Pilot wording: "Cancelling takeoff clearance, stopping", "stopped on runway ..., holding position", "Looking for traffic", "request wind and altimeter", "holding in position runway ..., say intentions" are the simulator's own pilot phrases; the FAA text defines when each situation arises (3-9-11, 7-2-1, 3-9-1 / 3-10-1, 3-9-4 NOTE), not the pilot's words.
* "traffic in sight" and "negative contact": from 7-2-1 ("reports traffic in sight") and the P/CG (NEGATIVE CONTACT -> TRAFFIC ADVISORIES).
