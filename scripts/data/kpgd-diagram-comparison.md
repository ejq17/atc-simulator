## Comparison with the FAA airport diagram (06178AD.PDF, cycle 2610)

Diagram taxiway identifiers (read visually from 250 dpi renders: the PDF has no text layer for the chart body): A, A1, A2, A3, A4, B, C, D, E, E1, E2, E3, F, G, G1, G2, G3, H (18). The diagram prints no hot spot; the lone filled circles are PAPI symbols.

1. **On the diagram but absent from the OSM refs: A1, A3, A4, G1, G2, G3.** No OSM way carries these refs (OSM has A, A2, B, C, D, E, E1, E2, E3, F, G, H), and without georeferenced diagram labels the untagged ways could not be assigned to them, so they are missing from the graph (their geometry, where mapped, is in the unnamed lanes). A1, A3 and A4 are the short connectors of A to runway 4/22; G1-G3 link taxiway G to the FBO apron.
2. **In OSM but not on the diagram:** none (every OSM ref is on the diagram).
3. **Untagged ways** (73): 8 are turn-on fillets collapsed by the build; 6 took the identifier of the named way they continue (continuity rule); 59 stay unnamed (flagged approximate). Many of those are apron / ramp lanes and connectors on the terminal and north ramps, which the diagram does not label.
4. **Runway entrances** are mapped as the straight crossing plus short untagged fillets; the build collapses the fillets and derives each hold line 250 ft from the centreline. OSM has 46 `holding_position` nodes (all `holding_position:type=runway`): for all 12 derived hold lines the nearest OSM node is within 6.1 m and for 8 of 12 within 0.1 m, which supports the 250 ft simplification here (table in `src/airport/kpgd/build-report.md`).
5. **Runway 09/27** is mapped in OSM (3 OSM runway ways: 09/27, 04/22, 15/33) but is not built (see the profile); taxiways E, E1-E3, G and G1-G3 that serve it are kept as geometry.
6. **Taxiway A crosses runway 15/33** (hold lines HP15-33-A-1/2) and **taxiway C crosses 15/33** as on the diagram; the runway intersection 4/22 x 15/33 is node `RWX-4-22x15-33` (computed from the NASR thresholds).
7. **Gates.** OSM `gate` nodes (refs 1, 2, 2A, 3, 4, 5, 6, 7) are inside the terminal; the aircraft stands are the OSM `parking_position` ways with ref 1-10 (OSM has no gate node for 8-10). Whether the real airport numbers its gates 1-10 is not checked against an airport source here.
8. OSM aerodrome and runway tags are not used; runway geometry, headings and elevations are NASR.
