import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS, ARRIVAL_PHASES, DEPARTURE_PHASES, InvalidTransitionError, assertTransition, canTransition, transitionPath, tryTransition,
} from './stateMachines';

describe('state machines', () => {
  it('allows the documented departure chain', () => {
    for (let i = 0; i < DEPARTURE_PHASES.length - 1; i++) {
      expect(canTransition(DEPARTURE_PHASES[i], DEPARTURE_PHASES[i + 1])).toBe(true);
    }
  });

  it('allows the documented arrival chain', () => {
    for (let i = 0; i < ARRIVAL_PHASES.length - 1; i++) {
      expect(canTransition(ARRIVAL_PHASES[i], ARRIVAL_PHASES[i + 1])).toBe(true);
    }
  });

  it('forbids impossible transitions (no invented clearances)', () => {
    expect(canTransition('HOLDING_SHORT', 'TAKEOFF_ROLL')).toBe(false);
    expect(canTransition('PARKED', 'TAKEOFF_ROLL')).toBe(false);
    expect(canTransition('FINAL', 'ROLLOUT')).toBe(false);
    expect(canTransition('TAKEOFF_ROLL', 'HOLDING_SHORT')).toBe(false);
    expect(canTransition('ARRIVED', 'TAXIING')).toBe(false);
    expect(() => assertTransition('HOLDING_SHORT', 'TAKEOFF_ROLL')).toThrow(InvalidTransitionError);
    expect(tryTransition('INBOUND', 'ROLLOUT')).toEqual({ ok: false, error: 'Impossible phase transition INBOUND -> ROLLOUT' });
    expect(tryTransition('FINAL', 'LANDING')).toEqual({ ok: true });
  });

  it('supports go-around branches and path finding', () => {
    expect(canTransition('FINAL', 'GO_AROUND')).toBe(true);
    expect(canTransition('GO_AROUND', 'APPROACH')).toBe(true);
    expect(transitionPath('PARKED', 'TAXIING')).toEqual(['READY', 'TAXIING']);
    expect(transitionPath('ARRIVED', 'PARKED')).toBeNull();
  });

  it('defines an entry for every phase', () => {
    for (const p of [...DEPARTURE_PHASES, ...ARRIVAL_PHASES, 'GO_AROUND', 'PATTERN', 'HOLDING'] as const) {
      expect(ALLOWED_TRANSITIONS[p]).toBeDefined();
    }
  });
});
