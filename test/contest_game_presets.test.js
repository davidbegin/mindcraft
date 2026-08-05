import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getContestGamePreset,
    listContestGamePresets,
} from '../src/mindcraft/contest/game_presets.js';

test('lists the starter contest games for the UI', () => {
    const games = listContestGamePresets();
    assert.deepEqual(
        games.map(game => game.id).sort(),
        ['diamond_race', 'tower_battle']
    );
    assert.match(games.find(game => game.id === 'tower_battle').durationLabel, /5/);
});

test('tower battle and diamond race presets include judge metrics', () => {
    const tower = getContestGamePreset('tower_battle');
    assert.equal(tower.rules.type, 'tower_battle');
    assert.equal(tower.rules.scoring, 'tallest-standing-tower');
    assert.equal(tower.metadata.pvp, true);
    assert.match(tower.prompt, /Nothing is submitted/);

    const diamonds = getContestGamePreset('diamond_race');
    assert.equal(diamonds.rules.winItem, 'diamond');
    assert.equal(diamonds.rules.metrics[0].direction, 'minimize');
});

test('unknown contest game ids throw', () => {
    assert.throws(() => getContestGamePreset('spleef'), /Unknown contest game/);
});
