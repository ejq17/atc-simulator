/** Things the keyboard, the top bar and the panels do to the layout that depend on the viewport (phone tab bar vs. desktop regions). */
import { useLayoutStore } from '../store/layoutStore';
import { useUiStore } from '../store/uiStore';
import { placements } from './layoutModel';
import type { PanelId } from './layoutModel';
import { metaOf } from './panelMeta';
import { isCompactNow } from './useMedia';

/** Bring a panel into view wherever it lives: raise its window, activate its tab, or (phone) switch the bottom-bar section. */
export function revealPanel(id: PanelId) {
  const meta = metaOf(id);
  if (isCompactNow() && meta.mobile) {
    const ui = useUiStore.getState();
    ui.setMobileSection(meta.mobile);
    ui.setMobileActive(meta.mobile, id);
    return;
  }
  useLayoutStore.getState().reveal(id);
}

/** True when the strip board is on screen (its tab is active, or it has its own window): S and X act on it only then. */
export function stripsVisible(): boolean {
  const { layout, windows } = useLayoutStore.getState();
  if (windows.strips) return true;
  if (isCompactNow()) {
    const ui = useUiStore.getState();
    return ui.mobileSection === 'aircraft' && ui.mobileActive.aircraft === 'strips';
  }
  const at = placements(layout).get('strips');
  return !!at && layout.regions[at.region][at.group].active === 'strips';
}

/** Top bar buttons: Charts, Navaids, Settings, ATIS, Weather. A panel that has a place (tab or window) is shown there; otherwise it opens as a drawer. */
export function openTool(id: Extract<PanelId, 'charts' | 'navaids' | 'settings' | 'atis' | 'weather'>) {
  const { layout, windows } = useLayoutStore.getState();
  const ui = useUiStore.getState();
  if (!isCompactNow() && (windows[id] || placements(layout).has(id))) {
    ui.setDrawer(null);
    useLayoutStore.getState().reveal(id);
    return;
  }
  ui.toggleDrawer(id);
}
