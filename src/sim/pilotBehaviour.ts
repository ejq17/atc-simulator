import { seeded01 } from './rng';

/**
 * Tuning values for the simulated pilots' behaviour in the Tower vocabulary features. ALL VALUES ARE DESIGN VALUES, not FAA figures
 * (the FAA text says when each situation arises, not how often or how well a pilot sees traffic). Set `Scenario.pilotBehaviour` (partial) to
 * override them, e.g. to scale difficulty; the defaults are the values the features were built and tested with.
 */
export interface GroundBehaviour {
  /** Airliners and cargo jets on airline / cargo stands push back and ask for it before they call ready to taxi. false = they taxi from the stand (the pre-pushback behaviour, kept for fixtures). */
  airlinerPushback: boolean;
  /** Speed the tug pushes an aircraft back at, m/s. DESIGN VALUE: about walking pace (1.2 m/s = 2.3 kt); no FAA or operator figure was found. */
  pushbackSpeedMps: number;
  /** Seconds between the pushback approval and the start of the push (tug connected, brakes released). DESIGN VALUE. */
  pushStartDelaySec: number;
  /** Rate the nose swings round while the tail is pushed onto the lane, deg/s. DESIGN VALUE. */
  pushSwingRateDegPerSec: number;
  /** Seconds the aircraft stands still after the push (parking brake set, tug disconnected) before its start is complete. DESIGN VALUE. */
  pushSettleSec: number;
  /** Seeded interval [min, max] s between the end of the push and the "ready to taxi" call of an airliner (engines are started during the push). DESIGN VALUE. */
  airlinerReadyAfterPushSec: [number, number];
  /** Seeded interval [min, max] s a GA pilot needs after the first call time to start the engine, run the checklist and call ready. DESIGN VALUE. */
  gaStartSec: [number, number];
  /** Seconds a pilot waits for the pushback approval before asking again. DESIGN VALUE. */
  pushbackRepeatAfterSec: number;
  /** Seconds an arrival stays visible at its stand after shutdown (the stand stays occupied). DESIGN VALUE: deplaning and the next turn are not modelled. */
  arrivedLingerSec: number;
  /** Per-aircraft cruise taxi speed = type speed x a seeded factor in [taxiSpeedMinFactor, 1]. DESIGN VALUE. */
  taxiSpeedMinFactor: number;
  /** Share of pilots (seeded per aircraft) who omit the hold-short part of a taxi readback (JO 7110.65 2-4-3). 0 in training mode unless overridden. DESIGN VALUE. */
  holdShortOmitFraction: number;
  /** Seconds a missing hold-short readback may stand before the controller is charged a communication error (JO 7110.65 2-4-3, 3-7-2). DESIGN VALUE (same window as a missed readback error). */
  holdShortReadbackGraceSec: number;
  /** Probability, as a share of the readback error rate, that the route read back names a wrong taxiway. DESIGN VALUE. */
  taxiwayErrorShare: number;
  /** Share of pilots (seeded per aircraft) unfamiliar with the airport, who request progressive taxi (AIM 4-3-18). 0 in training mode unless overridden. DESIGN VALUE. */
  unfamiliarFraction: number;
  /** Speed (kt) cap on taxilanes / apron connectors: AC 150/5300-13B Chg 1 glossary "Taxilane": "not more than 15 mph (13 kts)". */
  taxilaneMaxKt: number;
}

export interface PilotBehaviour {
  ground: GroundBehaviour;
  /** Share of light VFR pilots (seeded per aircraft) who do not report the ATIS code and need the wind / altimeter (JO 7110.65 3-9-1, 3-10-1). */
  noAtisFraction: number;
  /** Seconds a pilot waits on Tower for the answer to his request before asking for the numbers. */
  numbersRequestAfterSec: number;
  /** Seconds after the leader is clear of the runway that a pilot told to follow may cross the threshold (3-8-1, 3-10-3). */
  followMarginSec: number;
  /** Visual acquisition of described traffic (3-1-6, 7-2-1). Range is the weather visibility capped at `maxRangeSm`. */
  look: {
    maxRangeSm: number;
    /** Probability of seeing traffic within `aheadDeg` of the nose / within `sideDeg` / behind that. */
    pAhead: number;
    pSide: number;
    pBehind: number;
    aheadDeg: number;
    sideDeg: number;
    /** Altitude difference (ft) beyond which the probability is multiplied by `altFactor`. */
    altDiffFt: number;
    altFactor: number;
    /** Beyond this share of the range the probability is multiplied by `farFactor`. */
    farShare: number;
    farFactor: number;
    /** Share of the probability that is "in sight" at once; the rest is "looking" and acquired `acquireMinSec` + up to `acquireSpreadSec` later. */
    immediateShare: number;
    acquireMinSec: number;
    acquireSpreadSec: number;
  };
}

export const DEFAULT_PILOT_BEHAVIOUR: PilotBehaviour = {
  ground: {
    airlinerPushback: true, pushbackSpeedMps: 1.2, pushStartDelaySec: 8, pushSwingRateDegPerSec: 3, pushSettleSec: 4, airlinerReadyAfterPushSec: [15, 45], gaStartSec: [8, 25], pushbackRepeatAfterSec: 90,
    arrivedLingerSec: 120, taxiSpeedMinFactor: 0.85, holdShortOmitFraction: 0.08, holdShortReadbackGraceSec: 20, taxiwayErrorShare: 0.5, unfamiliarFraction: 0.1, taxilaneMaxKt: 13,
  },
  noAtisFraction: 0.4,
  numbersRequestAfterSec: 20,
  followMarginSec: 10,
  look: {
    maxRangeSm: 10, pAhead: 0.95, pSide: 0.6, pBehind: 0.2, aheadDeg: 60, sideDeg: 110,
    altDiffFt: 3000, altFactor: 0.5, farShare: 0.6, farFactor: 0.7, immediateShare: 0.6, acquireMinSec: 6, acquireSpreadSec: 10,
  },
};

/** A pilot unfamiliar with the airport (seeded per aircraft): requests progressive taxi (AIM 4-3-18) and asks "say route" when none is given. */
export function pilotUnfamiliar(ac: { seed: number }, fraction: number): boolean {
  return fraction > 0 && seeded01(ac.seed, 'unfamiliar') < fraction;
}

export type PilotBehaviourOverride = Partial<Omit<PilotBehaviour, 'look' | 'ground'>> & { look?: Partial<PilotBehaviour['look']>; ground?: Partial<GroundBehaviour> };

/**
 * Defaults with the scenario override on top. Training mode switches the pilot mistakes that no lesson teaches off (hold-short readback
 * omissions, unfamiliar pilots) unless the scenario sets them explicitly.
 */
export function resolvePilotBehaviour(o?: PilotBehaviourOverride, mode?: 'training' | 'free' | string): PilotBehaviour {
  const trainingOff: Partial<GroundBehaviour> = mode === 'training' ? { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 } : {};
  return {
    ...DEFAULT_PILOT_BEHAVIOUR, ...o,
    look: { ...DEFAULT_PILOT_BEHAVIOUR.look, ...o?.look },
    ground: { ...DEFAULT_PILOT_BEHAVIOUR.ground, ...trainingOff, ...o?.ground },
  };
}
