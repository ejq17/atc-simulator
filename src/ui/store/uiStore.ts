/** Purely visual UI state (view, layers, drawers). Aircraft/sim state lives in the sim store, never here. */
import { create } from 'zustand';
import { DEFAULT_SURFACE_LAYERS } from '../display/surfaceRenderer';
import type { SurfaceLayers } from '../display/surfaceRenderer';
import { DEFAULT_RADAR_LAYERS } from '../display/radarRenderer';
import type { RadarLayers, RadarRangeNm } from '../display/radarRenderer';

import type { PanelId } from '../layout/layoutModel';
import type { MobileSection } from '../layout/panelMeta';

export type DisplayView = 'surface' | 'radar' | 'tower';
export type DrawerId = 'charts' | 'navaids' | 'settings' | 'atis' | 'weather' | null;

interface UiState {
  /** Phone layout (below 1024 px): which bottom-bar section shows, and which tab is active inside each section. */
  mobileSection: MobileSection;
  setMobileSection(s: MobileSection): void;
  mobileActive: Partial<Record<MobileSection, PanelId>>;
  setMobileActive(section: MobileSection, id: PanelId): void;
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
  setDrawer(d: DrawerId): void;
  toggleDrawer(d: Exclude<DrawerId, null>): void;
  toggleSurfaceLayer(k: keyof SurfaceLayers): void;
  toggleRadarLayer(k: keyof RadarLayers): void;
  setRadarRange(r: RadarRangeNm): void;
  setFollow(f: boolean): void;
}

export const useUiStore = create<UiState>((set) => ({
  mobileSection: 'display',
  setMobileSection: (mobileSection) => set({ mobileSection }),
  mobileActive: {},
  setMobileActive: (section, id) => set((s) => ({ mobileActive: { ...s.mobileActive, [section]: id } })),
  stripDetailsOpen: false,
  setStripDetailsOpen: (stripDetailsOpen) => set({ stripDetailsOpen }),
  drawer: null,
  surfaceLayers: { ...DEFAULT_SURFACE_LAYERS },
  radarLayers: { ...DEFAULT_RADAR_LAYERS },
  radarRangeNm: 10,
  follow: false,
  draft: '',
  setDraft: (draft) => set({ draft }),
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
