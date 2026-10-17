import { describe, expect, it } from 'vitest';
import plates from '../../data/sources/kacy-procedures.json';
import { createEngine } from './engine';
import type { SimulationEngine } from './api';
import type { ApproachType, Weather } from './types';
import { ALL_POSITIONS, AT_FIX, cmd, find, ifrScenario, makeEngine, makeScenario, pilotTexts, run, runUntil, say } from './__fixtures__/testHelpers';
import { kacyWithPlates } from './__fixtures__/kacyPlates';
import { createTestAirport } from './__fixtures__/testAirport';
import { parseMinima, resolveMinima, runwayInSight } from './minima';
import { alongCross, findRunwayEnd } from './runways';
import { mToNm } from './geo';

const wx = (over: Partial<Weather>): Weather => ({ ...(makeScenario().weather as Weather), ...over });
const minimaOf = (chart: string): string => (plates as unknown as { instrument_approaches: { chart_name: string; minima_summary: string }[] }).instrument_approaches.find((p) => p.chart_name === chart)!.minima_summary;

describe('minima interpreter (verbatim KACY plate text)', () => {
  it('ILS: straight-in DA, HAT and visibility', () => {
    expect(parseMinima(minimaOf('ILS Z OR LOC Z RWY 13'), 'ILS', 74.8)).toMatchObject({ kind: 'DA', altFt: 275, hatFt: 200 });
    expect(parseMinima(minimaOf('ILS Z OR LOC Z RWY 13'), 'ILS', 74.8)!.visSm).toBeCloseTo(1800 / 5280, 3); // RVR 1800 only
    expect(parseMinima(minimaOf('HI-ILS Y OR LOC Y RWY 13'), 'ILS', 74.8)).toMatchObject({ kind: 'DA', altFt: 275, hatFt: 200, visSm: 0.5 }); // (200-1/2)
    expect(parseMinima(minimaOf('ILS OR LOC/DME RWY 31'), 'ILS', 63.4)).toMatchObject({ kind: 'DA', altFt: 264, hatFt: 200, visSm: 0.75 });
  });

  it('LOC: MDA', () => {
    expect(parseMinima(minimaOf('ILS Z OR LOC Z RWY 13'), 'LOC', 74.8)).toMatchObject({ kind: 'MDA', altFt: 520, hatFt: 445 });
    expect(parseMinima(minimaOf('ILS OR LOC/DME RWY 31'), 'LOC', 63.4)).toMatchObject({ kind: 'MDA', altFt: 520, hatFt: 456, visSm: 1 });
  });

  it('RNAV: LPV DA when published, else LNAV MDA, else RNP DA', () => {
    expect(parseMinima(minimaOf('RNAV (GPS) RWY 22'), 'RNAV', 67.6)).toMatchObject({ kind: 'DA', altFt: 364, hatFt: 296, visSm: 1 });
    expect(parseMinima(minimaOf('RNAV (GPS) RWY 04'), 'RNAV', 68.4)).toMatchObject({ kind: 'DA', altFt: 318, hatFt: 250, visSm: 1 });
    expect(parseMinima(minimaOf('RNAV (GPS) Y RWY 13'), 'RNAV', 74.8)).toMatchObject({ kind: 'DA', altFt: 275, hatFt: 200, visSm: 0.5 });
    expect(parseMinima(minimaOf('RNAV (RNP) Z RWY 13'), 'RNAV', 74.8)).toMatchObject({ kind: 'DA', altFt: 442, hatFt: 367, visSm: 0.75 });
    expect(parseMinima('LNAV MDA 480-1 / 480-1 1/8 HAT 412; circling A 540-1', 'RNAV', 68)).toMatchObject({ kind: 'MDA', altFt: 480, hatFt: 412, visSm: 1 });
  });

  it('VOR: MDA with the bracketed HAT', () => {
    expect(parseMinima(minimaOf('VOR RWY 04'), 'VOR', 68.4)).toMatchObject({ kind: 'MDA', altFt: 480, hatFt: 412, visSm: 1 });
    expect(parseMinima(minimaOf('VOR RWY 31'), 'VOR', 63.4)).toMatchObject({ kind: 'MDA', altFt: 480, hatFt: 416, visSm: 1 });
  });

  it('visibility fractions', () => {
    expect(parseMinima('S-ILS 1 DA 300 HAT 200 (200-1 1/2)', 'ILS', 100)!.visSm).toBe(1.5);
    expect(parseMinima('S-ILS 1 DA 300 HAT 200 (200-3/4)', 'ILS', 100)!.visSm).toBe(0.75);
  });

  it('unreadable or missing text -> undefined; the fallback is 200 ft HAT (ILS) / 450 ft HAT (others) and says so', () => {
    expect(parseMinima(undefined, 'ILS', 75)).toBeUndefined();
    expect(parseMinima('see plate', 'ILS', 75)).toBeUndefined();
    expect(parseMinima('S-ILS 13 DA 275 HAT 200', 'VOR', 75)).toBeUndefined(); // no VOR line
    const ils = resolveMinima(undefined, 'ILS', 75);
    expect(ils).toMatchObject({ kind: 'DA', altFt: 275, hatFt: 200, visSm: 0.5 });
    expect(ils.assumed).toMatch(/using 200 ft HAT/);
    const loc = resolveMinima(undefined, 'LOC', 75);
    expect(loc).toMatchObject({ kind: 'MDA', altFt: 525, hatFt: 450, visSm: 1 });
    expect(loc.assumed).toMatch(/using 450 ft HAT/);
    expect(resolveMinima({ id: 'x', name: 'x', type: 'IAP', chartPdfUrl: '', provenance: { source: 's', retrievedOn: 'd' }, minimaText: 'S-ILS 13 DA 275 HAT 200 (200-1/2)' }, 'ILS', 75).assumed).toBeUndefined();
  });

  it('every transcribed KACY approach has usable minima for its own type', () => {
    const kacy = kacyWithPlates();
    for (const p of kacy.procedures.filter((x) => x.type === 'IAP' && !/COPTER/.test(x.name))) {
      const type: ApproachType = /ILS/.test(p.name) ? 'ILS' : /RNAV/.test(p.name) ? 'RNAV' : 'VOR';
      const m = parseMinima(p.minimaText, type, 70);
      expect(m, `${p.name}: ${p.minimaText}`).toBeDefined();
      expect(m!.hatFt).toBeGreaterThanOrEqual(200);
      expect(m!.altFt).toBeGreaterThan(m!.hatFt);
    }
  });

  it('runway in sight: visibility and ceiling', () => {
    const m = { kind: 'DA' as const, altFt: 275, hatFt: 200, visSm: 0.5, source: '' };
    expect(runwayInSight(wx({}), m).inSight).toBe(true);
    expect(runwayInSight(wx({ visibilitySm: 0.25 }), m).why).toMatch(/visibility/);
    expect(runwayInSight(wx({ clouds: [{ cover: 'OVC', baseFtAgl: 150 }] }), m).why).toMatch(/ceiling 150 ft is below the 200 ft HAT/);
    expect(runwayInSight(wx({ clouds: [{ cover: 'OVC', baseFtAgl: 200 }], visibilitySm: 0.5 }), m).inSight).toBe(true);
    expect(runwayInSight(wx({ clouds: [{ cover: 'FEW', baseFtAgl: 100 }] }), m).inSight).toBe(true); // few clouds are not a ceiling
  });
});

describe('decision altitude (fixture ILS 13, DA 275 ft / HAT 200 / 1/2 sm)', () => {
  const g13 = findRunwayEnd(createTestAirport(), '13')!;
  const fly = (weather: Weather, opts: { airport?: ReturnType<typeof createTestAirport>; land?: boolean } = {}) => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B'], '13', {}, 3000)], { mode: 'training', weather }), opts: opts.airport ? { airport: opts.airport } : {} });
    const ac = find(e, 'NKS451');
    run(e, 5);
    expect(say(e, cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: '13' }), 'APP').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'FINAL', 1500)).toBe(true);
    say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'TWR' }), 'APP');
    expect(runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'LANDING', 30)).toBe(true);
    if (opts.land !== false) expect(say(e, cmd('LAND', 'NKS451', { runwayEnd: '13' }), 'TWR').status).toBe('accepted');
    return { e, ac };
  };
  const untilEnd = (e: SimulationEngine, phases: string[]) => runUntil(e, () => phases.includes(find(e, 'NKS451').phase), 600);

  it('ceiling below the HAT at the DA: missed approach even though cleared to land, "runway not in sight"', () => {
    const { e, ac } = fly(wx({ flightCategory: 'LIFR', clouds: [{ cover: 'OVC', baseFtAgl: 150 }], visibilitySm: 5 }));
    expect(untilEnd(e, ['GO_AROUND', 'ROLLOUT'])).toBe(true);
    expect(ac.phase).toBe('GO_AROUND');
    // at the DA (275 ft MSL), well before the 0.5 nm decision point
    expect(ac.altitudeFt).toBeGreaterThan(240);
    expect(mToNm(-alongCross(g13, ac.pos).along)).toBeGreaterThan(0.3);
    expect(pilotTexts(e).filter((t) => /going missed approach/.test(t))).toEqual([
      'Atlantic City Tower, Spirit four fifty one, going missed approach, runway not in sight, flying the published missed approach.',
    ]);
    expect(e.getState().events.some((x) => x.kind === 'GO_AROUND' && /runway not in sight/.test(x.text))).toBe(true);
    expect(ac.nav?.mode).toBe('missed');
  });

  it('visibility below the minimum at the DA: missed approach too', () => {
    const { e, ac } = fly(wx({ flightCategory: 'LIFR', clouds: [{ cover: 'SKC', baseFtAgl: 0 }], visibilitySm: 0.25 }));
    expect(untilEnd(e, ['GO_AROUND', 'ROLLOUT'])).toBe(true);
    expect(ac.phase).toBe('GO_AROUND');
  });

  it('weather at or above the minima: lands', () => {
    const { e, ac } = fly(wx({ flightCategory: 'IFR', clouds: [{ cover: 'OVC', baseFtAgl: 250 }], visibilitySm: 1 }));
    expect(untilEnd(e, ['GO_AROUND', 'ROLLOUT'])).toBe(true);
    expect(ac.phase).toBe('ROLLOUT');
    expect(e.getState().events.some((x) => x.kind === 'GO_AROUND')).toBe(false);
  });

  it('good weather never triggers the check', () => {
    const { e, ac } = fly(wx({}));
    expect(untilEnd(e, ['GO_AROUND', 'ROLLOUT'])).toBe(true);
    expect(ac.phase).toBe('ROLLOUT');
  });

  it('visual approaches have no decision altitude', () => {
    const e = makeEngine({ scenario: ifrScenario([AT_FIX('NKS451', 'TARR', ['TARR', 'FX13A', 'FX13B'], '13', {}, 3000)], { mode: 'training', weather: wx({ flightCategory: 'MVFR', clouds: [{ cover: 'BKN', baseFtAgl: 1500 }], visibilitySm: 3 }) }) });
    const ac = find(e, 'NKS451');
    run(e, 5);
    expect(say(e, cmd('APPROACH', 'NKS451', { approachType: 'VISUAL', runwayEnd: '13' }), 'APP').status).toBe('accepted');
    expect(runUntil(e, () => ac.phase === 'FINAL', 1500)).toBe(true);
    say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'TWR' }), 'APP');
    runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'LANDING', 30);
    say(e, cmd('LAND', 'NKS451', { runwayEnd: '13' }), 'TWR');
    expect(untilEnd(e, ['GO_AROUND', 'ROLLOUT'])).toBe(true);
    expect(ac.phase).toBe('ROLLOUT');
  });

  it('missing minima text: 200 ft HAT fallback for ILS, announced in an INFO event', () => {
    const noMinima = createTestAirport();
    for (const p of noMinima.procedures) delete p.minimaText;
    // ceiling 150 ft: below the 200 ft fallback HAT -> missed
    const { e, ac } = fly(wx({ flightCategory: 'LIFR', clouds: [{ cover: 'OVC', baseFtAgl: 150 }], visibilitySm: 5 }), { airport: noMinima });
    expect(untilEnd(e, ['GO_AROUND', 'ROLLOUT'])).toBe(true);
    expect(ac.phase).toBe('GO_AROUND');
    expect(e.getState().events.some((x) => /could not be read from the plate text; using 200 ft HAT and 0.5 sm/.test(x.text))).toBe(true);
  });

  it('is deterministic', () => {
    const play = () => {
      const { e } = fly(wx({ flightCategory: 'LIFR', clouds: [{ cover: 'OVC', baseFtAgl: 150 }], visibilitySm: 5 }));
      run(e, 300);
      const s = e.getState();
      return JSON.stringify({ a: s.aircraft, ev: s.events.map((x) => `${x.timeSec}:${x.text}`) });
    };
    expect(play()).toBe(play());
  });
});

describe('decision altitude on real KACY data', () => {
  const ap = kacyWithPlates();
  const flyKacy = (weather: Weather) => {
    const e = createEngine({
      airport: ap, readbackErrorRate: 0,
      scenario: makeScenario({
        controllerPositions: ALL_POSITIONS, mode: 'training', weather, activeRunways: { departing: ['13'], landing: ['13'] },
        spawns: [{ atSec: 0, callsign: 'NKS451', type: 'A320', flightRules: 'IFR', isDeparture: false, initialFrequencyId: 'APP', start: { kind: 'at_fix', fix: 'CARYL', altitudeFt: 3000, speedKt: 170, route: ['CARYL', 'MAYBN'], runwayEnd: '13' } }],
      }),
    });
    const ac = find(e, 'NKS451');
    run(e, 4);
    say(e, cmd('APPROACH', 'NKS451', { approachType: 'ILS', runwayEnd: '13' }), 'APP');
    runUntil(e, () => ac.phase === 'FINAL', 1500);
    say(e, cmd('CONTACT_FREQUENCY', 'NKS451', { frequencyId: 'TWR' }), 'APP');
    runUntil(e, () => ac.frequencyId === 'TWR' && ac.pendingRequest?.kind === 'LANDING', 30);
    say(e, cmd('LAND', 'NKS451', { runwayEnd: '13' }), 'TWR');
    runUntil(e, () => ac.phase === 'GO_AROUND' || ac.phase === 'ROLLOUT', 600);
    return { e, ac };
  };

  it('ILS 13 (DA 275, HAT 200, RVR 1800): 100 ft ceiling -> missed approach and the hold at SMITS; 300 ft ceiling -> lands', () => {
    const low = flyKacy(wx({ flightCategory: 'LIFR', clouds: [{ cover: 'OVC', baseFtAgl: 100 }] }));
    expect(low.ac.phase).toBe('GO_AROUND');
    expect(low.ac.nav).toEqual({ fixes: ['SMITS'], index: 0, mode: 'missed' });
    expect(runUntil(low.e, () => low.ac.phase === 'HOLDING', 1200)).toBe(true);
    const ok = flyKacy(wx({ flightCategory: 'IFR', clouds: [{ cover: 'OVC', baseFtAgl: 300 }], visibilitySm: 1 }));
    expect(ok.ac.phase).toBe('ROLLOUT');
  });
});
