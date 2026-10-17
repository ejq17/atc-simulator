/**
 * Session debrief: grade, summary, concrete improvement advice derived from the score counters and the event log,
 * an event timeline and the evaluated objectives.
 *
 * Grade: A >= 90, B >= 80, C >= 70, D >= 60, else F. Any runway incursion caps the grade at C.
 * Paragraph numbers in advice come from references.ts (all verified against the FAA web edition).
 */
import type { SimEvent, SimulationState } from '../sim/types';
import type { DebriefReport } from './index';
import { allObjectivesDone, evaluateObjectives } from './objectives';
import { REFERENCES, TRAINING_DISCLAIMER } from './references';
import type { ReferenceId } from './references';

export type Grade = DebriefReport['grade'];

export function gradeFor(score: number, runwayIncursions = 0): Grade {
  const g: Grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  if (runwayIncursions > 0 && (g === 'A' || g === 'B')) return 'C';
  return g;
}

const cite = (...ids: ReferenceId[]): string => `(7110.65 ${ids.map((i) => `${REFERENCES[i].para} ${REFERENCES[i].title}`).join('; ')})`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Kinds of event that appear in the timeline (besides anything with warning/critical severity). */
const TIMELINE_KINDS: ReadonlySet<SimEvent['kind']> = new Set([
  'COMMAND_ACCEPTED', 'COMMAND_REJECTED', 'CLARIFICATION', 'HANDOFF', 'GO_AROUND', 'RUNWAY_INCURSION', 'CONFLICT',
  'SEPARATION_VIOLATION', 'READBACK_ERROR', 'SCENARIO',
]);

function classifyUnsafe(text: string): 'takeoff' | 'lineup' | 'landing' | 'crossing' | 'intersecting' | 'other' {
  const t = text.toLowerCase();
  if (t.includes('intersecting runway')) return 'intersecting';
  if (t.includes('takeoff clearance')) return 'takeoff';
  if (t.includes('line up and wait')) return 'lineup';
  if (t.includes('landing clearance')) return 'landing';
  if (t.includes('crossing clearance')) return 'crossing';
  return 'other';
}

export function buildImprovements(state: SimulationState, events: SimEvent[]): string[] {
  const s = state.score;
  const out: string[] = [];

  if (s.runwayIncursions > 0) {
    const who = [...new Set(events.filter((e) => e.kind === 'RUNWAY_INCURSION').map((e) => e.callsign).filter(Boolean))].join(', ');
    out.push(
      `${plural(s.runwayIncursions, 'runway incursion')}${who ? ` (${who})` : ''}: an aircraft was on a runway without a clearance. Give every taxi route an explicit hold-short instruction, ` +
      `make sure the pilot reads it back (the KACY diagram requires readback of all runway holding instructions), and issue crossings only with "cross runway ... at ..." ${cite('3-7-2', '2-4-3')}.`,
    );
  }

  const unsafe = events.filter((e) => e.kind === 'CONFLICT' && e.data?.alertKind === 'UNSAFE_CLEARANCE');
  if (unsafe.length) {
    const groups = new Map<string, number>();
    for (const e of unsafe) groups.set(classifyUnsafe(e.text), (groups.get(classifyUnsafe(e.text)) ?? 0) + 1);
    const g = (k: string): number => groups.get(k) ?? 0;
    if (g('takeoff')) {
      out.push(`You issued ${plural(g('takeoff'), 'takeoff clearance')} while the runway was occupied or an arrival was on short final - wait for the preceding aircraft to be airborne and past the departure end or exit the runway, and for landing traffic to be clear ${cite('3-9-6', '3-10-3')}.`);
    }
    if (g('lineup')) {
      out.push(`You told an aircraft to line up and wait ${g('lineup') === 1 ? 'once' : g('lineup') + ' times'} while the runway was occupied, in use or an aircraft was already in position ${cite('3-9-4')}.`);
    }
    if (g('landing')) {
      out.push(`You issued ${plural(g('landing'), 'landing clearance')} with the runway occupied, an aircraft rolling or in position - hold the landing clearance (or send the arrival around) until the runway is free ${cite('3-10-5', '3-10-3')}.`);
    }
    if (g('crossing')) {
      out.push(`You cleared ${plural(g('crossing'), 'runway crossing')} while the runway was busy - look at the runway and the final before you say "cross" ${cite('3-7-2', '3-1-3')}.`);
    }
    if (g('intersecting')) {
      out.push(`You used intersecting runways 13/31 and 4/22 at the same time ${g('intersecting') === 1 ? 'once' : g('intersecting') + ' times'} - separate operations on intersecting runways ${cite('3-9-8')}.`);
    }
    if (g('other')) out.push(`${plural(g('other'), 'other unsafe clearance')} recorded; open the timeline for details.`);
  }

  if (s.separationViolations > 0) {
    const pairs = events.filter((e) => e.kind === 'SEPARATION_VIOLATION').slice(0, 3).map((e) => e.text);
    out.push(
      `${plural(s.separationViolations, 'loss of separation', 'losses of separation')}: ${pairs.join('; ')}. Use speed control, headings or a go-around to keep faster aircraft behind slower ones ${cite('3-8-1')}, ` +
      'and keep ground traffic at least a few aircraft lengths apart.',
    );
  }

  if (s.missedReadbackErrors > 0) {
    const ex = events.find((e) => e.kind === 'READBACK_ERROR' && e.data?.missed);
    out.push(
      `${plural(s.missedReadbackErrors, 'incorrect readback')} went uncorrected${ex ? ` (${ex.text.replace(/^Missed readback error from /, '')})` : ''}. Listen to the whole readback - runway, hold-short, heading, callsign - and repeat the instruction if anything differs ${cite('2-4-3')}.`,
    );
  }

  if (s.communicationErrors > 0) {
    const bad = events.filter((e) => (e.kind === 'COMMAND_REJECTED' || e.kind === 'CLARIFICATION') && e.data?.commError);
    const notOnFreq = bad.filter((e) => /not on frequency/i.test(e.text)).length;
    const noCallsign = bad.filter((e) => /no callsign|which aircraft/i.test(e.text)).length;
    const other = bad.length - notOnFreq - noCallsign;
    const bits: string[] = [];
    if (notOnFreq) bits.push(`${plural(notOnFreq, 'call')} to an aircraft on another frequency - switch to the right position (Ground/Tower) first or hand the aircraft off properly`);
    if (noCallsign) bits.push(`${plural(noCallsign, 'transmission')} without a callsign the system could match - say the full callsign ${cite('2-4-20')}`);
    if (other > 0) bits.push(`${plural(other, 'instruction')} the pilot could not carry out (wrong phase, unknown destination or route)`);
    out.push(`${plural(s.communicationErrors, 'communication error')}: ${bits.join('; ')}.`);
  }

  const goArounds = events.filter((e) => e.kind === 'GO_AROUND');
  const noClearance = goArounds.filter((e) => /no landing clearance/i.test(e.text));
  if (noClearance.length) {
    out.push(`${[...new Set(noClearance.map((e) => e.callsign))].join(', ')} had to go around because there was no landing clearance by the decision point - clear arrivals to land earlier, or tell them to go around yourself ${cite('3-10-5')}.`);
  }
  const trafficGa = goArounds.filter((e) => /traffic on the runway/i.test(e.text));
  if (trafficGa.length) {
    out.push(`${[...new Set(trafficGa.map((e) => e.callsign))].join(', ')} went around because another aircraft was still on the runway - hold the landing clearance until the runway is clear ${cite('3-10-3')}.`);
  }

  if (s.averageWaitSec > 60) {
    out.push(`Pilots waited ${Math.round(s.averageWaitSec)} s on average for an answer (${Math.round(s.totalDelaySec)} s beyond the one-minute allowance). Answer requests in the order they arrive, and use line up and wait to keep departures moving ${cite('3-9-4')}.`);
  } else if (s.totalDelaySec > 0) {
    out.push(`${Math.round(s.totalDelaySec)} s of delay beyond one minute built up on some requests; watch the pending-request list.`);
  }

  const missed = evaluateObjectives(state).filter((o) => !o.completed);
  for (const o of missed) out.push(`Objective not completed: ${o.text}.`);

  if (!out.length) out.push('No safety issues were recorded. Keep it up: now work on keeping the average wait short while holding the same standard.');
  return out;
}

function timelineOf(events: SimEvent[], t0: number): DebriefReport['timeline'] {
  return events
    .filter((e) => e.timeSec >= t0 && (e.severity !== 'info' || TIMELINE_KINDS.has(e.kind)))
    .filter((e) => e.kind !== 'CONFLICT' || e.data?.alertKind !== 'RUNWAY_CONFLICT' || e.severity !== 'info')
    .map((e) => ({ timeSec: Math.round((e.timeSec - t0) * 10) / 10, kind: e.kind, text: e.text, severity: e.severity, callsign: e.callsign }));
}

/**
 * Build the end-of-session report. `startedAtSec` is the sim time at which the session began (default 0); events before
 * it are ignored and timeline times are relative to it.
 */
export function buildDebrief(state: SimulationState, startedAtSec = 0): DebriefReport {
  const events = state.events.filter((e) => e.timeSec >= startedAtSec);
  const s = state.score;
  const grade = gradeFor(s.score, s.runwayIncursions);
  const durationSec = Math.max(0, state.clock.timeSec - startedAtSec);
  const objectives = evaluateObjectives(state);
  const completed = objectives.length ? allObjectivesDone(state) : s.scenarioCompleted;
  const minutes = Math.max(1, Math.round(durationSec / 60));

  const safety =
    s.runwayIncursions + s.unsafeInstructions + s.separationViolations === 0
      ? 'No safety events were recorded.'
      : `Safety events: ${[
        s.runwayIncursions && plural(s.runwayIncursions, 'runway incursion'),
        s.unsafeInstructions && plural(s.unsafeInstructions, 'unsafe clearance'),
        s.separationViolations && plural(s.separationViolations, 'separation violation'),
      ].filter(Boolean).join(', ')}.`;
  const obj = objectives.length ? ` Objectives: ${objectives.filter((o) => o.completed).length} of ${objectives.length} completed.` : '';
  const cap = s.runwayIncursions > 0 && s.score >= 80 ? ' A runway incursion caps the grade at C.' : '';
  const summary =
    `You worked ${state.scenario.name} for ${plural(minutes, 'minute')}: ${plural(s.aircraftHandled, 'aircraft', 'aircraft')} handled, ` +
    `${plural(s.correctClearances, 'correct clearance')}, average pilot wait ${Math.round(s.averageWaitSec)} s. ${safety} ` +
    `Score ${Math.round(s.score)}, grade ${grade}.${cap}${obj} ${state.scenario.mode === 'training' ? TRAINING_DISCLAIMER : ''}`.trim();

  return {
    scenarioId: state.scenario.id,
    scenarioName: state.scenario.name,
    durationSec,
    score: { ...s },
    grade,
    summary,
    improvements: buildImprovements(state, events),
    timeline: timelineOf(events, startedAtSec),
    objectives,
    completed,
  };
}
