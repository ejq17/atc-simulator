import { describe, expect, it } from 'vitest';
import { mergeAiRows } from './RadioPanel';

describe('Other positions (AI) rows', () => {
  it('lists APP and DEP, which share 124.6 at KACY, as one row', () => {
    const rows = mergeAiRows([
      { position: 'TWR', mhz: 120.3, text: 'TWR (AI): 2 aircraft' },
      { position: 'APP', mhz: 124.6, text: 'APP (AI): 1 aircraft' },
      { position: 'DEP', mhz: 124.6, text: 'DEP (AI): 0 aircraft' },
    ]);
    expect(rows.map((r) => r.positions)).toEqual([['TWR'], ['APP', 'DEP']]);
    expect(rows[1].text).toBe('APP (AI): 1 aircraft | DEP (AI): 0 aircraft');
  });
  it('keeps rows with no frequency apart and tolerates empty status text', () => {
    expect(mergeAiRows([{ position: 'GND', text: '' }, { position: 'CLNC', text: '' }]).map((r) => r.positions)).toEqual([['GND'], ['CLNC']]);
    expect(mergeAiRows([])).toEqual([]);
  });
});
