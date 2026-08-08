import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CONTEST_BOT_CHARACTERS,
    SURVIVOR_EXTRA_CHARACTERS,
    SURVIVOR_SEASON_CAST,
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
            'hot_button',
            'netherite_race',
            'spleef',
            'team_base_siege',
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
    assert.equal(tower.defaultCharacters.length, 8);
    assert.deepEqual(
        tower.defaultCharacters.map(({ name, profileId }) => ({ name, profileId })),
        [
            { name: 'Billy', profileId: 'grok-4-5-fast' },
            { name: 'Kimmy', profileId: 'kimi-k3-fast' },
            { name: 'Marcus', profileId: 'gemini-3-6-flash' },
            { name: 'Dario', profileId: 'claude-fable-5-fast' },
            { name: 'ChipChipperson', profileId: 'gpt-5-6-luna-instant' },
            { name: 'bridget', profileId: 'composer-2-5' },
            { name: 'Leviticus', profileId: 'gpt-5-6-terra-fast' },
            { name: 'Carl', profileId: 'meta-muse-spark-1-2' },
        ]
    );
    assert.equal(tower.defaultCharacters[3].voice, 'Timmy');
    assert.equal(tower.defaultCharacters[4].voice, 'RadioClyde');
    assert.equal(tower.defaultCharacters[5].voice, 'Bridget');
    assert.equal(tower.defaultCharacters[6].voice, 'Inferno');
    assert.equal(tower.defaultCharacters[7].voice, 'Nawlins');
    assert.equal(tower.defaultCharacters[2].voice, 'Sasquatch');
    assert.ok(tower.defaultCharacters.every(character => character.systemPrompt.length > 40));
    assert.match(tower.defaultCharacters[2].systemPrompt, /curious and open/i);
    assert.match(tower.defaultCharacters[3].systemPrompt, /contingency planning/i);
    assert.match(tower.defaultCharacters[4].systemPrompt, /never rerun/i);
    assert.match(tower.defaultCharacters[4].systemPrompt, /"Back to you, Beginbot\."/);
    assert.match(tower.defaultCharacters[5].systemPrompt, /do not keep insulting/i);
    assert.match(tower.defaultCharacters[6].systemPrompt, /bluffs/i);
    assert.match(tower.defaultCharacters[7].systemPrompt, /down south, open source/i);
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
        // Muse has no effort dial; null is the quick single-shot profile.
        const quickEfforts = [null, 'none', 'low'];
        assert.ok(
            quickEfforts.includes(effort),
            `${character.name} runs ${profile.model}, which is too slow for a default chat bot`
        );
    }
});

test('Survivor seats a named character in every one of its eleven slots', () => {
    const survivor = getSurvivorSeasonPreset();
    assert.equal(survivor.defaultCharacters.length, survivor.castSize);
    assert.deepEqual(
        survivor.defaultCharacters,
        SURVIVOR_SEASON_CAST.map(character => ({ ...character }))
    );
    assert.deepEqual(
        survivor.defaultCharacters.map(character => character.name),
        [
            'Billy',
            'Kimmy',
            'Marcus',
            'Dario',
            'ChipChipperson',
            'bridget',
            'Leviticus',
            'Grimble',
            'Cyrien',
            'Jessica',
            'Beauregard',
        ]
    );
    // The contest characters lead, so a smaller season still opens with the cast
    // the games dashboard uses -- minus Muse/Carl, which stays contest-only.
    const survivorContestCast = CONTEST_BOT_CHARACTERS.filter(
        character => character.profileId !== 'meta-muse-spark-1-2'
    );
    assert.deepEqual(
        survivor.defaultCharacters.slice(0, survivorContestCast.length),
        survivorContestCast.map(character => ({ ...character }))
    );
    survivor.defaultCharacters[0].name = 'Changed';
    assert.equal(getSurvivorSeasonPreset().defaultCharacters[0].name, 'Billy');
});

test('the overflow season characters are distinct, voiced, and quick', () => {
    const profiles = new Map(getCursorProfiles().map(profile => [profile.id, profile]));
    // Muse/Carl never joins a Survivor season, so Nawlins can be reused by an
    // overflow character; only the contest characters that actually take seats need
    // to stay distinct from the overflow cast.
    const survivorContestCast = CONTEST_BOT_CHARACTERS.filter(
        character => character.profileId !== 'meta-muse-spark-1-2'
    );
    const names = new Set(survivorContestCast.map(character => character.name));
    const voices = new Set(survivorContestCast.map(character => character.voice));
    const profileIds = new Set(survivorContestCast.map(character => character.profileId));

    for (const character of SURVIVOR_EXTRA_CHARACTERS) {
        assert.ok(!names.has(character.name), `${character.name} is already cast`);
        assert.ok(!voices.has(character.voice), `${character.voice} is already spoken for`);
        assert.ok(
            !profileIds.has(character.profileId),
            `${character.name} reuses profile ${character.profileId}`
        );
        names.add(character.name);
        voices.add(character.voice);
        profileIds.add(character.profileId);

        const profile = profiles.get(character.profileId);
        assert.ok(profile, `${character.name} references unknown profile ${character.profileId}`);
        const effort = Object.values(profile.profile.model.params || {})[0] || null;
        assert.ok(
            [null, 'none', 'low'].includes(effort),
            `${character.name} runs ${profile.model}, which is too slow for a default chat bot`
        );
        assert.ok(character.systemPrompt.length > 40, `${character.name} needs a personality`);
    }

    // claude-opus is the most expensive family here, so it sits in the last seat
    // and a ten-bot season never pays for it.
    assert.equal(SURVIVOR_SEASON_CAST.at(-1).profileId, 'claude-opus-5-fast');
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

test('the six-player scenario runs two tribes into a four-person jury', () => {
    const six = getSurvivorSeasonPreset('six_player');
    assert.equal(six.castSize, 6);
    assert.equal(six.minimumPlayers, 6);
    assert.equal(six.maximumPlayers, 6);
    assert.equal(six.mergeAt, 4);
    assert.equal(six.finalistCount, 2);
    assert.equal(six.juryEligibility, 'all_eliminated');
    assert.equal(six.defaultCharacters.length, 6);
    assert.deepEqual(
        six.defaultCharacters.map(character => character.name),
        ['Billy', 'Kimmy', 'Marcus', 'Dario', 'ChipChipperson', 'bridget']
    );
    assert.deepEqual(six.challengeGameIds, [
        'cake_race',
        'team_base_siege',
        'spleef',
        'diamond_race',
        'death_race',
    ]);
});

test('scenarios are listed for the operator UI and unknown ids throw', () => {
    const scenarios = listSurvivorScenarios();
    assert.deepEqual(
        scenarios.map(scenario => scenario.scenarioId),
        ['classic', 'four_player', 'six_player']
    );
    assert.ok(scenarios.every(scenario => scenario.castSize >= scenario.minimumPlayers));
    assert.throws(() => getSurvivorSeasonPreset('duos'), /Unknown Survivor scenario/);
});

test('contest presets include game-specific rules and judge metrics', () => {
    const cake = getContestGamePreset('cake_race');
    assert.equal(cake.rules.type, 'cake_race');
    assert.equal(cake.rules.winItem, 'cake');
    assert.equal(cake.rules.teamCount, 2);
    assert.equal(cake.rules.minimumPlayersPerTeam, 3);
    assert.equal(cake.rules.planningMs, 60_000);
    assert.equal(cake.defaultParticipantCount, 6);
    assert.deepEqual(
        cake.defaultCharacters.map(character => character.name),
        ['Billy', 'Kimmy', 'Marcus', 'Dario', 'ChipChipperson', 'bridget']
    );
    assert.deepEqual(cake.rules.ingredients, {
        milk_bucket: 3,
        sugar: 2,
        egg: 1,
        wheat: 3,
    });
    assert.equal(cake.rules.metrics[0].direction, 'minimize');
    assert.equal(cake.metadata.pvp, false);
    assert.match(cake.prompt, /two-team race/i);
    assert.match(cake.prompt, /none of the cake ingredients/i);
    assert.match(cake.prompt, /three milk buckets, two sugar, one egg, and three wheat/i);
    assert.match(cake.prompt, /share what you find/i);
    assert.match(cake.prompt, /ends automatically/i);
    const cakeListed = listContestGamePresets().find(game => game.id === 'cake_race');
    assert.equal(cakeListed.teamCount, 2);
    assert.equal(cakeListed.planningMs, 60_000);
    assert.equal(cakeListed.defaultParticipantCount, 6);
    assert.equal(cakeListed.defaultCharacters.length, 6);

    const tower = getContestGamePreset('tower_battle');
    assert.equal(tower.rules.type, 'tower_battle');
    assert.equal(tower.rules.scoring, 'tallest-standing-tower');
    assert.match(tower.prompt, /balance of offense and defense/i);
    assert.match(tower.prompt, /Do not abandon your own stack/i);

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
    assert.match(teamTower.prompt, /balance of offense and defense/i);
    assert.match(teamTower.prompt, /BUILDER-DEFENDER/i);
    assert.match(teamTower.prompt, /dedicated ATTACKER/i);
    assert.match(teamTower.prompt, /Do not send the whole team on offense/i);
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

    const baseSiege = getContestGamePreset('team_base_siege');
    assert.equal(baseSiege.rules.type, 'team_base_siege');
    assert.equal(baseSiege.rules.scoring, 'last-standing');
    assert.equal(baseSiege.rules.planningMs, 0);
    assert.equal(baseSiege.rules.buildPhaseMs, 3 * 60_000);
    assert.equal(baseSiege.rules.floorY, 100);
    assert.equal(baseSiege.metadata.pvp, true);
    assert.match(baseSiege.prompt, /free-for-all/i);
    assert.match(baseSiege.prompt, /Death eliminates you for good/i);
    assert.match(baseSiege.prompt, /last person alive/i);
    assert.equal(
        listContestGamePresets().find(game => game.id === 'team_base_siege').planningMs,
        0
    );
    assert.equal(
        listContestGamePresets().find(game => game.id === 'team_base_siege').buildPhaseMs,
        3 * 60_000
    );

    const deathRace = getContestGamePreset('death_race');
    assert.equal(deathRace.rules.type, 'death_race');
    assert.equal(deathRace.rules.scoring, 'first-death-wins');
    assert.equal(deathRace.rules.metrics[0].direction, 'minimize');
    assert.equal(deathRace.metadata.pvp, false);
    assert.equal(deathRace.metadata.arena, 'death-edge-v1');
    assert.match(deathRace.prompt, /cause your own death|first competitor to die/i);
    assert.match(deathRace.prompt, /survival instincts are disabled/i);
    assert.match(deathRace.prompt, /run off|edge|outer rim/i);
    assert.match(deathRace.prompt, /NOT allowed to spawn/i);
    assert.doesNotMatch(deathRace.prompt, /drown|water pool|deep water/i);
    assert.doesNotMatch(deathRace.prompt, /blank flat plain/i);
    assert.doesNotMatch(deathRace.prompt, /central lava|lava pit/i);
    assert.match(deathRace.prompt, /ends the instant|ends automatically/i);

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
    // Breaking a bot's own floor is self-elimination, so no rule may ask for it.
    assert.equal(spleef.rules.stationaryFloorBreakMs, undefined);
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
    assert.match(spleef.prompt, /remove as much of their usable ground as you can/i);
    assert.match(spleef.prompt, /the eight blocks touching it/i);
    assert.match(spleef.prompt, /instant self-elimination/i);
    assert.match(spleef.prompt, /!playSpleef\(100\)/i);

    const hotButton = getContestGamePreset('hot_button');
    assert.equal(hotButton.rules.type, 'hot_button');
    assert.equal(hotButton.rules.scoring, 'last-standing');
    assert.equal(hotButton.durationMs, 180_000);
    assert.equal(hotButton.metadata.pvp, false);
    assert.match(hotButton.prompt, /freshly randomized every match/i);
    assert.match(hotButton.prompt, /wins the match instantly/i);
    assert.match(hotButton.prompt, /!playHotButton/i);
    assert.equal(hotButton.rules.winItem, 'nether_star');
});

test('unknown contest game ids throw', () => {
    assert.throws(() => getContestGamePreset('not_a_real_game'), /Unknown contest game/);
});
