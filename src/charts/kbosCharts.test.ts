import { describe, expect, it } from 'vitest';
import { chartsByCategory, cycleFor, getChart, listChartGroups, listCharts } from './chartIndex';
import { navaidsFor } from './navaidData';

describe('KBOS chart index (from kbos-procedures.json)', () => {
  it('lists the diagram, 19 IAPs, the departures with continuation pages, the STAR pages, hot spot, LAHSO and the NE-1 minimums pages', () => {
    expect(chartsByCategory('DIAGRAM', 'KBOS').map((c) => c.pdfName)).toEqual(['00058AD.PDF']);
    expect(chartsByCategory('IAP', 'KBOS')).toHaveLength(19);
    const dps = chartsByCategory('DP', 'KBOS').map((c) => c.name);
    expect(dps).toContain('LOGAN FOUR DEPARTURE');
    expect(dps).toContain('LOGAN FOUR DEPARTURE, CONT.1');
    expect(dps).toContain('WYLYY FIVE DEPARTURE (RNAV)');
    expect(dps).toHaveLength(19); // 10 charts + 9 continuation pages (WYLYY is one page)
    expect(chartsByCategory('STAR', 'KBOS')).toHaveLength(9);
    expect(chartsByCategory('HOT_SPOT', 'KBOS').map((c) => c.pdfName)).toEqual(['NE1HOTSPOT.PDF']);
    expect(chartsByCategory('LAHSO', 'KBOS').map((c) => c.pdfName)).toEqual(['NE1LAHSO.PDF']);
    expect(chartsByCategory('MINIMUMS', 'KBOS').map((c) => c.pdfName).sort()).toEqual(['NE1ALT.PDF', 'NE1TO.PDF', 'NE1TO.PDF']);
  });

  it('every chart is an official aeronav URL of cycle 2610; the KACY list is the default and unchanged', () => {
    for (const c of listCharts('KBOS')) {
      expect(c.pdfUrl).toMatch(/^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\/[A-Za-z0-9_]+\.PDF$/);
      expect(c.cycle).toBe('2610');
    }
    expect(cycleFor('KBOS').label).toBe('FAA d-TPP cycle 2610, effective 2026-10-01 to 2026-10-29');
    expect(listCharts()).toEqual(listCharts('KACY'));
    expect(getChart('00058AD', 'KBOS')?.name).toBe('AIRPORT DIAGRAM');
    expect(getChart('00058AD', 'KMHT')).toBeUndefined();
  });

  it('groups approaches by runway end in numeric order (4R, 15R, 22L, 27, 32, 33L), ILS first', () => {
    const groups = listChartGroups('KBOS').filter((g) => g.category === 'IAP');
    expect(groups.map((g) => g.runway)).toEqual(['4L', '4R', '15R', '22L', '27', '32', '33L']);
    expect(groups.find((g) => g.runway === '4R')!.charts[0].name).toBe('ILS OR LOC RWY 04R');
    expect(groups.find((g) => g.runway === '33L')!.charts.some((c) => /RNP/.test(c.name) && /Special aircraft/.test(c.note ?? ''))).toBe(true);
  });
});

describe('KBOS navaid reference data', () => {
  const nav = navaidsFor('KBOS');
  it('has the BOS VOR/DME, five ILS systems and the nearby VOR/DMEs', () => {
    expect(nav.faaId).toBe('BOS');
    expect(nav.vortac).toMatchObject({ id: 'BOS', type: 'VOR/DME', freqMhz: 112.7, channel: '74X' });
    expect(nav.ils.map((s) => [s.runway, s.plateIdent, s.freqMhz])).toEqual([['04R', 'I-BOS', 110.3], ['15R', 'I-MDC', 110.7], ['22L', 'I-LQN', 110.3], ['27', 'I-DGU', 111.3], ['33L', 'I-LIP', 110.7]]);
    expect(nav.runwaysWithoutIls).toEqual(['4L', '22R', '9', '14', '32', '15L', '33R']);
    expect(nav.nearby.map((n) => n.id)).toEqual(expect.arrayContaining(['GDM', 'LFV', 'PVD', 'ORW', 'JFK']));
    expect(nav.nearby[0].id).toBe('GDM');
    expect(nav.fixes).toHaveLength(107);
    expect(nav.fixes.filter((f) => f.key).map((f) => f.id)).toEqual(expect.arrayContaining(['MILTT', 'MALDY', 'VOCUS', 'RIPIT', 'NIMOY', 'WAXEN']));
  });
});
