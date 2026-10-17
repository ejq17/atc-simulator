import type { ParseResult } from '../sim/types';
import type { ParseContext } from './context';
import { parse } from './parse';

export type { ParseContext } from './context';
export type { FixInfo } from './fixes';
export type { AircraftRef, CallsignResolution } from './callsign';
export { resolveCallsign, CALLSIGN_ACCEPT } from './callsign';
export { commandConfidence } from './confidence';
export { normalize } from './normalize';
export { rawSlice } from './tokens';
export type { NormalizedText, Token } from './tokens';

/**
 * Interpret one ATC transmission (STT output or typed text) as zero or more
 * structured commands. Pure function; the engine validates and executes.
 */
export function parseTransmission(text: string, ctx: ParseContext): ParseResult {
  return parse(text, ctx);
}
