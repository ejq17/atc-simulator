import { useEffect, useMemo, useState } from 'react';
import { game } from '../../game';
import type { FreePlayOptions, ScenarioSummary } from '../../game';
import { loadKacy } from '../../airport';
import type { GameMode, Weather } from '../../sim/types';
import { fetchLiveMetar } from '../../weather/liveWeather';
import { WEATHER_PRESETS, WEATHER_PRESET_IDS, getPresetWeather } from '../../weather/presets';
import type { WeatherPresetId } from '../../weather/presets';
import { formatMhz, windText } from '../lib/format';
import { summariseProvenance } from '../lib/provenance';
import { recommendedRunways, suggestPosition, useSimStore } from '../store/simStore';
import type { PositionChoice, StartOptions, WeatherChoice } from '../store/simStore';
import { AirportGlyph } from '../components/AirportGlyph';
import { VoiceSettingsForm } from '../components/VoiceSettingsForm';
import { Btn, Field, INPUT, LABEL, SELECT, Segmented } from '../components/ui';

const CUSTOM = '__custom__';
type LiveState = { status: 'loading' } | { status: 'ok'; weather: Weather; raw: string } | { status: 'error'; message: string };

const DENSITY = {
  light: { label: 'Light', arrivalsPerHour: 5, departuresPerHour: 5 },
  moderate: { label: 'Moderate', arrivalsPerHour: 10, departuresPerHour: 10 },
  busy: { label: 'Busy', arrivalsPerHour: 18, departuresPerHour: 18 },
} as const;
type Density = keyof typeof DENSITY;

const STARTS: { value: NonNullable<FreePlayOptions['startingScenario']>; label: string }[] = [
  { value: 'quiet', label: 'Quiet ramp' }, { value: 'busy_departures', label: 'Busy departures' },
  { value: 'busy_arrivals', label: 'Busy arrivals' }, { value: 'mixed', label: 'Mixed traffic' },
];

const TYPES = [
  { id: 'C172', label: 'Cessna 172 (light GA)' },
  { id: 'A320', label: 'Airbus A320 (airline)' },
];

function Dots({ n, max = 5 }: { n: number; max?: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`Difficulty ${n} of ${max}`} title={`Difficulty ${n} of ${max}`}>
      {Array.from({ length: max }, (_, i) => (<span key={i} className={`h-1.5 w-3 ${i < n ? 'bg-atc-amber' : 'bg-atc-border'}`} />))}
    </span>
  );
}

function SectionTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2.5 font-sans text-[11px] font-semibold uppercase tracking-[0.2em] text-atc-text">
      <span className="flex h-5 w-5 items-center justify-center border border-atc-cyan/60 text-[10px] text-atc-cyan">{n}</span>
      {children}
    </h2>
  );
}

export function SetupScreen() {
  const airport = useMemo(() => loadKacy(), []);
  const starting = useSimStore((s) => s.starting);
  const startStatus = useSimStore((s) => s.startStatus);
  const startSession = useSimStore((s) => s.startSession);
  const notices = useSimStore((s) => s.notices);
  const dismiss = useSimStore((s) => s.dismissNotice);
  const prev = useSimStore((s) => s.startOptions);

  const scenarios = useMemo(() => game.listScenarios(), []);
  const progress = useMemo(() => game.loadCareerProgress(), []);
  const prov = useMemo(() => summariseProvenance(airport), [airport]);

  const [mode, setMode] = useState<GameMode>(prev?.mode ?? 'free_play');
  const [scenarioId, setScenarioId] = useState<string>(prev?.scenarioId ?? CUSTOM);
  const [aircraftCount, setAircraftCount] = useState(prev?.freePlay.aircraftCount ?? 3);
  const [density, setDensity] = useState<Density>('moderate');
  const [gaPct, setGaPct] = useState(Math.round((prev?.freePlay.gaFraction ?? 0.5) * 100));
  const [maxAircraft, setMaxAircraft] = useState(prev?.freePlay.maxAircraft ?? 8);
  const [types, setTypes] = useState<string[]>(prev?.freePlay.aircraftTypes ?? ['C172', 'A320']);
  const [starting_, setStarting_] = useState<NonNullable<FreePlayOptions['startingScenario']>>(prev?.freePlay.startingScenario ?? 'mixed');
  const [difficulty, setDifficulty] = useState<NonNullable<FreePlayOptions['difficulty']>>(prev?.freePlay.difficulty ?? 'normal');
  const [seedText, setSeedText] = useState(prev?.seed !== undefined ? String(prev.seed) : '');
  const [weatherKey, setWeatherKey] = useState<string>(prev ? (prev.weather.kind === 'preset' ? `preset:${prev.weather.id}` : prev.weather.kind) : 'live');
  const [landing, setLanding] = useState<string>('auto');
  const [departing, setDeparting] = useState<string>('auto');
  const [position, setPosition] = useState<PositionChoice>(prev?.controller ?? 'TWR');
  const [live, setLive] = useState<LiveState>({ status: 'loading' });

  const refreshLive = () => {
    setLive({ status: 'loading' });
    fetchLiveMetar('KACY')
      .then((r) => setLive({ status: 'ok', weather: r.weather, raw: r.raw }))
      .catch((e: unknown) => setLive({ status: 'error', message: e instanceof Error ? e.message : String(e) }));
  };
  useEffect(refreshLive, []);

  const isCustom = mode === 'free_play' && scenarioId === CUSTOM;
  const list: ScenarioSummary[] = useMemo(() => {
    const byMode = scenarios.filter((s) => s.mode === mode);
    return mode === 'career' ? [...byMode].sort((a, b) => (a.careerStep ?? 0) - (b.careerStep ?? 0)) : byMode;
  }, [scenarios, mode]);
  const selected = list.find((s) => s.id === scenarioId);

  // Keep the selection valid when the mode changes.
  useEffect(() => {
    if (mode === 'free_play') return;
    if (!list.some((s) => s.id === scenarioId)) setScenarioId(list.find((s) => isUnlocked(s))?.id ?? list[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selection repair only on mode/list change
  }, [mode, list]);
  useEffect(() => {
    if (mode === 'free_play' && scenarioId !== CUSTOM && !scenarios.some((s) => s.id === scenarioId && s.mode === 'free_play')) setScenarioId(CUSTOM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  // Picking a ready-made scenario adopts its own weather and the controller positions it calls for.
  useEffect(() => {
    if (isCustom) {
      setWeatherKey((k) => (k === 'scenario' ? 'live' : k));
      return;
    }
    if (!scenarioId) return;
    setWeatherKey('scenario');
    try {
      setPosition(suggestPosition(game.buildScenario(scenarioId, airport, { seed: 1 }).controllerPositions));
    } catch {
      /* unknown scenario: keep the current position */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the selected scenario changes
  }, [scenarioId, isCustom]);

  function isUnlocked(s: ScenarioSummary): boolean {
    if (s.mode !== 'career') return true;
    return (s.careerStep ?? 1) <= progress.unlockedStep;
  }

  const weatherChoice: WeatherChoice = weatherKey === 'live' ? { kind: 'live' } : weatherKey === 'scenario' ? { kind: 'scenario' } : { kind: 'preset', id: weatherKey.replace('preset:', '') as WeatherPresetId };
  const previewWx: Weather = weatherChoice.kind === 'preset' ? getPresetWeather(weatherChoice.id) : live.status === 'ok' ? live.weather : getPresetWeather('clear');
  const rec = useMemo(() => recommendedRunways(previewWx, airport), [previewWx, airport]);
  const ends = airport.runways.flatMap((r) => r.ends.map((e) => e.id));
  const canStart = !starting && (isCustom || (!!selected && isUnlocked(selected)));

  const start = () => {
    const seed = seedText.trim() === '' ? undefined : Number(seedText);
    const freePlay: FreePlayOptions = {
      difficulty,
      aircraftCount,
      arrivalsPerHour: DENSITY[density].arrivalsPerHour,
      departuresPerHour: DENSITY[density].departuresPerHour,
      gaFraction: gaPct / 100,
      maxAircraft,
      aircraftTypes: types.length ? types : ['C172'],
      startingScenario: starting_,
    };
    const opts: StartOptions = {
      mode,
      scenarioId: isCustom ? undefined : scenarioId,
      freePlay,
      weather: weatherChoice,
      seed: seed !== undefined && Number.isFinite(seed) ? seed : undefined,
      controller: position,
      runways: landing === 'auto' && departing === 'auto' ? 'auto' : { landing: landing === 'auto' ? rec.landing[0] : landing, departing: departing === 'auto' ? rec.departing[0] : departing },
    };
    void startSession(opts);
  };

  const freqOf = (pos: string) => airport.frequencies.find((f) => f.position === pos);
  const POSITIONS: { value: PositionChoice; label: string; freq: string; note: string }[] = [
    { value: 'TWR', label: 'Tower', freq: formatMhz(freqOf('TWR')?.mhz ?? 0), note: 'Runway clearances, sequencing, handoffs to Ground and Departure.' },
    { value: 'GND', label: 'Ground', freq: formatMhz(freqOf('GND')?.mhz ?? 0), note: 'Taxi routes, hold-short points, runway crossings.' },
    { value: 'TWR+GND', label: 'Tower + Ground', freq: `${formatMhz(freqOf('TWR')?.mhz ?? 0)} + ${formatMhz(freqOf('GND')?.mhz ?? 0)}`, note: 'Both frequencies at once: each call goes out on the addressed aircraft’s frequency.' },
    { value: 'APP', label: 'Approach / Departure', freq: formatMhz(freqOf('APP')?.mhz ?? 0), note: 'Airborne traffic. Surface movement is not controlled from here.' },
    { value: 'CLNC', label: 'Clearance Delivery', freq: formatMhz(freqOf('CLNC')?.mhz ?? 0), note: 'Frequency only: the simulator has no IFR clearance workflow yet.' },
  ];

  return (
    <div className="atc-grid-bg h-full overflow-y-auto" data-testid="setup-screen">
      <div className="mx-auto flex min-h-full max-w-[1280px] flex-col px-6 pb-4 pt-8">
        <header className="mb-7 flex items-end justify-between gap-8 border-b border-atc-border pb-6">
          <div>
            <div className="font-sans text-[11px] uppercase tracking-[0.34em] text-atc-cyan">Atlantic City International · KACY</div>
            <h1 className="mt-2 font-sans text-[34px] font-bold uppercase leading-none tracking-[0.12em] text-atc-text">KACY ATC Simulator</h1>
            <p className="mt-3 max-w-xl font-sans text-[13px] leading-relaxed text-atc-muted">
              Work Tower and Ground at Atlantic City with real FAA runway and taxiway data. Speak or type your clearances; pilots read back, taxi, line up and fly.
              Entertainment and learning software, not ATC training.
            </p>
          </div>
          <AirportGlyph airport={airport} className="hidden h-28 w-auto shrink-0 opacity-90 md:block" />
        </header>

        {notices.map((n) => (
          <div key={n.id} role="alert" className="mb-4 flex items-center justify-between border border-atc-red/70 bg-atc-red/10 px-3 py-2 text-xs text-atc-red">
            <span>{n.text}</span>
            <button type="button" onClick={() => dismiss(n.id)} aria-label="Dismiss" className="px-2">×</button>
          </div>
        ))}

        <div className="grid flex-1 grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          {/* ------------------------------------------------------------------ left: what to play */}
          <div className="flex flex-col gap-8">
            <section>
              <SectionTitle n={1}>Mode</SectionTitle>
              <Segmented<GameMode>
                value={mode}
                onChange={(m) => setMode(m)}
                options={[
                  { value: 'free_play', label: <span data-testid="mode-free">Free play</span> },
                  { value: 'career', label: <span data-testid="mode-career">Career</span> },
                  { value: 'training', label: <span data-testid="mode-training">Training</span> },
                ]}
              />
              <p className="mt-2 text-[11.5px] text-atc-muted">
                {mode === 'free_play' && 'Open-ended sessions: set the traffic yourself, or start from a ready-made scenario.'}
                {mode === 'career' && 'Twelve graded steps. Each unlocks after you complete the one before it.'}
                {mode === 'training' && 'Guided scenarios with step-by-step prompts. Unsafe clearances are refused with an explanation.'}
              </p>
            </section>

            <section>
              <SectionTitle n={2}>{mode === 'free_play' ? 'Scenario' : mode === 'career' ? 'Career step' : 'Lesson'}</SectionTitle>
              <div className="flex flex-col gap-2" role="radiogroup" aria-label="Scenario">
                {mode === 'free_play' && (
                  <ScenarioCard id={CUSTOM} selected={scenarioId === CUSTOM} onSelect={() => setScenarioId(CUSTOM)} title="Custom free play" description="Generated traffic around the settings in step 3: a standing sandbox for Tower and Ground." meta="Open-ended" />
                )}
                {list.map((s) => (
                  <ScenarioCard
                    key={s.id}
                    id={s.id}
                    selected={scenarioId === s.id}
                    onSelect={() => isUnlocked(s) && setScenarioId(s.id)}
                    locked={!isUnlocked(s)}
                    title={s.careerStep ? `${s.careerStep}. ${s.name}` : s.name}
                    description={s.description}
                    meta={s.estimatedMinutes ? `~${s.estimatedMinutes} min` : undefined}
                    difficulty={s.difficulty}
                    done={s.careerStep ? progress.completedSteps.includes(s.careerStep) : false}
                    best={progress.bestScores[s.id]}
                  />
                ))}
                {mode !== 'free_play' && list.length === 0 && (
                  <div className="border border-atc-border bg-atc-panel p-4 text-xs text-atc-muted">No {mode} scenarios are available yet.</div>
                )}
              </div>
            </section>

            {isCustom && (
              <section>
                <SectionTitle n={3}>Traffic</SectionTitle>
                <div className="grid grid-cols-2 gap-x-5 gap-y-4 border border-atc-border bg-atc-panel p-4">
                  <Field label={`Aircraft at start: ${aircraftCount}`}>
                    <input type="range" min={1} max={12} value={aircraftCount} onChange={(e) => setAircraftCount(Number(e.target.value))} className="accent-[#39c5e8]" aria-label="Aircraft count" />
                  </Field>
                  <Field label={`Max aircraft at once: ${maxAircraft}`}>
                    <input type="range" min={2} max={20} value={maxAircraft} onChange={(e) => setMaxAircraft(Number(e.target.value))} className="accent-[#39c5e8]" aria-label="Maximum aircraft" />
                  </Field>
                  <Field label="Traffic density">
                    <Segmented<Density> value={density} onChange={setDensity} options={(Object.keys(DENSITY) as Density[]).map((d) => ({ value: d, label: DENSITY[d].label }))} />
                  </Field>
                  <Field label={`General aviation share: ${gaPct}%`}>
                    <input type="range" min={0} max={100} step={5} value={gaPct} onChange={(e) => setGaPct(Number(e.target.value))} className="accent-[#39c5e8]" aria-label="General aviation share" />
                  </Field>
                  <Field label="Starting situation">
                    <select className={SELECT} value={starting_} onChange={(e) => setStarting_(e.target.value as typeof starting_)} aria-label="Starting situation">
                      {STARTS.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
                    </select>
                  </Field>
                  <Field label="Difficulty" hint="Harder = more pilot readback errors and tighter timing.">
                    <Segmented value={difficulty} onChange={setDifficulty} options={[{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }]} />
                  </Field>
                  <div className="col-span-2">
                    <span className={LABEL}>Aircraft types</span>
                    <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
                      {TYPES.map((t) => (
                        <label key={t.id} className="flex cursor-pointer items-center gap-2 text-xs">
                          <input type="checkbox" className="accent-[#39c5e8]" checked={types.includes(t.id)} onChange={(e) => setTypes((cur) => (e.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id)))} />
                          {t.label}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}
          </div>

          {/* ------------------------------------------------------------------ right: conditions & controls */}
          <div className="flex flex-col gap-8">
            <section>
              <SectionTitle n={isCustom ? 4 : 3}>Conditions</SectionTitle>
              <div className="grid grid-cols-2 gap-x-5 gap-y-4 border border-atc-border bg-atc-panel p-4">
                <div className="col-span-2">
                  <Field label="Weather">
                    <select className={SELECT} value={weatherKey} onChange={(e) => setWeatherKey(e.target.value)} aria-label="Weather" data-testid="weather-select">
                      <option value="live">Live KACY METAR</option>
                      {WEATHER_PRESET_IDS.map((id) => (<option key={id} value={`preset:${id}`}>Simulated: {WEATHER_PRESETS[id].label}</option>))}
                      {!isCustom && <option value="scenario">Scenario default</option>}
                    </select>
                  </Field>
                  <div className="mt-2 text-[11.5px] leading-snug text-atc-muted" data-testid="weather-preview">
                    {weatherChoice.kind === 'live' && live.status === 'loading' && 'Fetching the current KACY METAR…'}
                    {weatherChoice.kind === 'live' && live.status === 'ok' && (<><b className="text-atc-green">Live</b> wind {windText(live.weather, airport.magneticVariationDeg)} (mag), {live.weather.visibilitySm} SM, {live.weather.flightCategory}<br /><code className="text-[10.5px]">{live.raw}</code></>)}
                    {weatherChoice.kind === 'live' && live.status === 'error' && (<span className="text-atc-amber">Live weather unavailable ({live.message}) — the session will fall back to a simulated clear day and tell you so. <button type="button" className="underline" onClick={refreshLive}>Retry</button></span>)}
                    {weatherChoice.kind === 'preset' && <>{WEATHER_PRESETS[weatherChoice.id].description} Wind {windText(previewWx, airport.magneticVariationDeg)} (mag).</>}
                    {weatherChoice.kind === 'scenario' && 'The scenario sets its own weather.'}
                  </div>
                </div>
                <Field label="Landing runway">
                  <select className={SELECT} value={landing} onChange={(e) => setLanding(e.target.value)} aria-label="Landing runway">
                    <option value="auto">Auto · {rec.landing[0]}</option>
                    {ends.map((e) => (<option key={e} value={e}>{e}</option>))}
                  </select>
                </Field>
                <Field label="Departing runway">
                  <select className={SELECT} value={departing} onChange={(e) => setDeparting(e.target.value)} aria-label="Departing runway">
                    <option value="auto">Auto · {rec.departing[0]}</option>
                    {ends.map((e) => (<option key={e} value={e}>{e}</option>))}
                  </select>
                </Field>
                <p className="col-span-2 text-[11px] leading-snug text-atc-muted">
                  {rec.summary}. {!isCustom && 'Ready-made scenarios keep their own runway unless you pick one here.'}
                </p>
                <Field label="Random seed" hint="Same seed + same commands = the same session. Blank = random.">
                  <input className={INPUT} inputMode="numeric" value={seedText} onChange={(e) => setSeedText(e.target.value.replace(/[^0-9]/g, ''))} placeholder="random" aria-label="Random seed" data-testid="seed-input" />
                </Field>
              </div>
            </section>

            <section>
              <SectionTitle n={isCustom ? 5 : 4}>Controller position</SectionTitle>
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Controller position">
                {POSITIONS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    role="radio"
                    aria-checked={position === p.value}
                    data-testid={`position-${p.value}`}
                    onClick={() => setPosition(p.value)}
                    className={`flex items-center justify-between gap-3 border px-3 py-2 text-left transition-colors ${position === p.value ? 'border-atc-cyan bg-atc-cyan/10' : 'border-atc-border bg-atc-panel hover:border-atc-muted'}`}
                  >
                    <span>
                      <span className={`block text-[13px] font-semibold ${position === p.value ? 'text-atc-cyan' : 'text-atc-text'}`}>{p.label}{p.value === 'TWR' && <span className="ml-2 font-sans text-[9.5px] font-normal uppercase tracking-wider text-atc-muted">default</span>}</span>
                      <span className="block text-[11px] leading-snug text-atc-muted">{p.note}</span>
                    </span>
                    <span className="shrink-0 text-[15px] font-semibold tabular-nums text-atc-green">{p.freq}</span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <SectionTitle n={isCustom ? 6 : 5}>Voice and radio</SectionTitle>
              <div className="border border-atc-border bg-atc-panel p-4"><VoiceSettingsForm /></div>
            </section>
          </div>
        </div>

        <div className="sticky bottom-0 -mx-6 mt-8 flex items-center justify-between gap-4 border-t border-atc-border bg-atc-bg/95 px-6 py-3 backdrop-blur">
          <div className="text-xs text-atc-muted" aria-live="polite">
            {starting ? <span className="text-atc-cyan">{startStatus || 'Starting…'}</span> : selected && !isCustom ? <>Ready: <b className="text-atc-text">{selected.name}</b> at <b className="text-atc-text">{POSITIONS.find((p) => p.value === position)?.label}</b></> : <>Ready: <b className="text-atc-text">Custom free play</b> at <b className="text-atc-text">{POSITIONS.find((p) => p.value === position)?.label}</b></>}
          </div>
          <Btn tone="green" size="md" onClick={start} disabled={!canStart} data-testid="start-session" className="min-w-44 !text-[13px] font-bold tracking-[0.2em]">
            {starting ? 'Starting…' : 'Start session'}
          </Btn>
        </div>

        <footer className="mt-4 border-t border-atc-border pt-3 text-[10.5px] leading-relaxed text-atc-muted" data-testid="provenance-footer">
          <div>{prov.footer}</div>
          <div>Not for navigation or real-world ATC use. ATIS and radio traffic are simulated; live METARs come from the Aviation Weather Center through the local backend.</div>
        </footer>
      </div>
    </div>
  );
}

function ScenarioCard({ id, selected, onSelect, title, description, meta, difficulty, locked, done, best }: {
  id: string; selected: boolean; onSelect: () => void; title: string; description: string; meta?: string; difficulty?: number; locked?: boolean; done?: boolean; best?: number;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={locked}
      disabled={locked}
      data-testid={`scenario-${id}`}
      onClick={onSelect}
      className={`flex flex-col gap-1 border p-3 text-left transition-colors disabled:cursor-not-allowed ${selected ? 'border-atc-cyan bg-atc-cyan/10' : 'border-atc-border bg-atc-panel hover:border-atc-muted'} ${locked ? 'opacity-45' : ''}`}
    >
      <span className="flex items-center justify-between gap-3">
        <span className={`text-[14px] font-semibold ${selected ? 'text-atc-cyan' : 'text-atc-text'}`}>
          {locked && <span aria-hidden="true" className="mr-1.5">🔒</span>}{title}
          {done && <span className="ml-2 border border-atc-green-dim px-1 font-sans text-[9.5px] font-normal uppercase tracking-wider text-atc-green">completed{best !== undefined ? ` · best ${best}` : ''}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-3 text-[10.5px] text-atc-muted">{meta}{difficulty !== undefined && <Dots n={difficulty} />}</span>
      </span>
      <span className="font-sans text-[12px] leading-snug text-atc-muted">{description}{locked && ' Complete the previous step to unlock.'}</span>
    </button>
  );
}
