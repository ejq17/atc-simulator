import type { ParsedCommand } from '../sim/types';
import type { AircraftRef } from './callsign';
import type { ParseContext } from './context';

/** Shared fixtures for the command tests (not a test file itself). */
export const AIRCRAFT: AircraftRef[] = [
  { callsign: 'N723EJ', spokenCallsign: 'Cessna seven two three echo juliet', type: 'C172' },
  { callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', type: 'A320' },
  { callsign: 'AAL1234', spokenCallsign: 'American twelve thirty four', type: 'B738' },
  { callsign: 'DAL88', spokenCallsign: 'Delta eighty eight', type: 'B739' },
  { callsign: 'N45PX', spokenCallsign: 'Piper four five papa x-ray', type: 'PA28' },
  { callsign: 'UAL202', spokenCallsign: 'United two oh two', type: 'A319' },
  { callsign: 'JBU615', spokenCallsign: 'JetBlue six fifteen', type: 'A320' },
  { callsign: 'SWA1717', spokenCallsign: 'Southwest seventeen seventeen', type: 'B737' },
  { callsign: 'FDX1011', spokenCallsign: 'FedEx ten eleven', type: 'B763' },
];

/** Shares the "three echo juliet" suffix with N723EJ. */
export const N993EJ: AircraftRef = { callsign: 'N993EJ', spokenCallsign: 'Cirrus nine nine three echo juliet', type: 'SR22' };

export const CTX: ParseContext = {
  aircraft: AIRCRAFT,
  taxiways: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'A1', 'B1', 'C1'],
  runwayEnds: ['4', '22', '13', '31'],
  frequencies: [
    { id: 'GND', mhz: 121.9 }, { id: 'TWR', mhz: 120.3 }, { id: 'APP', mhz: 124.6 },
    { id: 'DEP', mhz: 118.1 }, { id: 'CLNC', mhz: 121.65 },
  ],
};

export interface Case {
  say: string;
  /** Expected commands, matched in order with toMatchObject (extra fields allowed). */
  cmds: Partial<ParsedCommand>[];
  /** Substring that must appear in the issues of some command. */
  issue?: string;
  /** Substrings that must appear in NO command's issues. */
  clean?: boolean;
  /** Inclusive confidence bounds applied to every command. */
  conf?: [number, number];
  ctx?: ParseContext;
}
