import { EventEmitter } from 'events';
import { createServer } from 'http';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { Vec3 } from 'vec3';
import pkg from 'prismarine-viewer/lib/common.js';
import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';
import settings from '../settings.js';

const { setupRoutes } = pkg;

const VIEW_DISTANCE = 6;
const FRAME_MS = 50; // matches the viewer client's 50ms camera tween

// Third-person follow camera, framed like the MP4 recorder's: trailing the bot
// and raised slightly, pulled in when a block would sit between the two.
const FOLLOW_DISTANCE = 4.5;
const FOLLOW_HEIGHT = 1.1;
// The viewer client adds its own eye height to whatever position it is sent,
// so camera positions have to be sent relative to it.
const CLIENT_EYE_HEIGHT = 1.6;

/**
 * Where to put the camera so the bot is framed from behind, expressed as the
 * viewer client's `position` packet: a point plus the yaw/pitch to look along.
 */
export function followCameraPacket(bot) {
    const yaw = bot.entity.yaw;
    // mineflayer yaw=0 faces -z, so +(sin, cos) points behind the bot.
    const offset = new Vec3(Math.sin(yaw) * FOLLOW_DISTANCE, FOLLOW_HEIGHT, Math.cos(yaw) * FOLLOW_DISTANCE);
    const maxDist = offset.norm();
    const dir = offset.scaled(1 / maxDist);
    const eye = bot.entity.position.offset(0, CLIENT_EYE_HEIGHT, 0);

    let dist = maxDist;
    for (let t = 0.5; t < maxDist; t += 0.25) {
        const block = bot.blockAt(eye.plus(dir.scaled(t)));
        if (block && block.boundingBox === 'block') {
            dist = Math.max(1, t - 0.4);
            break;
        }
    }

    const camera = eye.plus(dir.scaled(dist));
    const horizontal = Math.hypot(camera.x - eye.x, camera.z - eye.z) || 1e-6;
    return {
        pos: { x: camera.x, y: camera.y - CLIENT_EYE_HEIGHT, z: camera.z },
        yaw,
        pitch: -Math.atan2(camera.y - eye.y, horizontal),
    };
}

/**
 * Serves the bot's view at localhost:3000+count_id for the Live Wall.
 *
 * This replaces prismarine-viewer's own mineflayer server, which only offers a
 * first-person camera or a static orbit camera that never follows the bot.
 * The rendering still happens in the viewing browser; only the camera is
 * driven from here.
 */
export function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;

    const port = 3000 + count_id;
    const app = express();
    setupRoutes(app);
    const server = createServer(app);
    const io = new SocketIOServer(server, { path: '/socket.io' });
    const sockets = [];

    io.on('connection', (socket) => {
        socket.emit('version', bot.version);
        sockets.push(socket);

        const worldView = new WorldView(bot.world, VIEW_DISTANCE, bot.entity.position, socket);
        worldView.init(bot.entity.position).catch(() => {});
        worldView.listenToBot(bot);

        // The viewer client ignores the bot's own mesh on any packet carrying a
        // pitch, and it only stops centering its default orbit camera once it
        // has seen a plain packet. So each frame sends the mesh first, then the
        // camera, and the camera waits for the client to be past that setup.
        let cameraReady = false;
        let lastPos = null;
        const frame = () => {
            const pos = bot.entity?.position;
            if (!pos) return;
            socket.emit('position', { pos, yaw: bot.entity.yaw, addMesh: true });
            if (cameraReady) socket.emit('position', followCameraPacket(bot));
            else cameraReady = pos.y > 0;

            if (!lastPos || lastPos.distanceTo(pos) > 0.5) {
                lastPos = pos.clone();
                worldView.updatePosition(pos).catch(() => {});
            }
        };
        const timer = setInterval(frame, FRAME_MS);

        socket.on('disconnect', () => {
            clearInterval(timer);
            worldView.removeListenersFromBot(bot);
            sockets.splice(sockets.indexOf(socket), 1);
        });
    });

    server.listen(port, '127.0.0.1', () => {
        console.log(`Prismarine viewer web server running on 127.0.0.1:${port}`);
    });

    bot.viewer = new EventEmitter();
    bot.viewer.close = () => {
        server.close();
        for (const socket of sockets) socket.disconnect();
    };
}
