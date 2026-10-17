import { describe, expect, it } from 'vitest';
import { altHundreds, altimeterText, formatElapsed, formatMhz, formatZulu, magHeading, magHeadingNum, phaseShort, statusTone, trendArrow, windText, wrapHeading } from './format';
import type { Weather } from '../../sim/types';

const wx = (over: Partial<Weather>): Weather => ({
  source: 'simulated', windDirDeg: 220, windSpeedKt: 8, visibilitySm: 10, clouds: [{ cover: 'SKC', baseFtAgl: 0 }], temperatureC: 15, dewpointC: 5,
  altimeterInHg: 29.92, phenomena: [], flightCategory: 'VFR', ...over,
});

describe('altitude data block', () => {
  it('shows hundreds of feet, three digits', () => {
    expect(altHundreds(2480)).toBe('025');
    expect(altHundreds(2449)).toBe('024');
    expect(altHundreds(75)).toBe('001');
    expect(altHundreds(0)).toBe('000');
    expect(altHundreds(12000)).toBe('120');
    expect(altHundreds(-300)).toBe('-03');
  });
  it('vertical trend arrow has a 200 fpm dead band', () => {
    expect(trendArrow(700)).toBe('↑');
    expect(trendArrow(-800)).toBe('↓');
    expect(trendArrow(150)).toBe('');
  });
});

describe('magnetic heading for display (KACY variation is -10, i.e. 10 W)', () => {
  it('adds ten degrees to TRUE headings', () => {
    expect(magHeading(118, -10)).toBe('128'); // runway 13
    expect(magHeading(298, -10)).toBe('308'); // runway 31
    expect(magHeading(28, -10)).toBe('038'); // runway 4
    expect(magHeading(208, -10)).toBe('218'); // runway 22
  });
  it('wraps through north and never shows 000', () => {
    expect(magHeading(350, -10)).toBe('360');
    expect(magHeading(355, -10)).toBe('005');
    expect(wrapHeading(0)).toBe(360);
    expect(magHeadingNum(10, 10)).toBe(360);
  });
  it('east variation subtracts', () => {
    expect(magHeading(100, 12)).toBe('088');
  });
});

describe('clocks and weather strings', () => {
  it('formats elapsed time and Zulu', () => {
    expect(formatElapsed(0)).toBe('00:00:00');
    expect(formatElapsed(3725.9)).toBe('01:02:05');
    const start = Date.UTC(2026, 9, 16, 23, 58, 30);
    expect(formatZulu(start, 0)).toBe('23:58:30Z');
    expect(formatZulu(start, 120)).toBe('00:00:30Z');
  });
  it('gives wind the way a tower says it (magnetic)', () => {
    expect(windText(wx({ windDirDeg: 290, windSpeedKt: 17, windGustKt: 23 }), -10)).toBe('300/17G23');
    expect(windText(wx({ windSpeedKt: 0 }), -10)).toBe('CALM');
    expect(windText(wx({ windDirDeg: 'VRB', windSpeedKt: 5 }), -10)).toBe('VRB05');
    expect(windText(wx({ windDirDeg: 350, windSpeedKt: 7 }), -10)).toBe('360/07');
  });
  it('formats altimeter and frequency', () => {
    expect(altimeterText(29.83)).toBe('A2983');
    expect(altimeterText(30.05)).toBe('A3005');
    expect(formatMhz(120.3)).toBe('120.30');
    expect(formatMhz(121.9)).toBe('121.90');
    expect(formatMhz(127.85)).toBe('127.85');
  });
});

describe('phase presentation', () => {
  it('has short codes and tones', () => {
    expect(phaseShort('HOLDING_SHORT')).toBe('HS');
    expect(phaseShort('INITIAL_CLIMB')).toBe('ICL');
    const base = { onGround: true, flags: {} };
    expect(statusTone({ ...base, phase: 'TAXIING' })).toBe('taxi');
    expect(statusTone({ ...base, phase: 'HOLDING_SHORT' })).toBe('hold');
    expect(statusTone({ ...base, phase: 'TAKEOFF_ROLL' })).toBe('runway');
    expect(statusTone({ ...base, phase: 'GO_AROUND' })).toBe('alert');
    expect(statusTone({ ...base, phase: 'FINAL', onGround: false })).toBe('arrival');
    expect(statusTone({ ...base, phase: 'TAXIING', flags: { emergency: true } })).toBe('alert');
  });
});
