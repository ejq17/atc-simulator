import { useState } from 'react';
import { useSimStore, recommendedRunways } from '../store/simStore';
import { fetchLiveMetar } from '../../weather/liveWeather';
import { WEATHER_PRESETS, WEATHER_PRESET_IDS, getPresetWeather } from '../../weather/presets';
import type { WeatherPresetId } from '../../weather/presets';
import { windText, altimeterText } from '../lib/format';
import { Btn, Field, LABEL, SELECT } from '../components/ui';
import { Drawer } from './Drawer';

export function WeatherDrawer({ onClose }: { onClose: () => void }) {
  const session = useSimStore((s) => s.session);
  const setWeather = useSimStore((s) => s.setWeather);
  const setRunways = useSimStore((s) => s.setActiveRunways);
  const addNotice = useSimStore((s) => s.addNotice);
  useSimStore((s) => s.rev);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<WeatherPresetId>('clear');
  if (!session) return null;
  const st = session.engine.getState();
  const ends = st.airport.runways.flatMap((r) => r.ends.map((e) => e.id));
  const rec = recommendedRunways(st.weather, st.airport);

  const applyLive = async () => {
    setBusy(true);
    try {
      const live = await fetchLiveMetar('KACY');
      setWeather(live.weather);
      addNotice('info', `Live weather applied: ${live.raw}`);
    } catch (err) {
      addNotice('warn', `Live weather unavailable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const setRwy = (kind: 'landing' | 'departing', end: string) => setRunways({ ...st.activeRunways, [kind]: [end] });

  return (
    <Drawer title="Weather and runways" onClose={onClose} width="min(460px,96vw)" testId="weather-drawer">
      <div className="flex flex-col gap-5 p-4 text-xs">
        <section className="flex flex-col gap-1">
          <span className={LABEL}>Current weather ({st.weather.source})</span>
          <div className="text-[13px] tabular-nums">Wind {windText(st.weather, st.airport.magneticVariationDeg)} · {altimeterText(st.weather.altimeterInHg)} · {st.weather.visibilitySm} SM · {st.weather.flightCategory}</div>
          {st.weather.rawMetar && <code className="break-words text-[11px] text-atc-muted">{st.weather.rawMetar}</code>}
        </section>
        <section className="flex flex-col gap-2">
          <Field label="Simulated weather preset">
            <div className="flex gap-2">
              <select className={SELECT} value={preset} onChange={(e) => setPreset(e.target.value as WeatherPresetId)} aria-label="Weather preset">
                {WEATHER_PRESET_IDS.map((id) => (<option key={id} value={id}>{WEATHER_PRESETS[id].label}</option>))}
              </select>
              <Btn tone="cyan" onClick={() => setWeather(getPresetWeather(preset))}>Apply</Btn>
            </div>
          </Field>
          <p className="text-[11px] text-atc-muted">{WEATHER_PRESETS[preset].description}</p>
          <Btn onClick={applyLive} disabled={busy} className="self-start">{busy ? 'Fetching…' : 'Use live KACY METAR'}</Btn>
        </section>
        <section className="flex flex-col gap-2 border-t border-atc-border pt-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Landing runway">
              <select className={SELECT} value={st.activeRunways.landing[0] ?? ''} onChange={(e) => setRwy('landing', e.target.value)} aria-label="Landing runway">
                {ends.map((e) => (<option key={e} value={e}>{e}</option>))}
              </select>
            </Field>
            <Field label="Departing runway">
              <select className={SELECT} value={st.activeRunways.departing[0] ?? ''} onChange={(e) => setRwy('departing', e.target.value)} aria-label="Departing runway">
                {ends.map((e) => (<option key={e} value={e}>{e}</option>))}
              </select>
            </Field>
          </div>
          <p className="text-[11px] text-atc-muted">{rec.summary}.</p>
          <Btn className="self-start" onClick={() => setRunways({ departing: rec.departing, landing: rec.landing })}>Use recommended ({rec.landing[0]})</Btn>
          <p className="text-[11px] leading-snug text-atc-muted">Changing runways issues a new ATIS letter. Aircraft already cleared keep their clearance; 13/31 and 4/22 intersect, so using both at once is flagged by the safety checks.</p>
        </section>
      </div>
    </Drawer>
  );
}
