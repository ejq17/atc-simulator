/**
 * KBOS (General Edward Lawrence Logan International) build profile.
 *
 * Everything here reads data/sources/kbos-*.json or the OSM extract; no aeronautical value is typed in. The profile decides which OSM
 * features become which kind of stand and how the NASR frequency rows are named.
 */
import type { RadioFrequency } from '../../src/sim/types.ts';
import { dist } from '../lib/geom.ts';
import type { P } from '../lib/geom.ts';
import type { AirportProfile, FrequencyCtx, J, ParkingCtx } from './types.ts';

const apronByName = (ctx: ParkingCtx, name: string): P[] => {
  const a = ctx.apronRecs.find((r) => r.name === name);
  if (!a) throw new Error(`OSM apron "${name}" not found in the KBOS extract`);
  return a.ring;
};

export const kbosProfile: AirportProfile = {
  icao: 'KBOS',
  slug: 'kbos',
  buildCommand: 'scripts/build-airport.ts KBOS',
  // Printed on the FAA airport diagram 00058AD.PDF (data/sources/kbos-procedures.json airport_diagram.taxiway_identifiers)
  taxiwayIds: ['A', 'A1', 'A2', 'B', 'C', 'C1', 'D', 'D1', 'D2', 'E', 'E1', 'E2', 'F', 'G', 'H', 'J', 'J1', 'K', 'L', 'M', 'M1', 'N', 'N1', 'N2', 'N3', 'P', 'Q', 'R', 'T', 'Y', 'Z'],
  diagramPdf: '00058AD.PDF',
  chartedMagneticHeading(id, { endSrc }) {
    const h = endSrc.charted_magnetic_heading_deg as number | null;
    if (h === null || h === undefined) throw new Error(`no charted magnetic heading for runway end ${id} in kbos-facility.json`);
    return h;
  },
  headingSourceNote: 'Charted magnetic headings from the airport diagram 00058AD.PDF (d-TPP 2610).',
  plateGeometryFile: 'kbos-plate-geometry.json',
  diagramComparisonFile: 'kbos-diagram-comparison.md',
  simplifyEntryChains: true,
  includeTaxilanes: true,
  excludeOsmWays: [
    { id: 480497343, reason: 'untagged connector at the 4R threshold: runway 14/32 passes about 60 m from the threshold, so its hold line (250 ft from the 4R centreline) falls inside runway 14/32' },
    { id: 480497344, reason: 'untagged connector at the 4R threshold, same overlap with runway 14/32' },
    { id: 678899871, reason: 'taxiway Y between the 15L/33R threshold area and taxiway M: it merges with M inside the polygon of runway 15L/33R at a shallow angle, so the crossing has no usable hold line on the Y side (an aircraft taxiing on Y would enter the runway polygon without a hold); M remains' },
    { id: 24845102, reason: 'the rest of taxiway Y (from runway 4R/22L to the way excluded above): without its link to M it would be a dead-end exit stub; Y is therefore absent from the graph (the diagram prints it)' },
  ],
  dropIsolatedLanes: true,
  shortStubJunctionM: 55,
  hotSpotProvenanceNote: 'Hot spots HS 1-4 as listed on NE1HOTSPOT.PDF (BOS rows) and circled on the airport diagram 00058AD.PDF; the position stored is the first runway intersection of the graph, not one of the four circles (which lie at different intersections).',
  runwayEndpointNote: ' (OSM runway endpoints were not compared with NASR: the runways come from NASR)',
  provenanceNotes: {
    navaids: 'kbos-navaids.json (BOS VOR/DME, GDM, LFV, PVD, ORW, JFK, ILS components for runways 4R, 15R, 22L, 27, 33L, 107 fixes from the approach plates and the ROBUC THREE / JFUND TWO arrivals)',
    procedures: 'kbos-procedures.json: 19 IAP charts (15 with fixes or minima transcribed), airport diagram, LOGAN FOUR and nine RNAV departures, ROBUC THREE and JFUND TWO STARs (transcribed), hot spots HS 1-4, LAHSO page',
    osm: 'Taxiways, aprons, parking positions, gates, buildings. Share-alike: the derived taxiway/apron dataset is an ODbL derivative.',
    diagramReconciliation: 'Taxiway identifier reconciliation against the airport diagram (identifiers read from the chart text and renders; no label positions georeferenced).',
  },
  extraApproximate: [
    '- Displaced thresholds (NASR: 22R 819, 4R 1155, 22L 1199, 15R 882 ft) are modelled by the simulator (`displacedThresholdFt`); `RunwayEnd.threshold` stays the pavement end.',
    '- No MVA sectors, holding patterns or fix altitudes are included (not transcribed; never invented).',
    '- Runway-runway intersections are found automatically (`RWX-<a>x<b>`); hot spots HS 1-4 are one text entry.',
    { id: 678899871, reason: 'taxiway Y between the 15L/33R threshold area and taxiway M: it merges with M inside the polygon of runway 15L/33R at a shallow angle, so the crossing has no usable hold line on the Y side (an aircraft taxiing on Y would enter the runway polygon without a hold); M remains' },
    { id: 24845102, reason: 'the rest of taxiway Y (from runway 4R/22L to the way excluded above): without its link to M it would be a dead-end exit stub; Y is therefore absent from the graph (the diagram prints it)' },
  ],
  parking(ctx: ParkingCtx) {
    const { featsOf, toLocalPts, loc, parkRecs, pickSpots, sampleSpots, addSynthetic, parkingConnectMaxM } = ctx;
    const stands = featsOf('parking_position');
    const gateNodes = featsOf('gate');
    const used = new Set<number>();
    const pointOf = (f: J): P => {
      const pts = f.geometry.type === 'Point' ? [loc(f.geometry.coordinates[1], f.geometry.coordinates[0])] : toLocalPts(f.geometry.coordinates);
      return pts[pts.length - 1];
    };

    // --- airline gates of Terminals A, B, C and E: OSM parking_position ways whose ref is the terminal letter plus digits (A1, B27, C9, E5)
    const gateRe = /^[ABCE]\d+$/;
    const seen = new Set<string>();
    for (const f of stands) {
      const ref = f.properties.ref as string | null;
      if (!ref || !gateRe.test(ref) || seen.has(ref)) continue;
      seen.add(ref);
      used.add(f.properties.osm_id as number);
      const pts = f.geometry.type === 'Point' ? [loc(f.geometry.coordinates[1], f.geometry.coordinates[0])] : toLocalPts(f.geometry.coordinates);
      const gate = gateNodes.find((g: J) => g.properties.ref === ref);
      const gp = gate ? loc(gate.geometry.coordinates[1], gate.geometry.coordinates[0]) : null;
      parkRecs.push({
        id: `GATE-${ref}`, name: `Gate ${ref}`, pos: pts[pts.length - 1], category: 'airline', source: 'osm', approximate: false, zone: `Terminal ${ref[0]}`,
        notes: `OSM parking_position ${f.properties.osm_type as string}/${f.properties.osm_id as number} ref=${ref} (stand = last node of the lead-in line${gp ? `; OSM gate node ${gate.properties.osm_id as number} is ${dist(gp, pts[pts.length - 1]).toFixed(0)} m from it` : ''}).`,
        leadIn: pts, node: -1, connectorLengthM: 0, connected: false,
      });
    }

    // --- cargo: OSM parking_position NC<n> (North Cargo) and SC<n> (South Cargo) stands without letter suffix
    const cargoRe = /^(NC|SC)\d+$/;
    const seenC = new Set<string>();
    for (const f of stands) {
      const ref = f.properties.ref as string | null;
      if (!ref || !cargoRe.test(ref) || seenC.has(ref)) continue;
      seenC.add(ref);
      used.add(f.properties.osm_id as number);
      const pts = f.geometry.type === 'Point' ? [loc(f.geometry.coordinates[1], f.geometry.coordinates[0])] : toLocalPts(f.geometry.coordinates);
      parkRecs.push({
        id: `CARGO-${ref}`, name: `${ref.startsWith('NC') ? 'North' : 'South'} Cargo ${ref.slice(2)}`, pos: pts[pts.length - 1], category: 'cargo', source: 'osm', approximate: false, zone: ref.startsWith('NC') ? 'North Cargo' : 'South Cargo',
        notes: `OSM parking_position ${f.properties.osm_type as string}/${f.properties.osm_id as number} ref=${ref} in the OSM aprons "North Cargo" / "South Cargo".`,
        leadIn: pts, node: -1, connectorLengthM: 0, connected: false,
      });
    }

    // --- GA / FBO: OSM has the apron "Signature Ramp" (and the building "Signature Aviation") but no stand features -> synthetic spots inside the polygon
    const sig = apronByName(ctx, 'Signature Ramp');
    const cands = sampleSpots(sig, { spacing: 24, margin: 12, avoidBuildingsM: 20, accept: () => true });
    const picked = pickSpots(cands, 8, 26, parkingConnectMaxM);
    picked.forEach((p, i) => {
      const fbo = i < 3;
      addSynthetic({ id: `${fbo ? 'FBO' : 'GA'}-${fbo ? i + 1 : i - 2}`, name: `${fbo ? 'FBO' : 'GA'} Ramp ${fbo ? i + 1 : i - 2}`, category: fbo ? 'fbo' : 'ga', zone: 'Signature Ramp', notes: 'Synthetic spot placed on a grid inside the OSM apron polygon "Signature Ramp" (next to the OSM building "Signature Aviation"); OSM has no stand features there. Not an FAA-charted stand.' }, p);
    });

    const unused = stands.filter((f: J) => !used.has(f.properties.osm_id as number)).map((f: J) => `${f.properties.osm_type as string}/${f.properties.osm_id as number}${f.properties.ref ? ` (${f.properties.ref as string})` : ''}`);
    void pointOf;
    return {
      unusedParkingWays: unused,
      reportParagraph: `The airline gates are real mapped data: OSM \`parking_position\` ways whose ref is a terminal letter (A, B, C, E) plus digits, lead-in line from the lane to the stand (stand = last node); variants with a letter suffix (A14A, B22B, ...) and the remote stands (hardstands 14A-M, H1-H3, D1-D3, J1-J5) are not used. The cargo stands are the OSM NC and SC \`parking_position\` ways. The FBO and GA spots are SYNTHETIC grid points inside the OSM apron "Signature Ramp" (\`source: "synthetic"\`, \`approximate: true\`). No Cape Air apron exists in the OSM data (only a seaplane-base node), so Cape Air flights use the airline gates. ${unused.length} OSM parking positions are not used: ${unused.slice(0, 60).join(', ')}${unused.length > 60 ? ', ...' : ''}. Each parking node is joined to the nearest taxi/apron edge by an apron connector edge (kind "apron_connector", taxiway "").`,
      approximateSummary: ['- Parking: gates and cargo stands are real OSM ways (position and lead-in as mapped); the FBO and GA spots are synthetic grid points; the connector to the taxi network is derived.'],
    };
  },
  frequencies({ freqSrc, callName, approachCallName, mk }: FrequencyCtx): RadioFrequency[] {
    const f: J = freqSrc.summary_by_function;
    const rows: J[] = freqSrc.all_frequencies_serving_airport;
    const uhfNote = (v: J): string => (v.uhf ? `UHF ${v.uhf as string}; ` : '');
    const row = (use: string, sect?: string): J => {
      const r = rows.find((x) => x.use_code === use && x.band === 'VHF' && (sect === undefined || x.sectorization === sect));
      if (!r) throw new Error(`NASR row ${use}${sect ? ` ${sect}` : ''} not found`);
      return r;
    };
    const tower: J[] = f.tower_all;
    const west = tower.find((t) => t.sectorization === 'WEST');
    const east = tower.find((t) => t.sectorization === 'EAST');
    const heli = tower.find((t) => t.sectorization === 'HELICOPTERS');
    const gnd: J[] = f.ground_all;
    const classB: J[] = f.class_b_frequencies;
    const out: RadioFrequency[] = [
      mk('ATIS', `${callName} ATIS`, f.ATIS.vhf, 'ATIS', `${f.ATIS.note as string}`),
      mk('CLNC', `${callName} Clearance Delivery`, f.clearance_delivery.vhf, 'CLNC', `${uhfNote(f.clearance_delivery)}${f.clearance_delivery.note as string}`),
      mk('GND', `${callName} Ground`, gnd[0].freq_mhz, 'GND', `${f.ground.note as string}. First of the two GND/P rows (the diagram prints 121.75 first).`),
      mk('TWR', `${callName} Tower (west)`, west.freq_mhz, 'TWR', `${uhfNote(f.tower)}FRQ LCL/P sectorization WEST; the diagram prints BOSTON TOWER 128.8 (WEST)`),
      mk('APP', `${approachCallName} Approach`, row('APCH/P IC', 'WEST').freq_mhz, 'APP', `FRQ APCH/P IC (WEST), also the WOONS STAR row; printed on every Boston plate as BOSTON APP CON 120.6 263.1. NASR publishes sector rows, not bearings; this is the frequency the plates print.`),
      mk('DEP', `${approachCallName} Departure`, row('DEP/P').freq_mhz, 'DEP', 'FRQ DEP/P (Boston Consolidated TRACON A90); printed on the departure charts as BOSTON DEP CON 133.0'),
      mk('GND-2', `${callName} Ground (121.9)`, gnd[1].freq_mhz, 'OTHER', 'Second FRQ GND/P row; NASR gives no sectorization. Not an assigned position of this simulator.'),
      mk('TWR-E', `${callName} Tower (east)`, east.freq_mhz, 'OTHER', 'FRQ LCL/P sectorization EAST; the simulator works one Tower position.'),
      mk('TWR-HELI', `${callName} Tower (helicopters)`, heli.freq_mhz, 'OTHER', 'FRQ LCL/P sectorization HELICOPTERS.'),
      mk('RAMP', `${callName} Ramp Control`, f.ramp_control[0].freq_mhz, 'OTHER', 'FRQ RAMP CTL; not an assigned position of this simulator.'),
      mk('APP-N', `${approachCallName} Approach (north)`, row('APCH/P', 'NORTH').freq_mhz, 'OTHER', 'FRQ APCH/P NORTH; not an assigned sector of this simulator.'),
      mk('APP-S', `${approachCallName} Approach (south)`, row('APCH/P', 'SOUTH').freq_mhz, 'OTHER', 'FRQ APCH/P SOUTH; not an assigned sector of this simulator.'),
    ];
    classB.forEach((c, i) => out.push(mk(`CLASS-B-${i + 1}`, `${approachCallName} Approach (Class B ${c.sectorization as string})`, c.freq_mhz, 'OTHER', 'FRQ CLASS B row, sector bearings as published; not an assigned sector of this simulator.', c.sectorization as string)));
    if (f.unicom.vhf) out.push(mk('UNICOM', `${callName} UNICOM`, f.unicom.vhf, 'OTHER', `${f.unicom.note as string}; not an ATC frequency`));
    out.push(mk('EMERG', 'Emergency', f.emergency.vhf, 'OTHER', `UHF ${f.emergency.uhf as string}`));
    return out;
  },
};
