/**
 * KMHT (Manchester-Boston Regional) build profile.
 *
 * Everything here reads data/sources/kmht-*.json or the OSM extract; no aeronautical value is typed in. The profile only
 * decides which OSM features become which kind of stand and how the NASR frequency rows are named.
 */
import type { RadioFrequency } from '../../src/sim/types.ts';
import { dist } from '../lib/geom.ts';
import type { P } from '../lib/geom.ts';
import type { AirportProfile, FrequencyCtx, J, ParkingCtx } from './types.ts';

/** OSM apron polygons (way ids) by their OSM `name` tag - looked up by name so the profile does not depend on way ids. */
const apronByName = (ctx: ParkingCtx, name: string): P[] => {
  const a = ctx.apronRecs.find((r) => r.name === name);
  if (!a) throw new Error(`OSM apron "${name}" not found in the KMHT extract`);
  return a.ring;
};

export const kmhtProfile: AirportProfile = {
  icao: 'KMHT',
  slug: 'kmht',
  buildCommand: 'scripts/build-airport.ts KMHT',
  // Printed on the FAA airport diagram 00246AD.PDF (data/sources/kmht-procedures.json airport_diagram.taxiway_identifiers)
  taxiwayIds: ['A', 'A1', 'A2', 'A3', 'A5', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'J1', 'K', 'K1', 'K2', 'L', 'M', 'M1', 'N', 'Z'],
  diagramPdf: '00246AD.PDF',
  chartedMagneticHeading(id, { endSrc }) {
    const h = endSrc.charted_magnetic_heading_deg as number | null;
    if (h === null || h === undefined) throw new Error(`no charted magnetic heading for runway end ${id} in kmht-facility.json`);
    return h;
  },
  headingSourceNote: 'Charted magnetic headings from the airport diagram 00246AD.PDF (d-TPP 2610).',
  crossing: {
    nodeId: 'RWX-X',
    name: 'Runway 6/24 x 17/35 intersection',
    notes: 'Intersection of the two runway centrelines (no FAA hot spot is charted at KMHT).',
  },
  plateGeometryFile: 'kmht-plate-geometry.json',
  diagramComparisonFile: 'kmht-diagram-comparison.md',
  simplifyEntryChains: true,
  runwayEndpointNote: ' (OSM runway endpoints were not compared with NASR: OSM maps each runway as several ways including displaced-threshold segments, and the runways come from NASR)',
  provenanceNotes: {
    navaids: 'kmht-navaids.json (MHT DME, CON and GDM VOR/DMEs, ILS components for runways 6, 17 and 35, 26 fixes)',
    procedures: 'kmht-procedures.json: 11 IAP charts (7 transcribed), airport diagram, MANCHESTER ONE and PPORT FOUR departures, ROZZE TWO STAR; no hot spot, no LAHSO',
    osm: 'Taxiways, aprons, parking positions, gates, buildings. Share-alike: the derived taxiway/apron dataset is an ODbL derivative.',
    diagramReconciliation: 'Taxiway identifier reconciliation against the airport diagram (identifiers read from the chart text; no label positions georeferenced).',
  },
  extraApproximate: [
    '- Displaced thresholds (runway ends 6, 17 and 35 per NASR, 442 / 336 / 850 ft) are modelled by the simulator: `RunwayEnd.threshold` stays the pavement end (takeoff, taxi, rollout, occupancy, TORA), `displacedThresholdFt` moves the landing threshold (glidepath, decision point, LDA) along the runway.',
    '- No MVA sectors, holding patterns or fix altitudes are included for this airport (not transcribed; never invented).',
  ],
  parking(ctx: ParkingCtx) {
    const { featsOf, loc, parkRecs, pickSpots, sampleSpots, addSynthetic, buildings, syntheticSpotSpacingM, parkingConnectMaxM } = ctx;
    const osmPos = (f: J): P => loc(f.geometry.coordinates[1], f.geometry.coordinates[0]);
    const stands = featsOf('parking_position').filter((f: J) => f.geometry.type === 'Point');
    const gateNodes = featsOf('gate').filter((f: J) => f.geometry.type === 'Point');
    const used = new Set<number>();

    // --- airline gates: OSM `gate` node ref N <-> the nearest OSM `parking_position` node with the same ref
    const gateRefs = [...new Set(gateNodes.map((g: J) => String(g.properties.ref)))].sort((a, b) => Number(a) - Number(b));
    for (const ref of gateRefs) {
      const gate = gateNodes.find((g: J) => g.properties.ref === ref);
      const cands = stands.filter((f: J) => f.properties.ref === ref);
      if (!cands.length) {
        ctx.warn(`gate ${ref}: no parking_position node with that ref in the OSM extract`);
        continue;
      }
      const gp = osmPos(gate);
      const best = cands.map((f: J) => ({ f, d: dist(osmPos(f), gp) })).sort((a: J, b: J) => a.d - b.d)[0];
      used.add(best.f.properties.osm_id as number);
      parkRecs.push({
        id: `GATE-${ref}`,
        name: `Gate ${ref}`,
        pos: osmPos(best.f),
        category: 'airline',
        source: 'osm',
        approximate: false,
        zone: 'Terminal',
        notes: `OSM parking_position node/${best.f.properties.osm_id as number} ref=${ref} (the aircraft stand); OSM gate node ${gate.properties.osm_id as number} (level 2, inside the terminal) is ${best.d.toFixed(0)} m from it${cands.length > 1 ? `; ${cands.length - 1} further parking_position node(s) carry the same ref and are not used` : ''}. Heading = direction of the apron connector.`,
        leadIn: [osmPos(best.f)],
        node: -1,
        connectorLengthM: 0,
        connected: false,
      });
    }

    // --- GA / FBO: OSM parking_position nodes without a ref inside the apron named "FBO Ramp" (real mapped stands)
    const fboRing = apronByName(ctx, 'FBO Ramp');
    const inFbo = stands.filter((f: J) => !f.properties.ref && ringContains(fboRing, osmPos(f)));
    const signature = buildings.find((b) => b.kind === 'hangar' && /Signature/i.test(b.name ?? ''));
    const sigC = signature ? centroid(signature.polygon as P[]) : undefined;
    const fboPool = sigC ? [...inFbo].sort((a: J, b: J) => dist(osmPos(a), sigC) - dist(osmPos(b), sigC)).slice(0, 8) : [];
    const fboPicked = pickSpots(fboPool.map(osmPos), 3, 20, parkingConnectMaxM);
    const pushOsmStand = (p: P, id: string, name: string, category: 'ga' | 'fbo', zone: string, note: string): void => {
      const f = stands.find((s: J) => dist(osmPos(s), p) < 0.01)!;
      used.add(f.properties.osm_id as number);
      parkRecs.push({ id, name, pos: p, category, source: 'osm', approximate: false, zone, notes: `OSM parking_position node/${f.properties.osm_id as number} (no ref) inside the OSM apron "FBO Ramp". ${note}`, leadIn: [p], node: -1, connectorLengthM: 0, connected: false });
    };
    fboPicked.forEach((p, i) => pushOsmStand(p, `FBO-${i + 1}`, `FBO Ramp ${i + 1}`, 'fbo', 'FBO', `Chosen among the stands nearest the building "${signature?.name ?? ''}" (OSM hangar, alt_name "US Customs").`));
    const fboIds = new Set(fboPicked.map((p) => `${p.x},${p.y}`));
    const gaPool = inFbo.map(osmPos).filter((p) => !fboIds.has(`${p.x},${p.y}`));
    const gaPicked = pickSpots(gaPool, 12, 18, parkingConnectMaxM);
    gaPicked.forEach((p, i) => pushOsmStand(p, `GA-${i + 1}`, `GA Ramp ${i + 1}`, 'ga', 'GA ramp', 'Spaced at least 18 m apart and within 150 m of the taxi network.'));

    // --- cargo: OSM has the cargo aprons but no stand features -> synthetic spots inside the real apron polygons
    const cargo: { apron: string; n: number; prefix: string }[] = [
      { apron: 'North Cargo Ramp', n: 2, prefix: 'CARGO-N' },
      { apron: 'South Cargo Ramp', n: 2, prefix: 'CARGO-S' },
    ];
    for (const c of cargo) {
      const ring = apronByName(ctx, c.apron);
      const cands = sampleSpots(ring, { spacing: 30, margin: 12, avoidBuildingsM: 25, accept: () => true });
      pickSpots(cands, c.n, 40, parkingConnectMaxM).forEach((p, i) =>
        addSynthetic({ id: `${c.prefix}-${i + 1}`, name: `${c.apron} ${i + 1}`, category: 'cargo', zone: c.apron, notes: `Synthetic spot placed on a grid inside the OSM apron polygon "${c.apron}" (OSM has the apron but no stand features). Not an FAA-charted stand.` }, p),
      );
    }
    void syntheticSpotSpacingM;

    const unused = stands.filter((f: J) => !used.has(f.properties.osm_id as number)).map((f: J) => `node/${f.properties.osm_id as number}`);
    return {
      unusedParkingWays: unused,
      reportParagraph: `The airline gates are real mapped data: each OSM \`gate\` node (refs ${gateRefs.join(', ')}; they sit at level 2 inside the terminal) is paired with the nearest OSM \`parking_position\` node of the same ref, which is the aircraft stand. FBO/GA stands are OSM \`parking_position\` nodes without a ref inside the OSM apron "FBO Ramp" (3 nearest the Signature Flight Support building become FBO stands, up to 12 further well-spaced ones GA stands). The cargo ramps (North, South) are OSM apron polygons without stand features, so their spots are SYNTHETIC grid points inside the polygons, flagged \`source: "synthetic"\`, \`approximate: true\`, not FAA-charted stands. ${unused.length} further OSM parking_position nodes are not used (duplicates of a gate ref, or stands in aprons that are not classified here: ${unused.slice(0, 40).join(', ')}${unused.length > 40 ? ', ...' : ''}). The OSM stands are single points, not lead-in lines, so each parking node is joined to the nearest taxi/apron edge by an apron connector edge (kind "apron_connector", taxiway "") and its heading is the direction of that connector.`,
      approximateSummary: ['- Parking: airline gate stands and the FBO/GA stands are real OSM nodes (position as mapped); heading and the connector to the taxi network are derived; the cargo spots are synthetic grid points.'],
    };
  },
  frequencies({ freqSrc, callName, approachCallName, mk }: FrequencyCtx): RadioFrequency[] {
    const f: J = freqSrc.summary_by_function;
    const uhf = (v: J): string => (v.uhf ? `UHF ${v.uhf as string}; ` : '');
    const out: RadioFrequency[] = [
      mk('ATIS', `${callName} ATIS`, f.ATIS.vhf, 'ATIS', `${uhf(f.ATIS)}hours ${f.ATIS.hours as string}; phone ${f.ATIS.phone as string}; ${f.ATIS.note as string}`),
      mk('CLNC', `${callName} Clearance Delivery`, f.clearance_delivery.vhf, 'CLNC', `${uhf(f.clearance_delivery)}${f.clearance_delivery.note as string}`),
      mk('GND', `${callName} Ground`, f.ground.vhf, 'GND', `${uhf(f.ground)}${f.ground.note as string}`),
      mk('TWR', `${callName} Tower`, f.tower.vhf, 'TWR', `${uhf(f.tower)}${f.tower.note as string}`),
      mk('APP', `${approachCallName} Approach`, f.approach_departure.vhf, 'APP', `${uhf(f.approach_departure)}${f.approach_departure.chart_name as string}. ${f.approach_departure.note as string}`),
      mk('DEP', `${approachCallName} Departure`, f.approach_departure.vhf, 'DEP', `${uhf(f.approach_departure)}same frequency as approach (NASR use code APCH/P DEP/P; the departure charts print BOS DEP CON 124.9 269.075)`),
    ];
    // NASR CLASS C rows other than the primary 124.9: named by area, not by bearings, so they are listed but not worked as positions
    (f.class_c_sector_frequencies as J[])
      .filter((c) => c.freq_mhz !== f.approach_departure.vhf)
      .forEach((c, i) => out.push(mk(`CLASS-C-${i + 1}`, `${approachCallName} Approach (${String(c.sectorization).toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase())})`, c.freq_mhz, 'OTHER', `${c.note as string}; not an assigned sector of this simulator`)));
    if (f.unicom.vhf) out.push(mk('UNICOM', `${callName} UNICOM`, f.unicom.vhf, 'OTHER', `${f.unicom.note as string}; not an ATC frequency`));
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
