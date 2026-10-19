import { createProjection } from '../../airport';
import type { Aircraft, Clearance, SimulationState } from '../../sim/types';
import { useSimState } from '../store/simStore';
import { useUiStore } from '../store/uiStore';
import { altText } from '../lib/ifr';
import { TONE_COLOR, altHundreds, formatElapsed, formatMhz, magHeading, phaseLabel, statusTone, trendArrow } from '../lib/format';
import { LABEL, Panel, Btn } from './ui';
import { freqLabel } from './AircraftPanel';
import { approachFixAltitudes, approachInfo, ifrClearanceParts, lahsoBadge, navDescription, nextFix, remainingFixes, requestBadge } from '../lib/ifr';

export function describeClearance(c: Clearance): string {
  const parts: string[] = [c.kind.replace(/_/g, ' ')];
  if (c.approachType) parts.push(c.approachType);
  if (c.fix) parts.push(c.fix);
  if (c.ifr) parts.push(`${c.ifr.destination} sqk ${c.ifr.squawk}`);
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
  const approach = approachInfo(state, ac);
  const fixAlts = approachFixAltitudes(state, ac);
  const lahso = lahsoBadge(state, ac);
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
            {ac.type} · <b className={ac.flightRules === 'IFR' ? 'text-atc-cyan' : ''} data-testid="detail-rules">{ac.flightRules}</b>
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
          <KV k="Squawk"><span data-testid="detail-squawk">{ac.squawk ?? '—'}</span></KV>
          <KV k="Radar"><span className={ac.radarIdentified ? 'text-atc-green' : 'text-atc-muted'} data-testid="detail-radar">{ac.radarIdentified ? 'IDENTIFIED' : ac.flightRules === 'IFR' && !ac.onGround ? 'not identified' : '—'}</span></KV>
          <KV k="Next fix"><span data-testid="detail-nextfix">{(!ac.onGround && nextFix(ac)) || '—'}</span></KV>
          <div className="col-span-3 min-w-0">
            <KV k="Navigation" mono={false}><span title={navDescription(state, ac)} data-testid="detail-nav">{navDescription(state, ac)}</span></KV>
          </div>
          <div className="col-span-3 min-w-0">
            <KV k="Position">{ll.lat.toFixed(5)}, {ll.lon.toFixed(5)}</KV>
          </div>
        </div>

        {approach.state !== 'none' && (
          <div className={`border px-2 py-1 text-[11.5px] ${approach.state === 'established' ? 'border-atc-green-dim bg-atc-green/10 text-atc-green' : 'border-atc-cyan/50 bg-atc-cyan/10 text-atc-cyan'}`} data-testid="detail-approach" data-state={approach.state}>
            Cleared {approach.label} approach · {approach.state === 'established' ? 'established' : 'not yet established'}
            {fixAlts.length > 0 && (
              <div className="mt-0.5 break-words text-[11px] text-atc-text/90" data-testid="detail-fix-altitudes">
                {fixAlts.map((a, i) => <span key={a.fix} title={a.note}>{i > 0 ? ' · ' : ''}<b>{a.fix}</b> {a.text}</span>)}
              </div>
            )}
          </div>
        )}

        {lahso && (
          <div className="border border-fuchsia-400/60 bg-fuchsia-400/10 px-2 py-1 text-[11.5px] text-fuchsia-300" data-testid="detail-lahso">{lahso}</div>
        )}

        {ac.flightPlan?.ifrClearance && (
          <div className="border border-atc-cyan/40 bg-atc-cyan/5 px-2 py-1.5" data-testid="detail-ifr-clearance">
            <div className={`${LABEL} !text-atc-cyan`}>IFR clearance {ac.flightPlan.ifrClearance.readBack ? 'read back' : ''}</div>
            <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
              {ifrClearanceParts(ac.flightPlan.ifrClearance).map((p) => (
                <div key={p.label} className="contents"><dt className="text-atc-muted">{p.label}</dt><dd className="text-atc-text tabular-nums">{p.value}</dd></div>
              ))}
            </dl>
          </div>
        )}

        {ac.flightPlan && (
          <div data-testid="detail-flightplan">
            <div className={LABEL}>Flight plan</div>
            <div className="text-[11.5px] text-atc-text">
              {ac.flightPlan.flightRules} · {ac.flightPlan.origin} → {ac.flightPlan.destination} · cruise {altText(ac.flightPlan.cruiseAltitudeFt)}
              {ac.flightPlan.arrivalApproach && <> · {ac.flightPlan.arrivalApproach.type} {ac.flightPlan.arrivalApproach.runwayEnd}</>}
            </div>
            <div className="break-words text-[11.5px] text-atc-muted" data-testid="detail-route">
              Route: {ac.flightPlan.route.length ? ac.flightPlan.route.map((f, i) => {
                const ahead = remainingFixes(ac);
                const cur = ac.nav && ahead[0] === f && ac.nav.fixes.indexOf(f) === Math.min(ac.nav.index, ac.nav.fixes.length - 1);
                return <span key={`${f}-${i}`} className={cur ? 'font-semibold text-atc-cyan' : ''}>{i > 0 ? ' ' : ''}{f}</span>;
              }) : '—'}
            </div>
            {ac.nav && ac.nav.fixes.length > 0 && ac.nav.fixes.join(' ') !== ac.flightPlan.route.join(' ') && (
              <div className="break-words text-[11.5px] text-atc-muted">Flying: {ac.nav.fixes.join(' ')} <span className="text-atc-muted/70">({ac.nav.mode})</span></div>
            )}
          </div>
        )}

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

        {(ac.onGround || ac.route) && (
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
        )}

        {ac.student && <div className="border border-atc-amber/60 bg-atc-amber/10 px-2 py-1 text-[11px] text-atc-amber" data-testid="detail-student">Student pilot: slower to respond, wordier, may ask for progressive taxi and misread pattern instructions.</div>}

        {(ac.flags.readbackErrorPending || (ac.pendingRequest && !ac.pendingRequest.unheard)) && (
          <div className="flex flex-col gap-1">
            {ac.flags.readbackErrorPending && !['no_readback', 'callsign'].includes(ac.flags.readbackErrorKind ?? '') && (
              <div className="border border-atc-red/70 bg-atc-red/10 px-2 py-1 text-[11px] text-atc-red">Readback error: the pilot read back something different. Re-issue the instruction to correct it.</div>
            )}
            {ac.pendingRequest && !ac.pendingRequest.unheard && (
              <div className="border border-atc-amber/60 bg-atc-amber/10 px-2 py-1 text-[11px] text-atc-amber" data-testid="detail-request"><b>{requestBadge(ac.pendingRequest.kind)}</b> ({formatElapsed(state.clock.timeSec - ac.pendingRequest.sinceSec).slice(3)} ago): {ac.pendingRequest.text}</div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
