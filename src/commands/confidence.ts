import type { CommandKind } from '../sim/types';
import { CALLSIGN_ACCEPT } from './callsign';

export interface ConfidenceInputs {
  kind: CommandKind;
  /** fraction of tokens consumed by recognised structure, 0..1 */
  coverage: number;
  /** callsign match score; null when no callsign was resolved */
  callsignScore: number | null;
  /** required entities absent (see requirements.ts) */
  missingRequired: number;
  /** contradictory entities (two runways, heading out of range ...) */
  conflicts: number;
  /** identifiers unknown to the airport context or invalid on their face */
  unknownIds: number;
  /** non-standard phraseology deviations ("line up" without "and wait") */
  nonstandard: number;
}

/**
 * Confidence in [0, 0.99], the product of independent factors:
 *
 *   Fg = coverage ^ 0.75                    grammar coverage (garbage words hurt)
 *   Fc = 0.40 if no callsign resolved       callsign factor
 *        else 0.85 + 0.15 * (score - 0.75) / 0.25     (score 0.75 -> 0.85, 1.0 -> 1.0)
 *   Fe = 0.55 ^ missingRequired             required entities (runway, value ...)
 *   Fx = 0.60 ^ conflicts                   conflicting entities
 *   Fu = 0.85 ^ unknownIds                  identifiers unknown to the airport
 *   Fn = 0.90 ^ nonstandard                 non-standard phraseology
 *
 *   confidence = min(0.99, Fg * Fc * Fe * Fx * Fu * Fn)      rounded to 2 dp
 *
 * UNKNOWN commands are capped at 0.1 * Fg. A clean, complete, standard
 * instruction with an exact callsign scores 0.99; a missing callsign can never
 * exceed 0.40, so the engine's "below threshold => clarify" rule triggers.
 */
export function commandConfidence(i: ConfidenceInputs): number {
  const fg = Math.pow(Math.max(0, Math.min(1, i.coverage)), 0.75);
  if (i.kind === 'UNKNOWN') return round2(0.1 * fg);
  const fc = i.callsignScore === null
    ? 0.4
    : 0.85 + 0.15 * Math.max(0, Math.min(1, (i.callsignScore - CALLSIGN_ACCEPT) / (1 - CALLSIGN_ACCEPT)));
  const raw = fg * fc * Math.pow(0.55, i.missingRequired) * Math.pow(0.6, i.conflicts)
    * Math.pow(0.85, i.unknownIds) * Math.pow(0.9, i.nonstandard);
  return round2(Math.min(0.99, raw));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
