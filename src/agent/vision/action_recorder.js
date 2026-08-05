// Watches the agent and drives the PovRecorder so we only capture footage
// worth watching: a clip starts when the bot is executing an action AND is
// actually doing something in the world (moving, digging, or producing skill
// output like block placements), and stops once the bot has been still for a
// grace period. Idle "sitting around" — thinking, chatting, waiting on model
// calls, or stationary no-op actions — is never recorded.
//
// Every finished clip is labeled with the action(s) performed (baked into the
// filename and the shared bots/recordings-manifest.jsonl), so footage from
// multiple bots can be lined up by wall-clock time and stitched together.

const POLL_MS = 1000;
// Positional jitter from physics/knockback is well under this per second;
// real walking covers several blocks. Below it the bot counts as standing still.
const MOVE_THRESHOLD = 0.2;
// How long the bot must be inactive before the clip is stopped and saved.
// Long enough to bridge brief pauses mid-action (pathfinder replans, block
// look-at delays) without splitting one activity into many tiny clips.
const IDLE_STOP_MS = 8000;

const CONTROL_STATES = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];

export class ActionRecorder {
    constructor(agent, recorder) {
        this.agent = agent;
        this.recorder = recorder;
        this._interval = null;
        this._lastPos = null;
        this._lastOutputLen = 0;
        this._lastActiveAt = 0;
        this._sessionFile = null; // file of the clip *we* started; never touch manual recordings
        this._starting = false;
        this._failures = 0; // consecutive broken sessions (no ffmpeg, renderer errors)
        this._disarmed = false;
    }

    start() {
        if (this._interval || this._disarmed) return;
        this._interval = setInterval(() => { this._tick().catch(() => {}); }, POLL_MS);
        console.log(`[${this.agent.name}] Action recorder armed: clips start when an action has the bot moving, stop after ${IDLE_STOP_MS / 1000}s of stillness.`);
    }

    stop() {
        clearInterval(this._interval);
        this._interval = null;
    }

    get armed() {
        return !!this._interval;
    }

    // Explicit user toggle (UI button): re-arming also forgives past failures
    // so e.g. installing ffmpeg and flipping the switch works without a restart.
    arm() {
        this._disarmed = false;
        this._failures = 0;
        this.start();
    }

    // Turn auto-recording off; if a clip we started is still rolling, finish
    // and save it rather than leaving an orphaned recording nobody will stop.
    async disarm() {
        this.stop();
        if (this._sessionFile && this.recorder.recording && this.recorder.file === this._sessionFile) {
            this._sessionFile = null;
            await this.recorder.stop();
        }
    }

    _isActive() {
        const bot = this.agent.bot;
        const pos = bot.entity?.position;
        if (!pos) return false;

        let moved = false;
        if (this._lastPos) {
            moved = pos.distanceTo(this._lastPos) > MOVE_THRESHOLD;
        }
        this._lastPos = pos.clone();

        // Stationary interactions: mining a block in place, or skills logging
        // progress (placed/collected/crafted lines land in bot.output).
        const digging = bot.targetDigBlock != null;
        const outputLen = bot.output?.length ?? 0;
        const producedOutput = outputLen > this._lastOutputLen;
        this._lastOutputLen = outputLen;

        const steering = CONTROL_STATES.some(s => {
            try { return bot.getControlState(s); } catch (_) { return false; }
        });

        return moved || digging || producedOutput || steering;
    }

    async _tick() {
        if (this._starting || this._disarmed) return;
        const active = this._isActive();
        if (active) this._lastActiveAt = Date.now();

        const actions = this.agent.actions;
        const label = actions?.currentActionLabel || '';

        if (this.recorder.recording) {
            // A recording we didn't start (UI Rec button, record_bot_view) is
            // the user's; leave its lifecycle alone.
            if (this.recorder.file !== this._sessionFile) return;
            if (label) this.recorder.addLabel(label);
            if (Date.now() - this._lastActiveAt >= IDLE_STOP_MS) {
                this._sessionFile = null;
                await this.recorder.stop();
                this._noteSessionHealth();
            }
            return;
        }

        // Our session ended without us stopping it (bot death, ffmpeg error).
        if (this._sessionFile) {
            this._sessionFile = null;
            this._noteSessionHealth();
        }

        if (active && actions?.executing) {
            this._starting = true;
            try {
                const status = await this.recorder.start({ label });
                if (status.recording) {
                    this._sessionFile = status.file;
                } else {
                    this._noteSessionHealth();
                }
            } catch (err) {
                console.error(`[${this.agent.name}] Action recorder failed to start clip:`, err.message);
                this._noteSessionHealth(err.message);
            } finally {
                this._starting = false;
                this._lastActiveAt = Date.now();
            }
        }
    }

    // Recording sessions that keep erroring (missing ffmpeg, broken GL) will
    // never succeed; disarm after a few instead of retrying every second.
    _noteSessionHealth(errorMessage = null) {
        const error = errorMessage || this.recorder.error;
        this._failures = error ? this._failures + 1 : 0;
        if (this._failures >= 3) {
            console.error(`[${this.agent.name}] Action recorder disarmed after ${this._failures} failed clips. Last error: ${error}`);
            this._disarmed = true;
            this.stop();
        }
    }
}
