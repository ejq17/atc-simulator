import { applyRunway, cmdHit, makeDraft, type Rule } from './draft';
import { runwayAfter } from './entities';
import { intAt, isOneOf, seq, skipWords, txt } from './match';

const HEADING_VERBS = ['fly', 'turn', 'maintain', 'continue', 'proceed', 'make', 'depart'];

/** Valid headings are 1..360; "000" is read as 360. Two-digit values <= 36 are ambiguous. */
function headingFrom(digits: string): { deg?: number; issue?: string } {
  const v = Number.parseInt(digits, 10);
  if (digits.length < 3 && v <= 36) return { issue: `ambiguous heading "${digits}" (say three digits)` };
  if (v > 360) return { issue: `invalid heading ${digits}` };
  return { deg: v === 0 ? 360 : v };
}

/** "turn left heading 270", "fly heading 180", "fly runway heading", "left turn heading 090" */
export const ruleHeading: Rule = (t, i) => {
  let j = i;
  const verb = HEADING_VERBS.includes(txt(t, j)) ? txt(t, j++) : '';
  j = skipWords(t, j, ['a', 'immediately']);
  let dir: 'left' | 'right' | undefined;
  if (isOneOf(t, j, ['left', 'right'])) dir = txt(t, j++) as 'left' | 'right';
  const sawTurn = txt(t, j) === 'turn';
  if (sawTurn) j++;
  const d = makeDraft('HEADING', dir ? { turnDirection: dir } : {});
  const special = seq(t, j, 'runway heading') >= 0 ? 'RUNWAY_HEADING' : seq(t, j, 'present heading') >= 0 ? 'PRESENT_HEADING' : '';
  if (special) {
    d.fields.destination = special;
    return cmdHit(j + 2, d);
  }
  const hasWord = txt(t, j) === 'heading';
  if (hasWord) j++;
  if (!hasWord && !(dir && (verb === 'turn' || sawTurn))) return null;
  j = skipWords(t, j, ['to']);
  const digits = intAt(t, j);
  if (digits !== null) {
    j++;
    const h = headingFrom(digits);
    if (h.deg !== undefined) d.fields.headingDeg = h.deg;
    if (h.issue) d.issues.push(h.issue);
  }
  return cmdHit(j, d);
};

const MIN_SPEED = 50;
const MAX_SPEED = 500;

/** "reduce speed to 180", "maintain 210 knots", "slow to 160", "speed 170", "resume normal speed" */
export const ruleSpeed: Rule = (t, i) => {
  const resume = seq(t, i, 'resume normal speed');
  if (resume >= 0) return cmdHit(resume, makeDraft('SPEED', { destination: 'NORMAL_SPEED' }));
  const verb = txt(t, i);
  if (!['reduce', 'slow', 'increase', 'speed', 'maintain', 'fly', 'set'].includes(verb)) return null;
  const strong = verb !== 'maintain' && verb !== 'fly' && verb !== 'set';
  let j = i + 1;
  const sawSpeedWord = verb === 'speed' || txt(t, j) === 'speed';
  j = skipWords(t, j, ['speed', 'down', 'to', 'and', 'your']);
  const digits = intAt(t, j);
  const unit = digits !== null && txt(t, j + 1) === 'knots';
  if (!strong && !(digits !== null && (unit || sawSpeedWord))) return null;
  const d = makeDraft('SPEED');
  if (digits === null) return cmdHit(j, d);
  const v = Number.parseInt(digits, 10);
  if (v >= MIN_SPEED && v <= MAX_SPEED) d.fields.speedKt = v;
  else d.issues.push(`implausible speed ${v}`);
  return cmdHit(unit ? j + 2 : j + 1, d);
};

const ALT_VERBS = ['climb', 'descend', 'maintain', 'altitude'];
const ALT_SKIP = ['and', 'maintain', 'to', 'altitude', 'vfr', 'at', 'or', 'below', 'above', 'immediately', 'expedite'];

/** "climb and maintain 5000", "maintain VFR at or below 2500", "descend and maintain flight level 180" */
export const ruleAltitude: Rule = (t, i) => {
  const verb = txt(t, i);
  if (!ALT_VERBS.includes(verb)) return null;
  const j = skipWords(t, i + 1, ALT_SKIP);
  if (isOneOf(t, j, ['heading', 'runway'])) return null;
  const isFl = txt(t, j) === 'fl';
  const digits = intAt(t, isFl ? j + 1 : j);
  const end = isFl ? j + 2 : j + 1;
  if (digits === null) {
    return verb === 'maintain' || verb === 'altitude' ? null : cmdHit(j, makeDraft('ALTITUDE'));
  }
  const d = makeDraft('ALTITUDE');
  const v = Number.parseInt(digits, 10);
  const ft = isFl ? v * 100 : v;
  if (!isFl && verb === 'maintain' && v >= 60 && v < 500) {
    const u = makeDraft('UNKNOWN');
    u.issues.push(`ambiguous "maintain ${v}": altitude or speed?`);
    return cmdHit(end, u);
  }
  if (ft < 100 || ft > 60000) d.issues.push(`invalid altitude ${ft}`);
  else {
    d.fields.altitudeFt = ft;
    if (ft % 100 !== 0) d.issues.push(`unusual altitude ${ft}`);
  }
  return cmdHit(end, d);
};

/** "enter left downwind runway 13", "make straight in runway 13", "report two mile final" */
export const rulePattern: Rule = (t, i) => {
  const verb = ['enter', 'join', 'make', 'report', 'fly'].includes(txt(t, i)) ? txt(t, i) : '';
  let j = verb ? i + 1 : i;
  j = skipWords(t, j, ['a', 'the', 'your']);
  const d = makeDraft('ENTER_PATTERN');

  if (verb === 'report') {
    const n = intAt(t, j);
    if (n && seq(t, j + 1, 'mile|miles final') >= 0) {
      d.fields.patternLeg = 'straight_in';
      d.fields.destination = `REPORT_${Number.parseInt(n, 10)}_MILE_FINAL`;
      return cmdHit(j + 3, d);
    }
  }
  let side: 'left' | 'right' | undefined;
  if (isOneOf(t, j, ['left', 'right'])) { side = txt(t, j) as 'left' | 'right'; j++; }
  const w = txt(t, j);
  let leg = '';
  if (w === 'downwind' || w === 'base' || w === 'traffic' || (verb === 'report' && w === 'final')) { leg = w; j++; if (leg === 'base') j = skipWords(t, j, ['leg']); }
  else if (seq(t, j, 'straight in') >= 0) { leg = 'straight'; j = skipWords(t, j + 2, ['approach', 'landing']); }
  if (!leg || (!verb && !side)) return null;
  if (side) d.fields.turnDirection = side;

  if (verb === 'report') {
    d.fields.destination = `REPORT_${leg.toUpperCase()}`;
    if (leg === 'base') d.fields.patternLeg = 'base';
    else if (leg === 'final') d.fields.patternLeg = 'straight_in';
    else if (leg === 'downwind' && side) d.fields.patternLeg = `${side}_downwind`;
  } else if (leg === 'straight') d.fields.patternLeg = 'straight_in';
  else if (leg === 'base') d.fields.patternLeg = 'base';
  else if (side) d.fields.patternLeg = `${side}_downwind`;
  else d.issues.push('pattern side not specified (left or right)');

  const r = runwayAfter(t, j);
  if (r) {
    if (r.ok) applyRunway(d, r.ref); else { d.issues.push(r.reason); d.unknownIds++; }
    j = r.next;
  }
  return cmdHit(j, d);
};
