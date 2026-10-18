import { useEffect, useRef } from 'react';
import { useSimStore } from '../store/simStore';
import { useUiStore } from '../store/uiStore';
import { useVoiceSettings } from '../store/voiceSettings';
import { keyLabel } from '../lib/voiceStatus';
import { MOBILE_SECTIONS, panelsOfSection } from './panelMeta';
import type { MobileSection } from './panelMeta';
import { TabbedPanels, useAlertCount } from './GroupView';

/** Large push-to-talk target for the phone layout, shown above the tab bar on every section except Radio (which has its own). */
function PttDock() {
  const session = useSimStore((s) => s.session);
  const voice = useSimStore((s) => s.voice);
  const settings = useVoiceSettings();
  const setSection = useUiStore((s) => s.setMobileSection);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    const ptt = session?.voice?.ptt;
    if (!el || !ptt) return;
    return ptt.bindButton(el);
  }, [session]);
  const disabled = settings.providerId === 'none' || voice.status === 'unsupported' || voice.status === 'permission_denied';
  return (
    <div className="flex shrink-0 items-stretch gap-2 border-t border-atc-border bg-atc-panel-2 px-2 py-1.5" data-testid="ptt-dock">
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        data-testid="ptt-dock-button"
        aria-label="Push to talk"
        className={`flex h-14 min-w-0 flex-1 select-none items-center justify-center gap-2 border font-sans text-[13px] font-semibold uppercase tracking-[0.14em] disabled:opacity-40 ${voice.transmitting ? 'atc-tx border-atc-red bg-atc-red/20 text-atc-red' : 'border-atc-green-dim bg-atc-bg text-atc-green'}`}
      >
        <span className={`inline-block h-3 w-3 ${voice.transmitting ? 'bg-atc-red' : 'bg-atc-green-dim'}`} />
        {voice.transmitting ? 'Transmitting' : disabled ? 'Mic off' : `Hold to talk`}
        <span className="hidden text-[10px] text-atc-muted min-[420px]:inline">{keyLabel(settings.pttKey)}</span>
      </button>
      <button type="button" data-testid="dock-command" className="h-14 w-16 shrink-0 border border-atc-border bg-atc-bg font-sans text-[11px] uppercase tracking-wider text-atc-text" onClick={() => { setSection('radio'); setTimeout(() => window.dispatchEvent(new Event('atc:focus-input')), 50); }}>
        Type
      </button>
    </div>
  );
}

/** Phone layout (below 1024 px): one section at a time (Display / Aircraft / Comms / Radio) above a bottom tab bar. */
export function MobileShell() {
  const section = useUiStore((s) => s.mobileSection);
  const setSection = useUiStore((s) => s.setMobileSection);
  const activeMap = useUiStore((s) => s.mobileActive);
  const setActive = useUiStore((s) => s.setMobileActive);
  const alerts = useAlertCount();
  const tabs = panelsOfSection(section);
  const active = activeMap[section] && tabs.includes(activeMap[section]!) ? activeMap[section]! : tabs[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="mobile-shell">
      <div className="flex min-h-0 flex-1" data-testid={section === 'display' ? 'display-area' : `mobile-${section}`}>
        <TabbedPanels tabs={tabs} active={active} onSelect={(id) => setActive(section, id)} hint={false} />
      </div>
      {section !== 'radio' && <PttDock />}
      <nav role="tablist" aria-label="Sections" className="grid shrink-0 grid-cols-4 border-t border-atc-border bg-atc-panel pb-[env(safe-area-inset-bottom)]">
        {MOBILE_SECTIONS.map((sec) => (
          <button
            key={sec.id}
            type="button"
            role="tab"
            aria-selected={sec.id === section}
            data-testid={`mtab-${sec.id}`}
            onClick={() => setSection(sec.id as MobileSection)}
            className={`relative h-12 border-r border-atc-border font-sans text-[11px] font-semibold uppercase tracking-[0.14em] last:border-r-0 ${sec.id === section ? 'bg-atc-cyan/10 text-atc-cyan shadow-[inset_0_2px_0_var(--color-atc-cyan)]' : 'text-atc-muted'}`}
          >
            {sec.label}
            {sec.id === 'comms' && alerts.count > 0 && <span className={`absolute right-2 top-1.5 min-w-4 px-1 text-[9.5px] leading-4 text-atc-bg ${alerts.critical ? 'atc-blink bg-atc-red' : 'bg-atc-amber'}`}>{alerts.count}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
