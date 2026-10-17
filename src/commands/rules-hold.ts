import type { HoldingInstruction } from '../sim/types';
import { cmdHit, makeDraft, type Rule } from './draft';
import type { FixMatcher } from './fixes';
import { intAt, isOneOf, seq, skipWords, txt, type Toks } from './match';
import { applyFix } from './rules-ifr';

const COMPASS_DEG: ReadonlyMap<string, number> = new Map(Object.entries({
  north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315,
}));
const GLUE = ['and', 'then', 'the', 'with', 'a'];
/** Allowed disagreement between the spoken quadrant and the radial, degrees. */
const COMPASS_TOLERANCE_DEG = 45;

/** Word at i, with the airline token 'SWA' read back as "southwest". */
const wordAt = (t: Toks, i: number): string => (t[i]?.kind === 'airline' && t[i].text === 'SWA' ? 'southwest' : txt(t, i));

const angleDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** "1245" / "945" (3 digits are padded) -> "1245" / "0945"; null when not a valid HHMM. */
function efcTime(digits: string): string | null {
  if (digits.length < 3 || digits.length > 4) return null;
  const hhmm = digits.padStart(4, '0');
  return Number(hhmm.slice(0, 2)) < 24 && Number(hhmm.slice(2)) < 60 ? hhmm : null;
}

/**
 * "hold at SMITS as published", "hold east of SMITS on the 090 radial, right turns, one minute legs,
 * expect further clearance 1245", "hold northwest of CARYL on the localizer, left turns, five mile legs",
 * "cleared to SMITS, hold as published". Elements may come in any order.
 *
 * `hold.inboundCourseDeg` is the INBOUND course to the fix: a holding radial R (the side of the fix the
 * aircraft holds on) gives inbound course R + 180 (mod 360, 0 -> 360). "On the localizer" leaves it undefined.
 */
export const ruleHoldAtFix = (m: FixMatcher): Rule => (t, i) => {
  const d = makeDraft('HOLD_AT_FIX');
  const hold: Partial<HoldingInstruction> = {};
  d.fields.hold = hold;
  let j: number;

  if (txt(t, i) === 'hold') {
    j = i + 1;
    if (isOneOf(t, j, ['short', 'shorts', 'position', 'your'])) return null;
    const knownFix = m.resolve(t, j)?.status === 'known';
    if (!['at', 'as', 'published', ...COMPASS_DEG.keys()].includes(wordAt(t, j)) && !knownFix) return null;
  } else if (isOneOf(t, i, ['cleared', 'clear', 'proceed', 'fly'])) {
    const a = skipWords(t, i + 1, ['to', 'direct', 'the']);
    const r = m.resolve(t, a);
    if (!r) return null;
    j = skipWords(t, r.next, ['and', 'then']);
    if (txt(t, j) !== 'hold' || isOneOf(t, j + 1, ['short', 'shorts', 'position', 'your'])) return null;
    const f = applyFix(d, m, t, a);
    if (f.id) hold.fix = f.id;
    j++;
  } else return null;

  let end = j;
  let asPublished = false;
  let direction: string | undefined;
  let radial: number | undefined;
  for (;;) {
    const s = skipWords(t, j, GLUE);
    const w = wordAt(t, s);
    let next = -1;
    if (w === 'at' && hold.fix === undefined) {
      const f = applyFix(d, m, t, skipWords(t, s + 1, ['the']));
      if (f.id) { hold.fix = f.id; next = f.next; }
    } else if (COMPASS_DEG.has(w) && direction === undefined) {
      direction = w;
      const a = skipWords(t, s + 1, ['of', 'the']);
      if (hold.fix === undefined) {
        const f = applyFix(d, m, t, a);
        if (f.id) { hold.fix = f.id; next = f.next; } else next = s + 1;
      } else next = s + 1;
    } else if (w === 'as' || w === 'published') {
      const p = seq(t, s, 'as? published');
      if (p >= 0) { asPublished = true; next = p; }
    } else if (hold.fix === undefined && m.resolve(t, s)?.status === 'known' && s === j) {
      const f = applyFix(d, m, t, s);
      if (f.id) { hold.fix = f.id; next = f.next; }
    } else if (w === 'on') {
      const a = skipWords(t, s + 1, ['the']);
      if (isOneOf(t, a, ['localizer', 'loc'])) next = a + 1;
      else {
        const pre = seq(t, a, 'radial');
        const n = intAt(t, pre >= 0 ? pre : a);
        const post = pre >= 0 ? pre + 1 : seq(t, a + 1, 'degree|degrees? radial');
        if (n !== null && post >= 0) {
          const v = Number.parseInt(n, 10);
          if (v >= 0 && v <= 360) radial = v === 0 ? 360 : v; else d.issues.push(`invalid radial ${n}`);
          next = post;
        }
      }
    } else if (w === 'left' || w === 'right') {
      const e = seq(t, s + 1, 'turn|turns|hand pattern?');
      if (e >= 0) { hold.turns = w; next = e; }
    } else if (intAt(t, s) !== null) {
      const n = Number.parseInt(txt(t, s), 10);
      const unit = txt(t, s + 1);
      const leg = seq(t, s + 2, 'leg|legs');
      if ((unit === 'minute' || unit === 'minutes') && leg >= 0) { hold.legMinutes = n; next = leg; }
      else if ((unit === 'mile' || unit === 'miles') && leg >= 0) { hold.legNm = n; next = leg; }
    } else if (w === 'expect' || w === 'efc') {
      const e = w === 'efc' ? s + 1 : seq(t, s, 'expect further clearance');
      if (e >= 0) {
        const a = skipWords(t, e, ['at', 'time']);
        const digits = intAt(t, a);
        const hhmm = digits === null ? null : efcTime(digits);
        if (hhmm) hold.efcZulu = hhmm;
        else d.issues.push(digits === null ? 'missing expect-further-clearance time' : `invalid expect-further-clearance time ${digits}`);
        next = digits === null ? e : a + 1;
        if (digits !== null && (txt(t, next) === 'zulu' || txt(t, next) === 'z')) next++;
      }
    }
    if (next < 0) break;
    j = end = next;
  }

  hold.asPublished = asPublished;
  if (radial !== undefined) {
    hold.inboundCourseDeg = (radial + 180) % 360 || 360;
    if (direction !== undefined && angleDiff(COMPASS_DEG.get(direction) as number, radial) > COMPASS_TOLERANCE_DEG) {
      d.issues.push(`inconsistent hold: "${direction}" of the fix but on the ${radial} radial`);
      d.conflicts++;
    }
  }
  if (hold.turns === undefined) {
    hold.turns = 'right';
    if (!asPublished) d.issues.push('standard right turns assumed');
  }
  return cmdHit(end, d);
};

/**
 * "execute [the] [published] missed approach", "go missed", "fly the published missed approach",
 * "go around, fly the published missed approach" (one MISSED_APPROACH, not a separate GO_AROUND).
 */
export const ruleMissedApproach: Rule = (t, i) => {
  const missed = (k: number): number => {
    const a = skipWords(t, k, ['the', 'a', 'your', 'published', 'standard']);
    return txt(t, a) === 'missed' ? skipWords(t, a + 1, ['approach', 'procedure']) : -1;
  };
  let k = -1;
  if (txt(t, i) === 'go' && txt(t, i + 1) === 'missed') k = missed(i + 1);
  else if (isOneOf(t, i, ['execute', 'fly', 'follow', 'commence', 'initiate'])) k = missed(i + 1);
  else if (seq(t, i, 'go around') >= 0) {
    const a = skipWords(t, i + 2, ['and', 'then']);
    if (isOneOf(t, a, ['execute', 'fly', 'follow', 'commence', 'initiate'])) k = missed(a + 1);
    else if (txt(t, a) === 'go' && txt(t, a + 1) === 'missed') k = missed(a + 1);
  }
  return k < 0 ? null : cmdHit(k, makeDraft('MISSED_APPROACH'));
};
