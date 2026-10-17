import { applyRunway, cmdHit, makeDraft, type Draft, type Rule } from './draft';
import { parseOneTaxiway, parseParking, parseRunway, parseTaxiways, runwayAfter } from './entities';
import { isOneOf, seq, skipWords, txt, type Toks } from './match';

const finishRunway = (d: Draft, t: Toks, at: number): number => {
  const r = runwayAfter(t, at);
  if (!r) return at;
  if (r.ok) applyRunway(d, r.ref); else { d.issues.push(r.reason); d.unknownIds++; }
  return r.next;
};

/** "taxi into position [and hold]", "position and hold|wait" */
export const ruleTaxiIntoPosition: Rule = (t, i) => {
  let j = seq(t, i, 'taxi into|to the? position');
  if (j < 0) j = seq(t, i, 'position and hold|wait');
  if (j < 0) return null;
  const d = makeDraft('LINE_UP_AND_WAIT');
  const w = seq(t, j, 'and? hold|wait');
  if (w >= 0) j = w;
  return cmdHit(finishRunway(d, t, j), d);
};

/** "line up [runway N] [and] wait|hold [runway N]" */
export const ruleLineUp: Rule = (t, i) => {
  if (seq(t, i, 'line up') < 0) return null;
  const d = makeDraft('LINE_UP_AND_WAIT');
  let j = finishRunway(d, t, i + 2);
  const w = seq(t, j, 'and|then? wait|hold');
  if (w < 0) {
    d.nonstandard++;
    d.issues.push('incomplete phraseology: expected "line up and wait"');
  } else j = w;
  return cmdHit(finishRunway(d, t, j), d);
};

/** "hold short [of] runway N | taxiway X" */
export const ruleHoldShort: Rule = (t, i) => {
  const j = seq(t, i, 'hold short|shorts of|at|on? the?');
  if (j < 0) return null;
  const d = makeDraft('HOLD_SHORT');
  const end = holdShortTarget(d, t, j);
  return cmdHit(end, d);
};

/** Parse the object of a hold-short instruction into `d`. Returns the end index. */
export function holdShortTarget(d: Draft, t: Toks, j: number): number {
  const rw = parseRunway(t, j);
  if (rw) {
    if (rw.ok) applyRunway(d, rw.ref); else { d.issues.push(rw.reason); d.unknownIds++; }
    return rw.next;
  }
  const tw = parseOneTaxiway(t, skipWords(t, j, ['taxiway', 'on', 'of', 'the'] as const));
  if (tw) { d.fields.holdShort = [tw.id]; return tw.next; }
  return j;
}

/** "hold position", "stop", bare "hold" (non-standard) */
export const ruleHoldPosition: Rule = (t, i) => {
  let j = seq(t, i, 'hold your? position');
  if (j < 0 && txt(t, i) === 'stop') {
    j = seq(t, i, 'stop right? there?');
    j = skipWords(t, j, ['now', 'immediately']);
    return cmdHit(j, makeDraft('HOLD_POSITION'));
  }
  if (j >= 0) return cmdHit(j, makeDraft('HOLD_POSITION'));
  if (txt(t, i) === 'hold' && !isOneOf(t, i + 1, ['short', 'shorts'])) {
    const d = makeDraft('HOLD_POSITION');
    d.nonstandard++;
    d.issues.push('incomplete phraseology: expected "hold position"');
    return cmdHit(i + 1, d);
  }
  return null;
};

/** "cross runway N [at|via taxiway X]" */
export const ruleCross: Rule = (t, i) => {
  if (txt(t, i) !== 'cross') return null;
  const d = makeDraft('CROSS_RUNWAY');
  let j = i + 1;
  const r = parseRunway(t, skipWords(t, j, ['the']));
  if (r) {
    if (r.ok) applyRunway(d, r.ref); else { d.issues.push(r.reason); d.unknownIds++; }
    j = r.next;
  }
  const k = seq(t, j, 'at|via|using|on taxiway?');
  if (k >= 0) {
    const tw = parseTaxiways(t, k);
    if (tw.ids.length) { d.fields.route = tw.ids; j = tw.next; }
  }
  return cmdHit(j, d);
};

/**
 * The body of a taxi instruction after its verb (at `i`): "[to] runway N | ramp | parking | <taxiway> ... [via A B] [hold short of ...]".
 * Returns the end index. `taxiways` (the airport's) decides whether a lone "v" is taxiway V or a misheard "via".
 */
function parseTaxiBody(d: Draft, t: Toks, i: number, taxiways?: readonly string[]): number {
  const route: string[] = [];
  const holds: string[] = [];
  let end = i;
  let j = i;
  const hasV = !!taxiways?.some((x) => x.toUpperCase() === 'V');
  for (;;) {
    j = skipWords(t, j, ['to', 'the', 'into', 'and', 'then', 'taxi']);
    const rw = parseRunway(t, j);
    if (rw && !d.fields.destination && !d.fields.runwayEnd) {
      if (rw.ok) applyRunway(d, rw.ref); else { d.issues.push(rw.reason); d.unknownIds++; }
      end = j = rw.next;
      continue;
    }
    const park = !d.fields.destination ? parseParking(t, j) : null;
    if (park) { d.kind = 'TAXI_TO_PARKING'; d.fields.destination = park.dest; end = j = park.next; continue; }
    const hs = seq(t, j, 'hold short|shorts of|at|on? the?');
    if (hs >= 0) {
      const h = makeDraft('HOLD_SHORT');
      const e = holdShortTarget(h, t, hs);
      if (e === hs) break;
      holds.push(...(h.fields.holdShort ?? []));
      d.issues.push(...h.issues); d.unknownIds += h.unknownIds;
      end = j = e;
      continue;
    }
    // "taxi to kilo [via bravo]": a taxiway as the destination (one identifier right after "to", not a list)
    if (txt(t, j - 1) === 'to' && j > i && !d.fields.destination && !d.fields.runwayEnd && t[j]?.kind === 'letter' && !route.length) {
      const one = parseOneTaxiway(t, j);
      if (one && t[one.next]?.kind !== 'letter' && !(txt(t, j) === 'v' && !hasV && t[j + 1]?.kind === 'letter')) {
        d.fields.destination = `TWY${one.id}`;
        d.nonstandard++;
        end = j = one.next;
        continue;
      }
    }
    const bare = j === i && t[j]?.kind === 'letter';
    // "V. Lima Papa" = "via lima papa" from STT (unless this airport has a taxiway V)
    const vAsVia = txt(t, j) === 'v' && !hasV && t[j + 1]?.kind === 'letter';
    if (isOneOf(t, j, ['via', 'along', 'using', 'taxiway', 'taxiways']) || bare || vAsVia) {
      if (vAsVia) d.nonstandard++;
      const tw = parseTaxiways(t, vAsVia ? j + 1 : j);
      if (!tw.ids.length) break;
      if (bare) d.nonstandard++;
      route.push(...tw.ids);
      end = j = tw.next;
      continue;
    }
    break;
  }
  if (route.length) d.fields.route = route;
  if (holds.length) d.fields.holdShort = holds;
  return end;
}

/** "taxi [to] runway N | ramp | parking | <taxiway> ... [via A B] [hold short of ...]" */
export const makeTaxiRule = (taxiways?: readonly string[]): Rule => (t, i) => {
  if (txt(t, i) !== 'taxi') return null;
  const d = makeDraft('TAXI');
  return cmdHit(parseTaxiBody(d, t, i + 1, taxiways), d);
};
export const ruleTaxi: Rule = makeTaxiRule();

/** "continue taxiing [to runway N via ...]": the taxi clearance in force resumes from a hold short of a taxiway. */
export const makeContinueTaxiRule = (taxiways?: readonly string[]): Rule => (t, i) => {
  const j = seq(t, i, 'continue taxi|taxiing');
  if (j < 0) return null;
  const d = makeDraft('TAXI');
  const end = parseTaxiBody(d, t, j, taxiways);
  if (!d.fields.destination) d.fields.destination = 'CONTINUE';
  return cmdHit(end, d);
};

/** "cleared to the terminal via bravo": not taxi phraseology (7110.65 3-7-2 is "taxi to ..."), taken as a taxi to parking and marked non-standard. */
export const makeClearedToParkingRule = (taxiways?: readonly string[]): Rule => (t, i) => {
  const j = seq(t, i, 'cleared|clear to? the?');
  if (j < 0 || !parseParking(t, j)) return null;
  const d = makeDraft('TAXI');
  d.nonstandard++;
  d.issues.push('non-standard phraseology: "cleared to <parking>" taken as "taxi to <parking>"');
  return cmdHit(parseTaxiBody(d, t, j, taxiways), d);
};

/** "cancel [taxi]": there is no cancel instruction for ground traffic; taken as "hold position" (non-standard). */
export const ruleCancel: Rule = (t, i) => {
  if (txt(t, i) !== 'cancel') return null;
  let j = skipWords(t, i + 1, ['taxi', 'taxiing', 'that', 'the', 'clearance', 'instruction']);
  if (txt(t, j) === 'takeoff') return null; // "cancel takeoff clearance" is a different instruction (not simulated)
  const d = makeDraft('HOLD_POSITION');
  d.nonstandard++;
  d.issues.push('non-standard phraseology: "cancel" taken as "hold position"');
  j = skipWords(t, j, ['hold', 'position', 'and']);
  return cmdHit(j, d);
};
