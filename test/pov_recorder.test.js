import assert from 'node:assert/strict';
import test from 'node:test';

import THREE from 'three';
import { Vec3 } from 'vec3';

import { applyFollowCamera } from '../src/agent/vision/follow_camera.js';

function cameraFixture() {
    let lookTarget = null;
    const viewer = {
        camera: {
            position: new THREE.Vector3(),
            lookAt(target) {
                lookTarget = target.clone();
            },
        },
        updateEntity() {},
    };
    const bot = {
        entity: {
            position: new Vec3(1, 2, 3),
            yaw: 0,
        },
        blockAt() {
            return null;
        },
    };
    return { viewer, bot, getLookTarget: () => lookTarget };
}

test('follow camera supports a wider distance and height', () => {
    const { viewer, bot, getLookTarget } = cameraFixture();

    applyFollowCamera(viewer, bot, 'alice', 12, false, 4);

    assert.deepEqual(viewer.camera.position.toArray(), [1, 7.6, 15]);
    assert.deepEqual(getLookTarget().toArray(), [1, 3.6, 3]);
});

test('follow camera retains the close-view default height', () => {
    const { viewer, bot } = cameraFixture();

    applyFollowCamera(viewer, bot, 'alice', 4.5, false);

    assert.deepEqual(viewer.camera.position.toArray(), [1, 4.7, 7.5]);
});
