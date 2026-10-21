/**
 * Frozen system prompt and response schema of the phrase interpreter (see src/commands/llm/contract.ts).
 *
 * The prompt is a constant: nothing per-request (airport, aircraft, time) may be interpolated into it, because it is sent as a
 * cached system block and any byte change would invalidate the cache. Per-request data goes in the user message.
 *
 * Schema design: Anthropic structured outputs allow at most 16 union-typed ("anyOf" / type-array) parameters and 24 optional
 * ones per request, and a command has about 60 possible fields. So the wire schema is FLAT and every property is required with
 * a sentinel for "not given" ("" for strings and enums, -1 for numbers, false for booleans, [] for arrays); only `callsign`
 * and `note` are real nulls. `toLlmCommand` turns a wire command into the `LlmCommand` of the contract and drops every sentinel.
 */
import type { CommandKind, HoldingInstruction, IfrClearanceDetails } from '../../src/sim/types';
import type { LlmCommand } from '../../src/commands/llm/contract';

/** Every CommandKind. The Record makes the compiler fail when `CommandKind` gains a member that is not listed here. */
const KIND_TABLE: Record<CommandKind, true> = {
  TAXI: true, HOLD_POSITION: true, HOLD_SHORT: true, CROSS_RUNWAY: true, LINE_UP_AND_WAIT: true,
  TAKEOFF: true, LAND: true, GO_AROUND: true, CONTINUE_APPROACH: true, CONTACT_FREQUENCY: true,
  HEADING: true, ALTITUDE: true, SPEED: true, ENTER_PATTERN: true, PUSHBACK: true, TAXI_TO_PARKING: true,
  IFR_CLEARANCE: true, APPROACH: true, DIRECT_FIX: true, RESUME_OWN_NAVIGATION: true, RADAR_CONTACT: true,
  HOLD_AT_FIX: true, MISSED_APPROACH: true, STAR: true, ADVISORY: true, RUNWAY_LIGHTS: true,
  EXIT_RUNWAY: true, CANCEL_TAKEOFF: true, TURN_AROUND: true, TRAFFIC_ADVISORY: true, FOLLOW_TRAFFIC: true,
  PATTERN_INSTRUCTION: true, REPORT_POSITION: true, FREQUENCY_CHANGE_APPROVED: true, SQUAWK: true, AIRPORT_INFO: true,
  PROCEED: true, AIR_TAXI: true, OVERHEAD: true,
  SAY_AGAIN: true, DID_YOU_COPY: true, UNABLE: true, READ_BACK_HOLD: true, UNKNOWN: true,
};
export const COMMAND_KINDS = Object.keys(KIND_TABLE) as CommandKind[];

export const NUM_UNSET = -1;

export const SYSTEM_PROMPT = `You are the phrase interpreter of an air traffic control training simulator for a small US airport. A student controller speaks or types a radio transmission to an aircraft. A rule-based parser could not read it with confidence. Your only job is to turn the transmission into structured commands that the simulator can execute. You never talk to the controller and never invent anything.

# Input

The user message holds: the aircraft currently in the simulation (callsign, spokenCallsign, type), the runway ends, taxiways, frequencies, fixes and STAR arrivals of the airport, optionally "GRAMMAR GUESS" (what the rule parser made of the transmission) and the TRANSMISSION itself. The grammar guess may be confirmed, corrected or ignored: trust the transmission over the guess.

# Rules

1. Address only aircraft present in the aircraft list. Copy the "callsign" string EXACTLY as listed (for example "NKS451" or "N6004T"); never reformat or invent one. Match the spoken form to an aircraft by its callsign, its spokenCallsign (airline telephony such as "Spirit four fifty one"), an abbreviated N-number ("three echo juliet" for the last characters), or its type ("the Cessna", "the Skyhawk", "the Citation", "the helicopter"). If several aircraft match the description, or none does, set callsign to null. The same callsign applies to every instruction of the transmission unless the controller addresses another aircraft.
2. Runway ends, taxiways, frequencies, fixes and STAR names must come from the lists in the user message. Use the list spelling ("13", "31", "A", "B1", "CARYL", "ROZZE2"). If the controller names something that is not in a list, choose the closest list entry only when the speech-to-text error is obvious (for example "around way one three" for "runway one three", "hold shore" for "hold short"); otherwise leave the field unset. Never output an identifier that is not in the lists.
3. The controller's phrasing may be loose, misheard by speech-to-text, or in a different order. Map it to the closest standard instruction below. Several instructions in one transmission are returned as several commands, in spoken order.
4. If the transmission contains no instruction for an aircraft (a pilot readback, chit-chat, a thank-you, a landline call to another controller, a question to the instructor), return an empty "commands" array and put a short reason in "note". Use kind UNKNOWN only for something that is clearly an instruction you cannot map.
5. "cross runway N behind the landing / arriving <aircraft>" or "cross runway N after the <aircraft> lands": ONE CROSS_RUNWAY with behindCallsign set to the callsign (from the aircraft list) of that other aircraft. If that aircraft cannot be identified, leave behindCallsign "" and say so in "note".
6. Fill only the fields an instruction needs. Every field of the output must be present; use the "not given" value for fields that do not apply: "" for text and enums, -1 for numbers, false for booleans, [] for lists. Never put a guess in a field the controller did not say.
7. "note" is one short line in plain English, or null when everything was clear.

# Output fields

kind, callsign, then the fields below. Headings are magnetic degrees 1..360 (000 means 360). Altitudes are feet (flight level 180 = 18000).
- runwayEnd: runway end ("13"); runwayId: its pair ("13/31"); crossRunwayId: the runway pair being crossed.
- route: taxiway names in order; holdShort: hold-short points ("RWY13" for a runway end, or a taxiway name "A"); destination: see the catalogue; exitTaxiway; turnDirection (left/right).
- headingDeg, departureHeading (heading to fly after takeoff, with turnDirection), altitudeFt, speedKt, frequencyId (GND, TWR, APP, DEP, CLNC), frequencyMhz, squawk (four digits as text).
- patternLeg (left_downwind, right_downwind, straight_in, base), turnDegrees, distanceNm, sequenceNumber, ifAble, segment, reason, trafficAdvised.
- approachType (ILS, LOC, RNAV, VOR, VISUAL), fix, starName, starTransition, descendVia.
- advisory (BIRDS or BRAKING) with brakingTerm; lightsDirection (UP, DOWN) or lightStep (1..5); reportClear; taxiMode (air, hover).
- pushTailDeg / pushFaceDeg: pushback tail or nose direction as a compass heading.
- Traffic described by the controller: trafficDesc (type words in lower case: "cessna", "boeing 737", "skyhawk"), trafficPosition (final, base, downwind, upwind, crosswind, departing, in_position, on_runway, ahead), trafficSide (left/right), trafficDistanceNm.
- Airport information: windDirDeg, windSpeedKt, windGustKt, calm, altimeterInHg.
- IFR clearance (kind IFR_CLEARANCE): ifrDestination (ICAO, "KPHL"), ifrRouteText (as spoken after "via", or "as filed"), ifrDepartureProcedure ("ATLANTIC CITY THREE"), ifrInitialAltitudeFt, ifrExpectAltitudeFt, ifrDepartureFrequencyMhz, ifrSquawk.
- Holding (kind HOLD_AT_FIX): holdFix, holdInboundCourseDeg (the INBOUND course to the fix: radial + 180, so "hold east of X on the 090 radial" is 270), holdTurns (left/right, right when not stated), holdLegMinutes, holdLegNm, holdAsPublished (true for "as published"), holdEfcZulu ("1245" for "expect further clearance one two four five").

# Catalogue of instructions (phrasing -> kind and fields)

- taxi [to] runway N [via A B] [hold short of X] -> TAXI: destination "RWY<end>" (e.g. "RWY13"), route, holdShort.
- taxi to the ramp / parking / general aviation / FBO / terminal / cargo / hangar / apron / gate N -> TAXI_TO_PARKING: destination RAMP, PARKING, GA, FBO, TERMINAL, CARGO, HANGAR, APRON or GATE<n>; route, holdShort.
- continue [straight] [on X] to Y (a progressive taxi step) -> TAXI with segment true, destination "TWY<Y>", route [X].
- hold position, stop (aircraft stopped on the ground) -> HOLD_POSITION.
- hold short of runway N / of taxiway X -> HOLD_SHORT: holdShort ["RWY13"] or ["A"], plus runwayEnd and runwayId for a runway.
- cross runway N [at / via taxiway X] -> CROSS_RUNWAY: crossRunwayId, runwayEnd, route [X]; behindCallsign for rule 5.
- line up and wait, position and hold, taxi into position -> LINE_UP_AND_WAIT.
- cleared for takeoff runway N -> TAKEOFF (runwayEnd, runwayId). "Fly runway heading" or "turn left heading 270" given with it: headingDeg is not used, use departureHeading and turnDirection on the TAKEOFF; if it is spoken as a separate instruction after takeoff use HEADING.
- cleared to land [runway N] -> LAND (destination "option", "touch_and_go", "stop_and_go" or "low_approach" when named). "Cleared to land runway N, hold short of runway M / taxiway X" -> ONE LAND with holdShort.
- go around -> GO_AROUND. continue approach -> CONTINUE_APPROACH. execute / fly the published missed approach -> MISSED_APPROACH.
- contact / monitor / switch to ground, tower, approach, departure, clearance delivery [freq] -> CONTACT_FREQUENCY: frequencyId, frequencyMhz when spoken; "change to my frequency" -> destination "MY_FREQUENCY".
- turn left/right heading N, fly heading N -> HEADING (headingDeg, turnDirection); "fly runway heading" -> destination "RUNWAY_HEADING"; "present heading" -> "PRESENT_HEADING".
- climb / descend / maintain N -> ALTITUDE (altitudeFt). "Maintain N until established on the localizer" -> ALTITUDE with destination "UNTIL_ESTABLISHED" ("UNTIL_<FIX>" plus fix for "until <fix>").
- reduce speed to N, slow to N, maintain N knots -> SPEED (speedKt); resume normal speed -> SPEED with destination "NORMAL_SPEED".
- enter left/right downwind / base runway N, make straight in -> ENTER_PATTERN (patternLeg, turnDirection = side, runwayEnd).
- extend downwind, turn base now, make short approach, make left/right 360 or 270, remain in closed traffic, make left closed traffic -> PATTERN_INSTRUCTION: destination EXTEND_DOWNWIND, TURN_BASE_NOW, SHORT_APPROACH, CIRCLE (turnDirection, turnDegrees) or CLOSED_TRAFFIC (turnDirection).
- report downwind / midfield / base / N mile final / final -> REPORT_POSITION: destination REPORT_MIDFIELD_DOWNWIND, REPORT_BASE or REPORT_FINAL (distanceNm).
- pushback approved [tail east / face south] -> PUSHBACK (pushTailDeg or pushFaceDeg).
- read back hold short instructions -> READ_BACK_HOLD. say again / repeat -> SAY_AGAIN. did you copy / how do you hear me -> DID_YOU_COPY. unable / request denied / not approved -> UNABLE.
- cleared ILS / localizer / RNAV / VOR / visual [approach] runway N -> APPROACH (approachType, runwayEnd, runwayId).
- proceed direct <fix> -> DIRECT_FIX (fix). resume own navigation -> RESUME_OWN_NAVIGATION. radar contact -> RADAR_CONTACT.
- cleared to <airport> via <route>, maintain N, expect N, departure frequency X, squawk NNNN; cleared to X as filed -> IFR_CLEARANCE (ifr* fields).
- hold at <fix> [as published] / hold <direction> of <fix> on the N radial, turns, legs, EFC -> HOLD_AT_FIX (hold* fields).
- cleared <STAR name> <number> arrival, descend via the <STAR name> arrival -> STAR: starName from the arrivals list ("ROZZE2"), starTransition when a transition fix of that arrival is named, descendVia true for "descend via".
- turn left/right at <taxiway>, exit left/right <taxiway>, turn right next taxiway, continue to the end (aircraft rolling out on a runway) -> EXIT_RUNWAY (turnDirection, exitTaxiway, ifAble for "if able"; destination "NEXT" or "END"). A following "hold short of runway N" or "contact ground" is its own command.
- cancel takeoff clearance, abort takeoff, reject takeoff -> CANCEL_TAKEOFF (reason = the words spoken after it).
- make a one eighty, turn around, reverse course (on a taxiway) -> TURN_AROUND.
- traffic, <type> <position> -> TRAFFIC_ADVISORY (traffic fields). [number N,] follow the <type> [position] -> FOLLOW_TRAFFIC (sequenceNumber, traffic fields).
- squawk VFR / squawk 4321 -> SQUAWK (squawk; destination "VFR" for "squawk VFR", squawk "1200"). frequency change approved, radar service terminated -> FREQUENCY_CHANGE_APPROVED.
- wind one three zero at eight, altimeter three zero one zero -> AIRPORT_INFO (info fields); when spoken together with another instruction, put the information on that command instead of a command of its own.
- caution bird activity ... -> ADVISORY with advisory BIRDS. braking action poor / medium to poor / ... -> ADVISORY with advisory BRAKING and brakingTerm (good, good to medium, medium, medium to poor, poor, nil).
- increase / decrease / set the runway lights [to step N] -> RUNWAY_LIGHTS (lightsDirection UP or DOWN, or lightStep 1..5).
- Vehicles and helicopters: proceed on runway N / on the taxiways -> PROCEED (destination "TAXIWAYS" for the taxiways); air taxi / hover taxi via A to the ramp -> AIR_TAXI (taxiMode air or hover, route, destination); overhead maneuver (pattern altitude, report initial, break at midfield) -> OVERHEAD (destination INITIAL or BREAK, altitudeFt, turnDirection).

# Examples

Aircraft: NKS451 (spoken "Spirit four fifty one", A320), N6004T ("Cessna six zero zero four tango", C172), N172SP ("Skyhawk one seven two sierra papa", C172). Runway ends 4, 22, 13, 31. Taxiways A, B, C.

1. "Spirit four fifty one taxi to runway four via alpha bravo, hold short of runway thirteen" -> one TAXI, callsign NKS451, destination RWY4, route [A, B], holdShort [RWY13].
2. "Spirit 451 runway one three line up and wait then cleared for takeoff fly heading one eight zero" -> LINE_UP_AND_WAIT (runwayEnd 13), then TAKEOFF (runwayEnd 13, departureHeading 180); both callsign NKS451.
3. "Cessna six zero zero four tango cross runway thirteen at bravo behind the landing Spirit four fifty one" -> CROSS_RUNWAY, callsign N6004T, crossRunwayId 13/31, runwayEnd 13, route [B], behindCallsign NKS451.
4. "the Cessna cross runway thirteen" -> two aircraft are Cessnas: one CROSS_RUNWAY with callsign null, crossRunwayId 13/31, note "two Cessnas in the list".
5. "Spirit four fifty one contact tower one two zero point niner" -> CONTACT_FREQUENCY, frequencyId TWR, frequencyMhz 120.9 (use the listed tower frequency when it matches).
6. "tax it to runway for via alpha, whole shore runway one three" (STT noise) -> TAXI destination RWY4 route [A], then HOLD_SHORT holdShort [RWY13], runwayEnd 13, runwayId 13/31, both for the callsign if one was heard.
7. "Spirit four fifty one descend and maintain three thousand, reduce speed to one eight zero" -> ALTITUDE altitudeFt 3000, then SPEED speedKt 180.
8. "Skyhawk one seven two sierra papa enter left downwind runway twenty two report midfield downwind" -> ENTER_PATTERN (patternLeg left_downwind, turnDirection left, runwayEnd 22), then REPORT_POSITION (destination REPORT_MIDFIELD_DOWNWIND).
9. "Spirit four fifty one roger, we'll hold short of runway four" (a pilot readback) -> no commands, note "readback, not an instruction".
10. "Tower, ground, request cross runway thirteen at alpha" (a landline call to another controller) -> no commands, note "landline call, not a radio instruction".
11. "Spirit four fifty one cleared ILS runway thirteen approach, maintain three thousand until established" -> APPROACH (approachType ILS, runwayEnd 13, runwayId 13/31), then ALTITUDE altitudeFt 3000 with destination UNTIL_ESTABLISHED.
12. "N6004T turn left at charlie, hold short of runway thirteen" -> EXIT_RUNWAY (turnDirection left, exitTaxiway C), then HOLD_SHORT (holdShort [RWY13], runwayEnd 13, runwayId 13/31).

In the examples the output is abbreviated: you must still return every field with its "not given" value.`;

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

type Prop = Record<string, unknown>;
const str: Prop = { type: 'string' };
const num: Prop = { type: 'number' };
const bool: Prop = { type: 'boolean' };
const strList: Prop = { type: 'array', items: { type: 'string' } };
const oneOf = (...values: string[]): Prop => ({ type: 'string', enum: ['', ...values] });
const nullableStr: Prop = { anyOf: [{ type: 'string' }, { type: 'null' }] };

const WIRE_PROPS: Record<string, Prop> = {
  kind: { type: 'string', enum: [...COMMAND_KINDS] },
  callsign: nullableStr,
  runwayEnd: str, runwayId: str, crossRunwayId: str, behindCallsign: str,
  route: strList, holdShort: strList,
  destination: str, exitTaxiway: str, fix: str, reason: str,
  frequencyId: str, squawk: str, starName: str, starTransition: str,
  headingDeg: num, departureHeading: num, altitudeFt: num, speedKt: num, frequencyMhz: num,
  turnDegrees: num, distanceNm: num, sequenceNumber: num, pushTailDeg: num, pushFaceDeg: num, lightStep: num,
  turnDirection: oneOf('left', 'right'),
  patternLeg: oneOf('left_downwind', 'right_downwind', 'straight_in', 'base'),
  approachType: oneOf('ILS', 'LOC', 'RNAV', 'VOR', 'VISUAL'),
  advisory: oneOf('BIRDS', 'BRAKING'),
  brakingTerm: oneOf('good', 'good to medium', 'medium', 'medium to poor', 'poor', 'nil'),
  lightsDirection: oneOf('UP', 'DOWN'),
  taxiMode: oneOf('air', 'hover'),
  ifAble: bool, segment: bool, descendVia: bool, trafficAdvised: bool, reportClear: bool,
  trafficDesc: str,
  trafficPosition: oneOf('final', 'base', 'downwind', 'upwind', 'crosswind', 'departing', 'in_position', 'on_runway', 'ahead'),
  trafficSide: oneOf('left', 'right'),
  trafficDistanceNm: num,
  windDirDeg: num, windSpeedKt: num, windGustKt: num, calm: bool, altimeterInHg: num,
  ifrDestination: str, ifrRouteText: str, ifrDepartureProcedure: str, ifrSquawk: str,
  ifrInitialAltitudeFt: num, ifrExpectAltitudeFt: num, ifrDepartureFrequencyMhz: num,
  holdFix: str, holdEfcZulu: str, holdInboundCourseDeg: num, holdLegMinutes: num, holdLegNm: num,
  holdTurns: oneOf('left', 'right'), holdAsPublished: bool,
};

export const LLM_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    commands: {
      type: 'array',
      items: {
        type: 'object',
        properties: WIRE_PROPS,
        required: Object.keys(WIRE_PROPS),
        additionalProperties: false,
      },
    },
    note: nullableStr,
  },
  required: ['commands', 'note'],
  additionalProperties: false,
} as const;

/** One command as the model returns it: every property present, "not given" sentinels instead of omissions. */
export type WireCommand = { kind: CommandKind; callsign: string | null } & Record<string, unknown>;
export interface WireResponse { commands: WireCommand[]; note: string | null }

/** Throws when the model output does not have the shape of `LLM_RESPONSE_SCHEMA` (used as the SDK `parse` hook). */
export function parseWireResponse(text: string): WireResponse {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as WireResponse).commands)) throw new Error('missing commands array');
  const { commands, note } = raw as WireResponse;
  for (const c of commands) {
    if (!c || typeof c !== 'object' || !COMMAND_KINDS.includes(c.kind)) throw new Error(`bad command kind ${String((c as { kind?: unknown })?.kind)}`);
  }
  return { commands, note: typeof note === 'string' && note.trim() ? note.trim() : null };
}

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== '' && v !== false && v !== NUM_UNSET && !(Array.isArray(v) && v.length === 0);

const SIMPLE_FIELDS = [
  'runwayEnd', 'runwayId', 'crossRunwayId', 'behindCallsign', 'route', 'holdShort', 'destination', 'exitTaxiway', 'fix', 'reason',
  'frequencyId', 'squawk', 'starName', 'starTransition', 'headingDeg', 'departureHeading', 'altitudeFt', 'speedKt', 'frequencyMhz',
  'turnDegrees', 'distanceNm', 'sequenceNumber', 'pushTailDeg', 'pushFaceDeg', 'lightStep', 'turnDirection', 'patternLeg',
  'approachType', 'advisory', 'brakingTerm', 'lightsDirection', 'taxiMode', 'ifAble', 'segment', 'descendVia', 'trafficAdvised', 'reportClear',
] as const;

/** Pick the set fields of `src` under the names in `map` (output name -> wire name). */
function pick(src: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [to, from] of Object.entries(map)) if (isSet(src[from])) out[to] = src[from];
  return out;
}

/** Wire command -> `LlmCommand`: sentinels dropped, flat traffic / info / ifr / hold fields regrouped. */
export function toLlmCommand(w: WireCommand): LlmCommand {
  const out: Record<string, unknown> = { kind: w.kind, callsign: typeof w.callsign === 'string' && w.callsign ? w.callsign : null };
  for (const f of SIMPLE_FIELDS) if (isSet(w[f])) out[f] = w[f];

  const traffic = pick(w, { desc: 'trafficDesc', position: 'trafficPosition', side: 'trafficSide', distanceNm: 'trafficDistanceNm' });
  if (Object.keys(traffic).length > 0) out.traffic = { desc: '', ...traffic };

  const info = pick(w, { windDirDeg: 'windDirDeg', windSpeedKt: 'windSpeedKt', windGustKt: 'windGustKt', calm: 'calm', altimeterInHg: 'altimeterInHg' });
  if (Object.keys(info).length > 0) out.info = info;

  const ifr = pick(w, {
    destination: 'ifrDestination', routeText: 'ifrRouteText', departureProcedure: 'ifrDepartureProcedure', squawk: 'ifrSquawk',
    initialAltitudeFt: 'ifrInitialAltitudeFt', expectAltitudeFt: 'ifrExpectAltitudeFt', departureFrequencyMhz: 'ifrDepartureFrequencyMhz',
  }) as Partial<IfrClearanceDetails>;
  if (Object.keys(ifr).length > 0) out.ifr = ifr;

  if (w.kind === 'HOLD_AT_FIX' || isSet(w.holdFix)) {
    const hold = pick(w, {
      fix: 'holdFix', inboundCourseDeg: 'holdInboundCourseDeg', turns: 'holdTurns', legMinutes: 'holdLegMinutes', legNm: 'holdLegNm', efcZulu: 'holdEfcZulu',
    }) as Partial<HoldingInstruction>;
    hold.asPublished = w.holdAsPublished === true;
    hold.turns ??= 'right';
    out.hold = hold;
  }
  return out as unknown as LlmCommand;
}
