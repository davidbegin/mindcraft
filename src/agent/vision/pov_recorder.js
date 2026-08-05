import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import THREE from 'three';
import worker_threads from 'worker_threads';
import { Vec3 } from 'vec3';
import { Viewer } from 'prismarine-viewer/viewer/lib/viewer.js';
import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';
import { getBufferFromStream } from 'prismarine-viewer/viewer/lib/simpleUtils.js';
import { createCanvas } from 'node-canvas-webgl/lib/index.js';

// prismarine-viewer's world mesher runs in worker threads and expects a global Worker
globalThis.Worker = worker_threads.Worker;

const RECORD_DEFAULTS = {
    fps: 20,
    width: 854,
    height: 480,
    viewDistance: 6,
    // 'follow' renders the bot as a player model with a name tag and keeps a
    // third-person camera behind it; 'first-person' is the raw bot POV.
    camera: 'follow',
    followDistance: 4.5,
};

// Entity id for the recorded bot's own mesh. WorldView deliberately excludes
// the bot's own entity, so the follow camera injects it under this id.
const POV_SELF_ID = 'pov-recorder-self';

// One shared manifest for every agent in this repo. Each line records a clip's
// bot, action labels, and exact UTC start/end (epoch ms), so overlapping clips
// from different bots can be lined up on a common timeline when stitching.
const MANIFEST_PATH = path.resolve('./bots/recordings-manifest.jsonl');

// Turns an action label like '!goToCoordinates' into a filename-safe tag.
function sanitizeLabel(label) {
    return String(label).replace(/^!/, '').replace(/[^a-zA-Z0-9_+.-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * prismarine-viewer moves entity meshes with 50ms TWEEN animations, but the
 * tween clock stalls in headless render loops, leaving every entity crawling
 * from the world origin. Wrap Entities.update to keep the mesh bookkeeping
 * (create/delete/name tags) and set transforms directly.
 * Shared by the recorder and the snapshotter.
 */
export function disableEntityTweens(viewer) {
    const entities = viewer.entities;
    const originalUpdate = entities.update.bind(entities);
    entities.update = (entity) => {
        if (!entities.entities[entity.id] || entity.delete) {
            originalUpdate({ ...entity, pos: undefined, yaw: undefined });
        }
        const mesh = entities.entities[entity.id];
        if (!mesh) return;
        if (entity.pos) mesh.position.set(entity.pos.x, entity.pos.y, entity.pos.z);
        if (entity.yaw !== undefined) mesh.rotation.y = entity.yaw;
    };
}

/**
 * Third-person follow camera. Renders the bot itself as a player model with
 * a name tag (WorldView skips the bot's own entity, so we inject it) and
 * places the camera behind the bot's facing direction, pulled in when solid
 * blocks sit between the bot and the camera. Shared by the recorder and the
 * snapshotter. `smooth` lerps toward the target for fluid video; snapshots
 * jump straight there.
 */
export function applyFollowCamera(viewer, bot, username, followDistance, smooth) {
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
    // Directly behind the bot's facing direction, slightly raised.
    // mineflayer yaw=0 looks toward -z, so +(sin, cos) points backwards.
    const offset = new THREE.Vector3(
        Math.sin(entity.yaw) * followDistance,
        1.1,
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

/**
 * Records the bot to an MP4 file.
 * Renders frames offscreen (node-canvas-webgl + prismarine-viewer) and pipes
 * JPEG frames into ffmpeg. One recorder per agent; start/stop from the UI via
 * the MindServer, or automatically on spawn with the `record_bot_view` setting.
 *
 * Default camera is a third-person follow cam: the bot is rendered as a
 * player model with a floating name tag, and the camera trails behind its
 * facing direction, pulling in closer when blocks would block the view
 * (tunnels, interiors). Pass `camera: 'first-person'` for the raw POV.
 *
 * If the agent process dies mid-recording, ffmpeg sees EOF on its input pipe
 * and still finalizes a playable MP4.
 */
export class PovRecorder {
    constructor(bot, name, onUpdate = null) {
        this.bot = bot;
        this.name = name;
        this.onUpdate = onUpdate;
        this.folder = path.resolve(`./bots/${name}/recordings`);

        this.recording = false;
        this.file = null;
        this.startedAt = null;
        this.frames = 0;
        this.error = null;
        this.cameraMode = RECORD_DEFAULTS.camera;

        this._interval = null;
        this._ffmpeg = null;
        this._viewer = null;
        this._worldView = null;
        this._renderer = null;
        this._canvas = null;
        this._busy = false;
        this._stopping = null;
        this._onBotEnd = () => { this.stop().catch(() => {}); };
    }

    getStatus() {
        return {
            recording: this.recording,
            file: this.file,
            folder: this.folder,
            startedAt: this.startedAt,
            frames: this.frames,
            error: this.error,
            camera: this.cameraMode,
            labels: [...(this.labels || [])],
        };
    }

    /**
     * Tag the current recording with what the bot is doing (an action label
     * like '!goToCoordinates'). Labels accumulate over the clip and are baked
     * into the final filename and the manifest when the recording stops.
     */
    addLabel(label) {
        if (!this.recording || !label) return;
        this.labels.add(String(label));
    }

    _notify() {
        try { this.onUpdate?.(this.getStatus()); } catch (_) { /* status updates are best-effort */ }
    }

    async start(options = {}) {
        if (this.recording) return this.getStatus();
        const opts = { ...RECORD_DEFAULTS, ...options };
        this.cameraMode = opts.camera === 'first-person' ? 'first-person' : 'follow';
        this._followDistance = Math.max(2, Number(opts.followDistance) || RECORD_DEFAULTS.followDistance);
        this._cameraPlaced = false;
        this.error = null;
        this.frames = 0;
        this.labels = new Set(opts.label ? [String(opts.label)] : []);

        fs.mkdirSync(this.folder, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `${this.name}_${timestamp}.mp4`;
        const outputPath = path.join(this.folder, filename);

        try {
            this._canvas = createCanvas(opts.width, opts.height);
            this._renderer = new THREE.WebGLRenderer({ canvas: this._canvas });
            this._viewer = new Viewer(this._renderer);
            if (!this._viewer.setVersion(this.bot.version)) {
                throw new Error(`Minecraft version ${this.bot.version} is not supported by the renderer`);
            }
            disableEntityTweens(this._viewer);
        } catch (err) {
            this._teardownRenderer();
            this.error = `Could not create the offscreen renderer: ${err.message}`;
            this._notify();
            return this.getStatus();
        }

        const center = this.bot.entity.position;
        this._worldView = new WorldView(this.bot.world, opts.viewDistance, center);
        this._viewer.listen(this._worldView);
        this._worldView.listenToBot(this.bot);
        await this._worldView.init(center);
        // Give the mesher a chance to finish so the video does not open on
        // half-loaded terrain; cap the wait so a stuck worker cannot block.
        await Promise.race([
            this._viewer.waitForChunksToRender().catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 8000)),
        ]);

        this._ffmpeg = spawn('ffmpeg', [
            '-y',
            '-f', 'image2pipe',
            '-framerate', String(opts.fps),
            '-i', 'pipe:0',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            outputPath,
        ]);
        this._ffmpeg.on('error', (err) => {
            const hint = err.code === 'ENOENT' ? 'ffmpeg is not installed or not on PATH' : err.message;
            this.error = `ffmpeg failed: ${hint}`;
            console.error(`[${this.name}] POV recording ffmpeg error:`, err.message);
            this.stop().catch(() => {});
        });
        // swallow EPIPE if ffmpeg dies while we are still writing frames
        this._ffmpeg.stdin.on('error', () => {});
        this._ffmpeg.stderr.on('data', () => {});

        this.recording = true;
        this.file = outputPath;
        this.startedAt = Date.now();
        this.bot.once('end', this._onBotEnd);

        this._interval = setInterval(() => { this._renderFrame(); }, Math.round(1000 / opts.fps));
        console.log(`[${this.name}] POV recording started: ${outputPath}`);
        this._notify();
        return this.getStatus();
    }

    async _renderFrame() {
        if (!this.recording || this._busy) return;
        this._busy = true;
        try {
            const pos = this.bot.entity.position;
            if (this.cameraMode === 'first-person') {
                this._viewer.setFirstPersonCamera(pos, this.bot.entity.yaw, this.bot.entity.pitch);
            } else {
                applyFollowCamera(this._viewer, this.bot, this.name, this._followDistance, this._cameraPlaced);
                this._cameraPlaced = true;
            }
            this._worldView.updatePosition(pos).catch(() => {});
            this._viewer.update();
            this._renderer.render(this._viewer.scene, this._viewer.camera);

            const buf = await getBufferFromStream(this._canvas.createJPEGStream({
                bufsize: 4096,
                quality: 0.9,
                progressive: false,
            }));
            if (this.recording && this._ffmpeg?.stdin.writable) {
                this._ffmpeg.stdin.write(buf);
                this.frames++;
            }
        } catch (err) {
            console.error(`[${this.name}] POV recording frame error:`, err.message);
        } finally {
            this._busy = false;
        }
    }

    async stop() {
        if (this._stopping) return this._stopping;
        if (!this.recording) return this.getStatus();
        this._stopping = this._stop();
        try {
            return await this._stopping;
        } finally {
            this._stopping = null;
        }
    }

    async _stop() {
        this.recording = false;
        clearInterval(this._interval);
        this._interval = null;
        this.bot.removeListener('end', this._onBotEnd);

        try { this._worldView?.removeListenersFromBot(this.bot); } catch (_) { /* bot may already be gone */ }
        this._worldView = null;

        const ffmpeg = this._ffmpeg;
        this._ffmpeg = null;
        if (ffmpeg && ffmpeg.exitCode === null) {
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    ffmpeg.kill('SIGKILL');
                    resolve();
                }, 10000);
                ffmpeg.once('close', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                ffmpeg.stdin.end();
            });
        }

        this._teardownRenderer();
        this._finalizeClip();
        console.log(`[${this.name}] POV recording stopped: ${this.file} (${this.frames} frames)`);
        this._notify();
        return this.getStatus();
    }

    /**
     * After ffmpeg has closed the file, bake the action labels into the
     * filename (name_timestamp__label.mp4) and append the clip to the shared
     * manifest so multi-bot footage can be correlated by wall-clock time.
     */
    _finalizeClip() {
        const endedAt = Date.now();
        const labels = [...(this.labels || [])];
        try {
            const tag = labels.map(sanitizeLabel).filter(Boolean).join('+').slice(0, 80);
            if (tag && this.file && fs.existsSync(this.file)) {
                const renamed = this.file.replace(/\.mp4$/, `__${tag}.mp4`);
                fs.renameSync(this.file, renamed);
                this.file = renamed;
            }
        } catch (err) {
            console.warn(`[${this.name}] Could not rename recording with labels:`, err.message);
        }
        try {
            fs.appendFileSync(MANIFEST_PATH, JSON.stringify({
                bot: this.name,
                file: this.file,
                labels,
                startedAt: this.startedAt,
                endedAt,
                startedAtIso: new Date(this.startedAt).toISOString(),
                endedAtIso: new Date(endedAt).toISOString(),
                durationMs: endedAt - this.startedAt,
                frames: this.frames,
            }) + '\n');
        } catch (err) {
            console.warn(`[${this.name}] Could not append to recordings manifest:`, err.message);
        }
    }

    _teardownRenderer() {
        try { this._renderer?.dispose(); } catch (_) { /* GL teardown is best-effort */ }
        this._viewer = null;
        this._renderer = null;
        this._canvas = null;
    }
}
