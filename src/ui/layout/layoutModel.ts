/**
 * Pure layout model: which panel sits in which region, as tabs, and which panels were popped out to their own windows.
 * No React, no DOM, no storage: `layoutStore.ts` persists it and `Workspace.tsx` renders it.
 */

export const PANEL_IDS = [
  'surface', 'radar', 'tower', 'list', 'strips', 'details', 'comms', 'alerts', 'landline', 'radio', 'charts', 'navaids', 'atis', 'weather', 'settings',
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const REGION_IDS = ['main', 'right', 'bottom'] as const;
export type RegionId = (typeof REGION_IDS)[number];

export const REGION_LABEL: Record<RegionId, string> = { main: 'Main display', right: 'Right column', bottom: 'Bottom row' };

/** A set of tabs. In the right column groups stack top to bottom; in the bottom row they sit side by side. */
export interface PanelGroup { tabs: PanelId[]; active: PanelId }
export type Regions = Record<RegionId, PanelGroup[]>;

export interface PopGeometry { x: number; y: number; w: number; h: number }
/** What is remembered about a panel that was popped out: its window geometry, and the region it returns to. */
export interface PopRecord extends PopGeometry { region: RegionId }

export interface LayoutSizes { rightW: number; bottomH: number }

export interface LayoutState {
  version: number;
  regions: Regions;
  sizes: LayoutSizes;
  popouts: Partial<Record<PanelId, PopRecord>>;
}

export const LAYOUT_VERSION = 1;
export const DEFAULT_SIZES: LayoutSizes = { rightW: 380, bottomH: 348 };
export const SIZE_LIMITS = { rightW: [260, 900], bottomH: [140, 900] } as const;

export const PRESET_IDS = ['tower-cab', 'ground', 'tracon', 'everything'] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const PRESET_LABEL: Record<PresetId, string> = { 'tower-cab': 'Tower cab', ground: 'Ground', tracon: 'TRACON', everything: 'Everything' };

const g = (tabs: PanelId[], active: PanelId = tabs[0]): PanelGroup => ({ tabs, active });

export function presetRegions(id: PresetId): Regions {
  switch (id) {
    case 'tower-cab':
      return { main: [g(['tower', 'surface', 'radar'])], right: [g(['strips', 'list']), g(['details'])], bottom: [g(['radio', 'landline'])] };
    case 'ground':
      return { main: [g(['surface', 'radar', 'tower'])], right: [g(['list', 'strips'])], bottom: [g(['comms', 'alerts', 'landline']), g(['radio'])] };
    case 'tracon':
      return { main: [g(['radar', 'surface', 'tower'])], right: [g(['strips', 'list']), g(['details'])], bottom: [g(['radio', 'landline'])] };
    case 'everything':
    default:
      return { main: [g(['surface', 'radar', 'tower'])], right: [g(['list', 'strips']), g(['details'])], bottom: [g(['comms', 'alerts', 'landline']), g(['radio'])] };
  }
}

export function presetLayout(id: PresetId): LayoutState {
  return { version: LAYOUT_VERSION, regions: presetRegions(id), sizes: { ...DEFAULT_SIZES }, popouts: {} };
}

export const defaultLayout = (): LayoutState => presetLayout('everything');

export interface Placement { region: RegionId; group: number; index: number }

export function placements(l: LayoutState): Map<PanelId, Placement> {
  const out = new Map<PanelId, Placement>();
  for (const region of REGION_IDS) {
    l.regions[region].forEach((grp, group) => grp.tabs.forEach((id, index) => out.set(id, { region, group, index })));
  }
  return out;
}

export const isDocked = (l: LayoutState, id: PanelId) => placements(l).has(id);
export const isPopped = (l: LayoutState, id: PanelId) => !!l.popouts[id];

export function dockedPanels(l: LayoutState): PanelId[] {
  return [...placements(l).keys()];
}

/** Panels that are neither in a region nor in a window. */
export function hiddenPanels(l: LayoutState): PanelId[] {
  const docked = placements(l);
  return PANEL_IDS.filter((id) => !docked.has(id) && !l.popouts[id]);
}

function clone(l: LayoutState): LayoutState {
  return {
    ...l,
    regions: { main: l.regions.main.map(cloneGroup), right: l.regions.right.map(cloneGroup), bottom: l.regions.bottom.map(cloneGroup) },
    sizes: { ...l.sizes },
    popouts: { ...l.popouts },
  };
}
const cloneGroup = (grp: PanelGroup): PanelGroup => ({ tabs: [...grp.tabs], active: grp.active });

function normalize(l: LayoutState): LayoutState {
  for (const region of REGION_IDS) {
    l.regions[region] = l.regions[region]
      .map((grp) => ({ tabs: grp.tabs, active: grp.tabs.includes(grp.active) ? grp.active : grp.tabs[0] }))
      .filter((grp) => grp.tabs.length > 0);
  }
  return l;
}

function removeFromRegions(l: LayoutState, id: PanelId) {
  for (const region of REGION_IDS) for (const grp of l.regions[region]) grp.tabs = grp.tabs.filter((t) => t !== id);
}

function insert(l: LayoutState, id: PanelId, region: RegionId, makeActive = true) {
  const groups = l.regions[region];
  if (groups.length === 0) groups.push({ tabs: [id], active: id });
  else {
    const grp = groups[0];
    grp.tabs.push(id);
    if (makeActive) grp.active = id;
  }
}

/** Where a panel goes when it is shown without a stated region. */
export const HOME_REGION: Record<PanelId, RegionId> = {
  surface: 'main', radar: 'main', tower: 'main',
  list: 'right', strips: 'right', details: 'right',
  comms: 'bottom', alerts: 'bottom', landline: 'bottom', radio: 'bottom',
  charts: 'main', navaids: 'right', atis: 'right', weather: 'right', settings: 'right',
};

export function movePanel(l: LayoutState, id: PanelId, region: RegionId): LayoutState {
  const next = clone(l);
  const cur = placements(next).get(id);
  if (cur?.region === region) return l;
  removeFromRegions(next, id);
  insert(next, id, region);
  delete next.popouts[id];
  return normalize(next);
}

export function hidePanel(l: LayoutState, id: PanelId): LayoutState {
  const next = clone(l);
  removeFromRegions(next, id);
  delete next.popouts[id];
  return normalize(next);
}

/** Show a panel (activate it if it is already docked). */
export function showPanel(l: LayoutState, id: PanelId, region?: RegionId): LayoutState {
  if (l.popouts[id] && !isDocked(l, id)) return l;
  if (isDocked(l, id)) return activatePanel(l, id);
  const next = clone(l);
  insert(next, id, region ?? HOME_REGION[id]);
  return normalize(next);
}

export function activatePanel(l: LayoutState, id: PanelId): LayoutState {
  const at = placements(l).get(id);
  if (!at) return l;
  if (l.regions[at.region][at.group].active === id) return l;
  const next = clone(l);
  next.regions[at.region][at.group].active = id;
  return next;
}

export function togglePanel(l: LayoutState, id: PanelId): LayoutState {
  return isDocked(l, id) || isPopped(l, id) ? hidePanel(l, id) : showPanel(l, id);
}

/** The panel leaves its region for its own window. `geom` is the window geometry to remember. */
export function popOutPanel(l: LayoutState, id: PanelId, geom: PopGeometry): LayoutState {
  const next = clone(l);
  const region = placements(next).get(id)?.region ?? l.popouts[id]?.region ?? HOME_REGION[id];
  removeFromRegions(next, id);
  next.popouts[id] = { ...geom, region };
  return normalize(next);
}

/**
 * The panel returns from its window to the region it came from. With `keepRecord` the geometry stays remembered so the
 * "Reopen windows" button can offer it again (the main window is going away, or the session ended); otherwise the user closed it.
 */
export function popInPanel(l: LayoutState, id: PanelId, keepRecord = false): LayoutState {
  const rec = l.popouts[id];
  const next = clone(l);
  if (!isDocked(next, id) && rec) insert(next, id, rec.region);
  if (!keepRecord) delete next.popouts[id];
  return normalize(next);
}

export function setPopGeometry(l: LayoutState, id: PanelId, geom: PopGeometry): LayoutState {
  const rec = l.popouts[id];
  if (!rec || (rec.x === geom.x && rec.y === geom.y && rec.w === geom.w && rec.h === geom.h)) return l;
  return { ...l, popouts: { ...l.popouts, [id]: { ...rec, ...geom } } };
}

export function clampSize(kind: keyof LayoutSizes, v: number): number {
  const [lo, hi] = SIZE_LIMITS[kind];
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

export function setSize(l: LayoutState, kind: keyof LayoutSizes, v: number): LayoutState {
  return { ...l, sizes: { ...l.sizes, [kind]: clampSize(kind, v) } };
}

/** Make sure the main region always shows at least one display; used when everything was hidden. */
export function ensureDisplay(l: LayoutState): LayoutState {
  const shown = (['surface', 'radar', 'tower'] as const).some((id) => isDocked(l, id) || isPopped(l, id));
  return shown ? l : showPanel(l, 'surface', 'main');
}

// ---- persistence -----------------------------------------------------------------------------------------------------

export const LAYOUT_STORAGE_KEY = 'kacy.layout.v1';

const isPanelId = (v: unknown): v is PanelId => typeof v === 'string' && (PANEL_IDS as readonly string[]).includes(v);
const isRegionId = (v: unknown): v is RegionId => typeof v === 'string' && (REGION_IDS as readonly string[]).includes(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function serializeLayout(l: LayoutState): string {
  return JSON.stringify(l);
}

/** Validate untrusted JSON. Anything unusable gives the default layout; unknown panels are dropped; a panel appears at most once. */
export function parseLayout(raw: string | null | undefined): LayoutState {
  if (!raw) return defaultLayout();
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return defaultLayout(); }
  const d = data as Partial<LayoutState> | null;
  if (!d || typeof d !== 'object' || d.version !== LAYOUT_VERSION || !d.regions || typeof d.regions !== 'object') return defaultLayout();
  const seen = new Set<PanelId>();
  const regions = { main: [], right: [], bottom: [] } as Regions;
  for (const region of REGION_IDS) {
    const groups = (d.regions as Record<string, unknown>)[region];
    if (!Array.isArray(groups)) continue;
    for (const raw of groups) {
      const tabsRaw = (raw as { tabs?: unknown })?.tabs;
      if (!Array.isArray(tabsRaw)) continue;
      const tabs = tabsRaw.filter(isPanelId).filter((id) => !seen.has(id) && (seen.add(id), true));
      if (!tabs.length) continue;
      const active = (raw as { active?: unknown }).active;
      regions[region].push({ tabs, active: isPanelId(active) && tabs.includes(active) ? active : tabs[0] });
    }
  }
  const popouts: LayoutState['popouts'] = {};
  const po = d.popouts as Record<string, Partial<PopRecord>> | undefined;
  if (po && typeof po === 'object') {
    for (const [k, v] of Object.entries(po)) {
      if (!isPanelId(k) || !v || !num(v.x) || !num(v.y) || !num(v.w) || !num(v.h)) continue;
      popouts[k] = { x: v.x, y: v.y, w: Math.max(240, v.w), h: Math.max(160, v.h), region: isRegionId(v.region) ? v.region : HOME_REGION[k] };
    }
  }
  const sizes: LayoutSizes = {
    rightW: num(d.sizes?.rightW) ? clampSize('rightW', d.sizes!.rightW) : DEFAULT_SIZES.rightW,
    bottomH: num(d.sizes?.bottomH) ? clampSize('bottomH', d.sizes!.bottomH) : DEFAULT_SIZES.bottomH,
  };
  let layout: LayoutState = { version: LAYOUT_VERSION, regions, sizes, popouts };
  // A panel that was in a window when the page closed is docked again (browsers will not reopen windows by themselves);
  // its record stays so "Reopen windows" can offer it.
  for (const id of Object.keys(popouts) as PanelId[]) layout = popInPanel(layout, id, true);
  return ensureDisplay(layout);
}
