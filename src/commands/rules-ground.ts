import { matchAircraftPhrase } from './behind';
import type { AircraftRef } from './callsign';
import { applyRunway, cmdHit, makeDraft, type Draft, type Rule } from './draft';
import { makeRunwayRef, parseOneTaxiway, parseParking, parseRunway, parseTaxiways, runwayAfter, type RunwayParse } from './entities';
import { intAt, isOneOf, seq, skipWords, txt, type Toks } from './match';

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

/** "hold short [of] runway N | N | taxiway X [on|at taxiway Y]" */
export const makeHoldShortRule = (runwayEnds?: readonly string[]): Rule => (t, i) => {
  const j = seq(t, i, 'hold short|shorts of|at|on? the?');
  if (j < 0) return null;
  const d = makeDraft('HOLD_SHORT');
  const end = holdShortTarget(d, t, j, runwayEnds);
  return cmdHit(end, d);
};
export const ruleHoldShort: Rule = makeHoldShortRule();

const stripZero = (e: string): string => e.replace(/^0+(?=\d)/, '').toUpperCase();

/**
 * A runway named without the word "runway" inside a hold-short object ("hold short of 31 on Bravo"):
 * a bare 1-2 digit number (optionally with left|right|center | L|R|C) that is an end of this airport.
 * Needs the airport's runway ends, otherwise a bare number is never taken as a runway.
 */
function bareRunway(t: Toks, j: number, runwayEnds?: readonly string[]): RunwayParse | null {
  const digits = intAt(t, j);
  if (!runwayEnds || digits === null || digits.length > 2) return null;
  const ends = new Set(runwayEnds.map(stripZero));
  const w = txt(t, j + 1);
  const spoken = w === 'left' || w === 'right' || w === 'center' ? w[0].toUpperCase()
    : t[j + 1]?.kind === 'letter' && (w === 'l' || w === 'r' || w === 'c') && !isOneOf(t, j + 2, ['heading', 'turn']) ? w.toUpperCase() : '';
  for (const suffix of spoken ? [spoken, ''] : ['']) {
    const ref = makeRunwayRef(digits, suffix);
    if (ref && ends.has(stripZero(ref.end))) return { ok: true, ref, next: j + 1 + (suffix ? 1 : 0) };
  }
  return null;
}

/** Parse the object of a hold-short instruction into `d`. Returns the end index (== j when no target was found). */
export function holdShortTarget(d: Draft, t: Toks, j: number, runwayEnds?: readonly string[]): number {
  const rw = parseRunway(t, j) ?? bareRunway(t, j, runwayEnds);
  if (rw) {
    if (rw.ok) applyRunway(d, rw.ref); else { d.issues.push(rw.reason); d.unknownIds++; }
    // "... runway 31 on Bravo": where to hold. No field carries it, so it is consumed (not an unrecognised word).
    const q = seq(t, rw.next, 'on|at taxiway?');
    const tw = q >= 0 ? parseOneTaxiway(t, q) : null;
    return tw ? tw.next : rw.next;
  }
  const tw = parseOneTaxiway(t, skipWords(t, j, ['taxiway', 'on', 'of', 'the'] as const));
  if (tw) { d.fields.holdShort = [tw.id]; return tw.next; }
  return j;
}

/**
 * "make a one eighty", "do a 180", "turn around", "reverse course": the aircraft on a taxiway turns back. JO 7110.65 has no phrase for it (3-7-2
 * gives step-by-step directions and directional turns only); "one eighty" is common usage, so the command is flagged non-standard.
 */
export const ruleTurnAround: Rule = (t, i) => {
  // "one eighty" arrives as the number 180 (or as 1 + 80 when the normaliser keeps the words apart)
  const lead = seq(t, i, 'make|do|perform|execute|take a? an?');
  const k0 = lead >= 0 ? lead : i;
  let j = -1;
  if (txt(t, k0) === '180') j = k0 + 1;
  else if (intAt(t, k0) === '1' && intAt(t, k0 + 1) === '80') j = k0 + 2;
  if (j >= 0) j = skipWords(t, j, ['degree', 'degrees', 'turn', 'right', 'there', 'now']);
  if (j < 0) j = seq(t, i, 'turn around|back');
  if (j < 0) j = seq(t, i, 'reverse course|direction');
  if (j < 0) return null;
  const d = makeDraft('TURN_AROUND');
  d.nonstandard++;
  d.issues.push('non-standard phraseology: JO 7110.65 has no "one eighty" for an aircraft on a taxiway (3-7-2 gives step-by-step directions and directional turns)');
  return cmdHit(j, d);
};

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

const CONDITIONAL_NONSTANDARD = 'non-standard phraseology: conditional "behind" crossing is an ICAO Doc 4444 clearance, not 7110.65';

/** "behind|after [the] [landing] <aircraft>" at `b` (the word after "behind"): sets `behindCallsign`, or leaves the crossing unresolved. Returns the end index. */
function parseBehind(d: Draft, t: Toks, b: number, aircraft: readonly AircraftRef[]): number {
  const m = matchAircraftPhrase(t, b, aircraft);
  if (m.callsign) d.fields.behindCallsign = m.callsign;
  else {
    d.behindUnresolved = true;
    d.issues.push(!m.spoken ? 'conditional crossing: no aircraft named after "behind"'
      : m.ambiguous.length > 1 ? `conditional crossing: '${m.spoken}' fits ${m.ambiguous.join(', ')}; name the aircraft by callsign`
        : `conditional crossing: no aircraft matches '${m.spoken}'`);
  }
  d.nonstandard++;
  d.issues.push(CONDITIONAL_NONSTANDARD);
  return m.next;
}

/**
 * "cross runway N [at|via taxiway X] [behind|after the [landing] <aircraft>]". The conditional form is an ICAO Doc 4444 conditional clearance, not
 * JO 7110.65 phraseology, so it is always non-standard; `aircraft` (the active list) resolves the aircraft to let pass first.
 */
export const makeCrossRule = (aircraft: readonly AircraftRef[] = []): Rule => (t, i) => {
  if (txt(t, i) !== 'cross') return null;
  const d = makeDraft('CROSS_RUNWAY');
  let j = i + 1;
  const r = parseRunway(t, skipWords(t, j, ['the']));
  if (r) {
    if (r.ok) applyRunway(d, r.ref); else { d.issues.push(r.reason); d.unknownIds++; }
    j = r.next;
  }
  const taxiway = () => {
    const k = seq(t, j, 'at|via|using|on taxiway?');
    if (k < 0) return;
    const tw = parseTaxiways(t, k);
    if (tw.ids.length) { d.fields.route = tw.ids; j = tw.next; }
  };
  taxiway();
  const b = seq(t, j, 'behind|after');
  if (b >= 0) {
    j = parseBehind(d, t, b, aircraft);
    if (!d.fields.route) taxiway();
  }
  return cmdHit(j, d);
};
export const ruleCross: Rule = makeCrossRule();

/**
 * The body of a taxi instruction after its verb (at `i`): "[to] runway N | ramp | parking | <taxiway> ... [via A B] [hold short of ...]".
 * Returns the end index. `taxiways` (the airport's) decides whether a lone "v" is taxiway V or a misheard "via".
 */
function parseTaxiBody(d: Draft, t: Toks, i: number, taxiways?: readonly string[], runwayEnds?: readonly string[]): number {
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
      const e = holdShortTarget(h, t, hs, runwayEnds);
      if (e === hs) {
        // A hold-short clause whose point could not be read must not pass as a plain taxi: the clause is consumed
        // and flagged, requirements.ts counts it as a missing entity, so the engine asks for a say-again.
        d.holdShortUnparsed = true;
        end = j = hs;
        continue;
      }
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
export const makeTaxiRule = (taxiways?: readonly string[], runwayEnds?: readonly string[]): Rule => (t, i) => {
  if (txt(t, i) !== 'taxi') return null;
  const d = makeDraft('TAXI');
  return cmdHit(parseTaxiBody(d, t, i + 1, taxiways, runwayEnds), d);
};
export const ruleTaxi: Rule = makeTaxiRule();

/** "continue taxiing [to runway N via ...]": the taxi clearance in force resumes from a hold short of a taxiway. */
export const makeContinueTaxiRule = (taxiways?: readonly string[], runwayEnds?: readonly string[]): Rule => (t, i) => {
  const j = seq(t, i, 'continue taxi|taxiing');
  if (j < 0) return null;
  const d = makeDraft('TAXI');
  const end = parseTaxiBody(d, t, j, taxiways, runwayEnds);
  if (!d.fields.destination) d.fields.destination = 'CONTINUE';
  return cmdHit(end, d);
};

/** "cleared to the terminal via bravo": not taxi phraseology (7110.65 3-7-2 is "taxi to ..."), taken as a taxi to parking and marked non-standard. */
export const makeClearedToParkingRule = (taxiways?: readonly string[], runwayEnds?: readonly string[]): Rule => (t, i) => {
  const j = seq(t, i, 'cleared|clear to? the?');
  if (j < 0 || !parseParking(t, j)) return null;
  const d = makeDraft('TAXI');
  d.nonstandard++;
  d.issues.push('non-standard phraseology: "cleared to <parking>" taken as "taxi to <parking>"');
  return cmdHit(parseTaxiBody(d, t, j, taxiways, runwayEnds), d);
};

/**
 * "read back hold short instructions" / "readback hold instructions": JO 7110.65 3-7-2 PHRASEOLOGY "READ BACK HOLD INSTRUCTIONS."
 * (a request for the pilot's readback of the runway hold-short instruction; 2-4-3, AIM 4-3-18).
 */
export const ruleReadBackHold: Rule = (t, i) => {
  const j = seq(t, i, 'read|readback back? hold short? instructions|instruction?');
  if (j < 0) return null;
  return cmdHit(j, makeDraft('READ_BACK_HOLD'));
};

/**
 * Progressive taxi segment (JO 7110.65 3-7-2: "Progressive instructions may include step-by-step directions and/or directional turns";
 * AIM 4-3-18): "continue [straight] [on Bravo] to Charlie". The 3-7-2 phrase is "continue taxiing ... to (location)", so this shorter
 * form is marked non-standard. "Turn left on Bravo" is the runway-exit grammar; the executor reads it as a taxi turn once the aircraft is taxiing.
 */
export const ruleContinueSegment: Rule = (t, i) => {
  if (txt(t, i) !== 'continue' || seq(t, i, 'continue taxi|taxiing') >= 0) return null;
  let j = skipWords(t, i + 1, ['straight', 'ahead']);
  const d = makeDraft('TAXI', { segment: true });
  const on = seq(t, j, 'on|via|along taxiway?');
  if (on >= 0) {
    const tw = parseOneTaxiway(t, on);
    if (tw) { d.fields.route = [tw.id]; j = tw.next; }
  }
  const to = seq(t, j, 'to taxiway?');
  if (to >= 0) {
    const tw = parseOneTaxiway(t, to);
    if (tw) { d.fields.destination = `TWY${tw.id}`; j = tw.next; }
  }
  if (!d.fields.destination) return null;
  d.nonstandard++;
  d.issues.push('non-standard phraseology: expected "continue taxiing to <taxiway>" (JO 7110.65 3-7-2)');
  return cmdHit(j, d);
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
