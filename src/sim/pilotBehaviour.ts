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
  /** Pilot realism: readback errors, response timing, radio discipline, callsign habits, pilot styles and pilot-initiated requests (see `PilotRealism`). */
  realism: PilotRealism;
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
  realism: undefined as unknown as PilotRealism, // replaced below (the presets are defined after this object)
  noAtisFraction: 0.4,
  numbersRequestAfterSec: 20,
  followMarginSec: 10,
  look: {
    maxRangeSm: 10, pAhead: 0.95, pSide: 0.6, pBehind: 0.2, aheadDeg: 60, sideDeg: 110,
    altDiffFt: 3000, altFactor: 0.5, farShare: 0.6, farFactor: 0.7, immediateShare: 0.6, acquireMinSec: 6, acquireSpreadSec: 10,
  },
};

// ---------------------------------------------------------------------------
// Pilot realism
// ---------------------------------------------------------------------------

/**
 * How messy the frequency is. `off` = a clean pilot (training lessons). A scenario without `pilotRealism` keeps the pre-realism
 * behaviour (only the seeded runway / heading digit error, 8 % outside training) so existing scenarios and tests replay unchanged.
 */
export type PilotRealismLevel = 'off' | 'light' | 'moderate' | 'heavy';
export const PILOT_REALISM_LEVELS: readonly PilotRealismLevel[] = ['off', 'light', 'moderate', 'heavy'];

/** Pilot-initiated request / habit codes (`PendingRequest.request`, `PilotRealism.requests`). */
export type PilotRequestCode =
  | 'RUNWAY_CHANGE' | 'SHORT_APPROACH' | 'OPTION' | 'STRAIGHT_IN' | 'STAY_IN_PATTERN' | 'NEED_MINUTE' | 'SPACING_360'
  | 'HIGHER' | 'LOWER' | 'DIRECT_FIX' | 'VISUAL_APPROACH' | 'TAXI_BACK' | 'PROGRESSIVE_TAXI';

/** [min, max] seconds. */
export type Range = readonly [number, number];

/**
 * ALL VALUES ARE DESIGN VALUES, not FAA figures: the FAA text (JO 7110.65 2-4-3, 2-4-20; AIM 4-2-4, 4-4-7) says what a correct readback
 * and callsign look like, not how often real pilots deviate. Every rate is a probability per eligible event, decided with a seeded
 * draw derived from the aircraft seed (or the engine generator), so the same seed replays the same event log.
 */
export interface PilotRealism {
  level: PilotRealismLevel;
  // --- readback errors (per eligible clearance; one error at most per readback) ---------------------------------------
  /** Runway or heading digit mistake (the pre-realism error; 0.08 was the single global rate). */
  digitErrorRate: number;
  /** ALTITUDE / initial IFR altitude read back wrong by 1000 ft (JO 7110.65 2-4-3 a; AIM 4-4-7 b). */
  altitudeErrorRate: number;
  /** Frequency change read back with a wrong digit. */
  frequencyErrorRate: number;
  /** Squawk code read back with a wrong digit (also inside an IFR clearance). */
  squawkErrorRate: number;
  /** Pattern instruction / entry read back as another one (multiplied for students by `studentPatternFactor`). */
  patternMisunderstandRate: number;
  /** An aircraft with a similar callsign on the frequency answers instead (JO 7110.65 2-4-20; AIM 4-2-4). Only when such an aircraft exists. */
  wrongCallsignRate: number;
  /** The traffic generator may create a flight whose callsign sounds like an active aircraft (AIM 4-2-4 acknowledges that this happens); otherwise it avoids it. */
  similarCallsignRate: number;
  /** The pilot complies but gives no readback at all (2-4-3: the controller must ensure the instruction was acknowledged). */
  noReadbackRate: number;
  // --- response timing and radio discipline --------------------------------------------------------------------------
  /** Seconds between the end of the instruction and the readback, by crew (seeded per aircraft and per call). */
  responseDelaySec: { airline: Range; ga: Range; student: Range };
  /** The pilot misses the call: no answer, nothing happens until the controller calls again ("did you copy" or re-issue). */
  delayedResponseRate: number;
  /** A transmission with more than `sayAgainMinCommands` instructions draws "say again" with this probability (students: x `studentSayAgainFactor`). */
  sayAgainRate: number;
  sayAgainMinCommands: number;
  /** When true calls are held `blockWindowSec` after keying; two calls keyed on one frequency inside the window are both blocked. */
  radioDiscipline: boolean;
  blockWindowSec: number;
  /** Blocked pilots retry after `blockRetryMinSec` + a seeded share of `blockRetrySpreadSec`, kept `blockWindowSec` + 0.4 s apart. */
  blockRetryMinSec: number;
  blockRetrySpreadSec: number;
  // --- callsign conventions and pilot styles ----------------------------------------------------------------------------
  /** Share of GA pilots that open with "November" instead of the type word (7110.65 2-4-20; AIM 4-2-4 says civil pilots should use the type, model or manufacturer). */
  novemberInitialRate: number;
  /** GA pilots shorten their callsign to the type / prefix and last three characters once the controller has done it (AIM 4-2-4). */
  abbreviateAfterController: boolean;
  /** Airline check-in "with you" (non-standard, but common). */
  withYouRate: number;
  /** Airline "with Bravo" for "with information Bravo" (non-standard shorthand). */
  withBravoRate: number;
  /** Share of light VFR GA aircraft flown by a student pilot (seeded per aircraft). */
  studentShare: number;
  /** Student: share of taxi requests that ask for progressive taxi. */
  progressiveTaxiRate: number;
  studentSayAgainFactor: number;
  studentPatternFactor: number;
  // --- pilot-initiated requests: share of eligible aircraft that ever make the request ---------------------------------
  requests: Record<Exclude<PilotRequestCode, 'PROGRESSIVE_TAXI' | 'LOWER'>, number>;
  /** Seconds the pilot needs after "we need a minute" before he is ready again. */
  needMinuteSec: Range;
}

const NO_DELAY: Range = [0, 0];

const OFF: PilotRealism = {
  level: 'off',
  digitErrorRate: 0, altitudeErrorRate: 0, frequencyErrorRate: 0, squawkErrorRate: 0,
  patternMisunderstandRate: 0, wrongCallsignRate: 0, similarCallsignRate: 0, noReadbackRate: 0,
  responseDelaySec: { airline: NO_DELAY, ga: NO_DELAY, student: NO_DELAY },
  delayedResponseRate: 0, sayAgainRate: 0, sayAgainMinCommands: 99, radioDiscipline: false, blockWindowSec: 0, blockRetryMinSec: 2, blockRetrySpreadSec: 3,
  novemberInitialRate: 0, abbreviateAfterController: false, withYouRate: 0, withBravoRate: 0, studentShare: 0, progressiveTaxiRate: 0,
  studentSayAgainFactor: 1, studentPatternFactor: 1,
  requests: {
    RUNWAY_CHANGE: 0, SHORT_APPROACH: 0, OPTION: 0, STRAIGHT_IN: 0, STAY_IN_PATTERN: 0, NEED_MINUTE: 0, SPACING_360: 0, HIGHER: 0, DIRECT_FIX: 0, VISUAL_APPROACH: 0, TAXI_BACK: 0,
  },
  needMinuteSec: [30, 60],
};

const LIGHT: PilotRealism = {
  ...OFF, level: 'light',
  digitErrorRate: 0.04, altitudeErrorRate: 0.02, frequencyErrorRate: 0.02, squawkErrorRate: 0.02,
  patternMisunderstandRate: 0.03, wrongCallsignRate: 0.15, similarCallsignRate: 0.04, noReadbackRate: 0.02,
  responseDelaySec: { airline: [0.4, 1.2], ga: [0.8, 2.2], student: [1.5, 3.5] },
  delayedResponseRate: 0.015, sayAgainRate: 0.15, sayAgainMinCommands: 3, radioDiscipline: true, blockWindowSec: 0.4,
  novemberInitialRate: 0.3, abbreviateAfterController: true, withYouRate: 0.2, withBravoRate: 0.2, studentShare: 0.1, progressiveTaxiRate: 0.4,
  studentSayAgainFactor: 1.5, studentPatternFactor: 2,
  requests: {
    RUNWAY_CHANGE: 0.04, SHORT_APPROACH: 0.04, OPTION: 0.05, STRAIGHT_IN: 0.06, STAY_IN_PATTERN: 0.1, NEED_MINUTE: 0.03, SPACING_360: 0.03, HIGHER: 0.05, DIRECT_FIX: 0.06, VISUAL_APPROACH: 0.1, TAXI_BACK: 0.05,
  },
};

const MODERATE: PilotRealism = {
  ...LIGHT, level: 'moderate',
  digitErrorRate: 0.08, altitudeErrorRate: 0.04, frequencyErrorRate: 0.04, squawkErrorRate: 0.04,
  patternMisunderstandRate: 0.05, wrongCallsignRate: 0.3, similarCallsignRate: 0.1, noReadbackRate: 0.04,
  responseDelaySec: { airline: [0.5, 1.8], ga: [1, 3.2], student: [2, 5] },
  delayedResponseRate: 0.03, sayAgainRate: 0.25, sayAgainMinCommands: 3, blockWindowSec: 0.5,
  novemberInitialRate: 0.4, withYouRate: 0.3, withBravoRate: 0.3, studentShare: 0.2, progressiveTaxiRate: 0.5, studentSayAgainFactor: 2, studentPatternFactor: 3,
  requests: {
    RUNWAY_CHANGE: 0.08, SHORT_APPROACH: 0.08, OPTION: 0.1, STRAIGHT_IN: 0.12, STAY_IN_PATTERN: 0.2, NEED_MINUTE: 0.06, SPACING_360: 0.06, HIGHER: 0.1, DIRECT_FIX: 0.12, VISUAL_APPROACH: 0.2, TAXI_BACK: 0.1,
  },
};

const HEAVY: PilotRealism = {
  ...MODERATE, level: 'heavy',
  digitErrorRate: 0.12, altitudeErrorRate: 0.07, frequencyErrorRate: 0.07, squawkErrorRate: 0.07,
  patternMisunderstandRate: 0.08, wrongCallsignRate: 0.5, similarCallsignRate: 0.2, noReadbackRate: 0.07,
  responseDelaySec: { airline: [0.6, 2.4], ga: [1.2, 4], student: [2.5, 6.5] },
  delayedResponseRate: 0.05, sayAgainRate: 0.35, sayAgainMinCommands: 2, blockWindowSec: 0.6,
  novemberInitialRate: 0.5, withYouRate: 0.4, withBravoRate: 0.4, studentShare: 0.3, progressiveTaxiRate: 0.6, studentSayAgainFactor: 2, studentPatternFactor: 3,
  requests: {
    RUNWAY_CHANGE: 0.14, SHORT_APPROACH: 0.14, OPTION: 0.18, STRAIGHT_IN: 0.2, STAY_IN_PATTERN: 0.3, NEED_MINUTE: 0.12, SPACING_360: 0.1, HIGHER: 0.18, DIRECT_FIX: 0.2, VISUAL_APPROACH: 0.35, TAXI_BACK: 0.2,
  },
  needMinuteSec: [40, 75],
};

export const PILOT_REALISM_PRESETS: Record<PilotRealismLevel, PilotRealism> = { off: OFF, light: LIGHT, moderate: MODERATE, heavy: HEAVY };

DEFAULT_PILOT_BEHAVIOUR.realism = OFF;

export type PilotRealismOverride = Partial<Omit<PilotRealism, 'responseDelaySec' | 'requests'>> & {
  responseDelaySec?: Partial<PilotRealism['responseDelaySec']>;
  requests?: Partial<PilotRealism['requests']>;
};
export type PilotBehaviourOverride = Partial<Omit<PilotBehaviour, 'look' | 'ground' | 'realism'>> & { look?: Partial<PilotBehaviour['look']>; ground?: Partial<GroundBehaviour>; realism?: PilotRealismOverride };

/** Scenario difficulty -> realism (easy = light, normal = moderate, hard = heavy). */
export function realismForDifficulty(d: 'easy' | 'normal' | 'hard' | undefined): PilotRealismLevel {
  return d === 'easy' ? 'light' : d === 'hard' ? 'heavy' : 'moderate';
}

/**
 * The ground-operations rates a realism level sets (src/sim/pilotBehaviour.ts `ground`): hold-short readback omissions, the wrong taxiway in a
 * readback (a share of the digit error rate) and pilots unfamiliar with the airport. DESIGN VALUES. `moderate` equals the defaults of the ground task.
 */
export const GROUND_RATES_BY_LEVEL: Record<PilotRealismLevel, Pick<GroundBehaviour, 'holdShortOmitFraction' | 'taxiwayErrorShare' | 'unfamiliarFraction'>> = {
  off: { holdShortOmitFraction: 0, taxiwayErrorShare: 0, unfamiliarFraction: 0 },
  light: { holdShortOmitFraction: 0.04, taxiwayErrorShare: 0.5, unfamiliarFraction: 0.05 },
  moderate: { holdShortOmitFraction: 0.08, taxiwayErrorShare: 0.5, unfamiliarFraction: 0.1 },
  heavy: { holdShortOmitFraction: 0.12, taxiwayErrorShare: 0.5, unfamiliarFraction: 0.15 },
};

/**
 * A pilot unfamiliar with the airport (seeded per aircraft): requests progressive taxi (AIM 4-3-18) and asks "say route" when none is given.
 * A student pilot asks for progressive taxi at the realism `progressiveTaxiRate` as well.
 */
export function pilotUnfamiliar(ac: { seed: number; student?: boolean }, fraction: number, studentRate = 0): boolean {
  if (ac.student && studentRate > 0 && seeded01(ac.seed, 'progressive') < studentRate) return true;
  return fraction > 0 && seeded01(ac.seed, 'unfamiliar') < fraction;
}

/**
 * Resolve the tuning object. `level` is the scenario's `pilotRealism`; undefined = the pre-realism behaviour (all realism features off, the
 * digit error stays at the engine's `readbackErrorRate`, the ground defaults apply). Training mode switches the pilot mistakes that no lesson
 * teaches off (hold-short readback omissions, unfamiliar pilots) unless the scenario sets them explicitly. A level sets the ground rates too.
 */
export function resolvePilotBehaviour(o?: PilotBehaviourOverride, mode?: 'training' | 'free' | string, level?: PilotRealismLevel): PilotBehaviour {
  const base = PILOT_REALISM_PRESETS[level ?? 'off'];
  const r = o?.realism;
  const realism: PilotRealism = {
    ...base, ...r,
    responseDelaySec: { ...base.responseDelaySec, ...r?.responseDelaySec },
    requests: { ...base.requests, ...r?.requests },
  };
  const trainingOff: Partial<GroundBehaviour> = mode === 'training' && !level ? { holdShortOmitFraction: 0, unfamiliarFraction: 0, taxiwayErrorShare: 0 } : {};
  return {
    ...DEFAULT_PILOT_BEHAVIOUR, ...o, realism,
    look: { ...DEFAULT_PILOT_BEHAVIOUR.look, ...o?.look },
    ground: { ...DEFAULT_PILOT_BEHAVIOUR.ground, ...(level ? GROUND_RATES_BY_LEVEL[level] : trainingOff), ...o?.ground },
  };
}
