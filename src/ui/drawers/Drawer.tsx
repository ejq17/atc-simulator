import { useEffect } from 'react';
import type { ReactNode } from 'react';

export function Drawer({ title, onClose, children, side = 'right', width = 'min(520px,94vw)', testId }: { title: string; onClose: () => void; children: ReactNode; side?: 'right' | 'center'; width?: string; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const center = side === 'center';
  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="false" aria-label={title} data-testid={testId}>
      <button type="button" aria-label="Close panel" className="absolute inset-0 cursor-default bg-black/55" onClick={onClose} tabIndex={-1} />
      <div
        className={`relative z-10 flex min-h-0 flex-col border border-atc-border bg-atc-panel shadow-2xl shadow-black ${center ? 'm-auto h-[88vh]' : 'ml-auto h-full border-y-0 border-r-0'}`}
        style={{ width }}
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-atc-border bg-atc-panel-2 px-4">
          <h2 className="font-sans text-[12px] font-semibold uppercase tracking-[0.2em] text-atc-text">{title}</h2>
          <button type="button" onClick={onClose} aria-label={`Close ${title}`} className="h-6 w-6 border border-atc-border text-atc-muted hover:border-atc-cyan hover:text-atc-cyan">×</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
