import type { AircraftRef } from './callsign';
import type { FixInfo } from './fixes';
import type { ArrivalInfo } from './rules-airport';

/** What the parser may know about the current airport and traffic. All optional except aircraft. */
export interface ParseContext {
  aircraft: AircraftRef[];
  /** Known taxiway identifiers ("A", "B", "A1"). Unknown spoken ones are reported in `issues`. */
  taxiways?: string[];
  /** Known runway ends ("4", "22", "13", "31"). */
  runwayEnds?: string[];
  /** Known frequencies, used to cross-check and fill `frequencyId`. */
  frequencies?: { id: string; mhz: number }[];
  /**
   * Named fixes / navaids for "proceed direct X" and "until X". Spoken forms are matched
   * case-insensitively; 5-letter fixes loosely (see `fixes.ts`). Without it any single word
   * after "direct" is accepted unvalidated.
   */
  fixes?: FixInfo[];
  /** Published STARs of the airport, for "cleared ROZZE two arrival" / "descend via the ROZZE two arrival" (JO 7110.65 4-7-1, 4-5-7). */
  arrivals?: ArrivalInfo[];
}
