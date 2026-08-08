import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CONTEST_BOT_CHARACTERS,
    getContestGamePreset,
    getSurvivorSeasonPreset,
    listContestGamePresets,
    listSurvivorScenarios,
} from '../src/mindcraft/contest/game_presets.js';
import { getCursorProfiles } from '../src/mindcraft/model_profiles.js';

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
            'spleef',
            'team_tower_battle',
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
            { name: 'Billy', profileId: 'grok-4-5-fast' },
            { name: 'Kimmy', profileId: 'kimi-k3-fast' },
            { name: 'Marcus', profileId: 'gemini-3-1-pro' },
            { name: 'Dario', profileId: 'claude-fable-5-fast' },
            { name: 'ChipChipperson', profileId: 'gpt-5-6-luna-instant' },
            { name: 'bridget', profileId: 'composer-2-5' },
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

test('every default character runs on a different model family at a quick effort', () => {
    const profiles = new Map(getCursorProfiles().map(profile => [profile.id, profile]));
    const families = new Set();

    for (const character of CONTEST_BOT_CHARACTERS) {
        const profile = profiles.get(character.profileId);
        assert.ok(profile, `${character.name} references unknown profile ${character.profileId}`);
        assert.ok(
            !families.has(profile.family),
            `${character.name} reuses the ${profile.family} model family`
        );
        families.add(profile.family);

        const effort = Object.values(profile.profile.model.params || {})[0] || null;
        assert.ok(
            [null, 'none', 'low'].includes(effort),
            `${character.name} runs ${profile.model}, which is too slow for a default chat bot`
        );
    }
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

test('the four-player scenario casts four bots for a final two', () => {
    const four = getSurvivorSeasonPreset('four_player');
    assert.equal(four.castSize, 4);
    assert.equal(four.minimumPlayers, 4);
    assert.equal(four.finalistCount, 2);
    assert.equal(four.mergeAt, 4);
    assert.equal(four.defaultCharacters.length, 4);
    assert.deepEqual(
        four.defaultCharacters.map(character => character.name),
        ['Billy', 'Kimmy', 'Marcus', 'Dario']
    );
    assert.ok(four.challengeGameIds.length > 0);
    assert.ok(four.phaseDurationsMs.strategy < getSurvivorSeasonPreset().phaseDurationsMs.strategy);
});

test('scenarios are listed for the operator UI and unknown ids throw', () => {
    const scenarios = listSurvivorScenarios();
    assert.deepEqual(
        scenarios.map(scenario => scenario.scenarioId),
        ['classic', 'four_player']
    );
    assert.ok(scenarios.every(scenario => scenario.castSize >= scenario.minimumPlayers));
    assert.throws(() => getSurvivorSeasonPreset('duos'), /Unknown Survivor scenario/);
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

    const teamTower = getContestGamePreset('team_tower_battle');
    assert.equal(teamTower.rules.type, 'team_tower_battle');
    assert.equal(teamTower.rules.deathPenaltyBlocks, 5);
    assert.equal(teamTower.rules.minimumPlayersPerTeam, 2);
    assert.equal(teamTower.rules.planningMs, 60_000);
    assert.equal(teamTower.metadata.pvp, true);
    assert.match(teamTower.prompt, /friendly fire is disabled/i);
    assert.match(teamTower.prompt, /planning phase/i);
    assert.match(teamTower.prompt, /Attacking is mandatory, not optional/i);
    assert.match(teamTower.prompt, /dedicated ATTACKER/i);
    assert.match(teamTower.prompt, /place blocks only when they connect/i);
    assert.match(teamTower.prompt, /never place a new foundation/i);
    assert.equal(
        listContestGamePresets().find(game => game.id === 'team_tower_battle').planningMs,
        60_000
    );
    assert.equal(
        listContestGamePresets().find(game => game.id === 'tower_battle').planningMs,
        0
    );

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

    const spleef = getContestGamePreset('spleef');
    assert.equal(spleef.rules.type, 'spleef');
    assert.equal(spleef.rules.scoring, 'last-standing');
    assert.equal(spleef.rules.floorY, 100);
    assert.equal(spleef.durationMs, 300_000);
    assert.equal(spleef.metadata.pvp, false);
    assert.match(spleef.prompt, /diamond shovel/i);
    assert.match(spleef.prompt, /last competitor still standing/i);
    // Core knowledge the bots kept failing at: win by dropping OTHERS, never dig
    // under your own feet, and aim breaks at a rival's coordinates.
    assert.match(spleef.prompt, /making OTHER players fall/i);
    assert.match(spleef.prompt, /never break the block you are standing on/i);
    assert.match(spleef.prompt, /never dig straight down/i);
    assert.match(spleef.prompt, /a rival's coordinates, not your own/i);
    assert.match(spleef.prompt, /ahead of a moving rival/i);
    assert.match(spleef.prompt, /cut off their escape/i);
});

test('unknown contest game ids throw', () => {
    assert.throws(() => getContestGamePreset('not_a_real_game'), /Unknown contest game/);
});
