import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function loadJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

const MDL_PHRASES = [
    'Compress useful information',
    'minimize words',
];

test('default prompts prefer Bennett weakness over MDL compression', () => {
    const profile = loadJson('./profiles/defaults/_default.json');

    for (const phrase of MDL_PHRASES) {
        assert.equal(
            profile.saving_memory.includes(phrase),
            false,
            `saving_memory still pushes MDL phrase: ${phrase}`
        );
        assert.equal(
            profile.coding.includes(phrase),
            false,
            `coding still pushes MDL phrase: ${phrase}`
        );
    }

    assert.match(profile.saving_memory, /Bennett's Razor/);
    assert.match(profile.saving_memory, /WEAK rules/);
    assert.match(profile.saving_memory, /transferable rules/);
    assert.match(profile.saving_memory, /500 characters/);

    assert.match(profile.coding, /Prefer WEAK/);
    assert.match(profile.coding, /parameterize/i);
    assert.match(profile.coding, /strategy class/);

    const bridgeExample = profile.coding_examples.find(turns =>
        turns.some(turn =>
            typeof turn.content === 'string' &&
            turn.content.includes('elevate and bridge')
        )
    );
    assert.ok(bridgeExample, 'expected a weak/parameterized path-around-water coding example');
});

test('task profiles that override saving_memory also drop MDL compression language', () => {
    for (const path of [
        './profiles/tasks/crafting_profile.json',
        './profiles/tasks/cooking_profile.json',
    ]) {
        const profile = loadJson(path);
        for (const phrase of MDL_PHRASES) {
            assert.equal(
                profile.saving_memory.includes(phrase),
                false,
                `${path} still pushes MDL phrase: ${phrase}`
            );
        }
        assert.match(profile.saving_memory, /Bennett's Razor/);
    }
});

test('history truncation hint prefers transferable rules over compression', () => {
    const source = readFileSync('./src/agent/history.js', 'utf8');
    assert.match(source, /Prefer transferable rules over excess coordinates next time/);
    assert.equal(source.includes('Compress it more next time'), false);
});
