/**
 * Runway visual range (RVR) for the ATIS and for landing information.
 *
 * Source of the numbers: 14 CFR 91.175(h)(2) "RVR value to visibility in statute miles" (eCFR, retrieved 2026-10-18) which is the same
 * table as AIM TBL 5-4-1 "RVR Value Conversions":
 *
 *     RVR 1,600 ft = 1/4 SM   2,400 = 1/2   3,200 = 5/8   4,000 = 3/4   4,500 = 7/8   5,000 = 1   6,000 = 1 1/4
 *
 * AIM 5-4-20: "For converting RVR values that fall between listed values, use the next higher RVR value; do not interpolate."
 *
 * When RVR is issued, and how: JO 7110.65 2-8-2 (issue the touchdown RVR for the runway in use when the prevailing visibility is 1 mile
 * or less, or when RVR indicates a reportable value, "RVR 6,000 feet or less"), 2-8-3 (runway, "RVR", value; "more than" / "less than"
 * the readable value): "Runway Two Seven RVR Two Thousand Four Hundred."
 *
 * NO SENSOR MODEL (task rule): the simulator has no transmissometers, no patchy fog and no day / night or light-setting effect on RVR.
 * It inverts the table once: the RVR reported for a prevailing visibility is the largest listed RVR whose converted visibility does
 * not exceed it (so converting the reported RVR back with the AIM rule gives a visibility no larger than the one in the METAR).
 * Below the table's lowest row (visibility under 1/4 SM) the simulator says "less than one thousand six hundred" instead of inventing a
 * number. RVR equipment is assumed on runway ends that have an ILS (the plates of such runways print RVR minima; the NASR data has no
 * RVR equipment field): see `runwayHasRvr`.
 */
export const RVR_TABLE: readonly { rvrFt: number; visibilitySm: number }[] = [
  { rvrFt: 1600, visibilitySm: 0.25 },
  { rvrFt: 2400, visibilitySm: 0.5 },
  { rvrFt: 3200, visibilitySm: 0.625 },
  { rvrFt: 4000, visibilitySm: 0.75 },
  { rvrFt: 4500, visibilitySm: 0.875 },
  { rvrFt: 5000, visibilitySm: 1 },
  { rvrFt: 6000, visibilitySm: 1.25 },
];

/** Reportable RVR values are 6,000 ft or less (JO 7110.65 2-8-2 NOTE). */
export const RVR_MAX_REPORTABLE_FT = 6000;

/** AIM 5-4-20 / 91.175(h): RVR -> visibility (SM), using the next higher listed RVR for values between rows; undefined above the table. */
export function visibilityFromRvr(rvrFt: number): number | undefined {
  const row = RVR_TABLE.find((r) => r.rvrFt >= rvrFt);
  return row?.visibilitySm;
}

export type RvrReport =
  | { kind: 'value'; rvrFt: number }
  | { kind: 'less_than'; rvrFt: number };

/**
 * RVR to issue for a prevailing visibility (SM), or undefined when none is required (visibility above 1 1/4 SM: the converted RVR
 * would exceed the 6,000 ft reportable limit and the visibility is above 1 SM, 2-8-2).
 */
export function rvrForVisibility(visibilitySm: number): RvrReport | undefined {
  if (!(visibilitySm <= RVR_TABLE[RVR_TABLE.length - 1].visibilitySm + 1e-9)) return undefined;
  let best: number | undefined;
  for (const r of RVR_TABLE) if (r.visibilitySm <= visibilitySm + 1e-9) best = r.rvrFt;
  return best === undefined ? { kind: 'less_than', rvrFt: RVR_TABLE[0].rvrFt } : { kind: 'value', rvrFt: best };
}

/** RVR equipment is assumed on a runway end with an instrument landing system (see the header). */
export function runwayHasRvr(end: { ils?: unknown } | undefined): boolean {
  return !!end?.ils;
}

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
const sp = (s: string | number): string => String(s).split('').map((c) => DIGIT_WORDS[Number(c)] ?? c).join(' ');

/** "one thousand six hundred" style: 2-4-17 says RVR values are spoken as a thousands/hundreds count ("Two Thousand Four Hundred"). */
export function spokenRvr(rvrFt: number): string {
  const thousands = Math.floor(rvrFt / 1000);
  const hundreds = Math.floor((rvrFt % 1000) / 100);
  const word = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const parts: string[] = [];
  if (thousands) parts.push(`${word[thousands]} thousand`);
  if (hundreds) parts.push(`${word[hundreds]} hundred`);
  return parts.join(' ') || 'zero';
}

/** Display ("RVR 2400", "RVR less than 1600") and spoken ("RVR two thousand four hundred") forms for runway `runway`. */
export function rvrPhrase(runwayEnd: string, r: RvrReport): { display: string; spoken: string } {
  const more = r.kind === 'less_than';
  const rwySpoken = runwayEnd.replace(/^0/, '').replace(/(\d+)([LRC]?)/i, (_m, d: string, s: string) => `${sp(d)}${s ? ` ${({ L: 'left', R: 'right', C: 'center' } as Record<string, string>)[s.toUpperCase()]}` : ''}`);
  return {
    display: `Runway ${runwayEnd} RVR ${more ? 'less than ' : ''}${r.rvrFt}.`,
    spoken: `Runway ${rwySpoken} RVR ${more ? 'less than ' : ''}${spokenRvr(r.rvrFt)}.`,
  };
}
