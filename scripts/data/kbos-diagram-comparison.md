Diagram identifiers (read from the chart text layer and 400 dpi renders of 00058AD.PDF, cycle 2610): A A1 A2 B C C1 D D1 D2 E E1 E2 F G H J J1 K L M M1 N N1 N2 N3 P Q R T Y Z (31).

**All 31 diagram identifiers have at least one OSM taxiway way with that `ref`**, and **OSM carries no taxiway ref that is not on the diagram** (147 OSM taxiway ways: 63 with a diagram ref, 84 without a ref; plus 108 `taxilane` ways, which are apron lanes and not used as named taxiways). Multi-way refs: M 7, F 5, C1 5, C 4, N 4, A1/A2/J1/M1/Q/Y 2-3. The 84 untagged ways are turn-on fillets (collapsed by the build), short connectors that take the identifier of the way they continue, and apron links that stay unnamed; the exact counts are in `src/airport/kbos/build-report.md`. No diagram label positions were georeferenced for KBOS.

The diagram also prints "A4", "A5" and "A" inside circles: these are approach-light symbols, not taxiways. Diagram taxiway "K" and "L" are short (K at the 4L threshold, L at the 15R threshold).

OSM gate refs (A1-A22, B1-B38 with 31A/35A, C6/E2 .. C36, E1A .. E16) are airline gates of Terminals A, B, C and E; the diagram does not print gate numbers (the profile uses OSM `gate` / `parking_position` refs).
