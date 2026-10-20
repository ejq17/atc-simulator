/**
 * Landline (coordination) phraseology: "<called position>, <calling position>, <message>".
 *
 *   Tower, Ground, cross runway one three at Alpha with Cessna three echo juliet     request to cross (REQUEST_CROSS)
 *   Ground, Tower, cross runway one three at Alpha [behind the landing Spirit]       Tower's authorisation, 7110.65 3-1-3 (APPROVE)
 *   Ground, Tower, cross approved | unable | hold short | stand by | I'll call you back
 *   Departure, Tower, release Spirit four fifty one                                    asks for the release (REQUEST_RELEASE)
 *   Tower, Departure, Spirit four fifty one released | hold for release                4-3-4 (RELEASED / HOLD_FOR_RELEASE)
 *   Departure, Tower, Spirit four fifty one rolling | going around                     information (ROLLING / GOING_AROUND)
 *   Tower, Ground, have Spirit ten thirty three exit left at Charlie                  asks Tower to give the exit (REQUEST_EXIT, 3-1-4)
 *   Tower, Ground, have Spirit ten thirty three hold short of runway four after landing
 *   Ground, Tower, Spirit ten thirty three will exit left at Charlie | unable, ..., will exit at Bravo     (APPROVE / UNABLE)
 *   Approach, Tower, need a gap for a departure runway two two [/ for two departures]   asks Approach for a departure gap (REQUEST_GAP; plain words, see sim/coordination.ts GAP)
 *   Tower, Approach, gap after Cessna three echo juliet | unable, ...                    Approach's answer (GAP_APPROVED / UNABLE)
 *   Approach, Departure, point out, two miles west of Cedar Lake, three thousand, Cessna ...    5-4-3 (POINT_OUT)
 *   Departure, Approach, Cessna ... point out approved | unable | traffic observed
 *
 * Not a radio transmission to an aircraft: `parseLandline` is separate from `parseTransmission`, reuses its normaliser, callsign matcher and
 * runway / taxiway readers, and returns one `LandlineCommand`. Which wordings are the FAA's (3-1-3, 4-3-4, 5-4-3) and which are plain words is in
 * `nonStandard`: a plain-words call keeps a lower confidence (0.9 per non-standard element, like the radio grammar's non-standard factor).
 */
import type { ControllerPositionId } from '../sim/types';
import { resolveCallsign, CALLSIGN_ACCEPT } from './callsign';
import type { AircraftRef } from './callsign';
import { parseOneTaxiway, parseRunway } from './entities';
import { normalize } from './normalize';
import { deriveAirlines, protectedWords } from './parse';
import type { Token } from './tokens';

export type LandlineKind =
  | 'REQUEST_CROSS' | 'APPROVE' | 'UNABLE' | 'STANDBY' | 'HOLD_SHORT' | 'CROSS_COMPLETE'
  | 'REQUEST_RELEASE' | 'RELEASED' | 'HOLD_FOR_RELEASE' | 'ROLLING' | 'GOING_AROUND'
  | 'REQUEST_EXIT' | 'REQUEST_GAP' | 'GAP_APPROVED'
  | 'POINT_OUT' | 'POINT_OUT_APPROVED' | 'POINT_OUT_UNABLE' | 'TRAFFIC_OBSERVED' | 'TRAFFIC' | 'TEXT' | 'UNKNOWN';

export interface LandlineCommand {
  kind: LandlineKind;
  /** The position that is called (first facility word) and the one calling (second). Undefined = not said. */
  to?: ControllerPositionId;
  from?: ControllerPositionId;
  callsign: string | null;
  runwayEnd?: string;
  runwayId?: string;
  /** The point / intersection ("A"); REQUEST_EXIT: the taxiway of the exit. */
  point?: string;
  /** REQUEST_EXIT: "exit left at Charlie". */
  exitSide?: 'left' | 'right';
  /** REQUEST_EXIT: "hold short of runway four after landing" (the runway is `runwayId` / `runwayEnd`). */
  holdShortAfterLanding?: boolean;
  /** REQUEST_GAP: how many departures wait for the gap ("for two departures"). */
  departures?: number;
  /** "behind the landing Spirit": the words after it, matched against the active aircraft. */
  afterCallsign?: string;
  /** POINT_OUT: "two miles west of Cedar Lake" as spoken (digits), and the altitude. */
  positionText?: string;
  altitudeFt?: number;
  /** TEXT / TRAFFIC: what was said after the two positions. */
  text?: string;
  confidence: number;
  /** The wording is not from the order (3-1-3, 4-3-4, 5-4-3). */
  nonStandard: boolean;
  issues: string[];
  rawText: string;
  normalizedText: string;
}

export interface LandlineContext {
  aircraft: AircraftRef[];
  /**
   * The positions the player works. With exactly one, the calling position need not be said: "Tower, cross runway four at Bravo with Spirit
   * ten thirty three" is Ground (or whichever position the player works) calling Tower.
   */
  playerPositions?: ControllerPositionId[];
  runwayEnds?: string[];
  taxiways?: string[];
  fixes?: { id: string; name?: string; spoken?: string }[];
}

const POSITION_WORDS: Record<string, ControllerPositionId> = {
  ground: 'GND', tower: 'TWR', approach: 'APP', departure: 'DEP', clearance: 'CLNC', delivery: 'CLNC',
};

/** Words speech recognition gives for the position names and the key words of a coordination call. */
const REPAIRS: Record<string, string> = {
  tour: 'tower', towers: 'tower', power: 'tower', tire: 'tower', grounds: 'ground', grown: 'ground', crowned: 'ground', round: 'ground',
  departures: 'departure', approaches: 'approach', proach: 'approach',
  crass: 'cross', released: 'released', realised: 'released', releases: 'release',
  enable: 'unable', unabel: 'unable', standby: 'standby', stand: 'stand', approve: 'approved', approval: 'approved', aproved: 'approved',
  rolin: 'rolling', roling: 'rolling', pointout: 'pointout', pointer: 'pointout',
};

function repaired(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    // "point-out" / "point out" / "pointed out": one marker
    if (t.kind === 'word' && /^point(ed|s)?$/.test(t.text) && next?.text === 'out') {
      out.push({ ...t, text: 'pointout', rawEnd: next.rawEnd });
      i++;
      continue;
    }
    if (t.kind === 'word' && t.text === 'stand' && next?.text === 'by') {
      out.push({ ...t, text: 'standby', rawEnd: next.rawEnd });
      i++;
      continue;
    }
    const fix = t.kind === 'word' ? REPAIRS[t.text] : undefined;
    out.push(fix ? { ...t, text: fix } : t);
  }
  return out;
}

const hasWord = (tokens: readonly Token[], ...words: string[]): boolean => tokens.some((t) => t.kind === 'word' && words.includes(t.text));
/** Leading "<position> [control], [this is] <position>" -> positions and the index of the first body token. */
function readPositions(tokens: readonly Token[]): { to?: ControllerPositionId; from?: ControllerPositionId; next: number } {
  let i = 0;
  const one = (): ControllerPositionId | undefined => {
    const t = tokens[i];
    if (!t || t.kind !== 'word') return undefined;
    const p = POSITION_WORDS[t.text];
    if (!p) return undefined;
    i++;
    if (t.text === 'clearance' && tokens[i]?.text === 'delivery') i++;
    if (tokens[i]?.text === 'control') i++;
    return p;
  };
  const to = one();
  if (!to) return { next: 0 };
  while (tokens[i]?.kind === 'word' && ['this', 'is', 'from'].includes(tokens[i].text)) i++;
  const from = one();
  return { to, from, next: i };
}

/**
 * Does this text start like a landline call ("Tower, Ground, ...")? A radio call to an aircraft never starts with two position names, nor with one
 * position name followed by a coordination request ("Tower, cross runway four at Bravo with Spirit ten thirty three", "Departure, release ...",
 * "Approach, point out ..."): the controller addresses aircraft by callsign, so a position name first is a call to another controller.
 */
export function looksLikeLandline(text: string): boolean {
  const n = normalize(text);
  const tokens = repaired(n.tokens);
  const r = readPositions(tokens);
  if (r.to !== undefined && r.from !== undefined && r.to !== r.from) return true;
  if (r.to === undefined) return false;
  const body = tokens.slice(r.next);
  const crossesRunway = body.some((t) => t.kind === 'word' && t.text === 'cross') && body.some((t) => t.kind === 'word' && t.text === 'runway');
  return crossesRunway || hasWord(body, 'pointout', 'release', 'released', 'gap') || isExitRequestBody(body);
}

/** "have <aircraft> exit left at Charlie" / "... hold short of runway four after landing": Ground asking Tower for an exit (3-1-4). */
function isExitRequestBody(body: readonly Token[]): boolean {
  const exit = hasWord(body, 'exit') || (hasWord(body, 'turn') && hasWord(body, 'left', 'right') && hasWord(body, 'have', 'at'));
  const holdAfterLanding = hasWord(body, 'hold') && hasWord(body, 'short') && hasWord(body, 'after') && hasWord(body, 'landing', 'lands', 'land');
  return (exit && hasWord(body, 'have')) || holdAfterLanding;
}

function entities(body: Token[], ctx: LandlineContext): { runwayEnd?: string; runwayId?: string; point?: string; issues: string[] } {
  const issues: string[] = [];
  let runwayEnd: string | undefined;
  let runwayId: string | undefined;
  let point: string | undefined;
  for (let i = 0; i < body.length; i++) {
    if (!runwayEnd && body[i].text === 'runway') {
      const r = parseRunway(body, i);
      if (r?.ok) {
        runwayEnd = r.ref.end;
        runwayId = r.ref.id;
        if (ctx.runwayEnds?.length && !ctx.runwayEnds.includes(r.ref.end) && !ctx.runwayEnds.includes(r.ref.id.split('/')[1] ?? '')) issues.push(`unknown runway ${r.ref.end}`);
      } else if (r) issues.push(r.reason);
    }
    if (!point && body[i].text === 'at') {
      const t = parseOneTaxiway(body, i + 1);
      if (t) {
        point = t.id;
        if (ctx.taxiways?.length && !ctx.taxiways.includes(t.id)) issues.push(`unknown taxiway ${t.id}`);
      }
    }
  }
  return { runwayEnd, runwayId, point, issues };
}

/** "behind the landing Spirit [four fifty one]": the aircraft the active list matches best (callsign, or the telephony / type word). */
function afterAircraft(body: Token[], ctx: LandlineContext): string | undefined {
  let i = body.findIndex((t) => t.kind === 'word' && (t.text === 'behind' || t.text === 'after'));
  if (i < 0) return undefined;
  i++;
  while (body[i] && ['the', 'landing', 'arrival', 'traffic', 'departing', 'aircraft'].includes(body[i].text)) i++;
  const slice = body.slice(i, i + 8);
  if (!slice.length) return undefined;
  const res = resolveCallsign(slice, ctx.aircraft);
  if (res.callsign && res.score >= CALLSIGN_ACCEPT) return res.callsign;
  // "the landing Spirit" / "the Cessna": first word of the spoken callsign, only when exactly one aircraft has it
  const word = slice[0].text.toLowerCase();
  const hits = ctx.aircraft.filter((a) =>
    a.spokenCallsign.toLowerCase().split(' ')[0] === word || (slice[0].kind === 'airline' && a.callsign.toUpperCase().startsWith(slice[0].text.toUpperCase()) && /^[A-Z]{3}\d/.test(a.callsign)));
  return hits.length === 1 ? hits[0].callsign : undefined;
}

export function parseLandline(text: string, ctx: LandlineContext): LandlineCommand {
  const norm = normalize(text, { extraAirlines: deriveAirlines(ctx.aircraft), protectedWords: protectedWords({ aircraft: ctx.aircraft, fixes: ctx.fixes }), taxiways: ctx.taxiways, runwayEnds: ctx.runwayEnds });
  const tokens = repaired(norm.tokens);
  const pos = readPositions(tokens);
  // A player who works one position needs not say it: the called position is the only other one named.
  if (pos.to && !pos.from && ctx.playerPositions?.length === 1 && ctx.playerPositions[0] !== pos.to) pos.from = ctx.playerPositions[0];
  const issues: string[] = [];
  let nonStandard = false;
  const base = (over: Partial<LandlineCommand>): LandlineCommand => ({
    kind: 'UNKNOWN', to: pos.to, from: pos.from, callsign: null, confidence: 0.1, nonStandard, issues, rawText: text, normalizedText: norm.text, ...over,
  });
  if (tokens.length === 0) return base({ issues: ['empty transmission'] });

  // body without the positions and the callsign
  const cs = resolveCallsign(tokens.slice(pos.next), ctx.aircraft);
  const body0 = tokens.slice(pos.next);
  const masked = cs.span ? body0.filter((_, i) => i < cs.span!.start || i >= cs.span!.end) : body0;
  const body = masked;
  let callsign = cs.callsign && cs.score >= CALLSIGN_ACCEPT ? cs.callsign : null;
  const ent = entities(body, ctx);
  // "behind the landing Spirit four fifty one": the only callsign said is the aircraft to wait for, not the one that crosses
  const after = afterAircraft(body0, ctx);
  if (after && callsign === after) callsign = null;
  issues.push(...ent.issues);

  const words = body.filter((t) => t.kind === 'word').map((t) => t.text);
  const has = (...w: string[]) => hasWord(body, ...w);
  let kind: LandlineKind = 'UNKNOWN';
  let positionText: string | undefined;
  let altitudeFt: number | undefined;
  let freeText: string | undefined;

  const answering = pos.from === 'TWR' && pos.to === 'GND';
  if (has('pointout')) {
    if (has('approved')) kind = 'POINT_OUT_APPROVED';
    else if (has('unable', 'negative')) kind = 'POINT_OUT_UNABLE';
    else {
      kind = 'POINT_OUT';
      // position: the words between "point out" and the callsign (or the first altitude); altitude: the first round number of 3+ digits
      const abs = tokens.slice(pos.next);
      const k0 = abs.findIndex((t) => t.text === 'pointout');
      const csStart = cs.span ? cs.span.start : abs.length;
      const altIdx = abs.findIndex((t, idx) => idx > k0 && t.kind === 'number' && /^\d{3,5}$/.test(t.text) && Number(t.text) >= 100 && Number(t.text) % 100 === 0);
      if (altIdx >= 0) altitudeFt = Number(abs[altIdx].text);
      const end = Math.min(csStart, altIdx >= 0 ? altIdx : abs.length);
      positionText = abs.slice(k0 + 1, Math.max(k0 + 1, end)).map((t) => t.text).join(' ').trim() || undefined;
      if (!positionText) issues.push('say where the aircraft is (a distance and direction from a fix)');
    }
  } else if (has('traffic') && has('observed')) kind = 'TRAFFIC_OBSERVED';
  else if (isExitRequestBody(body0)) kind = 'REQUEST_EXIT';
  else if (has('gap')) kind = has('after', 'available', 'ready') && !has('need', 'request') ? 'GAP_APPROVED' : 'REQUEST_GAP';
  else if (has('hold') && has('release')) kind = 'HOLD_FOR_RELEASE';
  else if (has('released') || (has('release') && has('approved', 'granted'))) kind = 'RELEASED';
  else if (has('release')) kind = 'REQUEST_RELEASE';
  else if (has('rolling')) kind = 'ROLLING';
  else if (words.includes('going') && has('around') || (has('go') && has('around')) || (has('on') && has('the') && has('go'))) kind = 'GOING_AROUND';
  else if (/\bacross\b/i.test(text) || (has('crossing') && has('complete')) || (has('clear') && has('runway')) || (has('complete') && !has('cross'))) kind = 'CROSS_COMPLETE';
  else if (has('cross') && (ent.runwayEnd !== undefined || callsign !== null)) {
    kind = has('request') || !answering ? 'REQUEST_CROSS' : 'APPROVE';
    if (kind === 'APPROVE' && after) nonStandard = true;
  } else if (has('standby') || (has('call') && has('back')) || (has('wait') && !has('hold'))) kind = 'STANDBY'; // "unable, traffic ..., I'll call you back" is a stand-by
  else if (has('unable', 'negative', 'denied', 'disapproved')) kind = 'UNABLE';
  else if (has('hold') && has('short')) kind = 'HOLD_SHORT';
  else if (has('approved', 'approve') || has('cross')) kind = 'APPROVE';
  else if (has('traffic')) {
    kind = 'TRAFFIC';
    freeText = body.map((t) => t.text).join(' ');
  } else if (body.length > 0 && pos.to && pos.from) {
    kind = 'TEXT';
    freeText = body.map((t) => t.text).join(' ');
  }

  // REQUEST_EXIT: the side, the taxiway after "at" / "on", and a hold short of a runway after landing
  let exitSide: 'left' | 'right' | undefined;
  let exitPoint = ent.point;
  const holdShortAfterLanding = kind === 'REQUEST_EXIT' && has('hold') && has('short');
  if (kind === 'REQUEST_EXIT') {
    exitSide = words.includes('left') ? 'left' : words.includes('right') ? 'right' : undefined;
    if (!exitPoint) {
      for (let i = 0; i < body.length && !exitPoint; i++) {
        if (['on', 'onto', 'via'].includes(body[i].text)) exitPoint = parseOneTaxiway(body, i + 1)?.id;
      }
    }
    if (!callsign) issues.push(cs.issues[0] ?? 'missing callsign');
    if (!exitPoint && !exitSide && !holdShortAfterLanding) issues.push('missing exit (say the taxiway or the side, or a hold short)');
    if (holdShortAfterLanding && !ent.runwayId) issues.push('missing runway to hold short of');
  }
  // REQUEST_GAP: "for a departure" / "for two departures"
  let departures: number | undefined;
  if (kind === 'REQUEST_GAP') {
    // ("departures" is also repaired to the position name "departure", so the plural is read from the normalised text)
    const m = /(?:^|\s)(\d+)\s+departures\b/.exec(norm.text);
    departures = m ? Number(m[1]) : /\bdepartures\b/.test(norm.text) ? 2 : 1;
  }
  // required parts and standardness
  if ((kind === 'REQUEST_CROSS') && !ent.runwayId) issues.push('missing runway');
  if ((kind === 'REQUEST_CROSS') && !callsign) issues.push(cs.callsign ? `low-confidence callsign ${cs.callsign}` : 'missing callsign');
  if ((kind === 'REQUEST_RELEASE' || kind === 'RELEASED' || kind === 'HOLD_FOR_RELEASE' || kind === 'ROLLING' || kind === 'GOING_AROUND' || kind === 'POINT_OUT') && !callsign) issues.push(cs.issues[0] ?? 'missing callsign');
  if (kind === 'REQUEST_CROSS' && !ent.point) { nonStandard = true; issues.push('no point / intersection (3-1-3 asks for it)'); }
  if (kind === 'APPROVE' && ent.runwayEnd !== undefined && !ent.point) { nonStandard = true; issues.push('"cross (runway) at (point)" is the 3-1-3 form'); }
  if (['REQUEST_CROSS', 'REQUEST_EXIT', 'REQUEST_GAP', 'GAP_APPROVED', 'UNABLE', 'STANDBY', 'HOLD_SHORT', 'CROSS_COMPLETE', 'REQUEST_RELEASE', 'ROLLING', 'GOING_AROUND', 'TRAFFIC', 'TEXT'].includes(kind)) nonStandard = true;
  if (kind === 'APPROVE' && ent.runwayEnd === undefined) nonStandard = true; // bare "approved" / "cross approved"

  // The two positions: required, except that a point-out may omit them (the 5-4-3 pattern starts at "point out"; the resolver fills them in).
  const noPositions = !pos.to && !pos.from;
  if (!(kind === 'POINT_OUT' && noPositions)) {
    if (!pos.to) issues.push('say the position you are calling');
    else if (!pos.from) issues.push('say which position is calling');
  }
  const known = kind !== 'UNKNOWN';
  let confidence = known ? 0.97 : 0.1;
  if (kind === 'POINT_OUT' && noPositions) confidence *= 0.9;
  else if (!pos.to || !pos.from) confidence *= 0.45;
  if (!known || body.length === 0) confidence = Math.min(confidence, 0.2);
  const missing = issues.filter((x) => x.startsWith('missing')).length;
  confidence *= 0.55 ** missing;
  if (nonStandard) confidence *= 0.9;
  if (kind === 'TEXT') confidence = Math.min(confidence, 0.75);
  if (ent.issues.length) confidence *= 0.85 ** ent.issues.length;
  confidence = Math.round(Math.min(0.99, confidence) * 100) / 100;

  const uniq = [...new Set(issues)];
  if (!known) uniq.push('no recognised coordination call');
  return base({
    kind, callsign, runwayEnd: ent.runwayEnd, runwayId: ent.runwayId, point: kind === 'REQUEST_EXIT' ? exitPoint : ent.point, exitSide, holdShortAfterLanding: holdShortAfterLanding || undefined, afterCallsign: after, departures,
    positionText, altitudeFt, text: freeText, confidence, nonStandard, issues: uniq,
  });
}

