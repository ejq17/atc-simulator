/**
 * Pressure and visibility units of non-US airports (EGLL).
 *
 * UK AIP GEN 3.5 para 3.8.10: QNH is "rounded down to the next whole hectopascal and reported as a four digit group preceded by the letter indicator Q"
 * (Q0995). Visibility is reported in metres, 9999 meaning 10 km or more (METAR; GEN 3.5 para 3.8). The simulator stores the altimeter in inches of
 * mercury and visibility in statute miles for every airport; these helpers convert at the edges (ATIS, displays, controller phrases).
 * 1 inHg = 33.8639 hPa (ICAO Annex 5 / standard conversion); 1 SM = 1609.344 m.
 */
export const HPA_PER_INHG = 33.8639;
export const M_PER_SM = 1609.344;

/** Whole hectopascals of an altimeter setting in inHg (rounded to nearest: the stored value is itself rounded to 0.01 inHg, 0.34 hPa). */
export function inHgToHpa(inHg: number): number {
  return Math.round(inHg * HPA_PER_INHG);
}

export function hpaToInHg(hpa: number): number {
  return Math.round((hpa / HPA_PER_INHG) * 1e4) / 1e4;
}

/** "QNH 1013" digits for a setting in inHg. */
export function qnhDigits(inHg: number): string {
  return String(inHgToHpa(inHg));
}

/** Visibility in metres as a METAR / ATIS reports it: whole 100 m below 5 km, 1 km steps to 10 km, "10 kilometres or more" from about 9.7 km. */
export function visibilityMetres(sm: number): { metres: number; tenKmOrMore: boolean } {
  const m = sm * M_PER_SM;
  if (m >= 9700) return { metres: 9999, tenKmOrMore: true };
  const step = m < 5000 ? 100 : 1000;
  return { metres: Math.max(0, Math.round(m / step) * step), tenKmOrMore: false };
}

/** "Visibility 6000 metres" / "Visibility 10 kilometres or more" (UK ATIS wording, CAP 413 chapter 4 and AIP GEN 3.5 para 7 broadcast order). */
export function visibilityText(sm: number): string {
  const v = visibilityMetres(sm);
  return v.tenKmOrMore ? '10 kilometres or more' : `${v.metres} metres`;
}
