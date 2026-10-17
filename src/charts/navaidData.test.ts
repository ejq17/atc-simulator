import { describe, expect, it } from 'vitest';
import { NAVAIDS, distanceBearing } from './navaidData';

describe('navaid data', () => {
  it('ACY VORTAC is OPERATIONAL RESTRICTED at 117.15 with unusable-sector remarks', () => {
    expect(NAVAIDS.vortac).toMatchObject({ id: 'ACY', freqMhz: 117.15, status: 'OPERATIONAL RESTRICTED', channel: '118Y' });
    expect(NAVAIDS.vortac.remarks.join(' ')).toMatch(/VOR UNUSBL/);
  });

  it('has ILS on 13 (I-PVO) and 31 (I-ACY) only, both 109.1; none on 04/22', () => {
    expect(NAVAIDS.ils.map((s) => [s.runway, s.plateIdent, s.freqMhz])).toEqual([['13', 'I-PVO', 109.1], ['31', 'I-ACY', 109.1]]);
    expect(NAVAIDS.runwaysWithoutIls.sort()).toEqual(['04', '22']);
  });

  it('lists VCN/SIE/CYN first and computes plausible distances from ACY', () => {
    expect(NAVAIDS.nearby.slice(0, 3).map((n) => n.id)).toEqual(['VCN', 'SIE', 'CYN']);
    const vcn = NAVAIDS.nearby[0];
    expect(vcn.distanceNmFromAcy).toBeGreaterThan(15);
    expect(vcn.distanceNmFromAcy).toBeLessThan(30);
    expect(vcn.bearingTrueFromAcy).toBeGreaterThan(270); // west-northwest
  });

  it('flags the five key approach fixes and carries their roles', () => {
    const keys = NAVAIDS.fixes.filter((f) => f.key).map((f) => f.id).sort();
    expect(keys).toEqual(['CARYL', 'MAYBN', 'PRSTY', 'SMITS', 'STEVV']);
    expect(NAVAIDS.fixes).toHaveLength(36);
    expect(NAVAIDS.fixes.find((f) => f.id === 'CARYL')?.roles.every((r) => r.role.length > 0)).toBe(true);
  });

  it('distanceBearing sanity: 1 degree of latitude is 60 NM due north', () => {
    const d = distanceBearing({ lat: 39, lon: -74 }, { lat: 40, lon: -74 });
    expect(d.nm).toBeCloseTo(60, 0);
    expect(d.bearing).toBeCloseTo(0, 3);
  });
});
