/**
 * KACY (Atlantic City International) build profile: the parts of the KACY dataset that are specific to this airport.
 * Moved here unchanged from the original scripts/build-kacy-airport.ts so the generated output stays byte-identical.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataProvenance, RadioFrequency } from '../../src/sim/types.ts';
import type { KacyMvaSector } from '../../src/airport/types.ts';
import { dist, polygonCentroid } from '../lib/geom.ts';
import type { P } from '../lib/geom.ts';
import { loadMva } from '../lib/mva.ts';
import { loadDiagramLabels } from './kacy-diagramLabels.ts';
import type { AirportProfile, FrequencyCtx, J, ParkingCtx } from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../data/sources');

const MVA_CHART = 'ACY_MVA_FUS3_2025';
const MVA_URL = 'https://aeronav.faa.gov/MVA_Charts/kmz/ACY_MVA_FUS3.kml';

export const kacyProfile: AirportProfile = {
  icao: 'KACY',
  slug: 'kacy',
  buildCommand: 'scripts/build-kacy-airport.ts',
  taxiwayIds: ['A', 'B', 'C', 'D', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P'],
  diagramPdf: '00669AD.PDF',
  chartedMagneticHeading(id, { procSrc }) {
    const dpRoutes: Record<string, string> = procSrc.departure_procedures[0].route_description;
    const text = dpRoutes[id];
    const m = /heading (\d{3})/.exec(text ?? '');
    if (!m) throw new Error(`no charted magnetic heading for runway end ${id} in kacy-procedures.json`);
    return parseInt(m[1], 10);
  },
  headingSourceNote: 'Charted magnetic headings from the ATLANTIC CITY THREE DP text (d-TPP 2610).',
  holdingPatternsFile: 'kacy-holding-patterns.json',
  fixAltitudesFile: 'kacy-fix-altitudes.json',
  diagramLabels() {
    const f = loadDiagramLabels(path.join(SRC, 'raw/dtpp_2610_txt/00669AD_bbox.html'), path.join(HERE, '../data/kacy-diagram-labels.json'));
    return {
      labels: f.labels.map((l) => ({ id: l.id, lat: l.lat, lon: l.lon, ptX: l.ptX, ptY: l.ptY })),
      from: f.from,
      note: 'Two label words are not taxiway labels (the "D" tab of the ATIS legend box and the "H" of the H1 helipad callout) and match no way within 30 m.',
    };
  },
  diagramLabelNote: 'words A B C D G H J K L M N P',
  runwayEndpointNote: ' (the OSM runway endpoints differ from NASR by ~1 ft at three ends and ~22 ft at the 04 end)',
  provenanceNotes: {
    navaids: 'kacy-navaids.json (ACY VORTAC, VORs, ILS components, 36 fixes)',
    procedures: 'kacy-procedures.json: 13 IAPs, airport diagram, ATLANTIC CITY THREE DP, hot spot, LAHSO',
    osm: 'Taxiways, aprons, parking lead-in lines, gates, buildings. Share-alike: the derived taxiway/apron dataset is an ODbL derivative.',
    diagramReconciliation: 'Taxiway identifier reconciliation against the airport diagram (label positions from pdftotext -bbox, georeferenced with the diagram graticule).',
  },
  diagramComparisonFile: 'kacy-diagram-comparison.md',
  crossing: {
    nodeId: 'HS1-X',
    name: 'HS 1 (runway 4/22 x 13/31 intersection)',
    notes: 'Intersection of the two runway centrelines; FAA hot spot HS 1.',
  },
  hotSpotProvenanceNote:
    'Position = intersection of the 4/22 and 13/31 centrelines (the diagram draws the HS 1 ellipse over this intersection; the ellipse also covers the A/13-31 and B/4-22 crossings). The sentence in the hot-spot text pairs runways and taxiways in an order that looks swapped relative to the geometry; the ellipse location was used.',
  parking(ctx: ParkingCtx) {
    const { featsOf, toLocalPts, loc, ringsOf, buildings, apronOf, parkRecs, sampleSpots, pickSpots, addSynthetic, syntheticSpotSpacingM, parkingConnectMaxM } = ctx;
    const bld = (osmId: number) => buildings.find((b) => b.osmId === osmId)!;
    // --- airline gates: OSM parking_position ways with ref 1..10 (lead-in polyline: lane -> stand) + OSM gate nodes
    const gateNodes = featsOf('gate');
    const parkingWays = featsOf('parking_position');
    for (const ref of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
      const way = parkingWays.find((f: J) => f.properties.ref === ref);
      const gate = gateNodes.find((f: J) => f.properties.ref === ref);
      if (!way) {
        ctx.warn(`gate ${ref}: no parking_position way in OSM extract`);
        continue;
      }
      const pts = toLocalPts(way.geometry.coordinates);
      const gp = gate ? loc(gate.geometry.coordinates[1], gate.geometry.coordinates[0]) : null;
      parkRecs.push({
        id: `GATE-${ref}`,
        name: `Gate ${ref}`,
        pos: pts[pts.length - 1],
        category: 'airline',
        source: 'osm',
        approximate: false,
        zone: 'Terminal',
        notes: `OSM parking_position way/${way.properties.osm_id as number} ref=${ref} (stand = last node of the lead-in line, heading from lane to stand)${gp ? `; OSM gate node ${(gate.properties.osm_id as number)} is ${dist(gp, pts[pts.length - 1]).toFixed(0)} m from the stand point` : ''}`,
        leadIn: pts,
        node: -1,
        connectorLengthM: 0,
        connected: false,
      });
    }
    const unnamedParkingWays = parkingWays.filter((f: J) => !f.properties.ref).map((f: J) => `way/${f.properties.osm_id as number}`);

    // --- synthetic ramp spots inside real OSM apron polygons
    const mainApron = apronOf(131636758).ring; // terminal + GA ramp apron
    const faaApron = apronOf(131638799).ring; // FAA / Coast Guard ramp apron
    const angPadApron = apronOf(1505110353).ring; // ANG arm/dearm pad
    const terminalPoly = bld(802693053).polygon as P[];
    const fboPoly = bld(131636747).polygon as P[]; // "Midlantic Jet Charters" (FBO)
    const cTerm = polygonCentroid(terminalPoly);
    const cFbo = polygonCentroid(fboPoly);
    const axisLen = dist(cTerm, cFbo);
    const uGA = { x: (cFbo.x - cTerm.x) / axisLen, y: (cFbo.y - cTerm.y) / axisLen };
    // GA ramp: the lobe of the main apron beyond the FBO building along the terminal->FBO axis
    const gaCands = sampleSpots(mainApron, {
      spacing: syntheticSpotSpacingM,
      margin: 14,
      avoidBuildingsM: 22,
      accept: (p) => (p.x - cFbo.x) * uGA.x + (p.y - cFbo.y) * uGA.y >= -10,
    });
    const gaSpots = pickSpots(gaCands, 8, syntheticSpotSpacingM * 0.9, parkingConnectMaxM);
    gaSpots.forEach((p, i) =>
      addSynthetic({ id: `GA-${i + 1}`, name: `GA Ramp ${i + 1}`, category: 'ga', zone: 'GA ramp', notes: 'Synthetic tie-down spot placed on a grid inside the OSM apron polygon (the lobe beyond the FBO building, south-east of the terminal in true-north terms = the diagram label GENERAL AVIATION RAMP); OSM has no GA stand features. Not an FAA-charted stand.' }, p),
    );
    // FBO: two spots on the apron side of the "Midlantic Jet Charters" building, closest to the lane network
    const fboCands = sampleSpots(mainApron, { spacing: 12, margin: 10, avoidBuildingsM: 14, accept: (p) => dist(p, cFbo) >= 28 && dist(p, cFbo) <= 70 });
    const fboSpots = pickSpots(fboCands, 2, 30, parkingConnectMaxM);
    fboSpots.forEach((p, i) =>
      addSynthetic({ id: `FBO-${i + 1}`, name: `FBO Ramp ${i + 1}`, category: 'fbo', zone: 'FBO', notes: 'Synthetic spot next to the OSM building "Midlantic Jet Charters" (the FBO building adjacent to the FAA diagram FBO marker). Not an FAA-charted stand.' }, p),
    );
    // FAA / cargo ramp
    const faaCands = sampleSpots(faaApron, { spacing: 30, margin: 12, avoidBuildingsM: 25, accept: () => true });
    const faaSpots = pickSpots(faaCands, 3, 36, parkingConnectMaxM);
    faaSpots.forEach((p, i) =>
      addSynthetic({ id: `FAA-${i + 1}`, name: `FAA Ramp ${i + 1}`, category: 'cargo', zone: 'FAA ramp', notes: 'Synthetic spot inside the OSM apron polygon next to the FAA hangar (FAA/cargo/tech-centre ramp). Not an FAA-charted stand.' }, p),
    );
    // ANG arm/dearm pad (13 end): two spots inside the OSM pad polygon
    const angPadCands = sampleSpots(angPadApron, { spacing: 20, margin: 8, avoidBuildingsM: 10, accept: () => true });
    pickSpots(angPadCands, 2, 24, parkingConnectMaxM).forEach((p, i) =>
      addSynthetic({ id: `ANG-PAD-${i + 1}`, name: `ANG Arm/Dearm Pad ${i + 1}`, category: 'military', zone: 'ANG', notes: 'Synthetic spot inside the OSM "Air National Guard Arm/Dearm Pad" apron polygon (military use only per NASR remark).' }, p),
    );
    // ANG ramp: one spot 30 m on the ramp side (north) of each of the six hangars in the ANG hangar row
    const angAnchor = buildings.find((b) => b.kind === 'hangar' && /NJANG/.test(b.name ?? ''));
    const angHangars = angAnchor
      ? buildings
          .filter((b) => b.kind === 'hangar' && dist(polygonCentroid(b.polygon as P[]), polygonCentroid(angAnchor.polygon as P[])) <= 120)
          .sort((a, b) => polygonCentroid(a.polygon as P[]).y - polygonCentroid(b.polygon as P[]).y)
      : [];
    angHangars.forEach((h, i) => {
      const c = polygonCentroid(h.polygon as P[]);
      addSynthetic({ id: `ANG-${i + 1}`, name: `ANG Ramp ${i + 1}`, category: 'military', zone: 'ANG', notes: `Synthetic spot 30 m north of OSM hangar ${h.osmId}${h.name ? ` ("${h.name}")` : ''} on the ANG ramp. Not an FAA-charted stand.` }, { x: c.x, y: c.y + 30 });
    });
    // Coast Guard helipads (OSM aeroway=helipad name=USCG) - real mapped features
    let uscgN = 0;
    for (const f of featsOf('helipad')) {
      if (f.properties.name !== 'USCG') continue;
      uscgN++;
      const c = polygonCentroid(ringsOf(f)[0]);
      parkRecs.push({ id: `USCG-${uscgN}`, name: `USCG Helipad ${uscgN}`, pos: c, category: 'military', source: 'osm', approximate: false, zone: 'USCG', notes: `OSM aeroway=helipad name=USCG way/${f.properties.osm_id as number}. Helicopter pad; position is the polygon centroid.`, leadIn: [c], node: -1, connectorLengthM: 0, connected: false });
    }
    return {
      unusedParkingWays: unnamedParkingWays,
      reportParagraph: `Only the 10 airline gates (OSM \`parking_position\` ways ref 1-10, lead-in line from the lane to the stand; stand = last node) are real stand data. The 6 untagged \`parking_position\` ways (${unnamedParkingWays.join(', ')}) are curved lead-in alternatives that start at the same nodes as stands 2-5 and are not used as separate stands. OSM has NO GA, FBO, Coast Guard (apart from 4 helipad polygons), ANG or FAA stand features, so those are SYNTHETIC spots placed on a grid inside real OSM apron polygons (or at helipad centroids / in front of ANG hangars). They are flagged \`source: "synthetic"\`, \`approximate: true\` and are not FAA-charted stands. Each parking node is joined to the nearest taxi/apron edge by an apron connector edge (kind "apron_connector", taxiway "").`,
      approximateSummary: ['- ALL parking positions except the 10 airline gate stands; synthetic GA / FBO / FAA / ANG spots and the pad spots.'],
    };
  },
  frequencies({ freqSrc, callName, mk }: FrequencyCtx): RadioFrequency[] {
    const fsum: J = freqSrc.summary_by_function;
    return [
      mk('ATIS', `${callName} ATIS`, fsum.ATIS.vhf, 'ATIS', `UHF ${fsum.ATIS.uhf as string}; hours ${fsum.ATIS.hours as string}; phone ${fsum.ATIS.phone as string}`),
      mk('CLNC', `${callName} Clearance Delivery`, fsum.clearance_delivery.vhf, 'CLNC', `UHF ${fsum.clearance_delivery.uhf as string}; ${fsum.clearance_delivery.note as string}`),
      mk('GND', `${callName} Ground`, fsum.ground.vhf, 'GND', `UHF ${fsum.ground.uhf as string}; ${fsum.ground.note as string}`),
      mk('TWR', `${callName} Tower`, fsum.tower.vhf, 'TWR', `UHF ${fsum.tower.uhf as string}; ${fsum.tower.note as string}. CTAF 120.3 only during ATC zero events.`),
      mk('APP', `${callName} Approach (south sector, bearings ${fsum.approach_departure_south.sectorization_bearings as string})`, fsum.approach_departure_south.vhf, 'APP', `UHF ${fsum.approach_departure_south.uhf as string}; ${fsum.approach_departure_south.chart_name as string}. Sector bearings as published in NASR; the reference point is not defined in the data.`, fsum.approach_departure_south.sectorization_bearings),
      mk('DEP', `${callName} Departure (south sector, bearings ${fsum.approach_departure_south.sectorization_bearings as string})`, fsum.approach_departure_south.vhf, 'DEP', `UHF ${fsum.approach_departure_south.uhf as string}; same frequency as approach (NASR use code APCH/P DEP/P)`, fsum.approach_departure_south.sectorization_bearings),
      mk('APP-N', `${callName} Approach (north sector, bearings ${fsum.approach_departure_north.sectorization_bearings as string})`, fsum.approach_departure_north.vhf, 'APP', `UHF ${fsum.approach_departure_north.uhf as string}; ${fsum.approach_departure_north.chart_name as string}`, fsum.approach_departure_north.sectorization_bearings),
      mk('DEP-N', `${callName} Departure (north sector, bearings ${fsum.approach_departure_north.sectorization_bearings as string})`, fsum.approach_departure_north.vhf, 'DEP', `UHF ${fsum.approach_departure_north.uhf as string}; same frequency as approach`, fsum.approach_departure_north.sectorization_bearings),
      mk('FAA-OPS', 'FAA Operations', fsum.faa_ops.vhf, 'OTHER', 'Not an ATC frequency (NASR use code OPS).'),
      mk('ANG-OPS', 'ANG Base Operations', fsum.ang_ops.vhf, 'OTHER', 'Not an ATC frequency (NASR use code ANG OPS).'),
      mk('EMERG', 'Emergency', fsum.emergency.vhf, 'OTHER', `UHF ${fsum.emergency.uhf as string}`),
    ];
  },
  mva(helpers) {
    const mvaFile = loadMva(path.join(SRC, 'raw/mva/ACY_MVA_FUS3.kml'), path.join(SRC, 'kacy-mva.json'), {
      product: 'FAA Minimum Vectoring Altitude (MVA) charts, Atlantic City ATCT/TRACON (ACY)',
      page: 'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/mva_mia/mva/',
      files: {
        kml: MVA_URL,
        xml: 'https://aeronav.faa.gov/MVA_Charts/aixm/ACY_MVA_FUS3.xml',
        pdf: 'https://aeronav.faa.gov/MVA_Charts/pdf/ACY_MVA_FUS3.pdf',
        fus5_alternate: 'https://aeronav.faa.gov/MVA_Charts/kmz/ACY_MVA_FUS5.kml (same sector letters and altitudes, slightly different geometry for B, D, E, H, I)',
      },
      chart_id: MVA_CHART,
      retrieved: '2026-10-17',
      server_last_modified: '2025-10-20T20:50:15Z (HTTP Last-Modified of ACY_MVA_FUS3.kml); chart PDF creation date 2025-07-09',
      effective_date: 'not stated in the product; "MVA/MIA charts are not updated on a regularly scheduled cycle" (FAA memorandum of 2014-12-08 inside the PDF); facilities review biennially. Chart id carries year 2025.',
      disclaimer: 'Visual reference only; not to be used as a navigational tool (FAA memorandum in the PDF).',
      variant_choice: 'FUS3 chosen as the primary variant; the page gives no explanation of FUS3 vs FUS5. Both publish identical sector letters and altitudes (A 1600, B 2000, C 2500, D 2100, E 2000, F 5500, G 2000, H 1700, I 2200 ft MSL).',
      datum: 'altitudes in feet MSL; polygon coordinates WGS84 lon/lat in the KML',
    });
    const mvaProv = (sectorId: string, note: string): DataProvenance => ({
      source: `FAA MVA/MIA digital product, chart ${MVA_CHART} (Atlantic City ATCT/TRACON)`,
      url: MVA_URL,
      retrievedOn: '2026-10-17',
      notes: `Sector ${sectorId}. ${note} Effective date not stated in the product (not updated on a regular cycle); file last modified 2025-10-20. Visual reference only, not for navigation.`,
    });
    const mvaSectors: KacyMvaSector[] = mvaFile.sectors.map((sec) => ({
      id: `ACY-MVA-${sec.id}`,
      name: sec.id,
      altitudeFt: sec.altitudeFt,
      polygon: sec.outer.map(([lon, lat]) => helpers.pr(helpers.loc(lat, lon))),
      holes: sec.holes.map((h) => h.map(([lon, lat]) => helpers.pr(helpers.loc(lat, lon)))),
      ...(sec.remarks ? { remarks: sec.remarks } : {}),
      ...(sec.controllingObstruction ? { controllingObstruction: sec.controllingObstruction } : {}),
      provenance: mvaProv(sec.id, `${sec.altitudeFt} ft MSL; ${sec.holes.length} inner ring(s) (areas inside this sector that have their own altitude).${sec.remarks ? ` Remarks: ${sec.remarks}` : ''}${sec.controllingObstruction ? ` ${sec.controllingObstruction}.` : ''}`),
    }));
    return {
      sectors: mvaSectors,
      provenance: mvaProv('all', `${mvaSectors.length} sectors from ${MVA_CHART}`),
      reportIntro: `Source: FAA MVA digital product, chart ${MVA_CHART} (Atlantic City ATCT/TRACON), ${MVA_URL} (also .pdf and AIXM .xml). No effective date is published in the product (MVA charts are not on a regular cycle); the file was last modified 2025-10-20. Visual reference only. Polygons are the outer rings in local metres; sectors that contain other sectors carry \`holes\`. FUS5 variant saved in data/sources/raw/mva/ (same letters/altitudes, slightly different geometry for B, D, E, H, I).`,
    };
  },
};
