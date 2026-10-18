/**
 * Training scenarios: calm weather, no readback errors, unsafe clearances refused (engine `mode: 'training'`), and a
 * `training.steps` walk-through. Every `reference` was verified on the FAA site (see ../references.ts); explanations are paraphrased and only the short phraseology patterns the order prescribes are repeated (audited in docs/PHRASEOLOGY-AUDIT.md).
 */
import { refText, refTexts, KACY_READBACK_NOTE } from '../references';
import type { TrainingStepSpec } from '../types';
import { NM, endOf, norm360, planDepartureTaxi } from '../world';
import { arrivalProcedure } from '../ifr';
import { findNavFix } from '../../sim/navigation';
import { GROUND_AND_TOWER, TOWER_AND_GROUND, arrivalInPattern, arrivalOnFinal, holdingShort, ifrDeparture, parkedDeparture, vfrWeather } from './common';
import type { Airport } from '../../sim/types';
import type { ScenarioDef } from './common';

const calm = () => vfrWeather(110, 6);
const MISTAKE_CONDITIONAL = 'Conditional instructions such as "line up and wait behind the landing traffic" or "taxi across behind the departing aircraft" are not allowed; issue a separate, unconditional instruction when the situation allows it.';

function def(
  id: string, name: string, difficulty: number, minutes: number, description: string, topic: string,
  build: ScenarioDef['build'],
): ScenarioDef {
  return { summary: { id, name, description: `${description} Topic: ${topic}.`, mode: 'training', difficulty, estimatedMinutes: minutes }, build };
}

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const digits = (n: number, width = 3): string => String(Math.round(n)).padStart(width, '0').split('').map((d) => DIGIT_WORDS[Number(d)]).join(' ');

/** Where `fixId` lies relative to the final approach course of `endId`: distance out, lateral offset (+ = right of the course) and the heading that intercepts at `angleDeg`. */
function interceptGeometry(airport: Airport, fixId: string, endId: string, angleDeg: number): { alongNm: number; crossNm: number; turn: 'left' | 'right'; headingMag: number; angleDeg: number } {
  const e = endOf(airport, endId);
  const p = findNavFix(airport, fixId)!.pos;
  const h = (e.trueHeadingDeg * Math.PI) / 180;
  const dir = { x: Math.sin(h), y: Math.cos(h) };
  const dx = p.x - e.threshold.x;
  const dy = p.y - e.threshold.y;
  const alongNm = -(dx * dir.x + dy * dir.y) / NM;
  const crossNm = (dx * dir.y - dy * dir.x) / NM; // + = right of the inbound course
  const turn: 'left' | 'right' = crossNm > 0 ? 'left' : 'right';
  const sign = turn === 'left' ? -1 : 1;
  const courseMag = norm360(e.trueHeadingDeg - airport.magneticVariationDeg);
  // Round to 5 degrees, never steeper than 30 degrees against the course.
  let headingMag = Math.round(norm360(courseMag + sign * angleDeg) / 5) * 5;
  let eff = Math.abs(((headingMag - courseMag + 540) % 360) - 180);
  if (eff > 29) {
    headingMag = norm360(headingMag - sign * 5);
    eff = Math.abs(((headingMag - courseMag + 540) % 360) - 180);
  }
  return { alongNm, crossNm, turn, headingMag: headingMag % 360 || 360, angleDeg: eff };
}

export const TRAINING_SCENARIOS: ScenarioDef[] = [
  // ---------------------------------------------------------------- 1
  def('train-01-phraseology', 'Training 1: Takeoff phraseology', 1, 5, 'Line up, takeoff clearance and handoff for a Cessna holding short of runway 13.', 'correct phraseology',
    (airport, o) => ({
      id: 'train-01-phraseology', name: 'Training 1: Takeoff phraseology', mode: 'training', seed: o?.seed ?? 201,
      description: 'Cessna N723EJ is holding short of runway 13. Practise the standard order of a departure: runway first, then the instruction, with the callsign. Unsafe clearances are refused and explained.',
      weather: calm(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR'],
      spawns: [holdingShort(airport, 'N723EJ', 'C172', '13', 0)],
      objectives: [{ id: 'takeoff', text: 'N723EJ takes off', check: 'takeoff:N723EJ' }],
      training: {
        steps: [
          {
            id: 'line-up', callsign: 'N723EJ', expectCommand: 'LINE_UP_AND_WAIT', reference: refText('3-9-4'),
            prompt: 'N723EJ is holding short of runway 13 and ready. Put it on the runway: say the runway number, then "line up and wait".',
            example: 'Cessna seven two three echo juliet, runway one three, line up and wait.',
            explanation: 'Line up and wait positions an aircraft for an imminent departure when a takeoff clearance cannot be issued yet. The runway number comes first, then the instruction. The aircraft should not sit in position for more than about 90 seconds without further instructions.',
            mistakes: [MISTAKE_CONDITIONAL, 'Leaving out the runway number.', 'Leaving the aircraft in position and forgetting it.'],
          },
          {
            id: 'takeoff', callsign: 'N723EJ', expectCommand: 'TAKEOFF', reference: refText('3-9-10'),
            prompt: 'The runway is clear. Clear N723EJ for takeoff.',
            example: 'Cessna seven two three echo juliet, runway one three, cleared for takeoff.',
            explanation: 'A takeoff clearance states the runway number first, then "cleared for takeoff". It is the only thing that authorises the takeoff roll, and the pilot should read it back with the runway and the callsign (7110.65 2-4-3 asks controllers to make sure runway and hold-short items are read back).',
            mistakes: ['Saying only "cleared for takeoff" without the runway number.', 'Using "take off" or "go ahead" - those are not takeoff clearances (4-3-1: avoid the word "takeoff" except to clear or cancel a takeoff).', 'Issuing it while another aircraft or vehicle is on the runway.'],
          },
          {
            id: 'handoff', callsign: 'N723EJ', expectCommand: 'CONTACT_FREQUENCY', reference: refText('2-1-17'),
            prompt: 'N723EJ is airborne and leaving your airspace. Tell it to contact Departure on 124.6.',
            example: 'Cessna seven two three echo juliet, contact departure one two four point six.',
            explanation: 'After you transfer an aircraft it leaves your frequency and no longer hears you. Give the facility and frequency, with the callsign, and let the pilot read it back. 7110.65 2-1-17 gives the form "Contact (facility and function), (frequency)": "contact departure one two four point six". The location name is omitted when the tower and the TRACON share a name, as they do at Atlantic City.',
            mistakes: ['Transferring the aircraft before it is clear of conflicts with your other traffic.', 'Forgetting the frequency.'],
          },
        ] satisfies TrainingStepSpec[],
      },
      durationSec: 600,
    })),

  // ---------------------------------------------------------------- 2
  def('train-02-taxi', 'Training 2: Taxi clearances', 2, 8, 'Route a Cessna from the GA ramp to the runway 13 hold line and hand it to Tower.', 'clearance requirements and runway safety',
    (airport, o) => {
      const plan = planDepartureTaxi(airport, 'GA-2', '13', ['D', 'A']);
      if (!plan) throw new Error('train-02: no route');
      return {
        id: 'train-02-taxi', name: 'Training 2: Taxi clearances', mode: 'training', seed: o?.seed ?? 202,
        description: 'Cessna N482KB is parked on GA ramp 2. You are Ground, with Tower as a second position. A taxi instruction is not a runway clearance: the aircraft stops at the hold line.',
        weather: calm(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: GROUND_AND_TOWER,
        spawns: [parkedDeparture('N482KB', 'C172', 'GA-2', 0)],
        objectives: [{ id: 'takeoff', text: 'N482KB takes off', check: 'takeoff:N482KB' }],
        training: {
          steps: [
            {
              id: 'taxi', callsign: 'N482KB', expectCommand: 'TAXI', reference: refTexts('3-7-2', '3-7-1'),
              prompt: 'N482KB asks to taxi. State the runway first, then the route to it (delta, alpha), and tell it to hold short of the runway.',
              example: 'Cessna four eight two kilo bravo, runway one three, taxi via delta, alpha, hold short of runway one three.',
              explanation: 'When you authorise taxi to a takeoff runway, state the departure runway first and then the specific route: "Runway (number), taxi via (route), hold short of (runway)". The route is mandatory, and the pilot\'s readback with the runway number confirms the runway assignment (3-7-2). Use "taxi" - never "cleared to taxi": the word "cleared" is kept for runway and approach clearances (3-7-1).',
              mistakes: ['"Cleared to taxi" instead of "taxi".', 'A destination with no route ("taxi to runway one three").', '"Taxi as requested" or "proceed as requested" - not approved wording.', 'Not checking the readback of the hold-short instruction.'],
            },
            {
              id: 'wait-hold', callsign: 'N482KB', check: 'holding_short:N482KB', reference: refText('3-7-2'),
              prompt: 'Wait. N482KB taxis to the runway 13 hold line and reports. Do not give it any runway instruction yet.',
              explanation: 'A taxi route never authorises entering a runway. The aircraft stops at the hold line and waits for a line up, takeoff or crossing clearance from the controller who owns the runway.',
              mistakes: ['Assuming it will stop by itself in the right place - say hold short.'],
            },
            {
              id: 'to-tower', callsign: 'N482KB', expectCommand: 'CONTACT_FREQUENCY', reference: refText('3-1-3'),
              prompt: 'N482KB is at the hold line. Ground is done: switch it to Tower on 120.3.',
              example: 'Cessna four eight two kilo bravo, contact tower one two zero point three.',
              explanation: 'The local (Tower) controller has primary responsibility for the active runway, so runway operations are handled on the Tower frequency.',
              mistakes: ['Issuing a takeoff clearance on the Ground frequency.'],
            },
            {
              id: 'takeoff', callsign: 'N482KB', expectCommand: 'TAKEOFF', reference: refText('3-9-10'),
              prompt: 'Switch to Tower. Once N482KB checks in, clear it for takeoff from runway 13 (the runway is empty).',
              example: 'Cessna four eight two kilo bravo, runway one three, cleared for takeoff.',
              explanation: 'Runway number first, then the clearance. It is issued only after you have confirmed the runway is clear of aircraft and vehicles.',
              mistakes: ['Clearing for takeoff without looking at the runway.', 'Forgetting to switch to the Tower position first (the pilot will not answer: "not on frequency").'],
            },
          ] satisfies TrainingStepSpec[],
        },
        durationSec: 900,
        briefing: `Route about ${Math.round(plan.lengthM)} m via ${plan.taxiways.join(' ')}.`,
      };
    }),

  // ---------------------------------------------------------------- 3
  def('train-03-runway-safety', 'Training 3: Landing traffic and runway safety', 3, 8, 'A landing Airbus and a Cessna holding short: who goes first, and why.', 'runway safety and clearance requirements',
    (airport, o) => ({
      id: 'train-03-runway-safety', name: 'Training 3: Landing traffic and runway safety', mode: 'training', seed: o?.seed ?? 203,
      description: 'Spirit 451 is 6 nm out on the runway 13 final. Cessna N723EJ is holding short, ready. The simulator will refuse any clearance that puts two aircraft on the runway; read the explanation when it does.',
      weather: calm(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
      spawns: [arrivalOnFinal(airport, 'NKS451', 'A320', '13', 6, 0), holdingShort(airport, 'N723EJ', 'C172', '13', 0)],
      objectives: [{ id: 'both', text: 'NKS451 lands and N723EJ takes off', check: 'landed:NKS451' }, { id: 'to', text: 'N723EJ takes off', check: 'takeoff:N723EJ' }],
      training: {
        steps: [
          {
            id: 'land', callsign: 'NKS451', expectCommand: 'LAND', reference: refTexts('3-10-5', '3-10-3'),
            prompt: 'NKS451 reports inbound. Clear it to land on runway 13. N723EJ stays at the hold line.',
            example: 'Spirit four fifty one, runway one three, cleared to land.',
            explanation: 'The landing clearance states the runway number first, then "cleared to land". Separation on a shared runway means the arrival must not cross the threshold until the aircraft ahead has landed and cleared the runway, or has departed and crossed the end.',
            mistakes: ['Omitting the runway number.', 'Clearing to land while another aircraft is lined up or rolling on the same runway.'],
          },
          {
            id: 'wait-clear', callsign: 'NKS451', check: 'vacated:NKS451', reference: refText('3-9-6'),
            prompt: 'The runway now belongs to the landing Airbus. Do NOT line up or clear N723EJ for takeoff; wait for NKS451 to land and report clear of the runway. (The simulator refuses a takeoff clearance once the arrival is inside 2 nm or the runway is occupied, and explains why.)',
            explanation: 'A departure may not begin its takeoff roll until the preceding landing aircraft is clear of the runway. Clearing the Cessna while the Airbus is landing would put two aircraft on the runway. (In real operations you may depart an aircraft ahead of an arrival only when the separation will exist; the simulator simplifies that to a 2 nm check.)',
            mistakes: ['"Line up and wait behind the landing Airbus" - a conditional instruction.', 'Clearing for takeoff because the arrival "looks far enough away" once it is on short final.'],
          },
          {
            id: 'to-ground', callsign: 'NKS451', expectCommand: 'CONTACT_FREQUENCY', reference: refText('3-10-9'),
            prompt: 'NKS451 is clear of the runway. Send it to Ground on 121.9.',
            example: 'Spirit four fifty one, contact ground one two one point niner.',
            explanation: 'After landing, aircraft are told where to exit and whether to hold short of anything, then switched to Ground. An aircraft is expected to taxi clear of the runway unless told otherwise.',
            mistakes: ['Leaving the aircraft on Tower frequency while it taxis.'],
          },
          {
            id: 'takeoff', callsign: 'N723EJ', expectCommand: 'TAKEOFF', reference: refTexts('3-9-10', '3-9-6'),
            prompt: 'The runway is now empty. Clear N723EJ for takeoff.',
            example: 'Cessna seven two three echo juliet, runway one three, cleared for takeoff.',
            explanation: 'With the arrival clear, the runway is yours again. Check it, then issue the clearance with the runway number first.',
            mistakes: ['Forgetting that the Cessna has been holding short a long time: confirm it is still there.'],
          },
        ] satisfies TrainingStepSpec[],
      },
      durationSec: 900,
    })),

  // ---------------------------------------------------------------- 4
  def('train-04-crossing', 'Training 4: Runway crossings and hold-short readbacks', 3, 10, 'Cross runway 13/31 at Alpha with a hold-short readback, the way the KACY diagram asks.', 'communication procedures and runway safety',
    (airport, o) => {
      const plan = planDepartureTaxi(airport, 'GA-3', '22', ['A']);
      if (!plan || !plan.crossings.some((c) => c.runwayId === '13/31')) throw new Error('train-04: route does not cross 13/31');
      return {
        id: 'train-04-crossing', name: 'Training 4: Runway crossings and hold-short readbacks', mode: 'training', seed: o?.seed ?? 204,
        description: `Cessna N60DX (GA ramp 3) wants runway 22. The route via Alpha crosses runway 13/31. ${KACY_READBACK_NOTE}`,
        weather: calm(), activeRunways: { departing: ['13', '22'], landing: ['13'] }, controllerPositions: GROUND_AND_TOWER,
        spawns: [parkedDeparture('N60DX', 'C172', 'GA-3', 0)],
        objectives: [{ id: 'crossed', text: 'N60DX crosses runway 13/31', check: 'crossed:N60DX:13/31' }],
        training: {
          steps: [
            {
              id: 'taxi', callsign: 'N60DX', expectCommand: 'TAXI', reference: refTexts('3-7-2', '2-4-3'),
              prompt: 'N60DX asks to taxi. State runway 22 first, give it a route via alpha, and tell it to hold short of runway 13.',
              example: 'Cessna six zero delta x-ray, runway two two, taxi via alpha, hold short of runway one three.',
              explanation: 'When the aircraft is to stop short of a runway, issue the route up to that runway hold-short point (3-7-2); for any other hold-short point you may give the route up to it, or the whole route and then the hold-short instruction. A crossing is a separate clearance for each runway. You must also make sure the pilot reads back the hold-short instruction - at KACY the airport diagram itself requires readback of all runway holding instructions, and 7110.65 2-4-3 and 3-7-2 require the controller to obtain it ("read back hold instructions" if it is missing).',
              mistakes: ['No hold-short instruction when you want the aircraft to stop short of the runway.', 'Accepting a readback that leaves out the hold-short, the runway or the callsign (pilots must use their callsign in a readback; the simulated pilots put it last).'],
            },
            {
              id: 'wait-report', callsign: 'N60DX', check: 'crossing_request:N60DX', reference: refText('3-7-2'),
              prompt: 'Wait for N60DX to taxi up to the runway 13/31 hold line at Alpha and report.',
              explanation: 'The aircraft stops at the hold line. Crossing a runway is a separate clearance that you issue only when the runway is clear.',
              mistakes: ['Telling it to cross before it has arrived at the hold line (the pilot will say it is not at the runway yet).'],
            },
            {
              id: 'cross', callsign: 'N60DX', expectCommand: 'CROSS_RUNWAY', reference: refTexts('3-7-2', '3-1-3'),
              prompt: 'Check runway 13/31 is empty, then tell N60DX to cross runway 13 at alpha.',
              example: 'Cessna six zero delta x-ray, cross runway one three at alpha.',
              explanation: 'The crossing instruction names the runway and where to cross ("Cross (runway) at (taxiway)"). The ground controller must coordinate with the local controller before authorising a crossing of an active runway; here you are both, so look at the runway first.',
              mistakes: ['"Taxi across" or "proceed across" - say "cross runway ... at ...".', 'Crossing in front of an arrival that is on short final.', 'Issuing the crossing without the runway number.'],
            },
            {
              id: 'wait-cross', callsign: 'N60DX', check: 'crossed:N60DX:13/31', reference: refText('3-1-12'),
              prompt: 'Watch N60DX cross and clear the far side of the runway before you use runway 13/31 for anything else.',
              explanation: 'Local control must scan the runway, and ground control must help. The runway is not available again until the whole aircraft has cleared it.',
              mistakes: ['Clearing a departure or landing the moment the aircraft starts to cross.'],
            },
          ] satisfies TrainingStepSpec[],
        },
        durationSec: 900,
      };
    }),

  // ---------------------------------------------------------------- 5
  def('train-05-sequencing', 'Training 5: Sequencing two arrivals', 3, 8, 'A slow Cessna ahead of a fast Airbus on the same final.', 'aircraft sequencing',
    (airport, o) => ({
      id: 'train-05-sequencing', name: 'Training 5: Sequencing two arrivals', mode: 'training', seed: o?.seed ?? 205,
      description: 'Cessna N723EJ is 4 nm out and slow; Spirit 451 is 11 nm out and faster. Establish the landing order and use speed to keep space between them.',
      weather: calm(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
      spawns: [arrivalOnFinal(airport, 'N723EJ', 'C172', '13', 4, 0, { speedKt: 85 }), arrivalOnFinal(airport, 'NKS451', 'A320', '13', 11, 0)],
      objectives: [{ id: 'both', text: 'Both aircraft land', check: 'landed:NKS451' }, { id: 'first', text: 'N723EJ lands', check: 'landed:N723EJ' }],
      training: {
        steps: [
          {
            id: 'lead', callsign: 'N723EJ', expectCommand: 'LAND', reference: refText('3-10-5'),
            prompt: 'N723EJ is the closer aircraft and number one. Clear it to land runway 13.',
            example: 'Cessna seven two three echo juliet, runway one three, cleared to land.',
            explanation: 'Landing order follows position on the final unless you change it. The leader gets the landing clearance first; the following aircraft is told what to expect.',
            mistakes: ['Clearing the faster aircraft first and leaving the slower one inside it.'],
          },
          {
            id: 'space', callsign: 'NKS451', expectCommand: 'SPEED', reference: refTexts('5-7-2', '3-8-1'),
            prompt: 'NKS451 is faster and will close on the Cessna. Reduce its speed to 140 knots to build spacing.',
            example: 'Spirit four fifty one, reduce speed to one four zero.',
            explanation: 'Sequence and spacing are established by having aircraft adjust their flight (speed, path, or pattern) as necessary - here, a speed reduction for the faster aircraft. Speed phraseology is "Reduce speed to" and the separate digits of the speed (5-7-2); the word "knots" may be left out.',
            mistakes: ['Waiting until the Airbus is nearly on top of the Cessna.', 'Issuing a speed outside what the aircraft can fly.'],
          },
          {
            id: 'wait-lead', callsign: 'N723EJ', check: 'vacated:N723EJ', reference: refText('3-10-3'),
            prompt: 'Wait for N723EJ to land and report clear of the runway.',
            explanation: 'The second arrival may not cross the landing threshold until the first one has landed and is clear of the runway (or the minimum distance applies in daylight). In the simulator an arrival without a usable runway goes around at 0.5 nm.',
            mistakes: ['Clearing the Airbus too late - it goes around if it has no clearance at 0.5 nm.'],
          },
          {
            id: 'follow', callsign: 'NKS451', expectCommand: 'LAND', reference: refTexts('3-10-5', '3-10-3'),
            prompt: 'The runway is clear. Clear NKS451 to land.',
            example: 'Spirit four fifty one, runway one three, cleared to land.',
            explanation: 'Now the runway meets the separation requirement, so the clearance can be issued.',
            mistakes: ['Issuing the clearance while the Cessna is still on the runway.'],
          },
        ] satisfies TrainingStepSpec[],
      },
      durationSec: 900,
    })),

  // ---------------------------------------------------------------- 6
  def('train-06-pattern', 'Training 6: Pattern entry and landing', 2, 8, 'Bring a Cessna into the left downwind for runway 13 and land it.', 'communication procedures and sequencing',
    (airport, o) => ({
      id: 'train-06-pattern', name: 'Training 6: Pattern entry and landing', mode: 'training', seed: o?.seed ?? 206,
      description: 'Cessna N59TB is joining the runway 13 pattern on the left (north-east) side, abeam the runway. Give it a pattern entry, then a landing clearance, then Ground.',
      weather: calm(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
      spawns: [arrivalInPattern(airport, 'N59TB', '13', 'left', 1.5, 0)],
      objectives: [{ id: 'land', text: 'N59TB lands', check: 'landed:N59TB' }],
      training: {
        steps: [
          {
            id: 'enter', callsign: 'N59TB', expectCommand: 'ENTER_PATTERN', reference: refText('3-8-1'),
            prompt: 'N59TB is inbound for landing. Tell it to enter a left downwind for runway 13.',
            example: 'Cessna five nine tango bravo, enter left downwind runway one three.',
            explanation: 'Pattern instructions are how the tower builds the arrival sequence: entry leg, runway, and later "extend downwind", "make short approach" or a number in the landing order (3-8-1). The AIM (4-3-2) shows the same entry form for a downwind with a runway number.',
            mistakes: ['Leaving out the runway.', 'Giving a pattern entry on the wrong side for the traffic flow.'],
          },
          {
            id: 'land', callsign: 'N59TB', expectCommand: 'LAND', reference: refText('3-10-5'),
            prompt: 'N59TB turns final and calls. Clear it to land on runway 13.',
            example: 'Cessna five nine tango bravo, runway one three, cleared to land.',
            explanation: 'Runway number, then "cleared to land". "Cleared for the option" is also a landing clearance, but it permits a touch-and-go, stop-and-go or low approach too.',
            mistakes: ['Clearing it to land before it is established and while the runway is not yet yours.'],
          },
          {
            id: 'exit', callsign: 'N59TB', expectCommand: 'CONTACT_FREQUENCY', reference: refText('3-10-9'),
            prompt: 'After landing N59TB reports clear of the runway. Send it to Ground on 121.9.',
            example: 'Cessna five nine tango bravo, contact ground one two one point niner.',
            explanation: 'Landing aircraft are expected to taxi clear of the runway; once clear, they go to Ground. Keep the Tower frequency free for runway work.',
            mistakes: ['Leaving the aircraft on Tower frequency.'],
          },
        ] satisfies TrainingStepSpec[],
      },
      durationSec: 900,
    })),

  // ---------------------------------------------------------------- 7
  def('train-07-go-around', 'Training 7: In position, then go around', 4, 8, 'A Cessna in position and an Airbus on final: what you must NOT do, and the go-around.', 'common mistakes',
    (airport, o) => ({
      id: 'train-07-go-around', name: 'Training 7: In position, then go around', mode: 'training', seed: o?.seed ?? 207,
      description: 'Cessna N723EJ is holding short of 13 and Spirit 451 is 5 nm out. If you line the Cessna up, you cannot also clear the Airbus to land.',
      weather: calm(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
      spawns: [arrivalOnFinal(airport, 'NKS451', 'A320', '13', 5, 0), holdingShort(airport, 'N723EJ', 'C172', '13', 0)],
      objectives: [{ id: 'dep', text: 'N723EJ takes off', check: 'takeoff:N723EJ' }],
      training: {
        steps: [
          {
            id: 'line-up', callsign: 'N723EJ', expectCommand: 'LINE_UP_AND_WAIT', reference: refText('3-9-4'),
            prompt: 'Line up N723EJ on runway 13 (Spirit 451 is 5 nm out and you intend to depart the Cessna first). Tell it about the landing traffic within 6 miles.',
            example: 'Cessna seven two three echo juliet, runway one three, line up and wait. Traffic, an Airbus three twenty, five mile final.',
            explanation: 'Line up and wait is for an imminent departure, and the aircraft in position is told about landing traffic within about 6 miles (for example "traffic, a Boeing 737, six mile final"). Once an aircraft is in position, the same runway cannot also be given to a landing aircraft (without the safety logic used at some facilities), so you must make the departure happen or send the arrival around.',
            mistakes: [MISTAKE_CONDITIONAL],
          },
          {
            id: 'go-around', callsign: 'NKS451', expectCommand: 'GO_AROUND', check: 'go_around:NKS451', reference: refTexts('3-8-1', '3-9-4', '3-10-5'),
            prompt: 'Spirit 451 is on final and the Cessna is still in position. Do not clear it to land - tell it to go around.',
            example: 'Spirit four fifty one, go around.',
            explanation: '"Go around" (with further instructions if needed) is the 3-8-1 phraseology. A landing clearance cannot be issued while another aircraft is holding in position on the runway. When the Cessna cannot depart in time, the arrival is sent around. (If you wait too long the Airbus goes around by itself at 0.5 nm without a clearance - that also completes the step.)',
            mistakes: ['Clearing the Airbus to land with the Cessna in position (the simulator refuses it in training mode).', 'Leaving the Cessna in position for minutes while you decide.'],
          },
          {
            id: 'takeoff', callsign: 'N723EJ', expectCommand: 'TAKEOFF', reference: refText('3-9-10'),
            prompt: 'Now that the arrival is not a factor, clear N723EJ for takeoff.',
            example: 'Cessna seven two three echo juliet, runway one three, cleared for takeoff.',
            explanation: 'The aircraft in position gets its takeoff clearance as soon as the runway is yours.',
            mistakes: ['Forgetting the aircraft in position.'],
          },
        ] satisfies TrainingStepSpec[],
      },
      durationSec: 900,
    })),

  // ---------------------------------------------------------------- 8
  def('train-08-ifr-clearance', 'Training 8: IFR clearance delivery', 4, 8, 'Read an IFR departure clearance to a Spirit A320 on Clearance Delivery, item by item.', 'clearance requirements and communication procedures',
    (airport, o) => ({
      id: 'train-08-ifr-clearance', name: 'Training 8: IFR clearance delivery', mode: 'training', seed: o?.seed ?? 208,
      description: 'Spirit 451 is at Gate 1, IFR to Philadelphia, and will call Clearance Delivery (127.85) in a few seconds. You are the Clearance Delivery controller: read the clearance with every element in order. The pilot reads it back and then calls Ground by itself.',
      weather: calm(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['CLNC'],
      spawns: [ifrDeparture(airport, 'NKS451', 'A320', 'GATE-1', 0, 'KPHL', 10000)],
      objectives: [{ id: 'clearance', text: 'Issue NKS451 its IFR clearance', check: 'ifr_clearance:NKS451' }],
      training: {
        steps: [
          {
            id: 'wait-call', callsign: 'NKS451', check: 'ifr_request:NKS451', reference: refText('4-3-3'),
            prompt: 'Wait for NKS451 to call Clearance Delivery. Do not read the clearance until the pilot has asked for it.',
            explanation: 'An IFR clearance is issued on request: the pilot calls with the facility name, the aircraft identification, the destination and the ATIS letter ("information Bravo received"), and then writes the clearance down ("ready to copy"). Reading it before the call gets a "we have not called for our clearance" answer.',
            mistakes: ['Issuing the clearance before the pilot has called.'],
          },
          {
            id: 'clearance', callsign: 'NKS451', expectCommand: 'IFR_CLEARANCE', reference: refTexts('4-2-1', '4-3-2', '3-9-3'),
            prompt: 'NKS451 is ready to copy. Issue the IFR clearance: cleared to Philadelphia airport, the Atlantic City Three departure with radar vectors, maintain two thousand, expect 10,000 ten minutes after departure, departure frequency 124.6, and a squawk code of your choice.',
            example: 'Spirit four fifty one, cleared to Philadelphia airport, Atlantic City Three departure, radar vectors, maintain two thousand, expect one zero thousand, one zero minutes after departure, departure frequency one two four point six, squawk four two one five.',
            explanation:
              'Give the items in this order. (1) The aircraft identification, so the right pilot answers. (2) The clearance limit: "cleared to Philadelphia airport" - when the limit is an airport, the word "airport" follows the name. ' +
              '(3) The departure procedure or vectors: "Atlantic City Three departure, radar vectors" - the 4-3-2 form is "(name and number) departure", with no "via"; at KACY the published procedure gives only the runway heading and Departure vectors the aircraft to the filed route (the chart says maintain 2000, expect the filed altitude ten minutes after departure). ' +
              '(4) The route, here covered by radar vectors (otherwise the filed route or "as filed"). (5) The altitude data in the order flown: "maintain two thousand" is the initial altitude, "expect one zero thousand, one zero minutes after departure" is the cruise altitude the pilot should plan for (digits are spoken one at a time: "one zero minutes"). ' +
              '(6) The departure frequency, 124.6 (Approach and Departure share it at KACY; the chart also shows 134.25 for the north sector), as "departure frequency ...", and (7) the transponder code ("squawk ..."; 3-9-3 puts frequency and code together): four digits, each 0 to 7, never 0000, 1200, 7500, 7600 or 7700, and not a code another aircraft already uses. The pilot reads the whole clearance back; the aircraft then switches to Ground by itself and asks for taxi.',
            mistakes: [
              'Leaving out "cleared to <destination>" - the destination is the clearance limit.',
              'A squawk code with an 8 or a 9, or a reserved or duplicate code.',
              'Giving the clearance on Ground: IFR aircraft call Clearance Delivery first (127.85).',
              'Dropping the departure frequency, so the pilot cannot call Departure after takeoff.',
            ],
          },
          {
            id: 'wait-ground', callsign: 'NKS451', check: 'handoff:NKS451', reference: refText('4-3-2'),
            prompt: 'Wait. The pilot reads the clearance back, then tunes Ground on its own and asks for taxi. Clearance Delivery is finished.',
            explanation: 'The pilot is now cleared. In a full session it goes Ground (taxi), Tower (takeoff clearance, then a handoff to Departure) and Departure (radar contact, climb, direct to the first fix). Takeoff without this clearance is refused in training and counted as a communication error in other modes.',
            mistakes: ['Telling the aircraft to contact Ground yourself - it does that itself after the readback.'],
          },
        ] satisfies TrainingStepSpec[],
      },
      durationSec: 600,
    })),

  // ---------------------------------------------------------------- 9
  def('train-09-approach', 'Training 9: Vectors to the ILS and approach clearance', 5, 10, 'Vector a Spirit A320 to the ILS 13 final, clear it for the approach and hand it to Tower.', 'sequencing and clearance requirements',
    (airport, o) => {
      const proc = arrivalProcedure(airport, '13');
      if (!proc?.feederFix || proc.approachType !== 'ILS') throw new Error('train-09: runway 13 has no ILS with a feeder fix');
      const g = interceptGeometry(airport, proc.feederFix, '13', 28);
      const hdg = digits(g.headingMag);
      const faf = proc.fafFix ? `${proc.fafFix}, ${proc.fafNm?.toFixed(1)} nm from the threshold` : 'the final approach fix';
      return {
        id: 'train-09-approach', name: 'Training 9: Vectors to the ILS and approach clearance', mode: 'training', seed: o?.seed ?? 209,
        description: `Spirit 451 has checked in on Approach (124.6) over ${proc.feederFix} at 4,000 ft, about ${Math.round(g.alongNm)} nm from the runway 13 threshold and ${Math.abs(g.crossNm).toFixed(1)} nm ${g.crossNm > 0 ? 'right' : 'left'} of the final approach course. ` +
          'Turn it onto an intercept heading, clear it for the ILS, then hand it to Tower once it reports established.',
        weather: calm(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['APP', 'DEP', 'TWR'],
        spawns: [{
          atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP', initialRequest: 'APPROACH',
          start: { kind: 'at_fix', fix: proc.feederFix, altitudeFt: 4000, speedKt: 180, route: [proc.feederFix], runwayEnd: '13' },
        }],
        objectives: [
          { id: 'approach', text: 'Clear NKS451 for the ILS 13 approach', check: 'approach:NKS451' },
          { id: 'established', text: 'NKS451 is established on the ILS', check: 'established:NKS451' },
          { id: 'tower', text: 'Hand NKS451 off to Tower', check: 'handoff:NKS451' },
        ],
        training: {
          steps: [
            {
              id: 'vector', callsign: 'NKS451', expectCommand: 'HEADING', reference: refTexts('5-9-2', '5-9-1'),
              prompt: `Vector NKS451 to intercept the runway 13 final approach course: turn ${g.turn} to a heading that meets the course at no more than 30 degrees. About ${Math.round(g.angleDeg)} degrees (heading ${String(g.headingMag).padStart(3, '0')}) works here: the aircraft is ${Math.abs(g.crossNm).toFixed(1)} nm off the course, so it intercepts about ${(Math.abs(g.crossNm) / Math.sin((g.angleDeg * Math.PI) / 180)).toFixed(0)} nm later.`,
              example: `Spirit four fifty one, turn ${g.turn} heading ${hdg}.`,
              explanation:
                `The heading must meet the final approach course at no more than 30 degrees (7110.65 allows 30 when the intercept is 2 miles or more outside the approach gate, 20 closer in), and 5-9-1 wants the intercept at least 2 miles outside the approach gate. 5-9-4 also has you give the aircraft's position relative to a fix on the final approach course (distance and fix name) before the vector. ` +
                `The simulator has no approach gate, so it simplifies this: intercept angle 30 degrees or less, intercept point outside the FAF (${faf}), and the course no more than 10 nm ahead of the aircraft when you clear it. ` +
                `Here the course is on your ${g.turn === 'left' ? 'left' : 'right'}, so turn ${g.turn}. A bigger angle ("turn left heading zero zero zero") would be refused as too steep.`,
              mistakes: ['An intercept angle above 30 degrees.', 'A heading that does not converge on the course (turning away from it).', 'Waiting until the aircraft is inside the FAF: the approach clearance is then refused.'],
            },
            {
              id: 'clear', callsign: 'NKS451', expectCommand: 'APPROACH', reference: refTexts('5-9-4', '4-8-1'),
              prompt: 'Clear NKS451 for the ILS runway 13 approach with an altitude to maintain until it is established: "maintain two thousand until established on the localizer, cleared ILS runway one three approach".',
              example: 'Spirit four fifty one, maintain two thousand until established on the localizer, cleared ILS runway one three approach.',
              explanation:
                'Before the aircraft reaches the approach gate the controller gives its position, the vector to the course and the approach clearance. The altitude is held "until established on the localizer" (a segment of the published approach; the 5-9-4 arrival examples use exactly this wording) so the aircraft stays above terrain and below the glidepath until it can follow it. ' +
                'The clearance names the approach as published, "Cleared ILS runway 13 approach" (4-8-1), and the pilot reads it back with the runway and callsign. The simulator checks the geometry: inside the FAF or an intercept steeper than 30 degrees is refused in training.',
              mistakes: ['"Cleared approach" without naming the ILS and the runway.', 'Forgetting the altitude to maintain until established.', 'Clearing the approach after the aircraft is already inside the FAF.'],
            },
            {
              id: 'wait-established', callsign: 'NKS451', check: 'established:NKS451', reference: refText('5-9-2'),
              prompt: 'Wait. NKS451 turns onto the localizer, intercepts the glidepath from below and reports established on the ILS runway 13.',
              explanation: 'After the interception, watch the track: if the aircraft is not converging, ask its position and intentions (5-9-2). The simulated pilot reports "established" when it is on the course, and stays on your frequency until you hand it off.',
              mistakes: ['Handing the aircraft to Tower before it has reported established (it is not yet on the final).'],
            },
            {
              id: 'handoff', callsign: 'NKS451', expectCommand: 'CONTACT_FREQUENCY', reference: refTexts('5-9-4', '2-1-17'),
              prompt: 'NKS451 is established. Hand it to Tower on 120.3.',
              example: 'Spirit four fifty one, contact tower one two zero point three.',
              explanation: 'Once the aircraft is established on the final and no longer needs vectors, Approach transfers it to Tower; the pilot checks in with its distance from the runway and Tower issues the landing clearance. 5-9-4 requires the frequency change before the final approach fix, and its example names the tower and gives the frequency; 2-1-17 gives the form "Contact (facility and function), (frequency)", with the location name omitted when tower and TRACON share it.',
              mistakes: ['Keeping the aircraft on Approach until the last mile.', 'Forgetting the frequency.'],
            },
          ] satisfies TrainingStepSpec[],
        },
        durationSec: 900,
      };
    }),
];
