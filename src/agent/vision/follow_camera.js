import THREE from 'three';
import { Vec3 } from 'vec3';

const POV_SELF_ID = 'pov-recorder-self';

export const DEFAULT_FOLLOW_HEIGHT = 1.1;

/**
 * Third-person follow camera. Renders the bot itself as a player model with
 * a name tag and places the camera behind its facing direction, pulling in
 * when solid blocks would obstruct the view.
 */
export function applyFollowCamera(
    viewer,
    bot,
    username,
    followDistance,
    smooth,
    followHeight = DEFAULT_FOLLOW_HEIGHT
) {
    const entity = bot.entity;
    const pos = entity.position;
    viewer.updateEntity({
        id: POV_SELF_ID,
        name: 'player',
        username,
        width: 0.6,
        height: 1.8,
        pos,
        yaw: entity.yaw,
    });

    const eye = new THREE.Vector3(pos.x, pos.y + 1.6, pos.z);
    const offset = new THREE.Vector3(
        Math.sin(entity.yaw) * followDistance,
        followHeight,
        Math.cos(entity.yaw) * followDistance
    );
    const maxDist = offset.length();
    const dir = offset.clone().normalize();
    let clearDist = maxDist;
    for (let t = 0.5; t < maxDist; t += 0.25) {
        const block = bot.blockAt(new Vec3(
            eye.x + dir.x * t,
            eye.y + dir.y * t,
            eye.z + dir.z * t
        ));
        if (block && block.boundingBox === 'block') {
            clearDist = Math.max(1.0, t - 0.4);
            break;
        }
    }
    const target = eye.clone().addScaledVector(dir, clearDist);
    if (smooth) {
        viewer.camera.position.lerp(target, 0.35);
    } else {
        viewer.camera.position.copy(target);
    }
    viewer.camera.lookAt(eye);
}
