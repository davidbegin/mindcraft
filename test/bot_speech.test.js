import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getAudibleChatText,
    getHumanCommandAcknowledgement,
    getSpokenChatText,
    isGameOperationalMessage,
    pickSpotReferencePhrase,
    SPOT_REFERENCE_PHRASES,
} from '../src/agent/speech_policy.js';

test('voices conversational text while excluding robot command syntax', () => {
    assert.equal(
        getSpokenChatText('On my way! !goToPlayer("Alex", 3)'),
        'On my way!'
    );
    assert.equal(getSpokenChatText('!goToPlayer("Alex", 3)'), '');
});

test('replaces spoken coordinates with a vague meeting-place phrase', () => {
    const coordinateLines = [
        'Meet me at x: 12, y: 64, z: -5.',
        'The base is X 12 Z -5.',
        'Head to (12, 64, -5).',
        'My coords are 12 64 -5.',
        'Meet near 12 64 -5.',
    ];
    for (const line of coordinateLines) {
        const spoken = getAudibleChatText(line);
        assert.ok(
            SPOT_REFERENCE_PHRASES.includes(spoken),
            `expected a known meeting-place phrase, got: ${spoken}`
        );
        assert.doesNotMatch(spoken, /\d/, 'spoken line must never leak coordinate digits');
    }
    assert.equal(getAudibleChatText('Meet me by the oak tree.'), 'Meet me by the oak tree.');
});

test('varies the spoken meeting-place phrase across a coordinate line', () => {
    const line = 'Meet me at x: 12, y: 64, z: -5.';
    const first = getAudibleChatText(line, () => 0);
    const last = getAudibleChatText(line, () => 0.999999);
    assert.equal(first, SPOT_REFERENCE_PHRASES[0]);
    assert.equal(last, SPOT_REFERENCE_PHRASES[SPOT_REFERENCE_PHRASES.length - 1]);
    assert.notEqual(first, last);
});

test('re-rolls the canned "the spot" line models memorized from old prompts', () => {
    const cannedLines = [
        'Meet me at the spot.',
        'meet me at the spot',
        "Let's go to the spot!",
        'Head to the spot.',
        'Come find me at the spot.',
        "I'll see you at our spot.",
    ];
    for (const line of cannedLines) {
        const spoken = getAudibleChatText(line);
        assert.notEqual(spoken, line);
        assert.ok(
            SPOT_REFERENCE_PHRASES.includes(spoken),
            `expected a known meeting-place phrase, got: ${spoken}`
        );
    }
});

test('leaves descriptive locations and ordinary "spot" talk untouched', () => {
    const untouched = [
        'Meet me at the hidden clearing.',
        'Come find me at the usual place.',
        'This spot has plenty of iron.',
        'I found a good spot for the tower.',
        'That spot is too exposed to defend.',
    ];
    for (const line of untouched) {
        assert.equal(getAudibleChatText(line), line);
    }
});

test('rewriting a coordinate line is stable when applied again', () => {
    const spoken = getAudibleChatText('Meet me at x: 12, y: 64, z: -5.');
    assert.equal(getAudibleChatText(spoken), spoken);
});

test('offers a large, unique pool of coordinate-safe meeting references', () => {
    assert.ok(
        SPOT_REFERENCE_PHRASES.length >= 50000,
        `expected at least 50,000 phrases, got ${SPOT_REFERENCE_PHRASES.length}`
    );
    assert.equal(
        new Set(SPOT_REFERENCE_PHRASES).size,
        SPOT_REFERENCE_PHRASES.length,
        'meeting-place phrases must be unique'
    );
    for (const phrase of SPOT_REFERENCE_PHRASES) {
        assert.doesNotMatch(phrase, /\d/, 'meeting-place phrases must not contain digits');
        assert.match(phrase, /[.!?]$/, 'meeting-place phrases must end with punctuation');
    }
});

test('pickSpotReferencePhrase stays within the phrase pool for edge randoms', () => {
    assert.equal(pickSpotReferencePhrase(() => 0), SPOT_REFERENCE_PHRASES[0]);
    assert.equal(
        pickSpotReferencePhrase(() => 1),
        SPOT_REFERENCE_PHRASES[SPOT_REFERENCE_PHRASES.length - 1]
    );
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
