import { describe, expect, it } from 'vitest';
import { parseTowerHours, towerClosedNotice, towerHoursLabel, towerOpenAt } from './towerHours';

const ET = 'America/New_York';
// 2026-07-01 is daylight time (UTC-4): 10:00 UTC = 06:00 local, 01:00 UTC next day = 21:00 local.
const at = (iso: string) => Date.parse(iso);

describe('tower hours against the real clock', () => {
  it('parses NASR TWR_HRS strings', () => {
    expect(parseTowerHours('0600-2100')).toEqual({ openMin: 360, closeMin: 1260 });
    expect(parseTowerHours('24')).toBe('always');
    expect(parseTowerHours('SEE REMARKS')).toBeUndefined();
    expect(parseTowerHours(undefined)).toBeUndefined();
  });

  it('is open from 0600 inclusive to 2100 exclusive in the airport time zone (daylight and standard time)', () => {
    expect(towerOpenAt('0600-2100', ET, at('2026-07-01T09:59:00Z'))).toBe(false); // 05:59 EDT
    expect(towerOpenAt('0600-2100', ET, at('2026-07-01T10:00:00Z'))).toBe(true); // 06:00 EDT
    expect(towerOpenAt('0600-2100', ET, at('2026-07-02T00:59:00Z'))).toBe(true); // 20:59 EDT
    expect(towerOpenAt('0600-2100', ET, at('2026-07-02T01:00:00Z'))).toBe(false); // 21:00 EDT
    expect(towerOpenAt('0600-2100', ET, at('2026-12-01T10:59:00Z'))).toBe(false); // 05:59 EST
    expect(towerOpenAt('0600-2100', ET, at('2026-12-01T11:00:00Z'))).toBe(true); // 06:00 EST
  });

  it('handles 24 hours, hours that cross midnight and unknown text', () => {
    expect(towerOpenAt('24', ET, at('2026-07-01T07:00:00Z'))).toBe(true);
    expect(towerOpenAt('2200-0600', ET, at('2026-07-01T03:00:00Z'))).toBe(true); // 23:00 EDT
    expect(towerOpenAt('2200-0600', ET, at('2026-07-01T16:00:00Z'))).toBe(false); // 12:00 EDT
    expect(towerOpenAt('SEE REMARKS', ET, 0)).toBeUndefined();
  });

  it('labels the hours', () => {
    expect(towerHoursLabel('0600-2100')).toBe('0600-2100 local');
    expect(towerHoursLabel('24')).toBe('24 hours');
    expect(towerHoursLabel(undefined)).toBeUndefined();
  });

  it('gives the closed notice only outside the hours', () => {
    const pgd = { towerHours: '0600-2100', timeZone: ET };
    expect(towerClosedNotice(pgd, 'Punta Gorda', at('2026-07-01T07:00:00Z'))).toBe('Punta Gorda Tower is closed at this hour in reality (0600-2100 local); the simulator staffs it anyway.');
    expect(towerClosedNotice(pgd, 'Punta Gorda', at('2026-07-01T15:00:00Z'))).toBeUndefined();
    expect(towerClosedNotice({ towerHours: '24' }, 'Manchester', at('2026-07-01T07:00:00Z'))).toBeUndefined();
    expect(towerClosedNotice({}, 'X', at('2026-07-01T07:00:00Z'))).toBeUndefined();
  });

  it('uses the airport time zone, not the viewer', () => {
    // 05:00 UTC is 22:00 in Los Angeles (closed for 0600-2100) and 06:00 in London (open)
    expect(towerOpenAt('0600-2100', 'America/Los_Angeles', at('2026-12-01T05:00:00Z'))).toBe(false);
    expect(towerOpenAt('0600-2100', 'Europe/London', at('2026-12-01T06:00:00Z'))).toBe(true);
  });
});
