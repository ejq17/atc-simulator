/** Purely visual UI state (view, layers, drawers). Aircraft/sim state lives in the sim store, never here. */
import { create } from 'zustand';
import { DEFAULT_SURFACE_LAYERS } from '../display/surfaceRenderer';
import type { SurfaceLayers } from '../display/surfaceRenderer';
import { DEFAULT_RADAR_LAYERS } from '../display/radarRenderer';
import type { RadarLayers, RadarRangeNm } from '../display/radarRenderer';

export type DisplayView = 'surface' | 'radar' | 'tower';
export type SideTab = 'list' | 'strips';
export type DrawerId = 'charts' | 'navaids' | 'settings' | 'atis' | 'weather' | null;

interface UiState {
  view: DisplayView;
  sideTab: SideTab;
  setSideTab(t: SideTab): void;
  /** Aircraft details under the strip board: collapsed by default there, so the board gets the column. */
  stripDetailsOpen: boolean;
  setStripDetailsOpen(open: boolean): void;
  drawer: DrawerId;
  surfaceLayers: SurfaceLayers;
  radarLayers: RadarLayers;
  radarRangeNm: RadarRangeNm;
  follow: boolean;
  /** Text in the typed-command box (shared so other panels can pre-fill a callsign). */
  draft: string;
  setDraft(t: string): void;
  setView(v: DisplayView): void;
  setDrawer(d: DrawerId): void;
  toggleDrawer(d: Exclude<DrawerId, null>): void;
  toggleSurfaceLayer(k: keyof SurfaceLayers): void;
  toggleRadarLayer(k: keyof RadarLayers): void;
  setRadarRange(r: RadarRangeNm): void;
  setFollow(f: boolean): void;
}

export const useUiStore = create<UiState>((set) => ({
  view: 'surface',
  sideTab: 'list',
  setSideTab: (sideTab) => set({ sideTab }),
  stripDetailsOpen: false,
  setStripDetailsOpen: (stripDetailsOpen) => set({ stripDetailsOpen }),
  drawer: null,
  surfaceLayers: { ...DEFAULT_SURFACE_LAYERS },
  radarLayers: { ...DEFAULT_RADAR_LAYERS },
  radarRangeNm: 10,
  follow: false,
  draft: '',
  setDraft: (draft) => set({ draft }),
  setView: (view) => set({ view }),
  setDrawer: (drawer) => set({ drawer }),
  toggleDrawer: (d) => set((s) => ({ drawer: s.drawer === d ? null : d })),
  toggleSurfaceLayer: (k) => set((s) => ({ surfaceLayers: { ...s.surfaceLayers, [k]: !s.surfaceLayers[k] } })),
  toggleRadarLayer: (k) => set((s) => ({ radarLayers: { ...s.radarLayers, [k]: !s.radarLayers[k] } })),
  setRadarRange: (radarRangeNm) => set({ radarRangeNm }),
  setFollow: (follow) => set({ follow }),
}));

/** Tiny event bus so keyboard shortcuts can drive the active canvas view without prop drilling. */
type ViewCommand = { type: 'zoom'; factor: number } | { type: 'fit' };
const listeners = new Set<(c: ViewCommand) => void>();
export const viewBus = {
  emit: (c: ViewCommand) => listeners.forEach((l) => l(c)),
  subscribe(l: (c: ViewCommand) => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};
