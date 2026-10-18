# Tower view: aircraft models

Everything about how aircraft look in the 3D Tower view. The whole module is lazy-loaded with the rest of the tower chunk (`towerScene.ts` is
the only file that creates a renderer); there are no model files, every shape is built from parameters at runtime.

## Files

| File | Role |
| --- | --- |
| `aircraftModel.ts` | Pure (no three.js). Model family and class by type, the real dimensions of each type, the family proportions (`RECIPES`), gear, pitch, bank and light logic, world placement of an aircraft, callsign billboard scale. Also read by the 2D glyphs in `../display/symbols.ts`. |
| `liveries.ts` | Pure. Livery table and lookup by callsign, plus the colour functions the fuselage texture and fin are painted with. |
| `aircraftMeshes.ts` | three.js. Builds the geometry of each family, the livery texture and materials, and a factory that caches them per (type, livery) and hands out cheap clones. |
| `towerScene.ts` | Places the clones every frame: yaw, pitch and roll about the main gear, gear visibility, propeller spin, light sprites, night lift. |

## Model space

Nose toward -z, +y up, +x the right wing (starboard, green light), origin on the ground under the middle of the fuselage. Length comes from
`getPerformance(type).lengthM` when the type is in the performance table, otherwise from the real length in the type table (`TYPES` in
`aircraftModel.ts`); wingspan and height keep the real span/length and height/length ratios of the type (A320 37.57 / 35.80 / 11.76 m,
B738 39.5 / 35.8 / 12.5, E175 31.7 / 26.0 / 9.7, CRJ9 36.4 / 24.9 / 7.5, DH8D 32.8 / 28.4 / 8.3, C25B 14.4 / 15.9 / 4.6, C172 8.28 / 11.0 / 2.72).

## Families

| Family | Types | Recipe |
| --- | --- | --- |
| `narrowbody` | A318-A321, B737-B739, B38M, B752, A220 (BCS1/3), E170-E195 | Lathe fuselage (ogive nose with slight droop, upswept tail cone), low swept wing with dihedral and winglets, underwing nacelles on pylons, conventional tail |
| `regionalJet` | CRJ2/7/9 | As above with aft-mounted engines on pylons and a T-tail |
| `bizjet` | Citation, Learjet, Gulfstream, Phenom, anything matching the business-jet designators | Slender fuselage, swept low wing, aft engines, T-tail |
| `turboprop` | DH8C/D, AT72/75, B350 (low wing) | High straight wing, two wing nacelles with spinners and propeller discs, T-tail, retractable gear |
| `turbopropSingle` | C208, PC12 | Stout fuselage, high wing with struts, nose propeller, fixed gear |
| `gaHigh` | C172, C182, C152, C206, C210 | High wing with struts, fixed tricycle gear with wheel fairings, cowl, spinner and propeller disc |
| `gaLow` | PA28, SR22/20, DA40, BE36, M20 | Low wing, fixed tricycle gear with fairings, nose propeller |

An unknown type falls back by designator, then by the performance category and length (the same fallback `getPerformance` uses for speeds).
`classifyAircraft` still returns the coarse class (`airliner`, `bizjet`, `ga`).

Each aircraft is drawn as at most four meshes: the fuselage (livery texture), the airframe (wings, tail, engines, vertex colours), the gear
(its own object so it can be hidden) and, on propeller types, one translucent disc with blades per propeller.

## Triangle budgets

Budget: under 3,000 triangles per aircraft, all families. Current counts (fuselage 16 segments, merged non-indexed geometry):

| Type | Triangles |
| --- | --- |
| A320 / B738 / E175 (narrowbody), CRJ9 (regionalJet) | 1,468 |
| DH8D (turboprop) | 1,536 |
| C25B / GLF4 (bizjet) | 1,324 / 1,348 |
| C172 / PA28 / SR22 (GA) | 860 / 840 / 840 |
| C208 | 712 |

`tower.test.ts` builds every family and asserts the budget, the real size and that nothing is below the ground.

## Liveries

`liveryFor(callsign)`: the first three letters when followed by a digit select an airline, anything else is a registration.

| Prefix | Scheme |
| --- | --- |
| NKS | Spirit: yellow throughout, black titles, black top stripe on the fin |
| AAL | American: polished metal, blue/white/red fin stripes |
| DAL | Delta: white, dark blue belly, red and blue fin |
| UAL | United: white over pale grey, dark blue fin and tail cone |
| JBU | JetBlue: white, blue fin and tailplane |
| SWA | Southwest: canyon blue, yellow and red belly bands, blue fin with red and yellow |
| FFT | Frontier: white with a green fin and engines |
| RPA, ENY, SKW | Regionals: white with the partner's fin |
| other 3 letters | White with a fin colour seeded by the prefix |
| N-number etc. | General aviation: white with two cheat-line stripes in one of seven colour pairs seeded by the registration; the fin takes the main stripe colour |

The fuselage is painted into a 64 x 512 `DataTexture` per livery by `fuselagePaint(t, v)` (t along the fuselage, v around it), including the cockpit glass
and a dashed window row. Textures and materials are cached; two aircraft of the same type and livery share all geometry and materials.

## Gear, attitude and lights

- Gear: retractable on `narrowbody`, `regionalJet`, `turboprop` and `bizjet`; up above 200 ft AGL, down on the ground, on final (`FINAL`, `LANDING`, `ROLLOUT`, `PATTERN`) and when descending below 2,500 ft AGL. GA singles and the Caravan keep fixed gear.
- Pitch (`modelPitchRad`): 3 degrees nose-up on final or in a low descent, 6 to 8 degrees climbing, a 6 degree rotation past the rotate speed on the takeoff roll, otherwise flight-path angle plus 2 degrees (the same range `pitchFromVerticalSpeed` has always used).
- Bank: the aircraft state has no bank field, so the scene derives the turn rate from the heading change per second of simulated time (smoothed) and banks coordinated (`bankFromTurnRate`, capped at 30 degrees). Pitch and roll turn about the main gear, so the nose rises on the roll without sinking the tail.
- Lights (`lightState`): position lights red left, green right, white tail, on whenever it is dark or visibility is under 3 SM; red beacon (top and belly, about 45% duty) unless parked; double-flash white strobes airborne and on the runway; landing light from line-up through the roll, on final and below 10,000 ft AGL. Anchors (wing tips, tail, beacons, nose gear) come from each model. At night the models get a small emissive lift so they keep their colours under the apron lighting.

## Glyphs on the 2D displays

`../display/symbols.ts` builds a top-down silhouette per type from the same `RECIPES` and real wingspan, so the surface display shows the correct planform
(swept wing and underwing engines, aft engines and T-tail, straight prop wing with propeller bar, twin turboprop). Radar targets are unchanged.
