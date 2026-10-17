import { useMemo, useState } from 'react';
import type { DebriefReport } from '../../game';
import { useSimStore } from '../store/simStore';
import { formatElapsed } from '../lib/format';
import { Btn, LABEL, Panel, Segmented } from '../components/ui';

type Sev = 'all' | 'warning' | 'critical';
type TimelineItem = DebriefReport['timeline'][number];

const GRADE_COLOR: Record<string, string> = { A: 'text-atc-green', B: 'text-atc-green', C: 'text-atc-amber', D: 'text-atc-amber', F: 'text-atc-red' };
const SEV_COLOR = { info: 'text-atc-muted', warning: 'text-atc-amber', critical: 'text-atc-red' } as const;

export function filterTimeline(items: readonly TimelineItem[], sev: Sev): TimelineItem[] {
  if (sev === 'all') return [...items];
  if (sev === 'critical') return items.filter((i) => i.severity === 'critical');
  return items.filter((i) => i.severity === 'warning' || i.severity === 'critical');
}

function Counter({ label, value, bad }: { label: string; value: number | string; bad?: boolean }) {
  return (
    <div className="flex flex-col border border-atc-border bg-atc-bg px-3 py-2">
      <span className={LABEL}>{label}</span>
      <span className={`text-[22px] font-semibold tabular-nums ${bad ? 'text-atc-red' : 'text-atc-text'}`}>{value}</span>
    </div>
  );
}

export function DebriefScreen() {
  const report = useSimStore((s) => s.debrief);
  const events = useSimStore((s) => s.debriefEvents);
  const duration = useSimStore((s) => s.debriefDurationSec);
  const career = useSimStore((s) => s.career);
  const playAgain = useSimStore((s) => s.playAgain);
  const back = useSimStore((s) => s.backToSetup);
  const [sev, setSev] = useState<Sev>('all');
  const [picked, setPicked] = useState<number | null>(null);
  const timeline = useMemo(() => (report ? filterTimeline(report.timeline, sev) : []), [report, sev]);
  if (!report) return null;
  const sc = report.score;
  const sel = picked !== null ? timeline[picked] : undefined;
  const related = sel ? events.filter((e) => Math.abs(e.timeSec - sel.timeSec) <= 20 && (e.speaker === 'ATC' || e.speaker === 'PILOT' || e.severity !== 'info') && (!sel.callsign || e.callsign === sel.callsign || e.severity !== 'info')).slice(0, 14) : [];

  return (
    <div className="atc-grid-bg h-full overflow-y-auto" data-testid="debrief-screen">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-6 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-atc-border pb-5">
          <div>
            <div className="font-sans text-[11px] uppercase tracking-[0.3em] text-atc-cyan">Session debrief</div>
            <h1 className="mt-1 font-sans text-[28px] font-bold uppercase tracking-[0.1em]">{report.scenarioName}</h1>
            <div className="mt-1 text-xs text-atc-muted">Duration {formatElapsed(duration)} · {report.completed ? 'scenario completed' : 'ended before completion'}</div>
          </div>
          <div className="flex gap-2">
            <Btn size="md" tone="green" onClick={() => void playAgain()} data-testid="play-again">Play again</Btn>
            <Btn size="md" onClick={back} data-testid="back-to-setup">Back to setup</Btn>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <section className="flex flex-col items-center gap-2 border border-atc-border bg-atc-panel p-6 text-center" data-testid="score-card">
            <span className={LABEL}>Grade</span>
            <span className={`text-[96px] font-bold leading-none ${GRADE_COLOR[report.grade] ?? ''}`} data-testid="grade">{report.grade}</span>
            <span className="text-[22px] font-semibold tabular-nums" data-testid="score">{Math.round(sc.score)}<span className="text-sm text-atc-muted"> / 100</span></span>
            <p className="mt-2 text-xs leading-relaxed text-atc-muted">{report.summary}</p>
            {career && (
              <div className="mt-3 w-full border-t border-atc-border pt-3 text-left text-[11.5px] text-atc-muted">
                <span className={LABEL}>Career progress</span>
                <div>Steps completed: <b className="text-atc-text">{career.completedSteps.length}</b> · Next unlocked: <b className="text-atc-text">{career.unlockedStep}</b></div>
                {career.bestScores[report.scenarioId] !== undefined && <div>Best score here: <b className="text-atc-text">{career.bestScores[report.scenarioId]}</b></div>}
              </div>
            )}
          </section>

          <section className="grid grid-cols-2 content-start gap-3 sm:grid-cols-3 xl:grid-cols-4">
            <Counter label="Aircraft handled" value={sc.aircraftHandled} />
            <Counter label="Correct clearances" value={sc.correctClearances} />
            <Counter label="Communication errors" value={sc.communicationErrors} bad={sc.communicationErrors > 0} />
            <Counter label="Runway incursions" value={sc.runwayIncursions} bad={sc.runwayIncursions > 0} />
            <Counter label="Separation violations" value={sc.separationViolations} bad={sc.separationViolations > 0} />
            <Counter label="Unsafe instructions" value={sc.unsafeInstructions} bad={sc.unsafeInstructions > 0} />
            <Counter label="Missed readback errors" value={sc.missedReadbackErrors} bad={sc.missedReadbackErrors > 0} />
            <Counter label="Avg. wait" value={`${Math.round(sc.averageWaitSec)} s`} />
            <Counter label="Total delay" value={`${Math.round(sc.totalDelaySec)} s`} />
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title="Improvements" className="min-h-[120px]">
            <ul className="flex flex-col gap-2 p-4 text-[12.5px] leading-snug" data-testid="improvements">
              {report.improvements.length === 0 && <li className="text-atc-muted">Nothing flagged. Clean session.</li>}
              {report.improvements.map((t, i) => (<li key={i} className="flex gap-2"><span className="text-atc-amber">▸</span>{t}</li>))}
            </ul>
          </Panel>
          <Panel title="Objectives" count={`${report.objectives.filter((o) => o.completed).length}/${report.objectives.length}`} className="min-h-[120px]">
            <ul className="flex flex-col gap-2 p-4 text-[12.5px]" data-testid="objectives">
              {report.objectives.length === 0 && <li className="text-atc-muted">This session had no scored objectives.</li>}
              {report.objectives.map((o) => (
                <li key={o.id} className="flex gap-2">
                  <span className={o.completed ? 'text-atc-green' : 'text-atc-red'}>{o.completed ? '✓' : '✗'}</span>
                  <span className={o.completed ? '' : 'text-atc-muted'}>{o.text}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <Panel
          title="Timeline"
          count={timeline.length}
          right={<Segmented size="xs" value={sev} onChange={(v) => { setSev(v); setPicked(null); }} options={[{ value: 'all', label: 'All' }, { value: 'warning', label: 'Warnings+' }, { value: 'critical', label: 'Critical' }]} />}
        >
          <div className="grid min-h-[200px] gap-0 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <ul className="max-h-[340px] overflow-y-auto border-r border-atc-border" data-testid="timeline">
              {timeline.length === 0 && <li className="p-4 text-xs text-atc-muted">No events at this severity.</li>}
              {timeline.map((t, i) => (
                <li key={`${t.timeSec}-${i}`}>
                  <button type="button" onClick={() => setPicked(i === picked ? null : i)} className={`flex w-full items-baseline gap-3 border-b border-atc-border/60 px-4 py-1.5 text-left text-[12px] hover:bg-atc-panel-2 ${i === picked ? 'bg-atc-cyan/10' : ''}`}>
                    <span className="w-14 shrink-0 tabular-nums text-atc-muted">{formatElapsed(t.timeSec)}</span>
                    <span className={`w-16 shrink-0 font-sans text-[10px] font-semibold uppercase tracking-wider ${SEV_COLOR[t.severity]}`}>{t.severity}</span>
                    <span className="min-w-0 flex-1">{t.callsign && <b className="mr-2 text-atc-cyan">{t.callsign}</b>}{t.text}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="max-h-[340px] overflow-y-auto p-4 text-xs" data-testid="timeline-detail">
              {!sel && <p className="text-atc-muted">Select an event to see what was on the radio around it.</p>}
              {sel && (
                <>
                  <div className={`font-semibold ${SEV_COLOR[sel.severity]}`}>{sel.kind.replace(/_/g, ' ')} · {formatElapsed(sel.timeSec)}</div>
                  <p className="mt-1 text-[13px]">{sel.text}</p>
                  <div className={`${LABEL} mt-4`}>Nearby events (±20 s)</div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {related.length === 0 && <li className="text-atc-muted">No related transmissions recorded.</li>}
                    {related.map((e) => (
                      <li key={e.id} className="flex gap-2 leading-snug">
                        <span className="w-12 shrink-0 tabular-nums text-atc-muted">{formatElapsed(e.timeSec).slice(3)}</span>
                        <span className={e.speaker === 'ATC' ? 'text-atc-cyan' : e.speaker === 'PILOT' ? 'text-atc-green' : 'text-atc-amber'}>{e.speaker ?? 'SYS'}</span>
                        <span className="min-w-0 flex-1">{e.callsign ? `${e.callsign}: ` : ''}{e.text}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
