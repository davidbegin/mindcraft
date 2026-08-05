import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildDogRaceProbeCommand,
    buildDogRaceResetCommand,
    dogTamingAdvancementEarned,
    findDogRaceWinner,
} from '../src/mindcraft/contest/dog_race.js';

test('builds safe advancement reset and probe commands', () => {
    assert.equal(
        buildDogRaceResetCommand('alice'),
        'advancement revoke alice only minecraft:husbandry/tame_an_animal'
    );
    assert.match(
        buildDogRaceProbeCommand('alice'),
        /^execute if entity @a\[name=alice,advancements=\{minecraft:husbandry\/tame_an_animal=true\},limit=1\]/
    );
    assert.throws(() => buildDogRaceProbeCommand('alice @a'), /Invalid Minecraft player name/);
});

test('recognizes successful advancement probes', () => {
    assert.equal(
        dogTamingAdvancementEarned('alice has 0 experience levels'),
        true
    );
    assert.equal(dogTamingAdvancementEarned('Test failed'), false);
    assert.equal(dogTamingAdvancementEarned(''), false);
});

test('finds the first participant observed with the dog-taming advancement', async () => {
    const commands = [];
    const winner = await findDogRaceWinner({
        status: 'running',
        rules: { type: 'dog_race' },
        participantIds: ['alice', 'bob'],
    }, async command => {
        commands.push(command);
        return command.includes('name=bob')
            ? 'bob has 3 experience levels'
            : 'Test failed';
    });

    assert.equal(winner, 'bob');
    assert.equal(commands.length, 2);
});

test('ignores other contest types and missing players', async () => {
    const runCommand = async () => {
        throw new Error('No player was found');
    };
    assert.equal(await findDogRaceWinner({
        status: 'running',
        rules: { type: 'dog_race' },
        participantIds: ['alice'],
    }, runCommand), null);
    assert.equal(await findDogRaceWinner({
        status: 'running',
        rules: { type: 'diamond_race' },
        participantIds: ['alice'],
    }, runCommand), null);
});
