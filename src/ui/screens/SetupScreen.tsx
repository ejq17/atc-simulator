import { useEffect, useMemo, useRef, useState } from 'react';
import { game } from '../../game';
import type { FreePlayOptions, ScenarioSummary } from '../../game';
import type { ClosureSpec } from '../../sim/types';
import { closedEndsOf } from '../../sim/airportOps';
import { DEFAULT_AIRPORT_ICAO, airportOrDefault, isAirportLoaded, listAirportOptions, preloadAirport } from '../../airport';
import { airportCallName } from '../../radio/frequencies';
import { towerClosedNotice, towerHoursLabel } from '../../game/towerHours';
import { profileTypes, rateScaleFor, trafficDefaultsFor } from '../../game/airportProfile';
import { SPECIAL_TRAFFIC_KINDS, SPECIAL_TRAFFIC_LABELS, availableSpecialKinds, defaultSpecialTraffic, resolveSpecialTraffic } from '../../game/specialTraffic';
import type { SpecialTrafficSelection } from '../../game/specialTraffic';
import type { ControllerPositionId, GameMode, Weather } from '../../sim/types';
import { fetchLiveMetar } from '../../weather/liveWeather';
import { WEATHER_PRESETS, WEATHER_PRESET_IDS, getPresetWeather } from '../../weather/presets';
import type { WeatherPresetId } from '../../weather/presets';
import { formatMhz, windText } from '../lib/format';
import { summariseProvenance } from '../lib/provenance';
import { recommendedRunways, useSimStore } from '../store/simStore';
import type { StartOptions, WeatherChoice } from '../store/simStore';
import { POSITION_CHOICES, POSITION_LABEL, POSITION_NOTE, POSITION_ORDER, aiPositionsFor, choiceFromPositions, frequencyRows, positionListText, rowLabel, suggestPosition } from '../lib/positions';
import type { PositionChoice } from '../lib/positions';
import { AirportGlyph } from '../components/AirportGlyph';
import { VoiceSettingsForm } from '../components/VoiceSettingsForm';
import { Btn, Field, INPUT, LABEL, SELECT, Segmented } from '../components/ui';

const CUSTOM = '__custom__';
type LiveState = { status: 'loading' } | { status: 'ok'; weather: Weather; raw: string; source?: 'awc-backend' | 'nws-direct' } | { status: 'error'; message: string };

const DENSITY = {
  light: { label: 'Light', arrivalsPerHour: 5, departuresPerHour: 5 },
  moderate: { label: 'Moderate', arrivalsPerHour: 10, departuresPerHour: 10 },
  busy: { label: 'Busy', arrivalsPerHour: 18, departuresPerHour: 18 },
} as const;
type Density = keyof typeof DENSITY;
/** Setup-screen hourly rate of a density level at an airport: the generic level scaled by how busy the real airport is (profile `rateScaleFor`; KACY and KMHT 1). */
function densityRate(level: Density, icao: string, kind: 'arrivalsPerHour' | 'departuresPerHour'): number {
  return Math.max(1, Math.round(DENSITY[level][kind] * rateScaleFor(icao)));
}

const STARTS: { value: NonNullable<FreePlayOptions['startingScenario']>; label: string }[] = [
  { value: 'quiet', label: 'Quiet ramp' }, { value: 'busy_departures', label: 'Busy departures' },
  { value: 'busy_arrivals', label: 'Busy arrivals' }, { value: 'mixed', label: 'Mixed traffic' },
];

const TYPES = [
  { id: 'C172', label: 'Cessna 172 (light GA)' },
  { id: 'A320', label: 'Airbus A320 (airline)' },
  { id: 'B738', label: 'Boeing 737-800 (airline)' },
  { id: 'BCS3', label: 'Airbus A220-300 (airline)' },
  { id: 'E175', label: 'Embraer 175 (regional jet)' },
  { id: 'CRJ9', label: 'CRJ-900 (regional jet)' },
  { id: 'B752', label: 'Boeing 757-200 (cargo)' },
  { id: 'C208', label: 'Cessna 208 Caravan (feeder)' },
  { id: 'A319', label: 'Airbus A319 (airline)' },
  { id: 'A321', label: 'Airbus A321 (airline)' },
  { id: 'A20N', label: 'Airbus A320neo (airline)' },
  { id: 'A21N', label: 'Airbus A321neo (airline)' },
  { id: 'B737', label: 'Boeing 737-700 (airline)' },
  { id: 'B38M', label: 'Boeing 737 MAX 8 (airline)' },
  { id: 'B739', label: 'Boeing 737-900 (airline)' },
  { id: 'E190', label: 'Embraer 190 (regional jet)' },
  { id: 'CRJ7', label: 'CRJ-700 (regional jet)' },
  { id: 'DH8D', label: 'Dash 8 Q400 (regional turboprop)' },
  { id: 'B762', label: 'Boeing 767-200 (heavy)' },
  { id: 'B763', label: 'Boeing 767-300 (heavy)' },
  { id: 'A306', label: 'Airbus A300-600 (cargo, heavy)' },
  { id: 'B772', label: 'Boeing 777-200 (heavy)' },
  { id: 'B77W', label: 'Boeing 777-300ER (heavy)' },
  { id: 'B788', label: 'Boeing 787-8 (heavy)' },
  { id: 'B789', label: 'Boeing 787-9 (heavy)' },
  { id: 'A332', label: 'Airbus A330-200 (heavy)' },
  { id: 'A333', label: 'Airbus A330-300 (heavy)' },
  { id: 'A339', label: 'Airbus A330-900 (heavy)' },
  { id: 'A359', label: 'Airbus A350-900 (heavy)' },
  { id: 'A35K', label: 'Airbus A350-1000 (heavy)' },
  { id: 'A388', label: 'Airbus A380-800 (super)' },
  { id: 'B744', label: 'Boeing 747-400 (heavy)' },
  { id: 'B748', label: 'Boeing 747-8 (heavy)' },
  { id: 'MD11', label: 'McDonnell Douglas MD-11 (cargo, heavy)' },
  { id: 'C402', label: 'Cessna 402C (commuter piston twin)' },
  { id: 'BE20', label: 'King Air 200 (turboprop twin)' },
  { id: 'BE9L', label: 'King Air 90 (turboprop twin)' },
  { id: 'PC12', label: 'Pilatus PC-12 (turboprop single)' },
  { id: 'C56X', label: 'Citation Excel (business jet)' },
  { id: 'CL35', label: 'Challenger 350 (business jet)' },
  { id: 'GLF5', label: 'Gulfstream V (business jet)' },
  { id: 'GLEX', label: 'Global Express (business jet)' },
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

/** `nowMs`: the real clock used for the tower-hours notice (tests pass a fixed instant). */
export function SetupScreen({ nowMs }: { nowMs?: number } = {}) {
  const initialIcao = useSimStore((s) => s.startOptions?.icao) ?? DEFAULT_AIRPORT_ICAO;
  const [ready, setReady] = useState(() => isAirportLoaded(initialIcao));
  useEffect(() => {
    if (ready) return;
    let live = true;
    // Airport data is a lazy chunk per airport; the setup screen needs the initial airport before it can render.
    preloadAirport(initialIcao).catch(() => preloadAirport(DEFAULT_AIRPORT_ICAO)).then(() => live && setReady(true), () => live && setReady(true));
    return () => { live = false; };
  }, [ready, initialIcao]);
  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center font-sans text-[12px] uppercase tracking-[0.2em] text-atc-muted" role="status" data-testid="airport-loading">Loading airport data…</div>
    );
  }
  return <SetupForm nowMs={nowMs} initialIcao={initialIcao} />;
}

function SetupForm({ nowMs, initialIcao }: { nowMs?: number; initialIcao: string }) {
  const prev = useSimStore((s) => s.startOptions);
  /** The airport the screen shows (its data is loaded); `chosenIcao` is the selector value, ahead of it while that airport's chunk downloads. */
  const [icao, setIcao] = useState<string>(initialIcao);
  const [chosenIcao, setChosenIcao] = useState<string>(initialIcao);
  const loadingAirport = chosenIcao !== icao;
  const chooseAirport = (code: string) => {
    setChosenIcao(code);
    if (isAirportLoaded(code)) { setIcao(code); return; }
    preloadAirport(code).then(() => setChosenIcao((cur) => { if (cur === code) setIcao(code); return cur; }), () => setChosenIcao((cur) => (cur === code ? icao : cur)));
  };
  const airport = useMemo(() => airportOrDefault(icao), [icao]);
  const callName = airportCallName(airport);
  const [openedAtMs] = useState(() => nowMs ?? Date.now());
  const hoursLabel = towerHoursLabel(airport.towerHours);
  const towerClosed = towerClosedNotice(airport, callName, openedAtMs);
  /** Aircraft types the airport's traffic profile can generate (KACY: C172, A320; KMHT adds B738, BCS3, E175, CRJ9, B752, C208; KPGD: A320, A319, B38M, B738, C172, PA28; the registry also holds the KBOS / KPHL / EGLL types). */
  const offeredTypes = useMemo(() => profileTypes(airport.icao), [airport]);
  /** Special traffic kinds the airport's profile has (KACY: all five; KMHT and KPGD: VFR transitions and vehicles; KPHL: vehicles only, Class B). Only these are offered. */
  const offeredSpecial = useMemo(() => availableSpecialKinds(airport.icao), [airport]);
  const starting = useSimStore((s) => s.starting);
  const startStatus = useSimStore((s) => s.startStatus);
  const startSession = useSimStore((s) => s.startSession);
  const notices = useSimStore((s) => s.notices);
  const dismiss = useSimStore((s) => s.dismissNotice);

  const [ifrFlows, setIfrFlows] = useState<boolean>(!!prev?.freePlay.ifrFlows);
  const scenarios = useMemo(() => game.listScenarios(icao), [icao]);
  const authoredElsewhere = useMemo(() => game.listScenarios().filter((s) => s.airports && !s.airports.includes(icao)), [icao]);
  const progress = useMemo(() => game.loadCareerProgress(), []);
  const prov = useMemo(() => summariseProvenance(airport), [airport]);
  /**
   * Positions each ready-made scenario has (`scenario.controllerPositions`) and the ones the player works by default
   * (`scenario.playerPositions`: the position a lesson is about; free play: unset, the setup suggests Tower).
   */
  const { needs, playerDefaults } = useMemo(() => {
    const m = new Map<string, ControllerPositionId[]>();
    const d = new Map<string, ControllerPositionId[]>();
    for (const sc of scenarios) {
      try {
        const built = game.buildScenario(sc.id, airport, { seed: 1, ...(sc.mode === 'free_play' ? { ifrFlows } : {}) });
        m.set(sc.id, built.controllerPositions);
        if (built.playerPositions) d.set(sc.id, built.playerPositions);
      } catch {
        /* unknown / unbuildable scenario: no positions shown */
      }
    }
    try {
      m.set(CUSTOM, game.buildFreePlay(airport, { seed: 1, ifrFlows }).controllerPositions);
    } catch {
      /* ignore */
    }
    return { needs: m, playerDefaults: d };
  }, [scenarios, airport, ifrFlows]);

  const [mode, setMode] = useState<GameMode>(prev?.mode ?? 'free_play');
  const [scenarioId, setScenarioId] = useState<string>(prev?.scenarioId ?? CUSTOM);
  const [aircraftCount, setAircraftCount] = useState(prev?.freePlay.aircraftCount ?? 3);
  const [density, setDensity] = useState<Density>('moderate');
  const [gaPct, setGaPct] = useState(Math.round((prev?.freePlay.gaFraction ?? trafficDefaultsFor(prev?.icao ?? initialIcao).gaFraction) * 100));
  const [patternWork, setPatternWork] = useState<boolean>(prev?.freePlay.patternWork ?? trafficDefaultsFor(prev?.icao ?? initialIcao).patternWork);
  const [maxAircraft, setMaxAircraft] = useState(prev?.freePlay.maxAircraft ?? 8);
  const [types, setTypes] = useState<string[]>(prev?.freePlay.aircraftTypes ?? TYPES.map((t) => t.id));
  const [special, setSpecial] = useState<SpecialTrafficSelection>(() => resolveSpecialTraffic(prev?.icao ?? DEFAULT_AIRPORT_ICAO, prev?.freePlay.specialTraffic ?? defaultSpecialTraffic(prev?.icao ?? DEFAULT_AIRPORT_ICAO)));
  const [starting_, setStarting_] = useState<NonNullable<FreePlayOptions['startingScenario']>>(prev?.freePlay.startingScenario ?? 'mixed');
  const [difficulty, setDifficulty] = useState<NonNullable<FreePlayOptions['difficulty']>>(prev?.freePlay.difficulty ?? 'normal');
  const [pilotRealism, setPilotRealism] = useState<NonNullable<FreePlayOptions['pilotRealism']>>(prev?.freePlay.pilotRealism ?? 'moderate');
  const [seedText, setSeedText] = useState(prev?.seed !== undefined ? String(prev.seed) : '');
  const [weatherKey, setWeatherKey] = useState<string>(prev ? (prev.weather.kind === 'preset' ? `preset:${prev.weather.id}` : prev.weather.kind) : 'live');
  const [closeRunway, setCloseRunway] = useState<string>('none');
  const [closeTaxiway, setCloseTaxiway] = useState<string>('none');
  const [airportEvents, setAirportEvents] = useState<boolean>(prev?.freePlay.airportEvents !== false);
  const [landing, setLanding] = useState<string>('auto');
  const [departing, setDeparting] = useState<string>('auto');
  /** Published runway configuration id, or 'auto' (airports with `runwayConfigurations` only). */
  const [configId, setConfigId] = useState<string>('auto');
  const [position, setPosition] = useState<PositionChoice>(prev?.controller ?? 'TWR');
  const [aiOn, setAiOn] = useState<boolean>(prev?.ai ?? true);
  const [realTime, setRealTime] = useState<boolean>(prev?.realTime ?? true);
  const [live, setLive] = useState<LiveState>({ status: 'loading' });

  const refreshLive = () => {
    setLive({ status: 'loading' });
    fetchLiveMetar(icao)
      .then((r) => setLive({ status: 'ok', weather: r.weather, raw: r.raw, source: r.source }))
      .catch((e: unknown) => setLive({ status: 'error', message: e instanceof Error ? e.message : String(e) }));
  };
  useEffect(refreshLive, [icao]);
  // Another airport: runway overrides and a scenario of the previous airport no longer apply.
  const lastIcao = useRef(icao);
  useEffect(() => {
    if (lastIcao.current === icao) return;
    lastIcao.current = icao;
    setLanding('auto');
    setDeparting('auto');
    setConfigId('auto');
    setCloseRunway('none');
    setCloseTaxiway('none');
    setScenarioId(CUSTOM);
    setMode('free_play');
    setSpecial(defaultSpecialTraffic(icao));
    setGaPct(Math.round(trafficDefaultsFor(icao).gaFraction * 100));
    setPatternWork(trafficDefaultsFor(icao).patternWork);
  }, [icao]);

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
  const mounted = useRef(false);
  useEffect(() => {
    const changed = mounted.current; // false on the first run: keep what a previous session (Play again) chose
    mounted.current = true;
    if (isCustom) {
      setWeatherKey((k) => (k === 'scenario' ? 'live' : k));
      // Custom free play: Tower, and AI works the rest (all five positions when IFR flows are on).
      if (changed) setPosition(ifrFlows ? 'ALL' : 'TWR');
      return;
    }
    if (!scenarioId) return;
    setWeatherKey('scenario');
    // The position the scenario is about (Ground lessons: Ground only); free play: Tower, with AI on the rest.
    const own = playerDefaults.get(scenarioId);
    const wanted = needs.get(scenarioId);
    if (own) setPosition(choiceFromPositions(own));
    else if (selectedMode(scenarioId) === 'free_play') setPosition('TWR');
    else if (wanted) setPosition(suggestPosition(wanted));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the selected scenario changes
  }, [scenarioId, isCustom]);

  function selectedMode(id: string): GameMode | undefined {
    return scenarios.find((x) => x.id === id)?.mode;
  }

  function isUnlocked(s: ScenarioSummary): boolean {
    if (s.mode !== 'career') return true;
    return (s.careerStep ?? 1) <= progress.unlockedStep;
  }

  const weatherChoice: WeatherChoice = weatherKey === 'live' ? { kind: 'live' } : weatherKey === 'scenario' ? { kind: 'scenario' } : { kind: 'preset', id: weatherKey.replace('preset:', '') as WeatherPresetId };
  const previewWx: Weather = weatherChoice.kind === 'preset' ? getPresetWeather(weatherChoice.id) : live.status === 'ok' ? live.weather : getPresetWeather('clear');
  const closedEnds = useMemo(() => closedEndsOf(airport, closeRunway !== 'none' ? [{ kind: 'RUNWAY', ident: closeRunway }] : []), [airport, closeRunway]);
  const rec = useMemo(() => recommendedRunways(previewWx, airport, closedEnds), [previewWx, airport, closedEnds]);
  const ends = airport.runways.flatMap((r) => r.ends.map((e) => e.id));
  const configs = airport.runwayConfigurations ?? [];
  const hasConfigs = configs.length > 0;
  const chosenConfig = configs.find((c) => c.id === configId);
  const taxiwayNames = useMemo(() => [...new Set(airport.taxiwayGraph.edges.map((e) => e.taxiway.toUpperCase()).filter((t) => !/^RWY/i.test(t)))].sort(), [airport]);
  const closures: ClosureSpec[] = [
    ...(closeRunway !== 'none' ? [{ kind: 'RUNWAY' as const, ident: closeRunway, reason: 'closed for the session (setup option)' }] : []),
    ...(closeTaxiway !== 'none' ? [{ kind: 'TAXIWAY' as const, ident: closeTaxiway, reason: 'closed for the session (setup option)' }] : []),
  ];
  const canStart = !starting && !loadingAirport && (isCustom || (!!selected && isUnlocked(selected)));

  const start = () => {
    const seed = seedText.trim() === '' ? undefined : Number(seedText);
    const freePlay: FreePlayOptions = {
      ifrFlows,
      difficulty,
      pilotRealism,
      aircraftCount,
      arrivalsPerHour: densityRate(density, airport.icao, 'arrivalsPerHour'),
      departuresPerHour: densityRate(density, airport.icao, 'departuresPerHour'),
      gaFraction: gaPct / 100,
      patternWork,
      maxAircraft,
      aircraftTypes: offeredTypes.filter((t) => types.includes(t)).length ? offeredTypes.filter((t) => types.includes(t)) : ['C172'],
      specialTraffic: resolveSpecialTraffic(airport.icao, special),
      startingScenario: starting_,
      closures,
      airportEvents,
    };
    const opts: StartOptions = {
      icao,
      mode,
      scenarioId: isCustom ? undefined : scenarioId,
      freePlay,
      weather: weatherChoice,
      seed: seed !== undefined && Number.isFinite(seed) ? seed : undefined,
      controller: position,
      ai: aiOn,
      realTime,
      runways: chosenConfig ? { landing: chosenConfig.landing, departing: chosenConfig.departing } : hasConfigs || (landing === 'auto' && departing === 'auto') ? 'auto' : { landing: landing === 'auto' ? rec.landing[0] : landing, departing: departing === 'auto' ? rec.departing[0] : departing },
    };
    void startSession(opts);
  };

  const scenarioNeeds: ControllerPositionId[] | undefined = needs.get(isCustom ? CUSTOM : scenarioId);
  const suggested: PositionChoice | undefined = scenarioNeeds ? (playerDefaults.get(scenarioId) ? choiceFromPositions(playerDefaults.get(scenarioId)!) : suggestPosition(scenarioNeeds)) : undefined;
  /** Positions that exist in the session but are not the player's; AI works them when "AI works the rest" is on. */
  const aiWorks: ControllerPositionId[] = scenarioNeeds ? aiPositionsFor(scenarioNeeds, POSITION_CHOICES[position]) : [];
  const POSITIONS = POSITION_ORDER.map((value) => {
    const rows = frequencyRows(airport, POSITION_CHOICES[value]);
    const rest = scenarioNeeds ? aiPositionsFor(scenarioNeeds, POSITION_CHOICES[value]) : [];
    return { value, label: POSITION_LABEL[value], rows, note: POSITION_NOTE[value], rest };
  });

  return (
    <div className="atc-grid-bg h-full overflow-y-auto" data-testid="setup-screen">
      <div className="mx-auto flex min-h-full max-w-[1280px] flex-col px-4 pb-4 pt-6 sm:px-6 sm:pt-8">
        <header className="mb-6 flex items-end justify-between gap-8 border-b border-atc-border pb-6">
          <div>
            <div className="font-sans text-[11px] uppercase tracking-[0.34em] text-atc-cyan">{airport.name} · {airport.icao}</div>
            <h1 className="mt-2 font-sans text-[26px] font-bold uppercase leading-none tracking-[0.08em] sm:text-[34px] sm:tracking-[0.12em] text-atc-text">{airport.icao} ATC Simulator</h1>
            <p className="mt-3 max-w-xl font-sans text-[13px] leading-relaxed text-atc-muted">
              Work Clearance Delivery, Ground, Tower, Departure and Approach at {callName} with real runway, taxiway and procedure data (FAA, or the UK AIP for Heathrow). Speak or type your clearances; pilots read back, taxi, line up and fly.
              Entertainment and learning software, not ATC training.
            </p>
            <label className="mt-4 flex items-center gap-3">
              <span className={LABEL}>Airport</span>
              <select className={SELECT} value={chosenIcao} onChange={(e) => chooseAirport(e.target.value)} aria-label="Airport" data-testid="airport-select">
                {listAirportOptions().map(({ icao: code, name }) => (<option key={code} value={code}>{code} · {name}</option>))}
              </select>
              {loadingAirport && <span className="font-sans text-[11px] text-atc-cyan" role="status" data-testid="airport-loading">Loading airport data…</span>}
              {hoursLabel && <span className="font-sans text-[11px] text-atc-muted" data-testid="tower-hours">Tower hours {hoursLabel}</span>}
            </label>
            {towerClosed && <p className="mt-2 max-w-xl font-sans text-[12px] leading-relaxed text-atc-amber" role="status" data-testid="tower-closed-notice">{towerClosed}</p>}
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
                  <ScenarioCard id={CUSTOM} selected={scenarioId === CUSTOM} onSelect={() => setScenarioId(CUSTOM)} title="Custom free play" description="Generated traffic around the settings in step 3: a standing sandbox for whichever positions you work." meta="Open-ended" />
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
                    meta={[needs.get(s.id)?.length ? needs.get(s.id)!.join(' · ') : '', s.estimatedMinutes ? `~${s.estimatedMinutes} min` : ''].filter(Boolean).join('  ·  ') || undefined}
                    difficulty={s.difficulty}
                    done={s.careerStep ? progress.completedSteps.includes(s.careerStep) : false}
                    best={progress.bestScores[s.id]}
                  />
                ))}
                {mode === 'free_play' && (
                  <label className="flex cursor-pointer items-start gap-2.5 border border-atc-border bg-atc-panel p-3" data-testid="ifr-flows-option">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[#39c5e8]"
                      checked={ifrFlows}
                      aria-label="IFR flows"
                      data-testid="ifr-flows"
                      onChange={(e) => {
                        setIfrFlows(e.target.checked);
                        // IFR flows span Clearance Delivery to Approach: offer the full set unless the player already picked one that covers it.
                        if (e.target.checked && !POSITION_CHOICES[position].includes('CLNC')) setPosition('ALL');
                      }}
                    />
                    <span>
                      <span className="block text-[13px] font-semibold text-atc-text">IFR flows</span>
                      <span className="block text-[11.5px] leading-snug text-atc-muted">
                        Airline departures call Clearance Delivery for an IFR clearance first, and arrivals check in with Approach at a fix and wait for vectors and an approach clearance.
                        Works best with All positions (or Approach + Tower).
                      </span>
                    </span>
                  </label>
                )}
                {mode !== 'free_play' && list.length === 0 && (
                  <div className="border border-atc-border bg-atc-panel p-4 text-xs text-atc-muted" data-testid="no-scenarios">
                    {authoredElsewhere.some((s) => s.mode === mode)
                      ? `The ${mode === 'career' ? 'career steps' : 'training lessons'} are written around ${authoredElsewhere.find((s) => s.mode === mode)!.airports!.join(', ')} (its real runway ends, taxiway names and parking stands) and are not offered at ${icao}. Use Free play here.`
                      : `No ${mode} scenarios are available yet.`}
                  </div>
                )}
              </div>
            </section>

            {isCustom && (
              <section>
                <SectionTitle n={3}>Traffic</SectionTitle>
                <div className="grid grid-cols-1 gap-x-5 gap-y-4 border sm:grid-cols-2 border-atc-border bg-atc-panel p-4">
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
                    <input type="range" min={0} max={100} step={1} value={gaPct} onChange={(e) => setGaPct(Number(e.target.value))} className="accent-[#39c5e8]" aria-label="General aviation share" />
                  </Field>
                  {offeredTypes.includes('C172') && (
                    <label className="col-span-2 flex cursor-pointer items-start gap-2 text-xs">
                      <input type="checkbox" data-testid="pattern-work" className="mt-0.5 accent-[#39c5e8]" checked={patternWork} onChange={(e) => setPatternWork(e.target.checked)} />
                      <span>
                        Pattern work
                        <span className="block text-[11px] leading-snug text-atc-muted">Touch-and-go requests and closed traffic. Off by default where the airport has none (Class B hubs).</span>
                      </span>
                    </label>
                  )}
                  <Field label="Starting situation">
                    <select className={SELECT} value={starting_} onChange={(e) => setStarting_(e.target.value as typeof starting_)} aria-label="Starting situation">
                      {STARTS.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
                    </select>
                  </Field>
                  <Field label="Difficulty" hint="Harder = more traffic and a steeper ramp over time.">
                    <Segmented value={difficulty} onChange={setDifficulty} options={[{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }]} />
                  </Field>
                  <Field label="Pilot realism" hint="Readback mistakes, slow or missed calls, blocked transmissions, student pilots, requests. Career steps ramp it up; training lessons are always clean.">
                    <Segmented value={pilotRealism} onChange={setPilotRealism} options={[{ value: 'off', label: 'Off' }, { value: 'light', label: 'Light' }, { value: 'moderate', label: 'Moderate' }, { value: 'heavy', label: 'Heavy' }]} />
                  </Field>
                  <div className="col-span-2">
                    <span className={LABEL}>Aircraft types</span>
                    <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
                      {TYPES.filter((t) => offeredTypes.includes(t.id)).map((t) => (
                        <label key={t.id} className="flex cursor-pointer items-center gap-2 text-xs">
                          <input type="checkbox" className="accent-[#39c5e8]" checked={types.includes(t.id)} onChange={(e) => setTypes((cur) => (e.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id)))} />
                          {t.label}
                        </label>
                      ))}
                    </div>
                  </div>
                  {offeredSpecial.length > 0 && (
                    <div className="col-span-2" role="group" aria-labelledby="special-traffic-label" data-testid="special-traffic">
                      <span id="special-traffic-label" className={LABEL}>Special traffic</span>
                      <div className="mt-1.5 grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">
                        {SPECIAL_TRAFFIC_KINDS.filter((k) => offeredSpecial.includes(k)).map((k) => (
                          <label key={k} className="flex cursor-pointer items-start gap-2 text-xs">
                            <input
                              type="checkbox"
                              className="mt-0.5 accent-[#39c5e8]"
                              checked={special[k]}
                              onChange={(e) => setSpecial((cur) => ({ ...cur, [k]: e.target.checked }))}
                              data-testid={`special-${k}`}
                            />
                            <span>
                              {SPECIAL_TRAFFIC_LABELS[k].label}
                              <span className="block text-[11px] leading-snug text-atc-muted">{SPECIAL_TRAFFIC_LABELS[k].hint}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>

          {/* ------------------------------------------------------------------ right: conditions & controls */}
          <div className="flex flex-col gap-8">
            <section>
              <SectionTitle n={isCustom ? 4 : 3}>Conditions</SectionTitle>
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 border sm:grid-cols-2 border-atc-border bg-atc-panel p-4">
                <div className="col-span-2">
                  <Field label="Weather">
                    <select className={SELECT} value={weatherKey} onChange={(e) => setWeatherKey(e.target.value)} aria-label="Weather" data-testid="weather-select">
                      <option value="live">Live {icao} METAR</option>
                      {WEATHER_PRESET_IDS.map((id) => (<option key={id} value={`preset:${id}`}>Simulated: {WEATHER_PRESETS[id].label}</option>))}
                      {!isCustom && <option value="scenario">Scenario default</option>}
                    </select>
                  </Field>
                  <div className="mt-2 text-[11.5px] leading-snug text-atc-muted" data-testid="weather-preview">
                    {weatherChoice.kind === 'live' && live.status === 'loading' && `Fetching the current ${icao} METAR…`}
                    {weatherChoice.kind === 'live' && live.status === 'ok' && (<><b className="text-atc-green">Live</b>{live.source ? ` (${live.source === 'nws-direct' ? 'National Weather Service' : 'Aviation Weather Center'})` : ''} wind {windText(live.weather, airport.magneticVariationDeg)} (mag), {live.weather.visibilitySm} SM, {live.weather.flightCategory}<br /><code className="text-[10.5px]">{live.raw}</code></>)}
                    {weatherChoice.kind === 'live' && live.status === 'error' && (<span className="text-atc-amber">Live weather unavailable ({live.message}) — the session will fall back to a simulated clear day and tell you so. <button type="button" className="underline" onClick={refreshLive}>Retry</button></span>)}
                    {weatherChoice.kind === 'preset' && <>{WEATHER_PRESETS[weatherChoice.id].description} Wind {windText(previewWx, airport.magneticVariationDeg)} (mag).</>}
                    {weatherChoice.kind === 'scenario' && 'The scenario sets its own weather.'}
                  </div>
                </div>
                {hasConfigs ? (
                  <Field label="Runway configuration" hint="Published use of the runways (arrivals / departures). Auto picks the one the wind favours; ready-made scenarios keep their own runways unless you pick one here.">
                    <select className={SELECT} value={configId} onChange={(e) => setConfigId(e.target.value)} aria-label="Runway configuration" data-testid="runway-configuration">
                      <option value="auto">Auto · {rec.landing.join('/')} arr, {rec.departing.join('/')} dep</option>
                      {configs.map((c) => {
                        const closed = [...c.landing, ...c.departing].some((e) => closedEnds.includes(e));
                        return (<option key={c.id} value={c.id} disabled={closed}>{c.name}: arr {c.landing.join('/')}, dep {c.departing.join('/')}{closed ? ' (closed runway)' : ''}</option>);
                      })}
                    </select>
                  </Field>
                ) : (
                  <>
                  <Field label="Landing runway">
                    <select className={SELECT} value={landing} onChange={(e) => setLanding(e.target.value)} aria-label="Landing runway">
                      <option value="auto">Auto · {rec.landing[0]}</option>
                      {ends.map((e) => (<option key={e} value={e} disabled={closedEnds.includes(e)}>{e}{closedEnds.includes(e) ? ' (closed)' : ''}</option>))}
                    </select>
                  </Field>
                  <Field label="Departing runway">
                    <select className={SELECT} value={departing} onChange={(e) => setDeparting(e.target.value)} aria-label="Departing runway">
                      <option value="auto">Auto · {rec.departing[0]}</option>
                      {ends.map((e) => (<option key={e} value={e} disabled={closedEnds.includes(e)}>{e}{closedEnds.includes(e) ? ' (closed)' : ''}</option>))}
                    </select>
                  </Field>
                  </>
                )}
                <p className="col-span-2 text-[11px] leading-snug text-atc-muted">
                  {rec.summary}. {!isCustom && 'Ready-made scenarios keep their own runway unless you pick one here.'}
                </p>
                <Field label="Close a runway" hint="NOTAM style: the runway is closed for the whole session. The ATIS reads it, the runway selector skips it, a clearance onto it is unsafe, and it is drawn with a yellow X.">
                  <select className={SELECT} value={closeRunway} onChange={(e) => setCloseRunway(e.target.value)} aria-label="Close a runway" data-testid="close-runway">
                    <option value="none">None</option>
                    {airport.runways.map((r) => (<option key={r.id} value={r.id} disabled={airport.runways.length < 2}>Runway {r.id}</option>))}
                  </select>
                </Field>
                <Field label="Close a taxiway" hint="Taxi routes avoid it, a taxi instruction over it is refused, and it is marked on the surface display.">
                  <select className={SELECT} value={closeTaxiway} onChange={(e) => setCloseTaxiway(e.target.value)} aria-label="Close a taxiway" data-testid="close-taxiway">
                    <option value="none">None</option>
                    {taxiwayNames.map((t) => (<option key={t} value={t}>Taxiway {t}</option>))}
                  </select>
                </Field>
                <label className="col-span-2 flex cursor-pointer items-start gap-2.5" data-testid="airport-events-option">
                  <input type="checkbox" className="mt-0.5 accent-[#39c5e8]" checked={airportEvents} onChange={(e) => setAirportEvents(e.target.checked)} aria-label="Airport events" data-testid="airport-events" />
                  <span className="text-[11.5px] leading-snug text-atc-muted"><b className="text-atc-text">Airport events</b> (free play): a runway inspection that closes a runway for a few minutes, a taxiway closure and bird activity can occur during the session. Braking action reports and runway lights requests follow the weather and time of day.</span>
                </label>
                <Field label="Clock" hint="Real time: sim time, day/night and traffic volume follow the real clock. Sim speed: the old 1x/2x/4x sim clock.">
                  <select className={SELECT} value={realTime ? 'real' : 'sim'} onChange={(e) => setRealTime(e.target.value === 'real')} aria-label="Clock" data-testid="clock-select">
                    <option value="real">Real time (live)</option>
                    <option value="sim">Sim speed</option>
                  </select>
                </Field>
                <Field label="Random seed" hint="Same seed + same commands = the same session. Blank = random.">
                  <input className={INPUT} inputMode="numeric" value={seedText} onChange={(e) => setSeedText(e.target.value.replace(/[^0-9]/g, ''))} placeholder="random" aria-label="Random seed" data-testid="seed-input" />
                </Field>
              </div>
            </section>

            <section>
              <SectionTitle n={isCustom ? 5 : 4}>I work</SectionTitle>
              {scenarioNeeds && (
                <div className="mb-2 flex flex-col gap-1 text-[11.5px] leading-snug text-atc-muted" data-testid="position-needs">
                  <span>
                    {isCustom ? 'Custom free play has' : 'This scenario has'} <b className="text-atc-text">{positionListText(scenarioNeeds)}</b>.
                    {' '}Pick the position you work; <b className="font-semibold text-[#b79cff]">AI controllers work the rest</b>.
                  </span>
                  <span data-testid="ai-works" className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-sans text-[10px] uppercase tracking-[0.16em]">{aiOn ? 'AI works' : 'Unstaffed'}</span>
                    {aiWorks.length > 0
                      ? <b className={`text-[12.5px] font-semibold ${aiOn ? 'text-[#b79cff]' : 'text-atc-amber'}`}>{positionListText(aiWorks)}</b>
                      : <span className="text-atc-text">nothing: you work every position</span>}
                    {aiWorks.length > 0 && !aiOn && <span className="text-atc-amber">aircraft there will be &ldquo;not on frequency&rdquo;</span>}
                  </span>
                </div>
              )}
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="I work">
                {POSITIONS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    role="radio"
                    aria-checked={position === p.value}
                    data-testid={`position-${p.value}`}
                    onClick={() => setPosition(p.value)}
                    className={`flex items-start justify-between gap-3 border px-3 py-2 text-left transition-colors ${position === p.value ? 'border-atc-cyan bg-atc-cyan/10' : 'border-atc-border bg-atc-panel hover:border-atc-muted'}`}
                  >
                    <span className="min-w-0">
                      <span className={`block text-[13px] font-semibold ${position === p.value ? 'text-atc-cyan' : 'text-atc-text'}`}>
                        {p.label}
                        {p.value === suggested && <span className="ml-2 font-sans text-[9.5px] font-normal uppercase tracking-wider text-atc-green">suggested</span>}
                        {!scenarioNeeds && p.value === 'TWR' && <span className="ml-2 font-sans text-[9.5px] font-normal uppercase tracking-wider text-atc-muted">default</span>}
                        {scenarioNeeds && p.rest.length > 0 && (
                          <span className={`ml-2 font-sans text-[9.5px] font-normal uppercase tracking-wider ${aiOn ? 'text-[#b79cff]' : 'text-atc-amber'}`}>
                            {aiOn ? 'AI works' : 'unstaffed'} {p.rest.join(' ')}
                          </span>
                        )}
                      </span>
                      <span className="block text-[11px] leading-snug text-atc-muted">{p.note}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end text-right leading-tight">
                      {p.rows.map((r) => (
                        <span key={r.mhz} className="whitespace-nowrap text-[13px] font-semibold tabular-nums text-atc-green">
                          <span className="mr-1.5 text-[9.5px] font-normal text-atc-muted">{rowLabel(r)}</span>{formatMhz(r.mhz)}
                        </span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
              <label className="mt-2 flex cursor-pointer items-start gap-2.5 border border-atc-border bg-atc-panel p-3" data-testid="ai-option">
                <input type="checkbox" className="mt-0.5 accent-[#b79cff]" checked={aiOn} aria-label="AI controllers work the other positions" data-testid="ai-toggle" onChange={(e) => setAiOn(e.target.checked)} />
                <span>
                  <span className="block text-[13px] font-semibold text-atc-text">AI controllers work the other positions</span>
                  <span className="block text-[11.5px] leading-snug text-atc-muted">
                    Each position you do not work gets a rule-based AI controller. It speaks on its own frequency, hands aircraft to you on yours, and you cannot instruct aircraft that are with it.
                    Off: those frequencies stay empty and aircraft on them cannot be reached.
                  </span>
                </span>
              </label>
            </section>

            <section>
              <SectionTitle n={isCustom ? 6 : 5}>Voice and radio</SectionTitle>
              <div className="border border-atc-border bg-atc-panel p-4"><VoiceSettingsForm /></div>
            </section>
          </div>
        </div>

        <div className="sticky bottom-0 -mx-4 mt-8 flex items-center justify-between gap-3 border-t border-atc-border bg-atc-bg/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:gap-4 sm:px-6">
          <div className="text-xs text-atc-muted" aria-live="polite">
            {starting ? <span className="text-atc-cyan">{startStatus || 'Starting…'}</span> : selected && !isCustom ? <>Ready: <b className="text-atc-text">{selected.name}</b> at <b className="text-atc-text">{POSITIONS.find((p) => p.value === position)?.label}</b></> : <>Ready: <b className="text-atc-text">Custom free play</b> at <b className="text-atc-text">{POSITIONS.find((p) => p.value === position)?.label}</b></>}
          </div>
          <Btn tone="green" size="md" onClick={start} disabled={!canStart} data-testid="start-session" className="min-w-36 shrink-0 !text-[13px] sm:min-w-44 font-bold tracking-[0.2em]">
            {starting ? 'Starting…' : 'Start session'}
          </Btn>
        </div>

        <footer className="mt-4 border-t border-atc-border pt-3 text-[10.5px] leading-relaxed text-atc-muted" data-testid="provenance-footer">
          <div>{prov.footer}</div>
          <div>Not for navigation or real-world ATC use. ATIS and radio traffic are simulated; live METARs come from the Aviation Weather Center (local backend) or the National Weather Service API.</div>
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
