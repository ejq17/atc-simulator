/**
 * Flight progress strip board: a pure, framework-free model of the strips a controller would have in the bays in front of them.
 *
 * - One bay per position (CLNC, GND, TWR, APP/DEP). A strip is "printed" into the bay of the frequency the aircraft is on the first
 *   time the board sees it, and MOVES to the next bay when the aircraft changes frequency (a handoff, by the player or by an AI).
 * - Clearance abbreviations are read from `Aircraft.clearances`, i.e. exactly what the engine accepted (a rejected or refused call never
 *   marks a strip). Takeoff and landing times are the sim times the board saw the aircraft leave / reach the ground, in Zulu.
 * - Everything the controller does on the board (sequence, strike, drop, notes) is kept here for the session; nothing is written back to the engine.
 */
import type { Aircraft, Airport, Clearance, ControllerPositionId, SimulationState } from '../../sim/types';
import { sameFrequency } from '../../radio/frequencies';

export type BayId = 'CLNC' | 'GND' | 'TWR' | 'APPDEP' | 'OTHER';

/** Bays in board order (left to right on a real rack). OTHER only exists when an aircraft is on a frequency no bay owns. */
export const BAY_ORDER: readonly BayId[] = ['CLNC', 'GND', 'TWR', 'APPDEP'];
export const BAY_LABEL: Record<BayId, string> = { CLNC: 'CLNC', GND: 'GND', TWR: 'TWR', APPDEP: 'APP/DEP', OTHER: 'OTHER' };
const BAY_POSITIONS: Record<BayId, readonly ControllerPositionId[]> = { CLNC: ['CLNC'], GND: ['GND'], TWR: ['TWR'], APPDEP: ['APP', 'DEP'], OTHER: [] };

export function bayOfPosition(p: ControllerPositionId): BayId {
  return p === 'APP' || p === 'DEP' ? 'APPDEP' : p;
}

/** The bay that owns a frequency: its airport-data position decides (APP, DEP and the DEP sectors share one bay). */
export function bayForFrequency(airport: Pick<Airport, 'frequencies'>, mhz: number): BayId {
  const f = airport.frequencies.find((x) => sameFrequency(x.mhz, mhz));
  if (!f || f.position === 'ATIS' || f.position === 'OTHER') return 'OTHER';
  return bayOfPosition(f.position);
}

/** Does the player work this bay (any of its positions)? Otherwise an AI controller does. */
export function bayWorkedByPlayer(bay: BayId, playerPositions: readonly ControllerPositionId[]): boolean {
  return BAY_POSITIONS[bay].some((p) => playerPositions.includes(p));
}

/** Bays that exist in a session: those whose positions are in the session (player or AI). */
export function bayListFor(sessionPositions: readonly ControllerPositionId[]): BayId[] {
  return BAY_ORDER.filter((b) => BAY_POSITIONS[b].some((p) => sessionPositions.includes(p)));
}

// ---------------------------------------------------------------------------------------------------------------------
// Time and marking
// ---------------------------------------------------------------------------------------------------------------------

/** Epoch ms of sim time 0, or a function from sim seconds to UTC ms (real-time mode moves the epoch when the clock re-locks). */
export type UtcSource = number | ((simSec: number) => number);

const two = (n: number) => String(n).padStart(2, '0');

/** "1203Z": the time FAA strips carry. */
export function zuluHm(startUtcMs: UtcSource, simSec: number): string {
  const d = new Date(typeof startUtcMs === 'function' ? startUtcMs(simSec) : startUtcMs + simSec * 1000);
  return `${two(d.getUTCHours())}${two(d.getUTCMinutes())}Z`;
}

export interface StripMark {
  /** Clearance id (or a synthetic id for times): marks are idempotent. */
  id: string;
  /** What is written on the strip, e.g. "C 13", "LUAW", "X 13/31", "T/O 1203Z". */
  text: string;
  /** Plain-language meaning, shown as a tooltip and in the legend. */
  title: string;
  timeSec: number;
  kind: 'clearance' | 'time';
}

const runwayNum = (id: string | undefined): string => (id ?? '').replace(/^RWY\s*/i, '').split('/')[0];

/**
 * The strip abbreviation for a clearance the engine accepted, or null for clearances that go elsewhere on the strip
 * (an altitude goes in the altitude box, a squawk in the squawk box) or that are not written down (radar contact).
 */
export function markForClearance(c: Clearance): Pick<StripMark, 'text' | 'title'> | null {
  const rwy = runwayNum(c.runwayEnd ?? c.runwayId);
  switch (c.kind) {
    case 'APPROACH':
      return { text: `C ${rwy}`.trim(), title: `Cleared ${c.approachType ?? ''} ${rwy ? `runway ${rwy} ` : ''}approach`.replace(/\s+/g, ' ').trim() };
    case 'LAND': {
      const hs = c.holdShort?.[0];
      if (hs) return { text: `LAHSO ${runwayNum(hs)}`, title: `Cleared to land runway ${rwy}, land and hold short of runway ${hs}` };
      return { text: `CTL ${rwy}`.trim(), title: `Cleared to land runway ${rwy}` };
    }
    case 'LINE_UP_AND_WAIT':
      return { text: 'LUAW', title: `Line up and wait${rwy ? `, runway ${rwy}` : ''}` };
    case 'TAKEOFF': {
      // the departure heading given with the clearance (JO 7110.65 5-8-2) shows on the strip: "CTO 13 L270" / "CTO 13 H180"
      const hd = c.headingDeg !== undefined && c.runwayEnd ? `${c.turnDirection === 'left' ? 'L' : c.turnDirection === 'right' ? 'R' : 'H'}${String(Math.round(c.headingDeg)).padStart(3, '0')}` : '';
      return { text: `CTO ${rwy}${hd ? ` ${hd}` : ''}`.trim(), title: `Cleared for takeoff${rwy ? `, runway ${rwy}` : ''}${hd ? `, ${c.turnDirection ? `turn ${c.turnDirection} ` : ''}fly heading ${String(Math.round(c.headingDeg!)).padStart(3, '0')} after takeoff` : ''}` };
    }
    case 'HOLD_SHORT': {
      const where = runwayNum(c.holdShort?.[0] ?? c.runwayEnd ?? c.runwayId);
      return { text: `H/S ${where}`.trim(), title: `Hold short of ${where ? `runway ${where}` : 'the runway'}` };
    }
    case 'CROSS_RUNWAY': {
      const id = c.runwayId ?? c.runwayEnd ?? '';
      return { text: `X ${id.replace(/^RWY\s*/i, '')}`.trim(), title: `Cross runway ${id}` };
    }
    case 'TAXI':
      return { text: c.route?.length ? `TX ${c.route.join(' ')}` : 'TX', title: `Taxi${c.route?.length ? ` via ${c.route.join(' ')}` : ''}${c.destination ? ` to ${c.destination}` : ''}` };
    case 'TAXI_TO_PARKING':
      return { text: 'TX PKG', title: 'Taxi to parking' };
    case 'PUSHBACK':
      return { text: 'PB', title: 'Pushback approved' };
    case 'HOLD_POSITION':
      return { text: 'HP', title: 'Hold position' };
    case 'TURN_AROUND':
      return { text: '180', title: 'Turn around (one eighty)' };
    case 'GO_AROUND':
      return { text: 'GA', title: 'Go around' };
    case 'CONTINUE_APPROACH':
      return { text: 'CA', title: 'Continue approach' };
    case 'MISSED_APPROACH':
      return { text: 'MA', title: 'Missed approach' };
    case 'IFR_CLEARANCE':
      return { text: 'CLR', title: 'IFR clearance issued' };
    case 'HEADING':
      return { text: `HDG ${String(Math.round(c.headingDeg ?? 0)).padStart(3, '0')}`, title: `Fly heading ${Math.round(c.headingDeg ?? 0)}${c.turnDirection ? `, turn ${c.turnDirection}` : ''}` };
    case 'SPEED':
      return { text: `SPD ${Math.round(c.speedKt ?? 0)}`, title: `Maintain ${Math.round(c.speedKt ?? 0)} knots` };
    case 'DIRECT_FIX':
      return { text: `DCT ${c.fix ?? ''}`.trim(), title: `Proceed direct ${c.fix ?? ''}`.trim() };
    case 'RESUME_OWN_NAVIGATION':
      return { text: 'RON', title: 'Resume own navigation' };
    case 'HOLD_AT_FIX':
      return { text: `HLD ${c.fix ?? ''}`.trim(), title: `Hold at ${c.fix ?? 'the fix'}` };
    case 'ENTER_PATTERN':
      return { text: 'PAT', title: 'Enter the traffic pattern' };
    case 'RADAR_CONTACT':
      return { text: 'RC', title: 'Radar contact' };
    case 'STAR':
      return { text: c.descendVia ? 'DV' : 'STAR', title: c.descendVia ? 'Descend via the arrival' : 'Cleared on the arrival' };
    case 'EXIT_RUNWAY':
      return { text: c.destination === 'END' ? 'EXIT END' : `EXIT ${c.exitTaxiway ?? ''}`.trim(), title: `Exit the runway${c.exitTaxiway ? ` at ${c.exitTaxiway}` : c.destination === 'END' ? ' at the end' : ' at the next taxiway'}${c.turnDirection ? `, turn ${c.turnDirection}` : ''}` };
    case 'CANCEL_TAKEOFF':
      return { text: 'CNX TO', title: 'Takeoff clearance cancelled' };
    case 'TRAFFIC_ADVISORY':
      return { text: 'TFC', title: `Traffic information${c.trafficResponse ? ` (pilot: ${c.trafficResponse.replace('_', ' ')})` : ''}` };
    case 'FOLLOW_TRAFFIC':
      return { text: c.sequenceNumber ? `#${c.sequenceNumber} FLW` : 'FLW', title: 'Follow the named traffic' };
    case 'PATTERN_INSTRUCTION': {
      const t: Record<string, [string, string]> = {
        EXTEND_DOWNWIND: ['EXT DW', 'Extend downwind'], TURN_BASE_NOW: ['BASE', 'Turn base now'], SHORT_APPROACH: ['SHORT', 'Short approach'],
        CIRCLE: [`${c.turnDegrees ?? 360}${c.turnDirection === 'right' ? 'R' : 'L'}`, `Make a ${c.turnDirection ?? 'left'} ${c.turnDegrees ?? 360}`], CLOSED_TRAFFIC: ['CLSD', 'Closed traffic'],
      };
      const [text, title] = t[c.destination ?? ''] ?? ['PAT', 'Pattern instruction'];
      return { text, title };
    }
    case 'REPORT_POSITION':
      return { text: 'RPT', title: 'Report position' };
    case 'FREQUENCY_CHANGE_APPROVED':
      return { text: 'FC OK', title: 'Frequency change approved' };
    case 'ALTITUDE':
    case 'SQUAWK':
    case 'AIRPORT_INFO':
    case 'CONTACT_FREQUENCY':
      return null; // altitude box / squawk box / not written down / the strip moves to the next bay
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Strip data
// ---------------------------------------------------------------------------------------------------------------------

/** What is printed on the strip. A snapshot, refreshed while the aircraft exists, so a strip stays readable after the aircraft has left. */
export interface StripFields {
  callsign: string;
  /** "C172/G": type and assumed equipment suffix. */
  typeEquip: string;
  flightRules: 'IFR' | 'VFR';
  /** Flown by a student pilot (marker on the strip). */
  student?: boolean;
  squawk?: string;
  origin: string;
  destination: string;
  route: string[];
  requestedAltitudeFt?: number;
  assignedAltitudeFt?: number;
  runway?: string;
  /** Request badge / phase shown in the right-hand corner. */
  phase: string;
}

export interface Strip {
  /** Aircraft id. */
  id: string;
  callsign: string;
  bay: BayId;
  /** Sequence within the bay (ascending). */
  order: number;
  printedSec: number;
  bayEnteredSec: number;
  /** Wall-clock ms (performance.now) at print / move, so the UI can animate only a fresh arrival. */
  bayEnteredWall: number;
  entry: 'print' | 'move';
  fromBay?: BayId;
  /** Bays this strip has been through, oldest first. */
  path: BayId[];
  marks: StripMark[];
  takeoffSec?: number;
  landedSec?: number;
  notes: string;
  struck: boolean;
  struckSec?: number;
  gone: boolean;
  goneSec?: number;
  fields: StripFields;
}

const EQUIP: Record<string, string> = { C172: 'G', A320: 'L' };

function altitudeAssigned(ac: Aircraft): number | undefined {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind === 'ALTITUDE' && c.altitudeFt !== undefined) return c.altitudeFt;
  }
  const ic = ac.flightPlan?.ifrClearance;
  if (ic && ac.isDeparture) return ic.initialAltitudeFt;
  return undefined;
}

export function stripFieldsOf(ac: Aircraft): StripFields {
  const suffix = EQUIP[ac.type];
  return {
    callsign: ac.callsign,
    typeEquip: suffix ? `${ac.type}/${suffix}` : ac.type,
    flightRules: ac.flightRules,
    ...(ac.student ? { student: true } : {}),
    squawk: ac.squawk ?? ac.flightPlan?.squawk,
    origin: ac.origin,
    destination: ac.destination,
    route: ac.flightPlan?.route ?? [],
    requestedAltitudeFt: ac.flightPlan?.cruiseAltitudeFt,
    assignedAltitudeFt: altitudeAssigned(ac),
    runway: ac.assignedRunwayEnd,
    phase: ac.phase,
  };
}

/** The strips of a bay in display order: active in sequence, then struck, then gone (aircraft left), each by when they ended. */
export function displayOrder(strips: readonly Strip[]): Strip[] {
  const active = strips.filter((s) => !s.struck && !s.gone).sort((a, b) => a.order - b.order);
  const struck = strips.filter((s) => s.struck && !s.gone).sort((a, b) => (a.struckSec ?? 0) - (b.struckSec ?? 0) || a.order - b.order);
  const gone = strips.filter((s) => s.gone).sort((a, b) => (a.goneSec ?? 0) - (b.goneSec ?? 0) || a.order - b.order);
  return [...active, ...struck, ...gone];
}

// ---------------------------------------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------------------------------------

export interface StripBoardOptions {
  startUtcMs: UtcSource;
  /** Wall clock for animation stamps; injectable for tests. */
  wallNow?: () => number;
  /** Finished (struck or gone) strips kept per bay before the oldest is dropped. Default 8. */
  maxFinishedPerBay?: number;
}

export interface StripBoard {
  /** Re-read the engine state: print new strips, move strips on handoff, add marks and times, retire strips of aircraft that left. */
  update(state: SimulationState): void;
  get(id: string): Strip | undefined;
  /** Strips of one bay in display order. */
  bay(bay: BayId): Strip[];
  /** All strips (any order). */
  all(): Strip[];
  /** Bays that have at least one strip, in board order (includes OTHER when used). */
  usedBays(): BayId[];
  setNotes(id: string, notes: string): void;
  /** Toggle struck (handled). Returns the new state, or undefined for an unknown strip. */
  strike(id: string): boolean | undefined;
  /** Remove the strip. Only allowed once it is struck or the aircraft has left; returns whether it was removed. */
  drop(id: string): boolean;
  /** Put `id` immediately before `beforeId` in the bay's sequence (null/undefined = at the end of the active strips). Both must share a bay. */
  reorder(id: string, beforeId?: string | null): boolean;
  /** Move `id` one place earlier (-1) or later (+1) among the active strips of its bay. */
  nudge(id: string, delta: -1 | 1): boolean;
  /** Increases whenever anything on the board changed (strips, marks, order, strike, notes), so views can memoise. */
  version(): number;
}

export function createStripBoard(opts: StripBoardOptions): StripBoard {
  const wall = opts.wallNow ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const maxFinished = opts.maxFinishedPerBay ?? 8;
  const strips = new Map<string, Strip>();
  /** Aircraft whose strip the controller dropped, and the bay it was dropped from: it is reprinted only in a different bay. */
  const dropped = new Map<string, BayId>();
  const sawAirborne = new Set<string>();
  /** Clearance ids already read per aircraft (including ones that write nothing on the strip). */
  const readClearances = new Map<string, Set<string>>();
  let strikeSeq = 0;
  let seq = 0;
  let version = 0;
  let firstUpdate = true;
  const bump = () => { version++; };

  function nextOrder(): number {
    return ++seq;
  }

  function trimFinished(bay: BayId) {
    const finished = displayOrder([...strips.values()].filter((s) => s.bay === bay)).filter((s) => s.struck || s.gone);
    for (let i = 0; i < finished.length - maxFinished; i++) {
      strips.delete(finished[i].id);
      dropped.delete(finished[i].id);
      bump();
    }
  }

  function addMark(s: Strip, m: StripMark): void {
    if (s.marks.some((x) => x.id === m.id)) return;
    s.marks.push(m);
    bump();
  }

  function update(state: SimulationState) {
    const t = state.clock.timeSec;
    const now = wall();
    const seen = new Set<string>();
    for (const ac of Object.values(state.aircraft)) {
      seen.add(ac.id);
      const bay = bayForFrequency(state.airport, ac.frequencyMhz);
      let s = strips.get(ac.id);
      if (dropped.has(ac.id) && dropped.get(ac.id) !== bay) dropped.delete(ac.id);
      if (!s) {
        if (dropped.has(ac.id)) continue;
        s = {
          id: ac.id, callsign: ac.callsign, bay, order: nextOrder(), printedSec: t, bayEnteredSec: t,
          // The aircraft that exist when the session opens are already on the rack: no print animation for them.
          bayEnteredWall: firstUpdate ? 0 : now, entry: 'print', path: [bay], marks: [], notes: '',
          struck: false, gone: false, fields: stripFieldsOf(ac),
        };
        strips.set(ac.id, s);
        bump();
      } else if (s.bay !== bay) {
        // Handoff: the strip goes to the other bay's rack, at the end of its sequence, and starts fresh (not struck).
        const from = s.bay;
        s.fromBay = from;
        s.bay = bay;
        s.order = nextOrder();
        s.bayEnteredSec = t;
        s.bayEnteredWall = now;
        s.entry = 'move';
        s.path.push(bay);
        s.struck = false;
        s.struckSec = undefined;
        s.gone = false;
        bump();
        trimFinished(from);
      }
      if (s.gone) { s.gone = false; s.goneSec = undefined; bump(); }

      // Static fields (the aircraft may have been given a squawk or a runway since the last look).
      const f = stripFieldsOf(ac);
      if (JSON.stringify(f) !== JSON.stringify(s.fields)) { s.fields = f; bump(); }

      // Clearances the engine accepted -> abbreviations.
      let read = readClearances.get(ac.id);
      if (!read) readClearances.set(ac.id, (read = new Set()));
      for (const c of ac.clearances) {
        if (read.has(c.id)) continue;
        read.add(c.id);
        const m = markForClearance(c);
        if (m) addMark(s, { id: c.id, ...m, timeSec: c.issuedAtSec, kind: 'clearance' });
      }
      // Times: liftoff and touchdown as the board saw them.
      if (!ac.onGround) {
        sawAirborne.add(ac.id);
        if (ac.isDeparture && s.takeoffSec === undefined) {
          s.takeoffSec = t;
          addMark(s, { id: `${ac.id}:to`, text: `T/O ${zuluHm(opts.startUtcMs, t)}`, title: `Airborne at ${zuluHm(opts.startUtcMs, t)}`, timeSec: t, kind: 'time' });
        }
      } else if (!ac.isDeparture && sawAirborne.has(ac.id) && s.landedSec === undefined) {
        s.landedSec = t;
        addMark(s, { id: `${ac.id}:ld`, text: `L ${zuluHm(opts.startUtcMs, t)}`, title: `Landed at ${zuluHm(opts.startUtcMs, t)}`, timeSec: t, kind: 'time' });
      }
    }
    // Aircraft that left the airspace: the strip stays (greyed, at the bottom) until the controller drops it.
    for (const s of strips.values()) {
      if (!seen.has(s.id) && !s.gone) {
        s.gone = true;
        s.goneSec = t;
        bump();
        trimFinished(s.bay);
      }
    }
    for (const id of [...dropped.keys()]) if (!seen.has(id)) dropped.delete(id);
    for (const id of [...readClearances.keys()]) if (!strips.has(id) && !seen.has(id)) readClearances.delete(id);
    firstUpdate = false;
  }

  return {
    update,
    get: (id) => strips.get(id),
    bay: (bay) => displayOrder([...strips.values()].filter((s) => s.bay === bay)),
    all: () => [...strips.values()],
    usedBays() {
      const used = new Set([...strips.values()].map((s) => s.bay));
      return [...BAY_ORDER, 'OTHER' as BayId].filter((b) => used.has(b));
    },
    setNotes(id, notes) {
      const s = strips.get(id);
      if (!s || s.notes === notes) return;
      s.notes = notes;
      bump();
    },
    strike(id) {
      const s = strips.get(id);
      if (!s) return undefined;
      s.struck = !s.struck;
      s.struckSec = s.struck ? ++strikeSeq : undefined;
      bump();
      return s.struck;
    },
    drop(id) {
      const s = strips.get(id);
      if (!s || !(s.struck || s.gone)) return false;
      strips.delete(id);
      if (!s.gone) dropped.set(id, s.bay);
      bump();
      return true;
    },
    reorder(id, beforeId) {
      const s = strips.get(id);
      if (!s || s.struck || s.gone || id === beforeId) return false;
      const lane = displayOrder([...strips.values()].filter((x) => x.bay === s.bay)).filter((x) => !x.struck && !x.gone && x.id !== id);
      let at = lane.length;
      if (beforeId) {
        const idx = lane.findIndex((x) => x.id === beforeId);
        if (idx < 0) return false; // different bay, struck or unknown
        at = idx;
      }
      lane.splice(at, 0, s);
      lane.forEach((x, i) => { x.order = i + 1; });
      seq = Math.max(seq, lane.length);
      bump();
      return true;
    },
    nudge(id, delta) {
      const s = strips.get(id);
      if (!s || s.struck || s.gone) return false;
      const lane = displayOrder([...strips.values()].filter((x) => x.bay === s.bay)).filter((x) => !x.struck && !x.gone);
      const i = lane.findIndex((x) => x.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= lane.length) return false;
      [lane[i], lane[j]] = [lane[j], lane[i]];
      lane.forEach((x, k) => { x.order = k + 1; });
      seq = Math.max(seq, lane.length);
      bump();
      return true;
    },
    version: () => version,
  };
}

/** The "Strip marking" legend: what each abbreviation written on a strip means. */
export const STRIP_LEGEND: readonly { mark: string; meaning: string }[] = [
  { mark: 'C 13', meaning: 'Cleared for the approach to runway 13 (ILS, RNAV, visual)' },
  { mark: 'CTL 13', meaning: 'Cleared to land runway 13' },
  { mark: 'LAHSO 13', meaning: 'Cleared to land and hold short of runway 13' },
  { mark: 'LUAW', meaning: 'Line up and wait' },
  { mark: 'CTO 13', meaning: 'Cleared for takeoff runway 13' },
  { mark: 'T/O 1203Z', meaning: 'Airborne at 1203 Zulu' },
  { mark: 'L 1210Z', meaning: 'Landed at 1210 Zulu' },
  { mark: 'X 13/31', meaning: 'Cleared to cross runway 13/31' },
  { mark: 'H/S 13', meaning: 'Hold short of runway 13' },
  { mark: 'TX A D', meaning: 'Taxi via taxiways A, D' },
  { mark: 'HDG 090 · SPD 180 · DCT VCN', meaning: 'Heading, speed and direct-to instructions' },
  { mark: 'GA · MA · HP', meaning: 'Go around, missed approach, hold position' },
];

export const STRIP_KEYS: readonly { key: string; meaning: string }[] = [
  { key: 'S', meaning: 'Strike the selected strip (handled): strike-through, to the bottom of its bay. Again to undo.' },
  { key: 'X', meaning: 'Drop a struck strip, or one whose aircraft has left.' },
  { key: 'Drag ⠿', meaning: 'Resequence inside a bay (Alt+↑ / Alt+↓ on a focused strip).' },
];
