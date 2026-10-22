/**
 * ATC phraseology for the AI controllers. Every phrase exists twice: `text` (what a UI shows: digits where a controller
 * would write them) and `spoken` (TTS-ready, every number as words). Callsign FIRST for controller transmissions
 * (7110.65 2-4-14), unlike the pilot calls in `src/radio/readback.ts` (callsign last in readbacks).
 */
import type { Aircraft, Airport, ApproachType } from '../sim/types';
import { facilityCallName, frequencyById, frequencyByMhz, positionWord } from '../radio/frequencies';
import {
  digitsSpoken, spokenAirportName, spokenAltitude, spokenFrequency, spokenFrequencyDecimal, spokenRunway, spokenSpeed, spokenTaxiway, titleCase,
} from '../radio/spoken';
import { approachWord, spokenFix } from '../radio/readback';

export interface Phrase {
  text: string;
  spoken: string;
}

type Seg = string | Phrase;

const seg = (s: Seg): Phrase => (typeof s === 'string' ? { text: s, spoken: s } : s);

/** Join segments with ", " (the usual comma-separated clause style of 7110.65 phraseology). */
export function clauses(...segs: (Seg | undefined | false)[]): Phrase {
  const ps = segs.filter((s): s is Seg => !!s).map(seg);
  return { text: ps.map((p) => p.text).join(', '), spoken: ps.map((p) => p.spoken).join(', ') };
}

/** Join segments with a space (inside one clause). */
export function words(...segs: (Seg | undefined | false)[]): Phrase {
  const ps = segs.filter((s): s is Seg => !!s).map(seg);
  return { text: ps.map((p) => p.text).join(' '), spoken: ps.map((p) => p.spoken).join(' ') };
}

const stripZero = (id: string): string => id.replace(/^0+(?=\d)/, '');

/** "13" -> one three; a runway pair ("4/22") is named by its first end, as spokenRunway does. */
export const rwy = (id: string): Phrase => ({ text: stripZero(id.toUpperCase().replace(/^(RUNWAY|RWY)\s*/, '').split('/')[0]), spoken: spokenRunway(id) });
export const taxiwayList = (ids: string[]): Phrase => {
  const s = ids.map(spokenTaxiway).join(', ');
  return { text: s, spoken: s };
};
export const altitude = (ft: number): Phrase => ({ text: ft >= 18000 ? `FL${Math.round(ft / 100)}` : String(Math.round(ft)), spoken: spokenAltitude(ft) });
export const speed = (kt: number): Phrase => ({ text: String(Math.round(kt)), spoken: spokenSpeed(kt) });

const trimMhz = (mhz: number): string => mhz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');

/** Frequency as a controller says it; Ground 121.6-121.99 is abbreviated "point niner" like the pilots' readbacks. */
export function frequency(airport: Airport, mhz: number, id?: string): Phrase {
  const f = (id ? frequencyById(airport, id) : undefined) ?? frequencyByMhz(airport, mhz);
  const abbreviated = f?.position === 'GND' && mhz >= 121.6 && mhz < 122;
  return {
    text: abbreviated ? `point ${mhz.toFixed(3).replace(/0+$/, '').split('.')[1] ?? '0'}` : trimMhz(mhz),
    spoken: abbreviated ? spokenFrequencyDecimal(mhz) : spokenFrequency(mhz),
  };
}

export const callsign = (ac: Pick<Aircraft, 'spokenCallsign'>): Phrase => ({ text: ac.spokenCallsign, spoken: ac.spokenCallsign });

export function facilityWord(airport: Airport, mhz: number, id?: string): string {
  return facilityCallName(airport, mhz, id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Phrases per instruction
// ---------------------------------------------------------------------------------------------------------------------

export function ifrClearance(
  ac: Aircraft, facility: string,
  c: { destination: string; departureProcedure?: string; initialAltitudeFt: number; expectAltitudeFt?: number; departureFrequencyMhz: number; squawk: string },
  airport: Airport,
): Phrase {
  const dest = spokenAirportName(c.destination);
  return clauses(
    callsign(ac),
    facility,
    `cleared to ${dest} airport`,
    c.departureProcedure ? `${titleCase(c.departureProcedure)} departure, radar vectors` : 'as filed',
    { text: `maintain ${altitude(c.initialAltitudeFt).text}`, spoken: `maintain ${spokenAltitude(c.initialAltitudeFt)}` },
    c.expectAltitudeFt ? { text: `expect ${altitude(c.expectAltitudeFt).text}, 10 minutes after departure`, spoken: `expect ${spokenAltitude(c.expectAltitudeFt)}, one zero minutes after departure` } : undefined,
    { text: `departure frequency ${frequency(airport, c.departureFrequencyMhz).text}`, spoken: `departure frequency ${spokenFrequency(c.departureFrequencyMhz)}` },
    { text: `squawk ${c.squawk}`, spoken: `squawk ${digitsSpoken(c.squawk)}` },
  );
}

export function taxiToRunway(ac: Aircraft, runwayEnd: string, via: string[], holdShort: string[]): Phrase {
  return clauses(
    callsign(ac),
    words('runway', rwy(runwayEnd)),
    via.length ? words('taxi via', taxiwayList(via)) : 'taxi',
    ...holdShort.map((r) => words('hold short of runway', rwy(r))),
  );
}

export function taxiToParking(ac: Aircraft, spot: { id: string; category: string }, via: string[], holdShort: string[]): Phrase {
  const digits = /(\d+)/.exec(spot.id)?.[1];
  const where =
    spot.category === 'airline' && digits
      ? { text: `gate ${Number(digits)}`, spoken: `gate ${digitsSpoken(String(Number(digits)))}` }
      : { text: 'the ramp', spoken: 'the ramp' };
  return clauses(callsign(ac), words('taxi to', where, via.length ? words('via', taxiwayList(via)) : undefined), ...holdShort.map((r) => words('hold short of runway', rwy(r))));
}

/** "N1AA, pushback approved, tail east" (NON-STANDARD: JO 7110.65 has no pushback phrase; pushback is normally a ramp / company function). */
export const pushbackApproved = (ac: Aircraft, tail?: string): Phrase => clauses(callsign(ac), 'pushback approved', tail ? `tail ${tail}` : undefined);

/** JO 7110.65 3-7-2 PHRASEOLOGY "READ BACK HOLD INSTRUCTIONS." */
export const readBackHoldInstructions = (ac: Aircraft): Phrase => clauses(callsign(ac), 'read back hold instructions');

/** One step of a progressive taxi (JO 7110.65 3-7-2: "step-by-step directions and/or directional turns"): "turn left on Bravo, continue to Charlie". */
export function progressiveStep(ac: Aircraft, s: { taxiways: string[]; turn?: 'left' | 'right'; next?: string }): Phrase {
  const twy = taxiwayList(s.taxiways);
  if (s.turn) return clauses(callsign(ac), words('turn', s.turn, 'on', twy), s.next ? words('continue to', taxiwayList([s.next])) : undefined);
  return clauses(callsign(ac), words('continue taxiing via', twy), s.next ? words('to', taxiwayList([s.next])) : undefined);
}

/**
 * "N1AA, pull off onto Charlie, let Cessna N2BB pass" - answer to a "nose to nose" call. Plain wording: JO 7110.65 has no phrase for it
 * (NON-STANDARD); the aircraft is taxied onto the branch with an ordinary taxi instruction.
 */
export function headOnPullAside(ac: Aircraft, other: Pick<Aircraft, 'spokenCallsign'>, taxiway: string, toStand?: string): Phrase {
  const where = toStand ? words('into', { text: toStand, spoken: toStand }) : words('onto', taxiwayList([taxiway]));
  return clauses(callsign(ac), words('pull off', where), words('let', callsign(other), 'pass'));
}

/** "N1AA, make a one eighty, let Cessna N2BB pass" (NON-STANDARD: common usage, the parser flags it too). */
export const headOnTurnAround = (ac: Aircraft, other: Pick<Aircraft, 'spokenCallsign'>): Phrase => clauses(callsign(ac), 'make a one eighty', words('let', callsign(other), 'pass'));

export const crossRunway = (ac: Aircraft, runwayId: string): Phrase => clauses(callsign(ac), words('cross runway', rwy(runwayId)));

export const lineUpAndWait = (ac: Aircraft, runwayEnd: string): Phrase => clauses(callsign(ac), words('runway', rwy(runwayEnd)), 'line up and wait');

/** "N1AA, runway 13, line up and wait, traffic Cessna, 2 mile final" (JO 7110.65 3-9-4: traffic information with line up and wait). */
export const lineUpAndWaitTraffic = (ac: Aircraft, runwayEnd: string, traffic: Phrase): Phrase =>
  clauses(callsign(ac), words('runway', rwy(runwayEnd)), 'line up and wait', words('traffic', traffic));

/** "N1AA, turn left at Charlie, contact Ground point niner" (JO 7110.65 3-10-9 example: exit instruction, then the frequency change). */
export function exitAndContact(ac: Aircraft, airport: Airport, taxiway: string, side: 'left' | 'right', frequencyId: string, mhz: number): Phrase {
  const f = frequencyById(airport, frequencyId) ?? frequencyByMhz(airport, mhz);
  const word = f && f.position !== 'OTHER' && f.position !== 'ATIS' ? positionWord(f.position).toLowerCase() : 'next controller';
  const twy = taxiwayList([taxiway]);
  return clauses(callsign(ac), words('turn', side, 'at', twy), words('contact', word, frequency(airport, mhz, f?.id)));
}

/**
 * "N1AA, turn left at Charlie, hold short of runway 4" (JO 7110.65 3-10-9 PHRASEOLOGY and example), given before touchdown or on the rollout when the
 * exit was arranged with Ground (3-1-4) or the pilot's own choice would put the aircraft in the way. Either part may be left out.
 */
export function exitInstruction(ac: Aircraft, e: { taxiway?: string; side?: 'left' | 'right'; holdShortRunway?: string }): Phrase {
  return clauses(callsign(ac), e.taxiway ? words('turn', e.side, 'at', taxiwayList([e.taxiway])) : e.side ? words('turn', e.side) : undefined, e.holdShortRunway ? words('hold short of runway', rwy(e.holdShortRunway)) : undefined);
}

/**
 * "N1AA, cross runway 13, turn right at Alpha, contact Ground point niner": the answer to an aircraft stopped on the runway (exit instruction
 * 3-10-9, crossing of the intersecting runway 3-7-2 / 3-1-3, then the frequency change).
 */
export function stoppedExit(ac: Aircraft, airport: Airport, taxiway: string, side: 'left' | 'right', crosses: string[], contact?: { frequencyId: string; mhz: number }): Phrase {
  const f = contact ? frequencyById(airport, contact.frequencyId) ?? frequencyByMhz(airport, contact.mhz) : undefined;
  const word = f && f.position !== 'OTHER' && f.position !== 'ATIS' ? positionWord(f.position).toLowerCase() : 'next controller';
  return clauses(
    callsign(ac),
    ...crosses.map((r) => words('cross runway', rwy(r))),
    words('turn', side, 'at', taxiwayList([taxiway])),
    contact ? words('contact', word, frequency(airport, contact.mhz, f?.id)) : undefined,
  );
}

/** "N1AA, wind 130 at 8, altimeter 3010" (3-9-1 / 3-10-1: wind and altimeter for a pilot who did not report the ATIS). */
export function airportInfo(ac: Aircraft, dirDeg: number | undefined, speedKt: number, altimeterInHg: number, unit: 'inHg' | 'hPa' = 'inHg'): Phrase {
  const alt = unit === 'hPa' ? String(Math.round(altimeterInHg * 33.8639)) : String(Math.round(altimeterInHg * 100));
  const wind: Phrase = speedKt === 0 || dirDeg === undefined
    ? { text: speedKt === 0 ? 'wind calm' : `wind variable at ${speedKt}`, spoken: speedKt === 0 ? 'wind calm' : `wind variable at ${digitsSpoken(String(speedKt))}` }
    : { text: `wind ${String(dirDeg).padStart(3, '0')} at ${speedKt}`, spoken: `wind ${digitsSpoken(String(dirDeg).padStart(3, '0'))} at ${digitsSpoken(String(speedKt))}` };
  return clauses(callsign(ac), wind, unit === 'hPa' ? { text: `QNH ${alt}`, spoken: `QNH ${digitsSpoken(alt)}` } : { text: `altimeter ${alt}`, spoken: `altimeter ${digitsSpoken(alt)}` });
}

export const clearedForTakeoff = (ac: Aircraft, runwayEnd: string, runwayHeading: boolean): Phrase =>
  clauses(callsign(ac), words('runway', rwy(runwayEnd)), runwayHeading && 'fly runway heading', 'cleared for takeoff');

/** "<callsign>, turn right heading two five zero, runway N, cleared for takeoff" (JO 7110.65 5-8-2 INITIAL HEADING, 3-9-10). */
export const clearedForTakeoffHeading = (ac: Aircraft, runwayEnd: string, headingMag: number, turn: 'left' | 'right'): Phrase => {
  const h = String(Math.round(headingMag) || 360).padStart(3, '0');
  return clauses(callsign(ac), { text: `turn ${turn} heading ${h}`, spoken: `turn ${turn} heading ${digitsSpoken(h)}` }, words('runway', rwy(runwayEnd)), 'cleared for takeoff');
};

/**
 * "<callsign>, [runway N RVR two thousand four hundred,] [braking action medium, reported by a Boeing seven thirty seven,] runway N, cleared to land."
 * The RVR (JO 7110.65 2-8-2: local control issues the current RVR to each aircraft prior to landing, 2-8-3 wording) and the braking action
 * information (3-3-5: the latest report for the runway in use to each arriving aircraft, or "no braking action reports received") go in front of the clearance.
 */
export const clearedToLand = (ac: Aircraft, runwayEnd: string, info: Phrase[] = []): Phrase =>
  clauses(callsign(ac), ...info, words('runway', rwy(runwayEnd)), 'cleared to land');

export const continueApproach = (ac: Aircraft): Phrase => clauses(callsign(ac), 'continue approach');

export const goAround = (ac: Aircraft): Phrase => clauses(callsign(ac), 'go around');

/** "extend downwind, I'll call your base" (JO 7110.65 3-8-1 EXTEND DOWNWIND; the "call your base" wording follows the 3-9-4 example). */
export const extendDownwind = (ac: Aircraft): Phrase => clauses(callsign(ac), "extend downwind, I'll call your base");

/** "turn base now": not a 7110.65 phrase (BEHAVIOUR-ACCURACY T15), plain English for the call the extend instruction promised. */
export const turnBaseNow = (ac: Aircraft): Phrase => clauses(callsign(ac), 'turn base now');

export const enterPattern = (ac: Aircraft, runwayEnd: string, leg: string): Phrase =>
  clauses(callsign(ac), words(leg, 'runway', rwy(runwayEnd)));

/** "contact tower one two zero point three" / "contact ground point niner" / "contact departure one two four point six". */
export function contact(ac: Aircraft, airport: Airport, frequencyId: string, mhz: number): Phrase {
  const f = frequencyById(airport, frequencyId) ?? frequencyByMhz(airport, mhz);
  const word = f && f.position !== 'OTHER' && f.position !== 'ATIS' ? positionWord(f.position).toLowerCase() : 'next controller';
  return clauses(callsign(ac), words('contact', word, frequency(airport, mhz, f?.id)));
}

export const radarContact = (ac: Aircraft, facility: string): Phrase => clauses(callsign(ac), facility, 'radar contact');

export function descendMaintain(ft: number, currentFt: number): Phrase {
  const verb = currentFt > ft + 50 ? 'descend and maintain' : currentFt < ft - 50 ? 'climb and maintain' : 'maintain';
  return { text: `${verb} ${altitude(ft).text}`, spoken: `${verb} ${spokenAltitude(ft)}` };
}

/** "descend via the Rozze Two arrival" (JO 7110.65 4-5-7, 4-7-1: the name and number without the parenthesised chart words). */
export const descendViaArrival = (spokenName: string): Phrase => {
  const n = titleCase(spokenName);
  return { text: `descend via the ${n} arrival`, spoken: `descend via the ${n} arrival` };
};

/**
 * Answer to a pilot's request for the runway lights up or down. JO 7110.65 3-4-10 d / 3-4-11 allow the change at the pilot's request but give no
 * phraseology for the answer: plain English, callsign first (2-4-14).
 */
export const lightsAnswer = (ac: Pick<Aircraft, 'spokenCallsign'>, direction: 'up' | 'down'): Phrase =>
  clauses(callsign(ac), direction === 'up' ? 'runway lights increased' : 'runway lights decreased');

export const direct = (airport: Airport, fix: string): Phrase => {
  const n = spokenFix(airport, fix);
  return { text: `proceed direct ${n}`, spoken: `proceed direct ${n}` };
};

export const clearedApproach = (type: ApproachType, runwayEnd: string): Phrase =>
  type === 'VISUAL'
    ? words('cleared visual approach runway', rwy(runwayEnd))
    : words('cleared', approachWord(type), 'runway', rwy(runwayEnd), 'approach');

export const reduceSpeed = (kt: number): Phrase => ({ text: `reduce speed to ${kt}`, spoken: `reduce speed to ${spokenSpeed(kt)}` });

export const holdAsPublished = (airport: Airport, fix: string): Phrase => {
  const n = spokenFix(airport, fix);
  return { text: `hold at ${n} as published`, spoken: `hold at ${n} as published` };
};

/** Re-issue after a wrong readback: "negative, ..." (7110.65 2-4-3: have the pilot correct a faulty readback). */
export const negative = (p: Phrase): Phrase => ({ text: `negative, ${p.text}`, spoken: `negative, ${p.spoken}` });

// ---------------------------------------------------------------------------------------------------------------------
// Traffic variety (vehicles, helicopters, VFR transitions, flight training, overhead maneuver)
// ---------------------------------------------------------------------------------------------------------------------

/** Vehicles are told to "proceed" or "hold", never "taxi" or "cleared" (JO 7110.65 3-7-2). */
export function proceedToRunway(ac: Aircraft, runwayEnd: string, via: string[], holdShort: string[]): Phrase {
  return clauses(
    callsign(ac),
    words('proceed to runway', rwy(runwayEnd), via.length ? words('via', taxiwayList(via)) : undefined),
    ...holdShort.map((r) => words('hold short of runway', rwy(r))),
  );
}

/** "<callsign>, proceed on runway one three, report runway inspection complete." */
export const proceedOnRunway = (ac: Aircraft, runwayEnd: string, report: string): Phrase =>
  clauses(callsign(ac), words('proceed on runway', rwy(runwayEnd)), report);

export const proceedOnTaxiways = (ac: Aircraft): Phrase => clauses(callsign(ac), 'proceed on the taxiways', 'hold short of all runways');

export function proceedToRamp(ac: Aircraft, via: string[], holdShort: string[]): Phrase {
  return clauses(callsign(ac), words('proceed to the ramp', via.length ? words('via', taxiwayList(via)) : undefined), ...holdShort.map((r) => words('hold short of runway', rwy(r))));
}

/** Helicopter takeoff (JO 7110.65 3-11-2): "<callsign>, <pad>, make right turn for southeast departure, cleared for takeoff." */
export const heliTakeoff = (ac: Aircraft, from: string, turn: 'left' | 'right', direction: string): Phrase =>
  clauses(callsign(ac), from, `make ${turn} turn for ${direction} departure`, 'cleared for takeoff');

/** Helicopter landing (3-11-6): "<callsign>, make straight-in approach to <pad>, cleared to land." */
export const heliLand = (ac: Aircraft, pad: string): Phrase => clauses(callsign(ac), `make straight-in approach to ${pad}`, 'cleared to land');

/** "air taxi to <place>" (3-11-1; hover taxi when asked for). */
export const airTaxi = (ac: Aircraft, where: string, mode: 'air' | 'hover' = 'air'): Phrase =>
  clauses(callsign(ac), `${mode === 'hover' ? 'hover taxi' : 'air taxi'} to ${where}`);

/** "hold position" for a helicopter in the air (it hovers). */
export const holdPosition = (ac: Aircraft): Phrase => clauses(callsign(ac), 'hold position');

export const squawkCode = (ac: Aircraft, code: string): Phrase =>
  clauses(callsign(ac), { text: `squawk ${code}`, spoken: `squawk ${digitsSpoken(code)}` });

/** Class C: radio contact and radar identification (7-8-4: "(a/c call sign) standby"; 7-8-2 services). */
export const radarContactVfr = (ac: Aircraft, facility: string): Phrase => clauses(callsign(ac), facility, 'radar contact');

/** Leaving the Class C outer area: services end and the frequency change is approved (7-8-8: "CHANGE TO ADVISORY FREQUENCY APPROVED"). */
export const classCTerminated = (ac: Aircraft): Phrase => clauses(callsign(ac), 'radar service terminated', 'squawk VFR', 'frequency change approved');

/** Overhead maneuver (3-10-12): "<callsign>, runway six, wind ..., pattern altitude six thousand, report initial." */
export function overheadInstruction(ac: Aircraft, runwayEnd: string, wind: Phrase, altitudeFt: number): Phrase {
  return clauses(callsign(ac), words('runway', rwy(runwayEnd)), wind, { text: `pattern altitude ${altitude(altitudeFt).text}`, spoken: `pattern altitude ${spokenAltitude(altitudeFt)}` }, 'report initial');
}

/** "<callsign>, break at midfield, report break." (3-10-12 example). */
export const breakAtMidfield = (ac: Aircraft): Phrase => clauses(callsign(ac), 'break at midfield', 'report break');

/** Touch-and-go landing clearance (3-8-1). */
export const clearedTouchAndGo = (ac: Aircraft, runwayEnd: string, info: Phrase[] = []): Phrase =>
  clauses(callsign(ac), ...info, words('runway', rwy(runwayEnd)), 'cleared touch-and-go');
