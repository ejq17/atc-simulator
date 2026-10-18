/**
 * Airport-state content of the weather layer: runway condition (RCAM) derivation, braking action terms, RVR conversion (14 CFR 91.175(h) / AIM TBL 5-4-1,
 * JO 7110.65 2-8-2 / 2-8-3), ATIS content for closures / RVR / braking action / bird activity / runway condition codes, and the ATIS cadence
 * (JO 7110.65 2-9-2: new weather observation, braking action worse, new or canceled NOTAMs).
 */
import { describe, expect, it } from 'vitest';
import type { Weather } from '../sim/types';
import { atisNeedsUpdate, atisUpdateReasons, generateAtis, type AtisOps, type GenerateAtisInput } from './atis';
import { getPresetWeather } from './presets';
import { isNewObservation, isOfficialObservation } from './observation';
import {
  BRAKING_TERMS, RCAM_BRAKING_TERM, brakingAdvisoriesInEffect, hasPrecipitation, runwayCondition, runwayIsDry, termRank,
} from './runwayCondition';
import { RVR_TABLE, rvrForVisibility, rvrPhrase, spokenRvr, visibilityFromRvr } from './rvr';
import { recommendRunways } from './runwaySelection';

const w = (over: Partial<Weather> = {}): Weather => ({ ...getPresetWeather('clear'), ...over });
const atisIn = (weather: Weather, ops?: AtisOps, extra: Partial<GenerateAtisInput> = {}): GenerateAtisInput => ({
  airportName: 'Manchester', icao: 'KMHT', weather, variationDeg: -15, activeRunways: { departing: ['6'], landing: ['6'] }, letter: 'C',
  timeUtc: new Date('2026-10-17T16:51:00Z'), elevationFt: 266, ops, ...extra,
});

describe('runway condition from the present weather (AC 150/5200-30D RCAM)', () => {
  it('a dry runway is code 6; no precipitation, no term', () => {
    const c = runwayCondition(w());
    expect(c).toMatchObject({ code: 6, surface: 'dry' });
    expect(c.term).toBeUndefined();
    expect(runwayIsDry(w({ phenomena: ['BR', 'FG'] }))).toBe(true);
  });
  it('rain wets the runway: light/moderate = code 5 (good), heavy = water over 1/8 inch = code 2 (medium to poor)', () => {
    expect(runwayCondition(w({ phenomena: ['-RA'] }))).toMatchObject({ code: 5, surface: 'wet', term: 'good' });
    expect(runwayCondition(w({ phenomena: ['RA'] }))).toMatchObject({ code: 5 });
    expect(runwayCondition(w({ phenomena: ['+RA'] }))).toMatchObject({ code: 2, term: 'medium to poor' });
    expect(runwayCondition(w({ phenomena: ['+TSRA'] }))).toMatchObject({ code: 2 });
  });
  it('snow depends on the temperature: cold dry snow over 1/8 inch = 3 (medium), warm slush over 1/8 inch = 2', () => {
    expect(runwayCondition(w({ phenomena: ['-SN'], temperatureC: -4 })).code).toBe(5);
    expect(runwayCondition(w({ phenomena: ['SN'], temperatureC: -4 }))).toMatchObject({ code: 3, term: 'medium', surface: 'snow' });
    expect(runwayCondition(w({ phenomena: ['SN'], temperatureC: 1 }))).toMatchObject({ code: 2, surface: 'slush' });
  });
  it('freezing rain is ice (code 1, poor); the worst of several phenomena wins; vicinity precipitation does not wet the runway', () => {
    expect(runwayCondition(w({ phenomena: ['FZRA'], temperatureC: -2 }))).toMatchObject({ code: 1, term: 'poor', surface: 'ice' });
    expect(runwayCondition(w({ phenomena: ['-RA', '+SN'], temperatureC: 0 })).code).toBe(3);
    expect(runwayCondition(w({ phenomena: ['VCSH', 'VCTS'] })).code).toBe(6);
    expect(hasPrecipitation(w({ phenomena: ['VCSH'] }))).toBe(false);
    expect(hasPrecipitation(w({ phenomena: ['SHRA'] }))).toBe(true);
  });
  it('the six official terms map onto RCAM codes 5..0 and rank from best to worst', () => {
    expect(BRAKING_TERMS).toEqual(['good', 'good to medium', 'medium', 'medium to poor', 'poor', 'nil']);
    expect([5, 4, 3, 2, 1, 0].map((c) => RCAM_BRAKING_TERM[c])).toEqual([...BRAKING_TERMS]);
    expect(BRAKING_TERMS.map(termRank)).toEqual([5, 4, 3, 2, 1, 0]);
  });
  it('braking action advisories (3-3-5): a medium / poor / nil report, or conditions conducive to deteriorating runway conditions', () => {
    expect(brakingAdvisoriesInEffect(w(), [])).toBe(false);
    expect(brakingAdvisoriesInEffect(w({ phenomena: ['-RA'], temperatureC: 15 }), [])).toBe(false);
    expect(brakingAdvisoriesInEffect(w({ phenomena: ['-RA'], temperatureC: 15 }), [{ term: 'medium' }])).toBe(true);
    expect(brakingAdvisoriesInEffect(w({ phenomena: ['-RA'], temperatureC: 15 }), [{ term: 'good' }])).toBe(false);
    expect(brakingAdvisoriesInEffect(w({ phenomena: ['-RA'], temperatureC: 2 }), [])).toBe(true);
    expect(brakingAdvisoriesInEffect(w({ phenomena: ['+RA'], temperatureC: 15 }), [])).toBe(true);
  });
});

describe('RVR (14 CFR 91.175(h)(2) = AIM TBL 5-4-1)', () => {
  it('the table is the published one', () => {
    expect(RVR_TABLE.map((r) => [r.rvrFt, r.visibilitySm])).toEqual([[1600, 0.25], [2400, 0.5], [3200, 0.625], [4000, 0.75], [4500, 0.875], [5000, 1], [6000, 1.25]]);
  });
  it('RVR to visibility uses the next higher listed RVR (AIM: 1800 RVR is 2400 = 1/2 mile; no interpolation)', () => {
    expect(visibilityFromRvr(1800)).toBe(0.5);
    expect(visibilityFromRvr(1600)).toBe(0.25);
    expect(visibilityFromRvr(5500)).toBe(1.25);
    expect(visibilityFromRvr(6500)).toBeUndefined();
  });
  it('visibility to RVR is the inverse: the largest listed RVR whose visibility does not exceed the prevailing one', () => {
    expect(rvrForVisibility(0.5)).toEqual({ kind: 'value', rvrFt: 2400 });
    expect(rvrForVisibility(0.6)).toEqual({ kind: 'value', rvrFt: 2400 });
    expect(rvrForVisibility(0.75)).toEqual({ kind: 'value', rvrFt: 4000 });
    expect(rvrForVisibility(1)).toEqual({ kind: 'value', rvrFt: 5000 });
    expect(rvrForVisibility(1.25)).toEqual({ kind: 'value', rvrFt: 6000 });
    // converting the reported RVR back never gives more than the weather's visibility
    for (const v of [0.25, 0.3, 0.5, 0.7, 0.9, 1, 1.2]) {
      const r = rvrForVisibility(v)!;
      expect(r.kind).toBe('value');
      expect(visibilityFromRvr((r as { rvrFt: number }).rvrFt)!).toBeLessThanOrEqual(v + 1e-9);
    }
  });
  it('is given only when the prevailing visibility is 1 1/4 SM or less (RVR 6,000 ft or less is reportable, 2-8-2); below the table the bound is stated', () => {
    expect(rvrForVisibility(1.5)).toBeUndefined();
    expect(rvrForVisibility(3)).toBeUndefined();
    expect(rvrForVisibility(0.125)).toEqual({ kind: 'less_than', rvrFt: 1600 });
  });
  it('is phrased as 2-8-3: runway, RVR, value', () => {
    expect(rvrPhrase('6', { kind: 'value', rvrFt: 2400 })).toEqual({ display: 'Runway 6 RVR 2400.', spoken: 'Runway six RVR two thousand four hundred.' });
    expect(rvrPhrase('35', { kind: 'less_than', rvrFt: 1600 }).spoken).toBe('Runway three five RVR less than one thousand six hundred.');
    expect(spokenRvr(6000)).toBe('six thousand');
  });
});

describe('ATIS airport state', () => {
  it('reads closures as NOTAMs: runway pair and taxiway (phonetic when spoken)', () => {
    const a = generateAtis(atisIn(w(), { closures: [{ kind: 'RUNWAY', ident: '17/35' }, { kind: 'TAXIWAY', ident: 'B' }, { kind: 'TAXIWAY', ident: 'A1' }] }));
    expect(a.text).toContain('NOTAMs: Runway 17/35 closed. Taxiway B closed. Taxiway A1 closed.');
    expect(a.spokenText).toContain('Runway one seven slash three five closed. Taxiway Bravo closed. Taxiway Alpha one closed.');
    expect(a.ops.closures).toEqual(['RUNWAY:17/35', 'TAXIWAY:A1', 'TAXIWAY:B']);
  });
  it('keeps free-text NOTAMs after the closures', () => {
    const a = generateAtis(atisIn(w(), { closures: [{ kind: 'TAXIWAY', ident: 'C' }] }, { notams: ['Crane near runway 24'] }));
    expect(a.text).toContain('NOTAMs: Taxiway C closed. Crane near runway 24.');
  });
  it('gives RVR right after the visibility, in the 2-8-3 form', () => {
    const a = generateAtis(atisIn(w({ visibilitySm: 0.5, flightCategory: 'LIFR' }), { rvr: [{ runwayEnd: '6', report: { kind: 'value', rvrFt: 2400 } }] }));
    expect(a.text).toMatch(/Visibility 1\/2\. Runway 6 RVR 2400\. Sky /);
    expect(a.spokenText).toMatch(/Visibility one half\. Runway six RVR two thousand four hundred\./);
  });
  it('says braking action advisories are in effect, the latest report with the aircraft type (3-3-4) and the runway condition codes with the time (2-9-3)', () => {
    const a = generateAtis(atisIn(w({ phenomena: ['RA'] }), {
      brakingAdvisories: true, braking: { term: 'medium to poor', aircraftSpoken: 'a Boeing seven thirty seven' },
      rwyCondition: [{ runwayEnd: '6', code: 2, atUtc: '1651' }],
    }));
    expect(a.text).toContain('Braking action advisories are in effect. Braking action medium to poor, reported by a Boeing seven thirty seven.');
    expect(a.text).toContain('Runway 6 condition codes 2, 2, 2 at 1651 Zulu.');
    expect(a.spokenText).toContain('Runway six condition codes two, two, two at one six five one Zulu.');
    expect(a.text.indexOf('Braking action advisories')).toBeLessThan(a.text.indexOf('Read back all runway hold short'));
  });
  it('adds bird activity in the vicinity of the airport (2-9-3, 2-1-23)', () => {
    expect(generateAtis(atisIn(w(), { birds: '' })).text).toContain('Bird activity in the vicinity of the airport.');
    expect(generateAtis(atisIn(w(), { birds: 'flocks of small birds, altitude unknown' })).text).toContain('Bird activity in the vicinity of the airport, flocks of small birds, altitude unknown.');
    expect(generateAtis(atisIn(w())).text).not.toMatch(/Bird|Braking|closed|RVR/);
  });
});

describe('ATIS cadence (JO 7110.65 2-9-2)', () => {
  const live = (observedAt: string, over: Partial<Weather> = {}): Weather => w({ source: 'live', observedAt, rawMetar: `KMHT ${observedAt}`, ...over });

  it('a routine hourly METAR (minute 50-59) and a SPECI are official observations; a 5-minute ASOS observation is not', () => {
    expect(isOfficialObservation({ observedAt: '2026-10-17T16:54:00.000Z' })).toBe(true);
    expect(isOfficialObservation({ observedAt: '2026-10-17T16:35:00.000Z' })).toBe(false);
    expect(isOfficialObservation({ rawMetar: 'SPECI KMHT 171635Z 18005KT 10SM CLR 03/M05 A3033' })).toBe(true);
    expect(isOfficialObservation({ rawMetar: 'KMHT 171654Z 18005KT 10SM CLR 03/M05 A3033' })).toBe(true);
    expect(isOfficialObservation({ rawMetar: 'KMHT 171635Z 18005KT 10SM CLR 03/M05 A3033' })).toBe(false);
  });
  it('reissues on every new hourly observation even when no value changed, but not on an unchanged or non-official one', () => {
    const first = generateAtis(atisIn(live('2026-10-17T15:54:00.000Z')));
    const same = live('2026-10-17T16:54:00.000Z');
    expect(isNewObservation(first.weather, same)).toBe(true);
    expect(atisUpdateReasons(first, same)).toContain('new weather observation');
    expect(atisNeedsUpdate(first, same)).toBe(true);
    // the same observation again, or a 5-minute observation with identical values: no new letter
    expect(atisNeedsUpdate(first, first.weather)).toBe(false);
    expect(atisNeedsUpdate(first, live('2026-10-17T16:35:00.000Z'))).toBe(false);
  });
  it('keeps the material-change triggers (wind, altimeter, categories, thunderstorm, runway)', () => {
    const a = generateAtis(atisIn(w({ windDirDeg: 180, windSpeedKt: 8 })));
    expect(atisUpdateReasons(a, w({ windDirDeg: 250, windSpeedKt: 8 }))).toContain('wind direction');
    expect(atisUpdateReasons(a, w({ windDirDeg: 180, windSpeedKt: 14 }))).toContain('wind speed');
    expect(atisUpdateReasons(a, w({ windDirDeg: 180, windSpeedKt: 8, altimeterInHg: 29.7 }))).toContain('altimeter');
    expect(atisUpdateReasons(a, w({ windDirDeg: 180, windSpeedKt: 8 }), { departing: ['24'], landing: ['24'] })).toContain('runway change');
    expect(atisUpdateReasons(a, w({ windDirDeg: 180, windSpeedKt: 8 }))).toEqual([]);
  });
  it('new or canceled closures, worse braking action, bird activity and new condition codes each make a new letter', () => {
    const wx = w({ phenomena: ['RA'] });
    const a = generateAtis(atisIn(wx, { brakingAdvisories: true, braking: { term: 'good', aircraftSpoken: 'a Cessna one seventy two' } }));
    const reasons = (ops: AtisOps) => atisUpdateReasons(a, wx, undefined, ops);
    expect(reasons({ brakingAdvisories: true, braking: { term: 'good', aircraftSpoken: 'x' } })).toEqual([]);
    expect(reasons({ brakingAdvisories: true, braking: { term: 'medium', aircraftSpoken: 'x' } })).toContain('braking action worse');
    expect(reasons({ brakingAdvisories: true, braking: { term: 'good to medium', aircraftSpoken: 'x' } })).toContain('braking action worse');
    expect(reasons({ closures: [{ kind: 'TAXIWAY', ident: 'B' }], brakingAdvisories: true, braking: { term: 'good', aircraftSpoken: 'x' } })).toContain('closures (NOTAMs)');
    expect(reasons({ birds: '', brakingAdvisories: true, braking: { term: 'good', aircraftSpoken: 'x' } })).toContain('bird activity');
    expect(reasons({ rwyCondition: [{ runwayEnd: '6', code: 5, atUtc: '1700' }], brakingAdvisories: true, braking: { term: 'good', aircraftSpoken: 'x' } })).toContain('runway condition codes');
    // a canceled closure (set before, gone now) is also a change
    const b = generateAtis(atisIn(wx, { closures: [{ kind: 'RUNWAY', ident: '6/24' }] }));
    expect(atisUpdateReasons(b, wx, undefined, {})).toContain('closures (NOTAMs)');
    // a better report than the one in the broadcast does not force a new letter
    const poor = generateAtis(atisIn(wx, { braking: { term: 'poor', aircraftSpoken: 'x' } }));
    expect(atisUpdateReasons(poor, wx, undefined, { braking: { term: 'medium', aircraftSpoken: 'x' } })).not.toContain('braking action worse');
  });
});

describe('runway selection never picks a closed runway (JO 7110.65 3-3-2)', () => {
  const ends = [
    { id: '6', magneticHeadingDeg: 57 }, { id: '24', magneticHeadingDeg: 237 }, { id: '17', magneticHeadingDeg: 171 }, { id: '35', magneticHeadingDeg: 351 },
  ];
  it('drops the excluded ends before ranking', () => {
    // wind from 240 (true 255): runway 24 is best
    const wind = { windDirDeg: 255, windSpeedKt: 15 as number };
    expect(recommendRunways(wind, ends, { variationDeg: -15 }).primary).toBe('24');
    const closed = recommendRunways(wind, ends, { variationDeg: -15, excludeEnds: ['6', '24'] });
    expect(['17', '35']).toContain(closed.primary);
    expect(closed.ranking.map((r) => r.id).sort()).toEqual(['17', '35']);
    expect(closed.best.every((id) => id === '17' || id === '35')).toBe(true);
  });
  it('is case-insensitive and throws when nothing is left', () => {
    const rwy = [{ id: '13L', magneticHeadingDeg: 128 }, { id: '31R', magneticHeadingDeg: 308 }];
    expect(recommendRunways({ windDirDeg: 0, windSpeedKt: 0 }, rwy, { excludeEnds: ['13l'] }).primary).toBe('31R');
    expect(() => recommendRunways({ windDirDeg: 0, windSpeedKt: 0 }, rwy, { excludeEnds: ['13L', '31R'] })).toThrow(/closed/);
  });
});
