import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getHumanCommandAcknowledgement,
    getSpokenChatText,
    isGameOperationalMessage,
} from '../src/agent/speech_policy.js';

test('voices conversational text while excluding robot command syntax', () => {
    assert.equal(
        getSpokenChatText('On my way! !goToPlayer("Alex", 3)'),
        'On my way!'
    );
    assert.equal(getSpokenChatText('!goToPlayer("Alex", 3)'), '');
});

test('guarantees humans an audible reply when a model emits only a command', () => {
    assert.equal(
        getHumanCommandAcknowledgement('!followPlayer("Alex", 4)', 'Alex'),
        'Got it, Alex.'
    );
    assert.equal(
        getHumanCommandAcknowledgement('I will follow you. !followPlayer("Alex", 4)', 'Alex'),
        null
    );
});

test('does not invent acknowledgements for internal prose or bot commands with speech', () => {
    assert.equal(getHumanCommandAcknowledgement('Checking my inventory.', 'Alex'), null);
    assert.equal(
        getHumanCommandAcknowledgement('I found it! !inventory', 'Alex'),
        null
    );
});

test('identifies game operational statuses that should remain silent', () => {
    assert.equal(isGameOperationalMessage('Picking up item!'), true);
    assert.equal(isGameOperationalMessage('[CODING @ 10,64,-5] Waiting on model...'), true);
    assert.equal(isGameOperationalMessage('[CODING DONE] Finished custom code.'), true);
    assert.equal(isGameOperationalMessage('I am picking up an item for you.'), false);
    assert.equal(isGameOperationalMessage('I finished building the tower!'), false);
});
