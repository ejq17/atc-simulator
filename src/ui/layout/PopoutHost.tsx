import { createPortal } from 'react-dom';
import { useLayoutStore } from '../store/layoutStore';
import { PopoutFrame } from './GroupView';
import type { PanelId } from './layoutModel';

/**
 * Renders every popped-out panel into its own window through a React portal, so the pop-outs share this tree's
 * context and the same zustand stores as the main window (no message passing, no second copy of the simulation).
 */
export function PopoutHost() {
  const windows = useLayoutStore((s) => s.windows);
  return (
    <>
      {(Object.keys(windows) as PanelId[]).map((id) => {
        const ref = windows[id]!;
        return createPortal(<PopoutFrame id={id} />, ref.root, id);
      })}
    </>
  );
}
