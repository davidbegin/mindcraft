import assert from 'node:assert/strict';
import test from 'node:test';
import { PrivateRoomRegistry } from '../src/mindcraft/survivor/private_rooms.js';

const eligible = ['Alice', 'Billy', 'Dario', 'Marcus'];

function registryWithEvents() {
    const events = [];
    let id = 0;
    return {
        events,
        registry: new PrivateRoomRegistry({
            idFactory: () => `id-${++id}`,
            onEvent: event => events.push(event),
        }),
    };
}

test('invited bots form an arbitrary-size private room', () => {
    const { registry } = registryWithEvents();
    const room = registry.create('Alice', ['Billy', 'Dario'], eligible, 'Final three?');
    registry.join(room.id, 'Billy', eligible);
    const joined = registry.join(room.id, 'Dario', eligible);
    assert.deepEqual(joined.memberIds, ['Alice', 'Billy', 'Dario']);
});

test('a bot belongs to only one room and uninvited bots cannot join', () => {
    const { registry } = registryWithEvents();
    const first = registry.create('Alice', ['Billy'], eligible);
    registry.join(first.id, 'Billy', eligible);
    const second = registry.create('Dario', ['Billy'], eligible);
    registry.join(second.id, 'Billy', eligible);
    assert.equal(registry.roomFor('Billy').id, second.id);
    assert.equal(registry.roomFor('Alice'), null);
    assert.throws(() => registry.join(second.id, 'Marcus', eligible), /not invited/);
});

test('messages expose content only through the room event and current membership', () => {
    const { registry, events } = registryWithEvents();
    const room = registry.create('Alice', ['Billy'], eligible);
    registry.join(room.id, 'Billy', eligible);
    const entry = registry.send('Alice', 'Vote Dario.');
    assert.deepEqual(entry.memberIds, ['Alice', 'Billy']);
    assert.ok(!entry.memberIds.includes('Dario'));
    assert.equal(events.at(-1).type, 'room.message');
});

test('phase cleanup and elimination remove room access', () => {
    const { registry } = registryWithEvents();
    const room = registry.create('Alice', ['Billy', 'Dario'], eligible);
    registry.join(room.id, 'Billy', eligible);
    registry.join(room.id, 'Dario', eligible);
    registry.removePlayer('Billy');
    assert.equal(registry.roomFor('Billy'), null);
    assert.throws(() => registry.send('Billy', 'still here'), /not in a private room/);
    registry.closeAll('voting-started');
    assert.deepEqual(registry.view(), []);
});
