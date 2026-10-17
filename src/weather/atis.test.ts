import { describe, expect, it } from 'vitest';
import type { Weather } from '../sim/types';
import {
  atisNeedsUpdate,
  atisUpdateReasons,
  describePhenomenon,
  displayVisibility,
  generateAtis,
  nextAtisLetter,
  phoneticForLetter,
  spokenAltimeter,
  spokenAltitude,
  spokenDigits,
  spokenRunway,
  spokenVisibility,
  type GenerateAtisInput,
} from './atis';
import { getPresetWeather } from './presets';
import { parseMetar } from './metar';

const base = (w: Weather, extra: Partial<GenerateAtisInput> = {}): GenerateAtisInput => ({
  airportName: 'Atlantic City',
  icao: 'KACY',
  weather: w,
  variationDeg: -10,
  activeRunways: { departing: ['22'], landing: ['22'] },
  letter: 'A',
  timeUtc: new Date('2026-10-17T16:51:00Z'),
  elevationFt: 75,
  ...extra,
});

describe('number rendering', () => {
  it('digits with niner', () => {
    expect(spokenDigits('220')).toBe('two two zero');
    expect(spokenDigits(9)).toBe('niner');
    expect(spokenDigits('1659')).toBe('one six five niner');
  });
  it('altimeter', () => {
    expect(spokenAltimeter(29.92)).toBe('two niner niner two');
    expect(spokenAltimeter(30.05)).toBe('three zero zero five');
    expect(spokenAltimeter(29.8)).toBe('two niner eight zero');
  });
  it('altitudes', () => {
    expect(spokenAltitude(600)).toBe('six hundred');
    expect(spokenAltitude(3800)).toBe('three thousand eight hundred');
    expect(spokenAltitude(2000)).toBe('two thousand');
    expect(spokenAltitude(12000)).toBe('one two thousand');
    expect(spokenAltitude(100)).toBe('one hundred');
    expect(spokenAltitude(4900)).toBe('four thousand niner hundred');
  });
  it('visibility display and spoken', () => {
    expect(displayVisibility(10)).toBe('10');
    expect(displayVisibility(1.5)).toBe('1 1/2');
    expect(displayVisibility(0.25)).toBe('1/4');
    expect(displayVisibility(0.75)).toBe('3/4');
    expect(spokenVisibility(10)).toBe('one zero');
    expect(spokenVisibility(3)).toBe('three');
    expect(spokenVisibility(1.5)).toBe('one and one half');
    expect(spokenVisibility(0.5)).toBe('one half');
    expect(spokenVisibility(0.25)).toBe('one quarter');
    expect(spokenVisibility(0.75)).toBe('three quarters');
    expect(spokenVisibility(0.125)).toBe('one eighth');
    expect(spokenVisibility(2.5)).toBe('two and one half');
  });
  it('runways', () => {
    expect(spokenRunway('13')).toBe('one three');
    expect(spokenRunway('4')).toBe('four');
    expect(spokenRunway('22L')).toBe('two two left');
    expect(spokenRunway('31R')).toBe('three one right');
  });
  it('phenomena', () => {
    expect(describePhenomenon('RA')).toBe('rain');
    expect(describePhenomenon('-RA')).toBe('light rain');
    expect(describePhenomenon('+TSRA')).toBe('thunderstorm with heavy rain');
    expect(describePhenomenon('VCTS')).toBe('thunderstorm in the vicinity');
    expect(describePhenomenon('BR')).toBe('mist');
    expect(describePhenomenon('FG')).toBe('fog');
    expect(describePhenomenon('FZFG')).toBe('freezing fog');
    expect(describePhenomenon('-SHSN')).toBe('light snow showers');
    expect(describePhenomenon('HZ')).toBe('haze');
    expect(describePhenomenon('VCSH')).toBe('showers in the vicinity');
  });
});

describe('letters', () => {
  it('rotates A..Z and wraps', () => {
    expect(nextAtisLetter('A')).toBe('B');
    expect(nextAtisLetter('M')).toBe('N');
    expect(nextAtisLetter('Y')).toBe('Z');
    expect(nextAtisLetter('Z')).toBe('A');
    expect(nextAtisLetter('c')).toBe('D');
  });
  it('restarts at A on invalid input', () => {
    expect(nextAtisLetter(undefined)).toBe('A');
    expect(nextAtisLetter('')).toBe('A');
    expect(nextAtisLetter('7')).toBe('A');
    expect(nextAtisLetter('AB')).toBe('A');
  });
  it('full cycle returns to start', () => {
    let l = 'A';
    for (let i = 0; i < 26; i++) l = nextAtisLetter(l);
    expect(l).toBe('A');
  });
  it('phonetic alphabet', () => {
    expect(phoneticForLetter('A')).toBe('Alpha');
    expect(phoneticForLetter('Z')).toBe('Zulu');
    expect(phoneticForLetter('x')).toBe('X-ray');
  });
});

describe('generateAtis - clear day', () => {
  const atis = generateAtis(base(getPresetWeather('clear')));

  it('follows the ATIS structure in display text', () => {
    expect(atis.text).toBe(
      'Atlantic City Airport information Alpha, 1651 Zulu. ' +
      'Wind 210 at 10. Visibility 10. Sky clear. Temperature 24, dew point 14. Altimeter 30.05. ' +
      'Visual approach runway 22 in use. Landing and departing runway 22. ' +
      'Advise on initial contact you have information Alpha.',
    );
  });

  it('renders aviation numbers in spokenText', () => {
    expect(atis.spokenText).toBe(
      'Atlantic City Airport information Alpha, one six five one Zulu. ' +
      'Wind two one zero at one zero. Visibility one zero. Sky clear. Temperature two four, dew point one four. ' +
      'Altimeter three zero zero five. ' +
      'Visual approach runway two two in use. Landing and departing runway two two. ' +
      'Advise on initial contact you have information Alpha.',
    );
    expect(atis.spokenText).not.toMatch(/\d/);
  });

  it('is clearly flagged as simulated', () => {
    expect(atis.simulated).toBe(true);
    expect(atis.simulatedLabel).toBe('SIMULATED – not the real KACY ATIS');
    expect(atis.letter).toBe('A');
    expect(atis.phonetic).toBe('Alpha');
    expect(atis.timeZulu).toBe('1651');
  });

  it('conforms to the shared Atis contract', () => {
    expect(atis.activeRunways).toEqual({ departing: ['22'], landing: ['22'] });
    expect(typeof atis.issuedAtSec).toBe('number');
    expect(atis.weather).toEqual(getPresetWeather('clear'));
    expect(atis.fieldElevationFt).toBe(75);
  });
});

describe('generateAtis - details', () => {
  it('speaks the altimeter as "two niner niner two" for 29.92', () => {
    const w = { ...getPresetWeather('clear'), altimeterInHg: 29.92 };
    const a = generateAtis(base(w));
    expect(a.text).toContain('Altimeter 29.92.');
    expect(a.spokenText).toContain('Altimeter two niner niner two.');
  });

  it('converts true wind to magnetic and rounds to tens (true 290 -> mag 300)', () => {
    const w = parseMetar('METAR KACY 170054Z 29017G23KT 10SM FEW018 BKN038 OVC049 21/17 A2983 RMK AO2');
    const a = generateAtis(base(w, { activeRunways: { departing: ['31'], landing: ['31'] } }));
    expect(a.text).toContain('Wind 300 at 17, gusts 23.');
    expect(a.spokenText).toContain('Wind three zero zero at one seven, gusts two three.');
    expect(a.text).toContain('Sky condition few clouds at 1800, ceiling 3800 broken, overcast 4900.');
    expect(a.spokenText).toContain('Sky condition few clouds at one thousand eight hundred, ceiling three thousand eight hundred broken, overcast four thousand niner hundred.');
    expect(a.text).toContain('Altimeter 29.83.');
  });

  it('zero-pads three-digit wind direction and handles calm / variable', () => {
    const w = { ...getPresetWeather('clear'), windDirDeg: 30, windSpeedKt: 6 };
    expect(generateAtis(base(w)).text).toContain('Wind 040 at 6.');
    expect(generateAtis(base(w)).spokenText).toContain('Wind zero four zero at six.');
    const calm = { ...w, windDirDeg: 0, windSpeedKt: 0 };
    expect(generateAtis(base(calm)).text).toContain('Wind calm.');
    const vrb = { ...w, windDirDeg: 'VRB' as const, windSpeedKt: 4 };
    expect(generateAtis(base(vrb)).text).toContain('Wind variable at 4.');
  });

  it('low visibility fog with vertical visibility and ILS', () => {
    const a = generateAtis(base(getPresetWeather('low-visibility'), { activeRunways: { departing: ['13'], landing: ['13'] } }));
    expect(a.text).toContain('Visibility 1/4, fog.');
    expect(a.spokenText).toContain('Visibility one quarter, fog.');
    expect(a.text).toContain('Sky condition sky obscured, vertical visibility 200.');
    expect(a.text).toContain('ILS runway 13 approach in use.');
    expect(a.spokenText).toContain('I L S runway one three approach in use.');
  });

  it('thunderstorms and rain wording', () => {
    const ts = generateAtis(base(getPresetWeather('thunderstorms')));
    expect(ts.text).toContain('Visibility 2, thunderstorm with heavy rain.');
    const neg = generateAtis(base({ ...getPresetWeather('rain'), temperatureC: -2, dewpointC: -5 }));
    expect(neg.text).toContain('Temperature minus 2, dew point minus 5.');
    expect(neg.spokenText).toContain('Temperature minus two, dew point minus five.');
  });

  it('explicit approaches and different landing/departing runways', () => {
    const a = generateAtis(base(getPresetWeather('imc'), {
      activeRunways: { landing: ['13'], departing: ['4'] },
      approachesInUse: ['ILS runway 13 approach', 'RNAV GPS runway 4 approach'],
    }));
    expect(a.text).toContain('ILS runway 13 approach and RNAV GPS runway 4 approach in use.');
    expect(a.spokenText).toContain('I L S runway one three approach and R NAV G P S runway four approach in use.');
    expect(a.text).toContain('Landing runway 13, departing runway 4.');
    expect(a.spokenText).toContain('Landing runway one three, departing runway four.');
  });

  it('multiple runways in use', () => {
    const a = generateAtis(base(getPresetWeather('clear'), { activeRunways: { landing: ['22', '31'], departing: ['22', '31'] } }));
    expect(a.text).toContain('Landing and departing runways 22 and 31.');
  });

  it('NOTAMs are included, spoken as notices to air missions with digits spelled', () => {
    const a = generateAtis(base(getPresetWeather('clear'), { notams: ['Taxiway B closed between A and C.', 'Runway 4/22 lights out of service'] }));
    expect(a.text).toContain('NOTAMs: Taxiway B closed between A and C. Runway 4/22 lights out of service.');
    expect(a.spokenText).toContain('Notices to air missions: Taxiway B closed between A and C. Runway four slash two two lights out of service.');
    expect(a.spokenText).not.toMatch(/\d/);
    expect(a.notams).toHaveLength(2);
  });

  it('omits NOTAM sentence when none', () => {
    expect(generateAtis(base(getPresetWeather('clear'))).text).not.toContain('NOTAM');
  });

  it('accepts "HHMM" strings and epoch numbers for time', () => {
    expect(generateAtis(base(getPresetWeather('clear'), { timeUtc: '0705' })).text).toContain('0705 Zulu');
    expect(generateAtis(base(getPresetWeather('clear'), { timeUtc: Date.UTC(2026, 0, 1, 23, 9) })).text).toContain('2309 Zulu');
    expect(() => generateAtis(base(getPresetWeather('clear'), { timeUtc: 'nonsense' }))).toThrow();
  });

  it('does not double the word Airport', () => {
    const a = generateAtis(base(getPresetWeather('clear'), { airportName: 'Atlantic City Airport' }));
    expect(a.text.startsWith('Atlantic City Airport information Alpha')).toBe(true);
  });

  it('uses the supplied letter and phonetic word', () => {
    const a = generateAtis(base(getPresetWeather('clear'), { letter: 'k' }));
    expect(a.letter).toBe('K');
    expect(a.text).toContain('information Kilo');
    expect(a.text.endsWith('you have information Kilo.')).toBe(true);
  });

  it('copies runways and weather so later mutation cannot corrupt the ATIS', () => {
    const w = getPresetWeather('clear');
    const rw = { landing: ['22'], departing: ['22'] };
    const a = generateAtis(base(w, { activeRunways: rw }));
    w.windSpeedKt = 40;
    rw.landing.push('31');
    expect(a.weather.windSpeedKt).toBe(10);
    expect(a.activeRunways.landing).toEqual(['22']);
  });
});

describe('atisNeedsUpdate', () => {
  const prev = generateAtis(base({
    ...getPresetWeather('clear'), windDirDeg: 200, windSpeedKt: 10, altimeterInHg: 30.0,
    visibilitySm: 10, clouds: [{ cover: 'FEW', baseFtAgl: 5000 }],
  }));
  const next = (patch: Partial<Weather>): Weather => ({ ...prev.weather, ...patch });

  it('no change -> no update', () => {
    expect(atisNeedsUpdate(prev, next({}))).toBe(false);
    expect(atisUpdateReasons(prev, next({}))).toEqual([]);
  });

  it('wind direction change of 30 degrees or more', () => {
    expect(atisNeedsUpdate(prev, next({ windDirDeg: 229 }))).toBe(false);
    expect(atisNeedsUpdate(prev, next({ windDirDeg: 230 }))).toBe(true);
    expect(atisNeedsUpdate(prev, next({ windDirDeg: 170 }))).toBe(true);
  });

  it('wind direction change wraps around north', () => {
    const p = { ...prev, weather: { ...prev.weather, windDirDeg: 350 } };
    expect(atisNeedsUpdate(p, { ...p.weather, windDirDeg: 20 })).toBe(true); // 30 deg
    expect(atisNeedsUpdate(p, { ...p.weather, windDirDeg: 10 })).toBe(false); // 20 deg
  });

  it('wind speed change of 5 kt or more', () => {
    expect(atisNeedsUpdate(prev, next({ windSpeedKt: 14 }))).toBe(false);
    expect(atisNeedsUpdate(prev, next({ windSpeedKt: 15 }))).toBe(true);
    expect(atisNeedsUpdate(prev, next({ windSpeedKt: 5 }))).toBe(true);
  });

  it('gust appearance of 5 kt or more', () => {
    expect(atisNeedsUpdate(prev, next({ windGustKt: 14 }))).toBe(false);
    expect(atisNeedsUpdate(prev, next({ windGustKt: 16 }))).toBe(true);
  });

  it('variable wind transition', () => {
    expect(atisNeedsUpdate(prev, next({ windDirDeg: 'VRB', windSpeedKt: 4 }))).toBe(true);
  });

  it('calm to calm ignores direction', () => {
    const p = { ...prev, weather: { ...prev.weather, windDirDeg: 0, windSpeedKt: 0 } };
    expect(atisNeedsUpdate(p, { ...p.weather, windDirDeg: 0 })).toBe(false);
  });

  it('altimeter change of 0.02 inHg or more', () => {
    expect(atisNeedsUpdate(prev, next({ altimeterInHg: 30.01 }))).toBe(false);
    expect(atisNeedsUpdate(prev, next({ altimeterInHg: 30.02 }))).toBe(true);
    expect(atisNeedsUpdate(prev, next({ altimeterInHg: 29.98 }))).toBe(true);
    expect(atisNeedsUpdate(prev, next({ altimeterInHg: 29.99 }))).toBe(false);
  });

  it('floating point altimeter differences are handled (29.92 -> 29.90)', () => {
    const p = { ...prev, weather: { ...prev.weather, altimeterInHg: 29.92 } };
    expect(atisNeedsUpdate(p, { ...p.weather, altimeterInHg: 29.9 })).toBe(true);
  });

  it('visibility category change', () => {
    expect(atisNeedsUpdate(prev, next({ visibilitySm: 8 }))).toBe(false);
    expect(atisNeedsUpdate(prev, next({ visibilitySm: 4 }))).toBe(true);
    expect(atisNeedsUpdate(prev, next({ visibilitySm: 2 }))).toBe(true);
    expect(atisUpdateReasons(prev, next({ visibilitySm: 0.5 }))).toContain('visibility category');
  });

  it('ceiling category change', () => {
    expect(atisNeedsUpdate(prev, next({ clouds: [{ cover: 'SCT', baseFtAgl: 1500 }] }))).toBe(false); // no ceiling either way
    expect(atisNeedsUpdate(prev, next({ clouds: [{ cover: 'BKN', baseFtAgl: 5000 }] }))).toBe(false); // above 3000
    expect(atisNeedsUpdate(prev, next({ clouds: [{ cover: 'BKN', baseFtAgl: 2500 }] }))).toBe(true);
    expect(atisUpdateReasons(prev, next({ clouds: [{ cover: 'OVC', baseFtAgl: 800 }] }))).toContain('ceiling category');
  });

  it('ceiling movement within a category is not a change', () => {
    const p = { ...prev, weather: { ...prev.weather, clouds: [{ cover: 'BKN' as const, baseFtAgl: 2500 }] } };
    expect(atisNeedsUpdate(p, { ...p.weather, clouds: [{ cover: 'BKN', baseFtAgl: 1500 }] })).toBe(false);
  });

  it('thunderstorm onset', () => {
    expect(atisNeedsUpdate(prev, next({ phenomena: ['TS'] }))).toBe(true);
    expect(atisNeedsUpdate(prev, next({ phenomena: ['-RA'] }))).toBe(false);
  });

  it('runway change', () => {
    expect(atisNeedsUpdate(prev, next({}), { landing: ['22'], departing: ['22'] })).toBe(false);
    expect(atisNeedsUpdate(prev, next({}), { landing: ['4'], departing: ['4'] })).toBe(true);
    expect(atisNeedsUpdate(prev, next({}), { landing: ['22'], departing: ['31'] })).toBe(true);
    expect(atisUpdateReasons(prev, next({}), { landing: ['4'], departing: ['4'] })).toEqual(['runway change']);
  });

  it('runway order does not matter', () => {
    const two = { ...prev, activeRunways: { landing: ['22', '31'], departing: ['22', '31'] } };
    expect(atisNeedsUpdate(two, prev.weather, { landing: ['31', '22'], departing: ['31', '22'] })).toBe(false);
  });
});
