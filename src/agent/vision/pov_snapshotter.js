import fs from 'fs';
import path from 'path';
import THREE from 'three';
import { Viewer } from 'prismarine-viewer/viewer/lib/viewer.js';
import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';
import { getBufferFromStream } from 'prismarine-viewer/viewer/lib/simpleUtils.js';
import { createCanvas } from 'node-canvas-webgl/lib/index.js';
import { disableEntityTweens, applyFollowCamera } from './pov_recorder.js';

const SNAPSHOT_DEFAULTS = {
    width: 400,
    height: 225,
    viewDistance: 3,
    intervalMs: 10000,
    followDistance: 4.5,
    quality: 0.75,
};

/**
 * Writes a periodic still of the bot (same third-person follow cam as the
 * recorder) to bots/<name>/snapshot.jpg. The MindServer serves /bots
 * statically, so the UI just refreshes that URL for a rough live view of
 * where every character is.
 *
 * While the PovRecorder has a clip rolling, its already-rendered canvas is
 * reused for free; otherwise a small dedicated pipeline (low resolution and
 * view distance) renders one frame per interval.
 */
export class PovSnapshotter {
    constructor(bot, name, recorder = null) {
        this.bot = bot;
        this.name = name;
        this.recorder = recorder;
        this.file = path.resolve(`./bots/${name}/snapshot.jpg`);
        this._interval = null;
        this._busy = false;
        this._viewer = null;
        this._worldView = null;
        this._renderer = null;
        this._canvas = null;
        this._pipelineBroken = false; // don't rebuild a failing GL context every tick
        this._onBotEnd = () => { this.stop(); };
    }

    start() {
        if (this._interval) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.bot.once('end', this._onBotEnd);
        this._interval = setInterval(() => { this._snap().catch(() => {}); }, SNAPSHOT_DEFAULTS.intervalMs);
        // First thumbnail shortly after spawn so cards are not blank for long.
        setTimeout(() => { this._snap().catch(() => {}); }, 3000);
    }

    stop() {
        clearInterval(this._interval);
        this._interval = null;
        this.bot.removeListener('end', this._onBotEnd);
        this._teardownPipeline();
    }

    async _snap() {
        if (this._busy || !this.bot.entity) return;
        this._busy = true;
        try {
            let buf = null;
            const rec = this.recorder;
            if (rec?.recording && rec._canvas) {
                // The recorder renders 20fps into its canvas; encode its latest frame.
                buf = await getBufferFromStream(rec._canvas.createJPEGStream({
                    bufsize: 4096,
                    quality: SNAPSHOT_DEFAULTS.quality,
                    progressive: false,
                }));
            } else {
                buf = await this._renderOwnFrame();
            }
            if (!buf) return;
            // Write-then-rename so the UI never fetches a half-written JPEG.
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, buf);
            fs.renameSync(tmp, this.file);
        } catch (err) {
            console.error(`[${this.name}] POV snapshot error:`, err.message);
        } finally {
            this._busy = false;
        }
    }

    async _renderOwnFrame() {
        if (!(await this._ensurePipeline())) return null;
        applyFollowCamera(this._viewer, this.bot, this.name, SNAPSHOT_DEFAULTS.followDistance, false);
        this._worldView.updatePosition(this.bot.entity.position).catch(() => {});
        this._viewer.update();
        this._renderer.render(this._viewer.scene, this._viewer.camera);
        return getBufferFromStream(this._canvas.createJPEGStream({
            bufsize: 4096,
            quality: SNAPSHOT_DEFAULTS.quality,
            progressive: false,
        }));
    }

    async _ensurePipeline() {
        if (this._viewer) return true;
        if (this._pipelineBroken) return false;
        try {
            this._canvas = createCanvas(SNAPSHOT_DEFAULTS.width, SNAPSHOT_DEFAULTS.height);
            this._renderer = new THREE.WebGLRenderer({ canvas: this._canvas });
            this._viewer = new Viewer(this._renderer);
            if (!this._viewer.setVersion(this.bot.version)) {
                throw new Error(`Minecraft version ${this.bot.version} is not supported by the renderer`);
            }
            disableEntityTweens(this._viewer);
            const center = this.bot.entity.position;
            this._worldView = new WorldView(this.bot.world, SNAPSHOT_DEFAULTS.viewDistance, center);
            this._viewer.listen(this._worldView);
            this._worldView.listenToBot(this.bot);
            await this._worldView.init(center);
            await Promise.race([
                this._viewer.waitForChunksToRender().catch(() => {}),
                new Promise(resolve => setTimeout(resolve, 8000)),
            ]);
            return true;
        } catch (err) {
            this._pipelineBroken = true;
            this._teardownPipeline();
            console.error(`[${this.name}] POV snapshot pipeline failed, snapshots disabled: ${err.message}`);
            return false;
        }
    }

    _teardownPipeline() {
        try { this._worldView?.removeListenersFromBot(this.bot); } catch (_) { /* bot may already be gone */ }
        this._worldView = null;
        try { this._renderer?.dispose(); } catch (_) { /* GL teardown is best-effort */ }
        this._viewer = null;
        this._renderer = null;
        this._canvas = null;
    }
}
