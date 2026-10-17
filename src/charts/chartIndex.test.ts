import { describe, expect, it } from 'vitest';
import { isAllowedChartUrl } from '../../server/charts/chartUrl';
import { CYCLE, chartsByCategory, getChart, isCycleCurrent, listChartGroups, listCharts } from './chartIndex';

describe('chart index (KACY d-TPP 2610)', () => {
  const charts = listCharts();

  it('contains exactly the verified charts: 1 diagram, 13 IAPs, 1 DP, hot spot, LAHSO, 2 minimums pages', () => {
    expect(charts).toHaveLength(19);
    expect(chartsByCategory('DIAGRAM')).toHaveLength(1);
    expect(chartsByCategory('IAP')).toHaveLength(13);
    expect(chartsByCategory('DP')).toHaveLength(1);
    expect(chartsByCategory('HOT_SPOT')).toHaveLength(1);
    expect(chartsByCategory('LAHSO')).toHaveLength(1);
    expect(chartsByCategory('MINIMUMS').map((c) => c.pdfName).sort()).toEqual(['NE2ALT.PDF', 'NE2TO.PDF']);
  });

  it('every entry is an official FAA chart that the proxy would accept', () => {
    for (const c of charts) {
      expect(c.isOfficialFaa).toBe(true);
      expect(isAllowedChartUrl(c.pdfUrl), c.pdfUrl).toBe(true);
      expect(c.pdfUrl.endsWith(`/${c.pdfName}`)).toBe(true);
      expect(c.cycle).toBe('2610');
      expect(c.effectiveFrom).toBe('2026-10-01');
      expect(c.effectiveTo).toBe('2026-10-29');
    }
    expect(new Set(charts.map((c) => c.id)).size).toBe(charts.length);
  });

  it('puts the airport diagram first and the named charts in place', () => {
    expect(charts[0]).toMatchObject({ name: 'AIRPORT DIAGRAM', pdfUrl: 'https://aeronav.faa.gov/d-tpp/2610/00669AD.PDF' });
    expect(getChart('00669ATLANTICCITY')?.name).toBe('ATLANTIC CITY THREE DEPARTURE');
    expect(getChart('NE2HOTSPOT')?.category).toBe('HOT_SPOT');
    expect(getChart('does-not-exist')).toBeUndefined();
  });

  it('groups approaches by runway (04, 13, 22, 31) with ILS first', () => {
    const groups = listChartGroups();
    expect(groups.map((g) => g.id)).toEqual(['DIAGRAM', 'IAP-04', 'IAP-13', 'IAP-22', 'IAP-31', 'DP', 'HOT_SPOT', 'LAHSO', 'MINIMUMS']);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    expect(byId['IAP-04'].charts.map((c) => c.name)).toEqual(['RNAV (GPS) RWY 04', 'VOR RWY 04']);
    expect(byId['IAP-22'].charts.map((c) => c.name)).toEqual(['RNAV (GPS) RWY 22']);
    expect(byId['IAP-13'].charts.map((c) => c.name)).toEqual([
      'ILS Z OR LOC Z RWY 13',
      'HI-ILS Y OR LOC Y RWY 13',
      'RNAV (GPS) Y RWY 13',
      'RNAV (RNP) Z RWY 13',
      'COPTER ILS OR LOC/DME RWY 13',
    ]);
    expect(byId['IAP-13'].charts.at(-1)?.name).toMatch(/^COPTER/);
    expect(byId['IAP-31'].charts).toHaveLength(5);
    expect(byId['IAP-31'].charts[0].name).toBe('ILS OR LOC/DME RWY 31');
    // no ILS charts on 04/22
    for (const id of ['IAP-04', 'IAP-22']) expect(byId[id].charts.some((c) => /ILS|LOC/.test(c.name))).toBe(false);
  });

  it('exposes cycle metadata read from the data', () => {
    expect(CYCLE.label).toBe('FAA d-TPP cycle 2610, effective 2026-10-01 to 2026-10-29');
    expect(isCycleCurrent(Date.parse('2026-10-16T12:00:00Z'))).toBe(true);
    expect(isCycleCurrent(Date.parse('2026-10-29T09:01:00Z'))).toBe(false);
  });

  it('listCharts returns copies, not the frozen internals', () => {
    const a = listCharts();
    a[0].name = 'mutated';
    expect(listCharts()[0].name).toBe('AIRPORT DIAGRAM');
  });
});
