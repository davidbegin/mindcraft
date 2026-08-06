import assert from 'node:assert/strict';
import test from 'node:test';

import { SpectatorDirector } from '../src/mindcraft/contest/spectator_director.js';

function positionReply(name, position) {
    return `${name} has the following entity data: `
        + `[${position.x}d, ${position.y}d, ${position.z}d]`;
}

function createHarness() {
    const commands = [];
    const positions = {
        alice: { x: 0, y: 64, z: 0 },
        bob: { x: 10, y: 64, z: 0 },
    };
    let intervalCallback = null;
    const director = new SpectatorDirector({
        random: () => 0,
        setInterval: callback => {
            intervalCallback = callback;
            return 42;
        },
        clearInterval: () => {},
        runCommand: command => {
            commands.push(command);
            if (command === 'list') {
                return Promise.resolve(
                    'There are 3 of a max of 20 players online: alice, bob, human'
                );
            }
            const match = command.match(/^data get entity (\w+) Pos$/);
            if (match) {
                return Promise.resolve(positionReply(match[1], positions[match[1]]));
            }
            return Promise.resolve('ok');
        },
    });
    return {
        commands,
        director,
        positions,
        getIntervalCallback: () => intervalCallback,
    };
}

test('starts by putting human players in spectator mode and following a participant', async () => {
    const { commands, director, getIntervalCallback } = createHarness();

    const view = await director.start({
        id: 'contest-1',
        participantIds: ['alice', 'bob'],
    });

    assert.deepEqual(view.spectators, ['human']);
    assert.equal(view.currentTarget, 'alice');
    assert.ok(commands.includes('gamemode spectator human'));
    assert.ok(commands.includes('spectate alice human'));
    assert.equal(typeof getIntervalCallback(), 'function');
});

test('switches to a different moving participant when movement begins', async () => {
    const { commands, director, positions } = createHarness();
    await director.start({
        id: 'contest-1',
        participantIds: ['alice', 'bob'],
    });

    positions.bob = { x: 11, y: 64, z: 0 };
    await director.tick();

    assert.equal(director.view().currentTarget, 'bob');
    assert.equal(commands.at(-1), 'spectate bob human');
});

test('stopping releases the spectator from the followed entity', async () => {
    const { commands, director } = createHarness();
    await director.start({
        id: 'contest-1',
        participantIds: ['alice', 'bob'],
    });

    const view = await director.stop();

    assert.equal(view.enabled, false);
    assert.ok(commands.includes('execute as human run spectate'));
});

test('does not start without an online human spectator', async () => {
    const director = new SpectatorDirector({
        runCommand: command => Promise.resolve(command === 'list'
            ? 'There are 2 of a max of 20 players online: alice, bob'
            : 'ok'),
    });

    await assert.rejects(
        () => director.start({
            id: 'contest-1',
            participantIds: ['alice', 'bob'],
        }),
        /No human spectator/
    );
});
