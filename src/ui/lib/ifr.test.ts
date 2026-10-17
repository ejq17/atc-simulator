import { describe, expect, it } from 'vitest';
import { loadKacy } from '../../airport';
import type { Aircraft, SimEvent } from '../../sim/types';
import { choiceFromPositions, frequencyRows, POSITION_CHOICES, POSITION_ORDER, rowLabel, suggestPosition } from './positions';
import { approachFixAltitudes, approachInfo, fixAltitudeText, ifrClearanceSummary, lahsoBadge, navDescription, navLetter, requestBadge, stripClearance } from './ifr';
import { pickProcedure, procedureGeometry } from './procedures';
import { bayFrequencies } from '../components/FlightStrips';
import { lastActivity } from '../components/RadioPanel';

const airport = loadKacy();

const base = (over: Partial<Aircraft> = {}): Aircraft => ({
  id: 'a1', callsign: 'NKS451', spokenCallsign: 'Spirit four fifty one', type: 'A320', flightRules: 'IFR', origin: 'KPHL', destination: 'KACY', isDeparture: false,
  pos: { x: 0, y: 0 }, headingDeg: 118, trackDeg: 118, altitudeFt: 5000, airspeedKt: 190, groundSpeedKt: 190, verticalSpeedFpm: 0, onGround: false,
  phase: 'INBOUND', frequencyMhz: 124.6, frequencyId: 'APP', clearances: [], target: {}, radioState: 'IDLE', occupyingRunways: [], runwayAuthorizations: [],
  spawnedAtSec: 0, history: [], voiceId: 'v', flags: {}, seed: 1, ...over,
});

describe('controller positions', () => {
  it('every choice round-trips and shares frequencies from the airport data', () => {
    for (const k of POSITION_ORDER) expect(choiceFromPositions(POSITION_CHOICES[k])).toBe(k);
    const app = frequencyRows(airport, POSITION_CHOICES.APP);
    expect(app).toHaveLength(1); // APP and DEP share 124.6 at KACY
    expect(rowLabel(app[0])).toBe('APP/DEP');
    expect(app[0].mhz).toBe(124.6);
    expect(frequencyRows(airport, POSITION_CHOICES.ALL).map((r) => r.mhz)).toEqual([120.3, 121.9, 127.85, 124.6]);
  });
  it('suggests the smallest set that covers a scenario', () => {
    expect(suggestPosition(['TWR'])).toBe('TWR');
    expect(suggestPosition(['GND', 'TWR'])).toBe('TWR+GND');
    expect(suggestPosition(['CLNC'])).toBe('CLNC');
    expect(suggestPosition(['APP', 'DEP'])).toBe('APP');
    expect(suggestPosition(['APP', 'TWR'])).toBe('APP+TWR');
    expect(suggestPosition(['CLNC', 'GND', 'TWR', 'APP', 'DEP'])).toBe('ALL');
    expect(suggestPosition(['CLNC', 'GND'])).toBe('ALL');
  });
});

describe('IFR display helpers', () => {
  it('has descriptive request badges', () => {
    expect(requestBadge('IFR_CLEARANCE')).toBe('REQ IFR CLNC');
    expect(requestBadge('APPROACH')).toBe('REQ APPROACH');
    expect(requestBadge('OTHER')).toBe('CHECK-IN');
    expect(requestBadge('TAXI')).toBe('REQ TAXI');
    expect(requestBadge('DEPARTURE')).toBe('REQ DEPARTURE');
    expect(requestBadge('LANDING')).toBe('REQ LANDING');
    expect(requestBadge('FREQUENCY_CHANGE')).toBe('REQ FREQ CHG');
  });
  it('mode letters and nav description', () => {
    const route = base({ nav: { fixes: ['VCN', 'CARYL'], index: 1, mode: 'route' } });
    expect(navLetter(route)).toBe('R');
    expect(navDescription({ airport }, route)).toBe('Route to CARYL');
    expect(navLetter(base({ nav: { fixes: ['VCN'], index: 0, mode: 'vectors' } }))).toBe('V');
    expect(navLetter(base({ nav: { fixes: ['VCN'], index: 0, mode: 'approach' } }))).toBe('A');
    expect(navLetter(base())).toBe('V'); // IFR on a heading = vectors
    expect(navLetter(base({ flightRules: 'VFR' }))).toBe('');
    expect(navDescription({ airport }, base({ nav: { fixes: ['VCN'], index: 0, mode: 'direct' } }))).toBe('Direct VCN');
  });
  it('approach clearance state: cleared until the aircraft is on the course', () => {
    const e13 = airport.runways.flatMap((r) => r.ends).find((e) => e.id === '13')!;
    const clr = { id: 'c', kind: 'APPROACH' as const, issuedAtSec: 0, byPosition: 'APP' as const, approachType: 'ILS' as const, runwayEnd: '13' };
    const off = base({ clearances: [clr], pos: { x: e13.threshold.x + 9000, y: e13.threshold.y + 9000 } });
    expect(approachInfo({ airport }, off)).toEqual({ state: 'cleared', label: 'ILS 13' });
    const rad = (e13.trueHeadingDeg * Math.PI) / 180;
    const on = base({ clearances: [clr], headingDeg: e13.trueHeadingDeg, pos: { x: e13.threshold.x - Math.sin(rad) * 8 * 1852, y: e13.threshold.y - Math.cos(rad) * 8 * 1852 } });
    expect(approachInfo({ airport }, on).state).toBe('established');
    expect(approachInfo({ airport }, base()).state).toBe('none');
    expect(stripClearance({ airport }, on)).toBe('Est. ILS 13');
  });
  it('summarises an IFR clearance on one line', () => {
    expect(ifrClearanceSummary({
      destination: 'KPHL', routeText: 'x', departureProcedure: 'ATLANTIC CITY THREE', initialAltitudeFt: 2000, expectAltitudeFt: 10000, departureFrequencyMhz: 124.6, squawk: '4215',
    })).toBe('KPHL · ATLANTIC CITY THREE departure · maintain 2,000 · expect 10,000 · dep 124.60 · sqk 4215');
  });
});

describe('procedure geometry for the radar', () => {
  const ids = (end: string) => procedureGeometry(airport, end)!.onCourse.map((f) => f.id).sort();
  it('finds the on-course fixes of each KACY landing runway', () => {
    expect(ids('13')).toEqual(['CARYL', 'MAYBN']);
    expect(ids('31')).toEqual(['PRSTY', 'STEVV']);
    expect(ids('22')).toEqual(['EFEWY', 'FLDER', 'KOPCE']);
    expect(ids('4')).toEqual(['FASEN', 'JEDOB', 'TEMVE']);
  });
  it('prefers the ILS and gives the IF distance; VCN is a feeder for ILS 13', () => {
    expect(pickProcedure(airport, '13')?.label).toBe('ILS 13');
    expect(pickProcedure(airport, '22')?.label).toBe('RNAV 22');
    const g = procedureGeometry(airport, '13')!;
    expect(g.ifNm).toBeGreaterThan(10);
    expect(g.feeders.map((f) => f.id)).toContain('VCN');
    expect(procedureGeometry(airport, '99')).toBeUndefined();
  });
});

describe('strips and frequency activity', () => {
  it('lists each bay\'s frequencies from the airport data (APP and DEP share one bay and one frequency; sector frequencies are not repeated)', () => {
    expect(bayFrequencies({ airport }, 'CLNC')).toEqual([127.85]);
    expect(bayFrequencies({ airport }, 'TWR')).toEqual([120.3]);
    expect(bayFrequencies({ airport }, 'APPDEP')).toEqual([124.6]);
  });
  it('reports the most recent call per frequency', () => {
    const ev = (id: string, t: number, mhz: number, speaker: SimEvent['speaker'], callsign: string): SimEvent => ({ id, timeSec: t, kind: 'TRANSMISSION', text: 'x', severity: 'info', frequencyMhz: mhz, speaker, callsign });
    const rows = frequencyRows(airport, POSITION_CHOICES.ALL);
    const act = lastActivity({ events: [ev('1', 1, 124.6, 'PILOT', 'NKS451'), ev('2', 5, 124.6, 'ATC', 'NKS451'), ev('3', 6, 127.85, 'PILOT', 'NKS608')] }, rows);
    expect(act.get(124.6)).toMatchObject({ dir: 'TX', timeSec: 5 });
    expect(act.get(127.85)).toMatchObject({ dir: 'RX', callsign: 'NKS608' });
    expect(act.has(120.3)).toBe(false);
  });
});

describe('published fix altitudes and LAHSO', () => {
  it('formats fix altitude restrictions', () => {
    expect(fixAltitudeText({ mandatoryAltitudeFt: 1500 })).toBe('at 1,500');
    expect(fixAltitudeText({ minAltitudeFt: 2000 })).toBe('at or above 2,000');
    expect(fixAltitudeText({ maxAltitudeFt: 3000 })).toBe('at or below 3,000');
    expect(fixAltitudeText({ minAltitudeFt: 2000, maxAltitudeFt: 3000 })).toBe('2,000-3,000');
    expect(fixAltitudeText({})).toBe('');
  });
  it('reads fix altitudes of the cleared procedure, and nothing when the data has none', () => {
    const clr = { id: 'c', kind: 'APPROACH' as const, issuedAtSec: 0, byPosition: 'APP' as const, approachType: 'ILS' as const, runwayEnd: '13' };
    const ac = base({ clearances: [clr] });
    const bare = { ...airport, procedures: airport.procedures.map((p) => ({ ...p, fixAltitudes: undefined })) };
    expect(approachFixAltitudes({ airport: bare }, ac)).toEqual([]);
    const procedures = airport.procedures.map((p) => (p.id === 'ILS-Z-OR-LOC-Z-RWY-13' ? { ...p, fixAltitudes: [{ fix: 'CARYL', minAltitudeFt: 2000 }, { fix: 'MAYBN', mandatoryAltitudeFt: 1500 }] } : p));
    expect(approachFixAltitudes({ airport: { ...bare, procedures: bare.procedures.map((p) => (p.id === 'ILS-Z-OR-LOC-Z-RWY-13' ? procedures.find((q) => q.id === p.id)! : p)) } }, ac).map((a) => `${a.fix} ${a.text}`)).toEqual(['CARYL at or above 2,000', 'MAYBN at 1,500']);
    expect(approachFixAltitudes({ airport }, base())).toEqual([]);
  });
  it('shows the LAHSO badge from RunwayEnd.lahso when a landing clearance carries hold-short runways', () => {
    const land = { id: 'l', kind: 'LAND' as const, issuedAtSec: 0, byPosition: 'TWR' as const, runwayEnd: '4', holdShort: ['13/31'] };
    expect(lahsoBadge({ airport }, base({ clearances: [land] }))).toBe('LAHSO: hold short 13/31, 3,550 ft available');
    expect(lahsoBadge({ airport }, base({ clearances: [{ ...land, holdShort: undefined }] }))).toBeUndefined();
    expect(lahsoBadge({ airport }, base())).toBeUndefined();
  });
});
