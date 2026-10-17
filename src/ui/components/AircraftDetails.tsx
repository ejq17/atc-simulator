import { createProjection } from '../../airport';
import type { Aircraft, Clearance, SimulationState } from '../../sim/types';
import { useSimState } from '../store/simStore';
import { useUiStore } from '../store/uiStore';
import { TONE_COLOR, altHundreds, formatElapsed, formatMhz, magHeading, phaseLabel, statusTone, trendArrow } from '../lib/format';
import { LABEL, Panel, Btn } from './ui';
import { freqLabel } from './AircraftPanel';

export function describeClearance(c: Clearance): string {
  const parts: string[] = [c.kind.replace(/_/g, ' ')];
  if (c.runwayEnd) parts.push(`RWY ${c.runwayEnd}`);
  else if (c.runwayId) parts.push(`RWY ${c.runwayId}`);
  if (c.route?.length) parts.push(`via ${c.route.join(' ')}`);
  if (c.holdShort?.length) parts.push(`hold short ${c.holdShort.join(', ')}`);
  if (c.destination && !c.runwayEnd) parts.push(`to ${c.destination}`);
  if (c.headingDeg !== undefined) parts.push(`${String(Math.round(c.headingDeg)).padStart(3, '0')}${c.turnDirection ? ` ${c.turnDirection}` : ''}`);
  if (c.altitudeFt !== undefined) parts.push(`${c.altitudeFt.toLocaleString()} ft`);
  if (c.speedKt !== undefined) parts.push(`${c.speedKt} kt`);
  if (c.frequencyMhz !== undefined) parts.push(formatMhz(c.frequencyMhz));
  return parts.join(' ');
}

/** Latest not-yet-completed clearance of each kind. */
export function activeClearances(ac: Aircraft): Clearance[] {
  const lastByKind = new Map<string, Clearance>();
  for (const c of ac.clearances) lastByKind.set(c.kind, c);
  return [...lastByKind.values()].filter((c) => c.completedAtSec === undefined);
}

export function describeStop(state: SimulationState, nodeId: string, isLast: boolean): string {
  const n = state.airport.taxiwayGraph.nodes[nodeId];
  if (!n) return nodeId;
  if (n.kind === 'holding_position') return `Hold short RWY ${n.runwayId ?? ''}${n.taxiways[0] ? ` on ${n.taxiways[0]}` : ''}`;
  return isLast ? `Route end${n.name ? ` (${n.name})` : ''}` : (n.name ?? nodeId);
}

function KV({ k, children, mono = true }: { k: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className={LABEL}>{k}</span>
      <span className={`truncate text-[12.5px] text-atc-text ${mono ? 'tabular-nums' : ''}`}>{children}</span>
    </div>
  );
}

export function AircraftDetails() {
  const state = useSimState();
  const setDraft = useUiStore((s) => s.setDraft);
  if (!state) return null;
  const ac = state.selectedAircraftId ? state.aircraft[state.selectedAircraftId] : undefined;
  if (!ac) {
    return (
      <Panel title="Aircraft details" className="shrink-0">
        <div className="px-3 py-4 text-xs leading-relaxed text-atc-muted">
          Select an aircraft in the list or on a display to see its position, clearances and taxi route.
        </div>
      </Panel>
    );
  }
  const var_ = state.airport.magneticVariationDeg;
  const proj = createProjection(state.airport.arp);
  const ll = proj.toLatLon(ac.pos);
  const clr = activeClearances(ac);
  const stops = ac.route?.stopAtNodeIds ?? [];
  const tone = statusTone(ac);
  const mag = magHeading(ac.headingDeg, var_);
  return (
    <Panel
      title="Aircraft details"
      className="shrink-0"
      right={<Btn size="xs" tone="cyan" onClick={() => setDraft(`${ac.spokenCallsign}, `)} title="Pre-fill the command box with this callsign">Address</Btn>}
    >
      <div className="flex flex-col gap-2.5 px-3 py-2.5" data-testid="aircraft-details">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-tight text-atc-cyan" data-testid="detail-callsign">{ac.callsign}</div>
            <div className="truncate text-[10.5px] text-atc-muted">{ac.spokenCallsign}</div>
          </div>
          <div className="shrink-0 text-right text-[10.5px] text-atc-muted">
            {ac.type} · {ac.flightRules}
            <br />
            {ac.origin} → {ac.destination}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-x-3 gap-y-2">
          <KV k="Phase"><span style={{ color: TONE_COLOR[tone] }} data-testid="detail-phase" data-phase={ac.phase}>{phaseLabel(ac.phase)}</span></KV>
          <KV k="Runway">{ac.assignedRunwayEnd ?? '—'}</KV>
          <KV k="Frequency">{freqLabel(state, ac.frequencyMhz)}</KV>
          <KV k="Hdg (mag)">{mag}°</KV>
          <KV k="Altitude">{Math.round(ac.altitudeFt).toLocaleString()} ft <span className="text-atc-muted">{altHundreds(ac.altitudeFt)}</span></KV>
          <KV k="GS / VS">{Math.round(ac.groundSpeedKt)} kt {trendArrow(ac.verticalSpeedFpm) || ''}{Math.abs(ac.verticalSpeedFpm) > 50 ? ` ${Math.round(ac.verticalSpeedFpm)}` : ''}</KV>
          <div className="col-span-3 min-w-0">
            <KV k="Position">{ll.lat.toFixed(5)}, {ll.lon.toFixed(5)}</KV>
          </div>
        </div>

        <div>
          <div className={LABEL}>Active clearances</div>
          {clr.length === 0 ? (
            <div className="text-[11.5px] text-atc-muted">None</div>
          ) : (
            <ul className="mt-0.5 flex flex-col gap-0.5" data-testid="detail-clearances">
              {clr.map((c) => (
                <li key={c.id} className="flex items-baseline justify-between gap-2 text-[11.5px]">
                  <span className="text-atc-text">{describeClearance(c)}</span>
                  <span className="shrink-0 text-[10px] text-atc-muted">{formatElapsed(c.issuedAtSec)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className={LABEL}>Taxi route</div>
          {ac.route ? (
            <div className="text-[11.5px]">
              <div className="text-atc-text">{ac.route.taxiways.length ? ac.route.taxiways.join(' → ') : 'direct'} <span className="text-atc-muted">· node {Math.min(ac.route.progressIndex, ac.route.nodeIds.length)}/{ac.route.nodeIds.length}</span></div>
              {stops.map((id, i) => (
                <div key={id} className="flex items-center gap-1.5 text-atc-red"><span className="inline-block h-1.5 w-1.5 bg-atc-red" />{describeStop(state, id, i === stops.length - 1)}</div>
              ))}
            </div>
          ) : (
            <div className="text-[11.5px] text-atc-muted">No taxi route assigned</div>
          )}
        </div>

        {(ac.flags.readbackErrorPending || ac.pendingRequest) && (
          <div className="flex flex-col gap-1">
            {ac.flags.readbackErrorPending && (
              <div className="border border-atc-red/70 bg-atc-red/10 px-2 py-1 text-[11px] text-atc-red">Readback error: the pilot read back something different. Re-issue the instruction to correct it.</div>
            )}
            {ac.pendingRequest && (
              <div className="border border-atc-amber/60 bg-atc-amber/10 px-2 py-1 text-[11px] text-atc-amber">Request ({formatElapsed(state.clock.timeSec - ac.pendingRequest.sinceSec).slice(3)} ago): {ac.pendingRequest.text}</div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
