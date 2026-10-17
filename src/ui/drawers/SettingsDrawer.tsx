import { useUiStore } from '../store/uiStore';
import { VoiceSettingsForm } from '../components/VoiceSettingsForm';
import { Toggle } from '../components/ui';
import { Drawer } from './Drawer';
import type { SurfaceLayers } from '../display/surfaceRenderer';
import type { RadarLayers } from '../display/radarRenderer';

const SURFACE: Record<keyof SurfaceLayers, string> = {
  labels: 'Aircraft data labels', taxiwayIds: 'Taxiway identifiers', routes: 'Planned taxi routes', trails: 'Movement trails', parking: 'Parking positions', unnamed: 'Unnamed taxi lanes',
};
const RADAR: Record<keyof RadarLayers, string> = {
  rings: 'Range rings', compass: 'Compass rose', approachPaths: 'Approach paths', navaids: 'Navaids', fixes: 'Approach fixes', allFixes: 'All fixes',
  labels: 'Data blocks', history: 'History dots', groundTargets: 'Ground targets', sweep: 'Sweep line (cosmetic)',
};

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const sl = useUiStore((s) => s.surfaceLayers);
  const rl = useUiStore((s) => s.radarLayers);
  const toggleS = useUiStore((s) => s.toggleSurfaceLayer);
  const toggleR = useUiStore((s) => s.toggleRadarLayer);
  return (
    <Drawer title="Settings" onClose={onClose} width="min(520px,96vw)" testId="settings-drawer">
      <div className="flex flex-col gap-6 p-4">
        <VoiceSettingsForm />
        <section>
          <h3 className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Surface display layers</h3>
          <div className="grid grid-cols-2 gap-x-4">
            {(Object.keys(SURFACE) as (keyof SurfaceLayers)[]).map((k) => (
              <Toggle key={k} checked={sl[k]} onChange={() => toggleS(k)} label={SURFACE[k]} />
            ))}
          </div>
        </section>
        <section>
          <h3 className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Radar display layers</h3>
          <div className="grid grid-cols-2 gap-x-4">
            {(Object.keys(RADAR) as (keyof RadarLayers)[]).map((k) => (
              <Toggle key={k} checked={rl[k]} onChange={() => toggleR(k)} label={RADAR[k]} />
            ))}
          </div>
        </section>
        <section className="border-t border-atc-border pt-3 text-[11px] leading-relaxed text-atc-muted">
          <h3 className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-atc-cyan">Keyboard</h3>
          Hold the PTT key to transmit (default Space) · Enter focuses the command box · Esc deselects or closes a panel · 1 / 2 switch Surface / Radar · + / − zoom (radar: change range) · P pause
        </section>
      </div>
    </Drawer>
  );
}
