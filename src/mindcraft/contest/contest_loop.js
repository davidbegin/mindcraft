export class ContestLoop {
    constructor(options = {}) {
        const {
            coordinator,
            intervalMs = 1000,
            onUpdate = () => {},
            onError = error => console.error('Contest loop failed:', error),
            setTimer = setTimeout,
            clearTimer = clearTimeout,
        } = options;

        if (!coordinator || typeof coordinator.tick !== 'function') {
            throw new TypeError('coordinator must provide tick()');
        }
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            throw new RangeError('intervalMs must be positive');
        }
        if (typeof onUpdate !== 'function') {
            throw new TypeError('onUpdate must be a function');
        }
        if (typeof onError !== 'function') {
            throw new TypeError('onError must be a function');
        }

        this.coordinator = coordinator;
        this.intervalMs = intervalMs;
        this.onUpdate = onUpdate;
        this.onError = onError;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.running = false;
        this.timer = null;
    }

    start() {
        if (this.running) return false;
        this.running = true;
        this._schedule(0);
        return true;
    }

    stop() {
        if (!this.running) return false;
        this.running = false;
        if (this.timer !== null) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
        return true;
    }

    async runOnce() {
        const result = await this.coordinator.tick();
        if (result.changed) {
            await this.onUpdate(this.coordinator.view(), result);
        }
        return result;
    }

    _schedule(delayMs) {
        this.timer = this.setTimer(async () => {
            this.timer = null;
            try {
                await this.runOnce();
            } catch (error) {
                try {
                    await this.onError(error);
                } catch (handlerError) {
                    console.error('Contest loop error handler failed:', handlerError);
                }
            } finally {
                if (this.running) this._schedule(this.intervalMs);
            }
        }, delayMs);
        this.timer?.unref?.();
    }
}
