import { useState } from 'react';
import { TRAINING_DISCLAIMER } from '../../game';
import { useSimStore } from '../store/simStore';
import { Btn } from './ui';

const LEVEL = {
  info: 'border-atc-cyan/50 bg-atc-cyan/10 text-atc-cyan',
  warn: 'border-atc-amber/60 bg-atc-amber/10 text-atc-amber',
  error: 'border-atc-red/70 bg-atc-red/10 text-atc-red',
} as const;

export function NoticeBar() {
  const notices = useSimStore((s) => s.notices);
  const dismiss = useSimStore((s) => s.dismissNotice);
  const complete = useSimStore((s) => s.scenarioComplete);
  const end = useSimStore((s) => s.endSession);
  if (notices.length === 0 && !complete) return null;
  return (
    <div className="flex shrink-0 flex-col" data-testid="notices">
      {complete && (
        <div className="flex items-center justify-between gap-3 border-b border-atc-green-dim bg-atc-green/10 px-4 py-1.5 text-xs text-atc-green">
          <span>Scenario complete. You can keep controlling traffic, or end the session to see your debrief.</span>
          <Btn tone="green" onClick={end}>View debrief</Btn>
        </div>
      )}
      {notices.map((n) => (
        <div key={n.id} role="alert" className={`flex items-center justify-between gap-3 border-b px-4 py-1.5 text-xs ${LEVEL[n.level]}`}>
          <span>{n.text}</span>
          <button type="button" onClick={() => dismiss(n.id)} aria-label="Dismiss notice" className="px-1 text-base leading-none hover:text-atc-text">×</button>
        </div>
      ))}
    </div>
  );
}

export function TrainingBanner() {
  const step = useSimStore((s) => s.training);
  const [open, setOpen] = useState(false);
  if (!step) return null;
  const tone = step.status === 'error' ? 'border-atc-red/70' : step.status === 'done' ? 'border-atc-green-dim' : 'border-atc-cyan/60';
  return (
    <div className={`flex shrink-0 items-start gap-4 border-b bg-atc-panel-2 px-4 py-1.5 ${tone}`} data-testid="training-banner">
      <div className="shrink-0 pt-0.5 font-sans text-[10px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Training {step.index + 1}/{step.total}</div>
      <div className="min-w-0 flex-1 text-xs leading-snug">
        <div className={`font-semibold text-atc-text ${open ? '' : 'line-clamp-2'}`}>{step.prompt}</div>
        {open && <div className="mt-1 whitespace-pre-line text-atc-muted">{step.explanation}{step.reference ? ` (${step.reference})` : ''}</div>}
        {step.lastFeedback && <div className={`${open ? '' : 'line-clamp-1'} ${step.status === 'error' ? 'text-atc-red' : 'text-atc-green'}`}>{step.lastFeedback}</div>}
        <div className={`mt-0.5 text-[10.5px] italic text-atc-muted ${open ? '' : 'truncate'}`} data-testid="training-disclaimer">{TRAINING_DISCLAIMER}</div>
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="shrink-0 pt-0.5 font-sans text-[10px] uppercase tracking-wider text-atc-muted hover:text-atc-cyan">
        {open ? 'Less' : 'Why?'}
      </button>
    </div>
  );
}
