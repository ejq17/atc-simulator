import { Suspense, lazy } from 'react';
import type { ComponentType } from 'react';
import type { PanelId } from './layoutModel';
import { SurfaceDisplay } from '../display/SurfaceDisplay';
import { RadarDisplay } from '../display/RadarDisplay';
import { AircraftPanel } from '../components/AircraftPanel';
import { FlightStrips } from '../components/FlightStrips';
import { AircraftDetails } from '../components/AircraftDetails';
import { CommsLog } from '../components/CommsLog';
import { AlertsStrip } from '../components/AlertsStrip';
import { RadioPanel } from '../components/RadioPanel';
import { ChartsPanel } from '../drawers/ChartsDrawer';
import { NavaidsPanel } from '../drawers/NavaidsDrawer';
import { AtisPanel } from '../drawers/AtisDrawer';
import { WeatherPanel } from '../drawers/WeatherDrawer';
import { SettingsPanel } from '../drawers/SettingsDrawer';

// three.js lives in its own chunk, fetched only when the Tower view is first shown.
const TowerDisplay = lazy(() => import('../tower/TowerDisplay'));

function TowerPanel() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-atc-muted" data-testid="tower-loading">Loading tower view…</div>}>
      <TowerDisplay key="tower" />
    </Suspense>
  );
}

function DetailsPanel() {
  return <div className="min-h-0 flex-1 overflow-y-auto"><AircraftDetails /></div>;
}

function AlertsPanel() {
  return <div className="min-h-0 flex-1 overflow-y-auto"><AlertsStrip /></div>;
}

/** The component each panel shows. Every one reads the shared stores, so it renders the same in the main window, a tab, or a pop-out. */
export const PANEL_COMPONENTS: Record<PanelId, ComponentType> = {
  surface: SurfaceDisplay,
  radar: RadarDisplay,
  tower: TowerPanel,
  list: AircraftPanel,
  strips: FlightStrips,
  details: DetailsPanel,
  comms: CommsLog,
  alerts: AlertsPanel,
  radio: RadioPanel,
  charts: ChartsPanel,
  navaids: NavaidsPanel,
  atis: AtisPanel,
  weather: WeatherPanel,
  settings: SettingsPanel,
};

/** One-line usage hint shown in a display's title bar on wide screens. */
export const PANEL_HINT: Partial<Record<PanelId, string>> = {
  surface: 'Wheel / pinch zoom · drag pan · tap aircraft to select · +/− zoom',
  radar: 'Wheel / pinch / +/− change range · drag pan · tap target to select',
  tower: 'Drag look · wheel / pinch zoom · [ ] runway ends · F follow · B binoculars',
  list: 'requests first',
  strips: 'one bay per position',
};
