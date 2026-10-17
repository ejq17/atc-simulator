import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../sim/types';
import { aiHandoffs, filterEvents } from './CommsLog';

const ev = (id: string, timeSec: number, over: Partial<SimEvent>): SimEvent => ({ id, timeSec, kind: 'TRANSMISSION', text: '', severity: 'info', ...over });

describe('AI transmissions and handoffs in the comms log', () => {
  const events: SimEvent[] = [
    ev('1', 100, { speaker: 'ATC', aiPosition: 'TWR', callsign: 'NKS451', text: 'Spirit four fifty one, runway 13, cleared to land' }),
    ev('2', 160, { speaker: 'ATC', aiPosition: 'TWR', callsign: 'NKS451', text: 'Spirit four fifty one, contact Ground one two one point nine' }),
    ev('3', 162, { speaker: 'PILOT', callsign: 'NKS451', text: 'Contact Ground' }),
    ev('4', 165, { kind: 'HANDOFF', speaker: 'SYSTEM', callsign: 'NKS451', text: 'NKS451 changed to 121.900 (GND)' }),
    ev('5', 300, { kind: 'HANDOFF', speaker: 'SYSTEM', callsign: 'N723EJ', text: 'N723EJ changed to 121.900 (GND)' }),
  ];

  it('attributes a frequency change to the AI that told the aircraft to contact the next position', () => {
    const m = aiHandoffs(events);
    expect(m.get('4')).toBe('TWR');
    expect(m.has('5')).toBe(false); // a handoff the player made (no AI call before it)
    expect(m.size).toBe(1);
  });

  it('ignores an AI "contact" call that is too old, and handoffs the engine already tags', () => {
    expect(aiHandoffs([events[1], ev('9', 400, { kind: 'HANDOFF', speaker: 'SYSTEM', callsign: 'NKS451', text: 'x' })]).size).toBe(0);
    expect(aiHandoffs([events[1], ev('9', 165, { kind: 'HANDOFF', speaker: 'SYSTEM', callsign: 'NKS451', text: 'x', aiPosition: 'TWR' })]).size).toBe(0);
  });

  it('keeps AI calls and handoffs in the Radio filter', () => {
    expect(filterEvents(events, 'comms').map((e) => e.id)).toEqual(['1', '2', '3', '4', '5']);
  });
});
