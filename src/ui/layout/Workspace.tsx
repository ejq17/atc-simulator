import { useRef } from 'react';
import type { CSSProperties, PointerEvent as RPointerEvent } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import { useUiStore } from '../store/uiStore';
import { GroupView } from './GroupView';
import { DEFAULT_SIZES } from './layoutModel';
import type { PanelGroup, RegionId } from './layoutModel';
import { metaOf } from './panelMeta';

/** Drag handle between two regions. Double-click restores the default size. */
function Splitter({ axis, onDrag, onReset, label }: { axis: 'x' | 'y'; onDrag(delta: number): void; onReset(): void; label: string }) {
  const start = useRef<number | null>(null);
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    start.current = axis === 'x' ? e.clientX : e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    const now = axis === 'x' ? e.clientX : e.clientY;
    onDrag(now - start.current);
    start.current = now;
  };
  const up = () => { start.current = null; };
  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title="Drag to resize · double-click to reset"
      data-testid={`splitter-${axis === 'x' ? 'right' : 'bottom'}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onReset}
      className={`atc-splitter touch-none ${axis === 'x' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'}`}
    />
  );
}

function groupStyle(region: RegionId, group: PanelGroup, rightW: number): CSSProperties {
  const min = metaOf(group.active).min;
  if (region !== 'bottom') return {};
  // Side by side: the radio panel keeps the width of the right column, everything else shares the rest.
  return group.tabs.includes('radio') ? { flex: `0 0 ${rightW}px`, maxWidth: '50%', minWidth: min.w } : { flex: '1 1 0', minWidth: min.w };
}

/** The desktop layout: main display, right column, bottom row, each hosting its groups of tabbed panels. */
export function Workspace() {
  const layout = useLayoutStore((s) => s.layout);
  const setSize = useLayoutStore((s) => s.setSize);
  const detailsOpen = useUiStore((s) => s.stripDetailsOpen);
  const setDetailsOpen = useUiStore((s) => s.setStripDetailsOpen);
  const { main, right, bottom } = layout.regions;
  const { rightW, bottomH } = layout.sizes;
  const hasMain = main.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace">
      <div className="flex min-h-0 flex-1">
        {hasMain && (
          <div className="flex min-w-0 flex-1 flex-col" data-testid="display-area">
            {main.map((g, i) => (
              <div key={i} className="flex min-h-0 flex-1">
                <GroupView group={g} region="main" />
              </div>
            ))}
          </div>
        )}
        {right.length > 0 && hasMain && (
          <Splitter axis="x" label="Resize right column" onDrag={(d) => setSize('rightW', rightW - d)} onReset={() => setSize('rightW', DEFAULT_SIZES.rightW)} />
        )}
        {right.length > 0 && (
          <aside
            className={`flex min-h-0 flex-col border-l border-atc-border ${hasMain ? 'shrink-0' : 'min-w-0 flex-1'}`}
            style={hasMain ? { width: rightW, maxWidth: '60%', minWidth: 260 } : undefined}
            data-testid="right-column"
          >
            {right.map((g, i) => {
              // Aircraft details under the strip board start collapsed so the board gets the column (as before).
              const collapsible = i > 0 && g.active === 'details' && right[i - 1].active === 'strips';
              const open = !collapsible || detailsOpen;
              return (
                <div
                  key={i}
                  className={`flex min-h-0 flex-col ${i === 0 ? 'flex-1' : 'shrink-0 border-t border-atc-border'}`}
                  style={i > 0 && open ? { maxHeight: collapsible ? '34%' : '48%' } : undefined}
                >
                  <GroupView group={g} region="right" collapse={collapsible ? { open, onToggle: () => setDetailsOpen(!detailsOpen) } : undefined} />
                </div>
              );
            })}
          </aside>
        )}
      </div>
      {bottom.length > 0 && (
        <>
          <Splitter axis="y" label="Resize bottom row" onDrag={(d) => setSize('bottomH', bottomH - d)} onReset={() => setSize('bottomH', DEFAULT_SIZES.bottomH)} />
          <div className="flex shrink-0 border-t border-atc-border" style={{ height: bottomH, maxHeight: '55%' }} data-testid="bottom-row">
            {bottom.map((g, i) => (
              <div key={i} className={`flex min-h-0 min-w-0 ${i > 0 ? 'border-l border-atc-border' : ''}`} style={groupStyle('bottom', g, rightW)}>
                <GroupView group={g} region="bottom" />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
