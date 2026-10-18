import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useSimState, useSimStore } from '../store/simStore';
import { afterCandidates, describeRequest, landlineView, quickRequests, statusLabel } from '../lib/landline';
import { formatElapsed } from '../lib/format';
import { keyLabel } from '../lib/voiceStatus';
import { useVoiceSettings } from '../store/voiceSettings';
import type { CoordRequest } from '../../sim/coordination';
import { Btn, INPUT, Kbd, LABEL, Panel, Segmented, Toggle } from './ui';

const WORD = { CLNC: 'Clearance Delivery', GND: 'Ground', TWR: 'Tower', APP: 'Approach', DEP: 'Departure' } as const;

/** The number of requests waiting for the player's answer (tab badge). */
export function useLandlineWaiting(): number {
  const state = useSimStore((s) => s.session?.engine.getState());
  const controller = useSimStore((s) => s.controller);
  useSimStore((s) => s.rev);
  if (!state) return 0;
  return landlineView(state, controller.positions).incoming.length;
}

const answerLabels = (r: CoordRequest) =>
  r.topic === 'RELEASE' ? { yes: 'Released', no: 'Hold for release', wait: 'Stand by' }
    : r.topic === 'POINT_OUT' ? { yes: 'Point out approved', no: 'Unable', wait: 'Stand by' }
      : { yes: 'Approve', no: 'Unable', wait: 'Stand by' };

function IncomingCard({ r }: { r: CoordRequest }) {
  const session = useSimStore((s) => s.session)!;
  const state = useSimState()!;
  const [after, setAfter] = useState('');
  const labels = answerLabels(r);
  const cands = r.topic === 'CROSSING' ? afterCandidates(state) : [];
  return (
    <li data-testid="landline-incoming" data-request={r.id} className="border border-atc-amber/60 bg-atc-bg px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-atc-amber">{WORD[r.from]} asks {WORD[r.to]}</span>
        <span className="text-[10px] text-atc-muted">{r.status === 'standby' ? 'you said stand by' : r.asks > 1 ? `asked ${r.asks}x` : 'new'}</span>
      </div>
      <div className="py-0.5 text-[12px] text-atc-text">{describeRequest(r)}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn size="xs" tone="green" data-testid="landline-approve" onClick={() => session.answerRequest(r.id, 'approve')}>{labels.yes}</Btn>
        <Btn size="xs" tone="red" data-testid="landline-unable" onClick={() => session.answerRequest(r.id, 'deny')}>{labels.no}</Btn>
        {r.status !== 'standby' && <Btn size="xs" tone="amber" data-testid="landline-standby" onClick={() => session.answerRequest(r.id, 'standby')}>{labels.wait}</Btn>}
        {cands.length > 0 && (
          <span className="flex items-center gap-1">
            <select aria-label="Approve behind the landing aircraft" className="h-6 border border-atc-border bg-atc-bg px-1 text-[10px]" value={after} onChange={(e) => setAfter(e.target.value)}>
              <option value="">behind the landing…</option>
              {cands.map((a) => <option key={a.id} value={a.id}>{a.callsign}</option>)}
            </select>
            <Btn size="xs" tone="cyan" disabled={!after} data-testid="landline-approve-after" onClick={() => session.answerRequest(r.id, 'approve', { afterAircraftId: after })}>Approve after</Btn>
          </span>
        )}
      </div>
    </li>
  );
}

export function LandlinePanel() {
  const state = useSimState();
  const session = useSimStore((s) => s.session);
  const controller = useSimStore((s) => s.controller);
  const settings = useVoiceSettings();
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [mode, setMode] = useState(false);
  if (!state || !session) return null;
  const now = state.clock.timeSec;
  const view = landlineView(state, controller.positions, scope === 'all');
  const quick = quickRequests(state, controller.positions);
  const api = (session.engine as unknown as { coordination?: { request(i: Record<string, unknown>): unknown } }).coordination;

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const r = session.submitLandline(text, 'typed');
    setNote({ tone: r.summary === 'done' ? 'ok' : 'bad', text: r.message });
    if (r.summary === 'done') setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
  };
  const alone = controller.aiPositions?.length === 0 && controller.positions.length > 1;

  return (
    <Panel
      title="Landline"
      count={view.incoming.length ? `${view.incoming.length} waiting` : undefined}
      className="h-full min-h-0"
      right={<Segmented size="xs" value={scope} onChange={setScope} options={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'All calls' }]} />}
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto p-2 md:grid-cols-[minmax(240px,1fr)_minmax(240px,1.2fr)]" data-testid="landline-panel">
        <div className="flex min-h-0 flex-col gap-2">
          <section>
            <div className={LABEL}>Waiting for you</div>
            <ul className="mt-1 flex flex-col gap-1.5" data-testid="landline-incoming-list">
              {view.incoming.length === 0 && <li className="text-[11px] text-atc-muted">{alone ? 'You work these positions yourself: no calls needed.' : 'Nothing waiting. A call from another position rings here.'}</li>}
              {view.incoming.map((r) => <IncomingCard key={r.id} r={r} />)}
            </ul>
            {view.givenOpen.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-1" data-testid="landline-given">
                {view.givenOpen.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 border border-atc-border px-2 py-1 text-[11px]">
                    <span>{describeRequest(r)} <span className="text-atc-muted">· {statusLabel(r, now)}</span></span>
                    <Btn size="xs" tone="red" data-testid="landline-takeback" onClick={() => session.rescindRequest(r.id, r.topic === 'RELEASE' ? 'hold for release' : 'hold short')}>Take back</Btn>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <div className={LABEL}>You asked</div>
            <ul className="mt-1 flex flex-col gap-1" data-testid="landline-outgoing">
              {view.outgoing.length === 0 && quick.length === 0 && <li className="text-[11px] text-atc-muted">No open requests.</li>}
              {quick.map((q) => (
                <li key={`${q.topic}-${q.aircraft.id}`}>
                  <Btn size="xs" tone="cyan" data-testid="landline-quick" onClick={() => api?.request({ topic: q.topic, from: q.from, to: q.to, aircraftId: q.aircraft.id, runwayId: q.runwayId, source: 'player' })}>{q.label}</Btn>
                </li>
              ))}
              {view.outgoing.map((r) => (
                <li key={r.id} data-testid="landline-out" data-status={r.status} className="flex items-baseline justify-between gap-2 border border-atc-border px-2 py-1 text-[11px]">
                  <span className="min-w-0 truncate">{WORD[r.to]}: {describeRequest(r)}</span>
                  <span className={r.status === 'approved' ? 'text-atc-green' : r.status === 'denied' || r.status === 'rescinded' ? 'text-atc-red' : 'text-atc-amber'}>{statusLabel(r, now)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <div className="flex min-h-0 flex-col gap-1.5">
          <div className={LABEL}>Log</div>
          <div role="log" aria-live="polite" data-testid="landline-log" className="min-h-[88px] flex-1 overflow-y-auto border border-atc-border bg-atc-bg py-1">
            {view.log.length === 0 && <div className="px-2 py-2 text-[11px] text-atc-muted">No calls yet.</div>}
            {view.log.map((m) => (
              <div key={m.id} className="flex items-baseline gap-2 px-2 py-[1px] text-[11.5px] leading-snug" data-testid="landline-msg" data-kind={m.kind}>
                <span className="w-[46px] shrink-0 tabular-nums text-atc-muted">{formatElapsed(m.timeSec)}</span>
                <span className={`min-w-0 flex-1 ${m.source === 'ai' ? 'text-[#b79cff]' : m.source === 'system' ? 'italic text-atc-muted' : 'text-atc-text'}`}>
                  {m.text}
                  {!m.standard && <span className="ml-1 text-[9px] uppercase text-atc-muted" title="Plain words: not phraseology from the order">plain</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              className={INPUT}
              data-testid="landline-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder="Tower, Ground, cross runway one three at Alpha with …"
              aria-label="Landline call"
            />
            <Btn size="sm" tone="cyan" onClick={send} data-testid="landline-send">Call</Btn>
          </div>
          {note && <div data-testid="landline-note" className={`text-[11px] ${note.tone === 'ok' ? 'text-atc-green' : 'text-atc-red'}`}>{note.text}</div>}
          <Toggle
            checked={mode}
            onChange={(v) => { setMode(v); session.setLandlineMode(v); }}
            label="Landline mode"
            hint={`Everything you say or type goes to the landline. Without it, hold ${keyLabel(settings.landlineKey)} to talk on the landline (a call that starts with two position names, like “Tower, Ground, …”, is always a landline call).`}
          />
          <div className="text-[10px] text-atc-muted">Hold <Kbd>{keyLabel(settings.landlineKey)}</Kbd> to talk on the landline.</div>
        </div>
      </div>
    </Panel>
  );
}
