/**
 * Tower vocabulary beyond clearances: runway exit instructions, cancel takeoff clearance, traffic information,
 * sequencing and pattern instructions, position reports, frequency change / squawk and airport information.
 *
 * Sources (each rule): JO 7110.65 3-10-9 (exit), 3-9-11 (cancel), 3-1-6 / 2-1-21 (traffic), 3-8-1 (sequence / spacing),
 * 3-10-11 (closed traffic), 3-10-1 / 3-9-1 (landing / departure information), 7-6-11 (squawk VFR, frequency change approved),
 * 5-2-1 (squawk), 3-9-4 (LUAW traffic information). See docs/FAA-REFERENCES.md and docs/PHRASEOLOGY-AUDIT.md.
 */
import { cmdHit, fillerHit, makeDraft, type Draft, type Rule } from './draft';
import { parseOneTaxiway } from './entities';
import { intAt, isOneOf, seq, skipWords, txt, type Toks } from './match';
import type { AirportInfo, TrafficRef } from '../sim/types';

// ---------------------------------------------------------------------------
// Runway exit (3-10-9)
// ---------------------------------------------------------------------------

const EXIT_VERBS = ['turn', 'exit', 'vacate', 'leave', 'take'];

/**
 * 7110.65 3-10-9: "TURN LEFT/RIGHT (taxiway/runway)", "IF ABLE, TURN LEFT/RIGHT (taxiway/runway)"; examples "turn right next taxiway",
 * "turn left at Charlie". Also "exit [the runway] [left|right] [at] Charlie" and "continue to the end" (not in 7110.65: flagged non-standard).
 * "turn left heading 270" is not an exit (the heading rule takes it).
 */
export const ruleExitRunway: Rule = (t, i) => {
  let j = i;
  let ifAble = false;
  const able = seq(t, j, 'if able');
  if (able >= 0) { ifAble = true; j = able; }
  // "continue to the end [of the runway]" / "continue on to the end" / "roll to the end"
  const end = seq(t, j, 'continue|proceed|roll on? to the end of? the? runway?');
  if (end >= 0) {
    const d = makeDraft('EXIT_RUNWAY', { destination: 'END' });
    d.nonstandard++; // 7110.65 3-10-9 has no "continue to the end" phraseology
    return cmdHit(end, d);
  }
  // "left on Charlie" / "right at Bravo" (the verb dropped): a side followed by a preposition and a taxiway letter
  if (isOneOf(t, j, ['left', 'right']) && isOneOf(t, j + 1, ['on', 'at', 'onto'])) {
    const k = skipWords(t, j + 2, ['taxiway']);
    const tw0 = parseOneTaxiway(t, k);
    if (tw0) {
      const d0 = makeDraft('EXIT_RUNWAY', { turnDirection: txt(t, j) as 'left' | 'right', exitTaxiway: tw0.id });
      if (ifAble) d0.fields.ifAble = true;
      return cmdHit(tw0.next, d0);
    }
  }
  const verb = txt(t, j);
  if (!EXIT_VERBS.includes(verb)) return null;
  j++;
  j = skipWords(t, j, ['the', 'runway', 'at', 'on', 'onto', 'via', 'taxiway', 'to']);
  let side: 'left' | 'right' | undefined;
  if (isOneOf(t, j, ['left', 'right'])) { side = txt(t, j) as 'left' | 'right'; j++; }
  if (isOneOf(t, j, ['heading', 'base', 'downwind', 'final', 'traffic']) || intAt(t, j) !== null) return null;
  const next = txt(t, j) === 'next';
  if (next) j = skipWords(t, j + 1, ['taxiway', 'intersection', 'exit']);
  j = skipWords(t, j, ['at', 'on', 'onto', 'via', 'the', 'taxiway']);
  const tw = parseOneTaxiway(t, j);
  if (!tw && !next && !(side && verb !== 'turn')) return null; // a bare "turn left" stays an (incomplete) heading
  if (verb === 'take' && !tw && !next) return null;
  const d = makeDraft('EXIT_RUNWAY');
  if (side) d.fields.turnDirection = side;
  if (tw) { d.fields.exitTaxiway = tw.id; j = tw.next; }
  if (ifAble) d.fields.ifAble = true;
  if (!tw && !next) d.fields.destination = 'NEXT';
  if (next) d.fields.destination = 'NEXT';
  return cmdHit(j, d);
};

// ---------------------------------------------------------------------------
// Cancel takeoff clearance (3-9-11)
// ---------------------------------------------------------------------------

const REASON_WORDS = [
  'traffic', 'vehicle', 'aircraft', 'airplane', 'on', 'the', 'runway', 'crossing', 'ahead', 'landing', 'because', 'of', 'a', 'an',
  'departing', 'animal', 'animals', 'dog', 'bird', 'birds', 'deer', 'wildlife', 'debris', 'obstruction', 'person', 'incursion',
  'for', 'safety', 'reasons', 'in', 'your', 'path', 'at', 'taxiway', 'intersection', 'is', 'there',
];

/** "cancel takeoff clearance [reason]" (7110.65 3-9-11), "abort takeoff", "reject takeoff", "abort, abort". A bare "stop" stays HOLD_POSITION. */
export const ruleCancelTakeoff: Rule = (t, i) => {
  const verb = txt(t, i);
  if (!['cancel', 'abort', 'reject', 'aborting'].includes(verb)) return null;
  let j = i + 1;
  const sawObject = isOneOf(t, j, ['takeoff', 'take', 'departure', 'the', 'your']);
  j = skipWords(t, j, ['the', 'your', 'takeoff', 'take', 'off', 'departure', 'clearance', 'takeoffs']);
  if (!sawObject && verb === 'cancel') return null; // "cancel taxi ..." / "cancel that" go to the older rule
  if (!sawObject && verb !== 'cancel') {
    // "abort, abort" / "abort abort abort"
    while (txt(t, j) === verb) j++;
  }
  const d = makeDraft('CANCEL_TAKEOFF');
  const reasonEnd = skipWords(t, j, REASON_WORDS);
  if (reasonEnd > j) {
    d.fields.reason = t.slice(j, reasonEnd).map((x) => x.text).join(' ');
    j = reasonEnd;
  }
  return cmdHit(j, d);
};

// ---------------------------------------------------------------------------
// Traffic description (3-1-6, 2-1-21, 3-8-1)
// ---------------------------------------------------------------------------

const DESC_FILLER = ['the', 'a', 'an', 'on', 'at', 'is', 'in', 'to', 'your', 'ahead', 'of', 'you', 'heavy'];

/** Position clause at i, e.g. "two mile final", "on left base", "downwind", "departing runway 13", "ahead", "in position". */
function trafficPosition(t: Toks, i: number): { pos: Partial<TrafficRef>; next: number } | null {
  let j = i;
  const dist = intAt(t, j);
  if (dist !== null && seq(t, j + 1, 'mile|miles') >= 0) {
    j += 2;
    const side = isOneOf(t, j, ['left', 'right']) ? (txt(t, j++) as 'left' | 'right') : undefined;
    const w = txt(t, j);
    if (['final', 'base', 'downwind', 'upwind', 'crosswind'].includes(w)) {
      return { pos: { position: w as TrafficRef['position'], distanceNm: Number(dist), ...(side ? { side } : {}) }, next: j + 1 };
    }
    return null;
  }
  j = skipWords(t, j, ['on', 'a', 'the', 'turning', 'established', 'short', 'long', 'in', 'at', 'is']);
  const side = isOneOf(t, j, ['left', 'right']) ? (txt(t, j++) as 'left' | 'right') : undefined;
  const w = txt(t, j);
  if (['final', 'base', 'downwind', 'upwind', 'crosswind'].includes(w)) {
    return { pos: { position: w as TrafficRef['position'], ...(side ? { side } : {}) }, next: j + 1 };
  }
  if (w === 'departing') return { pos: { position: 'departing' }, next: j + 1 };
  if (w === 'ahead') return { pos: { position: 'ahead' }, next: j + 1 };
  if (seq(t, j, 'holding? in position') >= 0) return { pos: { position: 'in_position' }, next: seq(t, j, 'holding? in position') };
  if (seq(t, j, 'on the runway') >= 0 || seq(t, i, 'on the runway') >= 0) return { pos: { position: 'on_runway' }, next: Math.max(seq(t, j, 'on the runway'), seq(t, i, 'on the runway')) };
  return null;
}

/**
 * "[a|the] <type words> <position clause>" starting at i. Type words are everything before the position clause (max 6 tokens).
 * STT/normaliser merges "seven thirty seven six mile final" into one number "7376": a 4-digit number directly before "mile" is
 * split into a 3-digit type designator and a 1-digit distance.
 */
export function parseTrafficRef(t: Toks, i: number): { ref: TrafficRef; next: number } | null {
  const words: string[] = [];
  let j = skipWords(t, i, ['a', 'an', 'the']);
  for (let k = j; k < Math.min(t.length, j + 7); k++) {
    // merged "7376 mile final"
    const num = intAt(t, k);
    if (num !== null && num.length === 4 && seq(t, k + 1, 'mile|miles') >= 0) {
      const split: Partial<TrafficRef> = { distanceNm: Number(num.slice(3)) };
      const after = seq(t, k + 1, 'mile|miles');
      const side = isOneOf(t, after, ['left', 'right']) ? (txt(t, after) as 'left' | 'right') : undefined;
      const w = txt(t, side ? after + 1 : after);
      if (['final', 'base', 'downwind'].includes(w)) {
        words.push(num.slice(0, 3));
        return { ref: { desc: words.filter((x) => !DESC_FILLER.includes(x)).join(' '), position: w as TrafficRef['position'], ...split, ...(side ? { side } : {}) }, next: (side ? after + 1 : after) + 1 };
      }
    }
    const p = trafficPosition(t, k);
    if (p) return { ref: { desc: words.filter((x) => !DESC_FILLER.includes(x)).join(' '), ...p.pos }, next: p.next };
    const w = txt(t, k);
    if (!w || t[k].kind === 'barrier') break;
    // clock position ("twelve o'clock") is relative to the pilot and not used for matching
    if (intAt(t, k) !== null && txt(t, k + 1) === 'oclock') { k++; continue; }
    words.push(w);
  }
  return null;
}

/** "traffic, Cessna two mile final" / "traffic, a Skyhawk on left base" (3-1-6 / 2-1-21). Without a readable position it is not claimed. */
export const ruleTrafficAdvisory: Rule = (t, i) => {
  if (txt(t, i) !== 'traffic') return null;
  const r = parseTrafficRef(t, i + 1);
  if (!r) return null;
  return cmdHit(r.next, makeDraft('TRAFFIC_ADVISORY', { traffic: r.ref }));
};

/** LUAW is followed by ", traffic <description>" (3-9-4): the traffic information is part of the instruction. Wraps a LUAW hit. */
export const withLuawTraffic = (rule: Rule): Rule => (t, i) => {
  const hit = rule(t, i);
  if (!hit || hit.body.type !== 'cmd' || hit.body.draft.kind !== 'LINE_UP_AND_WAIT') return hit;
  if (txt(t, hit.end) !== 'traffic') return hit;
  const r = parseTrafficRef(t, hit.end + 1);
  if (!r) return hit;
  hit.body.draft.fields.trafficAdvised = true;
  hit.body.draft.fields.traffic = r.ref;
  return { ...hit, end: r.next };
};

/** "[number two,] follow the Skyhawk [on base | ahead]" (3-8-1: "NUMBER (landing sequence number), FOLLOW (description and location of traffic)"). */
export const ruleFollowTraffic: Rule = (t, i) => {
  let j = i;
  let seqNo: number | undefined;
  const num = seq(t, j, 'number');
  if (num >= 0 && intAt(t, num) !== null) { seqNo = Number(intAt(t, num)); j = num + 1; }
  const f = seq(t, j, 'follow|following');
  if (f < 0) return null;
  const r = parseTrafficRef(t, f);
  const d = makeDraft('FOLLOW_TRAFFIC');
  if (seqNo !== undefined) d.fields.sequenceNumber = seqNo;
  if (r) { d.fields.traffic = r.ref; return cmdHit(r.next, d); }
  // "follow the Cessna" with no position: description words up to the end or a stop word
  const stop = ['runway', 'cleared', 'number', 'report', 'contact', 'caution', 'wake', 'traffic'];
  let k = skipWords(t, f, ['a', 'an', 'the']);
  const words: string[] = [];
  while (k < t.length && words.length < 4 && !stop.includes(txt(t, k)) && t[k].kind !== 'barrier') words.push(txt(t, k++));
  if (!words.length) return null;
  d.fields.traffic = { desc: words.filter((x) => !DESC_FILLER.includes(x)).join(' ') };
  return cmdHit(k, d);
};

// ---------------------------------------------------------------------------
// Pattern instructions (3-8-1, 3-10-11) and position reports
// ---------------------------------------------------------------------------

const CALL_BASE_WORDS = ['ill', 'i', 'will', 'tower', 'call', 'your', 'base', 'report', 'when', 'ready', 'ill', 'we', 'turn'];

export const rulePatternInstruction: Rule = (t, i) => {
  // "extend [your] downwind [I'll call your base]"
  let j = seq(t, i, 'extend|extended your? downwind');
  if (j >= 0) {
    const d = makeDraft('PATTERN_INSTRUCTION', { destination: 'EXTEND_DOWNWIND' });
    const tail = skipWords(t, j, CALL_BASE_WORDS);
    if (tail > j) j = tail;
    return cmdHit(j, d);
  }
  // "turn base [now]" / "start base" / "base now" / "turn left base now"
  const bare = seq(t, i, 'base now');
  if (bare >= 0) return cmdHit(bare, makeDraft('PATTERN_INSTRUCTION', { destination: 'TURN_BASE_NOW' }));
  const tb = seq(t, i, 'turn|start left|right? base now? leg?');
  if (tb >= 0) return cmdHit(tb, makeDraft('PATTERN_INSTRUCTION', { destination: 'TURN_BASE_NOW' }));
  // "make [a] short approach" / "short approach"
  j = seq(t, i, 'make? a? short approach');
  if (j >= 0) return cmdHit(j, makeDraft('PATTERN_INSTRUCTION', { destination: 'SHORT_APPROACH' }));
  // "make [a] left|right three sixty | two seventy"
  j = seq(t, i, 'make|do|fly a? left|right');
  if (j >= 0) {
    const side = txt(t, j - 1) as 'left' | 'right';
    const deg = intAt(t, j);
    if (deg === '360' || deg === '270') {
      const d = makeDraft('PATTERN_INSTRUCTION', { destination: 'CIRCLE', turnDirection: side, turnDegrees: Number(deg) });
      return cmdHit(j + 1, d);
    }
  }
  // "remain in closed traffic", "make left closed traffic", "left closed traffic approved", "closed traffic approved"
  j = seq(t, i, 'remain|stay|make|enter? in? the? left|right? closed traffic approved?');
  if (j >= 0) {
    const side = ['left', 'right'].find((s) => t.slice(i, j).some((x) => x.text === s)) as 'left' | 'right' | undefined;
    return cmdHit(j, makeDraft('PATTERN_INSTRUCTION', { destination: 'CLOSED_TRAFFIC', ...(side ? { turnDirection: side } : {}) }));
  }
  return null;
};

/** "report midfield downwind", "report base", "report two mile final", "report final" (3-10-1: requests for additional position reports). */
export const ruleReportPosition: Rule = (t, i) => {
  if (!isOneOf(t, i, ['report', 'call'])) return null;
  let j = skipWords(t, i + 1, ['when', 'the', 'a', 'your', 'on', 'at']);
  const n = intAt(t, j);
  if (n !== null && seq(t, j + 1, 'mile|miles final') >= 0) {
    return cmdHit(j + 3, makeDraft('REPORT_POSITION', { destination: 'REPORT_FINAL', distanceNm: Number(n) }));
  }
  if (isOneOf(t, j, ['left', 'right'])) j++;
  const k = skipWords(t, j, ['abeam', 'midfield', 'the', 'runway', 'midpoint', 'mid']);
  if (txt(t, k) === 'downwind') return cmdHit(k + 1, makeDraft('REPORT_POSITION', { destination: 'REPORT_MIDFIELD_DOWNWIND' }));
  if (txt(t, j) === 'base') return cmdHit(skipWords(t, j + 1, ['leg']), makeDraft('REPORT_POSITION', { destination: 'REPORT_BASE' }));
  if (seq(t, j, 'short? final') >= 0) return cmdHit(seq(t, j, 'short? final'), makeDraft('REPORT_POSITION', { destination: 'REPORT_FINAL' }));
  return null;
};

// ---------------------------------------------------------------------------
// Frequency change approved, squawk (7-6-11, 5-2-1, AIM 4-1-20)
// ---------------------------------------------------------------------------

/** "[radar service terminated,] frequency change approved", "change to advisory frequency approved" (7110.65 7-6-11). */
export const ruleFrequencyApproved: Rule = (t, i) => {
  let j = seq(t, i, 'radar service terminated');
  const start = j >= 0 ? j : i;
  j = seq(t, start, 'frequency change|changes|changed approved');
  if (j < 0) j = seq(t, start, 'change to advisory frequency approved');
  if (j < 0) j = seq(t, start, 'frequency change approve');
  if (j < 0) return null;
  return cmdHit(j, makeDraft('FREQUENCY_CHANGE_APPROVED'));
};

/** "radar service terminated" lead-in of 7110.65 7-6-11 ("RADAR SERVICE TERMINATED, SQUAWK VFR, FREQUENCY CHANGE APPROVED"): understood, no command. */
export const ruleRadarServiceTerminated: Rule = (t, i) => {
  const j = seq(t, i, 'radar service terminated');
  return j < 0 ? null : fillerHit(j);
};

/** "squawk VFR" (AIM 4-1-20: code 1200), "squawk one two zero zero" (5-2-1: SQUAWK (code)). Four digits 0-7. */
export const ruleSquawk: Rule = (t, i) => {
  if (txt(t, i) !== 'squawk') return null;
  let j = skipWords(t, i + 1, ['code']);
  if (txt(t, j) === 'vfr') return cmdHit(j + 1, makeDraft('SQUAWK', { squawk: '1200', destination: 'VFR' }));
  const code = intAt(t, j);
  if (code === null) return null; // "squawk ident" / "squawk standby" stay unsupported
  j++;
  const d = makeDraft('SQUAWK');
  if (/^[0-7]{4}$/.test(code)) d.fields.squawk = code;
  else { d.issues.push(`invalid squawk code "${code}" (four digits, each 0-7)`); d.unknownIds++; }
  return cmdHit(j, d);
};

// ---------------------------------------------------------------------------
// Departure / landing information (3-9-1, 3-10-1): wind and altimeter
// ---------------------------------------------------------------------------

function altimeterFrom(digits: string): number | undefined {
  const v = Number(digits);
  if (digits.length === 4 && v >= 2800 && v <= 3120) return v / 100;
  return undefined;
}

/** "wind calm", "wind one three zero at eight [gusts 15]" and/or "altimeter three zero one zero" -> one AIRPORT_INFO. */
export const ruleAirportInfo: Rule = (t, i) => {
  let j = i;
  const info: AirportInfo = {};
  const d: Draft = makeDraft('AIRPORT_INFO');
  let any = false;
  for (let guard = 0; guard < 3; guard++) {
    j = skipWords(t, j, ['and']);
    if (isOneOf(t, j, ['wind', 'winds'])) {
      if (seq(t, j + 1, 'calm') >= 0) { info.calm = true; j += 2; any = true; continue; }
      const dir = intAt(t, j + 1);
      if (dir === null) break;
      const at = seq(t, j + 2, 'at');
      info.windDirDeg = Number(dir);
      j += 2;
      if (at >= 0 && intAt(t, at) !== null) {
        info.windSpeedKt = Number(intAt(t, at));
        j = at + 1;
        const g = seq(t, j, 'gust|gusts|gusting');
        if (g >= 0 && intAt(t, g) !== null) { info.windGustKt = Number(intAt(t, g)); j = g + 1; }
      } else {
        d.issues.push('wind speed missing');
      }
      any = true;
      continue;
    }
    if (isOneOf(t, j, ['altimeter'])) {
      const a = intAt(t, j + 1) ?? (/^\d{2}\.\d{1,2}$/.test(txt(t, j + 1)) ? txt(t, j + 1) : null); // "3010" or "30.10"
      if (a === null) break;
      const v = a.includes('.') ? (Number(a) >= 28 && Number(a) <= 31.2 ? Number(a) : undefined) : altimeterFrom(a);
      if (v === undefined) d.issues.push(`implausible altimeter setting ${a}`); else info.altimeterInHg = v;
      j += 2;
      any = true;
      continue;
    }
    break;
  }
  if (!any) return null;
  d.fields.info = info;
  return cmdHit(j, d);
};

