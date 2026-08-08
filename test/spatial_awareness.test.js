import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildAgentSpatialSnapshot,
    distanceBetween,
    findAgentSpatialEntry,
    formatPosition,
} from '../src/utils/spatial.js';
import {
    getNearbyEntityDetails,
    getNearbyPlayerDetails,
} from '../src/agent/library/world.js';
import { getArenaWorldKnowledge } from '../src/mindcraft/contest/arena_manager.js';
import { knownBotPositionLines } from '../src/agent/library/spatial_context.js';

function position(x, y, z) {
    return {
        x,
        y,
        z,
        distanceTo(other) {
            return Math.hypot(x - other.x, y - other.y, z - other.z);
        },
    };
}

test('builds a sorted server-authoritative snapshot from valid wall states', () => {
    const snapshot = buildAgentSpatialSnapshot([
        {
            name: 'zed',
            gameplay: {
                position: { x: 8, y: 64, z: 2 },
                dimension: 'overworld',
                yaw: 1.2,
            },
        },
        { name: 'invalid', gameplay: { position: { x: 'nope', y: 1, z: 2 } } },
        {
            name: 'amy',
            gameplay: {
                position: { x: 1, y: 65, z: 3 },
                dimension: 'overworld',
            },
        },
    ], 10_000);

    assert.deepEqual(snapshot, {
        generatedAt: 10_000,
        agents: [
            {
                name: 'amy',
                position: { x: 1, y: 65, z: 3 },
                dimension: 'overworld',
                yaw: null,
                observedAt: 10_000,
            },
            {
                name: 'zed',
                position: { x: 8, y: 64, z: 2 },
                dimension: 'overworld',
                yaw: 1.2,
                observedAt: 10_000,
            },
        ],
    });
});

test('rejects stale and wrong-dimension positions used for navigation', () => {
    const snapshot = buildAgentSpatialSnapshot([{
        name: 'target',
        gameplay: {
            position: { x: 10, y: 64, z: 10 },
            dimension: 'overworld',
        },
    }], 1_000);

    assert.equal(findAgentSpatialEntry(snapshot, 'target', {
        now: 2_000,
        dimension: 'the_nether',
    }), null);
    assert.equal(findAgentSpatialEntry(snapshot, 'target', {
        now: 7_000,
        dimension: 'overworld',
    }), null);
    assert.equal(findAgentSpatialEntry(snapshot, 'target', {
        now: 2_000,
        dimension: 'overworld',
    })?.position.x, 10);
});

test('formats coordinates and computes three-dimensional distance', () => {
    assert.equal(distanceBetween({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 12 }), 13);
    assert.equal(formatPosition({ x: 1.25, y: 64, z: -8.5 }), 'x: 1.3, y: 64.0, z: -8.5');
});

test('nearby player and entity details preserve coordinates and distances', () => {
    const self = {
        id: 1,
        type: 'player',
        username: 'self',
        position: position(0, 64, 0),
    };
    const other = {
        id: 2,
        type: 'player',
        username: 'other',
        position: position(3, 64, 4),
    };
    const cow = {
        id: 3,
        type: 'mob',
        name: 'cow',
        position: position(6, 64, 8),
    };
    const bot = {
        entity: self,
        entities: { 1: self, 2: other, 3: cow },
        game: { dimension: 'overworld' },
    };

    assert.deepEqual(getNearbyPlayerDetails(bot), [{
        username: 'other',
        position: { x: 3, y: 64, z: 4 },
        distance: 5,
        dimension: 'overworld',
    }]);
    const details = getNearbyEntityDetails(bot);
    assert.deepEqual(details.map(detail => [detail.name, detail.position, detail.distance]), [
        ['other', { x: 3, y: 64, z: 4 }, 5],
        ['cow', { x: 6, y: 64, z: 8 }, 10],
    ]);
});

test('arena knowledge exposes exact boundaries and server-placed resources', () => {
    const diamond = getArenaWorldKnowledge('diamond_race');
    assert.deepEqual(diamond.arena.bounds, {
        minX: 99968,
        maxX: 100032,
        minZ: 99968,
        maxZ: 100032,
    });
    assert.equal(diamond.landmarks.length, 8);
    assert.deepEqual(diamond.landmarks[0], {
        label: 'Diamond ore 1',
        position: { x: 99979, y: 78, z: 99983 },
    });

    const cake = getArenaWorldKnowledge('cake_race', { halfSize: 12 });
    assert.equal(cake.landmarks.length, 8);
    assert.equal(cake.arena.bounds.minX, 99988);

    const netherite = getArenaWorldKnowledge('netherite_race');
    assert.equal(netherite.landmarks.length, 56);
});

test('bot position context distinguishes distance, dimension, and unavailable state', () => {
    const spatialState = {
        generatedAt: 2_000,
        agents: [
            {
                name: 'self',
                position: { x: 0, y: 64, z: 0 },
                dimension: 'overworld',
                observedAt: 2_000,
            },
            {
                name: 'nearby',
                position: { x: 3, y: 64, z: 4 },
                dimension: 'overworld',
                observedAt: 2_000,
            },
            {
                name: 'nether',
                position: { x: 1, y: 70, z: 1 },
                dimension: 'the_nether',
                observedAt: 2_000,
            },
        ],
    };
    assert.deepEqual(knownBotPositionLines({
        name: 'self',
        spatialState,
        bot: {
            entity: { position: { x: 0, y: 64, z: 0 } },
            game: { dimension: 'overworld' },
        },
    }, ['self', 'nearby', 'nether', 'missing'], 2_000), [
        'nearby at x: 3.0, y: 64.0, z: 4.0 (5.0 blocks away; live)',
        'nether at x: 1.0, y: 70.0, z: 1.0 in the_nether (live)',
        'missing: position temporarily unavailable',
    ]);
});
