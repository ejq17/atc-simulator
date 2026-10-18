import { useSimStore } from '../store/simStore';
import { useLayoutStore } from '../store/layoutStore';
import { Popover, MenuHeading, MenuItem } from '../components/Popover';
import { PanelFrameContext } from '../components/ui';
import { PANEL_COMPONENTS, PANEL_HINT } from './panelRegistry';
import { REGION_IDS, REGION_LABEL } from './layoutModel';
import type { PanelGroup, PanelId, RegionId } from './layoutModel';
import { metaOf } from './panelMeta';

/** Number of open conflicts; shown on the Alerts tab so a hidden alerts panel still announces itself. */
export function useAlertCount(): { count: number; critical: boolean } {
  const conflicts = useSimStore((s) => s.session?.engine.getState().conflicts);
  useSimStore((s) => s.rev);
  return { count: conflicts?.length ?? 0, critical: !!conflicts?.some((c) => c.severity === 'critical') };
}

export function TabLabel({ id }: { id: PanelId }) {
  const alerts = useAlertCount();
  const title = metaOf(id).title;
  const key = id === 'surface' ? '1' : id === 'radar' ? '2' : id === 'tower' ? '3' : undefined;
  return (
    <>
      {title}
      {key && <span className="ml-1 hidden opacity-50 xl:inline">{key}</span>}
      {id === 'alerts' && alerts.count > 0 && (
        <span className={`ml-1.5 inline-block min-w-4 px-1 text-center text-[9.5px] leading-4 ${alerts.critical ? 'atc-blink bg-atc-red text-atc-bg' : 'bg-atc-amber text-atc-bg'}`}>{alerts.count}</span>
      )}
    </>
  );
}

/** The tab strip + body used by docked groups and by the phone layout. `actions` goes at the right of the title bar. */
export function TabbedPanels({ tabs, active, onSelect, actions, testIdPrefix = 'tab', hint = true, bodyClass = '', collapsed = false }: {
  tabs: PanelId[]; active: PanelId; onSelect(id: PanelId): void; actions?: React.ReactNode; testIdPrefix?: string; hint?: boolean; bodyClass?: string; collapsed?: boolean;
}) {
  const Body = PANEL_COMPONENTS[active];
  const hintText = hint ? PANEL_HINT[active] : undefined;
  return (
    <div className="atc-frame flex min-h-0 min-w-0 flex-1 flex-col" data-panel={active}>
      <div className="atc-titlebar flex h-8 shrink-0 items-stretch justify-between gap-1 pl-0 pr-1">
        <div role="tablist" className="no-scrollbar flex min-w-0 items-stretch overflow-x-auto">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === active}
              data-testid={`${testIdPrefix}-${id}`}
              onClick={() => onSelect(id)}
              className={`atc-tab ${id === active ? 'atc-tab-on' : ''}`}
            >
              <TabLabel id={id} />
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pl-1">
          {hintText && <span className="hidden max-w-[34ch] truncate font-sans text-[10px] uppercase tracking-wider text-atc-muted min-[1500px]:inline">{hintText}</span>}
          {actions}
        </div>
      </div>
      {!collapsed && (
        <PanelFrameContext.Provider value>
          <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${bodyClass}`} data-testid={`panel-${active}`}>
            <Body key={active} />
          </div>
        </PanelFrameContext.Provider>
      )}
    </div>
  );
}

/** Pop out and "more" menu for one panel. */
export function PanelActions({ id, region }: { id: PanelId; region?: RegionId }) {
  const popOut = useLayoutStore((s) => s.popOut);
  const move = useLayoutStore((s) => s.movePanel);
  const hide = useLayoutStore((s) => s.hidePanel);
  return (
    <>
      <button type="button" className="atc-iconbtn" data-testid={`popout-${id}`} title={`Pop ${metaOf(id).title} out to its own window`} aria-label={`Pop out ${metaOf(id).title}`} onClick={() => popOut(id)}>⧉</button>
      <Popover label="⋯" buttonClass="atc-iconbtn" testId={`panel-menu-${id}`} title="Move or hide this panel">
        {(close) => (
          <>
            <MenuHeading>{metaOf(id).title}</MenuHeading>
            {REGION_IDS.filter((r) => r !== region).map((r) => (
              <MenuItem key={r} testId={`move-${id}-${r}`} onClick={() => { move(id, r); close(); }}>Move to {REGION_LABEL[r].toLowerCase()}</MenuItem>
            ))}
            <MenuItem onClick={() => { popOut(id); close(); }}>Pop out to a window</MenuItem>
            <MenuItem testId={`hide-${id}`} onClick={() => { hide(id); close(); }}>Hide panel</MenuItem>
          </>
        )}
      </Popover>
    </>
  );
}

export function GroupView({ group, region, collapse }: { group: PanelGroup; region: RegionId; collapse?: { open: boolean; onToggle(): void } }) {
  const activate = useLayoutStore((s) => s.activate);
  const callsign = useSimStore((s) => {
    const st = s.session?.engine.getState();
    const id = st?.selectedAircraftId;
    return id && st ? st.aircraft[id]?.callsign : undefined;
  });
  return (
    <TabbedPanels
      tabs={group.tabs}
      active={group.active}
      onSelect={activate}
      collapsed={collapse ? !collapse.open : false}
      actions={
        <>
          {collapse && (
            <button type="button" data-testid="details-toggle" aria-expanded={collapse.open} onClick={collapse.onToggle} className="atc-iconbtn !w-auto gap-1 px-2" title="Show or hide the selected aircraft's details">
              {callsign ?? 'none'} {collapse.open ? '▾' : '▸'}
            </button>
          )}
          <PanelActions id={group.active} region={region} />
        </>
      }
    />
  );
}

/** The content of a pop-out window: a slim title bar with "Dock" and the panel, full height. */
export function PopoutFrame({ id }: { id: PanelId }) {
  const popIn = useLayoutStore((s) => s.popIn);
  const Body = PANEL_COMPONENTS[id];
  return (
    <div className="atc-frame flex h-full w-full min-w-0 flex-col bg-atc-bg text-atc-text" data-testid={`popout-frame-${id}`}>
      <div className="atc-titlebar flex h-8 shrink-0 items-center justify-between gap-2 px-3">
        <span className="atc-title truncate">{metaOf(id).title}</span>
        <button type="button" className="atc-iconbtn !w-auto px-2" data-testid={`dock-${id}`} onClick={() => popIn(id)} title="Return this panel to the main window">Dock</button>
      </div>
      <PanelFrameContext.Provider value>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid={`panel-${id}`}>
          <Body />
        </div>
      </PanelFrameContext.Provider>
    </div>
  );
}
