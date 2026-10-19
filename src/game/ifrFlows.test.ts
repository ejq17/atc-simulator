/** IFR flows: traffic generator, free-play builder, objective checks and debrief advice for IFR mistakes. */
import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { createEngine } from '../sim/engine';
import { findNavFix } from '../sim/navigation';
import type { SpawnSpec, TrafficGenerator } from '../sim/traffic';
import type { Aircraft, ControllerPositionId, Scenario, SimEvent, SimulationState } from '../sim/types';
import { game } from './game';
import { arrivalJoinNm, arrivalProcedure, ifrFlightPlan, IFR_DESTINATIONS, resolveIfrFlows } from './ifr';
import { alongCross, findRunwayEnd } from '../sim/runways';
import { mToNm } from '../sim/geo';
import { evaluateCheck, isKnownCheck } from './objectives';
import { IFR_ARRIVAL_SPACING_NM, IFR_ARRIVAL_SPACING_SEC, IFR_JOIN_CLEAR_NM } from './traffic';
import { accepted, run, runUntil, say } from './testkit';
import { NM } from './world';
import { mulberry32 } from '../sim/rng';

const airport = loadKacy();

// ---------------------------------------------------------------------------------------------------------------------
// Traffic generator
// ---------------------------------------------------------------------------------------------------------------------

interface Recorded { spec: SpawnSpec; time: number; others: { pos: { x: number; y: number }; air: boolean; arrivalEnd?: string }[] }

function simulate(sc: Scenario, sec: number): Recorded[] {
  const inner = game.createTrafficGenerator(sc, airport);
  const recs: Recorded[] = [];
  const wrapped: TrafficGenerator = {
    update(state) {
      const out = inner.update(state);
      for (const spec of out) recs.push({ spec, time: state.clock.timeSec, others: Object.values(state.aircraft).map((a) => ({ pos: { ...a.pos }, air: !a.onGround, arrivalEnd: a.isDeparture ? undefined : a.assignedRunwayEnd })) });
      return out;
    },
  };
  const engine = createEngine({ airport, scenario: sc, trafficGenerator: wrapped });
  for (let i = 0; i < sec * 10; i++) engine.step();
  return recs;
}

function flowScenario(landing: string, departing = landing, over: Partial<Parameters<typeof game.buildFreePlay>[1]> = {}): Scenario {
  return game.buildFreePlay(airport, {
    seed: 17, weather: 'clear', aircraftCount: 0, difficulty: 'normal', arrivalsPerHour: 30, departuresPerHour: 24, gaFraction: 0.3, maxAircraft: 24,
    activeRunways: { departing: [departing], landing: [landing] }, ifrFlows: true, pilotRealism: 'off', ...over, // the flow tests script exact answers: clean pilots
  });
}

const EXPECTED_FIXES: Record<string, string[]> = { '13': ['CARYL', 'VCN'], '31': ['STEVV'], '22': ['KOPCE', 'PIDVE'], '4': ['JEDOB', 'WYLEA'] };

describe('IFR procedures read from the airport data', () => {
  it('ILS 13 via CARYL (feeder VCN), ILS 31 via STEVV, RNAV 22 via KOPCE, RNAV 4 via JEDOB', () => {
    const p13 = arrivalProcedure(airport, '13')!;
    expect(p13).toMatchObject({ approachType: 'ILS', ifFix: 'CARYL', feederFix: 'VCN', fafFix: 'MAYBN', route: ['VCN', 'CARYL', 'MAYBN'] });
    expect(arrivalProcedure(airport, '31')).toMatchObject({ approachType: 'ILS', ifFix: 'STEVV', fafFix: 'PRSTY', route: ['STEVV', 'PRSTY'] });
    expect(arrivalProcedure(airport, '22')).toMatchObject({ approachType: 'RNAV', ifFix: 'KOPCE', fafFix: 'EFEWY' });
    expect(arrivalProcedure(airport, '4')).toMatchObject({ approachType: 'RNAV', ifFix: 'JEDOB' });
    expect(arrivalProcedure(airport, '99')).toBeUndefined();
  });

  it('flight plans: A320 short hops cruise 10,000-23,000 ft, C172 4,000-6,000 ft, exit fixes exist in the dataset', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 60; i++) {
      const jet = ifrFlightPlan(airport, rng, 'A320');
      expect(jet.flightRules).toBe('IFR');
      expect(jet.origin).toBe('KACY');
      expect(IFR_DESTINATIONS.map((d) => d.icao)).toContain(jet.destination);
      expect(jet.cruiseAltitudeFt).toBeGreaterThanOrEqual(10000);
      expect(jet.cruiseAltitudeFt).toBeLessThanOrEqual(23000);
      for (const f of jet.route) expect(findNavFix(airport, f), f).toBeDefined();
      const c = ifrFlightPlan(airport, rng, 'C172');
      expect(c.cruiseAltitudeFt).toBeGreaterThanOrEqual(4000);
      expect(c.cruiseAltitudeFt).toBeLessThanOrEqual(6000);
    }
  });
});

describe('traffic generator IFR flows', () => {
  for (const [rwy, dep] of [['13', '13'], ['31', '31'], ['22', '13'], ['4', '13']] as const) {
    describe(`landing runway ${rwy}`, () => {
      const sc = flowScenario(rwy, dep);
      const recs = simulate(sc, 1800);
      const proc = arrivalProcedure(airport, rwy)!;
      // A jets-only run for fix selection and counts (unmanaged Cessnas circling near the final would otherwise block the fixes).
      // (2400 s: with the arrival slot at 200 s (game/traffic.ts ARRIVAL_SLOT_SEC) one runway takes at most 18 an hour, whatever the rate asked for)
      const jetRecs = simulate(flowScenario(rwy, dep, { aircraftTypes: ['A320'], gaFraction: 0, arrivalsPerHour: 45 }), 2400);
      const jetArr = [...recs, ...jetRecs].filter((r) => !r.spec.isDeparture && r.spec.type === 'A320');
      const jetOnly = jetRecs.filter((r) => !r.spec.isDeparture);

      it('lists the IFR positions and spawns airline arrivals over the procedure fix on Approach at 3,000-5,000 ft', () => {
        expect(sc.controllerPositions).toEqual(expect.arrayContaining(['CLNC', 'APP', 'DEP', 'TWR', 'GND']));
        expect(jetOnly.length).toBeGreaterThanOrEqual(4);
        for (const r of jetArr) {
          const st = r.spec.start;
          expect(st.kind).toBe('at_fix');
          if (st.kind !== 'at_fix') continue;
          expect(EXPECTED_FIXES[rwy], `${r.spec.callsign} at ${st.fix}`).toContain(st.fix);
          expect(st.runwayEnd).toBe(rwy);
          expect(st.route[0]).toBe(st.fix);
          expect(st.route[st.route.length - 1]).toBe(proc.route[proc.route.length - 1]);
          expect(st.altitudeFt).toBeGreaterThanOrEqual(3000);
          expect(st.altitudeFt).toBeLessThanOrEqual(5000);
          expect(r.spec.flightRules).toBe('IFR');
          expect(r.spec.initialFrequencyId).toBe('APP');
          expect(r.spec.initialRequest).toBe('APPROACH');
        }
        // The initial fix itself is used (not only feeders).
        expect(jetOnly.some((r) => r.spec.start.kind === 'at_fix' && r.spec.start.fix === proc.ifFix)).toBe(true);
      });

      it('keeps IFR arrivals on the same procedure at least 90 s and 5 nm apart, and 5 nm clear of every airborne aircraft', () => {
        for (const list of [recs.filter((r) => !r.spec.isDeparture && r.spec.type === 'A320'), jetOnly]) {
          for (let i = 1; i < list.length; i++) expect(list[i].time - list[i - 1].time).toBeGreaterThanOrEqual(IFR_ARRIVAL_SPACING_SEC);
        }
        for (const r of jetArr) {
          const st = r.spec.start;
          if (st.kind !== 'at_fix') continue;
          const p = findNavFix(airport, st.fix)!.pos;
          for (const o of r.others.filter((x) => x.air)) expect(Math.hypot(o.pos.x - p.x, o.pos.y - p.y) / NM, `${r.spec.callsign} at ${st.fix}`).toBeGreaterThanOrEqual(IFR_ARRIVAL_SPACING_NM);
        }
      });

      it("never starts an aircraft within 3.5 nm of the point where the engine measures its in-trail gap (no false 'unsafe approach clearance')", () => {
        const g = findRunwayEnd(airport, rwy)!;
        for (const r of jetArr) {
          const st = r.spec.start;
          if (st.kind !== 'at_fix') continue;
          const join = arrivalJoinNm(proc, st.fix === proc.feederFix);
          for (const o of r.others.filter((x) => x.air && x.arrivalEnd === rwy)) {
            expect(Math.abs(join - mToNm(-alongCross(g, o.pos).along)), `${r.spec.callsign} at ${st.fix}`).toBeGreaterThanOrEqual(IFR_JOIN_CLEAR_NM);
          }
        }
      });

      it('keeps Cessnas VFR: arrivals on final calling Tower, departures without a flight plan', () => {
        const ga = recs.filter((r) => r.spec.type === 'C172');
        expect(ga.length).toBeGreaterThan(2);
        for (const r of ga) {
          expect(r.spec.flightRules).toBe('VFR');
          expect(r.spec.flightPlan).toBeUndefined();
          if (!r.spec.isDeparture) expect(r.spec.start.kind).toBe('airborne');
          expect(r.spec.initialFrequencyId).toBe(r.spec.isDeparture ? 'GND' : 'TWR');
        }
      });

      it('airline departures are parked IFR departures with a flight plan that start on Clearance Delivery', () => {
        const deps = recs.filter((r) => r.spec.isDeparture && r.spec.type === 'A320');
        if (dep === '13') {
          expect(deps.length).toBeGreaterThanOrEqual(3);
          for (const r of deps) {
            expect(r.spec.start.kind).toBe('parked');
            expect(r.spec.initialFrequencyId).toBe('CLNC');
            expect(r.spec.initialRequest).toBe('IFR_CLEARANCE');
            const fp = r.spec.flightPlan!;
            expect(fp.flightRules).toBe('IFR');
            expect(fp.origin).toBe('KACY');
            expect(IFR_DESTINATIONS.map((d) => d.icao)).toContain(fp.destination);
            expect(fp.cruiseAltitudeFt).toBeGreaterThanOrEqual(10000);
            expect(fp.cruiseAltitudeFt).toBeLessThanOrEqual(23000);
          }
        }
      });

      it('is deterministic', () => {
        expect(simulate(flowScenario(rwy, dep), 1800).map((r) => r.spec)).toEqual(recs.map((r) => r.spec));
        expect(simulate(flowScenario(rwy, dep, { aircraftTypes: ['A320'], gaFraction: 0, arrivalsPerHour: 45 }), 2400).map((r) => r.spec)).toEqual(jetRecs.map((r) => r.spec));
      });
    });
  }

  it('Tower-only sessions keep the classic traffic: arrivals on final, no flight plans, Ground for departures', () => {
    for (const positions of [['TWR'], ['TWR', 'GND']] as ControllerPositionId[][]) {
      const sc = { ...game.buildFreePlay(airport, { seed: 17, weather: 'clear', aircraftCount: 0, arrivalsPerHour: 30, departuresPerHour: 24, maxAircraft: 24 }), controllerPositions: positions } as Scenario;
      expect(resolveIfrFlows(sc as never)).toEqual({ arrivals: false, departures: false });
      const recs = simulate(sc, 900);
      expect(recs.some((r) => !r.spec.isDeparture && r.spec.type === 'A320')).toBe(true);
      for (const r of recs) {
        expect(r.spec.start.kind === 'at_fix').toBe(false);
        expect(r.spec.flightPlan).toBeUndefined();
        expect(r.spec.initialFrequencyId).toBe(r.spec.isDeparture ? (positions.includes('GND') ? 'GND' : 'TWR') : 'TWR');
        expect(r.spec.initialRequest).toBe(r.spec.isDeparture ? 'TAXI' : 'LANDING');
      }
    }
  });

  it('without the option the controller positions decide: APP -> IFR arrivals, CLNC -> IFR departures, independently', () => {
    const base = game.buildFreePlay(airport, { seed: 19, weather: 'clear', aircraftCount: 0, arrivalsPerHour: 30, departuresPerHour: 30, gaFraction: 0.2, maxAircraft: 24, activeRunways: { departing: ['13'], landing: ['13'] } });
    expect(base.controllerPositions).toEqual(['TWR', 'GND']);
    const appOnly = simulate({ ...base, controllerPositions: ['APP', 'DEP', 'TWR'] } as Scenario, 900);
    expect(appOnly.filter((r) => !r.spec.isDeparture && r.spec.type === 'A320').every((r) => r.spec.start.kind === 'at_fix')).toBe(true);
    expect(appOnly.filter((r) => r.spec.isDeparture).every((r) => !r.spec.flightPlan)).toBe(true);
    const clncOnly = simulate({ ...base, controllerPositions: ['CLNC', 'GND', 'TWR', 'DEP'] } as Scenario, 900);
    expect(clncOnly.filter((r) => !r.spec.isDeparture).every((r) => r.spec.start.kind === 'airborne')).toBe(true);
    expect(clncOnly.filter((r) => r.spec.isDeparture && r.spec.type === 'A320').every((r) => r.spec.flightPlan?.flightRules === 'IFR' && r.spec.initialFrequencyId === 'CLNC')).toBe(true);
  });

  it('ifrFlows: false overrides positions that include APP and CLNC', () => {
    const sc = game.buildFreePlay(airport, { seed: 19, weather: 'clear', aircraftCount: 0, arrivalsPerHour: 30, departuresPerHour: 30, maxAircraft: 24, ifrFlows: false });
    const forced = { ...sc, controllerPositions: ['TWR', 'GND', 'CLNC', 'APP', 'DEP'] } as Scenario;
    expect(resolveIfrFlows(forced as never)).toEqual({ arrivals: false, departures: false });
    for (const r of simulate(forced, 900)) {
      expect(r.spec.start.kind).not.toBe('at_fix');
      expect(r.spec.flightPlan).toBeUndefined();
    }
  });

  it('IFR arrivals and departures from the generator can be worked: clearance, taxi request and approach clearance are accepted', () => {
    for (const rwy of ['13', '31']) {
      const base = flowScenario(rwy, rwy, { aircraftCount: 0, arrivalsPerHour: 24, departuresPerHour: 20, seed: 23, gaFraction: 0.2 });
      // scripted answers: clean pilots; raw clocks (nothing lands in this run, so the arrival slots and the airborne cap of the flow control would stop the arrivals after the first)
      const sc = { ...base, pilotRealism: 'off' as const, traffic: { ...base.traffic!, flowControl: false } };
      const e = createEngine({ airport, scenario: sc, readbackErrorRate: 0, trafficGenerator: game.createTrafficGenerator(sc, airport) });
      let gotClearance = 0;
      let gotApproach = 0;
      const answered = new Set<string>();
      for (let i = 0; i < 2400; i++) {
        run(e, 1);
        for (const a of Object.values(e.getState().aircraft) as Aircraft[]) {
          if (answered.has(a.callsign)) continue;
          if (a.pendingRequest?.kind === 'IFR_CLEARANCE') {
            const r = say(e, `${a.spokenCallsign}, cleared to ${a.flightPlan!.destination.slice(1)} airport, maintain two thousand`, 'CLNC');
            if (accepted(r)) {
              answered.add(a.callsign);
              gotClearance++;
            }
          } else if (a.pendingRequest?.kind === 'APPROACH' && !a.isDeparture) {
            // Cleared at check-in, as a busy controller would: the generator must never make that an unsafe clearance.
            const r = say(e, `${a.spokenCallsign}, cleared ${rwy === '13' ? 'I-L-S' : 'I-L-S'} runway ${rwy === '13' ? 'one three' : 'three one'} approach`, 'APP');
            if (accepted(r)) {
              answered.add(a.callsign);
              gotApproach++;
            }
          }
        }
      }
      expect(gotApproach, `runway ${rwy}`).toBeGreaterThanOrEqual(2);
      expect(gotClearance, `runway ${rwy}`).toBeGreaterThanOrEqual(2);
      const unsafeApproach = e.getState().events.filter((x) => x.kind === 'CONFLICT' && x.data?.alertKind === 'UNSAFE_CLEARANCE' && /Approach clearance/.test(x.text));
      expect(unsafeApproach.map((x) => `${x.timeSec} ${x.text}`), `runway ${rwy}`).toEqual([]);
      expect(e.getState().events.some((x) => x.kind === 'COMMAND_ACCEPTED' && x.data?.commError && x.data?.kind === 'APPROACH')).toBe(false);
    }
  });
});

describe('free play with ifrFlows', () => {
  it('lists the IFR positions and builds an IFR initial population that runs 120 s without conflicts', () => {
    for (const [seed, rwy] of [[1, '13'], [2, '31'], [3, '13'], [4, '31'], [5, '22'], [6, '4']] as const) {
      const sc = game.buildFreePlay(airport, {
        seed, weather: 'clear', ifrFlows: true, startingScenario: 'mixed', aircraftCount: 8, gaFraction: 0.4, maxAircraft: 20,
        activeRunways: { departing: [rwy === '22' || rwy === '4' ? '13' : rwy], landing: [rwy] },
      });
      expect(sc.controllerPositions).toEqual(['TWR', 'GND', 'CLNC', 'APP', 'DEP']);
      const arrivals = sc.spawns.filter((s) => !s.isDeparture);
      const jets = arrivals.filter((s) => s.type === 'A320');
      expect(jets.length, `seed ${seed}`).toBeGreaterThan(0);
      jets.forEach((s, k) => {
        expect(s.start.kind).toBe('at_fix');
        expect(s.initialFrequencyId).toBe('APP');
        expect(s.atSec).toBe(k * 270);
        if (s.start.kind === 'at_fix') expect(EXPECTED_FIXES[rwy]).toContain(s.start.fix);
      });
      for (const s of sc.spawns.filter((x) => x.isDeparture && x.type === 'A320')) {
        expect(s.initialFrequencyId).toBe('CLNC');
        expect(s.flightPlan?.flightRules).toBe('IFR');
      }
      for (const s of sc.spawns.filter((x) => x.type === 'C172')) {
        expect(s.flightPlan).toBeUndefined();
        expect(s.flightRules).toBe('VFR');
        expect(s.isDeparture).toBe(true); // Cessna arrivals wait for the generator when jets arrive at fixes
      }
      const e = createEngine({ airport, scenario: sc, trafficGenerator: game.createTrafficGenerator(sc, airport) });
      for (let i = 0; i < 1200; i++) e.step();
      const bad = e.getState().events.filter((x) => ['CONFLICT', 'RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(x.kind));
      expect(bad.map((x) => x.text), `seed ${seed} runway ${rwy}`).toEqual([]);
    }
  });

  it('is deterministic, and a Tower/Ground free play is unchanged by the new option', () => {
    const a = game.buildFreePlay(airport, { seed: 9, ifrFlows: true });
    const b = game.buildFreePlay(airport, { seed: 9, ifrFlows: true });
    expect(a).toEqual(b);
    const classic = game.buildFreePlay(airport, { seed: 9 });
    expect(classic.controllerPositions).toEqual(['TWR', 'GND']);
    expect(classic.spawns.every((s) => s.start.kind !== 'at_fix' && !s.flightPlan)).toBe(true);
    expect(JSON.parse(JSON.stringify(a)).spawns.length).toBe(a.spawns.length);
  });
});

describe('career steps 7, 9 and 11 include an IFR departure', () => {
  for (const id of ['career-07-arrivals-departures', 'career-09-mixed-performance', 'career-11-complex']) {
    it(id, () => {
      const sc = game.buildScenario(id, airport);
      expect(sc.controllerPositions).toEqual(expect.arrayContaining(['CLNC', 'GND', 'TWR', 'DEP']));
      const ifrDeps = sc.spawns.filter((s) => s.isDeparture && s.flightPlan?.flightRules === 'IFR');
      expect(ifrDeps.length).toBeGreaterThanOrEqual(1);
      for (const s of ifrDeps) {
        expect(s.initialFrequencyId).toBe('CLNC');
        expect(s.start.kind).toBe('parked');
        expect(s.flightPlan!.cruiseAltitudeFt).toBeGreaterThanOrEqual(10000);
        expect(s.flightPlan!.cruiseAltitudeFt).toBeLessThanOrEqual(23000);
      }
      if (id !== 'career-11-complex') {
        const checks = sc.objectives!.map((o) => o.check);
        expect(checks).toContain(`ifr_clearance:${ifrDeps[0].callsign}`);
        expect(checks).toContain(`handled:${ifrDeps[0].callsign}`);
      }
    });
  }

  it('career 11 keeps arrivals on final for Tower and generates IFR departures', () => {
    const sc = game.buildScenario('career-11-complex', airport);
    const recs = simulate(sc, 900);
    expect(recs.filter((r) => !r.spec.isDeparture).every((r) => r.spec.start.kind === 'airborne')).toBe(true);
    const jetDeps = recs.filter((r) => r.spec.isDeparture && r.spec.type === 'A320');
    expect(jetDeps.length).toBeGreaterThan(0);
    expect(jetDeps.every((r) => r.spec.initialFrequencyId === 'CLNC' && r.spec.flightPlan)).toBe(true);
  });

  it('career 7: NKS329 goes through Clearance Delivery, Ground, Tower and Departure and is handled', () => {
    const sc = game.buildScenario('career-07-arrivals-departures', airport);
    // Isolate the IFR departure: the other aircraft are not needed for the flow.
    const only = { ...sc, pilotRealism: 'off', spawns: sc.spawns.filter((s) => s.callsign === 'NKS329').map((s) => ({ ...s, atSec: 0 })), traffic: undefined } as Scenario; // scripted calls: clean pilots
    const e = createEngine({ airport, scenario: only, readbackErrorRate: 0 });
    const ac = () => Object.values(e.getState().aircraft)[0];
    expect(runUntil(e, () => ac().pendingRequest?.kind === 'IFR_CLEARANCE', 30)).toBe(true);
    expect(evaluateCheck(e.getState(), 'ifr_request:NKS329')).toBe(true);
    expect(accepted(say(e, 'Spirit three twenty nine, cleared to Philadelphia airport via the Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand one zero minutes after departure, departure frequency one two four point six, squawk four two one five', 'CLNC'))).toBe(true);
    expect(evaluateCheck(e.getState(), 'ifr_clearance:NKS329')).toBe(true);
    expect(ac().squawk).toBe('4215');
    expect(runUntil(e, () => ac().pendingRequest?.kind === 'PUSHBACK', 60)).toBe(true);
    expect(ac().frequencyId).toBe('GND');
    expect(accepted(say(e, 'Spirit three twenty nine, pushback approved, tail east', 'GND'))).toBe(true);
    expect(runUntil(e, () => ac().pendingRequest?.kind === 'TAXI', 300)).toBe(true);
    expect(accepted(say(e, 'Spirit three twenty nine, taxi to runway one three via bravo, hold short of runway four', 'GND'))).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'crossing_request:NKS329'), 900)).toBe(true);
    expect(accepted(say(e, 'Spirit three twenty nine, cross runway four at bravo', 'GND'))).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'holding_short:NKS329'), 900)).toBe(true);
    expect(accepted(say(e, 'Spirit three twenty nine, contact tower one two zero point three', 'GND'))).toBe(true);
    run(e, 8);
    expect(accepted(say(e, 'Spirit three twenty nine, runway one three, cleared for takeoff', 'TWR'))).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'takeoff:NKS329'), 300)).toBe(true);
    expect(evaluateCheck(e.getState(), 'departed_ifr:NKS329')).toBe(false);
    expect(runUntil(e, () => ac().phase === 'DEPARTURE', 300)).toBe(true);
    expect(accepted(say(e, 'Spirit three twenty nine, contact departure one two four point six', 'TWR'))).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'departed_ifr:NKS329'), 30)).toBe(true);
    expect(runUntil(e, () => ac().pendingRequest?.kind === 'OTHER' && ac().frequencyId !== 'TWR', 30)).toBe(true);
    expect(accepted(say(e, 'Spirit three twenty nine, radar contact, climb and maintain one zero thousand, proceed direct Coyle', 'DEP'))).toBe(true);
    expect(runUntil(e, (s) => evaluateCheck(s, 'handled:NKS329'), 2400)).toBe(true);
    const st = e.getState();
    expect(st.score.runwayIncursions + st.score.unsafeInstructions + st.score.separationViolations).toBe(0);
    const report = game.buildDebrief(st);
    expect(report.improvements.join(' ')).not.toMatch(/Departure|IFR clearance/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Objective checks from fabricated event logs
// ---------------------------------------------------------------------------------------------------------------------

let evId = 0;
const ev = (timeSec: number, kind: SimEvent['kind'], callsign: string, data: Record<string, unknown> = {}, extra: Partial<SimEvent> = {}): SimEvent =>
  ({ id: `e${++evId}`, timeSec, kind, callsign, text: '', severity: 'info', data, ...extra }) as SimEvent;
const fakeState = (events: SimEvent[]): SimulationState =>
  ({ events, aircraft: {}, airport, score: { aircraftHandled: 0, runwayIncursions: 0, unsafeInstructions: 0, separationViolations: 0 }, activeRunways: { departing: [], landing: [] } }) as unknown as SimulationState;

describe('IFR objective checks', () => {
  it('knows the new check names', () => {
    for (const c of ['approach:X', 'ifr_clearance:X', 'established:X', 'departed_ifr:X', 'ifr_request:X', 'handled:X']) expect(isKnownCheck(c)).toBe(true);
  });

  it('approach: an accepted approach clearance without an improper flag; a flagged or unsafe one does not count', () => {
    const ok = fakeState([ev(10, 'COMMAND_ACCEPTED', 'NKS1', { kind: 'APPROACH', unsafe: false, scored: true })]);
    expect(evaluateCheck(ok, 'approach:NKS1')).toBe(true);
    expect(evaluateCheck(ok, 'approach:NKS2')).toBe(false);
    const flagged = fakeState([ev(10, 'COMMAND_ACCEPTED', 'NKS1', { kind: 'APPROACH', unsafe: false, commError: true })]);
    expect(evaluateCheck(flagged, 'approach:NKS1')).toBe(false);
    const unsafe = fakeState([ev(10, 'COMMAND_ACCEPTED', 'NKS1', { kind: 'APPROACH', unsafe: true })]);
    expect(evaluateCheck(unsafe, 'approach:NKS1')).toBe(false);
    const redo = fakeState([ev(10, 'COMMAND_ACCEPTED', 'NKS1', { kind: 'APPROACH', commError: true }), ev(40, 'COMMAND_ACCEPTED', 'NKS1', { kind: 'APPROACH' })]);
    expect(evaluateCheck(redo, 'approach:NKS1')).toBe(true);
  });

  it('ifr_request / ifr_clearance / established', () => {
    const s = fakeState([
      ev(5, 'TRANSMISSION', 'NKS1', { request: 'IFR_CLEARANCE' }, { speaker: 'PILOT', text: 'Atlantic City Clearance Delivery, Spirit one, IFR to Philadelphia, ready to copy.' }),
      ev(9, 'COMMAND_ACCEPTED', 'NKS1', { kind: 'IFR_CLEARANCE' }),
      ev(50, 'TRANSMISSION', 'NKS2', { request: 'FREQUENCY_CHANGE' }, { speaker: 'PILOT', text: 'Atlantic City Approach, Spirit two, established on the ILS runway one three.' }),
      ev(60, 'TRANSMISSION', 'NKS3', { request: 'FREQUENCY_CHANGE' }, { speaker: 'PILOT', text: 'Atlantic City Tower, Spirit three, clear of runway one three.' }),
    ]);
    expect(evaluateCheck(s, 'ifr_request:NKS1')).toBe(true);
    expect(evaluateCheck(s, 'ifr_clearance:NKS1')).toBe(true);
    expect(evaluateCheck(s, 'ifr_clearance:NKS2')).toBe(false);
    expect(evaluateCheck(s, 'established:NKS2')).toBe(true);
    expect(evaluateCheck(s, 'established:NKS3')).toBe(false);
    const viaPhase = fakeState([ev(5, 'COMMAND_ACCEPTED', 'NKS4', { kind: 'APPROACH' }), ev(30, 'PHASE_CHANGE', 'NKS4', { to: 'FINAL' })]);
    expect(evaluateCheck(viaPhase, 'established:NKS4')).toBe(true);
    expect(evaluateCheck(fakeState([ev(30, 'PHASE_CHANGE', 'NKS5', { to: 'FINAL' })]), 'established:NKS5')).toBe(false);
  });

  it('departed_ifr needs the clearance, the takeoff and a handoff to Departure after it', () => {
    const dep = (mhz: number) => ev(120, 'HANDOFF', 'NKS1', { frequencyId: 'DEP' }, { frequencyMhz: mhz });
    const base = [ev(10, 'COMMAND_ACCEPTED', 'NKS1', { kind: 'IFR_CLEARANCE' }), ev(90, 'PHASE_CHANGE', 'NKS1', { to: 'INITIAL_CLIMB' })];
    expect(evaluateCheck(fakeState([...base, dep(124.6)]), 'departed_ifr:NKS1')).toBe(true);
    expect(evaluateCheck(fakeState([...base]), 'departed_ifr:NKS1')).toBe(false);
    expect(evaluateCheck(fakeState([...base, dep(121.9)]), 'departed_ifr:NKS1')).toBe(false); // Ground is not Departure
    expect(evaluateCheck(fakeState([base[1], dep(124.6)]), 'departed_ifr:NKS1')).toBe(false); // no clearance
    expect(evaluateCheck(fakeState([base[0], ev(50, 'HANDOFF', 'NKS1', {}, { frequencyMhz: 124.6 }), base[1]]), 'departed_ifr:NKS1')).toBe(false); // handoff before takeoff
  });

  it('handled:CS is per aircraft, handled:>=N still counts', () => {
    const s = { ...fakeState([ev(300, 'DESPAWN', 'NKS1', { handled: true }), ev(310, 'DESPAWN', 'NKS2', { handled: false })]), score: { aircraftHandled: 1 } } as unknown as SimulationState;
    expect(evaluateCheck(s, 'handled:NKS1')).toBe(true);
    expect(evaluateCheck(s, 'handled:NKS2')).toBe(false);
    expect(evaluateCheck(s, 'handled:>=1')).toBe(true);
    expect(evaluateCheck(s, 'handled:1')).toBe(true);
    expect(evaluateCheck(s, 'handled:>=2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Debrief advice for IFR mistakes, produced by the real engine
// ---------------------------------------------------------------------------------------------------------------------

function mini(spawns: Scenario['spawns'], over: Partial<Scenario> = {}) {
  const base = game.buildScenario('career-08-ifr', airport);
  const sc = { ...base, id: 'ifr-mini', mode: 'career', spawns, objectives: [], traffic: undefined, weather: base.weather, controllerPositions: ['TWR', 'GND', 'CLNC', 'APP', 'DEP'], pilotRealism: 'off', ...over } as Scenario;
  return createEngine({ airport, scenario: sc, readbackErrorRate: 0 });
}
const vcn = (callsign: string, atSec = 0): Scenario['spawns'][number] => ({
  atSec, callsign, type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP',
  start: { kind: 'at_fix', fix: 'VCN', altitudeFt: 4000, speedKt: 180, route: ['VCN'], runwayEnd: '13' },
});

describe('debrief: IFR mistakes', () => {
  it('approach clearance with a steep intercept (angle) is accepted but flagged, and the debrief says why', () => {
    const e = mini([vcn('NKS500')]);
    run(e, 5);
    expect(accepted(say(e, 'Spirit five hundred, turn right heading two zero zero', 'APP'))).toBe(true);
    // Heading 200 magnetic is far from the course: not converging, flagged.
    const r = say(e, 'Spirit five hundred, cleared I-L-S runway one three approach', 'APP');
    expect(r.outcomes[0].status).toBe('accepted');
    const text = game.buildDebrief(e.getState()).improvements.join(' ');
    expect(text).toMatch(/approach clearance/);
    expect(text).toMatch(/NKS500/);
    expect(evaluateCheck(e.getState(), 'approach:NKS500')).toBe(false);
    run(e, 1);
    expect(e.getState().score.communicationErrors).toBeGreaterThan(0);
  });

  it('approach clearance with an intercept angle above 30 degrees: the angle advice cites 5-9-2', () => {
    const e = mini([vcn('NKS501')]);
    run(e, 5);
    // The course is 128 magnetic; the aircraft is right of it. Turn left to 060: 68 degrees to the course.
    expect(accepted(say(e, 'Spirit five zero one, turn left heading zero six zero', 'APP'))).toBe(true);
    const r = say(e, 'Spirit five zero one, cleared I-L-S runway one three approach', 'APP');
    expect(r.outcomes[0].status).toBe('accepted');
    const text = game.buildDebrief(e.getState()).improvements.join(' ');
    expect(text).toMatch(/intercept angle/);
    expect(text).toContain('5-9-2');
  });

  it('approach clearance inside the final approach fix: the FAF advice cites 5-9-4', () => {
    const sc = game.buildScenario('career-03-single-landing', airport);
    const spawn = { ...sc.spawns[0], atSec: 0 };
    spawn.start = { ...(spawn.start as { kind: 'airborne' }), distanceNm: 3 } as never;
    spawn.initialFrequencyId = 'APP';
    const e = mini([spawn]);
    run(e, 3);
    expect(accepted(say(e, 'Spirit four fifty one, turn right heading one two eight', 'APP'))).toBe(true); // on vectors, 3 nm out: inside the FAF
    const r = say(e, 'Spirit four fifty one, cleared I-L-S runway one three approach', 'APP');
    expect(r.outcomes[0].status).toBe('accepted');
    const text = game.buildDebrief(e.getState()).improvements.join(' ');
    expect(text).toMatch(/final approach fix/);
    expect(text).toContain('5-9-4');
  });

  it('the same mistakes are refused in training mode and still reach the debrief', () => {
    const e = mini([vcn('NKS502')], { mode: 'training' });
    run(e, 5);
    say(e, 'Spirit five zero two, turn left heading zero six zero', 'APP');
    const r = say(e, 'Spirit five zero two, cleared I-L-S runway one three approach', 'APP');
    expect(r.outcomes[0].status).toBe('rejected');
    expect(game.buildDebrief(e.getState()).improvements.join(' ')).toMatch(/intercept angle|final approach course/);
  });

  it('takeoff without an IFR clearance is flagged in the debrief (and costs a communication error)', () => {
    const sc = game.buildScenario('career-01-first-radio', airport);
    const spawn = { ...sc.spawns[0], callsign: 'NKS600', type: 'A320', flightRules: 'IFR', flightPlan: { flightRules: 'IFR', origin: 'KACY', destination: 'KPHL', cruiseAltitudeFt: 10000, route: ['CYN'] } } as Scenario['spawns'][number];
    // The Cessna's full-length hold on 13 also serves the A320.
    const e = mini([spawn]);
    run(e, 8);
    const r = say(e, 'Spirit six hundred, runway one three, cleared for takeoff', 'TWR');
    expect(r.outcomes[0].status).toBe('accepted');
    run(e, 1);
    const report = game.buildDebrief(e.getState());
    expect(report.improvements.join(' ')).toMatch(/NKS600.*no IFR clearance/s);
    expect(report.improvements.join(' ')).toContain('4-3-2');
    expect(e.getState().score.communicationErrors).toBeGreaterThan(0);
  });

  it('an IFR departure not handed to Departure within 2 minutes of takeoff is flagged; handing it off in time is not', () => {
    const run2 = (handoffAfterSec: number | undefined, runSec: number) => {
      const sc = game.buildScenario('career-07-arrivals-departures', airport);
      const spawn = { ...sc.spawns.find((s) => s.callsign === 'NKS329')!, atSec: 0, start: undefined as never };
      // Start it on the runway 13 full-length hold, IFR with a clearance given: use the Cessna's hold node.
      const hold = game.buildScenario('career-01-first-radio', airport).spawns[0].start;
      const e = mini([{ ...spawn, start: hold, initialFrequencyId: 'TWR', initialRequest: 'DEPARTURE' }]);
      run(e, 1);
      // Give it a clearance through the engine's own path is impossible while holding short: it takes off flagged, which also marks it IFR.
      run(e, 8);
      say(e, 'Spirit three twenty nine, runway one three, cleared for takeoff', 'TWR');
      expect(runUntil(e, (s) => evaluateCheck(s, 'takeoff:NKS329'), 120)).toBe(true);
      const tUp = e.getState().clock.timeSec;
      if (handoffAfterSec !== undefined) {
        run(e, handoffAfterSec);
        expect(accepted(say(e, 'Spirit three twenty nine, contact departure one two four point six', 'TWR'))).toBe(true);
      }
      run(e, runSec);
      return { text: game.buildDebrief(e.getState()).improvements.join(' '), tUp };
    };
    const late = run2(undefined, 140);
    expect(late.text).toMatch(/NKS329 was airborne for more than 2 minutes before being handed to Departure/);
    const slow = run2(125, 20);
    expect(slow.text).toMatch(/more than 2 minutes before being handed to Departure/);
    const prompt = run2(40, 140);
    expect(prompt.text).not.toMatch(/handed to Departure/);
  });
});
