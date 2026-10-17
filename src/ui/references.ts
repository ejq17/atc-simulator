/**
 * FAA JO 7110.65 paragraph numbers and titles, verified 2026-10-16 (see docs/FAA-REFERENCES.md).
 * Only the number and title are used (paraphrased topic, never quoted text). Do not add paragraphs that are not in
 * docs/FAA-REFERENCES.md unless they were verified the same way.
 */
import type { ConflictAlert } from '../sim/types';

export interface FaaRef { para: string; title: string }

export const FAA_REFS = {
  groundMovement: { para: '3-7-2', title: 'TAXI AND GROUND MOVEMENT OPERATIONS' },
  lineUp: { para: '3-9-4', title: 'LINE UP AND WAIT (LUAW)' },
  sameRunwayDeparture: { para: '3-9-6', title: 'SAME RUNWAY SEPARATION' },
  intersectingDeparture: { para: '3-9-8', title: 'INTERSECTING RUNWAY/INTERSECTING FLIGHT PATH OPERATIONS' },
  takeoffClearance: { para: '3-9-10', title: 'TAKEOFF CLEARANCE' },
  sameRunwayArrival: { para: '3-10-3', title: 'SAME RUNWAY SEPARATION' },
  landingClearance: { para: '3-10-5', title: 'LANDING CLEARANCE' },
  withholdLanding: { para: '3-10-8', title: 'WITHHOLDING LANDING CLEARANCE' },
  runwayExiting: { para: '3-10-9', title: 'RUNWAY EXITING' },
} as const satisfies Record<string, FaaRef>;

/** Reference topics relevant to a conflict alert (empty when none of the verified paragraphs fits). */
export function refsForAlert(kind: ConflictAlert['kind']): FaaRef[] {
  switch (kind) {
    case 'RUNWAY_INCURSION': return [FAA_REFS.groundMovement];
    case 'RUNWAY_CONFLICT': return [FAA_REFS.sameRunwayDeparture, FAA_REFS.sameRunwayArrival, FAA_REFS.intersectingDeparture];
    case 'UNSAFE_CLEARANCE': return [FAA_REFS.takeoffClearance, FAA_REFS.landingClearance];
    case 'GROUND_PROXIMITY': return [FAA_REFS.groundMovement];
    default: return [];
  }
}

export function formatRef(r: FaaRef): string {
  return `JO 7110.65 ${r.para} ${r.title}`;
}
