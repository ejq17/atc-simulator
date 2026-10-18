/**
 * The panel layout the player arranged, plus the pop-out windows that hold some of its panels.
 * The persistent part (`layout`) is the pure model in ui/layout/layoutModel.ts; the windows are live browser objects and
 * are never persisted, only their geometry and home region are, so a new session can offer "Reopen windows".
 */
import { create } from 'zustand';
import {
  LAYOUT_STORAGE_KEY, activatePanel, clampSize, defaultLayout, ensureDisplay, hidePanel, isDocked, movePanel, parseLayout, popInPanel, popOutPanel, presetLayout, serializeLayout,
  setPopGeometry, setSize, showPanel, togglePanel,
} from '../layout/layoutModel';
import type { LayoutSizes, LayoutState, PanelId, PopGeometry, PresetId, RegionId } from '../layout/layoutModel';
import { openPopup } from '../layout/popupWindow';
import type { PopupHandle } from '../layout/popupWindow';
import { registerWindow, unregisterWindow } from '../layout/windows';
import { metaOf } from '../layout/panelMeta';

export interface PopupRef { win: Window; root: HTMLElement }

interface LayoutStore {
  layout: LayoutState;
  /** Live pop-out windows by panel. Not persisted. */
  windows: Partial<Record<PanelId, PopupRef>>;
  /** The browser refused to open a window (popup blocker). Cleared by the next successful pop-out or by dismissing the notice. */
  popupBlocked: boolean;
  /** Panels whose window was open when the last session ended: offered by "Reopen windows". */
  reopenable(): PanelId[];

  applyPreset(id: PresetId): void;
  reset(): void;
  movePanel(id: PanelId, region: RegionId): void;
  hidePanel(id: PanelId): void;
  showPanel(id: PanelId, region?: RegionId): void;
  togglePanel(id: PanelId): void;
  activate(id: PanelId): void;
  setSize(kind: keyof LayoutSizes, v: number): void;
  /** Show a panel wherever it lives: raise its window, or dock and activate it. */
  reveal(id: PanelId): void;

  popOut(id: PanelId): boolean;
  popIn(id: PanelId): void;
  reopenAll(): number;
  dismissReopen(): void;
  dismissBlocked(): void;
  /** Close every pop-out window. With `keepRecords` their geometry stays remembered for "Reopen windows". */
  closeAllPopouts(keepRecords: boolean): void;
}

function load(): LayoutState {
  try {
    return parseLayout(typeof localStorage === 'undefined' ? null : localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    return defaultLayout();
  }
}

function save(l: LayoutState) {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, serializeLayout(l));
  } catch { /* private mode or storage disabled: the layout simply is not remembered */ }
}

const handles = new Map<PanelId, PopupHandle>();
/** Windows we are closing ourselves: their unload event must not dock the panel again or forget it. */
const silent = new Set<PanelId>();
let unloading = false;
let geometryTimer: ReturnType<typeof setInterval> | undefined;

function defaultGeometry(id: PanelId, taken: number): PopGeometry {
  const { pop, min } = metaOf(id);
  const sx = typeof window === 'undefined' ? 0 : window.screenX;
  const sy = typeof window === 'undefined' ? 0 : window.screenY;
  return { x: sx + 60 + taken * 36, y: sy + 80 + taken * 36, w: Math.max(min.w, pop.w), h: Math.max(min.h, pop.h) };
}

export const useLayoutStore = create<LayoutStore>((set, get) => {
  const setLayout = (fn: (l: LayoutState) => LayoutState) => {
    const next = fn(get().layout);
    if (next !== get().layout) set({ layout: next });
  };

  const startGeometryPoll = () => {
    if (geometryTimer || typeof window === 'undefined') return;
    geometryTimer = setInterval(() => {
      for (const [id, h] of handles) {
        if (h.win.closed) continue;
        const g = h.geometry();
        if (g.w > 100 && g.h > 100) setLayout((l) => setPopGeometry(l, id, g));
      }
      if (handles.size === 0 && geometryTimer) { clearInterval(geometryTimer); geometryTimer = undefined; }
    }, 2000);
  };

  const dropHandle = (id: PanelId) => {
    const h = handles.get(id);
    if (h) unregisterWindow(h.win);
    handles.delete(id);
    const { [id]: _gone, ...rest } = get().windows;
    set({ windows: rest });
  };

  return {
    layout: load(),
    windows: {},
    popupBlocked: false,
    reopenable: () => (Object.keys(get().layout.popouts) as PanelId[]).filter((id) => !get().windows[id]),

    applyPreset(id) {
      const cur = get().layout;
      let next: LayoutState = { ...presetLayout(id), sizes: cur.sizes, popouts: { ...cur.popouts } };
      // Panels that live in a window stay there; the preset arranges the rest.
      for (const [pid, h] of handles) next = popOutPanel(next, pid, { ...cur.popouts[pid], ...h.geometry() });
      set({ layout: ensureDisplay(next) });
    },
    reset() { get().applyPreset('everything'); },
    movePanel: (id, region) => setLayout((l) => (get().windows[id] ? l : movePanel(l, id, region))),
    hidePanel(id) {
      if (get().windows[id]) get().popIn(id);
      setLayout((l) => ensureDisplay(hidePanel(l, id)));
    },
    showPanel: (id, region) => setLayout((l) => showPanel(l, id, region)),
    togglePanel(id) {
      if (get().windows[id]) { get().hidePanel(id); return; }
      setLayout((l) => ensureDisplay(togglePanel(l, id)));
    },
    activate: (id) => setLayout((l) => activatePanel(l, id)),
    setSize: (kind, v) => setLayout((l) => setSize(l, kind, v)),
    reveal(id) {
      const h = handles.get(id);
      if (h) { try { h.win.focus(); } catch { /* focus may be refused */ } return; }
      setLayout((l) => (isDocked(l, id) ? activatePanel(l, id) : showPanel(l, id)));
    },

    popOut(id) {
      if (handles.has(id)) { handles.get(id)!.win.focus(); return true; }
      const rec = get().layout.popouts[id];
      const geom: PopGeometry = rec ? { x: rec.x, y: rec.y, w: rec.w, h: rec.h } : defaultGeometry(id, handles.size);
      const handle: PopupHandle | null = openPopup({
        name: `kacy-atc-${id}`,
        title: `${metaOf(id).title} - ATC Simulator`,
        geometry: geom,
        onClosed: () => {
          const wasSilent = silent.delete(id);
          dropHandle(id);
          if (!wasSilent && !unloading) setLayout((l) => popInPanel(l, id, false));
        },
      });
      if (!handle) {
        set({ popupBlocked: true });
        return false;
      }
      handles.set(id, handle);
      registerWindow(handle.win);
      set({ popupBlocked: false, windows: { ...get().windows, [id]: { win: handle.win, root: handle.root } } });
      setLayout((l) => popOutPanel(l, id, geom));
      startGeometryPoll();
      return true;
    },
    popIn(id) {
      const h = handles.get(id);
      if (!h) { setLayout((l) => popInPanel(l, id, false)); return; }
      silent.add(id);
      h.close();
      dropHandle(id);
      silent.delete(id);
      setLayout((l) => popInPanel(l, id, false));
    },
    reopenAll() {
      let n = 0;
      // Browsers allow about one pop-up per click, so a second window may be refused: that is not "blocked", the notice keeps the rest.
      for (const id of get().reopenable()) if (get().popOut(id)) n++;
      if (n > 0) set({ popupBlocked: false });
      return n;
    },
    dismissReopen() {
      set({ layout: { ...get().layout, popouts: Object.fromEntries(Object.entries(get().layout.popouts).filter(([id]) => get().windows[id as PanelId])) } });
    },
    dismissBlocked: () => set({ popupBlocked: false }),
    closeAllPopouts(keepRecords) {
      const ids = [...handles.keys()];
      for (const id of ids) {
        const h = handles.get(id)!;
        silent.add(id);
        h.close();
        dropHandle(id);
        silent.delete(id);
      }
      if (ids.length) setLayout((l) => ids.reduce((acc, id) => popInPanel(acc, id, keepRecords), l));
    },
  };
});

export { clampSize };

if (typeof window !== 'undefined') {
  useLayoutStore.subscribe((s, prev) => { if (s.layout !== prev.layout) save(s.layout); });
  // Closing or reloading the main window takes its pop-outs with it, but they stay remembered for "Reopen windows".
  const onGone = () => {
    unloading = true;
    save(useLayoutStore.getState().layout);
    for (const h of handles.values()) { try { h.win.close(); } catch { /* ignore */ } }
  };
  window.addEventListener('pagehide', onGone);
  window.addEventListener('beforeunload', onGone);
  window.addEventListener('pageshow', () => { unloading = false; });
}
