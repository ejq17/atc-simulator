// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_STORAGE_KEY, defaultLayout, placements } from '../layout/layoutModel';
import { useLayoutStore } from './layoutStore';

/** A fake popup: an iframe's window, closable like a real one. */
function fakePopup() {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow!;
  Object.defineProperty(win, 'closed', { get: () => !frame.isConnected });
  Object.defineProperty(win, 'screenX', { value: 100 });
  Object.defineProperty(win, 'screenY', { value: 50 });
  Object.defineProperty(win, 'outerWidth', { value: 900 });
  Object.defineProperty(win, 'outerHeight', { value: 700 });
  win.close = () => { win.dispatchEvent(new (win as unknown as typeof globalThis).Event('unload')); frame.remove(); };
  return win;
}

describe('layout store', () => {
  beforeEach(() => {
    localStorage.clear();
    useLayoutStore.getState().closeAllPopouts(false);
    useLayoutStore.setState({ layout: defaultLayout(), windows: {}, popupBlocked: false });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('applies presets, moves and hides panels, and persists every change under the versioned key', () => {
    const s = useLayoutStore.getState();
    s.applyPreset('ground');
    expect(placements(useLayoutStore.getState().layout).get('comms')?.region).toBe('bottom');
    s.movePanel('list', 'bottom');
    s.hidePanel('strips');
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!);
    expect(saved.regions.bottom.flatMap((g: { tabs: string[] }) => g.tabs)).toContain('list');
    expect(saved.regions.right.flatMap((g: { tabs: string[] }) => g.tabs)).not.toContain('strips');
    s.reset();
    expect(useLayoutStore.getState().layout.regions).toEqual(defaultLayout().regions);
  });

  it('pops a panel out: opens a window, removes it from the layout, and docks it back when the window closes', () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    const ok = useLayoutStore.getState().popOut('radar');
    expect(ok).toBe(true);
    expect(open).toHaveBeenCalledWith('', 'kacy-atc-radar', expect.stringContaining('popup'));
    let st = useLayoutStore.getState();
    expect(st.windows.radar?.win).toBe(popup);
    expect(placements(st.layout).has('radar')).toBe(false);
    expect(st.layout.popouts.radar).toBeDefined();
    expect(popup.document.title).toContain('Radar');

    popup.close(); // the user closes the window
    st = useLayoutStore.getState();
    expect(st.windows.radar).toBeUndefined();
    expect(placements(st.layout).get('radar')?.region).toBe('main');
    expect(st.layout.popouts.radar).toBeUndefined();
  });

  it('shows the blocker notice when the browser refuses the window and leaves the panel where it is', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(useLayoutStore.getState().popOut('comms')).toBe(false);
    const st = useLayoutStore.getState();
    expect(st.popupBlocked).toBe(true);
    expect(placements(st.layout).has('comms')).toBe(true);
    st.dismissBlocked();
    expect(useLayoutStore.getState().popupBlocked).toBe(false);
  });

  it('closing all windows at session end docks the panels but keeps their geometry for "Reopen windows"', () => {
    vi.spyOn(window, 'open').mockImplementation(() => fakePopup());
    const s = useLayoutStore.getState();
    s.popOut('radar');
    s.popOut('radio');
    expect(Object.keys(useLayoutStore.getState().windows)).toHaveLength(2);
    s.closeAllPopouts(true);
    const st = useLayoutStore.getState();
    expect(Object.keys(st.windows)).toHaveLength(0);
    expect(placements(st.layout).get('radio')?.region).toBe('bottom');
    expect(st.reopenable().sort()).toEqual(['radar', 'radio']);
    expect(st.reopenAll()).toBe(2);
    expect(Object.keys(useLayoutStore.getState().windows).sort()).toEqual(['radar', 'radio']);
    expect(placements(useLayoutStore.getState().layout).has('radio')).toBe(false);
  });

  it('a preset keeps panels that live in a window in their windows', () => {
    vi.spyOn(window, 'open').mockImplementation(() => fakePopup());
    useLayoutStore.getState().popOut('radio');
    useLayoutStore.getState().applyPreset('tracon');
    const st = useLayoutStore.getState();
    expect(placements(st.layout).has('radio')).toBe(false);
    expect(st.windows.radio).toBeDefined();
    expect(placements(st.layout).get('strips')?.region).toBe('right');
  });
});
