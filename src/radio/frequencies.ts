/** Who hears what: aircraft only receive transmissions on their current frequency. */
import type { Aircraft, Airport, ControllerPositionId, RadioFrequency } from '../sim/types';

const EPS = 0.0005;

export function sameFrequency(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

/** True if the aircraft is tuned to `mhz` (and therefore hears / answers transmissions on it). */
export function hearsFrequency(aircraft: Pick<Aircraft, 'frequencyMhz'>, mhz: number): boolean {
  return sameFrequency(aircraft.frequencyMhz, mhz);
}

export function frequencyForPosition(airport: Airport, position: ControllerPositionId): RadioFrequency | undefined {
  return airport.frequencies.find((f) => f.position === position);
}

export function frequencyById(airport: Airport, id: string): RadioFrequency | undefined {
  const up = id.toUpperCase();
  return airport.frequencies.find((f) => f.id.toUpperCase() === up);
}

export function frequencyByMhz(airport: Airport, mhz: number): RadioFrequency | undefined {
  return airport.frequencies.find((f) => sameFrequency(f.mhz, mhz));
}

/** Positions (distinct, in airport-data order) that own `mhz`: more than one when positions share a frequency (KACY APP/DEP, KPGD CLNC/GND). */
export function positionsOnFrequency(airport: Airport, mhz: number): RadioFrequency['position'][] {
  const out: RadioFrequency['position'][] = [];
  for (const f of airport.frequencies) if (sameFrequency(f.mhz, mhz) && !out.includes(f.position)) out.push(f.position);
  return out;
}

/**
 * The position an aircraft's radio calls belong to when several positions share its frequency, from its flight phase: an IFR departure
 * parked without a clearance needs Clearance Delivery; any other aircraft on the ground short of the hold line (landed, taxiing, parked
 * with a clearance, pushing back) needs Ground; one at the hold line, lined up or on the runway needs Tower. Undefined when the phase
 * does not decide (airborne traffic: APP and DEP stay interchangeable).
 */
export function neededGroundPosition(ac: Pick<Aircraft, 'phase' | 'onGround' | 'isDeparture' | 'flightPlan'>): 'CLNC' | 'GND' | 'TWR' | undefined {
  if (!ac.onGround) return undefined;
  switch (ac.phase) {
    case 'PARKED':
      return ac.isDeparture && ac.flightPlan?.flightRules === 'IFR' && !ac.flightPlan.ifrClearance ? 'CLNC' : 'GND';
    case 'PUSHBACK': case 'READY': case 'TAXIING': case 'RUNWAY_EXIT': case 'TAXI_TO_PARKING': case 'ARRIVED':
      return 'GND';
    case 'HOLDING_SHORT': case 'LINE_UP_AND_WAIT': case 'CLEARED_FOR_TAKEOFF': case 'TAKEOFF_ROLL': case 'LANDING': case 'ROLLOUT':
      return 'TWR';
    default:
      return undefined;
  }
}

/**
 * The position an aircraft is talking to. One owner of its frequency: that position. Several (shared frequency): the position its phase needs
 * (`neededGroundPosition`) if one of them owns the frequency, else the one named by the frequency id it was last given, else the first.
 */
export function aircraftPosition(airport: Airport, ac: Pick<Aircraft, 'frequencyMhz' | 'frequencyId' | 'phase' | 'onGround' | 'isDeparture' | 'flightPlan'>): RadioFrequency['position'] | undefined {
  const positions = positionsOnFrequency(airport, ac.frequencyMhz);
  if (positions.length <= 1) return positions[0];
  const need = neededGroundPosition(ac);
  if (need && positions.includes(need)) return need;
  if (need === 'TWR' && positions.includes('GND')) return 'GND'; // on the runway but tuned to a Ground frequency that Delivery shares
  const byId = ac.frequencyId ? airport.frequencies.find((f) => f.id.toUpperCase() === ac.frequencyId!.toUpperCase() && sameFrequency(f.mhz, ac.frequencyMhz)) : undefined;
  return byId?.position ?? positions[0];
}

/** All aircraft that would hear a transmission on `mhz`. */
export function listenersOn(aircraft: Iterable<Aircraft>, mhz: number): Aircraft[] {
  const out: Aircraft[] = [];
  for (const a of aircraft) if (hearsFrequency(a, mhz)) out.push(a);
  return out;
}

const POSITION_WORD: Record<string, string> = { CLNC: 'Clearance Delivery', GND: 'Ground', TWR: 'Tower', APP: 'Approach', DEP: 'Departure', ATIS: 'ATIS' };

/** Short facility word for a position: "Ground", "Tower"... */
export function positionWord(position: string): string {
  return POSITION_WORD[position] ?? position;
}

/**
 * The name the tower calls itself on the radio ("Atlantic City", "Manchester"): the airport data's Tower frequency name (built from the
 * NASR tower radio call) without its position word. Airports without a Tower row fall back to the airport name with
 * "International/Regional/Airport..." stripped.
 */
export function airportCallName(airport: Airport): string {
  const twr = airport.frequencies.find((f) => f.position === 'TWR');
  const fromTower = twr?.name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+Tower\s*$/i, '').trim();
  if (fromTower) return fromTower;
  return airport.name
    .replace(/\(.*?\)/g, '')
    .replace(/\b(International|Intl|Regional|Municipal|Airport|Field|County|Memorial)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Full call name for the facility an aircraft is tuned to: "Atlantic City Ground".
 * Several positions can share one frequency (KACY: Approach and Departure are both 124.6), so the frequency id the
 * aircraft was told to contact wins when it matches the tuned frequency.
 */
export function facilityCallName(airport: Airport, mhz: number, frequencyId?: string): string {
  const byId = frequencyId ? frequencyById(airport, frequencyId) : undefined;
  const f = byId && sameFrequency(byId.mhz, mhz) ? byId : frequencyByMhz(airport, mhz);
  if (f && f.position !== 'OTHER') {
    // the frequency's own name carries the facility's radio call ("Boston Approach" at KMHT, where the TRACON is not the tower's city)
    const named = f.name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
    if (named.toLowerCase().endsWith(` ${positionWord(f.position).toLowerCase()}`)) return named;
    return `${airportCallName(airport)} ${positionWord(f.position)}`;
  }
  return airportCallName(airport);
}

export function formatMhz(mhz: number): string {
  return mhz.toFixed(3).replace(/0$/, '');
}
