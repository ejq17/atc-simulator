import { useSimState, useSimStore } from '../store/simStore';
import { useUiStore } from '../store/uiStore';
import { useCompact } from '../layout/useMedia';
import { LayoutMenu } from '../layout/LayoutMenu';
import { Popover, MenuItem } from './Popover';
import { openTool, revealPanel } from '../layout/actions';
import { useAlertCount } from '../layout/GroupView';
import { altimeterText, formatElapsed, formatZulu, windText } from '../lib/format';
import { Btn, LABEL } from './ui';
import { isDaylight, simUtcMs, sunriseSunsetUtc } from '../../sim/solar';
import type { SimulationState } from '../../sim/types';
import type { ClockStatus } from '../store/realtimeClock';
import type { LiveFeedStatus } from '../../weather/liveFeed';

const CAT_COLOR: Record<string, string> = { VFR: 'text-atc-green', MVFR: 'text-atc-cyan', IFR: 'text-atc-red', LIFR: 'text-fuchsia-400' };

export function airportTitle(name: string, icao: string): string {
  const pretty = name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bInternational\b/, 'Intl');
  return `${pretty} (${icao})`;
}

function Stat({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="atc-readout flex min-w-0 flex-col justify-center leading-tight" title={title}>
      <span className={LABEL}>{label}</span>
      <span className="text-[13px] font-semibold tabular-nums text-atc-text">{children}</span>
    </div>
  );
}

/** Sunrise / sunset at the airport for the sim's current UTC day (from solar.ts, fed by the session epoch). */
function daylightTitle(state: SimulationState): string {
  const utc = simUtcMs(state);
  const ss = sunriseSunsetUtc(state.airport.arp, utc);
  const hm = (ms: number) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`; };
  return ss ? `Sunrise ${hm(ss.sunriseMs)}, sunset ${hm(ss.sunsetMs)} at the airport` : 'No sunrise / sunset today';
}

function ClockBadge({ clock, realTime }: { clock: ClockStatus; realTime: boolean }) {
  if (!realTime) return null;
  const tone = clock.mode === 'live' ? 'border-atc-green text-atc-green' : clock.mode === 'paused' ? 'border-atc-amber text-atc-amber' : 'border-atc-cyan text-atc-cyan';
  const text = clock.mode === 'live' ? 'LIVE' : clock.mode === 'paused' ? 'PAUSED' : `SIM ${clock.speed}x`;
  const title = clock.mode === 'live' ? 'Sim time follows the real clock' : clock.mode === 'paused' ? 'Paused; resuming at 1x re-locks to the real clock' : 'Sim-speed override: the real-time lock is released. Choose 1x to lock back to the wall clock.';
  return <span data-testid="clock-mode" title={title} className={`border px-1 font-sans text-[10px] font-semibold uppercase leading-4 tracking-wider ${tone}`}>{text}</span>;
}

function WxBadge({ status }: { status: LiveFeedStatus }) {
  const label = status.kind === 'live' ? `LIVE WX ${status.observedAt.slice(11, 16)}Z` : status.kind === 'stale' ? `WX STALE ${status.observedAt.slice(11, 16)}Z` : 'WX SIMULATED';
  const tone = status.kind === 'live' ? 'border-atc-green text-atc-green' : 'border-atc-amber text-atc-amber';
  const title = status.kind === 'live' ? `Live KACY METAR, observed ${status.observedAt}. Refreshed every 5 minutes.`
    : status.kind === 'stale' ? `Weather backend unreachable (${status.error}). Using the last good METAR, observed ${status.observedAt}; retrying every minute.`
    : `Live weather unavailable (${status.error}). Using simulated weather; retrying every minute.`;
  return <span data-testid="wx-mode" title={title} className={`border px-1 font-sans text-[10px] font-semibold uppercase leading-4 tracking-wider ${tone}`}>{label}</span>;
}

const Rule = () => <span className="hidden h-7 w-px shrink-0 bg-atc-border sm:block" />;

function AlertChip() {
  const { count, critical } = useAlertCount();
  return (
    <button
      type="button"
      data-testid="alert-chip"
      onClick={() => revealPanel('alerts')}
      title={count ? `${count} open conflict${count === 1 ? '' : 's'}: show the alerts` : 'No conflicts'}
      className={`flex items-center gap-1.5 border px-2 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wider ${critical ? 'atc-blink border-atc-red text-atc-red' : count ? 'border-atc-amber text-atc-amber' : 'border-atc-border text-atc-muted'}`}
    >
      <span className={`inline-block h-1.5 w-1.5 ${critical ? 'bg-atc-red' : count ? 'bg-atc-amber' : 'bg-atc-green'}`} />
      {count ? `${count} alert${count === 1 ? '' : 's'}` : 'No alerts'}
    </button>
  );
}

export function TopBar() {
  const state = useSimState();
  const session = useSimStore((s) => s.session);
  const atis = useSimStore((s) => s.atis);
  const endSession = useSimStore((s) => s.endSession);
  const setSpeed = useSimStore((s) => s.setSpeed);
  const togglePause = useSimStore((s) => s.togglePause);
  const realTime = useSimStore((s) => s.realTime);
  const drawer = useUiStore((s) => s.drawer);
  const compact = useCompact();
  if (!state || !session) return null;
  const speed = state.clock.speed;
  const clock = session.clockStatus();
  const liveWx = useSimStore.getState().liveWeather;
  const w = state.weather;
  const v = state.airport.magneticVariationDeg;
  return (
    <header className="atc-topbar shrink-0 border-b border-atc-border bg-atc-panel">
      <div className="flex min-h-11 items-center gap-2 px-2 py-1 sm:gap-2.5 sm:px-3">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" className="shrink-0">
          <rect x="0.5" y="0.5" width="25" height="25" fill="#0b0e11" stroke="#2a323c" />
          <path d="M5 21 L21 5" stroke="#39c5e8" strokeWidth="3" />
          <path d="M5 6 L21 20" stroke="#7f8a96" strokeWidth="2" />
        </svg>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[13px] font-semibold tracking-wide text-atc-text" data-testid="airport-title">{airportTitle(state.airport.name, state.airport.icao)}</div>
          <div className={`${LABEL} max-w-[170px] truncate`} title={state.scenario.name}>{state.scenario.name}</div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
          <span className={`${LABEL} hidden min-[1400px]:inline`} title="Real-time mode: 1x follows the wall clock. 2x / 4x are a sim-speed override; 1x locks back to real time.">Sim speed</span>
          <div className="flex items-center gap-1" role="group" aria-label="Sim speed override">
            <Btn tone={speed === 0 ? 'amber' : 'default'} active={speed === 0} onClick={togglePause} aria-label={speed === 0 ? 'Resume' : 'Pause'} data-testid="pause">
              {speed === 0 ? '▶' : '⏸'}
            </Btn>
            {[1, 2, 4].map((sp) => (
              <Btn key={sp} active={speed === sp} onClick={() => setSpeed(sp)} data-testid={`speed-${sp}`} aria-pressed={speed === sp} className="max-[420px]:!px-1.5">{sp}×</Btn>
            ))}
          </div>
          {!compact && (
            <>
              <Rule />
              <LayoutMenu />
              <div className="flex items-center gap-1">
                <Btn onClick={() => openTool('charts')} active={drawer === 'charts'} data-testid="open-charts">Charts</Btn>
                <Btn onClick={() => openTool('navaids')} active={drawer === 'navaids'} data-testid="open-navaids">Navaids</Btn>
                <Btn onClick={() => openTool('settings')} active={drawer === 'settings'} data-testid="open-settings">Settings</Btn>
              </div>
              <Btn tone="red" onClick={endSession} data-testid="end-session">End session</Btn>
            </>
          )}
          {compact && (
            <Popover label="Menu" testId="topbar-menu" buttonClass="inline-flex h-9 items-center border border-atc-border bg-atc-bg px-3 font-sans text-[11px] font-medium uppercase tracking-wider text-atc-text">
              {(close) => (
                <>
                  <MenuItem testId="open-charts" onClick={() => { openTool('charts'); close(); }}>Charts</MenuItem>
                  <MenuItem testId="open-navaids" onClick={() => { openTool('navaids'); close(); }}>Navaids</MenuItem>
                  <MenuItem testId="open-settings" onClick={() => { openTool('settings'); close(); }}>Settings</MenuItem>
                  <MenuItem testId="end-session" onClick={() => { close(); endSession(); }}><span className="text-atc-red">End session</span></MenuItem>
                </>
              )}
            </Popover>
          )}
        </div>
      </div>
      <div className="atc-statusstrip flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-atc-border/70 px-2 py-1 sm:gap-x-4 sm:px-3" data-testid="status-strip">
        <Stat label="Sim time"><span data-testid="sim-time">{formatElapsed(state.clock.timeSec)}</span></Stat>
        <Stat label="Zulu" title={daylightTitle(state)}><span data-testid="zulu">{formatZulu(session.utcAt, state.clock.timeSec)}</span> <span className="text-[11px] font-normal text-atc-muted" data-testid="daynight">{isDaylight(state.airport.arp, simUtcMs(state)) ? 'DAY' : 'NIGHT'}</span></Stat>
        <ClockBadge clock={clock} realTime={realTime} />
        <Rule />
        <Stat label="Wind (mag)" title="Magnetic direction, as the tower would say it"><span data-testid="wind">{windText(w, v)}</span></Stat>
        {liveWx && <WxBadge status={liveWx} />}
        <Stat label="Altimeter"><span data-testid="altimeter">{altimeterText(w.altimeterInHg)}</span></Stat>
        <div className="hidden sm:block">
          <Stat label="Conditions"><span className={CAT_COLOR[w.flightCategory]}>{w.flightCategory}</span> <span className="text-[11px] font-normal text-atc-muted">{w.visibilitySm} SM</span></Stat>
        </div>
        <Rule />
        <button type="button" onClick={() => openTool('atis')} data-testid="atis-button" className={`flex items-center gap-2 border px-2 py-0.5 text-left hover:border-atc-cyan ${drawer === 'atis' ? 'border-atc-cyan' : 'border-atc-border'}`}>
          <span className="flex flex-col leading-tight">
            <span className={LABEL}>ATIS</span>
            <span className="text-[13px] font-semibold text-atc-cyan" data-testid="atis-letter">INFO {atis?.letter ?? '-'}</span>
          </span>
          <span className="border border-atc-amber/70 px-1 font-sans text-[9px] font-semibold uppercase leading-4 tracking-wider text-atc-amber max-[420px]:hidden">Simulated</span>
        </button>
        <button type="button" onClick={() => openTool('weather')} data-testid="runway-config" title="Change weather and runway configuration" className={`flex flex-col border px-2 py-0.5 text-left leading-tight hover:border-atc-cyan ${drawer === 'weather' ? 'border-atc-cyan' : 'border-atc-border'}`}>
          <span className={LABEL}>Runways</span>
          <span className="text-[13px] font-semibold tabular-nums">
            <span className="text-atc-muted text-[10px] font-normal">DEP</span> {state.activeRunways.departing.join('/')} <span className="text-atc-muted text-[10px] font-normal">ARR</span> {state.activeRunways.landing.join('/')}
          </span>
        </button>
        <div className="ml-auto"><AlertChip /></div>
      </div>
    </header>
  );
}
