import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationRequestRegistry } from '../src/mindcraft/survivor/conversation_requests.js';

const CAST = ['Alice', 'Billy', 'Cara', 'Dev'];

function createRegistry(options = {}) {
    let now = options.now ?? 0;
    let sequence = 0;
    const events = [];
    const registry = new ConversationRequestRegistry({
        idFactory: () => `talk-${++sequence}`,
        clock: () => now,
        onEvent: event => events.push(event),
        ...options,
    });
    return {
        registry,
        events,
        advance: milliseconds => {
            now += milliseconds;
        },
    };
}

test('a request only becomes a conversation once someone accepts', () => {
    const { registry, events } = createRegistry();
    const request = registry.open('Alice', ['Billy', 'Cara'], CAST, { pitch: 'final three?' });
    assert.equal(request.status, 'pending');
    assert.deepEqual(request.inviteeIds, ['Billy', 'Cara']);

    const first = registry.respond(request.id, 'Billy', true);
    assert.equal(first.settled, false, 'Cara has not answered yet');
    assert.deepEqual(first.outstandingIds, ['Cara']);

    const second = registry.respond(request.id, 'Cara', false, 'I am with Dev');
    assert.equal(second.settled, true);
    assert.deepEqual(second.accepterIds, ['Billy']);

    const { request: resolved, accepterIds } = registry.resolve(request.id, 'room-9');
    assert.equal(resolved.status, 'accepted');
    assert.equal(resolved.roomId, 'room-9');
    assert.deepEqual(accepterIds, ['Billy'], 'only Billy is in the room');
    assert.deepEqual(
        events.map(event => event.type),
        ['talk.requested', 'talk.accepted', 'talk.declined', 'talk.resolved']
    );
});

test('a request everyone refuses opens no room at all', () => {
    const { registry } = createRegistry();
    const request = registry.open('Alice', ['Billy'], CAST);
    registry.respond(request.id, 'Billy', false, 'not talking to you');

    const { request: resolved, accepterIds } = registry.resolve(request.id, 'room-9');
    assert.equal(resolved.status, 'declined');
    assert.equal(resolved.roomId, null, 'a refused request must not leave a room behind');
    assert.deepEqual(accepterIds, []);
});

test('silence at the deadline counts as a refusal', () => {
    const { registry, advance } = createRegistry({ requestTtlMs: 30_000 });
    const request = registry.open('Alice', ['Billy', 'Cara'], CAST);
    registry.respond(request.id, 'Billy', true);

    assert.deepEqual(registry.dueRequests(), [], 'not due yet');
    advance(30_000);
    assert.deepEqual(registry.dueRequests().map(item => item.id), [request.id]);

    const { accepterIds } = registry.resolve(request.id, 'room-1');
    assert.deepEqual(accepterIds, ['Billy'], 'Cara never answered, so she is not in the room');
});

test('a player who was turned down cannot immediately ask again', () => {
    const { registry, advance } = createRegistry({ declineCooldownMs: 45_000 });
    const first = registry.open('Alice', ['Billy'], CAST);
    registry.respond(first.id, 'Billy', false);
    registry.resolve(first.id);

    assert.throws(() => registry.open('Alice', ['Billy'], CAST), /turned you down/);
    // Someone else is still fair game.
    assert.ok(registry.open('Alice', ['Cara'], CAST));

    registry.cancelAll('phase-ended');
    advance(45_000);
    assert.ok(registry.open('Alice', ['Billy'], CAST), 'the cooldown expires');
});

test('one open ask at a time, and only at players who can talk', () => {
    const { registry } = createRegistry();
    registry.open('Alice', ['Billy'], CAST);
    assert.throws(() => registry.open('Alice', ['Cara'], CAST), /already waiting/);
    assert.throws(() => registry.open('Alice', [], CAST), /at least one other player/);
    assert.throws(() => registry.open('Alice', ['Ghost'], CAST), /Not available to talk: Ghost/);
    assert.throws(() => registry.open('Ghost', ['Alice'], CAST), /cannot start a private conversation/);
    assert.throws(
        () => registry.open('Billy', ['Alice', 'Cara', 'Dev', 'Eve', 'Fay'], [...CAST, 'Eve', 'Fay']),
        /at most 4 players/
    );
});

test('a player only ever sees requests they are part of', () => {
    const { registry } = createRegistry();
    registry.open('Alice', ['Billy'], CAST);
    registry.open('Cara', ['Dev'], CAST);

    assert.deepEqual(registry.pendingFor('Alice').map(item => item.requesterId), ['Alice']);
    assert.deepEqual(registry.pendingFor('Billy').map(item => item.requesterId), ['Alice']);
    assert.deepEqual(registry.pendingFor('Dev').map(item => item.requesterId), ['Cara']);
    assert.equal(registry.pendingFor('Alice').length, 1, 'Cara and Dev talking is invisible to Alice');
});

test('nobody answers twice and strangers cannot answer at all', () => {
    const { registry } = createRegistry();
    const request = registry.open('Alice', ['Billy'], CAST);
    registry.respond(request.id, 'Billy', true);
    assert.throws(() => registry.respond(request.id, 'Billy', false), /already answered/);
    assert.throws(() => registry.respond(request.id, 'Cara', true), /was not asked/);

    registry.resolve(request.id, 'room-1');
    assert.throws(() => registry.respond(request.id, 'Billy', true), /already accepted/);
    assert.throws(() => registry.resolve(request.id), /already accepted/);
});

test('eliminating a player kills the requests they were part of', () => {
    const { registry } = createRegistry();
    const mine = registry.open('Alice', ['Billy'], CAST);
    const theirs = registry.open('Cara', ['Dev'], CAST);

    registry.removePlayer('Billy');
    assert.equal(registry.get(mine.id).status, 'cancelled');
    assert.equal(registry.get(theirs.id).status, 'pending');
});
