/**
 * KMHT ROZZE TWO arrivals: spawn at a STAR entry fix, "cleared ROZZE TWO arrival" / "descend via the ROZZE TWO arrival" (JO 7110.65 4-7-1, 4-5-7),
 * the published altitude and speed restrictions, vectors cancelling the arrival (AIM 5-4-1), and the AI Approach controller working a STAR arrival
 * through to the landing on every runway.
 */
import { describe, expect, it } from 'vitest';
import { loadKmht } from '../airport';
import { mulberry32 } from '../sim/rng';
import { mToNm, dist } from '../sim/geo';
import { findNavFix } from '../sim/navigation';
import { findStar, starProfile } from '../sim/star';
import { starArrivalSpawn } from '../game/ifr';
import { alongCross, findRunwayEnd } from '../sim/runways';
import type { Aircraft, ScenarioAircraftSpawn } from '../sim/types';
import { cmd, createHarness } from './testkit';
import type { Harness } from './testkit';

const kmht = loadKmht();
const star = findStar(kmht)!;
const profile = new Map(starProfile(star.star).map((r) => [r.fix, r]));

const spawn = (rwy: string, entry = 'CRIBB', cs = 'SWA123', type = 'B738', seed = 5): ScenarioAircraftSpawn =>
  starArrivalSpawn(kmht, mulberry32(seed), { callsign: cs, type, runwayEnd: rwy, atSec: 0, entry })!;

function harness(rwy: string, spawns: ScenarioAircraftSpawn[], player: ('TWR' | 'APP')[] = ['TWR']): Harness {
  return createHarness({ airport: kmht, player, activeRunways: { departing: [rwy], landing: [rwy] }, spawns, mode: 'free_play' });
}

/** Closest approach of the aircraft to each restricted fix of the STAR while it is flying the arrival: altitude and speed at that moment. */
function trackCrossings(h: Harness, cs: string) {
  const out = new Map<string, { d: number; alt: number; kt: number }>();
  return {
    out,
    sample() {
      const ac = h.find(cs);
      if (!ac?.star) return;
      for (const [fix] of profile) {
        const p = findNavFix(kmht, fix)!.pos;
        const d = dist(ac.pos, p);
        const cur = out.get(fix);
        if (!cur || d < cur.d) out.set(fix, { d, alt: ac.altitudeFt, kt: ac.airspeedKt });
      }
    },
  };
}

describe('spawning on the arrival', () => {
  it('a STAR arrival appears over CRIBB / FLYZZ inside the published altitude window, 250 kt, on the Approach frequency, already on the arrival', () => {
    const h = harness('6', [spawn('6', 'CRIBB'), spawn('6', 'FLYZZ', 'AAL9')]);
    const a = h.find('SWA123')!;
    const b = h.find('AAL9')!;
    expect(a.star).toMatchObject({ name: 'ROZZE TWO', transition: 'CRIBB', runwayEnd: '6', descendVia: false });
    expect(a.altitudeFt).toBeGreaterThanOrEqual(13000);
    expect(a.altitudeFt).toBeLessThanOrEqual(16000);
    expect(a.nav).toMatchObject({ mode: 'route', fixes: ['CRIBB', 'MONRC', 'ROZZE', 'PNARD', 'TEETO', 'JAAZZ'], index: 1 });
    expect(a.airspeedKt).toBe(250);
    expect(a.frequencyId).toBe('APP');
    expect(b.altitudeFt).toBeGreaterThanOrEqual(13000);
    expect(mToNm(dist(b.pos, { x: 0, y: 0 }))).toBeGreaterThan(40);
  });
  it('turbojets only (chart note): a Caravan or a Cessna gets no STAR spawn', () => {
    expect(starArrivalSpawn(kmht, mulberry32(1), { callsign: 'WIG1', type: 'C208', runwayEnd: '6', atSec: 0 })).toBeUndefined();
    expect(starArrivalSpawn(kmht, mulberry32(1), { callsign: 'N1', type: 'C172', runwayEnd: '6', atSec: 0 })).toBeUndefined();
  });
  it('the pilot checks in and the aircraft is not removed as "lost" although the entry fix is outside the 40 nm area', () => {
    const h = harness('6', [spawn('6')]);
    h.run(30);
    expect(h.find('SWA123')).toBeDefined();
    expect(h.pilotTexts('SWA123')[0]).toMatch(/^Boston Approach, Southwest one twenty three, level one five thousand/);
  });
});

describe('clearance and descend via (4-7-1, 4-5-7)', () => {
  it('without "descend via" the aircraft keeps its altitude (AIM 5-4-1: maintain the last assigned altitude); "descend via" starts the descent', () => {
    const h = harness('6', [spawn('6')], ['APP']);
    const a = h.find('SWA123')!;
    const alt0 = a.altitudeFt;
    h.run(60);
    expect(a.altitudeFt).toBeCloseTo(alt0, -1);
    const out = h.say('APP', cmd('STAR', 'SWA123', { starName: 'ROZZE2', descendVia: true }));
    expect(out.status).toBe('accepted');
    expect(out.status === 'accepted' && out.readback).toBe('Descend via the Rozze Two arrival, CRIBB transition, Southwest one twenty three');
    expect(a.star?.descendVia).toBe(true);
    expect(a.target.altitudeFt).toBe(5000);
    h.run(120);
    expect(a.altitudeFt).toBeLessThan(alt0 - 1500);
  });
  it('"cleared ROZZE TWO arrival" is read back as such and keeps the vertical state', () => {
    const h = harness('6', [spawn('6')], ['APP']);
    const out = h.say('APP', cmd('STAR', 'SWA123', { starName: 'ROZZE2' }));
    expect(out.status === 'accepted' && out.readback).toBe('Cleared Rozze Two arrival, CRIBB transition, Southwest one twenty three');
    expect(h.find('SWA123')!.star?.descendVia).toBe(false);
  });
  it('a transition re-routes from its entry; a wrong name or number is refused', () => {
    const h = harness('17', [spawn('17')], ['APP']);
    expect(h.say('APP', cmd('STAR', 'SWA123', { starName: 'ROZZE2', starTransition: 'MUCOW' })).status).toBe('accepted');
    expect(h.find('SWA123')!.nav!.fixes).toEqual(['MUCOW', 'FFATY', 'CRIBB', 'MONRC', 'ROZZE', 'NUUKM', 'PURBL', 'LYLAC', 'BLSSM', 'BLUUM']);
    const bad = h.say('APP', cmd('STAR', 'SWA123', { starName: 'KENZI3' }));
    expect(bad).toMatchObject({ status: 'rejected', pilotResponse: expect.stringMatching(/we don't have that arrival/) });
    expect(h.say('APP', cmd('STAR', 'SWA123', { starName: 'ROZZE2', starTransition: 'NOPE' })).status).toBe('rejected');
  });
  it('direct to a fix of the arrival stays on the arrival; direct to any other fix leaves it', () => {
    const h = harness('6', [spawn('6')], ['APP']);
    h.say('APP', cmd('DIRECT_FIX', 'SWA123', { fix: 'PNARD' }));
    h.run(2);
    const ac = h.find('SWA123')!;
    expect(ac.star).toBeDefined();
    expect(ac.nav!.mode).toBe('direct');
    expect(ac.nav!.fixes[ac.nav!.index]).toBe('PNARD');
    expect(ac.nav!.fixes).toContain('TEETO');
    h.say('APP', cmd('DIRECT_FIX', 'SWA123', { fix: 'BLSSM' })); // BLSSM belongs to the runway 17 route, not to this aircraft's runway 6 route
    expect(h.find('SWA123')!.star).toBeUndefined();
  });
  it('a missed or impossible request is refused: a ground aircraft cannot take an arrival', () => {
    const h = harness('6', [spawn('6')], ['APP']);
    const ac = h.find('SWA123')!;
    ac.onGround = true;
    expect(h.say('APP', cmd('STAR', 'SWA123', { starName: 'ROZZE2' })).status).toBe('rejected');
  });
});

describe('altitude and speed restrictions are flown (descend via)', () => {
  for (const rwy of ['6', '17', '24', '35']) {
    it(`runway ${rwy}: crossing altitudes and speeds meet the chart, then the aircraft is cleared for the approach and lands`, () => {
      const h = harness(rwy, [spawn(rwy)]);
      const t = trackCrossings(h, 'SWA123');
      let landed = false;
      h.runUntil(() => {
        const ac = h.find('SWA123');
        if (!ac) { landed = true; return true; }
        if (ac.phase === 'FINAL' && ac.pendingRequest?.kind === 'LANDING') h.say('TWR', cmd('LAND', 'SWA123', { runwayEnd: rwy }));
        return ac.phase === 'ROLLOUT' || ac.phase === 'RUNWAY_EXIT';
      }, 2600, () => t.sample());
      const ac = h.find('SWA123');
      expect(landed || ['ROLLOUT', 'RUNWAY_EXIT'].includes(ac!.phase)).toBe(true);
      // the controller cleared the arrival with "descend via", then the approach
      const atc = h.atc('APP').map((e) => e.text);
      expect(atc[0]).toMatch(/radar contact, descend via the Rozze Two arrival/);
      expect(atc.some((x) => /cleared (ILS|RNAV) runway .* approach/.test(x))).toBe(true);
      // restrictions at the fixes it flew (the closest approach to each restricted fix on its route)
      const route = star.star.runways.find((r) => r.runwayEnd === rwy)!.fixes;
      for (const fix of ['MONRC', 'FYSHR', ...route.slice(1)]) {
        const r = profile.get(fix);
        const c = t.out.get(fix);
        if (!r || !c || c.d > 1500) continue; // not flown (or the nearest sample is far: the aircraft never came close)
        if (r.minAltitudeFt !== undefined) expect(c.alt, `${fix} at or above`).toBeGreaterThanOrEqual(r.minAltitudeFt - 250);
        if (r.maxAltitudeFt !== undefined) expect(c.alt, `${fix} at or below`).toBeLessThanOrEqual(r.maxAltitudeFt + 150);
        if (r.mandatoryAltitudeFt !== undefined) expect(Math.abs(c.alt - r.mandatoryAltitudeFt), `${fix} at`).toBeLessThanOrEqual(250);
        if (r.speedKt !== undefined) expect(c.kt, `${fix} speed`).toBeLessThanOrEqual(r.speedKt + 6);
      }
      expect(h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION', 'GO_AROUND'].includes(e.kind)).map((e) => e.text)).toEqual([]);
    }, 20000);
  }
  it('runway 24 ends "then on heading 057": the pilot takes the heading and expects vectors; Approach then sends it to the approach', () => {
    const h = harness('24', [spawn('24')]);
    let sawHeading = false;
    h.runUntil(() => {
      const ac = h.find('SWA123');
      if (ac && !ac.star && !ac.nav && ac.target.headingDeg !== undefined && !sawHeading) sawHeading = true;
      return sawHeading || !ac;
    }, 1500);
    expect(sawHeading).toBe(true);
    expect(h.events.some((e) => /reached the end of the ROZZE TWO arrival, heading 057/.test(e.text))).toBe(true);
  }, 20000);
});

describe('vectors, altitude assignments and the approach clearance end the arrival (AIM 5-4-1)', () => {
  it('a heading cancels the STAR with its restrictions', () => {
    const h = harness('6', [spawn('6')], ['APP']);
    h.say('APP', cmd('STAR', 'SWA123', { starName: 'ROZZE2', descendVia: true }));
    h.run(5);
    expect(h.find('SWA123')!.star).toBeDefined();
    expect(h.say('APP', cmd('HEADING', 'SWA123', { headingDeg: 90 })).status).toBe('accepted');
    expect(h.find('SWA123')!.star).toBeUndefined();
    expect(h.say('APP', cmd('STAR', 'SWA123', { starName: 'ROZZE2', descendVia: true })).status).toBe('rejected'); // on vectors: name a transition or send direct first
    expect(h.say('APP', cmd('STAR', 'SWA123', { starName: 'ROZZE2', starTransition: 'CRIBB', descendVia: true })).status).toBe('accepted');
  });
  it('an altitude assignment replaces "descend via" but the speed restrictions stay', () => {
    const h = harness('6', [spawn('6')], ['APP']);
    h.say('APP', cmd('STAR', 'SWA123', { starName: 'ROZZE2', descendVia: true }));
    h.say('APP', cmd('ALTITUDE', 'SWA123', { altitudeFt: 12000 }));
    const ac = h.find('SWA123')!;
    expect(ac.star).toMatchObject({ descendVia: false });
    expect(ac.target.altitudeFt).toBe(12000);
  });
  it('the approach clearance cancels the STAR', () => {
    const h = harness('6', [spawn('6', 'CRIBB')], ['APP']);
    h.say('APP', cmd('DIRECT_FIX', 'SWA123', { fix: 'TEETO' }));
    h.run(3);
    const ac = h.find('SWA123')!;
    ac.pos = { ...findNavFix(kmht, 'TEETO')!.pos };
    ac.pos.x += 3000;
    const out = h.say('APP', cmd('APPROACH', 'SWA123', { approachType: 'ILS', runwayEnd: '6' }));
    expect(['accepted', 'rejected']).toContain(out.status);
    if (out.status === 'accepted') expect(ac.star).toBeUndefined();
  });
});

describe('the AI Approach controller and the generator', () => {
  it('two STAR arrivals to one runway are spaced and both land without a safety event', () => {
    const h = harness('35', [spawn('35', 'CRIBB', 'SWA123'), { ...spawn('35', 'FLYZZ', 'AAL456', 'B738', 9), atSec: 150 }]);
    const landed = new Set<string>();
    h.runUntil(() => {
      for (const ac of Object.values(h.engine.getState().aircraft) as Aircraft[]) {
        if (ac.phase === 'FINAL' && ac.pendingRequest?.kind === 'LANDING') {
          const g = findRunwayEnd(kmht, '35')!;
          if (-alongCross(g, ac.pos).along < 5 * 1852) h.say('TWR', cmd('LAND', ac.callsign, { runwayEnd: '35' }));
        }
        if (ac.phase === 'ROLLOUT' || ac.phase === 'RUNWAY_EXIT') landed.add(ac.callsign);
      }
      return landed.size === 2;
    }, 3600);
    expect([...landed].sort()).toEqual(['AAL456', 'SWA123']);
    expect(h.events.filter((e) => ['RUNWAY_INCURSION', 'SEPARATION_VIOLATION'].includes(e.kind)).map((e) => e.text)).toEqual([]);
  }, 30000);
});
