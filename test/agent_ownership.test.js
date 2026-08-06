import assert from 'node:assert/strict';
import test from 'node:test';
import {
    colonyControlsAgent,
    isGameSessionAgent,
} from '../src/mindcraft/agent_ownership.js';

test('a contest bot is never owned by the colony', () => {
    const contestBot = {
        name: 'terra_instant',
        settings: { game_session: { sessionId: 'survivor-1' } },
    };
    assert.equal(isGameSessionAgent(contestBot), true);
    assert.equal(colonyControlsAgent(contestBot), false);
});

test('an ordinary colony bot stays under colony control', () => {
    const colonyBot = { name: 'miner', settings: { colony: { enabled: true } } };
    assert.equal(isGameSessionAgent(colonyBot), false);
    assert.equal(colonyControlsAgent(colonyBot), true);
});

test('a missing connection is controlled by nobody', () => {
    assert.equal(colonyControlsAgent(null), false);
    assert.equal(colonyControlsAgent(undefined), false);
    assert.equal(isGameSessionAgent(null), false);
});

test('a bot with no settings is treated as a colony bot, not a game bot', () => {
    assert.equal(isGameSessionAgent({ name: 'andy' }), false);
    assert.equal(colonyControlsAgent({ name: 'andy' }), true);
});
