import { useLayoutStore } from '../store/layoutStore';
import { Popover, MenuHeading, MenuItem } from '../components/Popover';
import { PANEL_IDS, PRESET_IDS, PRESET_LABEL, REGION_IDS, REGION_LABEL, placements } from './layoutModel';
import type { PanelId, RegionId } from './layoutModel';
import { metaOf } from './panelMeta';

const SEL = 'h-6 border border-atc-border bg-atc-bg px-1 font-sans text-[10px] uppercase tracking-wider text-atc-text';

/** Top bar "Layout" menu: presets, per-panel show / hide / region / pop-out, reopen windows, reset. */
export function LayoutMenu() {
  const layout = useLayoutStore((s) => s.layout);
  const windows = useLayoutStore((s) => s.windows);
  const applyPreset = useLayoutStore((s) => s.applyPreset);
  const reset = useLayoutStore((s) => s.reset);
  const toggle = useLayoutStore((s) => s.togglePanel);
  const move = useLayoutStore((s) => s.movePanel);
  const showPanel = useLayoutStore((s) => s.showPanel);
  const popOut = useLayoutStore((s) => s.popOut);
  const popIn = useLayoutStore((s) => s.popIn);
  const reopenAll = useLayoutStore((s) => s.reopenAll);
  const closeAll = useLayoutStore((s) => s.closeAllPopouts);
  const at = placements(layout);
  const pending = (Object.keys(layout.popouts) as PanelId[]).filter((id) => !windows[id]);
  const open = Object.keys(windows).length;
  return (
    <Popover
      label={<>Layout <span className="text-atc-muted">▾</span></>}
      testId="layout-menu"
      buttonClass="inline-flex h-7 shrink-0 items-center gap-1 border border-atc-border bg-atc-bg px-2.5 font-sans text-[11px] font-medium uppercase tracking-wider text-atc-text hover:border-atc-muted"
      panelClass="w-[19rem]"
    >
      {(close) => (
        <>
          <MenuHeading>Presets</MenuHeading>
          {PRESET_IDS.map((p) => (
            <MenuItem key={p} testId={`preset-${p}`} onClick={() => { applyPreset(p); close(); }}>{PRESET_LABEL[p]}</MenuItem>
          ))}
          <MenuHeading>Panels</MenuHeading>
          <ul>
            {PANEL_IDS.map((id) => {
              const place = at.get(id);
              const popped = !!windows[id];
              const shown = !!place || popped;
              const region: RegionId | '' = popped ? '' : place?.region ?? '';
              return (
                <li key={id} className="flex items-center gap-2 px-3 py-1" data-testid={`layout-row-${id}`}>
                  <input type="checkbox" className="accent-[#39c5e8]" checked={shown} onChange={() => toggle(id)} aria-label={`Show ${metaOf(id).title}`} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px]">{metaOf(id).title}</span>
                  {popped ? (
                    <button type="button" className={SEL} onClick={() => popIn(id)}>Dock</button>
                  ) : (
                    <select
                      className={SEL}
                      aria-label={`Region of ${metaOf(id).title}`}
                      value={region}
                      onChange={(e) => { const r = e.target.value as RegionId; if (shown) move(id, r); else showPanel(id, r); }}
                    >
                      {!shown && <option value="">hidden</option>}
                      {REGION_IDS.map((r) => (<option key={r} value={r}>{REGION_LABEL[r]}</option>))}
                    </select>
                  )}
                  <button type="button" className={SEL} title="Open in its own window" aria-label={`Pop out ${metaOf(id).title}`} disabled={popped} onClick={() => { popOut(id); close(); }}>⧉</button>
                </li>
              );
            })}
          </ul>
          <MenuHeading>Windows</MenuHeading>
          <MenuItem testId="layout-reopen" disabled={pending.length === 0} onClick={() => { reopenAll(); close(); }}>
            <span>Reopen windows</span><span className="text-atc-muted">{pending.length}</span>
          </MenuItem>
          <MenuItem disabled={open === 0} onClick={() => { closeAll(false); close(); }}>
            <span>Dock all windows</span><span className="text-atc-muted">{open}</span>
          </MenuItem>
          <MenuHeading>Reset</MenuHeading>
          <MenuItem testId="layout-reset" onClick={() => { reset(); close(); }}>Reset layout</MenuItem>
        </>
      )}
    </Popover>
  );
}
