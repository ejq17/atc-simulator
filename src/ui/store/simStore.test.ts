import { describe, expect, it } from 'vitest';
import { loadKacy } from '../../airport';
import { getPresetWeather } from '../../weather/presets';
import { choiceFromSetup, POSITION_CHOICES, recommendedRunways, suggestPosition } from './simStore';
import { describeVoiceStatus, keyLabel } from '../lib/voiceStatus';
import { airportTitle } from '../components/TopBar';
import { filterEvents } from '../components/CommsLog';
import { filterTimeline } from '../screens/DebriefScreen';
import { sortAircraft } from '../components/AircraftPanel';
import { describeClearance } from '../components/AircraftDetails';
import { formatRef, refsForAlert, FAA_REFS } from '../references';
import type { Aircraft, SimEvent } from '../../sim/types';

describe('runway recommendation for the setup screen', () => {
  const airport = loadKacy();
  it('picks the best-headwind end from the wind', () => {
    const w = getPresetWeather('strong-winds');
    const rec = recommendedRunways(w, airport);
    expect(rec.landing).toEqual(rec.departing);
    expect(['4', '22', '13', '31']).toContain(rec.landing[0]);
    expect(rec.summary).toMatch(/Runway|runway/);
  });
  it('uses the preferred runway when the wind is calm', () => {
    const calm = { ...getPresetWeather('clear'), windSpeedKt: 0, windDirDeg: 0 };
    expect(recommendedRunways(calm, airport).landing).toEqual(['31']);
  });
});

describe('controller position helpers', () => {
  it('maps scenario positions to a choice', () => {
    expect(suggestPosition(['TWR'])).toBe('TWR');
    expect(suggestPosition(['GND'])).toBe('GND');
    expect(suggestPosition(['GND', 'TWR'])).toBe('TWR+GND');
    expect(suggestPosition(['TWR', 'GND'])).toBe('TWR+GND');
    expect(suggestPosition(['APP'])).toBe('APP');
  });
  it('round-trips choice <-> positions', () => {
    for (const k of Object.keys(POSITION_CHOICES) as (keyof typeof POSITION_CHOICES)[]) expect(choiceFromSetup({ positions: POSITION_CHOICES[k] })).toBe(k);
  });
});

describe('voice status text', () => {
  it('has a clear human message for each state', () => {
    expect(describeVoiceStatus('unsupported', 'webspeech', 'Speech recognition is not available.').text).toMatch(/typed command/i);
    expect(describeVoiceStatus('permission_denied', 'webspeech').text).toMatch(/permission/i);
    expect(describeVoiceStatus('listening', 'webspeech').badge).toBe('TRANSMITTING');
    expect(describeVoiceStatus('idle', 'webspeech', undefined, 'SPACE').text).toMatch(/hold SPACE/);
    expect(describeVoiceStatus('idle', 'none').badge).toBe('VOICE OFF');
    expect(describeVoiceStatus('error', 'deepgram', 'network down').text).toMatch(/network down/);
  });
  it('labels keys', () => {
    expect(keyLabel('Space')).toBe('SPACE');
    expect(keyLabel('KeyT')).toBe('T');
    expect(keyLabel('F2')).toBe('F2');
  });
});

describe('panel helpers', () => {
  it('titles the airport as in the brief', () => {
    expect(airportTitle('ATLANTIC CITY INTL', 'KACY')).toBe('Atlantic City Intl (KACY)');
    expect(airportTitle('ATLANTIC CITY INTERNATIONAL', 'KACY')).toBe('Atlantic City Intl (KACY)');
  });
  const ev = (over: Partial<SimEvent>): SimEvent => ({ id: Math.random().toString(), timeSec: 0, kind: 'INFO', text: 'x', severity: 'info', ...over });
  it('radio filter keeps comms and warnings, hides phase noise and the engine true-wind note', () => {
    const events = [
      ev({ kind: 'TRANSMISSION', speaker: 'PILOT' }), ev({ kind: 'PHASE_CHANGE' }), ev({ kind: 'COMMAND_REJECTED', severity: 'warning' }),
      ev({ kind: 'INFO', text: 'Weather updated: wind 110/6 kt', speaker: 'SYSTEM' }), ev({ kind: 'RUNWAY_ENTERED' }),
      ev({ kind: 'INFO', text: 'ATIS information Bravo is current', speaker: 'SYSTEM' }),
    ];
    expect(filterEvents(events, 'comms').map((e) => e.kind)).toEqual(['TRANSMISSION', 'COMMAND_REJECTED', 'INFO']);
    expect(filterEvents(events, 'all')).toHaveLength(5);
  });
  it('debrief timeline filter by severity', () => {
    const items = [
      { timeSec: 1, kind: 'A', text: 'a', severity: 'info' as const }, { timeSec: 2, kind: 'B', text: 'b', severity: 'warning' as const }, { timeSec: 3, kind: 'C', text: 'c', severity: 'critical' as const },
    ];
    expect(filterTimeline(items, 'all')).toHaveLength(3);
    expect(filterTimeline(items, 'warning').map((i) => i.kind)).toEqual(['B', 'C']);
    expect(filterTimeline(items, 'critical').map((i) => i.kind)).toEqual(['C']);
  });
  it('sorts aircraft with pending requests first', () => {
    const mk = (callsign: string, phase: string, pending?: boolean) => ({ callsign, phase, onGround: true, flags: {}, pendingRequest: pending ? { kind: 'TAXI', text: '', sinceSec: 0 } : undefined }) as unknown as Aircraft;
    const sorted = sortAircraft([mk('B1', 'TAXIING'), mk('A1', 'PARKED'), mk('C1', 'PARKED', true)]);
    expect(sorted[0].callsign).toBe('C1');
    expect(sorted[1].callsign).toBe('B1');
  });
  it('describes clearances compactly', () => {
    expect(describeClearance({ id: '1', kind: 'TAKEOFF', issuedAtSec: 0, byPosition: 'TWR', runwayEnd: '13' })).toBe('TAKEOFF RWY 13');
    expect(describeClearance({ id: '2', kind: 'TAXI', issuedAtSec: 0, byPosition: 'GND', route: ['A', 'B'], holdShort: ['13/31'] })).toBe('TAXI via A B hold short 13/31');
    expect(describeClearance({ id: '3', kind: 'HEADING', issuedAtSec: 0, byPosition: 'TWR', headingDeg: 270, turnDirection: 'left' })).toBe('HEADING 270 left');
  });
});

describe('FAA references (verified table only)', () => {
  it('uses the paragraphs listed in docs/FAA-REFERENCES.md', () => {
    expect(FAA_REFS.sameRunwayDeparture).toEqual({ para: '3-9-6', title: 'SAME RUNWAY SEPARATION' });
    expect(refsForAlert('UNSAFE_CLEARANCE').map((r) => r.para)).toEqual(['3-9-10', '3-10-5']);
    expect(refsForAlert('AIRBORNE_PROXIMITY')).toEqual([]);
    expect(formatRef(FAA_REFS.groundMovement)).toBe('JO 7110.65 3-7-2 TAXI AND GROUND MOVEMENT OPERATIONS');
  });
});
