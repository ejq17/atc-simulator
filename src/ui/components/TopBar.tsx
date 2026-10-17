import { useSimState, useSimStore } from '../store/simStore';
import { useUiStore } from '../store/uiStore';
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
    <div className="flex flex-col justify-center leading-tight" title={title}>
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

const Rule = () => <span className="h-7 w-px shrink-0 bg-atc-border" />;

export function TopBar() {
  const state = useSimState();
  const session = useSimStore((s) => s.session);
  const atis = useSimStore((s) => s.atis);
  const endSession = useSimStore((s) => s.endSession);
  const setSpeed = useSimStore((s) => s.setSpeed);
  const togglePause = useSimStore((s) => s.togglePause);
  const realTime = useSimStore((s) => s.realTime);
  const toggleDrawer = useUiStore((s) => s.toggleDrawer);
  const drawer = useUiStore((s) => s.drawer);
  if (!state || !session) return null;
  const speed = state.clock.speed;
  const clock = session.clockStatus();
  const liveWx = useSimStore.getState().liveWeather;
  const w = state.weather;
  const v = state.airport.magneticVariationDeg;
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2.5 whitespace-nowrap border-b border-atc-border bg-atc-panel px-3">
      <div className="flex items-center gap-3">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" className="shrink-0">
          <rect x="0.5" y="0.5" width="25" height="25" fill="#0b0e11" stroke="#2a323c" />
          <path d="M5 21 L21 5" stroke="#39c5e8" strokeWidth="3" />
          <path d="M5 6 L21 20" stroke="#7f8a96" strokeWidth="2" />
        </svg>
        <div className="min-w-0 leading-tight">
          <div className="text-[13px] font-semibold tracking-wide text-atc-text" data-testid="airport-title">{airportTitle(state.airport.name, state.airport.icao)}</div>
          <div className={`${LABEL} max-w-[170px] truncate`} title={state.scenario.name}>{state.scenario.name}</div>
        </div>
      </div>
      <Rule />
      <Stat label="Sim time"><span data-testid="sim-time">{formatElapsed(state.clock.timeSec)}</span></Stat>
      <Stat label="Zulu" title={daylightTitle(state)}><span data-testid="zulu">{formatZulu(session.utcAt, state.clock.timeSec)}</span> <span className="text-[11px] font-normal text-atc-muted" data-testid="daynight">{isDaylight(state.airport.arp, simUtcMs(state)) ? 'DAY' : 'NIGHT'}</span></Stat>
      <ClockBadge clock={clock} realTime={realTime} />
      <Rule />
      <Stat label="Wind (mag)" title="Magnetic direction, as the tower would say it"><span data-testid="wind">{windText(w, v)}</span></Stat>
      {liveWx && <WxBadge status={liveWx} />}
      <Stat label="Altimeter"><span data-testid="altimeter">{altimeterText(w.altimeterInHg)}</span></Stat>
      <div className="hidden min-[1560px]:block">
        <Stat label="Conditions"><span className={CAT_COLOR[w.flightCategory]}>{w.flightCategory}</span> <span className="text-[11px] font-normal text-atc-muted">{w.visibilitySm} SM</span></Stat>
      </div>
      <Rule />
      <button type="button" onClick={() => toggleDrawer('atis')} data-testid="atis-button" className={`flex items-center gap-2 border px-2 py-1 text-left hover:border-atc-cyan ${drawer === 'atis' ? 'border-atc-cyan' : 'border-atc-border'}`}>
        <span className="flex flex-col leading-tight">
          <span className={LABEL}>ATIS</span>
          <span className="text-[13px] font-semibold text-atc-cyan" data-testid="atis-letter">INFO {atis?.letter ?? '-'}</span>
        </span>
        <span className="border border-atc-amber/70 px-1 font-sans text-[9px] font-semibold uppercase leading-4 tracking-wider text-atc-amber">Simulated</span>
      </button>
      <button type="button" onClick={() => toggleDrawer('weather')} data-testid="runway-config" title="Change weather and runway configuration" className={`flex flex-col border px-2 py-1 text-left leading-tight hover:border-atc-cyan ${drawer === 'weather' ? 'border-atc-cyan' : 'border-atc-border'}`}>
        <span className={LABEL}>Runways</span>
        <span className="text-[13px] font-semibold tabular-nums">
          <span className="text-atc-muted text-[10px] font-normal">DEP</span> {state.activeRunways.departing.join('/')} <span className="text-atc-muted text-[10px] font-normal">ARR</span> {state.activeRunways.landing.join('/')}
        </span>
      </button>

      <div className="ml-auto flex items-center gap-3">
        <span className={`${LABEL} hidden min-[1400px]:inline`} title="Real-time mode: 1x follows the wall clock. 2x / 4x are a sim-speed override; 1x locks back to real time.">Sim speed</span>
        <div className="flex items-center gap-1" role="group" aria-label="Sim speed override">
          <Btn tone={speed === 0 ? 'amber' : 'default'} active={speed === 0} onClick={togglePause} aria-label={speed === 0 ? 'Resume' : 'Pause'} data-testid="pause">
            {speed === 0 ? '▶' : '⏸'}
          </Btn>
          {[1, 2, 4].map((s) => (
            <Btn key={s} active={speed === s} onClick={() => setSpeed(s)} data-testid={`speed-${s}`} aria-pressed={speed === s}>{s}×</Btn>
          ))}
        </div>
        <Rule />
        <div className="flex items-center gap-1">
          <Btn onClick={() => toggleDrawer('charts')} active={drawer === 'charts'} data-testid="open-charts">Charts</Btn>
          <Btn onClick={() => toggleDrawer('navaids')} active={drawer === 'navaids'} data-testid="open-navaids">Navaids</Btn>
          <Btn onClick={() => toggleDrawer('settings')} active={drawer === 'settings'} data-testid="open-settings">Settings</Btn>
        </div>
        <Btn tone="red" onClick={endSession} data-testid="end-session">End session</Btn>
      </div>
    </header>
  );
}
