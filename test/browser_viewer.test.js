import assert from 'node:assert/strict';
import test from 'node:test';
import { Vec3 } from 'vec3';
import { followCameraPacket } from '../src/agent/vision/browser_viewer.js';

const CLIENT_EYE_HEIGHT = 1.6;

function makeBot({ yaw = 0, position = new Vec3(0, 64, 0), solidAt = () => false } = {}) {
    return {
        entity: { position, yaw, pitch: 0 },
        blockAt(pos) {
            return { boundingBox: solidAt(pos) ? 'block' : 'empty' };
        },
    };
}

// Where the client will actually put the camera, and where it will be looking.
function resolveCamera(packet) {
    const pos = new Vec3(packet.pos.x, packet.pos.y + CLIENT_EYE_HEIGHT, packet.pos.z);
    const forward = new Vec3(
        -Math.sin(packet.yaw) * Math.cos(packet.pitch),
        Math.sin(packet.pitch),
        -Math.cos(packet.yaw) * Math.cos(packet.pitch)
    );
    return { pos, forward };
}

test('camera sits behind and above the bot, not at its eyes', () => {
    const bot = makeBot({ yaw: 0, position: new Vec3(10, 64, 20) });
    const { pos } = resolveCamera(followCameraPacket(bot));

    // yaw=0 faces -z, so the camera trails toward +z.
    assert.ok(pos.z > 20 + 4, `expected camera behind the bot, got z=${pos.z}`);
    assert.ok(Math.abs(pos.x - 10) < 1e-6);
    assert.ok(pos.y > 64 + CLIENT_EYE_HEIGHT, 'camera should be raised above eye height');
});

test('camera trails whichever way the bot faces', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 2.3]) {
        const bot = makeBot({ yaw, position: new Vec3(0, 64, 0) });
        const { pos } = resolveCamera(followCameraPacket(bot));
        const behind = new Vec3(Math.sin(yaw), 0, Math.cos(yaw));
        const offset = new Vec3(pos.x, 0, pos.z).normalize();
        assert.ok(offset.dot(behind) > 0.99, `yaw ${yaw} put the camera in front of the bot`);
    }
});

test('camera looks back at the bot from wherever it ends up', () => {
    for (const yaw of [0, 1.1, Math.PI, -2.5]) {
        const bot = makeBot({ yaw, position: new Vec3(5, 70, -3) });
        const { pos, forward } = resolveCamera(followCameraPacket(bot));
        const eye = bot.entity.position.offset(0, CLIENT_EYE_HEIGHT, 0);
        const toEye = eye.minus(pos).normalize();
        assert.ok(forward.dot(toEye) > 0.999, `yaw ${yaw} aimed the camera away from the bot`);
    }
});

test('a wall behind the bot pulls the camera in instead of into the block', () => {
    const position = new Vec3(0, 64, 0);
    const open = followCameraPacket(makeBot({ position }));
    const walled = followCameraPacket(makeBot({
        position,
        solidAt: (pos) => pos.z > 2,
    }));

    const openDist = resolveCamera(open).pos.distanceTo(position.offset(0, CLIENT_EYE_HEIGHT, 0));
    const walledDist = resolveCamera(walled).pos.distanceTo(position.offset(0, CLIENT_EYE_HEIGHT, 0));
    assert.ok(walledDist < openDist, 'wall should shorten the follow distance');
    assert.ok(walledDist >= 1, 'camera should not end up inside the bot');
});
