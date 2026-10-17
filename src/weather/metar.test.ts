import { describe, expect, it } from 'vitest';
import {
  ceilingFt,
  computeFlightCategory,
  isPhenomenonToken,
  parseMetar,
  parseMetarDetailed,
  windMagnetic,
} from './metar';

/**
 * Real METARs fetched from https://aviationweather.gov/api/data/metar on
 * 2026-10-17 ~01:55 UTC (rawOb field). Expected values were derived by hand
 * from the raw text, not from the parser.
 */
const REAL_FETCHED_2026_10_17 = [
  {
    raw: 'METAR KACY 170054Z 29017G23KT 10SM FEW018 BKN038 OVC049 21/17 A2983 RMK AO2 RAB38E49 PRESRR SLP100 P0000 T02060172',
    wind: [290, 17, 23], vis: 10, clouds: [['FEW', 1800], ['BKN', 3800], ['OVC', 4900]], t: 21, d: 17, alt: 29.83, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR KATL 170152Z 33018G32KT 10SM BKN023 BKN080 BKN110 19/13 A3002 RMK AO2 PK WND 32032/0145 SLP159 T01890133 $',
    wind: [330, 18, 32], vis: 10, clouds: [['BKN', 2300], ['BKN', 8000], ['BKN', 11000]], t: 19, d: 13, alt: 30.02, wx: [], cat: 'MVFR',
  },
  {
    raw: 'METAR KBOS 170154Z 27012G20KT 10SM -RA SCT050 OVC110 19/17 A2966 RMK AO2 RAB15 SLP044 P0000 T01940172',
    wind: [270, 12, 20], vis: 10, clouds: [['SCT', 5000], ['OVC', 11000]], t: 19, d: 17, alt: 29.66, wx: ['-RA'], cat: 'VFR',
  },
  {
    raw: 'METAR KBTV 170054Z 30011G18KT 10SM OVC022 09/05 A2978 RMK AO2 SLP085 T00940050',
    wind: [300, 11, 18], vis: 10, clouds: [['OVC', 2200]], t: 9, d: 5, alt: 29.78, wx: [], cat: 'MVFR',
  },
  {
    raw: 'METAR KBUF 170054Z 33012KT 10SM FEW023 SCT026 BKN039 09/06 A2997 RMK AO2 RAB14E44 SLP149 P0000 T00940056 $',
    wind: [330, 12, undefined], vis: 10, clouds: [['FEW', 2300], ['SCT', 2600], ['BKN', 3900]], t: 9, d: 6, alt: 29.97, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR KDEN 170153Z 10008KT 10SM CLR 06/M06 A3056 RMK AO2 SLP352 T00561061',
    wind: [100, 8, undefined], vis: 10, clouds: [['CLR', 0]], t: 6, d: -6, alt: 30.56, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR KEWR 170151Z 29008KT 10SM -RA FEW040 SCT090 BKN110 OVC200 19/16 A2976 RMK AO2 RAB13 SLP077 P0001 T01940161 $',
    wind: [290, 8, undefined], vis: 10, clouds: [['FEW', 4000], ['SCT', 9000], ['BKN', 11000], ['OVC', 20000]], t: 19, d: 16, alt: 29.76, wx: ['-RA'], cat: 'VFR',
  },
  {
    raw: 'METAR KFAT 170153Z 00000KT 10SM CLR 28/02 A3004 RMK AO2 SLP171 T02830022',
    wind: [0, 0, undefined], vis: 10, clouds: [['CLR', 0]], t: 28, d: 2, alt: 30.04, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR KJFK 170151Z 31010KT 10SM SCT065 BKN085 BKN110 BKN140 BKN220 21/14 A2976 RMK AO2 SLP076 T02060139 $',
    wind: [310, 10, undefined], vis: 10, clouds: [['SCT', 6500], ['BKN', 8500], ['BKN', 11000], ['BKN', 14000], ['BKN', 22000]], t: 21, d: 14, alt: 29.76, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR KLAX 170153Z 30006KT 10SM FEW220 FEW280 31/09 A2994 RMK AO2 SLP137 T03060094 $',
    wind: [300, 6, undefined], vis: 10, clouds: [['FEW', 22000], ['FEW', 28000]], t: 31, d: 9, alt: 29.94, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR KMIA 170153Z 34007KT 10SM SCT022 SCT038 SCT085 SCT250 27/24 A2999 RMK AO2 SLP156 OCNL LTGICCC DSNT NW CB DSNT NW T02720244 $',
    wind: [340, 7, undefined], vis: 10, clouds: [['SCT', 2200], ['SCT', 3800], ['SCT', 8500], ['SCT', 25000]], t: 27, d: 24, alt: 29.99, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR KMSP 170153Z 31005KT 10SM CLR 07/M03 A3051 RMK AO2 SLP339 T00721028',
    wind: [310, 5, undefined], vis: 10, clouds: [['CLR', 0]], t: 7, d: -3, alt: 30.51, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR KORD 170151Z 35012KT 10SM FEW043 FEW055 08/03 A3035 RMK AO2 SLP280 T00780028 $',
    wind: [350, 12, undefined], vis: 10, clouds: [['FEW', 4300], ['FEW', 5500]], t: 8, d: 3, alt: 30.35, wx: [], cat: 'VFR',
  },
  {
    raw: 'SPECI KPHL 170124Z 29006KT 10SM -RA FEW030 BKN070 BKN120 BKN220 19/16 A2980 RMK AO2 P0006 T01890161',
    wind: [290, 6, undefined], vis: 10, clouds: [['FEW', 3000], ['BKN', 7000], ['BKN', 12000], ['BKN', 22000]], t: 19, d: 16, alt: 29.8, wx: ['-RA'], cat: 'VFR',
  },
  {
    raw: 'METAR KSEA 170153Z 16006KT 10SM FEW180 SCT230 21/06 A3004 RMK AO2 SLP178 T02110056',
    wind: [160, 6, undefined], vis: 10, clouds: [['FEW', 18000], ['SCT', 23000]], t: 21, d: 6, alt: 30.04, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR PANC 170153Z 00000KT 10SM FEW020 SCT080 BKN110 07/02 A2940 RMK AO2 SLP958 VIRGA N-NE T00670022 $',
    wind: [0, 0, undefined], vis: 10, clouds: [['FEW', 2000], ['SCT', 8000], ['BKN', 11000]], t: 7, d: 2, alt: 29.4, wx: [], cat: 'VFR',
  },
  {
    raw: 'METAR PHNL 170153Z 04016G24KT 10SM FEW025 FEW040 29/21 A2995 RMK AO2 PK WND 07026/0055 RAB0054E18 SLP140 P0000 T02890206 $',
    wind: [40, 16, 24], vis: 10, clouds: [['FEW', 2500], ['FEW', 4000]], t: 29, d: 21, alt: 29.95, wx: [], cat: 'VFR',
  },
] as const;

describe('parseMetar - real METARs fetched 2026-10-17 from aviationweather.gov', () => {
  it.each(REAL_FETCHED_2026_10_17.map((c) => [c.raw.slice(0, 22), c] as const))('%s', (_n, c) => {
    const w = parseMetar(c.raw);
    expect(w.source).toBe('live');
    expect(w.windDirDeg).toBe(c.wind[0]);
    expect(w.windSpeedKt).toBe(c.wind[1]);
    expect(w.windGustKt).toBe(c.wind[2]);
    expect(w.visibilitySm).toBe(c.vis);
    expect(w.clouds.map((l) => [l.cover, l.baseFtAgl])).toEqual(c.clouds.map((l) => [l[0], l[1]]));
    expect(w.temperatureC).toBe(c.t);
    expect(w.dewpointC).toBe(c.d);
    expect(w.altimeterInHg).toBeCloseTo(c.alt, 5);
    expect(w.phenomena).toEqual([...c.wx]);
    expect(w.flightCategory).toBe(c.cat);
    expect(w.rawMetar).toBe(c.raw);
  });

  it('does not misread remarks tokens (RAB38E49, PK WND, VIRGA, LTGICCC) as weather or sky', () => {
    const w = parseMetar(REAL_FETCHED_2026_10_17[0].raw);
    expect(w.phenomena).toEqual([]);
    expect(w.clouds).toHaveLength(3);
    const d = parseMetarDetailed(REAL_FETCHED_2026_10_17[0].raw);
    expect(d.remarks).toBe('AO2 RAB38E49 PRESRR SLP100 P0000 T02060172');
    expect(d.unparsed).toEqual([]);
    expect(d.station).toBe('KACY');
    expect(d.day).toBe(17);
    expect(d.hour).toBe(0);
    expect(d.minute).toBe(54);
  });

  it('reports SPECI type', () => {
    expect(parseMetarDetailed(REAL_FETCHED_2026_10_17[13].raw).type).toBe('SPECI');
  });
});

describe('parseMetar - edge cases', () => {
  it('variable wind (VRB) with low speed', () => {
    const w = parseMetar('KACY 121253Z VRB03KT 10SM CLR 15/10 A3001');
    expect(w.windDirDeg).toBe('VRB');
    expect(w.windSpeedKt).toBe(3);
    expect(w.windGustKt).toBeUndefined();
  });

  it('variable wind sector group dddVddd', () => {
    const d = parseMetarDetailed('KACY 121253Z 24008KT 200V280 10SM FEW050 20/12 A2999');
    expect(d.weather.windDirDeg).toBe(240);
    expect(d.variableWind).toEqual({ fromDeg: 200, toDeg: 280 });
  });

  it('three-digit wind speeds and gusts', () => {
    const w = parseMetar('KACY 121253Z 270105G120KT 1/2SM +TSRA OVC008CB 20/19 A2950');
    expect(w.windSpeedKt).toBe(105);
    expect(w.windGustKt).toBe(120);
  });

  it('whole + fractional visibility "1 1/2SM"', () => {
    const w = parseMetar('KACY 121253Z 05005KT 1 1/2SM BR OVC006 12/11 A3010');
    expect(w.visibilitySm).toBe(1.5);
    expect(w.phenomena).toEqual(['BR']);
    expect(w.flightCategory).toBe('IFR');
  });

  it('fractional visibility "3/4SM" and "1/2SM"', () => {
    expect(parseMetar('KACY 121253Z 00000KT 3/4SM FG VV002 10/10 A3000').visibilitySm).toBe(0.75);
    expect(parseMetar('KACY 121253Z 00000KT 1/2SM FG VV002 10/10 A3000').visibilitySm).toBe(0.5);
  });

  it('"M1/4SM" (less than 1/4) is stored as 0.25 and LIFR', () => {
    const w = parseMetar('KACY 121253Z 00000KT M1/4SM FG VV001 08/08 A3012');
    expect(w.visibilitySm).toBe(0.25);
    expect(w.clouds).toEqual([{ cover: 'VV', baseFtAgl: 100 }]);
    expect(w.flightCategory).toBe('LIFR');
  });

  it('"P6SM" is stored as 6', () => {
    expect(parseMetar('KACY 121253Z 18010KT P6SM SCT040 22/15 A2992').visibilitySm).toBe(6);
  });

  it('multiple present-weather groups, intensity and proximity prefixes', () => {
    const w = parseMetar('KACY 121253Z 22012G25KT 2SM +TSRA BR VCSH BKN015CB OVC030 24/22 A2985');
    expect(w.phenomena).toEqual(['+TSRA', 'BR', 'VCSH']);
    expect(w.clouds.map((c) => c.cover)).toEqual(['BKN', 'OVC']);
    expect(w.flightCategory).toBe('IFR'); // vis 2 SM
  });

  it('VCTS and freezing/snow groups', () => {
    expect(parseMetar('KACY 121253Z 22008KT 8SM VCTS SCT040 28/24 A2990').phenomena).toEqual(['VCTS']);
    const snow = parseMetar('KACY 011253Z 02015G25KT 1/2SM +SN FZFG VV004 M03/M04 A2975');
    expect(snow.phenomena).toEqual(['+SN', 'FZFG']);
    expect(snow.temperatureC).toBe(-3);
    expect(snow.dewpointC).toBe(-4);
  });

  it('negative temperature and dew point (M prefix)', () => {
    const w = parseMetar('KBTV 051253Z 31010KT 10SM CLR M12/M20 A3045');
    expect(w.temperatureC).toBe(-12);
    expect(w.dewpointC).toBe(-20);
  });

  it('temperature 00 and M00', () => {
    const w = parseMetar('KBTV 051253Z 31010KT 10SM CLR 00/M00 A3000');
    expect(w.temperatureC).toBe(0);
    expect(Object.is(w.dewpointC, -0) || w.dewpointC === 0).toBe(true);
  });

  it('SKC and CLR and NCD all mean no ceiling', () => {
    for (const sky of ['SKC', 'CLR', 'NCD']) {
      const w = parseMetar(`KACY 121253Z 18005KT 10SM ${sky} 20/10 A3000`);
      expect(ceilingFt(w.clouds)).toBeUndefined();
      expect(w.flightCategory).toBe('VFR');
    }
    expect(parseMetar('KACY 121253Z 18005KT 10SM SKC 20/10 A3000').clouds[0].cover).toBe('SKC');
  });

  it('VV vertical visibility counts as ceiling', () => {
    const w = parseMetar('KACY 121253Z 00000KT 1/8SM FG VV001 10/10 A3000');
    expect(ceilingFt(w.clouds)).toBe(100);
    expect(w.visibilitySm).toBe(0.125);
    expect(w.flightCategory).toBe('LIFR');
  });

  it('AUTO and COR tokens are accepted and flagged', () => {
    const a = parseMetarDetailed('METAR KACY 121253Z AUTO 18010KT 10SM CLR 20/10 A3000 RMK AO1');
    expect(a.auto).toBe(true);
    expect(a.corrected).toBe(false);
    expect(a.weather.clouds[0].cover).toBe('CLR');
    const c = parseMetarDetailed('METAR KACY 121253Z COR 18010KT 10SM CLR 20/10 A3000');
    expect(c.corrected).toBe(true);
    expect(c.unparsed).toEqual([]);
  });

  it('RMK content is preserved and not parsed (a fake "BKN010" in remarks is ignored)', () => {
    const d = parseMetarDetailed('KACY 121253Z 18010KT 10SM FEW050 20/10 A3000 RMK AO2 BKN010 V FEW SLP150');
    expect(d.weather.clouds).toEqual([{ cover: 'FEW', baseFtAgl: 5000 }]);
    expect(d.remarks).toContain('BKN010');
    expect(d.weather.rawMetar).toContain('RMK');
  });

  it('cloud heights ignore CB/TCU suffix but keep the layer', () => {
    const w = parseMetar('KACY 121253Z 18010KT 5SM TS SCT025TCU BKN040CB 28/24 A2990');
    expect(w.clouds).toEqual([{ cover: 'SCT', baseFtAgl: 2500 }, { cover: 'BKN', baseFtAgl: 4000 }]);
    expect(w.phenomena).toEqual(['TS']);
  });

  it('missing groups get documented defaults and are reported', () => {
    const d = parseMetarDetailed('KACY 121253Z 18010KT');
    expect(d.missing).toEqual(expect.arrayContaining(['visibility', 'sky', 'temperature', 'dewpoint', 'altimeter']));
    expect(d.weather.visibilitySm).toBe(10);
    expect(d.weather.altimeterInHg).toBe(29.92);
    expect(d.weather.flightCategory).toBe('VFR');
  });

  it('missing dewpoint "12/" keeps temperature', () => {
    const d = parseMetarDetailed('KACY 121253Z 18010KT 10SM CLR 12/ A3000');
    expect(d.weather.temperatureC).toBe(12);
    expect(d.missing).toContain('dewpoint');
  });

  it('CAVOK is understood', () => {
    const w = parseMetar('EGLL 121250Z 24008KT CAVOK 18/09 Q1021');
    expect(w.visibilitySm).toBe(10);
    expect(w.flightCategory).toBe('VFR');
    expect(w.altimeterInHg).toBeCloseTo(30.15, 2);
  });

  it('metric visibility 9999 and 0800', () => {
    expect(parseMetar('LFPG 121300Z 24008KT 9999 FEW040 18/09 Q1021').visibilitySm).toBe(10);
    const fog = parseMetar('LFPG 121300Z 00000KT 0800 FG VV002 09/09 Q1021');
    expect(fog.visibilitySm).toBeCloseTo(0.5, 1);
    expect(fog.flightCategory).toBe('LIFR');
  });

  it('wind in MPS is converted to knots', () => {
    expect(parseMetar('UUEE 121300Z 24005MPS 9999 FEW040 18/09 Q1021').windSpeedKt).toBe(10);
  });

  it('RVR groups are ignored', () => {
    const d = parseMetarDetailed('KACY 121253Z 13004KT 1/4SM R13/1800FT FG VV002 10/10 A3000');
    expect(d.unparsed).toEqual([]);
    expect(d.weather.visibilitySm).toBe(0.25);
  });

  it('tolerates extra whitespace and lower-risk garbage without throwing', () => {
    const d = parseMetarDetailed('  METAR   KACY  121253Z   18010KT   10SM  XYZZY  CLR 20/10 A3000  ');
    expect(d.unparsed).toEqual(['XYZZY']);
    expect(d.weather.windSpeedKt).toBe(10);
    expect(() => parseMetar('')).not.toThrow();
    expect(parseMetarDetailed('').missing).toContain('wind');
  });

  it('resolves observedAt from a reference date', () => {
    const w = parseMetar('METAR KACY 170054Z 29017G23KT 10SM CLR 21/17 A2983', { referenceDate: new Date('2026-10-17T02:00:00Z') });
    expect(w.observedAt).toBe('2026-10-17T00:54:00.000Z');
    const prevMonth = parseMetar('METAR KACY 302350Z 29017KT 10SM CLR 21/17 A2983', { referenceDate: new Date('2026-11-01T00:10:00Z') });
    expect(prevMonth.observedAt).toBe('2026-10-30T23:50:00.000Z');
  });

  it('leaves observedAt unset without a reference date', () => {
    expect(parseMetar('KACY 170054Z 29017KT 10SM CLR 21/17 A2983').observedAt).toBeUndefined();
  });
});

describe('flight category thresholds', () => {
  const ovc = (ft: number) => [{ cover: 'OVC' as const, baseFtAgl: ft }];
  const bkn = (ft: number) => [{ cover: 'BKN' as const, baseFtAgl: ft }];
  const few = (ft: number) => [{ cover: 'FEW' as const, baseFtAgl: ft }];

  it.each([
    [10, [], 'VFR'],
    [6, ovc(3100), 'VFR'],
    [5.01, few(500), 'VFR'], // FEW is not a ceiling
    [5, [], 'MVFR'],
    [3, [], 'MVFR'],
    [2.99, [], 'IFR'],
    [1, [], 'IFR'],
    [0.99, [], 'LIFR'],
    [0.25, [], 'LIFR'],
    [10, ovc(3000), 'MVFR'],
    [10, bkn(1000), 'MVFR'],
    [10, ovc(999), 'IFR'],
    [10, bkn(500), 'IFR'],
    [10, ovc(499), 'LIFR'],
    [10, [{ cover: 'VV' as const, baseFtAgl: 200 }], 'LIFR'],
    [0.5, ovc(5000), 'LIFR'], // worse of the two wins
    [2, ovc(400), 'LIFR'],
    [10, [...few(300), ...bkn(4000)], 'VFR'], // lowest BKN/OVC, not lowest layer
    [10, [...few(300), ...bkn(2500), ...ovc(800)], 'IFR'],
  ] as const)('vis %s clouds %j -> %s', (vis, clouds, cat) => {
    expect(computeFlightCategory(vis, clouds)).toBe(cat);
  });

  it('ceilingFt picks the lowest BKN/OVC/VV and ignores FEW/SCT/CLR', () => {
    expect(ceilingFt([{ cover: 'SCT', baseFtAgl: 500 }, { cover: 'BKN', baseFtAgl: 4000 }, { cover: 'OVC', baseFtAgl: 2000 }])).toBe(2000);
    expect(ceilingFt([{ cover: 'FEW', baseFtAgl: 500 }])).toBeUndefined();
    expect(ceilingFt([])).toBeUndefined();
  });
});

describe('isPhenomenonToken', () => {
  it.each(['RA', '-RA', '+TSRA', 'VCTS', 'BR', 'FG', 'HZ', 'SN', 'BLSN', 'FZRA', 'SHRA', '-SHSN', 'TSGR', 'BCFG', 'UP', 'FC', '+FC'])('accepts %s', (t) => {
    expect(isPhenomenonToken(t)).toBe(true);
  });
  it.each(['A2992', 'FEW020', 'RMK', 'AUTO', 'COR', '10SM', 'R', '+', 'XX', 'CLR', 'SKC'])('rejects %s', (t) => {
    expect(isPhenomenonToken(t)).toBe(false);
  });
});

describe('windMagnetic', () => {
  const w = (dir: number | 'VRB', spd: number) => ({ windDirDeg: dir, windSpeedKt: spd });
  it('KACY (10 W, east-positive -10) adds 10 degrees to true', () => {
    expect(windMagnetic(w(290, 17), -10)).toBe(300);
    expect(windMagnetic(w(200, 10), -10)).toBe(210);
  });
  it('east variation subtracts', () => {
    expect(windMagnetic(w(100, 10), 12)).toBe(88);
  });
  it('wraps through north and never returns 0 for a real wind', () => {
    expect(windMagnetic(w(355, 10), -10)).toBe(5);
    expect(windMagnetic(w(10, 10), 10)).toBe(360);
    expect(windMagnetic(w(5, 10), 5)).toBe(360);
  });
  it('VRB stays VRB and calm is 0', () => {
    expect(windMagnetic(w('VRB', 3), -10)).toBe('VRB');
    expect(windMagnetic(w(0, 0), -10)).toBe(0);
  });
  it('rounds to tens on request', () => {
    expect(windMagnetic(w(294, 10), -10, 10)).toBe(300);
    expect(windMagnetic(w(291, 10), -10, 10)).toBe(300);
    expect(windMagnetic(w(356, 10), -10, 10)).toBe(10);
    expect(windMagnetic(w(350, 10), -10, 10)).toBe(360);
  });
});
