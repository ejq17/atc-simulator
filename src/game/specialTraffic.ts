/**
 * Special traffic kinds beyond airline arrivals / departures and GA: U.S. Coast Guard helicopters, Air National Guard fighters, VFR
 * transitions through the Class C, flight training pattern work, airport vehicles. The per-airport rates live in the airport profile
 * (`AirportTrafficProfile.special`, airportProfile.ts); this file holds the kinds, the setup-screen selection and the rate arithmetic.
 *
 * Gameplay data: the RATES are design values (no traffic statistics were used); the existence of each kind at an airport is sourced in
 * data/sources/README.md ("Traffic variety") or the airport has no such traffic.
 */
import { profileFor } from './airportProfile';

export type SpecialTrafficKind = 'helicopter' | 'military' | 'transition' | 'training' | 'vehicles';
export const SPECIAL_TRAFFIC_KINDS: readonly SpecialTrafficKind[] = ['helicopter', 'military', 'transition', 'training', 'vehicles'];

/** The setup screen's checkboxes: one flag per kind. */
export type SpecialTrafficSelection = Record<SpecialTrafficKind, boolean>;

export const SPECIAL_TRAFFIC_LABELS: Readonly<Record<SpecialTrafficKind, { label: string; hint: string }>> = {
  helicopter: { label: 'Coast Guard helicopters', hint: 'MH-65 air taxi, hover and helipad departures and arrivals' },
  military: { label: 'Air National Guard fighters', hint: 'F-16C singles and flights of two, overhead pattern' },
  transition: { label: 'VFR transitions', hint: 'Class C service, squawk and radar contact for aircraft crossing the area' },
  training: { label: 'Flight training', hint: 'Student pilots flying touch-and-go pattern work' },
  vehicles: { label: 'Airport vehicles', hint: 'Runway inspections and pavement checks that need clearances' },
};

/** Kinds the airport's traffic profile has rates for (a kind with no rate cannot be selected). */
export function availableSpecialKinds(icao: string | undefined): SpecialTrafficKind[] {
  const sp = profileFor(icao).special;
  return SPECIAL_TRAFFIC_KINDS.filter((k) => !!sp?.[k]);
}

/** Free-play default: every kind the airport offers is on. */
export function defaultSpecialTraffic(icao: string | undefined): SpecialTrafficSelection {
  const on = new Set(availableSpecialKinds(icao));
  return { helicopter: on.has('helicopter'), military: on.has('military'), transition: on.has('transition'), training: on.has('training'), vehicles: on.has('vehicles') };
}

/** A selection restricted to what the airport offers (unknown or unavailable kinds are off; no selection at all = every kind off). */
export function resolveSpecialTraffic(icao: string | undefined, requested?: Partial<SpecialTrafficSelection>): SpecialTrafficSelection {
  const avail = new Set(availableSpecialKinds(icao));
  const base: Partial<SpecialTrafficSelection> = requested ?? {};
  const out = {} as SpecialTrafficSelection;
  for (const k of SPECIAL_TRAFFIC_KINDS) out[k] = avail.has(k) && base[k] === true;
  return out;
}
