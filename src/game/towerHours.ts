/**
 * Tower hours (NASR TWR_HRS) against the real clock. The simulator staffs every position at every hour; this only tells the player when
 * the real tower would be closed (no CTAF/non-towered mode is simulated).
 */
import { airportTimeZone } from './trafficDensity';

/** Opening interval in local minutes after midnight, or 'always' for "24". Undefined for text this parser does not know. */
export function parseTowerHours(hours: string | undefined): { openMin: number; closeMin: number } | 'always' | undefined {
  const t = hours?.trim();
  if (!t) return undefined;
  if (t === '24') return 'always';
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(t);
  if (!m) return undefined;
  const [oh, om, ch, cm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (oh > 24 || ch > 24 || om > 59 || cm > 59) return undefined;
  return { openMin: oh * 60 + om, closeMin: ch * 60 + cm };
}

/** Local minutes after midnight at a UTC instant in an IANA time zone. */
export function localMinuteAt(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

/** True/false when the hours string is known, undefined when it is not. Intervals that cross midnight (2200-0600) are handled. */
export function towerOpenAt(hours: string | undefined, timeZone: string, utcMs: number): boolean | undefined {
  const p = parseTowerHours(hours);
  if (!p) return undefined;
  if (p === 'always') return true;
  const now = localMinuteAt(utcMs, timeZone);
  return p.openMin <= p.closeMin ? now >= p.openMin && now < p.closeMin : now >= p.openMin || now < p.closeMin;
}

/** "24 hours" / "0600-2100 local" for the setup screen; undefined when the airport data has no tower hours. */
export function towerHoursLabel(hours: string | undefined): string | undefined {
  const p = parseTowerHours(hours);
  if (!p) return hours?.trim() ? `${hours!.trim()} (as published)` : undefined;
  return p === 'always' ? '24 hours' : `${hours!.trim()} local`;
}

/** The notice shown when the real clock is outside the tower's hours; undefined while it is open or the hours are unknown. */
export function towerClosedNotice(airport: { towerHours?: string; timeZone?: string }, towerName: string, utcMs: number): string | undefined {
  if (towerOpenAt(airport.towerHours, airportTimeZone(airport), utcMs) !== false) return undefined;
  return `${towerName} Tower is closed at this hour in reality (${airport.towerHours!.trim()} local); the simulator staffs it anyway.`;
}
