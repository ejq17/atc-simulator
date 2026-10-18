import { describe, expect, it } from 'vitest';
import { chartsByCategory, cycleFor, getChart, listChartGroups, listCharts } from './chartIndex';
import { navaidsFor } from './navaidData';

describe('KMHT chart index (from kmht-procedures.json)', () => {
  it('lists the diagram, 11 IAPs, 2 DPs, the STAR pages and the NE-1 minimums pages', () => {
    expect(chartsByCategory('DIAGRAM', 'KMHT').map((c) => c.pdfName)).toEqual(['00246AD.PDF']);
    expect(chartsByCategory('IAP', 'KMHT')).toHaveLength(11);
    expect(chartsByCategory('DP', 'KMHT').map((c) => c.name)).toEqual(['MANCHESTER ONE DEPARTURE', 'PPORT FOUR DEPARTURE (RNAV)']);
    expect(chartsByCategory('STAR', 'KMHT')).toHaveLength(2);
    expect(chartsByCategory('HOT_SPOT', 'KMHT')).toHaveLength(0);
    expect(chartsByCategory('LAHSO', 'KMHT')).toHaveLength(0);
    expect(chartsByCategory('MINIMUMS', 'KMHT').map((c) => c.pdfName).sort()).toEqual(['NE1ALT.PDF', 'NE1TO.PDF']);
    expect(chartsByCategory('MINIMUMS', 'KMHT')[0].note).toMatch(/Northeast 1 booklet page.*KMHT/);
  });

  it('every chart is an official aeronav URL of cycle 2610; the KACY list is the default and unchanged', () => {
    for (const c of listCharts('KMHT')) {
      expect(c.pdfUrl).toMatch(/^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\/[A-Za-z0-9_]+\.PDF$/);
      expect(c.cycle).toBe('2610');
    }
    expect(cycleFor('KMHT').label).toBe('FAA d-TPP cycle 2610, effective 2026-10-01 to 2026-10-29');
    expect(listCharts()).toEqual(listCharts('KACY'));
    expect(getChart('00669AD')?.name).toBe('AIRPORT DIAGRAM');
    expect(getChart('00246AD', 'KMHT')?.name).toBe('AIRPORT DIAGRAM');
    expect(getChart('00669AD', 'KMHT')).toBeUndefined();
  });

  it('groups approaches by runway in numeric order, ILS first', () => {
    const groups = listChartGroups('KMHT').filter((g) => g.category === 'IAP');
    expect(groups.map((g) => g.runway)).toEqual(['6', '17', '24', '35']);
    expect(groups.find((g) => g.runway === '35')!.charts[0].name).toBe('ILS OR LOC RWY 35');
  });
});

describe('KMHT navaid reference data', () => {
  const nav = navaidsFor('KMHT');
  it('has the MHT DME, three ILS systems and the CON / GDM VOR/DMEs', () => {
    expect(nav.faaId).toBe('MHT');
    expect(nav.vortac).toMatchObject({ id: 'MHT', type: 'DME', freqMhz: 114.4, channel: '91X' });
    expect(nav.ils.map((s) => [s.runway, s.plateIdent, s.freqMhz])).toEqual([['06', 'I-MJE', 109.95], ['17', 'I-MNA', 109.1], ['35', 'I-MHT', 109.1]]);
    expect(nav.runwaysWithoutIls).toEqual(['24']);
    expect(nav.nearby.map((n) => n.id).sort()).toEqual(['CON', 'GDM']);
    expect(nav.fixes).toHaveLength(41); // 26 on the approach plates + 15 more on the ROZZE TWO arrival
    expect(nav.fixes.filter((f) => f.key).map((f) => f.id)).toEqual(expect.arrayContaining(['MNTIN', 'ORDIE', 'FITZY']));
  });
});
