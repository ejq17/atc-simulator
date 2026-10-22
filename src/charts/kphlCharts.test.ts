import { describe, expect, it } from 'vitest';
import { chartsByCategory, cycleFor, getChart, listChartGroups, listCharts } from './chartIndex';
import { navaidsFor } from './navaidData';

describe('KPHL chart index (from kphl-procedures.json)', () => {
  it('lists the diagram, 25 approach charts (22 instrument + 3 visual), the DP, 6 STARs, the hot-spot page and the NE-4 minimums pages', () => {
    expect(chartsByCategory('DIAGRAM', 'KPHL').map((c) => c.pdfName)).toEqual(['00320AD.PDF']);
    expect(chartsByCategory('IAP', 'KPHL')).toHaveLength(25);
    expect(chartsByCategory('IAP', 'KPHL').filter((c) => c.approachType === 'Visual approach')).toHaveLength(3);
    expect(chartsByCategory('DP', 'KPHL').map((c) => c.name)).toEqual(['PHILADELPHIA FOUR DEPARTURE', 'PHILADELPHIA FOUR DEPARTURE, CONT.1']);
    expect(chartsByCategory('STAR', 'KPHL').map((c) => c.name)).toEqual(['BOJID FOUR (RNAV)', 'PAATS FOUR (RNAV)', 'PAATS FOUR (RNAV), CONT.1', 'BUNTS THREE', 'JIIMS FOUR (RNAV)', 'SLATT SIX', 'SPUDS SEVEN (RNAV)']);
    expect(chartsByCategory('HOT_SPOT', 'KPHL').map((c) => c.pdfName)).toEqual(['NE4HOTSPOT.PDF']);
    expect(chartsByCategory('LAHSO', 'KPHL')).toHaveLength(0);
    expect(chartsByCategory('MINIMUMS', 'KPHL').map((c) => c.pdfName).sort()).toEqual(['NE4ALT.PDF', 'NE4TO.PDF']);
    expect(chartsByCategory('MINIMUMS', 'KPHL')[0].note).toMatch(/Northeast 4 booklet page.*KPHL/);
  });

  it('every chart is an official aeronav URL of cycle 2610; the KACY list is the default and unchanged', () => {
    for (const c of listCharts('KPHL')) {
      expect(c.pdfUrl).toMatch(/^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\/[A-Za-z0-9_]+\.PDF$/);
      expect(c.cycle).toBe('2610');
    }
    expect(listCharts('KPHL')).toHaveLength(38);
    expect(cycleFor('KPHL').label).toBe('FAA d-TPP cycle 2610, effective 2026-10-01 to 2026-10-29');
    expect(listCharts()).toEqual(listCharts('KACY'));
    expect(getChart('00320AD', 'KPHL')?.name).toBe('AIRPORT DIAGRAM');
    expect(getChart('00320AD', 'KMHT')).toBeUndefined();
  });

  it('groups approaches by runway end (number, then L < R), ILS first, visual charts last', () => {
    const groups = listChartGroups('KPHL').filter((g) => g.category === 'IAP');
    expect(groups.map((g) => g.runway)).toEqual(['9L', '9R', '17', '26', '27L', '27R', '35']);
    expect(groups.find((g) => g.runway === '27R')!.charts[0].name).toBe('ILS OR LOC RWY 27R');
    const g9l = groups.find((g) => g.runway === '9L')!.charts.map((c) => c.name);
    expect(g9l[0]).toBe('ILS OR LOC RWY 09L');
    expect(g9l.at(-1)).toMatch(/VISUAL/);
  });
});

describe('KPHL navaid reference data', () => {
  const nav = navaidsFor('KPHL');
  it('has the OOD VORTAC as the reference navaid, six ILS systems and the plate VORs', () => {
    expect(nav.faaId).toBe('PHL');
    expect(nav.vortac).toMatchObject({ id: 'OOD', type: 'VORTAC', freqMhz: 112.8, channel: '75X' });
    expect(nav.ils.map((s) => [s.runway, s.plateIdent, s.freqMhz]).sort()).toEqual([['09L', 'I-VII', 108.95], ['09R', 'I-PHL', 109.3], ['17', 'I-MYY', 108.75], ['26', 'I-LLH', 111.55], ['27L', 'I-GLC', 109.3], ['27R', 'I-PDP', 108.95]]);
    expect(nav.runwaysWithoutIls.sort()).toEqual(['35', '8']);
    expect(nav.nearby.map((n) => n.id)).toEqual(expect.arrayContaining(['MXE', 'DQO', 'PTW', 'CYN', 'ARD', 'RBV']));
    expect(nav.fixes).toHaveLength(84);
    expect(nav.fixes.filter((f) => f.key).map((f) => f.id)).toEqual(expect.arrayContaining(['JALTO', 'KELEE', 'TORNE', 'HARLU']));
  });
});
