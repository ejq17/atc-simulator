import { useUiStore } from '../store/uiStore';
import { VoiceSettingsForm } from '../components/VoiceSettingsForm';
import { Toggle } from '../components/ui';
import { Drawer } from './Drawer';
import type { SurfaceLayers } from '../display/surfaceRenderer';
import { RADAR_LAYER_LABELS } from '../display/radarRenderer';
import type { RadarLayers } from '../display/radarRenderer';

const SURFACE: Record<keyof SurfaceLayers, string> = {
  labels: 'Aircraft data labels', taxiwayIds: 'Taxiway identifiers', routes: 'Planned taxi routes', trails: 'Movement trails', parking: 'Parking positions', unnamed: 'Unnamed taxi lanes',
};
const RADAR = RADAR_LAYER_LABELS;

export function SettingsPanel() {
  const sl = useUiStore((s) => s.surfaceLayers);
  const rl = useUiStore((s) => s.radarLayers);
  const toggleS = useUiStore((s) => s.toggleSurfaceLayer);
  const toggleR = useUiStore((s) => s.toggleRadarLayer);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-6 p-4" data-testid="settings-panel">
        <VoiceSettingsForm />
        <section>
          <h3 className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Surface display layers</h3>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {(Object.keys(SURFACE) as (keyof SurfaceLayers)[]).map((k) => (
              <Toggle key={k} checked={sl[k]} onChange={() => toggleS(k)} label={SURFACE[k]} />
            ))}
          </div>
        </section>
        <section>
          <h3 className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Radar display layers</h3>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {(Object.keys(RADAR) as (keyof RadarLayers)[]).map((k) => (
              <Toggle key={k} checked={rl[k]} onChange={() => toggleR(k)} label={RADAR[k]} />
            ))}
          </div>
        </section>
        <section className="border-t border-atc-border pt-3 text-[11px] leading-relaxed text-atc-muted">
          <h3 className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Keyboard</h3>
          Hold the PTT key to transmit (default Space) · Enter focuses the command box · Esc deselects or closes a panel · 1 / 2 / 3 switch Surface / Radar / Tower · + / − zoom (radar: change range) · P pause
        </section>
      </div>
    </div>
  );
}

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  return (
    <Drawer title="Settings" onClose={onClose} width="min(520px,96vw)" testId="settings-drawer" panel="settings">
      <SettingsPanel />
    </Drawer>
  );
}
