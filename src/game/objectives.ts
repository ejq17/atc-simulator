/**
 * Objective predicates. `Scenario.objectives[].check` and training-step `check` fields are strings of the form
 * `name[:arg[:arg]]`, evaluated against the live `SimulationState` (events + aircraft + score).
 *
 *   cmd:KIND:CS            an accepted, safe command of that kind was issued to CS (e.g. cmd:TAKEOFF:N723EJ)
 *   takeoff:CS             CS is airborne (reached INITIAL_CLIMB)
 *   landed:CS              CS touched down (reached ROLLOUT)
 *   vacated:CS             CS landed and its whole footprint has left the runway surface
 *   parked:CS              CS shut down at parking (ARRIVED / handled)
 *   taxied:CS              CS began taxiing (reached TAXIING)
 *   holding_short:CS       CS reported holding short of its departure runway
 *   crossing_request:CS    CS reported holding short and asking to cross a runway
 *   crossed:CS:13/31       CS entered and then left that runway surface (a crossing)
 *   handoff:CS             CS changed frequency after a CONTACT_FREQUENCY
 *   go_around:CS           CS went around
 *   landed_before:A:B      A touched down, and B had not touched down earlier
 *   handled:>=N | handled:N   score.aircraftHandled
 *   score:>=N              score.score
 *   no_incursions | no_unsafe | no_separation | no_conflicts
 *   active_runway:31       the active runway configuration lists runway end 31 for both landing and departing
 *   always                 trivially true
 *
 * Unknown checks evaluate to false (and `isKnownCheck` tells the author).
 */
import type { SimEvent, SimulationState } from '../sim/types';

export interface ObjectiveResult {
  id: string;
  text: string;
  completed: boolean;
}

interface EventIndex {
  /** first time a keyed fact became true */
  facts: Map<string, number>;
}

const AIRBORNE_DEPARTURE_PHASES = new Set(['INITIAL_CLIMB', 'DEPARTURE', 'PATTERN', 'HOLDING']);

let cache: { events: SimEvent[]; len: number; lastId: string | undefined; index: EventIndex } | undefined;

function indexOf(state: SimulationState): EventIndex {
  const ev = state.events;
  const lastId = ev[ev.length - 1]?.id;
  if (cache && cache.events === ev && cache.len === ev.length && cache.lastId === lastId) return cache.index;
  const facts = new Map<string, number>();
  const put = (k: string, t: number): void => {
    if (!facts.has(k)) facts.set(k, t);
  };
  /** callsign -> runway id it touched down on */
  const landedOn = new Map<string, string>();
  const runwayOfEnd = (end: string): string | undefined => state.airport.runways.find((r) => r.ends.some((x) => x.id === end))?.id;
  for (const e of ev) {
    const cs = e.callsign?.toUpperCase();
    if (!cs) continue;
    const d = e.data ?? {};
    switch (e.kind) {
      case 'INFO':
        if (typeof d.runwayEnd === 'string' && typeof d.alongM === 'number') {
          const rid = runwayOfEnd(d.runwayEnd);
          if (rid) landedOn.set(cs, rid);
        }
        break;
      case 'PHASE_CHANGE':
        if (typeof d.to === 'string') put(`phase:${cs}:${d.to}`, e.timeSec);
        break;
      case 'COMMAND_ACCEPTED':
        if (typeof d.kind === 'string' && !d.unsafe && d.correction !== true) put(`cmd:${d.kind}:${cs}`, e.timeSec);
        break;
      case 'HANDOFF':
        put(`handoff:${cs}`, e.timeSec);
        break;
      case 'GO_AROUND':
        put(`go_around:${cs}`, e.timeSec);
        break;
      case 'RUNWAY_ENTERED':
        if (typeof d.runwayId === 'string') put(`entered:${cs}:${d.runwayId}`, e.timeSec);
        break;
      case 'RUNWAY_EXITED':
        if (typeof d.runwayId === 'string' && facts.has(`entered:${cs}:${d.runwayId}`)) {
          put(`exited:${cs}:${d.runwayId}`, e.timeSec);
          if (landedOn.get(cs) === d.runwayId) put(`vacated:${cs}`, e.timeSec);
        }
        break;
      case 'DESPAWN':
        if (d.handled) put(`handled:${cs}`, e.timeSec);
        break;
      case 'TRANSMISSION':
        if (e.speaker === 'PILOT' && typeof d.request === 'string') {
          if (d.request === 'CROSSING') put(`crossing_request:${cs}`, e.timeSec);
          else if ((d.request === 'DEPARTURE' || d.request === 'FREQUENCY_CHANGE') && /holding short runway/i.test(e.text)) put(`holding_short:${cs}`, e.timeSec);
        }
        break;
      default:
        break;
    }
  }
  const index = { facts };
  cache = { events: ev, len: ev.length, lastId, index };
  return index;
}

function aircraftBy(state: SimulationState, cs: string) {
  return Object.values(state.aircraft).find((a) => a.callsign.toUpperCase() === cs);
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s.replace(/^>=/, ''));
  return Number.isFinite(n) ? n : undefined;
};

const KNOWN = new Set([
  'cmd', 'takeoff', 'landed', 'vacated', 'parked', 'taxied', 'holding_short', 'crossing_request', 'crossed', 'handoff', 'go_around',
  'landed_before', 'handled', 'score', 'no_incursions', 'no_unsafe', 'no_separation', 'no_conflicts', 'active_runway', 'always',
]);

export function isKnownCheck(check: string): boolean {
  return KNOWN.has(check.split(':')[0]);
}

/** Time (s) a fact first became true, or undefined. Exposed for debrief/training use. */
export function firstTime(state: SimulationState, key: string): number | undefined {
  return indexOf(state).facts.get(key);
}

export function evaluateCheck(state: SimulationState, check: string): boolean {
  const parts = check.split(':');
  const name = parts[0];
  const cs = parts[1]?.toUpperCase() ?? '';
  const facts = indexOf(state).facts;
  const s = state.score;
  switch (name) {
    case 'always':
      return true;
    case 'cmd':
      return facts.has(`cmd:${parts[1]?.toUpperCase()}:${parts[2]?.toUpperCase()}`);
    case 'takeoff': {
      if (facts.has(`phase:${cs}:INITIAL_CLIMB`)) return true;
      const a = aircraftBy(state, cs);
      return !!a && !a.onGround && a.isDeparture && AIRBORNE_DEPARTURE_PHASES.has(a.phase);
    }
    case 'landed':
      return facts.has(`phase:${cs}:ROLLOUT`) || facts.has(`phase:${cs}:RUNWAY_EXIT`);
    case 'vacated':
      return facts.has(`vacated:${cs}`);
    case 'parked':
      return facts.has(`phase:${cs}:ARRIVED`) || (facts.has(`handled:${cs}`) && facts.has(`phase:${cs}:ROLLOUT`));
    case 'taxied':
      return facts.has(`phase:${cs}:TAXIING`);
    case 'holding_short':
      return facts.has(`holding_short:${cs}`);
    case 'crossing_request':
      return facts.has(`crossing_request:${cs}`);
    case 'crossed':
      return facts.has(`exited:${cs}:${parts[2]}`);
    case 'handoff':
      return facts.has(`handoff:${cs}`);
    case 'go_around':
      return facts.has(`go_around:${cs}`);
    case 'landed_before': {
      const a = facts.get(`phase:${cs}:ROLLOUT`);
      if (a === undefined) return false;
      const b = facts.get(`phase:${parts[2]?.toUpperCase()}:ROLLOUT`);
      return b === undefined || a <= b;
    }
    case 'handled': {
      const raw = parts[1] ?? '';
      const n = num(raw) ?? 1;
      return raw.startsWith('>=') || raw === '' ? s.aircraftHandled >= n : s.aircraftHandled === n;
    }
    case 'score': {
      const n = num(parts[1]) ?? 0;
      return s.score >= n;
    }
    case 'no_incursions':
      return s.runwayIncursions === 0;
    case 'no_unsafe':
      return s.unsafeInstructions === 0;
    case 'no_separation':
      return s.separationViolations === 0;
    case 'no_conflicts':
      return s.runwayIncursions === 0 && s.unsafeInstructions === 0 && s.separationViolations === 0;
    case 'active_runway': {
      const end = parts[1];
      return state.activeRunways.landing.includes(end) && state.activeRunways.departing.includes(end);
    }
    default:
      return false;
  }
}

export function evaluateObjectives(state: SimulationState): ObjectiveResult[] {
  return (state.scenario.objectives ?? []).map((o) => ({ id: o.id, text: o.text, completed: evaluateCheck(state, o.check) }));
}

/** Negative objectives ("no_*") hold until broken; they must not by themselves complete a scenario. */
export function isGuardCheck(check: string): boolean {
  return check === 'always' || check.startsWith('no_') || check.startsWith('score:');
}

/** Every objective is satisfied AND at least one non-guard objective exists. */
export function allObjectivesDone(state: SimulationState): boolean {
  const objs = state.scenario.objectives ?? [];
  if (!objs.length) return false;
  if (objs.every((o) => isGuardCheck(o.check))) return false;
  return objs.every((o) => evaluateCheck(state, o.check));
}
