import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CONTEST_BOT_CHARACTERS,
    getContestGamePreset,
    listContestGamePresets,
} from '../src/mindcraft/contest/game_presets.js';

test('lists the starter contest games for the UI', () => {
    const games = listContestGamePresets();
    assert.deepEqual(
        games.map(game => game.id).sort(),
        [
            'death_race',
            'deepest_2_5',
            'deepest_5',
            'diamond_race',
            'dog_race',
            'netherite_race',
            'tower_battle',
        ]
    );
    const tower = games.find(game => game.id === 'tower_battle');
    assert.equal(tower.durationLabel, '2 min 30 sec');
    assert.equal(tower.durationMs, 150_000);
    assert.deepEqual(tower.narrator, {
        name: 'narrator',
        voice: 'Narrator',
    });
    assert.deepEqual(
        tower.defaultCharacters,
        CONTEST_BOT_CHARACTERS.map(character => ({ ...character }))
    );
    assert.equal(tower.defaultCharacters.length, 4);
    assert.deepEqual(
        tower.defaultCharacters.map(({ name, profileId }) => ({ name, profileId })),
        [
            { name: 'Billy', profileId: 'gpt-5-6-luna-instant' },
            { name: 'Alice', profileId: 'claude' },
            { name: 'Marcus', profileId: 'gemini' },
            { name: 'Priya', profileId: 'grok' },
        ]
    );
    assert.ok(tower.defaultCharacters.every(character => character.systemPrompt.length > 40));
});

test('contest presets include game-specific rules and judge metrics', () => {
    const tower = getContestGamePreset('tower_battle');
    assert.equal(tower.rules.type, 'tower_battle');
    assert.equal(tower.rules.scoring, 'tallest-standing-tower');
    assert.equal(tower.metadata.pvp, true);
    assert.match(tower.prompt, /Nothing is submitted/);
    assert.match(tower.prompt, /timer expires/);
    assert.doesNotMatch(tower.prompt, /five minutes/i);

    const deathRace = getContestGamePreset('death_race');
    assert.equal(deathRace.rules.type, 'death_race');
    assert.equal(deathRace.rules.scoring, 'first-death-wins');
    assert.equal(deathRace.rules.metrics[0].direction, 'minimize');
    assert.equal(deathRace.metadata.pvp, false);
    assert.match(deathRace.prompt, /cause your own death/i);
    assert.match(deathRace.prompt, /survival instincts are disabled/i);
    assert.match(deathRace.prompt, /ends automatically/i);

    const diamonds = getContestGamePreset('diamond_race');
    assert.equal(diamonds.rules.winItem, 'diamond');
    assert.equal(diamonds.rules.metrics[0].direction, 'minimize');

    const dog = getContestGamePreset('dog_race');
    assert.equal(dog.rules.type, 'dog_race');
    assert.equal(dog.rules.winEntity, 'wolf');
    assert.equal(dog.rules.winAdvancement, 'minecraft:husbandry/tame_an_animal');
    assert.equal(dog.rules.metrics[0].direction, 'minimize');
    assert.match(dog.prompt, /start without bones/i);
    assert.match(dog.prompt, /ends automatically/i);

    const netherite = getContestGamePreset('netherite_race');
    assert.equal(netherite.rules.type, 'netherite_race');
    assert.equal(netherite.rules.winItem, 'netherite_ingot');
    assert.equal(netherite.rules.metrics[0].direction, 'minimize');
    assert.match(netherite.prompt, /three diamonds/i);
    assert.match(netherite.prompt, /diamond pickaxe/i);
    assert.match(netherite.prompt, /four ancient debris/i);

    const shortDepth = getContestGamePreset('deepest_2_5');
    assert.equal(shortDepth.durationMs, 150_000);
    assert.equal(shortDepth.rules.type, 'depth_race');
    assert.equal(shortDepth.rules.startY, 101);
    assert.match(shortDepth.prompt, /Y-coordinate is measured automatically/i);

    const longDepth = getContestGamePreset('deepest_5');
    assert.equal(longDepth.durationMs, 300_000);
    assert.equal(longDepth.rules.scoring, 'lowest-y-at-deadline');
});

test('unknown contest game ids throw', () => {
    assert.throws(() => getContestGamePreset('spleef'), /Unknown contest game/);
});
