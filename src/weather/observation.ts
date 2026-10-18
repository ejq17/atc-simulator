/**
 * Official weather observations and the ATIS (FAA JO 7110.65 2-9-2): "Make a new recording ... Upon receipt of any new official weather
 * regardless of whether there is or is not a change in values."
 *
 * "Official weather" is the routine hourly METAR and a SPECI. The live feed also delivers 5-minute ASOS observations (NWS API): those are
 * not official weather and only produce a new ATIS letter when the values change enough (atisUpdateReasons). A routine hourly METAR is
 * recognised by its observation time (minute 50-59, the ASOS routine window: KACY and KMHT report at :54), a SPECI by its "SPECI" prefix.
 */
import type { Weather } from '../sim/types';

/** First and last minute of the hour in which a routine hourly METAR is observed (simplification of the ASOS routine schedule). */
export const ROUTINE_METAR_MINUTES: readonly [number, number] = [50, 59];

function observationMinute(w: Pick<Weather, 'observedAt' | 'rawMetar'>): number | undefined {
  if (w.observedAt) {
    const d = new Date(w.observedAt);
    if (!Number.isNaN(d.getTime())) return d.getUTCMinutes();
  }
  const m = /\b\d{2}(\d{2})(\d{2})Z\b/.exec(w.rawMetar ?? '');
  return m ? Number(m[2]) : undefined;
}

/** A routine hourly METAR or a SPECI. */
export function isOfficialObservation(w: Pick<Weather, 'observedAt' | 'rawMetar'>): boolean {
  if (/^\s*SPECI\b/i.test(w.rawMetar ?? '')) return true;
  const min = observationMinute(w);
  return min !== undefined && min >= ROUTINE_METAR_MINUTES[0] && min <= ROUTINE_METAR_MINUTES[1];
}

/** `next` is an official observation that differs (observation time, else raw report) from the one the ATIS was made from. */
export function isNewObservation(prev: Pick<Weather, 'observedAt' | 'rawMetar'>, next: Pick<Weather, 'observedAt' | 'rawMetar'>): boolean {
  if (!isOfficialObservation(next)) return false;
  if (next.observedAt !== undefined) return next.observedAt !== prev.observedAt;
  return next.rawMetar !== undefined && next.rawMetar !== prev.rawMetar;
}
