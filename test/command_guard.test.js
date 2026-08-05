import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandGuard, looksLikeFailure, ALLOWED_WHILE_DEAD } from '../src/agent/commands/command_guard.js';

test('allows a command until it fails twice with identical args', () => {
    const guard = new CommandGuard(() => 1_000);
    const args = [-48, 64, -13, 2];

    assert.equal(guard.check('!goToCoordinates', args), null);
    guard.record('!goToCoordinates', args, 'Path not found, but attempting to navigate anyway using destructive movements.\nPathfinding stopped: Cannot break stone with current tools.');

    assert.equal(guard.check('!goToCoordinates', args), null);
    guard.record('!goToCoordinates', args, 'Timeout: Took to long to decide path to goal!');

    const rejection = guard.check('!goToCoordinates', args);
    assert.match(rejection, /failed 2 times/);
    assert.match(rejection, /!clearArea|!placeRow/);
});

test('different args are tracked independently', () => {
    const guard = new CommandGuard(() => 1_000);
    guard.record('!goToCoordinates', [1, 2, 3, 1], 'Path not found');
    guard.record('!goToCoordinates', [1, 2, 3, 1], 'Path not found');
    assert.notEqual(guard.check('!goToCoordinates', [1, 2, 3, 1]), null);
    assert.equal(guard.check('!goToCoordinates', [9, 9, 9, 1]), null);
});

test('a success resets the failure count', () => {
    const guard = new CommandGuard(() => 1_000);
    const args = ['cobblestone', 32];
    guard.record('!putInChest', args, 'Error: Event windowOpen did not fire within timeout of 20000ms');
    guard.record('!putInChest', args, 'Successfully deposited 32 cobblestone.');
    guard.record('!putInChest', args, 'Error: Event windowOpen did not fire within timeout of 20000ms');
    assert.equal(guard.check('!putInChest', args), null);
});

test('failures expire after the tracking window', () => {
    let now = 1_000;
    const guard = new CommandGuard(() => now);
    const args = ['farmer2', 'chicken', 1];
    guard.record('!givePlayer', args, 'Failed to give chicken to farmer2, it was never received.');
    guard.record('!givePlayer', args, 'Failed to give chicken to farmer2, it was never received.');
    assert.notEqual(guard.check('!givePlayer', args), null);

    now += 5 * 60 * 1000 + 1;
    assert.equal(guard.check('!givePlayer', args), null);
});

test('chest failures escalate with a replace-the-chest hint', () => {
    const guard = new CommandGuard(() => 1_000);
    const args = ['cobblestone', 32];
    guard.record('!putInChest', args, 'Error: Event windowOpen did not fire within timeout of 20000ms');
    guard.record('!putInChest', args, 'Error: Event windowOpen did not fire within timeout of 20000ms');
    const rejection = guard.check('!putInChest', args);
    assert.match(rejection, /Place a new chest/);
});

test('failure detection distinguishes success from failure text', () => {
    assert.equal(looksLikeFailure('You have reached -13, 69, -28.'), false);
    assert.equal(looksLikeFailure('Planted 12 wheat_seeds.'), false);
    assert.equal(looksLikeFailure('Could not find a bed to sleep in.'), true);
    assert.equal(looksLikeFailure('Failed to give cobblestone to builder, too close.'), true);
    assert.equal(looksLikeFailure(undefined), false);
    assert.equal(looksLikeFailure(''), false);
});

test('stop and restart stay usable while dead', () => {
    assert.ok(ALLOWED_WHILE_DEAD.has('!stop'));
    assert.ok(ALLOWED_WHILE_DEAD.has('!restart'));
    assert.ok(!ALLOWED_WHILE_DEAD.has('!goToCoordinates'));
});
