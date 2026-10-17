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
  const j = seq(t, i, 'hold short|shorts of|at? the?');
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
  const tw = parseOneTaxiway(t, skipWords(t, j, ['taxiway'] as const));
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

/** "taxi [to] runway N | ramp | parking ... [via A B] [hold short of ...]" */
export const ruleTaxi: Rule = (t, i) => {
  if (txt(t, i) !== 'taxi') return null;
  const d = makeDraft('TAXI');
  const route: string[] = [];
  const holds: string[] = [];
  let end = i + 1;
  let j = i + 1;
  for (;;) {
    j = skipWords(t, j, ['to', 'the', 'into', 'and', 'then']);
    const rw = parseRunway(t, j);
    if (rw && !d.fields.destination && !d.fields.runwayEnd) {
      if (rw.ok) applyRunway(d, rw.ref); else { d.issues.push(rw.reason); d.unknownIds++; }
      end = j = rw.next;
      continue;
    }
    const park = !d.fields.destination ? parseParking(t, j) : null;
    if (park) { d.kind = 'TAXI_TO_PARKING'; d.fields.destination = park.dest; end = j = park.next; continue; }
    const hs = seq(t, j, 'hold short|shorts of|at? the?');
    if (hs >= 0) {
      const h = makeDraft('HOLD_SHORT');
      const e = holdShortTarget(h, t, hs);
      if (e === hs) break;
      holds.push(...(h.fields.holdShort ?? []));
      d.issues.push(...h.issues); d.unknownIds += h.unknownIds;
      end = j = e;
      continue;
    }
    const bare = j === i + 1 && t[j]?.kind === 'letter';
    if (isOneOf(t, j, ['via', 'along', 'using', 'taxiway', 'taxiways']) || bare) {
      const tw = parseTaxiways(t, j);
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
  return cmdHit(end, d);
};
