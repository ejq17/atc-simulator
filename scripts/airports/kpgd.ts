/**
 * KPGD (Punta Gorda Airport, FL) build profile.
 *
 * Everything here reads data/sources/kpgd-*.json or the OSM extract; no aeronautical value is typed in. The profile only
 * decides which OSM features become which kind of stand and how the NASR frequency rows are named.
 */
import type { RadioFrequency } from '../../src/sim/types.ts';
import { dist } from '../lib/geom.ts';
import type { P } from '../lib/geom.ts';
import type { AirportProfile, FrequencyCtx, J, ParkingCtx } from './types.ts';

const NORTH_RAMP_APRON_OSM_ID = 308584964; // OSM apron west of the terminal apron (the diagram's NORTH RAMP)

export const kpgdProfile: AirportProfile = {
  icao: 'KPGD',
  slug: 'kpgd',
  buildCommand: 'scripts/build-airport.ts KPGD',
  // Printed on the FAA airport diagram 06178AD.PDF (data/sources/kpgd-procedures.json airport_diagram.taxiway_identifiers)
  taxiwayIds: ['A', 'A1', 'A2', 'A3', 'A4', 'B', 'C', 'D', 'E', 'E1', 'E2', 'E3', 'F', 'G', 'G1', 'G2', 'G3', 'H'],
  diagramPdf: '06178AD.PDF',
  // NASR 09/27 is not modelled: NASR remark "NOT AVBL FOR PART 121/PART 380 OPS ... RSTRD TO ACFT LESS THAN 6000 LBS", d-TPP takeoff minimums "Rwys 9, 27 NA - airport authority request"
  excludeRunways: ['09/27'],
  chartedMagneticHeading(id, { endSrc }) {
    const h = endSrc.charted_magnetic_heading_deg as number | null;
    if (h === null || h === undefined) throw new Error(`no charted magnetic heading for runway end ${id} in kpgd-facility.json`);
    return h;
  },
  headingSourceNote: 'Charted magnetic headings from the airport diagram 06178AD.PDF (d-TPP 2610).',
  plateGeometryFile: 'kpgd-plate-geometry.json',
  diagramComparisonFile: 'kpgd-diagram-comparison.md',
  simplifyEntryChains: true,
  runwayEndpointNote: ' (OSM runway endpoints were not compared with NASR; the runways come from NASR)',
  provenanceNotes: {
    navaids: 'kpgd-navaids.json (ILS/DME I-PGD for runway 4, the LEE COUNTY VORTAC (RSW) used by the plates, 45 fixes: 28 on the approach plates and 17 on the LUBBR FOUR and PIKKR SEVEN arrivals)',
    procedures: 'kpgd-procedures.json: 5 IAP charts (all transcribed: ILS or LOC 4, RNAV (GPS) 4, 15, 22, 33), airport diagram, LUBBR FOUR and PIKKR SEVEN STARs (PGD bodies transcribed); no DP or SID, no hot spot, no LAHSO',
    osm: 'Taxiways, aprons, parking positions, gates, buildings. Share-alike: the derived taxiway/apron dataset is an ODbL derivative.',
    diagramReconciliation: 'Taxiway identifier reconciliation against the airport diagram (identifiers read from a render of the chart: the diagram PDF has no text layer; no label positions georeferenced).',
  },
  extraApproximate: [
    '- Runway 09/27 (2636 x 60 ft, NASR) is NOT in the built airport: no Part 121 / 380 use, takeoff not authorised (airport authority request) and restricted to aircraft under 6000 lb. Taxiways E, E1-E3 and G1-G3 that serve it remain as geometry.',
    '- Displaced threshold of runway 15 (271 ft per NASR) is modelled by the simulator (`displacedThresholdFt`).',
    '- No MVA sectors, holding patterns or fix altitudes are included for this airport (not transcribed; never invented).',
    '- The FBO ramp north of runway 9/27 shown on the diagram is not mapped as an apron in OSM: FBO and GA spots are synthetic (north ramp) or the three unreferenced OSM stands (south ramp).',
  ],
  parking(ctx: ParkingCtx) {
    const { featsOf, toLocalPts, loc, buildings, parkRecs, sampleSpots, pickSpots, addSynthetic, apronOf, syntheticSpotSpacingM, parkingConnectMaxM } = ctx;
    const gateNodes = featsOf('gate');
    const parkingWays = featsOf('parking_position');
    const used = new Set<number>();
    const termPoly = buildings.find((b) => b.kind === 'terminal')!.polygon as P[];
    const termC = { x: termPoly.reduce((s, q) => s + q.x, 0) / termPoly.length, y: termPoly.reduce((s, q) => s + q.y, 0) / termPoly.length };
    // --- airline stands: OSM parking_position ways with ref 1..10 (lead-in polyline lane -> stand); OSM gate nodes exist for 1, 2, 2A, 3-7
    for (const ref of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
      const way = parkingWays.find((f: J) => f.properties.ref === ref);
      if (!way) {
        ctx.warn(`gate ${ref}: no parking_position way in OSM extract`);
        continue;
      }
      used.add(way.properties.osm_id as number);
      const pts = toLocalPts(way.geometry.coordinates);
      // OSM digitised stands 7-10 from the terminal outwards: the stand is the end nearer the terminal
      if (dist(pts[0], termC) < dist(pts[pts.length - 1], termC)) pts.reverse();
      const gates = gateNodes.filter((f: J) => String(f.properties.ref).startsWith(ref));
      parkRecs.push({
        id: `GATE-${ref}`,
        name: `Gate ${ref}`,
        pos: pts[pts.length - 1],
        category: 'airline',
        source: 'osm',
        approximate: false,
        zone: 'Terminal',
        notes: `OSM parking_position way/${way.properties.osm_id as number} ref=${ref} (stand = last node of the lead-in line, heading from lane to stand)${gates.length ? `; OSM gate node(s) ${gates.map((g: J) => `${g.properties.osm_id as number} (ref ${g.properties.ref as string}) ${dist(loc(g.geometry.coordinates[1], g.geometry.coordinates[0]), pts[pts.length - 1]).toFixed(0)} m`).join(', ')} from the stand point` : '; no OSM gate node with this ref'}`,
        leadIn: pts,
        node: -1,
        connectorLengthM: 0,
        connected: false,
      });
    }
    // --- GA: the three OSM parking_position ways without a ref (south ramp, next to the OSM hangar)
    const unref = parkingWays.filter((f: J) => !f.properties.ref);
    unref.forEach((way: J, i: number) => {
      used.add(way.properties.osm_id as number);
      const pts = toLocalPts(way.geometry.coordinates);
      parkRecs.push({
        id: `GA-${i + 1}`,
        name: `GA Ramp ${i + 1}`,
        pos: pts[pts.length - 1],
        category: 'ga',
        source: 'osm',
        approximate: false,
        zone: 'South ramp',
        notes: `OSM parking_position way/${way.properties.osm_id as number} (no ref, no name) on the south ramp next to the OSM hangar; stand = last node of the lead-in line.`,
        leadIn: pts,
        node: -1,
        connectorLengthM: 0,
        connected: false,
      });
    });
    // --- synthetic spots inside the real OSM apron polygon west of the terminal (the diagram's NORTH RAMP)
    const north = apronOf(NORTH_RAMP_APRON_OSM_ID).ring;
    const cands = sampleSpots(north, { spacing: syntheticSpotSpacingM, margin: 12, avoidBuildingsM: 20, accept: () => true });
    const picked = pickSpots(cands, 8, syntheticSpotSpacingM * 0.9, parkingConnectMaxM);
    picked.forEach((p: P, i: number) => {
      const fbo = i < 2;
      addSynthetic(
        { id: fbo ? `FBO-${i + 1}` : `GA-${i - 1 + 3}`, name: fbo ? `FBO Ramp ${i + 1}` : `GA North Ramp ${i - 1}`, category: fbo ? 'fbo' : 'ga', zone: 'North ramp', notes: 'Synthetic spot placed on a grid inside the OSM apron polygon west of the terminal (diagram label NORTH RAMP); OSM has no stand features there and the FBO ramp drawn on the diagram north of runway 9/27 is not mapped as an apron. Not an FAA-charted stand.' },
        p,
      );
    });
    const unused = parkingWays.filter((f: J) => !used.has(f.properties.osm_id as number)).map((f: J) => `way/${f.properties.osm_id as number}`);
    return {
      unusedParkingWays: unused,
      reportParagraph: 'The ten airline stands are OSM `parking_position` ways with ref 1-10 (lead-in polyline from the lane to the stand); OSM `gate` nodes exist for refs 1, 2, 2A, 3-7 inside the terminal and are only cited in the notes. The three OSM stands without a ref (south ramp) are GA stands. The FBO and further GA spots are SYNTHETIC grid points inside the OSM apron polygon of the north ramp (`source: "synthetic"`, `approximate: true`), because the FBO ramp is not mapped as an apron. No cargo spots: no cargo apron is mapped and none is sourced.',
      approximateSummary: ['- Parking: airline stands and three GA stands are real OSM ways; FBO / north-ramp GA spots are synthetic grid points inside a real apron polygon; no cargo ramp.'],
    };
  },
  frequencies({ freqSrc, callName, approachCallName, mk }: FrequencyCtx): RadioFrequency[] {
    const f: J = freqSrc.summary_by_function;
    const rows: J[] = freqSrc.all_frequencies_serving_airport;
    // CLNC and GND share 119.55 (NASR CD/P and GND/P); the engine routes a call by the position the aircraft's phase needs (radio/frequencies.ts aircraftPosition).
    const out: RadioFrequency[] = [
      mk('ATIS', `${callName} ATIS`, f.ATIS.vhf, 'ATIS', `hours ${f.ATIS.hours as string}; ${f.ATIS.note as string}`),
      mk('CLNC', `${callName} Clearance Delivery`, f.clearance_delivery.vhf, 'CLNC', `${f.clearance_delivery.note as string}. NASR remark: when the tower is closed clearance delivery is 127.05, monitored by Fort Myers approach control.`),
      mk('GND', `${callName} Ground`, f.ground.vhf, 'GND', f.ground.note as string),
      mk('TWR', `${callName} Tower`, f.tower.vhf, 'TWR', `${f.tower.note as string}; tower hours 0600-2100 (NASR TWR_HRS), CTAF 121.0 when closed (NASR FRQ CTAF row)`),
      mk('APP', `${approachCallName} Approach`, f.approach_departure.vhf, 'APP', `UHF ${f.approach_departure.uhf as string}; ${f.approach_departure.chart_name as string}. Facility ${f.approach_departure.facility as string} (${f.approach_departure.facility_name as string}). ${f.approach_departure.note as string}`),
      mk('DEP', `${approachCallName} Departure`, f.approach_departure.vhf, 'DEP', 'same frequency as approach (NASR use code APCH/P DEP/P)'),
    ];
    // NASR rows named for altitude strata or other facilities: listed, not worked as positions
    const pikkr = rows.find((r) => r.use_code === 'PIKKR STAR' && r.sectorization === '6000 FT & ABV');
    if (pikkr) out.push(mk('PIKKR-HIGH', `${approachCallName} Approach (6000 ft and above)`, pikkr.freq_mhz, 'OTHER', 'NASR FRQ row use PIKKR STAR, sectorization "6000 FT & ABV" (the 5000 FT & BLO row is 127.05, the primary approach frequency); not an assigned sector of this simulator', '6000 FT & ABV'));
    const rcag = rows.find((r) => r.use_code === 'FORT MYERS RCAG' && Number(r.freq_mhz) < 225);
    if (rcag) out.push(mk('ZMA-RCAG', 'Miami Center (Fort Myers RCAG)', rcag.freq_mhz, 'OTHER', 'NASR FRQ row FORT MYERS RCAG (sectorization LOW): approach/departure service by Miami ARTCC when Fort Myers approach control is closed; not worked in this simulator'));
    const tpa = rows.find((r) => r.use_code === 'LUBBR STAR' && Number(r.freq_mhz) < 225);
    if (tpa) out.push(mk('TPA-LUBBR', 'Tampa Approach (LUBBR STAR)', tpa.freq_mhz, 'OTHER', 'NASR FRQ row LUBBR STAR, facility TPA; the LUBBR FOUR arrival is flown under Tampa approach before the Fort Myers handoff; not worked in this simulator'));
    if (f.unicom.vhf) out.push(mk('UNICOM', `${callName} UNICOM`, f.unicom.vhf, 'OTHER', `${f.unicom.note as string}; not an ATC frequency`));
    return out;
  },
};
