/**
 * KPHL (Philadelphia International) build profile.
 *
 * Everything here reads data/sources/kphl-*.json or the OSM extract; no aeronautical value is typed in. The profile only decides which OSM
 * features become which kind of stand and how the NASR frequency rows are named.
 */
import type { RadioFrequency } from '../../src/sim/types.ts';
import { dist } from '../lib/geom.ts';
import type { P } from '../lib/geom.ts';
import type { AirportProfile, FrequencyCtx, J, ParkingCtx } from './types.ts';

const apronByName = (ctx: ParkingCtx, name: string): P[] => {
  const a = ctx.apronRecs.find((r) => r.name === name);
  if (!a) throw new Error(`OSM apron "${name}" not found in the KPHL extract`);
  return a.ring;
};

/** Terminal aprons by their OSM `name` (the polygons that contain the airline stands). */
/** A stand's lead-in start must be within this distance of the mapped taxi/apron network (OSM has no taxilane network on the aprons, so far stands cannot be connected). */
const NET_MAX_M = 100;

const TERMINAL_APRONS = ['A West', 'A East', 'B', 'C', 'D', 'E', 'F'] as const;

export const kphlProfile: AirportProfile = {
  icao: 'KPHL',
  slug: 'kphl',
  buildCommand: 'scripts/build-airport.ts KPHL',
  // Printed on the FAA airport diagram 00320AD.PDF (data/sources/kphl-procedures.json airport_diagram.taxiway_identifiers)
  taxiwayIds: [
    'A', 'A1', 'A2', 'A3', 'B', 'D', 'D1', 'D2', 'D4', 'E', 'E1', 'E2', 'E3', 'E4', 'E5', 'F', 'G', 'H', 'J', 'J1', 'K', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8',
    'L', 'M', 'N', 'P', 'P2', 'P3', 'P4', 'P5', 'P6', 'Q', 'R', 'S', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S11', 'S12', 'S13', 'SS', 'SS1', 'SS3', 'T', 'TA', 'U', 'V', 'W', 'Y', 'Z',
  ],
  diagramPdf: '00320AD.PDF',
  chartedMagneticHeading(id, { endSrc }) {
    const h = endSrc.charted_magnetic_heading_deg as number | null;
    if (h === null || h === undefined) throw new Error(`no charted magnetic heading for runway end ${id} in kphl-facility.json`);
    return h;
  },
  headingSourceNote: 'Charted magnetic headings from the airport diagram 00320AD.PDF (d-TPP 2610).',
  hotSpotProvenanceNote:
    'The airport diagram circles two hot spots: HS 1 (taxiways S7/Y at runway 09R-27L, west end) and HS 2 (taxiways K/D with runways 35 and 27R). The hot-spot position placed here is the 17/35 x 09L/27R intersection (HS 2); HS 1 is a taxiway/runway intersection that is part of the ordinary taxiway-runway crossings of the graph. Text from NE4HOTSPOT.PDF.',
  plateGeometryFile: 'kphl-plate-geometry.json',
  excludeOsmWays: [
    { id: 145778731, reason: 'taxiway A1 is mapped as a closed loop around the end of runway 26 whose nearest neighbouring taxiway point is about 500 m away (the connection to taxiway A is not mapped in OSM): it would leave the runway-26 holds and the loop isolated from the taxi network' },
  ],
  knownGaps: [
    { check: 'runway 8/26 end 26 half', reason: 'OSM maps only taxiway A up to about 500 m short of the runway-26 end and the A1 loop around that end is not connected to it (the connection is not mapped); with A1 excluded the east half of runway 8/26 has one connected taxiway (A, at mid-runway). The diagram shows A and A1 reaching the 26 end.' },
  ],
  diagramComparisonFile: 'kphl-diagram-comparison.md',
  simplifyEntryChains: true,
  runwayEndpointNote: ' (OSM runway endpoints were not compared with NASR: the runways come from NASR)',
  provenanceNotes: {
    navaids: 'kphl-navaids.json (6 ILS/LOC with DME for runways 9L, 9R, 17, 26, 27L, 27R; OOD, MXE, DQO, PTW, CYN, ARD, RBV VOR/VORTACs of the plates and the VORs of the transcribed arrivals; 84 fixes from the approach plates and the BOJID FOUR / PAATS FOUR arrivals)',
    procedures: 'kphl-procedures.json: 22 instrument approach charts (15 transcribed: 9 ILS/LOC incl. two converging, 7 RNAV (GPS)... see the README), airport diagram, PHILADELPHIA FOUR departure, 6 STAR charts (BOJID FOUR and PAATS FOUR transcribed: transitions, runway legs, notes; no published restrictions), hot spot page, no LAHSO',
    osm: 'Taxiways, aprons, parking positions, gates, buildings. Share-alike: the derived taxiway/apron dataset is an ODbL derivative.',
    diagramReconciliation: 'Taxiway identifier reconciliation against the airport diagram (identifiers read from a 450 dpi render of the chart; no label positions georeferenced).',
  },
  extraApproximate: [
    '- Displaced threshold of runway end 27L (1913 ft per NASR) is modelled by the simulator (`displacedThresholdFt`).',
    '- No MVA sectors, holding patterns or fix altitudes are included for this airport (not transcribed; never invented).',
  ],
  parking(ctx: ParkingCtx) {
    const { featsOf, toLocalPts, loc, parkRecs, pickSpots, sampleSpots, addSynthetic, buildings, parkingConnectMaxM } = ctx;
    const osmPos = (f: J): P => loc(f.geometry.coordinates[1], f.geometry.coordinates[0]);
    const parkingWays = featsOf('parking_position').filter((f: J) => f.geometry.type === 'LineString');
    const gateNodes = featsOf('gate').filter((f: J) => f.geometry.type === 'Point');
    const used = new Set<number>();
    const lastPt = (f: J): P => {
      const pts = toLocalPts(f.geometry.coordinates);
      return pts[pts.length - 1];
    };

    // --- airline gates: OSM parking_position ways (lead-in line lane -> stand, stand = last node) whose stand lies inside a terminal apron polygon
    const termRings = TERMINAL_APRONS.map((n) => ({ name: n, ring: apronByName(ctx, n) }));
    const seen = new Map<string, number>();
    const gateRefsUsed: string[] = [];
    const gateSorted = parkingWays
      .filter((f: J) => /^[A-F]\d+[A-Z]?$/.test(String(f.properties.ref ?? '')))
      .map((f: J) => ({ f, apron: termRings.find((t) => ringContains(t.ring, lastPt(f))) }))
      .filter((x) => x.apron)
      .filter((x) => ctx.networkDistance(toLocalPts(x.f.geometry.coordinates)[0]) <= NET_MAX_M)
      .sort((a, b) => String(a.f.properties.ref).localeCompare(String(b.f.properties.ref), 'en', { numeric: true }));
    for (const { f, apron } of gateSorted) {
      const ref = String(f.properties.ref);
      const n = (seen.get(ref) ?? 0) + 1;
      seen.set(ref, n);
      const pts = toLocalPts(f.geometry.coordinates);
      const gate = gateNodes.find((g: J) => String(g.properties.ref) === ref.replace(/[A-Z]$/, ''));
      const gp = gate ? osmPos(gate) : null;
      used.add(f.properties.osm_id as number);
      gateRefsUsed.push(ref);
      parkRecs.push({
        id: n === 1 ? `GATE-${ref}` : `GATE-${ref}-${n}`,
        name: n === 1 ? `Gate ${ref}` : `Gate ${ref} (stand ${n})`,
        pos: pts[pts.length - 1],
        category: 'airline',
        source: 'osm',
        approximate: false,
        zone: `Terminal ${apron!.name}`,
        notes: `OSM parking_position way/${f.properties.osm_id as number} ref=${ref} (stand = last node of the lead-in line, heading from lane to stand), inside the OSM apron "${apron!.name}".${gp ? ` OSM gate node ${gate.properties.osm_id as number} ref=${gate.properties.ref as string} is ${dist(gp, pts[pts.length - 1]).toFixed(0)} m from the stand (gate nodes sit inside the terminal).` : ' No OSM gate node with this ref.'}`,
        leadIn: pts,
        node: -1,
        connectorLengthM: 0,
        connected: false,
      });
    }

    // --- cargo: FedEx stands (OSM refs "FedEx 1".."FedEx 5", real mapped lines) and the UPS ramp on the south side
    for (const f of parkingWays.filter((x: J) => /^FedEx \d$/.test(String(x.properties.ref ?? '')))) {
      const ref = String(f.properties.ref);
      const pts = toLocalPts(f.geometry.coordinates);
      used.add(f.properties.osm_id as number);
      parkRecs.push({ id: `FEDEX-${ref.slice(-1)}`, name: `FedEx ${ref.slice(-1)}`, pos: pts[pts.length - 1], category: 'cargo', source: 'osm', approximate: false, zone: 'Cargo City', notes: `OSM parking_position way/${f.properties.osm_id as number} ref="${ref}" (lead-in line lane -> stand), inside the OSM apron "Cargo City" next to the OSM buildings named FEDEX.`, leadIn: pts, node: -1, connectorLengthM: 0, connected: false });
    }
    const ups = buildings.find((b) => b.name === 'UPS');
    const upsC = ups ? centroid(ups.polygon as P[]) : undefined;
    const upsPool = upsC
      ? parkingWays
          .filter((f: J) => !f.properties.ref && dist(lastPt(f), upsC) <= 1000 && !used.has(f.properties.osm_id as number) && ctx.networkDistance(toLocalPts(f.geometry.coordinates)[0]) <= NET_MAX_M)
          .sort((a: J, b: J) => lastPt(a).x - lastPt(b).x)
      : [];
    const upsPicked = upsPool.filter((_: J, i: number) => i % Math.max(1, Math.floor(upsPool.length / 12)) === 0).slice(0, 12);
    upsPicked.forEach((f: J, i: number) => {
      const pts = toLocalPts(f.geometry.coordinates);
      used.add(f.properties.osm_id as number);
      parkRecs.push({ id: `UPS-${i + 1}`, name: `UPS Ramp ${i + 1}`, pos: pts[pts.length - 1], category: 'cargo', source: 'osm', approximate: false, zone: 'South cargo apron (UPS)', notes: `OSM parking_position way/${f.properties.osm_id as number} (no ref; lead-in line lane -> stand) within ${dist(lastPt(f), upsC!).toFixed(0)} m of the OSM building tagged UPS (operator UPS, 1 Hog Island Road) south of runway 09R-27L. Every ${Math.max(1, Math.floor(upsPool.length / 12))}th of the ${upsPool.length} such stands, west to east.`, leadIn: pts, node: -1, connectorLengthM: 0, connected: false });
    });

    // --- GA: the five refless parking_position lines on the North Apron (real mapped); FBO: synthetic spots inside the OSM apron "Atlantic Aviation"
    const northRing = apronByName(ctx, 'North Apron');
    const gaWays = parkingWays.filter((f: J) => !f.properties.ref && ringContains(northRing, lastPt(f)));
    gaWays.forEach((f: J, i: number) => {
      const pts = toLocalPts(f.geometry.coordinates);
      used.add(f.properties.osm_id as number);
      parkRecs.push({ id: `GA-${i + 1}`, name: `GA Ramp ${i + 1}`, pos: pts[pts.length - 1], category: 'ga', source: 'osm', approximate: false, zone: 'North Apron', notes: `OSM parking_position way/${f.properties.osm_id as number} (no ref; lead-in line lane -> stand) inside the OSM apron "North Apron".`, leadIn: pts, node: -1, connectorLengthM: 0, connected: false });
    });
    const fboRing = apronByName(ctx, 'Atlantic Aviation');
    const fboCands = sampleSpots(fboRing, { spacing: 25, margin: 10, avoidBuildingsM: 20, accept: () => true });
    pickSpots(fboCands, 3, 35, parkingConnectMaxM).forEach((p, i) =>
      addSynthetic({ id: `FBO-${i + 1}`, name: `FBO Ramp ${i + 1}`, category: 'fbo', zone: 'FBO (Atlantic Aviation)', notes: 'Synthetic spot placed on a grid inside the OSM apron polygon "Atlantic Aviation" (OSM maps the apron and the hangar "Atlantic FBO" but no stand features there). Not an FAA-charted stand.' }, p),
    );

    const unused = parkingWays.filter((f: J) => !used.has(f.properties.osm_id as number)).map((f: J) => `way/${f.properties.osm_id as number}`);
    return {
      unusedParkingWays: unused,
      reportParagraph: `The airline gates are real mapped data: OSM \`parking_position\` ways with a terminal ref (A..F + number, ${gateRefsUsed.length} stands) whose stand (last node of the lead-in line, lane to stand) lies inside one of the terminal apron polygons (${TERMINAL_APRONS.join(', ')}); the OSM \`gate\` nodes (${gateNodes.length}, inside the terminal at level 2) are only compared with them. The cargo stands are real mapped lines too (FedEx 1-5 on the OSM apron "Cargo City"; ${upsPicked.length} of ${upsPool.length} refless stands of the south-side UPS ramp, spaced west to east). GA stands are the refless lines on the North Apron; the FBO spots (Atlantic Aviation) are SYNTHETIC grid points inside the OSM apron polygon, flagged \`source: "synthetic"\`, \`approximate: true\`. ${unused.length} further OSM parking_position ways are not used (stands with other refs: R/H/W/DHB, "A14 AIRBUS", the other refless lines, duplicates). The heading of each stand is the direction of its lead-in line.`,
      approximateSummary: ['- Parking: airline gate, FedEx, UPS and GA stands are real OSM lead-in lines (position and heading as mapped); the three FBO spots are synthetic grid points.'],
    };
  },
  frequencies({ freqSrc, callName, mk }: FrequencyCtx): RadioFrequency[] {
    const f: J = freqSrc.summary_by_function;
    const uhf = (v: J): string => (v.uhf ? `UHF ${v.uhf as string}; ` : '');
    const dep: J[] = f.departure_sectors; // 090-269 (119.75, SOUTH DEP CON) and 270-089 (124.35, NORTH DEP CON)
    const south = dep.find((d) => d.freq_mhz === '119.75')!;
    const north = dep.find((d) => d.freq_mhz === '124.35')!;
    const out: RadioFrequency[] = [
      mk('ATIS', `${callName} ATIS`, f.ATIS.vhf, 'ATIS', `${f.ATIS.note as string} Departure ATIS ${f.atis_departure.vhf as string}. Hours ${f.ATIS.hours as string}.`),
      mk('CLNC', `${callName} Clearance Delivery`, f.clearance_delivery.vhf, 'CLNC', `${uhf(f.clearance_delivery)}${f.clearance_delivery.note as string}`),
      mk('GND', `${callName} Ground`, f.ground.vhf, 'GND', `${uhf(f.ground)}${f.ground.note as string}`),
      mk('TWR', `${callName} Tower`, f.tower.vhf, 'TWR', `${f.tower.note as string}; runways 08/26, 09L/27R, 17/35 (NASR LCL/P). The second tower position (09R/27L) is listed below.`),
      mk('APP', `${callName} Approach`, f.approach_departure.vhf, 'APP', `${uhf(f.approach_departure)}${f.approach_departure.chart_name as string}. NASR APCH/P DEP/P (initial contact). NASR also publishes altitude-stratified approach sectors (listed below as non-position frequencies).`),
      mk('DEP', `${callName} Departure (south, bearings ${south.sectorization as string})`, south.freq_mhz, 'DEP', `NASR DEP/P ${south.sectorization as string}, named SOUTH DEP CON on the PHILADELPHIA FOUR departure chart (UHF 269.25).`, south.sectorization),
      mk('DEP-N', `${callName} Departure (north, bearings ${north.sectorization as string})`, north.freq_mhz, 'DEP', `NASR DEP/P ${north.sectorization as string}, named NORTH DEP CON on the PHILADELPHIA FOUR departure chart (UHF 319.15); same frequency as the primary approach.`, north.sectorization),
    ];
    // everything else NASR publishes for KPHL: listed, not worked as positions
    for (const t of (f.tower_additional ?? []) as J[]) out.push(mk('TWR-2', `${callName} Tower (${t.sectorization as string})`, t.vhf, 'OTHER', `${t.note as string}; the simulator has one tower position`));
    for (const g of (f.ground_secondary ?? []) as J[]) out.push(mk('GND-2', `${callName} Ground (secondary)`, g.vhf, 'OTHER', `${g.note as string}`));
    out.push(mk('ATIS-DEP', `${callName} Departure ATIS`, f.atis_departure.vhf, 'OTHER', f.atis_departure.note as string));
    for (const p of (f.prm_monitor ?? []) as J[]) out.push(mk(`PRM-${(p.sectorization as string).replace(/\s+/g, '')}`, `${callName} PRM monitor (${p.sectorization as string})`, p.vhf, 'OTHER', p.note as string));
    for (const r of (f.final_approach ?? []) as J[]) out.push(mk('FINAL', `${callName} Final`, r.vhf, 'OTHER', `${r.note as string}`));
    (f.approach_sectors as J[]).forEach((a, i) => out.push(mk(`APP-S${i + 1}`, `${callName} Approach (${String(a.sectorization)})`, a.freq_mhz, 'OTHER', `NASR APCH/P ${String(a.sectorization)}; not an assigned sector of this simulator`)));
    if (f.unicom?.vhf) out.push(mk('UNICOM', `${callName} UNICOM`, f.unicom.vhf, 'OTHER', `${f.unicom.note as string}; not an ATC frequency`));
    out.push(mk('EMERG', 'Emergency', f.emergency.vhf, 'OTHER', `UHF ${f.emergency.uhf as string}`));
    return out;
  },
};

function ringContains(ring: P[], p: P): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function centroid(poly: P[]): P {
  return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
}
