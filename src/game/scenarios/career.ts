/**
 * Career progression: the 12 steps of goal.md section 14, in order. Every spawn resolves against the real KACY data
 * (holding positions from `runwayEntryNodes`, parking ids from the airport, airborne spawns on the TRUE-heading
 * extended centreline or on real bearings toward neighbouring airfields).
 *
 * Conventions: wind favours 13/31; the A320 only ever departs from the 13/31 full-length / Charlie holds (the engine
 * refuses a 6,500 ft roll on 6,145 ft runway 4/22); no helicopters (Coast Guard) and no fighters (ANG) are spawned
 * because the simulator does not model them yet.
 */
import { getPresetWeather } from '../../weather/presets';
import { planDepartureTaxi, routeWords } from '../world';
import type { ScenarioEvent } from '../types';
import { buildFreePlay } from './freeplay';
import {
  GROUND_AND_TOWER, TOWER_AND_GROUND, WX_RWY13, arrivalFrom, arrivalInPattern, arrivalOnFinal, holdingShort, parkedDeparture, vfrWeather,
} from './common';
import type { ScenarioDef } from './common';

const obj = (id: string, text: string, check: string): { id: string; text: string; check: string } => ({ id, text, check });
const NO_INCURSIONS = obj('safe', 'Keep the runways safe: no runway incursions', 'no_incursions');

function def(summary: ScenarioDef['summary'], build: ScenarioDef['build']): ScenarioDef {
  return { summary, build };
}

// ---------------------------------------------------------------------------
// 1. First radio transmission
// ---------------------------------------------------------------------------
const step1 = def(
  { id: 'career-01-first-radio', name: '1. First radio transmission', description: 'A Cessna is holding short of runway 13 and ready to go. Make your first call and clear it for takeoff.', mode: 'career', difficulty: 1, careerStep: 1, estimatedMinutes: 3 },
  (airport, o) => ({
    id: 'career-01-first-radio', name: '1. First radio transmission', mode: 'career', careerStep: 1, seed: o?.seed ?? 101,
    description:
      'You are the Tower controller at Atlantic City. Cessna N723EJ is holding short of runway 13 at the full-length entry (taxiway Bravo) and has just called ready for departure. ' +
      'Hold push-to-talk, say the callsign and the runway, and clear it for takeoff: "Cessna seven two three echo juliet, runway one three, cleared for takeoff."',
    weather: WX_RWY13(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: ['TWR'],
    spawns: [holdingShort(airport, 'N723EJ', 'C172', '13', 0)],
    objectives: [obj('takeoff-clearance', 'Issue a valid takeoff clearance to N723EJ', 'cmd:TAKEOFF:N723EJ')],
    durationSec: 300, difficulty: 'easy',
  }),
);

// ---------------------------------------------------------------------------
// 2. Single-aircraft takeoff (GA ramp -> taxi -> hold short -> takeoff)
// ---------------------------------------------------------------------------
const step2 = def(
  { id: 'career-02-single-takeoff', name: '2. Single-aircraft takeoff', description: 'Taxi a Cessna from the GA ramp to runway 13, hand it to Tower and send it on its way.', mode: 'career', difficulty: 2, careerStep: 2, estimatedMinutes: 6 },
  (airport, o) => {
    const plan = planDepartureTaxi(airport, 'GA-2', '13', ['D', 'A']);
    if (!plan) throw new Error('career-02: no GA-2 -> runway 13 route via Delta, Alpha');
    return {
      id: 'career-02-single-takeoff', name: '2. Single-aircraft takeoff', mode: 'career', careerStep: 2, seed: o?.seed ?? 102,
      description:
        `Cessna N482KB is on GA ramp 2 and wants to depart. You are on Ground (121.9) with Tower (120.3) as your second position. ` +
        `Taxi it to runway 13 with a full route, e.g. "taxi to runway one three via ${routeWords(['D', 'A'])}, hold short runway one three" ` +
        `(about ${Math.round(plan.lengthM)} m, no runway crossing). When it reports at the hold line, switch it to Tower and clear it for takeoff.`,
      weather: WX_RWY13(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: GROUND_AND_TOWER,
      spawns: [parkedDeparture('N482KB', 'C172', 'GA-2', 0)],
      objectives: [
        obj('taxi', 'Issue a taxi instruction with a route to runway 13', 'cmd:TAXI:N482KB'),
        obj('hold-short', 'N482KB reaches the runway 13 hold line', 'holding_short:N482KB'),
        obj('airborne', 'N482KB takes off', 'takeoff:N482KB'),
        NO_INCURSIONS,
      ],
      durationSec: 900, difficulty: 'easy',
    };
  },
);

// ---------------------------------------------------------------------------
// 3. Single-aircraft landing
// ---------------------------------------------------------------------------
const step3 = def(
  { id: 'career-03-single-landing', name: '3. Single-aircraft landing', description: 'Land a Spirit A320 on runway 13, then hand it to Ground.', mode: 'career', difficulty: 2, careerStep: 3, estimatedMinutes: 8 },
  (airport, o) => ({
    id: 'career-03-single-landing', name: '3. Single-aircraft landing', mode: 'career', careerStep: 3, seed: o?.seed ?? 103,
    description:
      'Spirit 451, an Airbus A320, is 8 nm from the runway 13 threshold on the ILS course and will call you. Clear it to land ("Spirit four fifty one, runway one three, cleared to land"), ' +
      'wait for it to report clear of the runway, then tell it to contact Ground on 121.9.',
    weather: WX_RWY13(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
    spawns: [arrivalOnFinal(airport, 'NKS451', 'A320', '13', 8, 0)],
    objectives: [
      obj('landing-clearance', 'Clear NKS451 to land', 'cmd:LAND:NKS451'),
      obj('landed', 'NKS451 lands', 'landed:NKS451'),
      obj('handoff', 'Hand NKS451 off to Ground', 'handoff:NKS451'),
      NO_INCURSIONS,
    ],
    durationSec: 900, difficulty: 'easy',
  }),
);

// ---------------------------------------------------------------------------
// 4. Multiple departures
// ---------------------------------------------------------------------------
const step4 = def(
  { id: 'career-04-multiple-departures', name: '4. Multiple departures', description: 'Sequence three departures from one runway without ever putting two aircraft on it at once.', mode: 'career', difficulty: 3, careerStep: 4, estimatedMinutes: 10 },
  (airport, o) => ({
    id: 'career-04-multiple-departures', name: '4. Multiple departures', mode: 'career', careerStep: 4, seed: o?.seed ?? 104,
    description:
      'Two Cessnas are holding short of runway 13: N412KB at the full-length entry (Bravo) and N88PL at Charlie. A Spirit A320 will ask to taxi from the terminal in about a minute. ' +
      'Decide the order, use line up and wait only when a takeoff clearance cannot be issued yet, and never clear a departure until the aircraft ahead is airborne and past the end of the runway or has turned clear.' +
      ' The A320 needs about 6,500 ft of runway: send it to the full-length hold on Bravo (or Charlie), not the Alpha intersection - the simulator will refuse the takeoff.',
    weather: WX_RWY13(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
    spawns: [
      holdingShort(airport, 'N412KB', 'C172', '13', 0),
      holdingShort(airport, 'N88PL', 'C172', '13', 0, { taxiway: 'C' }),
      parkedDeparture('NKS608', 'A320', 'GATE-4', 60),
    ],
    objectives: [
      obj('dep-1', 'N412KB takes off', 'takeoff:N412KB'),
      obj('dep-2', 'N88PL takes off', 'takeoff:N88PL'),
      obj('dep-3', 'NKS608 takes off', 'takeoff:NKS608'),
      NO_INCURSIONS,
      obj('no-unsafe', 'No unsafe clearances', 'no_unsafe'),
    ],
    durationSec: 1200, difficulty: 'normal',
  }),
);

// ---------------------------------------------------------------------------
// 5. Ground taxi procedures (a real 13/31 crossing at Alpha)
// ---------------------------------------------------------------------------
const step5 = def(
  { id: 'career-05-ground-taxi', name: '5. Ground taxi procedures', description: 'Work Ground only: three taxi routes, two of them across an active runway.', mode: 'career', difficulty: 3, careerStep: 5, estimatedMinutes: 12 },
  (airport, o) => {
    const to13 = planDepartureTaxi(airport, 'GA-1', '13', ['D', 'A']);
    const to22 = planDepartureTaxi(airport, 'GA-2', '22', ['A']);
    const viaB = planDepartureTaxi(airport, 'FBO-1', '13', ['B']);
    if (!to13 || !to22 || !viaB) throw new Error('career-05: missing taxi route');
    if (!to22.crossings.some((c) => c.runwayId === '13/31')) throw new Error('career-05: route to runway 22 via Alpha does not cross 13/31');
    return {
      id: 'career-05-ground-taxi', name: '5. Ground taxi procedures', mode: 'career', careerStep: 5, seed: o?.seed ?? 105,
      description:
        'You are Ground. N301AC (GA ramp 1) wants runway 13, N77RK (GA ramp 2) wants runway 22 and N620G (FBO ramp 1) wants runway 13 the long way. ' +
        'The route to 22 via Alpha takes N77RK across runway 13/31 at Alpha, and the Bravo route to the full-length end of 13 crosses 4/22 at Bravo. ' +
        'Give each a complete route with hold-short instructions, make sure the hold-short is read back, and issue each crossing only when the runway is clear. The KACY diagram notes that readback of all runway holding instructions is required.',
      weather: WX_RWY13(), activeRunways: { departing: ['13', '22'], landing: ['13'] }, controllerPositions: GROUND_AND_TOWER,
      spawns: [
        parkedDeparture('N301AC', 'C172', 'GA-1', 0),
        parkedDeparture('N77RK', 'C172', 'GA-2', 20),
        parkedDeparture('N620G', 'C172', 'FBO-1', 60),
      ],
      objectives: [
        obj('taxi-13', 'Taxi N301AC to runway 13', 'cmd:TAXI:N301AC'),
        obj('taxi-22', 'Taxi N77RK toward runway 22 via Alpha', 'cmd:TAXI:N77RK'),
        obj('cross-1331', 'N77RK crosses runway 13/31 on your clearance', 'crossed:N77RK:13/31'),
        obj('cross-422', 'N620G crosses runway 4/22 on your clearance', 'crossed:N620G:4/22'),
        NO_INCURSIONS,
      ],
      durationSec: 1200, difficulty: 'normal',
    };
  },
);

// ---------------------------------------------------------------------------
// 6. Traffic pattern operations
// ---------------------------------------------------------------------------
const step6 = def(
  { id: 'career-06-pattern', name: '6. Traffic pattern operations', description: 'Bring two Cessnas into the runway 13 traffic pattern and land them.', mode: 'career', difficulty: 3, careerStep: 6, estimatedMinutes: 12 },
  (airport, o) => ({
    id: 'career-06-pattern', name: '6. Traffic pattern operations', mode: 'career', careerStep: 6, seed: o?.seed ?? 106,
    description:
      'Two VFR Cessnas are joining the runway 13 pattern: N59TB is abeam the runway on the left (north-east) side and N90DM will call a couple of minutes later on the right (south-west) side. ' +
      'Give pattern entries ("Cessna five nine tango bravo, enter left downwind runway one three", "...enter right downwind runway one three"), watch the spacing on base and final, and clear each to land ' +
      'once the one ahead is no longer a factor.',
    weather: WX_RWY13(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
    spawns: [
      arrivalInPattern(airport, 'N59TB', '13', 'left', 1.5, 0),
      arrivalInPattern(airport, 'N90DM', '13', 'right', 4, 120),
    ],
    objectives: [
      obj('pattern-1', 'Send N59TB into the pattern', 'cmd:ENTER_PATTERN:N59TB'),
      obj('pattern-2', 'Send N90DM into the pattern', 'cmd:ENTER_PATTERN:N90DM'),
      obj('land-1', 'N59TB lands', 'landed:N59TB'),
      obj('land-2', 'N90DM lands', 'landed:N90DM'),
      NO_INCURSIONS,
    ],
    durationSec: 1500, difficulty: 'normal',
  }),
);

// ---------------------------------------------------------------------------
// 7. Multiple arrivals and departures
// ---------------------------------------------------------------------------
const step7 = def(
  { id: 'career-07-arrivals-departures', name: '7. Multiple arrivals and departures', description: 'Interleave three arrivals and two departures on runway 13.', mode: 'career', difficulty: 4, careerStep: 7, estimatedMinutes: 15 },
  (airport, o) => ({
    id: 'career-07-arrivals-departures', name: '7. Multiple arrivals and departures', mode: 'career', careerStep: 7, seed: o?.seed ?? 107,
    description:
      'One runway, five movements. Spirit 712 is on a 9 nm final, a Cessna is holding short for departure, Cessna N35DM is coming in from Millville, a Spirit departure will call from the gate, ' +
      'and American 1201 arrives from the Philadelphia direction later. Get the departures out in the gaps between arrivals, give landing aircraft clearances in order and send each to Ground.' +
      ' The A320 needs about 6,500 ft of runway: send it to the full-length hold on Bravo (or Charlie), not the Alpha intersection - the simulator will refuse the takeoff.',
    weather: WX_RWY13(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
    spawns: [
      arrivalOnFinal(airport, 'NKS712', 'A320', '13', 9, 0),
      holdingShort(airport, 'N214BQ', 'C172', '13', 0),
      arrivalFrom(airport, 'N35DM', 'C172', '13', 'KMIV', 14, 90),
      parkedDeparture('NKS329', 'A320', 'GATE-2', 120),
      arrivalFrom(airport, 'AAL1201', 'A320', '13', 'KPHL', 24, 400, { altitudeFt: 4000 }),
    ],
    objectives: [
      obj('arr-1', 'NKS712 lands', 'landed:NKS712'),
      obj('arr-2', 'N35DM lands', 'landed:N35DM'),
      obj('arr-3', 'AAL1201 lands', 'landed:AAL1201'),
      obj('dep-1', 'N214BQ takes off', 'takeoff:N214BQ'),
      obj('dep-2', 'NKS329 takes off', 'takeoff:NKS329'),
      NO_INCURSIONS,
      obj('no-sep', 'No separation violations', 'no_separation'),
    ],
    durationSec: 1500, difficulty: 'normal',
  }),
);

// ---------------------------------------------------------------------------
// 8. IFR traffic
// ---------------------------------------------------------------------------
const step8 = def(
  { id: 'career-08-ifr', name: '8. IFR traffic', description: 'Low IFR: Spirit and American A320s on the ILS to runway 13, GA grounded.', mode: 'career', difficulty: 4, careerStep: 8, estimatedMinutes: 15 },
  (airport, o) => ({
    id: 'career-08-ifr', name: '8. IFR traffic', mode: 'career', careerStep: 8, seed: o?.seed ?? 108,
    description:
      'The IMC weather preset is in effect: 600 ft broken, 1,100 ft overcast, visibility 2 miles in mist. VFR general aviation is grounded. Three A320s are flying the ILS to runway 13 (runway 13 has an ILS; runway 4/22 has none) ' +
      'and one Spirit departure is ready at the gate. Keep generous spacing behind each arrival, and remember an arrival will not accept a late landing clearance inside 0.5 nm: it goes around.',
    weather: getPresetWeather('imc'), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
    spawns: [
      arrivalOnFinal(airport, 'NKS244', 'A320', '13', 10, 0, { altitudeFt: 3000 }),
      arrivalOnFinal(airport, 'AAL1672', 'A320', '13', 16, 0, { altitudeFt: 3000, speedKt: 180 }),
      arrivalOnFinal(airport, 'NKS377', 'A320', '13', 22, 60, { altitudeFt: 3000, speedKt: 180 }),
      parkedDeparture('NKS890', 'A320', 'GATE-5', 30),
    ],
    objectives: [
      obj('arr-1', 'NKS244 lands', 'landed:NKS244'),
      obj('arr-2', 'AAL1672 lands', 'landed:AAL1672'),
      obj('arr-3', 'NKS377 lands', 'landed:NKS377'),
      obj('dep-1', 'NKS890 takes off', 'takeoff:NKS890'),
      NO_INCURSIONS,
      obj('no-sep', 'No separation violations', 'no_separation'),
    ],
    durationSec: 1800, difficulty: 'normal',
  }),
);

// ---------------------------------------------------------------------------
// 9. Mixed aircraft performance
// ---------------------------------------------------------------------------
const step9 = def(
  { id: 'career-09-mixed-performance', name: '9. Mixed aircraft performance', description: 'A fast Airbus is catching a slow Cessna on the same final. Sequence them.', mode: 'career', difficulty: 4, careerStep: 9, estimatedMinutes: 14 },
  (airport, o) => ({
    id: 'career-09-mixed-performance', name: '9. Mixed aircraft performance', mode: 'career', careerStep: 9, seed: o?.seed ?? 109,
    description:
      'Cessna N48KT is 6 nm out at 90 knots with Spirit 817 (A320) 12 nm out at 180 knots behind it: the Airbus closes about 70-100 knots faster. Slow the Spirit, or land the Cessna first and keep it from reaching the runway until it is clear. ' +
      'Two departures (N61RT, then Spirit 540 from the gate) need gaps; the Airbus needs far more runway and time than the Cessna.' +
      ' The A320 needs about 6,500 ft of runway: send it to the full-length hold on Bravo (or Charlie), not the Alpha intersection - the simulator will refuse the takeoff.',
    weather: WX_RWY13(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
    spawns: [
      arrivalOnFinal(airport, 'N48KT', 'C172', '13', 6, 0, { speedKt: 90 }),
      arrivalOnFinal(airport, 'NKS817', 'A320', '13', 12, 0, { speedKt: 180 }),
      holdingShort(airport, 'N61RT', 'C172', '13', 0),
      parkedDeparture('NKS540', 'A320', 'GATE-7', 45),
    ],
    objectives: [
      obj('arr-1', 'N48KT lands', 'landed:N48KT'),
      obj('arr-2', 'NKS817 lands', 'landed:NKS817'),
      obj('dep-1', 'N61RT takes off', 'takeoff:N61RT'),
      obj('dep-2', 'NKS540 takes off', 'takeoff:NKS540'),
      obj('no-sep', 'No separation violations', 'no_separation'),
      NO_INCURSIONS,
    ],
    durationSec: 1500, difficulty: 'hard',
  }),
);

// ---------------------------------------------------------------------------
// 10. Runway changes (scripted wind shift)
// ---------------------------------------------------------------------------
export const RUNWAY_CHANGE_AT_SEC = 600;

const step10 = def(
  { id: 'career-10-runway-change', name: '10. Runway changes', description: 'The wind swings 180 degrees mid-session. Change the active runways to 31 and keep traffic flowing.', mode: 'career', difficulty: 5, careerStep: 10, estimatedMinutes: 20 },
  (airport, o) => {
    const events: ScenarioEvent[] = [
      {
        atSec: RUNWAY_CHANGE_AT_SEC, kind: 'weather', weather: vfrWeather(300, 14),
        text: 'Wind shift: now 300 at 14. Runway 31 is favoured. Update the active runways, then issue new instructions: new traffic is arriving and departing on 31.',
        recommendedRunways: { departing: ['31'], landing: ['31'] },
      },
      { atSec: RUNWAY_CHANGE_AT_SEC - 60, kind: 'message', text: 'Forecast: a sea-breeze front is approaching; expect the wind to swing to the northwest within a minute.' },
    ];
    return {
      id: 'career-10-runway-change', name: '10. Runway changes', mode: 'career', careerStep: 10, seed: o?.seed ?? 110,
      description:
        'Operations start on runway 13 with a light southeast wind. At 10 minutes the wind shifts to 300 at 14 (see the weather schedule): runway 31 becomes the runway in use. ' +
        'Finish the runway 13 traffic, switch the active runways to 31 (landing and departing), and handle American 1004 (arrival on 31) and Cessna N90LE (departure from 31). Update the ATIS when the configuration changes.' +
        ' The A320 needs about 6,500 ft of runway: send it to the full-length hold on Bravo (the full-length hold at either end), not the Alpha intersection - the simulator will refuse the takeoff.',
      weather: vfrWeather(130, 10), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
      spawns: [
        arrivalOnFinal(airport, 'NKS501', 'A320', '13', 9, 0),
        holdingShort(airport, 'N629CT', 'C172', '13', 0),
        parkedDeparture('NKS233', 'A320', 'GATE-8', 100),
        arrivalOnFinal(airport, 'N17PV', 'C172', '13', 6, 120),
        arrivalOnFinal(airport, 'AAL1004', 'A320', '31', 10, RUNWAY_CHANGE_AT_SEC + 90),
        holdingShort(airport, 'N90LE', 'C172', '31', RUNWAY_CHANGE_AT_SEC + 30),
      ],
      objectives: [
        obj('arr-13', 'NKS501 lands on 13', 'landed:NKS501'),
        obj('dep-13', 'N629CT takes off on 13', 'takeoff:N629CT'),
        obj('switch', 'Switch the active runways to 31', 'active_runway:31'),
        obj('arr-31', 'AAL1004 lands on 31', 'landed:AAL1004'),
        obj('dep-31', 'N90LE takes off from 31', 'takeoff:N90LE'),
        NO_INCURSIONS,
      ],
      events, durationSec: 1800, difficulty: 'hard',
    };
  },
);

// ---------------------------------------------------------------------------
// 11. Complex airport traffic
// ---------------------------------------------------------------------------
const step11 = def(
  { id: 'career-11-complex', name: '11. Complex airport traffic', description: 'A busy afternoon: continuous arrivals and departures, GA and airline, for 25 minutes.', mode: 'career', difficulty: 5, careerStep: 11, estimatedMinutes: 25 },
  (airport, o) => {
    const fp = buildFreePlay(airport, {
      seed: o?.seed ?? 111, weather: 'light-crosswinds', difficulty: 'hard', startingScenario: 'mixed',
      aircraftCount: 6, arrivalsPerHour: 20, departuresPerHour: 20, gaFraction: 0.35, maxAircraft: 14,
    });
    return {
      ...fp,
      id: 'career-11-complex', name: '11. Complex airport traffic', mode: 'career', careerStep: 11,
      description:
        'Free-play density at its highest: up to 14 aircraft, about 40 operations an hour, GA and airline traffic, and a 12 knot crosswind with gusts. Handle at least 10 aircraft in 25 minutes without a runway incursion or a loss of separation.',
      objectives: [
        obj('handled', 'Handle at least 10 aircraft', 'handled:>=10'),
        NO_INCURSIONS,
        obj('no-sep', 'No separation violations', 'no_separation'),
      ],
      durationSec: 1500,
    };
  },
);

// ---------------------------------------------------------------------------
// 12. Emergency scenarios (scripted: the engine has no emergency model)
// ---------------------------------------------------------------------------
const step12 = def(
  { id: 'career-12-emergency', name: '12. Emergency scenarios', description: 'Spirit 1180 declares a medical emergency while two other arrivals are ahead of it. Get it on the ground first.', mode: 'career', difficulty: 5, careerStep: 12, estimatedMinutes: 15 },
  (airport, o) => {
    const mayday =
      'Pan-pan, pan-pan, pan-pan, Atlantic City Tower, Spirit eleven eighty, medical emergency, one one miles northwest, request priority landing runway one three.';
    return {
      id: 'career-12-emergency', name: '12. Emergency scenarios', mode: 'career', careerStep: 12, seed: o?.seed ?? 112,
      description:
        'American 1590 is 7 nm out on the runway 13 final and Cessna N305SP is coming from Millville. A few seconds into the session Spirit 1180 calls with a medical emergency (pan-pan) and asks for priority. ' +
        'Give it the first landing clearance: send the others around, slow them or vector them clear, then clear NKS1180 to land and keep the runway free. Scripted: the emergency is announced by the scenario event system, not by the engine.',
      weather: WX_RWY13(), activeRunways: { departing: ['13'], landing: ['13'] }, controllerPositions: TOWER_AND_GROUND,
      spawns: [
        arrivalOnFinal(airport, 'AAL1590', 'A320', '13', 7, 0),
        arrivalFrom(airport, 'N305SP', 'C172', '13', 'KMIV', 14, 0),
        arrivalFrom(airport, 'NKS1180', 'A320', '13', 'KPHL', 11, 15, { altitudeFt: 3000, speedKt: 190 }),
      ],
      objectives: [
        obj('emergency-first', 'Clear the emergency aircraft NKS1180 to land first', 'landed_before:NKS1180:AAL1590'),
        obj('emergency-first-2', 'NKS1180 also lands ahead of N305SP', 'landed_before:NKS1180:N305SP'),
        obj('clear', 'Issue NKS1180 a landing clearance', 'cmd:LAND:NKS1180'),
        obj('handoff', 'Hand NKS1180 off to Ground', 'handoff:NKS1180'),
        NO_INCURSIONS,
      ],
      events: [{ atSec: 21, kind: 'emergency', callsign: 'NKS1180', declaration: 'PAN-PAN', text: mayday }],
      durationSec: 1200, difficulty: 'hard',
    };
  },
);

export const CAREER_SCENARIOS: ScenarioDef[] = [step1, step2, step3, step4, step5, step6, step7, step8, step9, step10, step11, step12];
