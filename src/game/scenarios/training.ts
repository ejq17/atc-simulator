/**
 * Training scenarios: calm weather, no readback errors, unsafe clearances refused (engine `mode: 'training'`), and a
 * `training.steps` walk-through. Every `reference` was verified on the FAA site (see ../references.ts); nothing is quoted.
 */
import { refText, refTexts, KACY_READBACK_NOTE } from '../references';
import type { TrainingStepSpec } from '../types';
import { planDepartureTaxi } from '../world';
import { GROUND_AND_TOWER, TOWER_AND_GROUND, arrivalInPattern, arrivalOnFinal, holdingShort, parkedDeparture, vfrWeather } from './common';
import type { ScenarioDef } from './common';

const calm = () => vfrWeather(110, 6);
const MISTAKE_CONDITIONAL = 'Conditional instructions such as "line up and wait behind the landing traffic" or "taxi across behind the departing aircraft" are not allowed; issue a separate, unconditional instruction when the situation allows it.';

function def(
  id: string, name: string, difficulty: number, minutes: number, description: string, topic: string,
  build: ScenarioDef['build'],
): ScenarioDef {
  return { summary: { id, name, description: `${description} Topic: ${topic}.`, mode: 'training', difficulty, estimatedMinutes: minutes }, build };
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
            explanation: 'A takeoff clearance states the runway number first, then "cleared for takeoff". It is the only thing that authorises the takeoff roll, and the pilot must read it back with the runway and the callsign.',
            mistakes: ['Saying only "cleared for takeoff" without the runway number.', 'Using "take off" or "go ahead" - those are not takeoff clearances.', 'Issuing it while another aircraft or vehicle is on the runway.'],
          },
          {
            id: 'handoff', callsign: 'N723EJ', expectCommand: 'CONTACT_FREQUENCY',
            prompt: 'N723EJ is airborne and leaving your airspace. Tell it to contact Departure on 124.6.',
            example: 'Cessna seven two three echo juliet, contact departure one two four point six.',
            explanation: 'After you transfer an aircraft it leaves your frequency and no longer hears you. Give the facility and frequency, with the callsign, and let the pilot read it back. (No 7110.65 paragraph is cited here: handoff phraseology was not verified for this lesson.)',
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
              prompt: 'N482KB asks to taxi. Give a route to runway 13 (delta, alpha) and tell it to hold short of the runway.',
              example: 'Cessna four eight two kilo bravo, taxi to runway one three via delta, alpha, hold short runway one three.',
              explanation: 'A taxi instruction must include the specific route to follow. When it is for a runway, make sure the pilot has the correct runway assignment (the readback with the runway number confirms it) and say where the aircraft must hold. Use "taxi" - never "cleared to taxi": the word "cleared" is kept for runway and approach clearances.',
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
              prompt: 'N60DX asks to taxi. Give it a route to runway 22 via alpha, and tell it to hold short of runway 13.',
              example: 'Cessna six zero delta x-ray, taxi to runway two two via alpha, hold short of runway one three.',
              explanation: 'When you want an aircraft to stop short of a runway, issue the route up to the hold-short point (or the whole route and then the hold-short instruction). You must also make sure the pilot reads back the hold-short instruction - at KACY the airport diagram itself requires readback of all runway holding instructions.',
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
              explanation: 'The crossing instruction names the runway and where to cross. The ground controller must coordinate with the local controller before authorising a crossing of an active runway; here you are both, so look at the runway first.',
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
      description: 'Cessna N723EJ is 4 nm out and slow; Spirit 451 is 9 nm out and faster. Establish the landing order and use speed to keep space between them.',
      weather: calm(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
      spawns: [arrivalOnFinal(airport, 'N723EJ', 'C172', '13', 4, 0, { speedKt: 85 }), arrivalOnFinal(airport, 'NKS451', 'A320', '13', 9, 0)],
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
            id: 'space', callsign: 'NKS451', expectCommand: 'SPEED', reference: refText('3-8-1'),
            prompt: 'NKS451 is faster and will close on the Cessna. Reduce its speed to 140 knots to build spacing.',
            example: 'Spirit four fifty one, reduce speed to one four zero.',
            explanation: 'Sequence and spacing are established by having aircraft adjust their flight (speed, path, or pattern) as necessary - here, a speed reduction for the faster aircraft.',
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
            explanation: 'Pattern instructions are how the tower builds the arrival sequence: entry leg, runway, and later "extend downwind", "make short approach" or a number in the landing order.',
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
            prompt: 'Line up N723EJ on runway 13 (Spirit 451 is 5 nm out and you intend to depart the Cessna first).',
            example: 'Cessna seven two three echo juliet, runway one three, line up and wait.',
            explanation: 'Line up and wait is for an imminent departure. Once an aircraft is in position, the same runway cannot also be given to a landing aircraft (without the safety logic used at some facilities), so you must make the departure happen or send the arrival around.',
            mistakes: [MISTAKE_CONDITIONAL],
          },
          {
            id: 'go-around', callsign: 'NKS451', expectCommand: 'GO_AROUND', check: 'go_around:NKS451', reference: refTexts('3-9-4', '3-10-5'),
            prompt: 'Spirit 451 is on final and the Cessna is still in position. Do not clear it to land - tell it to go around.',
            example: 'Spirit four fifty one, go around.',
            explanation: 'A landing clearance cannot be issued while another aircraft is holding in position on the runway. When the Cessna cannot depart in time, the arrival is sent around. (If you wait too long the Airbus goes around by itself at 0.5 nm without a clearance - that also completes the step.)',
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
];
