/**
 * Pure display-formatting helpers shared by the panels and both canvas renderers.
 * Engine state keeps TRUE headings; controllers and pilots use MAGNETIC, so every
 * heading shown to the user goes through `magHeading`.
 */
import type { Aircraft, FlightPhase, Weather } from '../../sim/types';

const pad = (n: number, w: number) => String(Math.max(0, Math.trunc(n))).padStart(w, '0');

/** Altitude as a radar data block shows it: hundreds of feet, three digits. 2,480 ft -> "025". */
export function altHundreds(ft: number): string {
  const h = Math.round(ft / 100);
  return h < 0 ? `-${pad(-h, 2)}` : pad(h, 3);
}

/** Wrap to 1..360 (a heading of 0 is spoken and displayed as 360). */
export function wrapHeading(deg: number): number {
  const r = Math.round(((deg % 360) + 360) % 360);
  return r === 0 ? 360 : r;
}

/** TRUE -> MAGNETIC (east-positive variation, KACY = -10) as a 3-digit string. */
export function magHeading(trueDeg: number, variationDeg: number): string {
  return pad(wrapHeading(trueDeg - variationDeg), 3);
}

export function magHeadingNum(trueDeg: number, variationDeg: number): number {
  return wrapHeading(trueDeg - variationDeg);
}

/** Vertical trend glyph: climb, descend or level. Threshold 200 fpm. */
export function trendArrow(vsFpm: number): '↑' | '↓' | '' {
  if (vsFpm > 200) return '↑';
  if (vsFpm < -200) return '↓';
  return '';
}

export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${pad(s / 3600, 2)}:${pad((s % 3600) / 60, 2)}:${pad(s % 60, 2)}`;
}

/** Zulu wall clock "HH:MM:SSZ" at `startUtcMs + simSec`. */
export function formatZulu(startUtcMs: number | ((simSec: number) => number), simSec: number): string {
  const d = new Date(typeof startUtcMs === 'function' ? startUtcMs(simSec) : startUtcMs + simSec * 1000);
  return `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}Z`;
}

export function formatMhz(mhz: number): string {
  return mhz.toFixed(3).replace(/0$/, '');
}

/** Wind as the tower would give it: magnetic direction, speed, gusts. "300/17G23", "CALM", "VRB05". */
export function windText(w: Weather, variationDeg: number): string {
  if (w.windSpeedKt === 0) return 'CALM';
  const gust = w.windGustKt ? `G${pad(w.windGustKt, 2)}` : '';
  if (w.windDirDeg === 'VRB') return `VRB${pad(w.windSpeedKt, 2)}${gust}`;
  return `${magHeading(w.windDirDeg, variationDeg)}/${pad(w.windSpeedKt, 2)}${gust}`;
}

export function altimeterText(inHg: number): string {
  return `A${pad(Math.round(inHg * 100), 4)}`;
}

/** Short phase codes used in data labels and the strip list. */
export const PHASE_SHORT: Record<string, string> = {
  PARKED: 'PK', PUSHBACK: 'PB', READY: 'RDY', TAXIING: 'TX', HOLDING_SHORT: 'HS', LINE_UP_AND_WAIT: 'LUAW',
  CLEARED_FOR_TAKEOFF: 'CTO', TAKEOFF_ROLL: 'ROLL', INITIAL_CLIMB: 'ICL', DEPARTURE: 'DEP',
  INBOUND: 'INB', APPROACH: 'APP', FINAL: 'FIN', LANDING: 'LDG', ROLLOUT: 'RLO',
  RUNWAY_EXIT: 'EXT', TAXI_TO_PARKING: 'TXP', ARRIVED: 'ARR', GO_AROUND: 'GA', PATTERN: 'PAT', HOLDING: 'HLD',
};

export function phaseShort(phase: FlightPhase | string): string {
  return PHASE_SHORT[phase] ?? phase.slice(0, 4);
}

export function phaseLabel(phase: FlightPhase | string): string {
  return phase.replace(/_/g, ' ');
}

export type StatusTone = 'idle' | 'taxi' | 'hold' | 'runway' | 'airborne' | 'arrival' | 'alert';

/** Colour class of an aircraft by operational state (used by strips, symbols and radar blocks). */
export function statusTone(ac: Pick<Aircraft, 'phase' | 'onGround' | 'flags'>): StatusTone {
  if (ac.flags?.emergency) return 'alert';
  switch (ac.phase) {
    case 'PARKED': case 'READY': case 'ARRIVED': return 'idle';
    case 'PUSHBACK': return 'taxi';
    case 'TAXIING': case 'TAXI_TO_PARKING': case 'RUNWAY_EXIT': return 'taxi';
    case 'HOLDING_SHORT': case 'LINE_UP_AND_WAIT': return 'hold';
    case 'CLEARED_FOR_TAKEOFF': case 'TAKEOFF_ROLL': case 'LANDING': case 'ROLLOUT': return 'runway';
    case 'GO_AROUND': return 'alert';
    case 'INBOUND': case 'APPROACH': case 'FINAL': case 'PATTERN': case 'HOLDING': return 'arrival';
    default: return 'airborne';
  }
}

export const TONE_COLOR: Record<StatusTone, string> = {
  idle: '#7f8a96',
  taxi: '#39d353',
  hold: '#f2b33d',
  runway: '#ffffff',
  airborne: '#7bd88f',
  arrival: '#39c5e8',
  alert: '#ff4d4f',
};

export function formatClearance(k: string): string {
  return k.replace(/_/g, ' ');
}

/** Spoken-style runway id for UI text: "13/31" stays, ends stay. */
export function sameMhz(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0005;
}
