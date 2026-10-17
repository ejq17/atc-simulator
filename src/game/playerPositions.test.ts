import { describe, expect, it } from 'vitest';
import { loadKacy } from '../airport';
import { game, defaultPlayerPositions } from './game';

const airport = loadKacy();

describe('playerPositions (single-position play, the rest is AI)', () => {
  it('buildFreePlay records the player positions and leaves the full position set alone', () => {
    const sc = game.buildFreePlay(airport, { seed: 5, playerPositions: ['GND'] });
    expect(sc.playerPositions).toEqual(['GND']);
    expect(sc.controllerPositions).toEqual(['TWR', 'GND']);
  });

  it('with IFR flows the full five-position set exists and the player picks any subset', () => {
    const sc = game.buildFreePlay(airport, { seed: 5, ifrFlows: true, playerPositions: ['CLNC'] });
    expect(sc.controllerPositions).toEqual(['TWR', 'GND', 'CLNC', 'APP', 'DEP']);
    expect(sc.playerPositions).toEqual(['CLNC']);
  });

  it('free play without the option leaves playerPositions unset (= the player works everything)', () => {
    expect(game.buildFreePlay(airport, { seed: 5 }).playerPositions).toBeUndefined();
    expect(game.buildScenario('free-play-mixed', airport, { seed: 5 }).playerPositions).toBeUndefined();
  });

  it('buildScenario honours an explicit override for free-play presets, career and training', () => {
    expect(game.buildScenario('free-play-mixed', airport, { seed: 5, playerPositions: ['TWR'] }).playerPositions).toEqual(['TWR']);
    expect(game.buildScenario('career-02-single-takeoff', airport, { seed: 5, playerPositions: ['GND'] }).playerPositions).toEqual(['GND']);
    expect(game.buildScenario('train-01-phraseology', airport, { seed: 5, playerPositions: ['TWR', 'TWR'] }).playerPositions).toEqual(['TWR']);
  });

  it('career and training scenarios default to the position they are about; Ground lessons give GND only', () => {
    const ground = game.buildScenario('career-05-ground-taxi', airport, { seed: 5 });
    expect(ground.playerPositions).toEqual(['GND']);
    expect(ground.controllerPositions).toContain('TWR'); // Tower still exists: AI works it
    expect(game.buildScenario('train-02-taxi', airport, { seed: 5 }).playerPositions).toEqual(['GND']);
    expect(game.buildScenario('train-09-approach', airport, { seed: 5 }).playerPositions).toEqual(['APP', 'DEP']);
    expect(game.buildScenario('career-03-single-landing', airport, { seed: 5 }).playerPositions).toEqual(['TWR']);
  });

  it('scenarios that exercise several positions together keep them all (no default)', () => {
    expect(defaultPlayerPositions('career-07-arrivals-departures')).toBeUndefined();
    expect(game.buildScenario('career-07-arrivals-departures', airport, { seed: 5 }).playerPositions).toBeUndefined();
    expect(game.buildScenario('train-08-ifr-clearance', airport, { seed: 5 }).playerPositions).toBeUndefined();
  });

  it('every default is a subset of the scenario\'s own positions', () => {
    for (const s of game.listScenarios()) {
      const sc = game.buildScenario(s.id, airport, { seed: 5 });
      for (const p of sc.playerPositions ?? []) expect(sc.controllerPositions, s.id).toContain(p);
    }
  });
});
