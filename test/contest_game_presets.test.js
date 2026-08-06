import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CONTEST_BOT_CHARACTERS,
    getContestGamePreset,
    getSurvivorSeasonPreset,
    listContestGamePresets,
} from '../src/mindcraft/contest/game_presets.js';

test('lists the starter contest games for the UI', () => {
    const games = listContestGamePresets();
    assert.deepEqual(
        games.map(game => game.id).sort(),
        [
            'cake_race',
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
    assert.equal(tower.defaultCharacters.length, 7);
    assert.deepEqual(
        tower.defaultCharacters.map(({ name, profileId }) => ({ name, profileId })),
        [
            { name: 'Billy', profileId: 'gpt-5-6-luna-instant' },
            { name: 'Alice', profileId: 'claude' },
            { name: 'Marcus', profileId: 'gpt-5-6-terra-balanced' },
            { name: 'Dario', profileId: 'gpt-5-6-terra-thorough' },
            { name: 'ChipChipperson', profileId: 'gpt-5-6-sol-instant' },
            { name: 'bridget', profileId: 'gpt-5-6-terra-balanced' },
            { name: 'Leviticus', profileId: 'gpt-5-6-terra-fast' },
        ]
    );
    assert.equal(tower.defaultCharacters[3].voice, 'Timmy');
    assert.equal(tower.defaultCharacters[4].voice, 'RadioClyde');
    assert.equal(tower.defaultCharacters[5].voice, 'Bridget');
    assert.equal(tower.defaultCharacters[6].voice, 'Inferno');
    assert.equal(tower.defaultCharacters[2].voice, 'Sasquatch');
    assert.ok(tower.defaultCharacters.every(character => character.systemPrompt.length > 40));
    assert.match(tower.defaultCharacters[2].systemPrompt, /curious and open/i);
    assert.match(tower.defaultCharacters[3].systemPrompt, /contingency planning/i);
    assert.match(tower.defaultCharacters[4].systemPrompt, /never rerun/i);
    assert.match(tower.defaultCharacters[5].systemPrompt, /do not keep insulting/i);
    assert.match(tower.defaultCharacters[6].systemPrompt, /bluffs/i);
});

test('Survivor uses the canonical contest characters by default', () => {
    const survivor = getSurvivorSeasonPreset();
    assert.deepEqual(
        survivor.defaultCharacters,
        CONTEST_BOT_CHARACTERS.map(character => ({ ...character }))
    );
    assert.equal(survivor.defaultCharacters.length, 7);
    survivor.defaultCharacters[0].name = 'Changed';
    assert.equal(getSurvivorSeasonPreset().defaultCharacters[0].name, 'Billy');
});

test('contest presets include game-specific rules and judge metrics', () => {
    const cake = getContestGamePreset('cake_race');
    assert.equal(cake.rules.type, 'cake_race');
    assert.equal(cake.rules.winItem, 'cake');
    assert.deepEqual(cake.rules.ingredients, {
        milk_bucket: 3,
        sugar: 2,
        egg: 1,
        wheat: 3,
    });
    assert.equal(cake.rules.metrics[0].direction, 'minimize');
    assert.equal(cake.metadata.pvp, false);
    assert.match(cake.prompt, /none of the cake ingredients/i);
    assert.match(cake.prompt, /three milk buckets, two sugar, one egg, and three wheat/i);
    assert.match(cake.prompt, /ends automatically/i);

    const tower = getContestGamePreset('tower_battle');
    assert.equal(tower.rules.type, 'tower_battle');
    assert.equal(tower.rules.scoring, 'tallest-standing-tower');
    assert.match(tower.prompt, /distinctive balance/i);

    for (const game of listContestGamePresets()) {
        assert.doesNotMatch(
            getContestGamePreset(game.id).prompt,
            /trade playful trash talk with every rival/i
        );
    }
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
    assert.match(deathRace.prompt, /no prescribed solution/i);
    assert.doesNotMatch(deathRace.prompt, /lava pit/i);
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
