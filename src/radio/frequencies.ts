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
