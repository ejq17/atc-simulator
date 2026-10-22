/**
 * EGLL (London Heathrow) build profile.
 *
 * Sources: UK AIP (NATS eAIP) AD 2.EGLL, AIRAC 10/2026 (data/sources/egll-*.json, hand-transcribed) and OpenStreetMap.
 * No aeronautical value is typed here: taxiway identifiers are read from egll-procedures.json (aerodrome chart), stand numbers
 * from egll-stands.json (AD 2-EGLL-2-4..2-7), frequencies from egll-frequencies.json (AD 2.18).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RadioFrequency } from '../../src/sim/types.ts';
import type { P } from '../lib/geom.ts';
import { dist } from '../lib/geom.ts';
import type { AirportProfile, FrequencyCtx, J, ParkingCtx } from './types.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/sources');
const readJson = (f: string): J => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));

const diagram: J = readJson('egll-procedures.json').airport_diagram;
/**
 * Identifiers the simulator can name: the command parser accepts a letter plus up to two digits ("A1", "N10"), so the diagram's
 * suffixed exits (A9E, N4W, S5E ...) and "Link nn" stubs stay unnamed geometry (named by continuity); see data/sources/README.md EGLL.
 */
const NAMEABLE = /^[A-Z]\d{0,2}$/;
const taxiwayIds: string[] = (diagram.taxiway_identifiers as string[]).filter((i) => NAMEABLE.test(i));

const stands: J = readJson('egll-stands.json');
const standTerminal = new Map<string, string>();
for (const c of Object.values(stands.charts) as J[]) for (const n of c.stand_numbers as string[]) standTerminal.set(n, c.terminal as string);

/** AD 2.20 para 2: "Cargo Area stands 601-609 and 614-616" (stands 611-613 are not in the stand charts). */
const isCargo = (ref: string): boolean => ref.startsWith('6');

export const egllProfile: AirportProfile = {
  icao: 'EGLL',
  slug: 'egll',
  buildCommand: 'scripts/build-airport.ts EGLL',
  taxiwayIds,
  osmRef(ref) {
    if (!ref) return null;
    const m = /^Taxiway ([A-Z])$/.exec(ref);
    return m ? m[1] : ref;
  },
  diagramPdf: 'AD 2-EGLL-2-1',
  chartedMagneticHeading(id, { endSrc }) {
    const h = endSrc.charted_magnetic_heading_deg as number | null;
    if (h === null || h === undefined) throw new Error(`no charted magnetic heading for runway end ${id} in egll-facility.json`);
    return h;
  },
  headingSourceNote: 'Charted magnetic headings (088 / 268) from the aerodrome chart AD 2-EGLL-2-1; true bearings from AD 2.12.',
  holdingPatternsFile: 'egll-holding-patterns.json',
  plateGeometryFile: 'egll-plate-geometry.json',
  hotSpotProvenanceNote: 'Hot spots HS1-HS5 are printed on the aerodrome chart AD 2-EGLL-2-1; no position is placed because the two runways do not cross.',
  holdAllBranches: true,
  relaxedChecks: { noGaFbo: true, holdPath: true, dropTinyLeadIn: true },
  diagramComparisonFile: 'egll-diagram-comparison.md',
  runwayEndpointNote: ' (the runways come from the AIP thresholds; pavement ends of 09L and 09R are derived from the displaced thresholds; OSM runway endpoints were not compared)',
  provenanceNotes: {
    navaids: 'egll-navaids.json (LON VOR/DME, OCK/BIG/LAM/BNN, EPM/CHT/WOD/BUR NDBs, DET/MID/SAM/CPT/BPK, 4 ILS/DME, STAR waypoints from the coding tables, 8 DERIVED ILS DME fixes)',
    procedures: 'egll-procedures.json: 12 approach charts (4 ILS/DME transcribed), aerodrome chart, 24 SIDs (route text), 18 RNAV STARs (transcribed from coding tables), hot spots HS1-HS5; chart PDFs are LINKED to the official NATS URLs, not bundled',
    osm: 'Taxiways, aprons, stands (parking_position ways), gates, buildings. Share-alike: the derived taxiway/apron dataset is an ODbL derivative.',
    diagramReconciliation: 'Taxiway identifier reconciliation against the UK AIP aerodrome chart (identifiers read from the chart text; see scripts/data/egll-diagram-comparison.md).',
  },
  extraApproximate: [
    '- Displaced thresholds of 09L (309 m) and 09R (308 m): `RunwayEnd.threshold` is the DERIVED pavement end, `displacedThresholdFt` moves the landing threshold to the AIP threshold coordinates.',
    '- Taxiway names with a suffix letter (A9E, N4W ...) and the "Link nn" stubs are not named in the graph (parser limit); stands are the OSM parking_position ways whose number is on the AIP stand charts, MARS sub-stands (209L/209R ...) are not separate positions.',
    '- No MVA sectors (the AD 2-EGLL-5-1 ATC surveillance minimum altitude chart is not transcribed).',
  ],
  spokenName: () => 'Heathrow',
  parking(ctx: ParkingCtx) {
    const { featsOf, toLocalPts, parkRecs, networkDistance, warn } = ctx;
    const ways = featsOf('parking_position').filter((f: J) => f.geometry.type === 'LineString' && /^\d{3}$/.test(String(f.properties.ref)) && standTerminal.has(String(f.properties.ref)));
    const byRef = new Map<string, J[]>();
    for (const w of ways) byRef.set(String(w.properties.ref), [...(byRef.get(String(w.properties.ref)) ?? []), w]);
    const unused: string[] = [];
    const refs = [...byRef.keys()].sort((a, b) => Number(a) - Number(b));
    for (const ref of refs) {
      const cands = byRef.get(ref)!;
      // several ways with one number (MARS variants, duplicated mapping): keep the one whose lane end is nearest the taxi network
      const scored = cands.map((f: J) => {
        let pts: P[] = toLocalPts(f.geometry.coordinates);
        if (pts.length > 1 && networkDistance(pts[pts.length - 1]) < networkDistance(pts[0])) pts = [...pts].reverse();
        return { f, pts, d: networkDistance(pts[0]) };
      }).sort((a, b) => a.d - b.d);
      const best = scored[0];
      for (const o of scored.slice(1)) unused.push(`way/${o.f.properties.osm_id as number}`);
      if (best.pts.length < 2 || dist(best.pts[0], best.pts[best.pts.length - 1]) < 5) {
        warn(`stand ${ref}: OSM way too short for a lead-in line`);
        continue;
      }
      const cargo = isCargo(ref);
      parkRecs.push({
        id: `STAND-${ref}`,
        name: `Stand ${ref}`,
        pos: best.pts[best.pts.length - 1],
        category: cargo ? 'cargo' : 'airline',
        source: 'osm',
        approximate: false,
        zone: standTerminal.get(ref)!,
        notes: `OSM parking_position way/${best.f.properties.osm_id as number} ref=${ref} (stand = last node of the lead-in line); stand number on AIP chart ${Object.entries(stands.charts).find(([, c]) => (c as J).stand_numbers.includes(ref))?.[0] ?? ''} (${standTerminal.get(ref)!}).`,
        leadIn: best.pts,
        node: -1,
        connectorLengthM: 0,
        connected: false,
      });
    }
    const all = featsOf('parking_position').filter((f: J) => f.geometry.type === 'LineString').map((f: J) => `way/${f.properties.osm_id as number}`);
    const used = new Set(parkRecs.map((r) => (/way\/(\d+)/.exec(r.notes ?? '') ?? [])[1]));
    const notUsed = all.filter((w: string) => !used.has(w.slice(4)));
    void unused;
    return {
      unusedParkingWays: notUsed,
      reportParagraph: `Stands are the OSM \`parking_position\` ways (lead-in line, last node = stand) whose three-digit number appears on the AIP stand charts AD 2-EGLL-2-4..2-7 (egll-stands.json): ${parkRecs.length} stands (Terminal 2: 2xx, Terminal 3: 3xx, Terminal 4: 4xx, Terminal 5: 5xx, cargo area 6xx). Where several ways carry one number the one nearest the taxi network is used; MARS sub-centrelines (L / R suffix), unnumbered ways and numbers not on the charts are not used (${notUsed.length} ways). No gate nodes are used (they sit inside the terminals).`,
      approximateSummary: ['- Parking: stand positions and lead-in lines are real OSM geometry; stand-to-terminal assignment follows the AIP stand charts; aircraft size limits per stand are not modelled.'],
    };
  },
  frequencies({ freqSrc, mk }: FrequencyCtx): RadioFrequency[] {
    const f: J = freqSrc.summary_by_function;
    const named = (id: string, call: string, mhz: number, pos: RadioFrequency['position'], note: string): RadioFrequency => ({ ...mk(id, call, String(mhz), pos, note), callName: call });
    const out: RadioFrequency[] = [
      { ...mk('ATIS', 'Heathrow Information', String(f.ATIS.arrival_mhz), 'ATIS', `Arrival ATIS (AD 2.18); also broadcast on ${(f.ATIS.vor_broadcast_mhz as J[]).map((v) => `${v.mhz as number} (${v.on as string})`).join(', ')}; departure ATIS ${f.ATIS.departure_mhz as number}`) },
      named('CLNC', 'Heathrow Delivery', f.delivery.mhz, 'CLNC', `${f.delivery.source as string}`),
      named('GND', 'Heathrow Ground', f.ground.mhz, 'GND', `Alternates ${(f.ground.alternates_mhz as number[]).join(', ')} (AD 2.18)`),
      named('TWR', 'Heathrow Tower', f.tower.mhz, 'TWR', `Alternates ${(f.tower.alternates_mhz as number[]).join(', ')}; ${f.tower.source as string}`),
      named('APP', 'Heathrow Director', f.director.mhz, 'APP', `Alternates ${(f.director.alternates_mhz as number[]).join(', ')} when instructed by ATC (AD 2.18)`),
      named('DEP', 'London Control', f.london_control.default_mhz, 'DEP', `Departures change to London Control after take-off; this is the frequency of the CPT and GASGU / GOGSI SID charts, the other SIDs print ${(f.london_control.by_sid_chart as J[]).map((c) => `${c.sids as string} ${c.mhz as number}`).join(', ')}`),
      mk('ATIS-DEP', 'Heathrow Information (departure)', String(f.ATIS.departure_mhz), 'OTHER', 'Departure ATIS (AD 2.18, DOC 5 NM / GND)'),
      mk('RADAR', 'Heathrow Radar', String(f.radar.mhz), 'OTHER', `${f.radar.note as string}; not an assigned position of this simulator`),
      mk('FIRE', 'Heathrow Fire', String(f.fire.mhz), 'OTHER', `${f.fire.note as string}`),
      mk('EMERG', 'Emergency', String(f.emergency.mhz), 'OTHER', 'Emergency frequency (AD 2.18)'),
    ];
    return out;
  },
};
