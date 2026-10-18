/**
 * Tuning values for the simulated pilots' behaviour in the Tower vocabulary features. ALL VALUES ARE DESIGN VALUES, not FAA figures
 * (the FAA text says when each situation arises, not how often or how well a pilot sees traffic). Set `Scenario.pilotBehaviour` (partial) to
 * override them, e.g. to scale difficulty; the defaults are the values the features were built and tested with.
 */
export interface PilotBehaviour {
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
  noAtisFraction: 0.4,
  numbersRequestAfterSec: 20,
  followMarginSec: 10,
  look: {
    maxRangeSm: 10, pAhead: 0.95, pSide: 0.6, pBehind: 0.2, aheadDeg: 60, sideDeg: 110,
    altDiffFt: 3000, altFactor: 0.5, farShare: 0.6, farFactor: 0.7, immediateShare: 0.6, acquireMinSec: 6, acquireSpreadSec: 10,
  },
};

export type PilotBehaviourOverride = Partial<Omit<PilotBehaviour, 'look'>> & { look?: Partial<PilotBehaviour['look']> };

export function resolvePilotBehaviour(o?: PilotBehaviourOverride): PilotBehaviour {
  return { ...DEFAULT_PILOT_BEHAVIOUR, ...o, look: { ...DEFAULT_PILOT_BEHAVIOUR.look, ...o?.look } };
}
