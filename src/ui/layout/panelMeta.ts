import { HOME_REGION } from './layoutModel';
import type { PanelId, RegionId } from './layoutModel';

/** Which mobile bottom-bar section a panel belongs to (below 1024 px one section shows at a time). */
export type MobileSection = 'display' | 'aircraft' | 'comms' | 'radio';

export interface PanelMeta {
  id: PanelId;
  title: string;
  /** Smallest useful size in CSS pixels; the pop-out window opens no smaller, and docked regions never shrink a panel below it. */
  min: { w: number; h: number };
  /** Size a new pop-out window opens at. */
  pop: { w: number; h: number };
  mobile?: MobileSection;
  /** Canvas display: fills its region and wants the keys 1/2/3. */
  display?: boolean;
  home: RegionId;
}

const m = (id: PanelId, title: string, min: [number, number], pop: [number, number], extra: Partial<PanelMeta> = {}): PanelMeta => ({
  id, title, min: { w: min[0], h: min[1] }, pop: { w: pop[0], h: pop[1] }, home: HOME_REGION[id], ...extra,
});

export const PANEL_META: Record<PanelId, PanelMeta> = {
  surface: m('surface', 'Surface', [320, 220], [1100, 780], { mobile: 'display', display: true }),
  radar: m('radar', 'Radar', [320, 220], [1000, 780], { mobile: 'display', display: true }),
  tower: m('tower', 'Tower', [320, 220], [1100, 700], { mobile: 'display', display: true }),
  list: m('list', 'Aircraft', [260, 160], [460, 720], { mobile: 'aircraft' }),
  strips: m('strips', 'Strips', [280, 200], [560, 760], { mobile: 'aircraft' }),
  details: m('details', 'Details', [260, 140], [460, 640], { mobile: 'aircraft' }),
  comms: m('comms', 'Comms', [300, 140], [620, 480], { mobile: 'comms' }),
  alerts: m('alerts', 'Alerts', [260, 60], [680, 160], { mobile: 'comms' }),
  radio: m('radio', 'Radio', [300, 220], [460, 520], { mobile: 'radio' }),
  charts: m('charts', 'Charts', [360, 300], [1100, 820]),
  navaids: m('navaids', 'Navaids', [320, 260], [760, 720]),
  atis: m('atis', 'ATIS', [280, 200], [520, 520]),
  weather: m('weather', 'Weather', [280, 260], [480, 640]),
  settings: m('settings', 'Settings', [300, 260], [560, 760]),
};

export const metaOf = (id: PanelId): PanelMeta => PANEL_META[id];

export const MOBILE_SECTIONS: { id: MobileSection; label: string }[] = [
  { id: 'display', label: 'Display' },
  { id: 'aircraft', label: 'Aircraft' },
  { id: 'comms', label: 'Comms' },
  { id: 'radio', label: 'Radio' },
];

export function panelsOfSection(section: MobileSection): PanelId[] {
  return (Object.values(PANEL_META) as PanelMeta[]).filter((p) => p.mobile === section).map((p) => p.id);
}
