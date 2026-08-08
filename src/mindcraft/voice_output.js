/**
 * Routes generated bot and narrator speech to output devices.
 *
 * Host speakers sit next to the Minecraft client, so they are the primary
 * output and always play. Dashboard pages are monitoring tools: they mirror a
 * line only after opting in explicitly, and they can never become the sole
 * output. That way a tab nobody can hear -- backgrounded, muted, or a headless
 * automation browser -- cannot silence a game.
 */
export class VoiceOutput {
    constructor(options = {}) {
        if (typeof options.playOnHost !== 'function') {
            throw new TypeError('playOnHost must be a function');
        }
        this.playOnHost = options.playOnHost;
        this.clearHost = options.clearHost || (() => {});
        this.silenceOnHost = options.silenceOnHost || (() => {});
        this.onError = options.onError || (error => console.warn(`Voice output failed: ${error.message}`));
        this.monitors = new Set();
    }

    addMonitor(socket) {
        if (!socket) return;
        this.monitors.add(socket);
    }

    removeMonitor(socket) {
        this.monitors.delete(socket);
    }

    monitorCount() {
        return this.monitors.size;
    }

    clear() {
        try {
            this.clearHost();
        } catch (error) {
            this.onError(error);
        }
        for (const monitor of [...this.monitors]) {
            if (!monitor.connected) {
                this.monitors.delete(monitor);
                continue;
            }
            try {
                monitor.emit('bot-voice-clear');
            } catch (error) {
                this.onError(error);
            }
        }
    }

    /**
     * Cut one bot off everywhere and drop the lines it already queued, without
     * touching anybody else's. Used when a bot dies or is eliminated: the rest
     * of the cast, and the narrator calling the elimination, keep their audio.
     */
    silence(agentName) {
        if (!agentName) return;
        try {
            this.silenceOnHost(agentName);
        } catch (error) {
            this.onError(error);
        }
        for (const monitor of [...this.monitors]) {
            if (!monitor.connected) {
                this.monitors.delete(monitor);
                continue;
            }
            try {
                monitor.emit('bot-voice-clear', { agentName });
            } catch (error) {
                this.onError(error);
            }
        }
    }

    dispatch({ agentName, text, audio }) {
        if (!audio) return;
        try {
            this.playOnHost({ agentName, text, audio });
        } catch (error) {
            this.onError(error);
        }
        for (const monitor of [...this.monitors]) {
            if (!monitor.connected) {
                this.monitors.delete(monitor);
                continue;
            }
            try {
                monitor.emit('bot-voice', { agentName, text, audio });
            } catch (error) {
                this.onError(error);
            }
        }
    }
}
