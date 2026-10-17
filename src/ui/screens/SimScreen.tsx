import { Suspense, lazy, useEffect } from 'react';
import { useSimStore } from '../store/simStore';
import { useUiStore, viewBus } from '../store/uiStore';
import { TopBar } from '../components/TopBar';
import { FlightStrips } from '../components/FlightStrips';
import { AircraftPanel } from '../components/AircraftPanel';
import { AircraftDetails } from '../components/AircraftDetails';
import { RadioPanel } from '../components/RadioPanel';
import { CommsLog } from '../components/CommsLog';
import { AlertsStrip } from '../components/AlertsStrip';
import { NoticeBar, TrainingBanner } from '../components/Banners';
import { Segmented } from '../components/ui';
import { SurfaceDisplay } from '../display/SurfaceDisplay';
import { RadarDisplay } from '../display/RadarDisplay';

// three.js lives in its own chunk, fetched only when the Tower tab is first opened.
const TowerDisplay = lazy(() => import('../tower/TowerDisplay'));
import { ChartsDrawer } from '../drawers/ChartsDrawer';
import { NavaidsDrawer } from '../drawers/NavaidsDrawer';
import { SettingsDrawer } from '../drawers/SettingsDrawer';
import { AtisDrawer } from '../drawers/AtisDrawer';
import { WeatherDrawer } from '../drawers/WeatherDrawer';

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !('tagName' in el)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

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
        case '1': ui.setView('surface'); break;
        case '2': ui.setView('radar'); break;
        case '3': ui.setView('tower'); break;
        case '+': case '=': viewBus.emit({ type: 'zoom', factor: 1.4 }); break;
        case '-': case '_': viewBus.emit({ type: 'zoom', factor: 1 / 1.4 }); break;
        case 'p': case 'P': sim.togglePause(); break;
        // Strip board (only while the Strips tab is showing, so the keys never surprise anyone looking at the aircraft list).
        case 's': case 'S': if (ui.sideTab === 'strips') { e.preventDefault(); sim.strikeStrip(); } break;
        case 'x': case 'X': if (ui.sideTab === 'strips') { e.preventDefault(); sim.dropStrip(); } break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function selectedCallsign(id: string | undefined): string {
  const st = useSimStore.getState().session?.engine.getState();
  const ac = id && st ? st.aircraft[id] : undefined;
  return ac ? `· ${ac.callsign}` : '';
}

export function SimScreen() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const drawer = useUiStore((s) => s.drawer);
  const setDrawer = useUiStore((s) => s.setDrawer);
  const sideTab = useUiStore((s) => s.sideTab);
  const setSideTab = useUiStore((s) => s.setSideTab);
  const detailsOpen = useUiStore((s) => s.stripDetailsOpen);
  const setDetailsOpen = useUiStore((s) => s.setStripDetailsOpen);
  const selectedId = useSimStore((s) => s.session?.engine.getState().selectedAircraftId);
  const icao = useSimStore((s) => s.session?.engine.getState().airport.icao ?? 'KACY');
  useSimStore((s) => s.rev);
  useShortcuts();
  const close = () => setDrawer(null);
  return (
    <div className="flex h-full flex-col bg-atc-bg" data-testid="sim-screen">
      <TopBar />
      <NoticeBar />
      <TrainingBanner />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-atc-border bg-atc-panel px-3">
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'surface', label: <span data-testid="tab-surface">Surface <span className="opacity-60">1</span></span> },
                { value: 'radar', label: <span data-testid="tab-radar">Radar <span className="opacity-60">2</span></span> },
                { value: 'tower', label: <span data-testid="tab-tower">Tower <span className="opacity-60">3</span></span> },
              ]}
            />
            <span className="hidden font-sans text-[10.5px] uppercase tracking-wider text-atc-muted md:inline">
              {view === 'surface'
                ? 'Wheel zoom · drag pan · click aircraft to select · +/− zoom'
                : view === 'radar'
                  ? 'Wheel / +/− change range · drag pan · click target to select'
                  : 'Drag look · wheel zoom · [ ] runway ends · F follow · B binoculars · click aircraft to select'}
            </span>
          </div>
          <div className="relative min-h-0 flex-1" data-testid="display-area">
            {view === 'surface' ? <SurfaceDisplay key="surface" /> : view === 'radar' ? <RadarDisplay key="radar" /> : (
              <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-atc-muted" data-testid="tower-loading">Loading tower view…</div>}>
                <TowerDisplay key="tower" />
              </Suspense>
            )}
          </div>
        </div>
        <aside className="flex w-[380px] shrink-0 flex-col border-l border-atc-border bg-atc-panel xl:w-[400px]">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-atc-border bg-atc-panel px-2">
            <Segmented
              size="xs"
              value={sideTab}
              onChange={setSideTab}
              options={[
                { value: 'list', label: <span data-testid="tab-list">Aircraft</span> },
                { value: 'strips', label: <span data-testid="tab-strips">Strips</span> },
              ]}
            />
            <span className="font-sans text-[10px] uppercase tracking-wider text-atc-muted">{sideTab === 'list' ? 'requests first' : 'one bay per position'}</span>
          </div>
          {sideTab === 'list' ? <AircraftPanel /> : <FlightStrips />}
          {sideTab === 'strips' && (
            <button
              type="button"
              data-testid="details-toggle"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen(!detailsOpen)}
              className="flex h-7 shrink-0 items-center justify-between border-t border-atc-border bg-atc-panel-2 px-3 font-sans text-[10.5px] font-semibold uppercase tracking-[0.18em] text-atc-text hover:text-atc-cyan"
            >
              <span>Aircraft details {selectedCallsign(selectedId)}</span>
              <span className="text-atc-muted">{detailsOpen ? '▾' : '▸'}</span>
            </button>
          )}
          {(sideTab !== 'strips' || detailsOpen) && (
            <div className={`${sideTab === 'strips' ? 'max-h-[34%]' : 'max-h-[62%]'} shrink-0 overflow-y-auto border-t border-atc-border`}>
              <AircraftDetails />
            </div>
          )}
        </aside>
      </div>
      <div className="flex h-[348px] shrink-0 border-t border-atc-border">
        <div className="flex min-w-0 flex-1 flex-col">
          <AlertsStrip />
          <div className="min-h-0 flex-1"><CommsLog /></div>
        </div>
        <div className="w-[380px] shrink-0 border-l border-atc-border xl:w-[400px]"><RadioPanel /></div>
      </div>
      {drawer === 'charts' && <ChartsDrawer onClose={close} icao={icao} />}
      {drawer === 'navaids' && <NavaidsDrawer onClose={close} icao={icao} />}
      {drawer === 'settings' && <SettingsDrawer onClose={close} />}
      {drawer === 'atis' && <AtisDrawer onClose={close} />}
      {drawer === 'weather' && <WeatherDrawer onClose={close} />}
    </div>
  );
}
