import { useState } from 'react';
import type { ReactNode } from 'react';

/** Small floating control cluster used on top of the canvases. */
export function OverlayBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`absolute z-10 flex items-center gap-1 ${className}`}>{children}</div>;
}

export const OVL_BTN =
  'ovl-btn h-7 min-w-7 border border-atc-border bg-atc-bg/85 px-2 font-sans text-[11px] font-medium uppercase tracking-wider text-atc-text backdrop-blur-sm hover:border-atc-cyan hover:text-atc-cyan';

export function LayerMenu<K extends string>({ title = 'Layers', layers, labels, onToggle }: { title?: string; layers: Record<K, boolean>; labels: Record<K, string>; onToggle: (k: K) => void }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(labels) as K[];
  return (
    <div className="relative">
      <button type="button" className={OVL_BTN} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {title} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-8 z-20 w-44 max-w-[80vw] border border-atc-border bg-atc-panel p-1.5 shadow-xl shadow-black/60">
          {keys.map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-2 px-1.5 py-1 text-[11px] text-atc-text hover:bg-atc-panel-2">
              <input type="checkbox" className="accent-[#39c5e8]" checked={layers[k]} onChange={() => onToggle(k)} aria-label={labels[k]} />
              {labels[k]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
