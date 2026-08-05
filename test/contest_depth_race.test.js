import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildDepthProbeCommand,
    parsePlayerY,
    scoreDepthRace,
} from '../src/mindcraft/contest/depth_race.js';

test('builds safe position probes and parses Minecraft entity positions', () => {
    assert.equal(buildDepthProbeCommand('alice'), 'data get entity alice Pos');
    assert.throws(() => buildDepthProbeCommand('alice @a'), /Invalid Minecraft player name/);
    assert.equal(
        parsePlayerY('alice has the following entity data: [100000.5d, -42.25d, 99998.0d]'),
        -42.25
    );
    assert.equal(parsePlayerY('No entity was found'), null);
});

test('scores lower Y coordinates as greater depth', async () => {
    const positions = {
        alice: 'alice has the following entity data: [1.0d, 60.5d, 3.0d]',
        bob: 'bob has the following entity data: [1.0d, 12.0d, 3.0d]',
    };
    const results = await scoreDepthRace({
        participantIds: ['alice', 'bob'],
        startY: 101,
        runCommand: command => Promise.resolve(positions[command.split(' ')[3]]),
    });

    assert.equal(results[0].score, 40.5);
    assert.equal(results[1].score, 89);
    assert.equal(results[1].details.y, 12);
    assert.equal(results[1].disqualified, false);
});

test('disqualifies participants whose position cannot be measured', async () => {
    const [result] = await scoreDepthRace({
        participantIds: ['offline'],
        startY: 101,
        runCommand: () => Promise.reject(new Error('No entity was found')),
    });

    assert.equal(result.disqualified, true);
    assert.equal(result.score, 0);
    assert.match(result.details, /No entity was found/);
});
