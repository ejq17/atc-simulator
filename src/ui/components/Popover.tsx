import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * A button with a dropdown. Closes on an outside press or Escape, in whichever window the button lives in (main or a pop-out).
 */
export function Popover({ label, children, buttonClass = '', align = 'right', testId, title, panelClass = '' }: {
  label: ReactNode; children: (close: () => void) => ReactNode; buttonClass?: string; align?: 'left' | 'right'; testId?: string; title?: string; panelClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const doc = ref.current?.ownerDocument ?? document;
    const away = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    doc.addEventListener('pointerdown', away, true);
    doc.addEventListener('keydown', esc, true);
    return () => {
      doc.removeEventListener('pointerdown', away, true);
      doc.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} data-testid={testId} title={title} onClick={() => setOpen((o) => !o)} className={buttonClass}>
        {label}
      </button>
      {open && (
        <div role="menu" className={`absolute top-full z-50 mt-1 max-h-[80dvh] min-w-[11rem] max-w-[92vw] overflow-y-auto border border-atc-border bg-atc-panel shadow-xl shadow-black/70 ${align === 'right' ? 'right-0' : 'left-0'} ${panelClass}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, active, disabled, testId }: { children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left font-sans text-[11px] uppercase tracking-wider hover:bg-atc-panel-2 disabled:opacity-40 ${active ? 'text-atc-cyan' : 'text-atc-text'}`}
    >
      {children}
    </button>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="border-t border-atc-border/70 px-3 pb-1 pt-2 font-sans text-[9.5px] uppercase tracking-[0.2em] text-atc-muted first:border-t-0">{children}</div>;
}
