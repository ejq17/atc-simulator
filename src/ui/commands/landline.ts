/**
 * Landline pipeline (the player's calls to the other positions), used by the voice landline key, the landline mode and the typed box:
 *
 *   text -> parseLandline -> resolve against the open requests -> engine.coordination.request / respond / rescind / inform
 *
 * The engine logs every message as a COORDINATION event; nothing is spoken here (the player spoke it, or typed it). A call that cannot be
 * carried out (a position the player does not work, nothing to answer, an aircraft that does not exist) is refused with the reason and logged as
 * an INFO line, like a refused radio call.
 */
import { looksLikeLandline, parseLandline } from '../../commands';
import type { LandlineCommand } from '../../commands';
import { numberWords } from '../../radio/spoken';
import type { SimulationEngine } from '../../sim/api';
import type { SimulationEngineExtras } from '../../sim/engineExtras';
import type { Aircraft, ControllerPositionId, SimulationState } from '../../sim/types';
import { awaitingAnswer, releasePosition, sameController, isStaffed } from '../../sim/coordination';
import { findRunway } from '../../sim/runways';
import { departuresAtHold } from '../lib/landline';
import type { CoordRequest } from '../../sim/coordination';
import { fixList, taxiwayNames } from './transmit';
import type { ControllerSetup } from './transmit';

export { looksLikeLandline };

export type LandlineSummary = 'done' | 'rejected' | 'clarify' | 'empty';

export interface LandlineResult {
  text: string;
  source: 'voice' | 'typed';
  command?: LandlineCommand;
  summary: LandlineSummary;
  /** One line for the panel. */
  message: string;
  requestId?: string;
}

export interface LandlineInput {
  engine: SimulationEngine;
  text: string;
  source: 'voice' | 'typed';
  controller: ControllerSetup;
}

const WORD: Record<ControllerPositionId, string> = { CLNC: 'Clearance Delivery', GND: 'Ground', TWR: 'Tower', APP: 'Approach', DEP: 'Departure' };

/** "2 miles west of cedar lake" -> "two miles west of cedar lake" (the TTS and the log read better with words for small numbers). */
const wordsForSmall = (s: string): string => s.replace(/\b(\d{1,2})\b/g, (_, n: string) => numberWords(Number(n)));

function refusal(engine: SimulationEngine, text: string, command: LandlineCommand | undefined, summary: LandlineSummary, message: string): LandlineResult {
  engine.logEvent({ kind: summary === 'clarify' ? 'CLARIFICATION' : 'INFO', text: `Landline: ${message}`, severity: 'warning', speaker: 'SYSTEM', data: { landline: true } });
  return { text, source: 'typed', command, summary, message };
}

function aircraftBy(state: SimulationState, callsign: string | null): Aircraft | undefined {
  return callsign ? Object.values(state.aircraft).find((a) => a.callsign.toUpperCase() === callsign.toUpperCase()) : undefined;
}

/** The request this answer is about: addressed to the answering position, matching the topic, the callsign and the runway when they were said. */
function pendingFor(state: SimulationState, answerer: ControllerPositionId, topic: CoordRequest['topic'] | undefined, cmd: LandlineCommand): { req?: CoordRequest; ambiguous?: CoordRequest[] } {
  let open = awaitingAnswer(state, answerer);
  if (topic) open = open.filter((r) => r.topic === topic);
  if (cmd.callsign) open = open.filter((r) => r.callsign === cmd.callsign);
  if (cmd.runwayId) open = open.filter((r) => !r.runwayId || r.runwayId === cmd.runwayId);
  if (open.length === 1) return { req: open[0] };
  if (open.length > 1) return { ambiguous: open };
  return {};
}

export function transmitLandline(input: LandlineInput): LandlineResult {
  const { engine, controller } = input;
  const text = input.text.trim();
  const api = (engine as SimulationEngine & SimulationEngineExtras).coordination;
  const state = engine.getState();
  const done = (message: string, command: LandlineCommand, requestId?: string): LandlineResult => ({ text, source: input.source, command, summary: 'done', message, requestId });
  const fail = (summary: LandlineSummary, message: string, command?: LandlineCommand): LandlineResult => ({ ...refusal(engine, text, command, summary, message), source: input.source });
  if (!text) return { text, source: input.source, summary: 'empty', message: 'Nothing to say.' };
  if (!api) return fail('rejected', 'This simulation has no coordination channel.');

  const cmd = parseLandline(text, {
    aircraft: Object.values(state.aircraft).map((a) => ({ callsign: a.callsign, spokenCallsign: a.spokenCallsign, type: a.type })),
    runwayEnds: state.airport.runways.flatMap((r) => r.ends.map((e) => e.id)),
    taxiways: taxiwayNames(state),
    fixes: fixList(state),
    playerPositions: controller.positions,
  });
  if (cmd.kind === 'UNKNOWN' || cmd.confidence < 0.6) {
    return fail('clarify', `Landline call not understood: heard "${text}"${cmd.issues.length ? ` (${cmd.issues.join('; ')})` : ''}. Say "<position>, <your position>, <message>" (your own position may be left out when you work only one): for example "Tower, cross runway one three at Alpha with Cessna ...".`, cmd);
  }

  const mine = controller.positions;
  let from = cmd.from;
  let to = cmd.to;
  const ac = aircraftBy(state, cmd.callsign);
  if (cmd.callsign && !ac) return fail('rejected', `No aircraft ${cmd.callsign} on the airport or in the area.`, cmd);

  // a point-out without the positions: Departure to Approach for a departure, Approach to Departure otherwise
  if (cmd.kind === 'POINT_OUT' && !from && !to) {
    const worksDep = mine.includes('DEP');
    const worksApp = mine.includes('APP');
    from = worksDep && (!worksApp || ac?.isDeparture !== false) ? 'DEP' : worksApp ? 'APP' : undefined;
    to = from === 'DEP' ? 'APP' : from === 'APP' ? 'DEP' : undefined;
  }
  if (!from || !to) return fail('clarify', 'Say which position you are calling and which one you are.', cmd);
  if (!mine.includes(from)) return fail('rejected', `You do not work ${WORD[from]}: you are ${mine.map((p) => WORD[p]).join(' and ')}.`, cmd);
  if (!isStaffed(state, to)) return fail('rejected', `Nobody works ${WORD[to]} in this session.`, cmd);
  if (sameController(state, from, to)) return fail('rejected', `You work both ${WORD[from]} and ${WORD[to]}: there is nobody to call.`, cmd);

  const need = (what: string): LandlineResult | undefined => (ac ? undefined : fail('clarify', `${what}: say the aircraft callsign.`, cmd));
  const answerWith = (topic: CoordRequest['topic'] | undefined, apply: (r: CoordRequest) => string | undefined): LandlineResult => {
    const { req, ambiguous } = pendingFor(state, from!, topic, cmd);
    if (ambiguous) return fail('clarify', `Which aircraft? ${ambiguous.map((r) => r.callsign).join(' or ')} (${ambiguous.length} requests are waiting for ${WORD[from!]}).`, cmd);
    if (!req) return fail('rejected', `Nothing is waiting for an answer from ${WORD[from!]}${cmd.callsign ? ` about ${cmd.callsign}` : ''}.`, cmd);
    const err = apply(req);
    return err ? fail('rejected', err, cmd) : done(`${WORD[from!]} answered ${req.callsign}`, cmd, req.id);
  };

  switch (cmd.kind) {
    case 'REQUEST_CROSS': {
      const e = need('Crossing request');
      if (e) return e;
      if (to !== 'TWR') return fail('rejected', 'A runway crossing is coordinated with Tower.', cmd);
      const req = api.request({ topic: 'CROSSING', from, to, aircraftId: ac!.id, runwayId: cmd.runwayId, point: cmd.point, source: 'player' });
      return req ? done(`Asked ${WORD[to]} for ${ac!.callsign} to cross runway ${req.runwayId}`, cmd, req.id) : fail('rejected', 'The request could not be made.', cmd);
    }
    case 'REQUEST_EXIT': {
      const e = need('Exit request');
      if (e) return e;
      if (to !== 'TWR') return fail('rejected', 'A runway exit for an arrival is coordinated with Tower.', cmd);
      const req = api.request({
        topic: 'EXIT', from, to, aircraftId: ac!.id, point: cmd.point, exitSide: cmd.exitSide,
        holdShortRunwayId: cmd.holdShortAfterLanding ? cmd.runwayId : undefined, source: 'player',
      });
      return req ? done(`Asked ${WORD[to]} to have ${ac!.callsign} ${[cmd.point || cmd.exitSide ? `exit${cmd.exitSide ? ` ${cmd.exitSide}` : ''}${cmd.point ? ` at ${cmd.point}` : ''}` : '', cmd.holdShortAfterLanding ? `hold short of runway ${cmd.runwayEnd ?? cmd.runwayId}` : ''].filter(Boolean).join(', ')}`, cmd, req.id) : fail('rejected', 'The request could not be made.', cmd);
    }
    case 'REQUEST_GAP': {
      // "Approach, Tower, need a gap for a departure runway two two": the request is made for the departure that has waited longest at that runway's hold.
      if (to !== 'APP') return fail('rejected', 'A departure gap is asked of Approach.', cmd);
      const rw = cmd.runwayId ? findRunway(state.airport, cmd.runwayId) : undefined;
      const waiting = departuresAtHold(state, rw?.id).filter((a) => !cmd.callsign || a.callsign === cmd.callsign);
      const dep = ac ?? waiting[0];
      if (!dep) return fail('rejected', `No departure is waiting at the hold${cmd.runwayEnd ? ` of runway ${cmd.runwayEnd}` : ''}.`, cmd);
      const end = cmd.runwayEnd ?? dep.assignedRunwayEnd;
      const req = api.request({ topic: 'GAP', from, to, aircraftId: dep.id, runwayId: rw?.id ?? findRunway(state.airport, dep.assignedRunwayEnd ?? '')?.id, runwayEnd: end, departures: cmd.departures ?? Math.max(1, waiting.length), source: 'player' });
      return req ? done(`Asked ${WORD[to]} for a gap for ${req.departures ?? 1} departure${(req.departures ?? 1) > 1 ? 's' : ''}${end ? ` runway ${end}` : ''}`, cmd, req.id) : fail('rejected', 'The request could not be made.', cmd);
    }
    case 'GAP_APPROVED':
      return answerWith('GAP', (r) => {
        const after = cmd.afterCallsign ? aircraftBy(state, cmd.afterCallsign) : undefined;
        api.respond(r.id, 'approve', { by: from!, source: 'player', afterAircraftId: after?.id });
        return undefined;
      });
    case 'APPROVE':
      return answerWith(cmd.runwayId || cmd.point ? 'CROSSING' : undefined, (r) => {
        const after = cmd.afterCallsign ? aircraftBy(state, cmd.afterCallsign) : undefined;
        api.respond(r.id, 'approve', { by: from!, source: 'player', afterAircraftId: after?.id });
        return undefined;
      });
    case 'UNABLE':
      return answerWith(undefined, (r) => {
        api.respond(r.id, 'deny', { by: from!, source: 'player' });
        return undefined;
      });
    case 'STANDBY':
      return answerWith(undefined, (r) => {
        api.respond(r.id, 'standby', { by: from!, source: 'player' });
        return undefined;
      });
    case 'HOLD_SHORT': {
      // an approval that has not been used is taken back; a request still waiting is refused
      const approved = state.coordination?.requests.filter((r) => r.topic === 'CROSSING' && r.to === from && r.status === 'approved' && (!cmd.callsign || r.callsign === cmd.callsign)) ?? [];
      if (approved.length === 1) {
        api.rescind(approved[0].id, { by: from, source: 'player', reason: 'hold short' });
        return done(`Took back the crossing approval for ${approved[0].callsign}`, cmd, approved[0].id);
      }
      return answerWith('CROSSING', (r) => {
        api.respond(r.id, 'deny', { by: from!, source: 'player' });
        return undefined;
      });
    }
    case 'CROSS_COMPLETE': {
      const e = need('Crossing complete');
      if (e) return e;
      api.inform({ kind: 'CROSS_COMPLETE', from, to, aircraftId: ac!.id, runwayId: cmd.runwayId, source: 'player' });
      return done(`Told ${WORD[to]} that ${ac!.callsign} is across`, cmd);
    }
    case 'REQUEST_RELEASE': {
      const e = need('Release request');
      if (e) return e;
      const target = to === 'DEP' || to === 'APP' ? to : releasePosition(state);
      if (!target) return fail('rejected', 'Nobody works Departure or Approach.', cmd);
      const req = api.request({ topic: 'RELEASE', from, to: target, aircraftId: ac!.id, runwayId: cmd.runwayId, source: 'player' });
      return req ? done(`Asked ${WORD[target]} to release ${ac!.callsign}`, cmd, req.id) : fail('rejected', 'The request could not be made.', cmd);
    }
    case 'RELEASED': {
      const e = need('Release');
      if (e) return e;
      const { req } = pendingFor(state, from, 'RELEASE', cmd);
      // Departure may release before Tower asks: the release is then logged as Departure's call and is current at once
      const r = req ?? api.request({ topic: 'RELEASE', from: to, to: from, aircraftId: ac!.id, source: 'player' });
      if (!r) return fail('rejected', 'The release could not be recorded.', cmd);
      api.respond(r.id, 'approve', { by: from, source: 'player' });
      return done(`Released ${ac!.callsign}`, cmd, r.id);
    }
    case 'HOLD_FOR_RELEASE': {
      const approved = state.coordination?.requests.filter((r) => r.topic === 'RELEASE' && r.to === from && r.status === 'approved' && (!cmd.callsign || r.callsign === cmd.callsign)) ?? [];
      if (approved.length === 1) {
        api.rescind(approved[0].id, { by: from, source: 'player', reason: 'hold for release' });
        return done(`Took back the release of ${approved[0].callsign}`, cmd, approved[0].id);
      }
      return answerWith('RELEASE', (r) => {
        api.respond(r.id, 'deny', { by: from!, source: 'player' });
        return undefined;
      });
    }
    case 'ROLLING':
    case 'GOING_AROUND': {
      const e = need(cmd.kind === 'ROLLING' ? 'Rolling' : 'Going around');
      if (e) return e;
      api.inform({ kind: cmd.kind, from, to, aircraftId: ac!.id, runwayId: cmd.runwayId ?? ac!.assignedRunwayEnd, source: 'player' });
      return done(`Told ${WORD[to]}: ${ac!.callsign} ${cmd.kind === 'ROLLING' ? 'rolling' : 'going around'}`, cmd);
    }
    case 'POINT_OUT': {
      const e = need('Point out');
      if (e) return e;
      const req = api.request({
        topic: 'POINT_OUT', from, to, aircraftId: ac!.id, positionText: cmd.positionText ? wordsForSmall(cmd.positionText) : undefined, altitudeFt: cmd.altitudeFt, source: 'player',
      });
      return req ? done(`Pointed out ${ac!.callsign} to ${WORD[to]}`, cmd, req.id) : fail('rejected', 'The point out could not be made.', cmd);
    }
    case 'POINT_OUT_APPROVED':
      return answerWith('POINT_OUT', (r) => {
        api.respond(r.id, 'approve', { by: from!, source: 'player' });
        return undefined;
      });
    case 'POINT_OUT_UNABLE':
      return answerWith('POINT_OUT', (r) => {
        api.respond(r.id, 'deny', { by: from!, source: 'player' });
        return undefined;
      });
    case 'TRAFFIC_OBSERVED':
      api.inform({ kind: 'TRAFFIC_OBSERVED', from, to, source: 'player' });
      return done(`Told ${WORD[to]}: traffic observed`, cmd);
    case 'TRAFFIC':
    case 'TEXT':
      api.inform({ kind: cmd.kind === 'TRAFFIC' ? 'TRAFFIC' : 'TEXT', from, to, text: cmd.text ?? text, source: 'player' });
      return done(`Message to ${WORD[to]}`, cmd);
    default:
      return fail('clarify', 'Landline call not understood.', cmd);
  }
}
