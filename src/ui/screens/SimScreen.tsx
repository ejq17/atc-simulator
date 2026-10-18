import { useEffect } from 'react';
import { useSimStore } from '../store/simStore';
import { useUiStore, viewBus } from '../store/uiStore';
import { useLayoutStore } from '../store/layoutStore';
import { TopBar } from '../components/TopBar';
import { NoticeBar, TrainingBanner } from '../components/Banners';
import { ChartsDrawer } from '../drawers/ChartsDrawer';
import { NavaidsDrawer } from '../drawers/NavaidsDrawer';
import { SettingsDrawer } from '../drawers/SettingsDrawer';
import { AtisDrawer } from '../drawers/AtisDrawer';
import { WeatherDrawer } from '../drawers/WeatherDrawer';
import { Workspace } from '../layout/Workspace';
import { MobileShell } from '../layout/MobileShell';
import { PopoutHost } from '../layout/PopoutHost';
import { PopupNotices } from '../layout/PopupNotices';
import { revealPanel, stripsVisible } from '../layout/actions';
import { useCompact } from '../layout/useMedia';
import { addWindowListener, onEachWindow } from '../layout/windows';

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !('tagName' in el)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** Keyboard shortcuts, on the main window and on every pop-out window (a popup has its own event target). */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ui = useUiStore.getState();
      const sim = useSimStore.getState();
      if (isEditable(e.target)) return;
      switch (e.key) {
        case 'Enter':
          if (ui.drawer) return;
          e.preventDefault();
          window.dispatchEvent(new Event('atc:focus-input'));
          break;
        case 'Escape':
          if (ui.drawer) return; // the drawer closes itself
          sim.selectAircraft(undefined);
          break;
        case '1': revealPanel('surface'); break;
        case '2': revealPanel('radar'); break;
        case '3': revealPanel('tower'); break;
        case '+': case '=': viewBus.emit({ type: 'zoom', factor: 1.4 }); break;
        case '-': case '_': viewBus.emit({ type: 'zoom', factor: 1 / 1.4 }); break;
        case 'p': case 'P': sim.togglePause(); break;
        // Strip board (only while it is showing, so the keys never surprise anyone looking at the aircraft list).
        case 's': case 'S': if (stripsVisible()) { e.preventDefault(); sim.strikeStrip(); } break;
        case 'x': case 'X': if (stripsVisible()) { e.preventDefault(); sim.dropStrip(); } break;
        default:
      }
    };
    return addWindowListener('keydown', onKey);
  }, []);
}

/** Push-to-talk key events must also reach the voice controller while a pop-out has focus. */
function usePttInPopouts() {
  const ptt = useSimStore((s) => s.session?.voice?.ptt);
  const landline = useSimStore((s) => s.session?.voice?.landlinePtt);
  useEffect(() => {
    if (!ptt) return;
    return onEachWindow((win) => {
      if (win === window) return undefined;
      const offs = [ptt.attachTarget(win), landline?.attachTarget(win)];
      return () => offs.forEach((off) => off?.());
    });
  }, [ptt, landline]);
}

export function SimScreen() {
  const drawer = useUiStore((s) => s.drawer);
  const setDrawer = useUiStore((s) => s.setDrawer);
  const icao = useSimStore((s) => s.session?.engine.getState().airport.icao ?? 'KACY');
  const compact = useCompact();
  useShortcuts();
  usePttInPopouts();
  // Ending the session closes every pop-out (their geometry stays remembered for "Reopen windows").
  useEffect(() => () => useLayoutStore.getState().closeAllPopouts(true), []);
  const close = () => setDrawer(null);
  return (
    <div className="atc-app flex flex-col bg-atc-bg" data-testid="sim-screen">
      <TopBar />
      <NoticeBar />
      <TrainingBanner />
      <PopupNotices />
      {compact ? <MobileShell /> : <Workspace />}
      <PopoutHost />
      {drawer === 'charts' && <ChartsDrawer onClose={close} icao={icao} />}
      {drawer === 'navaids' && <NavaidsDrawer onClose={close} icao={icao} />}
      {drawer === 'settings' && <SettingsDrawer onClose={close} />}
      {drawer === 'atis' && <AtisDrawer onClose={close} />}
      {drawer === 'weather' && <WeatherDrawer onClose={close} />}
    </div>
  );
}
