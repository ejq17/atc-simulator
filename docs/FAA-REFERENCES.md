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
| 3-1-3 | USE OF ACTIVE RUNWAYS | Coordination between Ground and Tower (see "Coordination between positions" below for the verified text) |
| 3-1-4 | COORDINATION BETWEEN LOCAL AND GROUND CONTROLLERS | Local and ground controllers exchange information as necessary for the safe and efficient use of runways and movement areas |
| 4-3-4 | DEPARTURE RELEASE, HOLD FOR RELEASE, RELEASE TIMES, DEPARTURE RESTRICTIONS, AND CLEARANCE VOID TIMES | `(aircraft identification) RELEASED.` to another controller; Hold For Release |
| 5-4-2 / 5-4-3 / 5-4-7 | TERMS / METHODS / POINT OUT | Point out, "POINT OUT APPROVED", "TRAFFIC OBSERVED", "UNABLE"; landline voice as a method; responsibilities of the transferring and receiving controller |
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
| 2-1-23 | BIRD ACTIVITY INFORMATION | Bird activity advisory ("Issue advisory information on pilot-reported, tower-observed ... bird activity"; the task brief called it 2-1-22, which in this edition is UAS activity) and the ATIS line |
| 2-8-1, 2-8-2, 2-8-3 | FURNISH RVR VALUES; ARRIVAL/DEPARTURE RUNWAY VISIBILITY; TERMINOLOGY | When RVR is issued (prevailing visibility 1 mile or less, or RVR 6,000 ft or less) and how ("Runway One Four RVR Two Thousand Four Hundred"; "more than" / "less than") |
| 2-9-2 | OPERATING PROCEDURES | When a new ATIS recording is made: new official weather regardless of a change in values, braking action reported worse, runway / approach change, new or canceled NOTAMs |
| 3-3-1 | LANDING AREA CONDITION | Runway Condition Codes via the ATIS ("condition codes two, two, three at one zero one eight zulu"); airport management closes runways |
| 3-3-2 | CLOSED/UNSAFE RUNWAY INFORMATION | A takeoff / landing clearance onto a closed runway is unsafe; "RUNWAY (number) CLOSED/UNSAFE" |
| 3-3-4, 3-3-5 | BRAKING ACTION; BRAKING ACTION ADVISORIES | The six terms, aircraft type with a report, "Braking Action Advisories are in effect", issuing the latest report, "NO BRAKING ACTION REPORTS RECEIVED FOR RUNWAY (number)" |
| 3-4-10, 3-4-11, 3-4-14 | RUNWAY EDGE LIGHTS; HIRL, RCLS, TDZL; MIRL | Lights on at night and below 2 SM by day, pilot-requested changes, HIRL intensity steps 1-5 by visibility (TBL 3-4-8), no edge lights on a runway closed by NOTAM |
| 4-5-7, 5-7-2 | ALTITUDE INFORMATION; METHODS | "DESCEND VIA (STAR name and number) (transition if required.)"; published speed restrictions apply regardless of climb via / descend via |
| 4-7-1, 4-7-12 | CLEARANCE INFORMATION; AIRPORT CONDITIONS | "(STAR name and number) ARRIVAL, (transition name) TRANSITION", "Descend via the ... Arrival"; airport conditions and RwyCC to arrivals |

Page URLs (the FAA site returns 403 to non-browser user agents; fetch with a normal browser UA):
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap2_section_1.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap2_section_4.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap2_section_8.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap2_section_9.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_3.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_4.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_1.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_5.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_7.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_8.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_9.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_10.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap4_section_2.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap4_section_3.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap4_section_7.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap4_section_8.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap5_section_2.html
- https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap5_section_4.html
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
| 14 CFR 91.175(h)(2) (eCFR, retrieved 2026-10-18) = AIM TBL 5-4-1 | https://www.ecfr.gov/current/title-14/part-91/section-91.175 ; https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap5_section_4.html | RVR to visibility table (1,600 = 1/4, 2,400 = 1/2, 3,200 = 5/8, 4,000 = 3/4, 4,500 = 7/8, 5,000 = 1, 6,000 = 1 1/4); AIM: "use the next higher RVR value; do not interpolate" |
| FAA AC 150/5200-30D, Table 5-2 (RCAM) | https://www.faa.gov/documentLibrary/media/Advisory_Circular/150-5200-30D.pdf (read 2026-10-18) | Runway condition codes 6..0, contaminant descriptions and the matching pilot reported braking action (5 good, 4 good to medium, 3 medium, 2 medium to poor, 1 poor, 0 nil) |
| FAA AC 150/5370-2G, 2.18.2.1.2 and Figure 2-3 | https://www.faa.gov/documentLibrary/media/Advisory_Circular/150-5370-2G.pdf (read 2026-10-18) | Temporarily closed runway: an X at each end on or near the designation numbers; closed runways and exit taxiways are marked with a yellow X |
| d-TPP cycle 2610 ROZZE TWO ARRIVAL (RNAV), 00246ROZZE.PDF and 00246ROZZE_C.PDF; NASR 2026-10-01 STAR_RTE.csv | https://aeronav.faa.gov/d-tpp/2610/00246ROZZE.PDF ; https://nfdc.faa.gov/webContent/28DaySub/extra/01_Oct_2026_STAR_CSV.zip | KMHT's only STAR (data/sources/README.md "ROZZE TWO ARRIVAL") |
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

### Coordination between positions (verified 2026-10-18, FAA web edition, chapter 3 section 1, chapter 4 section 3, chapter 5 section 4)

Read from the pages above (fetched with a browser User-Agent). The text quoted here is short, the rest is paraphrased.

* **3-1-3 USE OF ACTIVE RUNWAYS.** "The local controller has primary responsibility for operations conducted on the active runway and must control the use of those runways." Items: "Ground control must obtain approval from local control before authorizing an aircraft or a vehicle to cross or use any portion of an active runway. The coordination must include the point/intersection at the runway where the operation will occur." Phraseology: `CROSS (runway) AT (point/intersection).` "When the local controller authorizes another controller to cross an active runway, the local controller must verbally specify the runway to be crossed and the point/intersection at the runway where the operation will occur preceded by the word 'cross.'" "The ground controller must advise the local controller when the coordinated runway operation is complete. This may be accomplished verbally or through visual aids as specified by a facility directive." Also: "The local controller must coordinate with the ground controller before using a runway not previously designated as active."
  Used by: `coordination.ts` `crossingGate` (training refuses, free play scores a coordination error), the Tower authorisation wording, the point in every crossing request, the completion message (the engine posts it when the aircraft has left the runway, standing for the visual aid), the AI Ground/Tower, the debrief advice, training lesson 10. **Not modelled:** vehicles ("a vehicle later"), "taxi/proceed on or along an active runway for purposes other than crossing" (a back-taxi stays a taxi instruction on the runway-holding route), "use of a runway not previously designated as active" (the runway configuration is set by the player, not announced by Tower).
* **3-1-4 COORDINATION BETWEEN LOCAL AND GROUND CONTROLLERS.** Information is exchanged "as necessary for the safe and efficient use of airport runways and movement areas ... verbal means, flight progress strips, other written information, or automation displays"; Ground notifies Local when a departure is taxied to a runway other than the one previously designated as active, and of any aircraft taxied to an intersection for takeoff. **Not modelled:** these two notifications (Ground does not announce a runway change or an intersection departure; Tower sees the strip).
* **4-3-4 DEPARTURE RELEASE, HOLD FOR RELEASE, ...** Phraseology "To another controller, (aircraft identification) RELEASED." "Hold For Release (HFR). 'Hold for release' instructions must be used to inform a pilot or a controller that a departure clearance is not valid until additional instructions are received." The paragraph's rule ("Departures from an airport without an operating control tower must be issued either a departure release, a hold for release, or a release time") is about airports without a tower. **That a tower must obtain a release from the TRACON for an IFR departure is not stated in 7110.65: it comes from a letter of agreement / facility directive (JO 7210.3 4-3-1 is the LOA paragraph; its text was not read).** The simulator therefore makes it a scenario setting (`Scenario.coordination.releasesRequired`, default on when a separate Departure/Approach position is staffed and the player does not work both), and uses "(callsign) released" and "(callsign) hold for release" as the phrases, which are the 4-3-4 ones. The release interval (120 s) and the "stand by" spacing (45 s) are design values.
* **5-4-3 METHODS.** Landline voice is one of the methods to transfer radar identification. Order of a point out: position of the target relative to a fix known to both, the aircraft identification, altitude / restrictions / pertinent information. Phraseology `HANDOFF/POINT-OUT/TRAFFIC (aircraft position), (aircraft ID or discrete beacon code), (altitude, restrictions, and other pertinent information, if applicable).` Example "Point out, Southwest of Richmond VOR ...". Responses: `(Aircraft ID) (restrictions, if applicable) RADAR CONTACT`, `(aircraft ID or discrete beacon code) POINT OUT APPROVED`, `TRAFFIC OBSERVED`, `UNABLE (appropriate information, as required)`.
* **5-4-2 TERMS / 5-4-7 POINT OUT.** "Point Out. An action taken by a controller to transfer the radar identification of an aircraft to another controller and radio communications will not be transferred." The transferring controller obtains approval before the aircraft enters the receiving controller's delegated airspace, must obtain approval before any change to the aircraft's flight path, altitude or speed after the point out is approved, and complies with the receiving controller's restrictions; the receiving controller is responsible for separation between the point-out aircraft and other aircraft he has separation responsibility for. **The simulator makes point outs information only** (no airspace boundaries are modelled): nothing is enforced and nothing is scored.

Not in the FAA text, so plain words and marked `standard: false` in `CoordMessage` and "plain" in the Landline log: the Ground-to-Tower request wording ("request cross runway one three at Alpha with ..."), "unable, ..., I'll call you back" / "stand by", "hold short, ... disregard the crossing", "behind the landing <callsign>", "<callsign> across runway ...", "request release <callsign>", "<callsign> rolling", "<callsign> going around" / "aircraft on the go", the traffic information line and free text. The parser gives them the non-standard confidence factor 0.9. "Rolling" and "going around" calls are practice at many facilities (often in an LOA); none is in 7110.65 or the P/CG entries that were searched.

## Ground operations (read 2026-10-18 from the FAA HTML pages; quoted text is verbatim)

JO 7110.65 section 3-7 (https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap3_section_7.html) and 2-4-3 (.../chap2_section_4.html); AIM 4-3-18 (.../aim_html/chap4_section_3.html); Pilot/Controller Glossary (.../pcg_html/glossary-p.html). The saved pages lose the sub-paragraph letters, so the rules are cited by paragraph and quoted text.

| Reference | Verified text (verbatim) | Used for |
|---|---|---|
| 2-4-3 PILOT ACKNOWLEDGMENT/READ BACK | "Ensure the read back of hold short instructions, whether a part of taxi instructions or a LAHSO clearance." / "Ensure that items read back are correct." NOTE: "Initial read back of a taxi, departure or landing clearance should include the runway assignment" | Hold-short readback requirement (G4), wrong-taxiway readback error |
| 3-7-2 TAXI AND GROUND MOVEMENT OPERATIONS | "The taxi clearance/route must include the specific route to follow." / "When authorizing an aircraft to taxi to an assigned takeoff runway, state the departure runway followed by the specific taxi route." PHRASEOLOGY "RUNWAY (number), TAXI VIA (route as necessary)(hold short instructions as necessary)." EXAMPLE "Taxi/continue taxiing/proceed to the hangar." | Route-less taxi flagged / refused (G1) |
| 3-7-2 (read back) | "Request a read back of runway hold short instructions when it is not received from the pilot/vehicle operator." PHRASEOLOGY "READ BACK HOLD INSTRUCTIONS." NOTE "Read back hold instructions phraseology may be initiated for any point on a movement area when the controller believes the read back is necessary." | `READ_BACK_HOLD`, AI Ground, 20 s charge |
| 3-7-2 (progressive taxi) | "Issue progressive taxi/ground movement instructions when: A pilot/operator requests. The specialist deems it necessary due to traffic or field conditions, e.g., construction or closed taxiways. Necessary during reduced visibility, especially when the taxi route is not visible from the tower." NOTE "Progressive instructions may include step-by-step directions and/or directional turns." | Progressive taxi (G1) |
| 3-7-1 | "Do not use the word \"cleared\" in conjunction with authorization for aircraft to taxi" | Phrases of the AI segments ("continue taxiing via ...") |
| AIM 4-3-18 | "If the pilot is unfamiliar with the airport or for any reason confusion exists as to the correct taxi routing, a request may be made for progressive taxi instructions which include step-by-step routing directions." / "Controllers are required to request a readback of runway hold short assignment when it is not received from the pilot/vehicle." / pilots "should always read back: The runway assignment. Any clearance to enter a specific runway. Any instruction to hold short of a specific runway or line up and wait." | Unfamiliar pilots, readbacks |
| AIM 4-3-15 / 4-3-16 | "Pilots of departing aircraft should communicate with the control tower on the appropriate ground control/clearance delivery frequency prior to starting engines to receive engine start time, taxi and/or clearance information." | Engine start / ready timing context (the intervals themselves are design values) |
| P/CG PROGRESSIVE TAXI | "Precise taxi instructions given to a pilot unfamiliar with the airport or issued in stages as the aircraft proceeds along the taxi route." | Progressive taxi |
| AC 150/5300-13B Chg 1, Appendix 1 glossary | Taxilane: "Taxi speeds on taxilanes are generally not more than 15 mph (13 kts)." Taxiway: "Taxi speeds on taxiways will typically range from 15 mph (13 kts) to 35 mph (30 kts)." | Taxi speeds (G7); `taxilaneMaxKt` = 13 |
| AC 150/5300-13B Chg 1, 5.17.1 | "Provide a pushback area (Figure 5-3) with sufficient space to push aircraft back to a point where aircraft initiate maneuvering under their own power." | Push point = where the stand lead-in meets the lane (G10) |
| NOT FOUND | No pushback or engine-start phraseology in JO 7110.65 (searched the saved 3-7 and 2-4 pages: no "push"). Pushback is normally a ramp / company function; the simulator lets Ground approve it and marks the phrase non-standard. "Say route" and the pilot's \"say again hold short instructions\" are plain language (no FAA phrase found). | Non-standard markings |
