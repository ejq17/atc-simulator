import type { ButtonHTMLAttributes, ReactNode } from 'react';

export const LABEL = 'font-sans text-[10px] uppercase tracking-[0.16em] text-atc-muted';

export function PanelHeader({ title, right, count }: { title: string; right?: ReactNode; count?: number | string }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-atc-border bg-atc-panel-2 px-3">
      <div className="flex items-center gap-2">
        <span className="font-sans text-[10.5px] font-semibold uppercase tracking-[0.18em] text-atc-text">{title}</span>
        {count !== undefined && <span className="border border-atc-border px-1 text-[10px] leading-4 text-atc-muted">{count}</span>}
      </div>
      {right}
    </div>
  );
}

export function Panel({ title, right, count, children, className = '' }: { title: string; right?: ReactNode; count?: number | string; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-h-0 flex-col border border-atc-border bg-atc-panel ${className}`}>
      <PanelHeader title={title} right={right} count={count} />
      {children}
    </section>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'cyan' | 'amber' | 'red' | 'green'; active?: boolean; size?: 'xs' | 'sm' | 'md' };

const TONES = {
  default: 'border-atc-border text-atc-text hover:border-atc-muted hover:bg-atc-panel-2',
  cyan: 'border-atc-cyan/60 text-atc-cyan hover:bg-atc-cyan/10',
  amber: 'border-atc-amber/60 text-atc-amber hover:bg-atc-amber/10',
  red: 'border-atc-red/70 text-atc-red hover:bg-atc-red/10',
  green: 'border-atc-green-dim text-atc-green hover:bg-atc-green/10',
} as const;

export function Btn({ tone = 'default', active, size = 'sm', className = '', ...rest }: BtnProps) {
  const sz = size === 'xs' ? 'h-6 px-1.5 text-[10px]' : size === 'sm' ? 'h-7 px-2.5 text-[11px]' : 'h-9 px-4 text-xs';
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 border font-sans font-medium uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${sz} ${TONES[tone]} ${active ? 'bg-atc-cyan/15 !border-atc-cyan !text-atc-cyan' : 'bg-atc-bg'} ${className}`}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="border border-atc-border bg-atc-bg px-1 font-mono text-[10px] leading-4 text-atc-text">{children}</kbd>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {children}
      {hint && <span className="text-[10.5px] leading-snug text-atc-muted">{hint}</span>}
    </label>
  );
}

export const INPUT = 'h-8 w-full border border-atc-border bg-atc-bg px-2 text-xs text-atc-text placeholder:text-atc-muted/70 focus:border-atc-cyan focus:outline-none';
export const SELECT = `${INPUT} appearance-none pr-6`;

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-4 w-8 shrink-0 border transition-colors ${checked ? 'border-atc-cyan bg-atc-cyan/25' : 'border-atc-border bg-atc-bg'}`}
      >
        <span className={`absolute top-0.5 h-2.5 w-2.5 transition-all ${checked ? 'left-[18px] bg-atc-cyan' : 'left-0.5 bg-atc-muted'}`} />
      </button>
      <span className="flex flex-col">
        <span className="text-xs text-atc-text">{label}</span>
        {hint && <span className="text-[10.5px] leading-snug text-atc-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2 w-2 shrink-0" style={{ background: color }} />;
}

export function Segmented<T extends string | number>({ value, options, onChange, size = 'sm' }: { value: T; options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[]; onChange: (v: T) => void; size?: 'xs' | 'sm' }) {
  return (
    <div className="inline-flex border border-atc-border" role="group">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          disabled={o.disabled}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`${size === 'xs' ? 'h-6 px-2 text-[10px]' : 'h-7 px-3 text-[11px]'} border-r border-atc-border font-sans font-medium uppercase tracking-wider last:border-r-0 disabled:opacity-35 ${o.value === value ? 'bg-atc-cyan/15 text-atc-cyan' : 'bg-atc-bg text-atc-muted hover:text-atc-text'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
