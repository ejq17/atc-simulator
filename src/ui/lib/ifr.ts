/**
 * Display helpers for IFR state: flight plan, navigation mode, issued IFR clearance, approach clearance and the
 * descriptive pending-request badges. Pure functions of engine data (no copies are kept).
 */
import type { Aircraft, Clearance, IfrClearanceDetails, PendingRequest, SimulationState } from '../../sim/types';
import { M_PER_NM, headingVec } from './geom';
import { formatMhz, magHeading } from './format';
import { pickProcedure } from './procedures';

/** Badge text for what a pilot is waiting for. `OTHER` is the generic check-in after a frequency change. */
export const REQUEST_BADGE: Record<PendingRequest['kind'], string> = {
  IFR_CLEARANCE: 'REQ IFR CLNC',
  APPROACH: 'REQ APPROACH',
  OTHER: 'CHECK-IN',
  TAXI: 'REQ TAXI',
  DEPARTURE: 'REQ DEPARTURE',
  LANDING: 'REQ LANDING',
  FREQUENCY_CHANGE: 'REQ FREQ CHG',
  CROSSING: 'REQ CROSSING',
  PATTERN: 'REQ PATTERN',
};

export function requestBadge(kind: PendingRequest['kind']): string {
  return REQUEST_BADGE[kind] ?? `REQ ${String(kind).replace(/_/g, ' ')}`;
}

export type NavLetter = 'V' | 'R' | 'A' | '';

/**
 * Data-block mode letter: V radar vectors (also an IFR aircraft holding a heading), R route (route or direct-to),
 * A approach (flying the approach route, or cleared and intercepting). Blank on the ground and for VFR traffic on its own navigation.
 */
export function navLetter(ac: Pick<Aircraft, 'nav' | 'onGround' | 'flightRules' | 'clearances'>): NavLetter {
  if (ac.onGround) return '';
  if (ac.nav?.mode === 'approach' || openClearance(ac, 'APPROACH')) return 'A';
  if (ac.nav) return ac.nav.mode === 'vectors' ? 'V' : 'R';
  return ac.flightRules === 'IFR' ? 'V' : '';
}

/** The fix the aircraft is flying to now. */
export function nextFix(ac: Pick<Aircraft, 'nav'>): string | undefined {
  const n = ac.nav;
  return n ? n.fixes[Math.min(n.index, n.fixes.length - 1)] : undefined;
}

/** The latest, still-open clearance of a kind. */
export function openClearance(ac: Pick<Aircraft, 'clearances'>, kind: Clearance['kind']): Clearance | undefined {
  for (let i = ac.clearances.length - 1; i >= 0; i--) {
    const c = ac.clearances[i];
    if (c.kind === kind) return c.completedAtSec === undefined ? c : undefined;
  }
  return undefined;
}

export type ApproachState = 'none' | 'cleared' | 'established';

export interface ApproachInfo {
  state: ApproachState;
  /** "ILS 13" */
  label: string;
}

/**
 * Cleared approach and whether the aircraft is established on it. The engine keeps `approach` private, so this reads the
 * open APPROACH clearance and checks the geometry the same way a controller would: on the FINAL phase, or within ~0.5 nm of the
 * final approach course heading within 30 degrees of the runway.
 */
export function approachInfo(state: Pick<SimulationState, 'airport'>, ac: Aircraft): ApproachInfo {
  const c = openClearance(ac, 'APPROACH');
  if (!c) return { state: 'none', label: '' };
  const end = c.runwayEnd ?? ac.assignedRunwayEnd ?? '';
  const label = `${c.approachType ?? 'APP'}${end ? ` ${end}` : ''}`;
  if (ac.phase === 'FINAL' || ac.phase === 'LANDING' || ac.phase === 'ROLLOUT') return { state: 'established', label };
  const re = state.airport.runways.flatMap((r) => r.ends).find((e) => e.id === end);
  if (re && !ac.onGround) {
    const dir = headingVec(re.trueHeadingDeg);
    const dx = (ac.pos.x - re.threshold.x) / M_PER_NM;
    const dy = (ac.pos.y - re.threshold.y) / M_PER_NM;
    const along = -(dx * dir.x + dy * dir.y);
    const cross = dx * -dir.y + dy * dir.x;
    const rel = Math.abs((((ac.headingDeg - re.trueHeadingDeg) % 360) + 540) % 360 - 180);
    if (along > 0 && Math.abs(cross) <= 0.5 && rel <= 30) return { state: 'established', label };
  }
  return { state: 'cleared', label };
}

/** "Route to CARYL" / "Direct VCN" / "Approach ILS 13" / "Vectors". */
export function navDescription(state: Pick<SimulationState, 'airport'>, ac: Aircraft): string {
  if (ac.onGround) return '—';
  const n = ac.nav;
  if (!n) {
    if (ac.flightRules !== 'IFR') return 'Own navigation / pattern';
    const a = approachInfo(state, ac);
    const hdg = `heading ${magHeading(ac.headingDeg, state.airport.magneticVariationDeg)}`;
    return a.state === 'cleared' ? `Vectors, ${hdg} · intercepting ${a.label}` : `Vectors, ${hdg}`;
  }
  const next = nextFix(ac);
  switch (n.mode) {
    case 'route': return `Route${next ? ` to ${next}` : ''}`;
    case 'direct': return `Direct ${next ?? ''}`.trim();
    case 'approach': {
      const a = approachInfo(state, ac);
      return `Approach ${a.label || ''}${next ? ` (${next})` : ''}`.trim();
    }
    case 'vectors': return 'Vectors';
    default: return n.mode;
  }
}

/** The fixes still ahead of the aircraft on its active route, in order (empty when none). */
export function remainingFixes(ac: Pick<Aircraft, 'nav'>): string[] {
  const n = ac.nav;
  return n ? n.fixes.slice(Math.min(n.index, n.fixes.length)) : [];
}

export function altText(ft: number): string {
  return ft >= 18000 ? `FL${Math.round(ft / 100)}` : `${Math.round(ft).toLocaleString('en-US')}`;
}

type Issued = NonNullable<NonNullable<Aircraft['flightPlan']>['ifrClearance']>;

/** One-line IFR clearance summary: "KPHL · ATLANTIC CITY THREE · maintain 2,000 · expect 10,000 · DEP 124.6 · sqk 4215". */
export function ifrClearanceParts(c: IfrClearanceDetails | Issued): { label: string; value: string }[] {
  const parts: { label: string; value: string }[] = [
    { label: 'Cleared to', value: c.destination },
    { label: 'Via', value: c.departureProcedure ? `${c.departureProcedure} departure` : c.routeText },
    { label: 'Maintain', value: altText(c.initialAltitudeFt) },
  ];
  if (c.expectAltitudeFt) parts.push({ label: 'Expect', value: altText(c.expectAltitudeFt) });
  parts.push({ label: 'Departure', value: formatMhz(c.departureFrequencyMhz) }, { label: 'Squawk', value: c.squawk });
  return parts;
}

export function ifrClearanceSummary(c: IfrClearanceDetails | Issued): string {
  const p = ifrClearanceParts(c);
  const get = (l: string) => p.find((x) => x.label === l)?.value;
  return [
    get('Cleared to'),
    get('Via'),
    `maintain ${get('Maintain')}`,
    get('Expect') ? `expect ${get('Expect')}` : undefined,
    `dep ${get('Departure')}`,
    `sqk ${get('Squawk')}`,
  ].filter(Boolean).join(' · ');
}

/** Short clearance text for a flight-strip: approach, IFR clearance or the latest open clearance. */
export function stripClearance(state: Pick<SimulationState, 'airport'>, ac: Aircraft): string {
  const a = approachInfo(state, ac);
  if (a.state !== 'none') return `${a.state === 'established' ? 'Est.' : 'Cleared'} ${a.label}`;
  const ic = ac.flightPlan?.ifrClearance;
  if (ic && ac.isDeparture && ac.onGround) return `CLNC ${ic.destination} ${ic.departureProcedure ?? ''} ${altText(ic.initialAltitudeFt)}`.replace(/\s+/g, ' ').trim();
  const open = [...ac.clearances].reverse().find((c) => c.completedAtSec === undefined && c.kind !== 'CONTACT_FREQUENCY');
  if (!open) return '';
  if (open.kind === 'HEADING') return `HDG ${String(Math.round(open.headingDeg ?? 0)).padStart(3, '0')}`;
  if (open.kind === 'ALTITUDE') return `ALT ${altText(open.altitudeFt ?? 0)}`;
  if (open.kind === 'DIRECT_FIX') return `DIRECT ${open.fix ?? ''}`.trim();
  if (open.kind === 'TAKEOFF' || open.kind === 'LAND') return `${open.kind === 'LAND' ? 'LAND' : 'TKOF'} ${open.runwayEnd ?? ''}`.trim();
  return open.kind.replace(/_/g, ' ');
}

type FixAlt = NonNullable<import('../../sim/types').InstrumentProcedure['fixAltitudes']>[number];

/** "2,000" / "at 1,500" / "at or above 2,000" / "at or below 3,000" / "2,000-3,000" for a published fix altitude. */
export function fixAltitudeText(a: Pick<FixAlt, 'minAltitudeFt' | 'maxAltitudeFt' | 'mandatoryAltitudeFt'>): string {
  const f = (n: number) => n.toLocaleString('en-US');
  if (a.mandatoryAltitudeFt !== undefined) return `at ${f(a.mandatoryAltitudeFt)}`;
  if (a.minAltitudeFt !== undefined && a.maxAltitudeFt !== undefined) return `${f(a.minAltitudeFt)}-${f(a.maxAltitudeFt)}`;
  if (a.minAltitudeFt !== undefined) return `at or above ${f(a.minAltitudeFt)}`;
  if (a.maxAltitudeFt !== undefined) return `at or below ${f(a.maxAltitudeFt)}`;
  return '';
}

/** Published altitudes (`procedure.fixAltitudes`) of the procedure the aircraft is cleared for; empty without data. */
export function approachFixAltitudes(state: Pick<SimulationState, 'airport'>, ac: Aircraft): { fix: string; text: string; note?: string }[] {
  const c = openClearance(ac, 'APPROACH');
  if (!c) return [];
  const end = c.runwayEnd ?? ac.assignedRunwayEnd;
  if (!end) return [];
  const pick = pickProcedure(state.airport, end, c.approachType);
  return (pick?.procedure.fixAltitudes ?? [])
    .map((a) => ({ fix: a.fix, text: fixAltitudeText(a), note: a.note }))
    .filter((a) => a.text);
}

/** LAHSO state of an open landing clearance that carries hold-short runways, from `RunwayEnd.lahso`; undefined otherwise. */
export function lahsoBadge(state: Pick<SimulationState, 'airport'>, ac: Aircraft): string | undefined {
  const c = openClearance(ac, 'LAND');
  if (!c?.holdShort?.length) return undefined;
  const end = c.runwayEnd ?? ac.assignedRunwayEnd;
  const re = state.airport.runways.flatMap((r) => r.ends).find((e) => e.id === end);
  const l = re?.lahso;
  const rwy = c.holdShort.join(', ');
  return l ? `LAHSO: hold short ${rwy}, ${l.availableLandingDistanceFt.toLocaleString('en-US')} ft available` : `LAHSO: hold short ${rwy}`;
}
