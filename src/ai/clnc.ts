/**
 * Clearance Delivery: answers a pending IFR_CLEARANCE request with a complete IFR clearance
 * (destination, departure procedure, initial altitude, expect-altitude, departure frequency by sector, squawk).
 */
import type { Aircraft, ParsedCommand } from '../sim/types';
import { departureFrequencyFor, departureProcedureName, DEFAULT_INITIAL_ALTITUDE_FT, isAssignableSquawk, squawksInUse } from '../sim/ifr';
import { mkCmd } from './core';
import type { Agent, AgentView, Plan } from './core';
import * as say from './phrase';

/** Squawk codes handed out by the AI so far this session (so two clearances in the same second never collide). */
export function nextSquawk(v: AgentView, rand: () => number, reserved: Set<string>): string {
  const used = squawksInUse(v.state);
  for (let i = 0; i < 400; i++) {
    const code = `${Math.floor(rand() * 8)}${Math.floor(rand() * 8)}${Math.floor(rand() * 8)}${Math.floor(rand() * 8)}`;
    if (isAssignableSquawk(code) && !used.has(code) && !reserved.has(code)) return code;
  }
  for (let n = 0o2000; n < 0o7000; n++) {
    const code = n.toString(8).padStart(4, '0');
    if (isAssignableSquawk(code) && !used.has(code) && !reserved.has(code)) return code;
  }
  return '2000';
}

export interface ClearanceStore {
  rand: () => number;
  /** Codes the AI handed out (so two clearances in the same second never collide). */
  reserved: Set<string>;
  /** aircraft id -> code chosen while the clearance is pending (stable across re-evaluations). */
  memo: Map<string, string>;
}

export function ifrClearancePlan(v: AgentView, ac: Aircraft, store: ClearanceStore): Plan | undefined {
  const fp = ac.flightPlan;
  if (!fp || fp.flightRules !== 'IFR' || fp.ifrClearance) return undefined;
  const airport = v.airport;
  const dep = departureFrequencyFor(airport, fp.route);
  if (!dep) return undefined;
  // The squawk is drawn from the AI's own stream; the same aircraft keeps the same code across re-evaluations.
  let squawk = store.memo.get(ac.id);
  if (!squawk || squawksInUse(v.state, ac.id).has(squawk)) {
    squawk = nextSquawk(v, store.rand, store.reserved);
    store.memo.set(ac.id, squawk);
    store.reserved.add(squawk);
  }
  const ifr: NonNullable<ParsedCommand['ifr']> = {
    destination: fp.destination,
    departureProcedure: departureProcedureName(airport),
    initialAltitudeFt: DEFAULT_INITIAL_ALTITUDE_FT,
    expectAltitudeFt: fp.cruiseAltitudeFt,
    departureFrequencyMhz: dep.mhz,
    squawk,
  };
  const phrase = say.ifrClearance(
    ac, v.facility(ac),
    { destination: ifr.destination!, departureProcedure: ifr.departureProcedure, initialAltitudeFt: ifr.initialAltitudeFt!, expectAltitudeFt: ifr.expectAltitudeFt, departureFrequencyMhz: ifr.departureFrequencyMhz!, squawk },
    airport,
  );
  return {
    key: `${ac.id}:ifr`, aircraftId: ac.id, callsign: ac.callsign, priority: 50, once: true,
    cmds: [mkCmd('IFR_CLEARANCE', ac, { ifr })],
    phrase,
    summary: `${ac.callsign} IFR clearance to ${fp.destination}, squawk ${squawk}`,
  };
}

export function createClearanceAgent(store: ClearanceStore): Agent {
  return (v) => {
    const plans: Plan[] = [];
    for (const ac of v.onFrequency) {
      if (ac.pendingRequest?.kind !== 'IFR_CLEARANCE' || !ac.onGround || ac.radioState === 'TRANSMITTING') continue;
      const p = ifrClearancePlan(v, ac, store);
      if (p) plans.push(p);
    }
    return plans;
  };
}
