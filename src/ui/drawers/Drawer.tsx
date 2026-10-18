import type { ReactNode } from 'react';
import { addWindowListener } from '../layout/windows';
import { useEffect } from 'react';
import type { PanelId } from '../layout/layoutModel';
import { useLayoutStore } from '../store/layoutStore';
import { useUiStore } from '../store/uiStore';

/**
 * A panel shown as an overlay (the default for Charts, Navaids, ATIS, Weather and Settings). `panel` adds a "pop out" button that
 * moves it into its own window; the drawer closes when it does.
 */
export function Drawer({ title, onClose, children, side = 'right', width = 'min(520px,94vw)', testId, panel }: { title: string; onClose: () => void; children: ReactNode; side?: 'right' | 'center'; width?: string; testId?: string; panel?: PanelId }) {
  useEffect(() => {
    return addWindowListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }, true);
  }, [onClose]);
  const center = side === 'center';
  const popOut = () => {
    if (!panel) return;
    if (useLayoutStore.getState().popOut(panel)) useUiStore.getState().setDrawer(null);
  };
  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="false" aria-label={title} data-testid={testId}>
      <button type="button" aria-label="Close panel" className="absolute inset-0 cursor-default bg-black/55" onClick={onClose} tabIndex={-1} />
      <div
        className={`relative z-10 flex min-h-0 max-w-full flex-col border border-atc-border bg-atc-panel shadow-2xl shadow-black ${center ? 'm-auto h-[88dvh]' : 'ml-auto h-full border-y-0 border-r-0'}`}
        style={{ width }}
      >
        <div className="atc-titlebar flex h-10 shrink-0 items-center justify-between gap-2 px-3 sm:px-4">
          <h2 className="atc-title min-w-0 truncate !text-[12px] !tracking-[0.2em]">{title}</h2>
          <div className="flex shrink-0 items-center gap-1.5">
            {panel && (
              <button type="button" onClick={popOut} data-testid={`drawer-popout-${panel}`} title="Open in its own window" aria-label={`Pop out ${title}`} className="atc-iconbtn">⧉</button>
            )}
            <button type="button" onClick={onClose} aria-label={`Close ${title}`} className="atc-iconbtn">×</button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
