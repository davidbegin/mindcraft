import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationRequestRegistry } from '../src/mindcraft/survivor/conversation_requests.js';

const eligible = ['Alice', 'Billy', 'Dario', 'Marcus'];

function registryWithClock(options = {}) {
    const events = [];
    let id = 0;
    let now = 1_000;
    const registry = new ConversationRequestRegistry({
        idFactory: () => `req-${++id}`,
        onEvent: event => events.push(event),
        clock: () => now,
        ...options,
    });
    return {
        events,
        registry,
        advance(ms) {
            now += ms;
            return now;
        },
        now: () => now,
    };
}

test('a room opens for the bots who said yes and skips the ones who said no', () => {
    const { registry } = registryWithClock();
    const request = registry.open('Alice', ['Billy', 'Dario'], eligible, { pitch: 'Final three?' });

    registry.respond(request.id, 'Billy', true);
    const second = registry.respond(request.id, 'Dario', false, 'Not with you.');
    assert.equal(second.settled, true);
    assert.deepEqual(second.accepterIds, ['Billy']);

    const { request: resolved, accepterIds } = registry.resolve(request.id, 'room-1');
    assert.equal(resolved.status, 'accepted');
    assert.equal(resolved.roomId, 'room-1');
    assert.deepEqual(accepterIds, ['Billy']);
});

test('a request everyone refuses opens no room at all', () => {
    const { registry, events } = registryWithClock();
    const request = registry.open('Alice', ['Billy'], eligible);
    registry.respond(request.id, 'Billy', false, 'I am done talking to you.');

    const { request: resolved } = registry.resolve(request.id, 'room-1');
    assert.equal(resolved.status, 'declined');
    assert.equal(resolved.roomId, null);

    const declined = events.find(event => event.type === 'talk.declined');
    assert.equal(declined.reason, 'I am done talking to you.');
});

test('silence at the deadline counts as a refusal', () => {
    const { registry, advance } = registryWithClock({ requestTtlMs: 30_000 });
    const request = registry.open('Alice', ['Billy', 'Dario'], eligible);
    registry.respond(request.id, 'Billy', true);

    assert.deepEqual(registry.dueRequests(), []);
    advance(30_000);
    assert.deepEqual(registry.dueRequests().map(item => item.id), [request.id]);

    const { accepterIds } = registry.resolve(request.id, 'room-1');
    assert.deepEqual(accepterIds, ['Billy']);
});

test('with no invite TTL, pending asks never become due on the clock', () => {
    const { registry, advance } = registryWithClock();
    const request = registry.open('Alice', ['Billy'], eligible);
    assert.equal(request.expiresAt, null);
    advance(120_000);
    assert.deepEqual(registry.dueRequests(), []);
    assert.equal(registry.pending()[0].status, 'pending');
});

test('a bot waits on one answer at a time and cannot re-ask someone who just refused', () => {
    const { registry, advance } = registryWithClock({ declineCooldownMs: 45_000 });
    const first = registry.open('Alice', ['Billy'], eligible);
    assert.throws(() => registry.open('Alice', ['Dario'], eligible), /already waiting on an answer/);

    registry.respond(first.id, 'Billy', false);
    registry.resolve(first.id);
    assert.throws(() => registry.open('Alice', ['Billy'], eligible), /already turned you down/);

    const second = registry.open('Alice', ['Dario'], eligible);
    advance(45_000);
    registry.resolve(second.id);
    assert.doesNotThrow(() => registry.open('Alice', ['Billy'], eligible));
});

test('a bot only sees its own asks and the asks pointed at it', () => {
    const { registry } = registryWithClock();
    const mine = registry.open('Alice', ['Billy'], eligible);
    const theirs = registry.open('Dario', ['Marcus'], eligible);

    assert.deepEqual(registry.pendingFor('Alice').map(item => item.id), [mine.id]);
    assert.deepEqual(registry.pendingFor('Billy').map(item => item.id), [mine.id]);
    assert.deepEqual(registry.pendingFor('Marcus').map(item => item.id), [theirs.id]);
});

test('an invitee answers once, and only if they were asked', () => {
    const { registry } = registryWithClock();
    const request = registry.open('Alice', ['Billy'], eligible);

    assert.throws(() => registry.respond(request.id, 'Marcus', true), /was not asked/);
    registry.respond(request.id, 'Billy', true);
    assert.throws(() => registry.respond(request.id, 'Billy', false), /already answered/);

    registry.resolve(request.id, 'room-1');
    assert.throws(() => registry.respond(request.id, 'Billy', true), /already accepted/);
});

test('a request names available players and stays within the group limit', () => {
    const { registry } = registryWithClock({ maxInvitees: 2 });
    assert.throws(() => registry.open('Alice', [], eligible), /at least one other player/);
    assert.throws(() => registry.open('Alice', ['Alice'], eligible), /at least one other player/);
    assert.throws(() => registry.open('Alice', ['Nobody'], eligible), /Not available to talk: Nobody/);
    assert.throws(
        () => registry.open('Alice', ['Billy', 'Dario', 'Marcus'], eligible),
        /at most 2 players/
    );
    assert.throws(() => registry.open('Ghost', ['Billy'], eligible), /cannot start a private conversation/);
});

test('elimination and phase cleanup drop pending requests', () => {
    const { registry } = registryWithClock();
    const asked = registry.open('Alice', ['Billy'], eligible);
    const asking = registry.open('Billy', ['Dario'], eligible);

    registry.removePlayer('Billy');
    assert.equal(registry.get(asked.id).status, 'cancelled');
    assert.equal(registry.get(asking.id).status, 'cancelled');

    registry.open('Dario', ['Marcus'], eligible);
    registry.cancelAll('voting-started');
    assert.deepEqual(registry.view(), []);
});
