import { describe, expect, it } from 'vitest';
import {
  LAYOUT_STORAGE_KEY, LAYOUT_VERSION, PANEL_IDS, PRESET_IDS, clampSize, defaultLayout, dockedPanels, hiddenPanels, hidePanel, movePanel, parseLayout, placements, popInPanel,
  popOutPanel, presetLayout, serializeLayout, setPopGeometry, setSize, showPanel, togglePanel,
} from './layoutModel';
import type { LayoutState } from './layoutModel';

const GEOM = { x: 10, y: 20, w: 800, h: 600 };
const where = (l: LayoutState, id: Parameters<typeof placements>[0] extends never ? never : (typeof PANEL_IDS)[number]) => placements(l).get(id)?.region;

describe('layout presets', () => {
  it('Tower cab is Tower view + strips + radio', () => {
    const l = presetLayout('tower-cab');
    expect(l.regions.main[0].active).toBe('tower');
    expect(l.regions.right[0].tabs).toContain('strips');
    expect(where(l, 'radio')).toBe('bottom');
    expect(where(l, 'comms')).toBeUndefined();
  });
  it('Ground is Surface + aircraft list + comms + radio', () => {
    const l = presetLayout('ground');
    expect(l.regions.main[0].active).toBe('surface');
    expect(l.regions.right[0].tabs).toContain('list');
    expect(where(l, 'comms')).toBe('bottom');
    expect(where(l, 'radio')).toBe('bottom');
  });
  it('TRACON is Radar + strips + radio', () => {
    const l = presetLayout('tracon');
    expect(l.regions.main[0].active).toBe('radar');
    expect(where(l, 'strips')).toBe('right');
    expect(where(l, 'radio')).toBe('bottom');
  });
  it('Everything is the original layout: three displays, list + strips + details, comms + alerts, radio', () => {
    const l = presetLayout('everything');
    expect(l.regions.main[0].tabs).toEqual(['surface', 'radar', 'tower']);
    expect(l.regions.right.map((g) => g.tabs)).toEqual([['list', 'strips'], ['details']]);
    expect(l.regions.bottom.map((g) => g.tabs)).toEqual([['comms', 'alerts'], ['radio']]);
    expect(l).toEqual(defaultLayout());
  });
  it('every preset shows each panel at most once and always has a display', () => {
    for (const id of PRESET_IDS) {
      const docked = dockedPanels(presetLayout(id));
      expect(new Set(docked).size).toBe(docked.length);
      expect(docked.some((p) => ['surface', 'radar', 'tower'].includes(p))).toBe(true);
    }
  });
});

describe('moving and hiding panels', () => {
  it('moves a panel to another region as a tab and makes it active', () => {
    const l = movePanel(defaultLayout(), 'comms', 'right');
    expect(where(l, 'comms')).toBe('right');
    expect(l.regions.right[0].tabs).toContain('comms');
    expect(l.regions.right[0].active).toBe('comms');
    expect(l.regions.bottom[0].tabs).toEqual(['alerts']);
  });
  it('drops a group that becomes empty and repairs the active tab', () => {
    let l = movePanel(defaultLayout(), 'radio', 'main');
    expect(l.regions.bottom).toHaveLength(1);
    l = hidePanel(l, 'comms');
    expect(l.regions.bottom[0].tabs).toEqual(['alerts']);
    expect(l.regions.bottom[0].active).toBe('alerts');
    l = hidePanel(l, 'alerts');
    expect(l.regions.bottom).toEqual([]);
  });
  it('hides and shows panels; hidden ones are listed', () => {
    let l = hidePanel(defaultLayout(), 'strips');
    expect(hiddenPanels(l)).toEqual(expect.arrayContaining(['strips', 'charts', 'settings']));
    l = showPanel(l, 'strips');
    expect(where(l, 'strips')).toBe('right');
    l = togglePanel(l, 'strips');
    expect(where(l, 'strips')).toBeUndefined();
  });
  it('showing an already docked panel just activates it, and the layout is not mutated', () => {
    const base = defaultLayout();
    const snapshot = JSON.stringify(base);
    const l = showPanel(base, 'strips');
    expect(l.regions.right[0].active).toBe('strips');
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('pop-out bookkeeping', () => {
  it('a popped-out panel leaves its region and remembers geometry and home region', () => {
    const l = popOutPanel(defaultLayout(), 'radar', GEOM);
    expect(where(l, 'radar')).toBeUndefined();
    expect(l.popouts.radar).toEqual({ ...GEOM, region: 'main' });
    expect(l.regions.main[0].tabs).toEqual(['surface', 'tower']);
  });
  it('pop in returns the panel to its region and forgets the window unless asked to keep it', () => {
    const popped = popOutPanel(defaultLayout(), 'radio', GEOM);
    expect(popped.regions.bottom).toHaveLength(1);
    const back = popInPanel(popped, 'radio');
    expect(where(back, 'radio')).toBe('bottom');
    expect(back.popouts.radio).toBeUndefined();
    const kept = popInPanel(popped, 'radio', true);
    expect(where(kept, 'radio')).toBe('bottom');
    expect(kept.popouts.radio).toBeDefined();
  });
  it('a popped panel cannot be shown or moved into a region at the same time', () => {
    const popped = popOutPanel(defaultLayout(), 'comms', GEOM);
    expect(showPanel(popped, 'comms')).toBe(popped);
  });
  it('remembers the last window geometry', () => {
    const popped = popOutPanel(defaultLayout(), 'comms', GEOM);
    const moved = setPopGeometry(popped, 'comms', { x: 5, y: 6, w: 700, h: 500 });
    expect(moved.popouts.comms).toMatchObject({ x: 5, w: 700, region: 'bottom' });
    expect(setPopGeometry(moved, 'comms', { x: 5, y: 6, w: 700, h: 500 })).toBe(moved);
    expect(setPopGeometry(defaultLayout(), 'comms', GEOM).popouts.comms).toBeUndefined();
  });
});

describe('persistence', () => {
  it('round-trips a customised layout', () => {
    let l = movePanel(defaultLayout(), 'comms', 'right');
    l = hidePanel(l, 'alerts');
    l = setSize(l, 'rightW', 500);
    l = popOutPanel(l, 'radar', GEOM);
    const back = parseLayout(serializeLayout(l));
    expect(back.sizes.rightW).toBe(500);
    expect(where(back, 'comms')).toBe('right');
    expect(where(back, 'alerts')).toBeUndefined();
    // A panel that was in a window is docked again on load (browsers will not reopen windows), with its record kept for "Reopen windows".
    expect(where(back, 'radar')).toBe('main');
    expect(back.popouts.radar).toMatchObject(GEOM);
  });
  it('falls back to the default for garbage, other versions and empty storage', () => {
    expect(parseLayout(null)).toEqual(defaultLayout());
    expect(parseLayout('not json')).toEqual(defaultLayout());
    expect(parseLayout(JSON.stringify({ version: LAYOUT_VERSION + 1, regions: {} }))).toEqual(defaultLayout());
    expect(parseLayout('{"version":1}')).toEqual(defaultLayout());
  });
  it('drops unknown panels, duplicates and bad sizes, and never ends up without a display', () => {
    const raw = JSON.stringify({
      version: LAYOUT_VERSION,
      regions: { main: [{ tabs: ['radio', 'bogus', 'radio'], active: 'bogus' }], right: 'x', bottom: [{ tabs: [], active: 'radio' }] },
      sizes: { rightW: 5, bottomH: 'tall' },
      popouts: { nope: { x: 1, y: 1, w: 1, h: 1 }, list: { x: 'a' } },
    });
    const l = parseLayout(raw);
    expect(l.regions.main[0].tabs.filter((t) => t === 'radio')).toHaveLength(1);
    expect(l.regions.main[0].tabs).toContain('surface');
    expect(l.sizes.rightW).toBe(clampSize('rightW', 5));
    expect(l.sizes.bottomH).toBe(348);
    expect(Object.keys(l.popouts)).toEqual([]);
  });
  it('uses a versioned storage key', () => {
    expect(LAYOUT_STORAGE_KEY).toMatch(/\.v\d+$/);
  });
});
