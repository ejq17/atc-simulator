/**
 * Grammar of the traffic-variety instructions.
 *
 * Sources: JO 7110.65 3-7-2 ("proceed" / "hold" for vehicles), 3-1-3 and 3-7-2 (runway use by vehicles), FAA AC 150/5210-20A Appendix B para 4.3 (vehicle
 * calls and the controller replies "hold short of runway", "cleared off south on runway 19 right"), 3-11-1 (AIR-TAXI / HOVER-TAXI), 3-11-2 (helicopter
 * takeoff: "(present position, taxiway, helipad, numbers) MAKE RIGHT/LEFT TURN FOR (direction ...) DEPARTURE ... CLEARED FOR TAKEOFF"), 3-11-6 (helicopter
 * landing: "MAKE APPROACH STRAIGHT-IN ... TO (location, helipad ...) ... CLEARED TO LAND"), 3-10-12 (overhead maneuver: "PATTERN ALTITUDE (altitude). RIGHT TURNS.",
 * "REPORT INITIAL.", "BREAK AT (specified point). REPORT BREAK."). "PROCEED AS REQUESTED" is not approved for a runway (3-1-5 NOTE) and is not parsed.
 */
import { cmdHit, makeDraft, type Draft, type Rule } from './draft';
import { parseOneTaxiway, parseRunway, parseTaxiways } from './entities';
import { intAt, isOneOf, seq, skipWords, txt, type Toks } from './match';
import { parseParking } from './entities';

const COMPASS: Record<string, number> = { north: 360, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315 };

/** "coast guard [helipad|ramp] [N]" / "helipad N" / a named parking ("the ramp"): the destination field of a helicopter instruction, or null. */
export function parseHeliDest(t: Toks, i: number): { dest: string; next: number } | null {
  let j = skipWords(t, i, ['the']);
  const coast = txt(t, j) === 'CGD' || txt(t, j) === 'cgd' || txt(t, j) === 'uscg';
  if (coast) j++;
  const k = skipWords(t, j, ['helipad', 'pad', 'ramp']);
  const named = coast || k > j;
  if (!named) {
    const park = parseParking(t, i);
    return park ? { dest: park.dest, next: park.next } : null;
  }
  const n = intAt(t, k);
  if (n !== null && n.length <= 1) return { dest: `USCG-${n}`, next: k + 1 };
  return { dest: coast ? 'USCG' : 'HELIPAD', next: k };
}

/** "[pad,] make right turn [for] southeast departure, cleared for takeoff [from present position|helipad ...]" and "cleared for takeoff from present position". */
export const ruleHeliTakeoff: Rule = (t, i) => {
  const d: Draft = makeDraft('TAKEOFF');
  let j = i;
  // optional leading location: "present position", "coast guard helipad one"
  const pp = seq(t, j, 'present position');
  if (pp >= 0) {
    d.fields.destination = 'PRESENT';
    j = pp;
  } else if (txt(t, j) === 'CGD' || isOneOf(t, j, ['helipad', 'pad'])) {
    const hd = parseHeliDest(t, j);
    if (hd) {
      d.fields.destination = hd.dest;
      j = hd.next;
    }
  }
  if (txt(t, j) === ',') j++;
  // turn clause: "make right turn [for] <direction> departure"
  const side = seq(t, j, 'make') >= 0 ? txt(t, j + 1) : txt(t, j);
  const turnStart = seq(t, j, 'make') >= 0 ? j + 1 : j;
  if ((side === 'left' || side === 'right') && txt(t, turnStart + 1) === 'turn') {
    d.fields.turnDirection = side;
    j = skipWords(t, turnStart + 2, ['for']);
    const comp = COMPASS[txt(t, j)];
    if (comp !== undefined) {
      d.fields.headingDeg = comp;
      j++;
    } else if (txt(t, j) === 'heading' && intAt(t, j + 1) !== null) {
      d.fields.headingDeg = Number(intAt(t, j + 1));
      j += 2;
    }
    j = skipWords(t, j, ['departure']);
    if (txt(t, j) === ',') j++;
  }
  const c = seq(t, j, 'cleared|clear for|to? the? takeoff');
  if (c < 0) return null;
  j = c;
  const from = seq(t, j, 'from|at|on');
  if (from >= 0) {
    const k = skipWords(t, from, ['the']);
    if (parseRunway(t, k)) return null; // a runway named: the ordinary takeoff rule
    const pp2 = seq(t, k, 'present position');
    if (pp2 >= 0) {
      d.fields.destination = 'PRESENT';
      j = pp2;
    } else if (txt(t, k) === 'taxiway') {
      const one = parseOneTaxiway(t, k + 1);
      if (!one) return null;
      d.fields.destination = `TWY${one.id}`;
      j = one.next;
    } else {
      const hd = parseHeliDest(t, k);
      if (!hd) return null;
      d.fields.destination = hd.dest;
      j = hd.next;
    }
  } else if (!d.fields.destination) {
    return null; // "cleared for takeoff" alone (or with a runway) belongs to the ordinary takeoff rule
  }
  return cmdHit(j, d);
};

/** "[make straight-in approach to] <helipad>, cleared to land" for a helicopter, i.e. "cleared to land" followed by a helipad / ramp, not a runway. */
export const ruleHeliLand: Rule = (t, i) => {
  let j = i;
  const pre = seq(t, j, 'make straight in|circling approach to?');
  let dest: { dest: string; next: number } | null = null;
  if (pre >= 0) {
    dest = parseHeliDest(t, pre);
    if (!dest) return null;
    j = dest.next;
    if (txt(t, j) === ',') j++;
    const c = seq(t, j, 'cleared|clear for|to? the? land');
    if (c < 0) return cmdHit(j, Object.assign(makeDraft('LAND', { destination: dest.dest }), {}));
    return cmdHit(c, makeDraft('LAND', { destination: dest.dest }));
  }
  const c = seq(t, j, 'cleared|clear for|to? the? land');
  if (c < 0) return null;
  dest = parseHeliDest(t, skipWords(t, c, ['at', 'on', 'to']));
  if (!dest) return null;
  return cmdHit(dest.next, makeDraft('LAND', { destination: dest.dest }));
};

/** "air taxi [via alpha] [to|direct] <where>" / "hover taxi to <where>" (3-11-1). */
export const ruleAirTaxi: Rule = (t, i) => {
  const hover = seq(t, i, 'hover taxi');
  const air = hover >= 0 ? -1 : seq(t, i, 'air taxi');
  const j0 = hover >= 0 ? hover : air;
  if (j0 < 0) return null;
  const d = makeDraft('AIR_TAXI', { taxiMode: hover >= 0 ? 'hover' : 'air' });
  let j = j0;
  const route: string[] = [];
  for (;;) {
    j = skipWords(t, j, ['direct', 'to', 'the', 'and', 'then']);
    if (isOneOf(t, j, ['via', 'along', 'using', 'taxiway', 'taxiways'])) {
      const tw = parseTaxiways(t, j);
      if (!tw.ids.length) break;
      route.push(...tw.ids);
      j = tw.next;
      continue;
    }
    if (!d.fields.destination) {
      const rw = parseRunway(t, j);
      if (rw && rw.ok) { d.fields.destination = `RWY${rw.ref.end}`; j = rw.next; continue; }
      const hd = parseHeliDest(t, j);
      if (hd) { d.fields.destination = hd.dest; j = hd.next; continue; }
      if (txt(t, j) === 'taxiway') {
        const one = parseOneTaxiway(t, j + 1);
        if (one) { d.fields.destination = `TWY${one.id}`; j = one.next; continue; }
      }
    }
    break;
  }
  if (route.length) d.fields.route = route;
  return cmdHit(j, d);
};

/**
 * "proceed on runway N [, report ... complete|clear]" (a vehicle onto a runway), "proceed on the taxiways", and "proceed to ... " = a vehicle taxi: the
 * taxi rule parses the destination and route after the verb. Only claims "proceed" followed by on/to/via with a runway, taxiway or ramp word, so
 * "proceed direct <fix>" and "proceed as requested" stay with the other rules.
 */
export const makeProceedRule = (taxiRule: Rule): Rule => (t, i) => {
  if (txt(t, i) !== 'proceed') return null;
  let j = i + 1;
  if (isOneOf(t, j, ['on', 'along'])) {
    j = skipWords(t, j + 1, ['the']);
    if (isOneOf(t, j, ['taxiway', 'taxiways', 'all'])) {
      j = skipWords(t, j, ['taxiway', 'taxiways', 'all', 'the']);
      return cmdHit(j, makeDraft('PROCEED', { destination: 'TAXIWAYS' }));
    }
    const rw = parseRunway(t, j);
    if (!rw) return null;
    const d = makeDraft('PROCEED');
    if (rw.ok) { d.fields.runwayEnd = rw.ref.end; d.fields.runwayId = rw.ref.id; } else { d.issues.push(rw.reason); d.unknownIds++; }
    j = rw.next;
    // "report runway inspection complete" / "report clear of the runway"
    const rep = seq(t, j, 'report');
    if (rep >= 0) {
      const e = skipWords(t, rep, ['runway', 'inspection', 'complete', 'clear', 'of', 'the', 'off', 'when']);
      if (e > rep) { d.fields.reportClear = true; j = e; }
    }
    return cmdHit(j, d);
  }
  if (isOneOf(t, j, ['to', 'via']) && (isOneOf(t, j + 1, ['runway', 'the', 'ramp', 'parking']) || txt(t, j) === 'via' || parseParking(t, j + 1))) {
    // reuse the taxi rule on a copy of the tokens where "proceed" reads "taxi"
    const copy = t.slice();
    copy[i] = { ...t[i], text: 'taxi' };
    return taxiRule(copy, i);
  }
  return null;
};

/** The overhead maneuver (3-10-12): "runway 6, wind ..., pattern altitude 6000, right turns, report initial" and "break at midfield, report break". */
export const ruleOverhead: Rule = (t, i) => {
  // "break at midfield, report break" / "report break"
  const br = seq(t, i, 'break at midfield|specified? point?');
  if (br >= 0 || seq(t, i, 'report break') >= 0) {
    let j = br >= 0 ? br : i;
    j = skipWords(t, j, [',']);
    const rb = seq(t, j, 'report break');
    return cmdHit(rb >= 0 ? rb : j, makeDraft('OVERHEAD', { destination: 'BREAK' }));
  }
  // find "pattern altitude N" or "report initial" ahead of a leading "runway N" within a short window
  const start = txt(t, i) === 'runway' ? i : -1;
  const window = t.slice(i, i + 22).map((x) => x.text);
  const hasPattern = window.includes('pattern') || (window.includes('report') && window.includes('initial'));
  if (start < 0 && !(txt(t, i) === 'pattern' || (txt(t, i) === 'report' && txt(t, i + 1) === 'initial'))) return null;
  if (!hasPattern) return null;
  const d = makeDraft('OVERHEAD', { destination: 'INITIAL' });
  let j = i;
  const rw = parseRunway(t, j);
  if (rw) {
    if (rw.ok) { d.fields.runwayEnd = rw.ref.end; d.fields.runwayId = rw.ref.id; } else { d.issues.push(rw.reason); d.unknownIds++; }
    j = rw.next;
  }
  // skip the wind clause up to "pattern" / "right turns" / "report"
  while (j < t.length && !isOneOf(t, j, ['pattern', 'report', 'right', 'left', 'break'])) j++;
  const pa = seq(t, j, 'pattern altitude');
  if (pa >= 0) {
    const n = intAt(t, pa);
    if (n !== null) { d.fields.altitudeFt = Number(n); j = pa + 1; }
    else j = pa;
  }
  j = skipWords(t, j, [',']);
  const turns = seq(t, j, 'right|left turns');
  if (turns >= 0) { d.fields.turnDirection = txt(t, j) as 'left' | 'right'; j = turns; }
  j = skipWords(t, j, [',']);
  const ri = seq(t, j, 'report initial');
  if (ri >= 0) j = ri;
  return cmdHit(j, d);
};

/** 3-10-1 "RIGHT TRAFFIC." / "MAKE RIGHT TRAFFIC." / "RIGHT TRAFFIC APPROVED.": the pattern direction for an arrival (taken as an enter-downwind instruction on that side). */
export const ruleTrafficDirection: Rule = (t, i) => {
  const j = seq(t, i, 'make|enter? left|right traffic approved?');
  if (j < 0) return null;
  const side = isOneOf(t, i, ['left', 'right']) ? txt(t, i) : txt(t, i + 1);
  if (side !== 'left' && side !== 'right') return null;
  if (isOneOf(t, j, ['closed'])) return null; // "right closed traffic" belongs to the closed-traffic rule
  return cmdHit(j, makeDraft('ENTER_PATTERN', { patternLeg: side === 'left' ? 'left_downwind' : 'right_downwind' }));
};
