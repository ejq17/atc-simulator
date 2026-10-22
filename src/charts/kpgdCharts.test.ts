import { describe, expect, it } from 'vitest';
import { chartsByCategory, cycleFor, getChart, listChartGroups, listCharts } from './chartIndex';
import { navaidsFor } from './navaidData';

describe('KPGD chart index (from kpgd-procedures.json)', () => {
  it('lists the diagram, 5 IAPs, the 3 STAR pages, no DP / hot spot / LAHSO and the SE-3 minimums pages', () => {
    expect(chartsByCategory('DIAGRAM', 'KPGD').map((c) => c.pdfName)).toEqual(['06178AD.PDF']);
    expect(chartsByCategory('IAP', 'KPGD')).toHaveLength(5);
    expect(chartsByCategory('DP', 'KPGD')).toHaveLength(0);
    expect(chartsByCategory('STAR', 'KPGD').map((c) => c.pdfName)).toEqual(['00640LUBBR.PDF', '00640LUBBR_C.PDF', '06020PIKKR.PDF']);
    expect(chartsByCategory('HOT_SPOT', 'KPGD')).toHaveLength(0);
    expect(chartsByCategory('LAHSO', 'KPGD')).toHaveLength(0);
    expect(chartsByCategory('MINIMUMS', 'KPGD').map((c) => c.pdfName).sort()).toEqual(['SE3ALT.PDF', 'SE3TO.PDF']);
  });

  it('every chart is an official aeronav URL of cycle 2610', () => {
    for (const c of listCharts('KPGD')) {
      expect(c.pdfUrl).toMatch(/^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\/[A-Za-z0-9_]+\.PDF$/);
      expect(c.cycle).toBe('2610');
    }
    expect(cycleFor('KPGD').label).toBe('FAA d-TPP cycle 2610, effective 2026-10-01 to 2026-10-29');
    expect(getChart('06178AD', 'KPGD')?.name).toBe('AIRPORT DIAGRAM');
    expect(getChart('06178AD')).toBeUndefined();
  });

  it('groups approaches by runway in numeric order, ILS first', () => {
    const groups = listChartGroups('KPGD').filter((g) => g.category === 'IAP');
    expect(groups.map((g) => g.runway)).toEqual(['4', '15', '22', '33']);
    expect(groups.find((g) => g.runway === '4')!.charts[0].name).toBe('ILS OR LOC RWY 04');
  });
});

describe('KPGD navaid reference data', () => {
  const nav = navaidsFor('KPGD');
  it('has the Lee County VORTAC, the runway 4 ILS and 45 fixes', () => {
    expect(nav.faaId).toBe('PGD');
    expect(nav.vortac).toMatchObject({ id: 'RSW', type: 'VORTAC', freqMhz: 114.15, channel: '88Y' });
    expect(nav.ils.map((s) => [s.runway, s.plateIdent, s.freqMhz])).toEqual([['04', 'I-PGD', 109.75]]);
    expect(nav.runwaysWithoutIls.sort()).toEqual(['15', '22', '27', '33', '9']); // the panel lists every NASR runway end (09/27 included although the simulator does not model it)
    expect(nav.fixes).toHaveLength(45);
  });
});
