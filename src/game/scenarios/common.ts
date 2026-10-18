/** Builders shared by the scenario catalogue. */
import type { Airport, ControllerPositionId, ScenarioAircraftSpawn, Weather } from '../../sim/types';
import type { FreePlayOptions, ScenarioSummary } from '../index';
import { makeSimulatedWeather } from '../../weather/presets';
import type { GameScenario } from '../types';
import { getPerformance } from '../../sim/performance';
import { bearingTo, fullLengthHold, holdOn, inboundFromBearing, onDownwind, onFinal } from '../world';
import type { NeighbourId } from '../world';
import { arrivalAtFix, arrivalProcedure, ifrFlightPlan } from '../ifr';

export interface ScenarioDef {
  summary: ScenarioSummary;
  build(airport: Airport, options?: FreePlayOptions): GameScenario;
}

/** Calm summer VFR day with a chosen TRUE wind (KACY variation is 10 W, so magnetic = true + 10). */
export function vfrWeather(windTrueDeg: number, kt: number, gust?: number): Weather {
  return makeSimulatedWeather({
    windDirDeg: windTrueDeg, windSpeedKt: kt, ...(gust ? { windGustKt: gust } : {}), visibilitySm: 10,
    clouds: [{ cover: 'FEW', baseFtAgl: 5000 }], temperatureC: 22, dewpointC: 12, altimeterInHg: 30.02, phenomena: [],
  });
}

/** Wind close to the runway 13 heading (true 118) so every 13/31 operation is a mild headwind. */
export const WX_RWY13 = (): Weather => vfrWeather(110, 8);
/** Wind favouring runway 31 (true 298). */
export const WX_RWY31 = (): Weather => vfrWeather(300, 14);

const isLight = (type: string): boolean => getPerformance(type).category === 'light';

export function holdingShort(
  airport: Airport, callsign: string, type: string, endId: string, atSec: number,
  o: { taxiway?: string; freq?: 'TWR' | 'GND' } = {},
): ScenarioAircraftSpawn {
  const hold = o.taxiway ? holdOn(airport, endId, o.taxiway) : fullLengthHold(airport, endId);
  return {
    atSec, callsign, type, flightRules: isLight(type) ? 'VFR' : 'IFR',
    start: { kind: 'holding_short', nodeId: hold.id, runwayEnd: endId },
    isDeparture: true, initialFrequencyId: o.freq ?? 'TWR', initialRequest: 'DEPARTURE',
  };
}

export function parkedDeparture(callsign: string, type: string, parkingId: string, atSec: number): ScenarioAircraftSpawn {
  return {
    atSec, callsign, type, flightRules: isLight(type) ? 'VFR' : 'IFR',
    start: { kind: 'parked', parkingId }, isDeparture: true, initialFrequencyId: 'GND', initialRequest: 'TAXI',
  };
}

/** Arrival established on the extended centreline `nm` out. */
export function arrivalOnFinal(
  airport: Airport, callsign: string, type: string, endId: string, nm: number, atSec: number,
  o: { speedKt?: number; altitudeFt?: number; freq?: string } = {},
): ScenarioAircraftSpawn {
  const light = isLight(type);
  const speedKt = o.speedKt ?? (light ? 95 : nm > 10 ? 180 : 160);
  return {
    atSec, callsign, type, flightRules: light ? 'VFR' : 'IFR',
    start: onFinal(airport, endId, nm, { speedKt, altitudeFt: o.altitudeFt }),
    isDeparture: false, initialFrequencyId: o.freq ?? 'TWR', initialRequest: 'LANDING',
  };
}

/** Arrival coming from a neighbouring airport's direction, heading for the runway threshold. */
export function arrivalFrom(
  airport: Airport, callsign: string, type: string, endId: string, from: NeighbourId, nm: number, atSec: number,
  o: { speedKt?: number; altitudeFt?: number; freq?: string } = {},
): ScenarioAircraftSpawn {
  const light = isLight(type);
  return {
    atSec, callsign, type, flightRules: light ? 'VFR' : 'IFR',
    start: inboundFromBearing(airport, endId, bearingTo(airport, from), nm, {
      altitudeFt: o.altitudeFt ?? (light ? 2500 : 3000), speedKt: o.speedKt ?? (light ? 100 : 190),
    }),
    isDeparture: false, initialFrequencyId: o.freq ?? 'TWR', initialRequest: 'LANDING',
  };
}

export const TOWER_AND_GROUND: ControllerPositionId[] = ['TWR', 'GND'];
export const GROUND_AND_TOWER: ControllerPositionId[] = ['GND', 'TWR'];

export function nameList(...cs: string[]): string {
  return cs.join(', ');
}

/** VFR Cessna joining the pattern: starts on the downwind leg (see `onDownwind`). */
export function arrivalInPattern(
  airport: Airport, callsign: string, endId: string, side: 'left' | 'right', alongNm: number, atSec: number,
  o: { freq?: string } = {},
): ScenarioAircraftSpawn {
  return {
    atSec, callsign, type: 'C172', flightRules: 'VFR', start: onDownwind(airport, endId, side, alongNm, { speedKt: 90 }),
    isDeparture: false, initialFrequencyId: o.freq ?? 'TWR', initialRequest: 'LANDING',
  };
}

/** Parked A320 (or Cessna) IFR departure that starts on Clearance Delivery, with a fixed destination and cruise altitude. */
export function ifrDeparture(
  airport: Airport, callsign: string, type: string, parkingId: string, atSec: number, destination: string, cruiseAltitudeFt: number,
): ScenarioAircraftSpawn {
  return {
    atSec, callsign, type, flightRules: 'IFR', start: { kind: 'parked', parkingId }, isDeparture: true,
    initialFrequencyId: 'CLNC', initialRequest: 'IFR_CLEARANCE',
    flightPlan: ifrFlightPlan(airport, () => 0, type, { destination, cruiseAltitudeFt }),
  };
}

/**
 * IFR arrival over a fix of the published procedure for `endId` (ILS 13: CARYL, or VCN via CARYL with `fromFeeder`), on the Approach frequency.
 * The fixes are read from `airport.procedures`; the builder throws if the runway has no procedure.
 */
export function ifrArrival(
  airport: Airport, callsign: string, type: string, endId: string, atSec: number,
  o: { fromFeeder?: boolean; altitudeFt?: number; speedKt?: number } = {},
): ScenarioAircraftSpawn {
  const proc = arrivalProcedure(airport, endId);
  if (!proc) throw new Error(`No arrival procedure for runway ${endId}`);
  return {
    atSec, callsign, type, flightRules: 'IFR',
    start: arrivalAtFix(airport, proc, { altitudeFt: o.altitudeFt ?? 3000, speedKt: o.speedKt ?? 180, fromFeeder: o.fromFeeder }),
    isDeparture: false, initialFrequencyId: 'APP', initialRequest: 'APPROACH',
  };
}

/** Everything but the player's choice of position: Tower + Ground + Clearance Delivery + Departure (career steps 7, 9). */
export const IFR_DEPARTURE_POSITIONS: ControllerPositionId[] = ['TWR', 'GND', 'CLNC', 'DEP'];
