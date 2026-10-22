import { describe, expect, it } from 'vitest';
import { isDaylight, solarElevationDeg, sunriseSunsetUtc } from './solar';

const ACY = { lat: 39.45757583, lon: -74.57715527 };
const at = (iso: string) => Date.parse(iso);
const hm = (ms: number) => { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

describe('NOAA sunrise / sunset', () => {
  it('Atlantic City: reference days (against a hand computation of the same quantities to within a few minutes)', () => {
    // Hand computation (solar noon from the longitude and the equation of time, hour angle for the 90.833 degree zenith):
    // 2026-10-17: declination -9.3 deg, equation of time +14.4 min -> solar noon 16:44Z, day 11.1 h: sunrise 11:11Z, sunset 22:17Z
    const oct = sunriseSunsetUtc(ACY, at('2026-10-17T15:00:00Z'))!;
    expect(Math.abs(hm(oct.sunriseMs) - (11 * 60 + 11))).toBeLessThan(5);
    expect(Math.abs(hm(oct.sunsetMs) - (22 * 60 + 17))).toBeLessThan(5);
    // summer solstice: sunrise ~05:32 EDT (09:32Z), sunset ~20:31 EDT (00:31Z next day)
    const jun = sunriseSunsetUtc(ACY, at('2026-06-21T15:00:00Z'))!;
    expect(Math.abs(hm(jun.sunriseMs) - (9 * 60 + 32))).toBeLessThan(8);
    expect(Math.abs(hm(jun.sunsetMs) - 31)).toBeLessThan(8);
    // winter solstice: sunrise ~07:12 EST (12:12Z), sunset ~16:38 EST (21:38Z)
    const dec = sunriseSunsetUtc(ACY, at('2026-12-21T15:00:00Z'))!;
    expect(Math.abs(hm(dec.sunriseMs) - (12 * 60 + 12))).toBeLessThan(8);
    expect(Math.abs(hm(dec.sunsetMs) - (21 * 60 + 38))).toBeLessThan(8);
  });

  it('daylight is the interval between them; the elevation is about the declination-limited noon maximum', () => {
    expect(isDaylight(ACY, at('2026-10-17T16:00:00Z'))).toBe(true); // noon local
    expect(isDaylight(ACY, at('2026-10-17T06:00:00Z'))).toBe(false); // 02:00 local
    expect(isDaylight(ACY, at('2026-10-17T23:00:00Z'))).toBe(false); // 19:00 local, after the 22:17Z sunset
    const noon = solarElevationDeg(ACY, at('2026-10-17T16:50:00Z'));
    expect(noon).toBeGreaterThan(40);
    expect(noon).toBeLessThan(45); // 90 - lat + decl(-9.3) = 41.2 ... 
    const just = sunriseSunsetUtc(ACY, at('2026-10-17T15:00:00Z'))!;
    expect(isDaylight(ACY, just.sunriseMs - 120000)).toBe(false);
    expect(isDaylight(ACY, just.sunriseMs + 120000)).toBe(true);
    expect(isDaylight(ACY, just.sunsetMs - 120000)).toBe(true);
    expect(isDaylight(ACY, just.sunsetMs + 120000)).toBe(false);
  });

  it('polar night has no sunrise', () => {
    expect(sunriseSunsetUtc({ lat: 80, lon: 0 }, at('2026-12-21T12:00:00Z'))).toBeUndefined();
  });
});
