import { useLayoutStore } from '../store/layoutStore';
import { Btn } from '../components/ui';
import { useCompact } from './useMedia';
import { metaOf } from './panelMeta';
import type { PanelId } from './layoutModel';

/** Popup blocker notice and the "Reopen windows" offer (browsers will not open windows without a click). */
export function PopupNotices() {
  const blocked = useLayoutStore((s) => s.popupBlocked);
  const dismissBlocked = useLayoutStore((s) => s.dismissBlocked);
  const popouts = useLayoutStore((s) => s.layout.popouts);
  const windows = useLayoutStore((s) => s.windows);
  const reopenAll = useLayoutStore((s) => s.reopenAll);
  const dismissReopen = useLayoutStore((s) => s.dismissReopen);
  const compact = useCompact();
  const pending = (Object.keys(popouts) as PanelId[]).filter((id) => !windows[id]);
  return (
    <>
      {blocked && (
        <div role="alert" data-testid="popup-blocked" className="flex items-start justify-between gap-3 border-b border-atc-amber/60 bg-atc-amber/10 px-3 py-1.5 text-xs text-atc-amber">
          <span>The browser blocked the pop-up window. Allow pop-ups for this site (look for the blocked-pop-up icon in the address bar), then pop the panel out again. The panel stays in the main window until then.</span>
          <button type="button" onClick={dismissBlocked} aria-label="Dismiss" className="shrink-0 px-2">×</button>
        </div>
      )}
      {!compact && pending.length > 0 && (
        <div data-testid="reopen-notice" className="flex flex-wrap items-center justify-between gap-2 border-b border-atc-cyan/40 bg-atc-cyan/5 px-3 py-1 text-xs text-atc-text">
          <span>{pending.length === 1 ? '1 window' : `${pending.length} windows`} ({pending.map((id) => metaOf(id).title).join(', ')}) {pending.length === 1 ? 'was' : 'were'} open last time.</span>
          <span className="flex gap-2">
            <Btn size="xs" tone="cyan" data-testid="reopen-windows" onClick={() => reopenAll()}>Reopen windows</Btn>
            <Btn size="xs" onClick={dismissReopen}>Dismiss</Btn>
          </span>
        </div>
      )}
    </>
  );
}
