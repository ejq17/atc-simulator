/**
 * Controller position sets the player can work, with the plain-language description shown on the setup screen
 * and in the Radio panel. Frequencies always come from `airport.frequencies` (never hard-coded here).
 */
import type { Airport, ControllerPositionId } from '../../sim/types';
import { frequencyForPosition, sameFrequency } from '../../radio/frequencies';

export type PositionChoice = 'CLNC' | 'GND' | 'TWR' | 'TWR+GND' | 'APP' | 'DEP' | 'APP+TWR' | 'ALL';

/**
 * The first position of a set is the primary one (used by the engine as the default). Where two positions share a
 * frequency (KACY Approach and Departure are both 124.6) the earlier one wins when a call has to be assigned.
 */
export const POSITION_CHOICES: Record<PositionChoice, ControllerPositionId[]> = {
  CLNC: ['CLNC'],
  GND: ['GND'],
  TWR: ['TWR'],
  'TWR+GND': ['TWR', 'GND'],
  APP: ['APP', 'DEP'],
  DEP: ['DEP'],
  'APP+TWR': ['APP', 'DEP', 'TWR'],
  ALL: ['TWR', 'GND', 'CLNC', 'APP', 'DEP'],
};

export const POSITION_ORDER: PositionChoice[] = ['CLNC', 'GND', 'TWR', 'TWR+GND', 'APP', 'DEP', 'APP+TWR', 'ALL'];

export const POSITION_LABEL: Record<PositionChoice, string> = {
  CLNC: 'Clearance Delivery',
  GND: 'Ground',
  TWR: 'Tower',
  'TWR+GND': 'Tower + Ground',
  APP: 'Approach + Departure',
  DEP: 'Departure',
  'APP+TWR': 'Approach + Tower',
  ALL: 'All positions',
};

/** What each choice does. `needs` text is derived from the scenario at render time. */
export const POSITION_NOTE: Record<PositionChoice, string> = {
  CLNC: 'IFR clearances for parked departures: destination, departure procedure, altitudes, departure frequency and squawk. Aircraft then call Ground by themselves.',
  GND: 'Taxi routes, hold-short points, runway crossings and pushback.',
  TWR: 'Runway clearances (takeoff, line up and wait, land), sequencing, handoffs to Departure and Ground.',
  'TWR+GND': 'Both frequencies at once. Each call goes out on the addressed aircraft’s frequency.',
  APP: 'Airborne IFR traffic: vectors, direct-to, altitudes, approach clearances, radar contact, handoff to Tower. Approach and Departure share 124.6 at KACY.',
  DEP: 'Departing IFR traffic only: radar contact, climb, direct-to and routing after Tower hands them off.',
  'APP+TWR': 'Bring arrivals down the approach and land them yourself, and release the departures to Departure.',
  ALL: 'Every position at once: clearance to taxi to takeoff to departure and approach to landing.',
};

export const POSITION_WORD: Record<ControllerPositionId, string> = {
  CLNC: 'Clearance Delivery', GND: 'Ground', TWR: 'Tower', APP: 'Approach', DEP: 'Departure',
};

export function choiceFromPositions(positions: readonly ControllerPositionId[]): PositionChoice {
  const key = positions.join('+');
  return POSITION_ORDER.find((k) => POSITION_CHOICES[k].join('+') === key) ?? 'TWR';
}

/** The smallest position set that covers every position a scenario lists (Tower when it lists none we know). */
export function suggestPosition(positions: readonly ControllerPositionId[]): PositionChoice {
  const want = new Set(positions);
  if (want.size === 0) return 'TWR';
  let best: PositionChoice | undefined;
  for (const k of POSITION_ORDER) {
    const have = POSITION_CHOICES[k];
    if (![...want].every((p) => have.includes(p))) continue;
    if (!best || have.length < POSITION_CHOICES[best].length) best = k;
  }
  return best ?? 'ALL';
}

export interface FrequencyRow {
  mhz: number;
  /** Positions the controller works on this frequency (APP and DEP together at KACY). */
  positions: ControllerPositionId[];
  /** Frequency ids from the airport data ("APP", "DEP"). */
  ids: string[];
}

/** One row per DISTINCT frequency of a position set, in the set's order. */
export function frequencyRows(airport: Pick<Airport, 'frequencies'>, positions: readonly ControllerPositionId[]): FrequencyRow[] {
  const rows: FrequencyRow[] = [];
  for (const p of positions) {
    const f = frequencyForPosition(airport as Airport, p);
    if (!f) continue;
    const row = rows.find((r) => sameFrequency(r.mhz, f.mhz));
    if (row) {
      row.positions.push(p);
      row.ids.push(p);
    } else rows.push({ mhz: f.mhz, positions: [p], ids: [p] });
  }
  return rows;
}

/** "APP/DEP" style label of a row. */
export function rowLabel(row: FrequencyRow): string {
  return row.positions.join('/');
}

/**
 * Positions that exist in the session but are not the player's: an AI controller works each of them.
 * Order follows the scenario's own list; a position the player works is never AI.
 */
export function aiPositionsFor(scenarioPositions: readonly ControllerPositionId[], playerPositions: readonly ControllerPositionId[]): ControllerPositionId[] {
  const mine = new Set(playerPositions);
  return [...new Set(scenarioPositions)].filter((p) => !mine.has(p));
}

/** "Tower, Approach/Departure": the plain-language list shown for AI positions. APP and DEP read as one when both are listed. */
export function positionListText(positions: readonly ControllerPositionId[]): string {
  const out: string[] = [];
  const set = new Set(positions);
  for (const p of positions) {
    if (p === 'DEP' && set.has('APP')) continue;
    out.push(p === 'APP' && set.has('DEP') ? 'Approach/Departure' : POSITION_WORD[p]);
  }
  return out.join(', ');
}

/** Short tag for a position: "TWR". */
export function positionTag(p: ControllerPositionId): string {
  return p;
}
