// Optional in-browser mirror of bot and narrator speech.
//
// The MindServer always plays these lines on the host speakers next to the
// Minecraft client, so a game is audible with no browser open. A page only
// receives audio after the user turns monitoring on, which keeps a tab nobody
// is listening to -- backgrounded, muted, or a headless automation browser --
// from ever competing for the audio. The server half lives in mindserver.js.

(function () {
    const STORAGE_KEY = 'mindcraft.voiceMonitor';

    /**
     * Wires a page's socket up to optional voice monitoring.
     * `onStatus` receives 'on' | 'off' | 'blocked' so a page can reflect state.
     */
    window.initBotVoice = function initBotVoice(socket, { onStatus } = {}) {
        let enabled = false;
        try { enabled = localStorage.getItem(STORAGE_KEY) === 'on'; } catch (_) { /* private mode */ }
        let playback = Promise.resolve();
        let playbackGeneration = 0;
        let activeAudio = null;
        let activeAgentName = null;
        let resolveActiveAudio = null;
        // Lines arrive well before they play, so a per-bot clear has to name the
        // backlog it cancels rather than a moment in time: agent name -> the last
        // sequence number that bot is no longer allowed to play.
        let sequence = 0;
        const clearedThrough = new Map();

        const setStatus = (status) => {
            try { onStatus?.(status); } catch (_) { /* page callback is advisory */ }
        };

        function sync() {
            socket.emit(enabled ? 'start-voice-monitor' : 'stop-voice-monitor');
            setStatus(enabled ? 'on' : 'off');
        }

        function setEnabled(next) {
            enabled = !!next;
            try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch (_) { /* private mode */ }
            sync();
        }

        socket.on('connect', sync);
        if (socket.connected) sync();

        socket.on('bot-voice', (payload) => {
            if (!enabled || !payload?.audio) return;
            const generation = playbackGeneration;
            const seq = ++sequence;
            playback = playback.catch(() => {}).then(() => new Promise(resolve => {
                if (generation !== playbackGeneration
                    || seq <= (clearedThrough.get(payload.agentName) ?? 0)) {
                    resolve();
                    return;
                }
                const audio = new Audio(`data:audio/mpeg;base64,${payload.audio}`);
                activeAudio = audio;
                activeAgentName = payload.agentName;
                resolveActiveAudio = resolve;
                const finish = () => {
                    if (activeAudio === audio) {
                        activeAudio = null;
                        activeAgentName = null;
                        resolveActiveAudio = null;
                    }
                    resolve();
                };
                audio.onended = finish;
                audio.onerror = finish;
                audio.play().catch(error => {
                    // Autoplay policy blocks sound until the user interacts with
                    // the page. The host speakers already played this line, so
                    // just surface why the mirror is quiet.
                    console.warn(`Could not mirror ${payload.agentName || 'bot'} voice:`, error.message);
                    setStatus('blocked');
                    finish();
                });
            }));
        });

        socket.on('bot-voice-clear', (payload) => {
            const agentName = payload?.agentName;
            if (agentName) {
                clearedThrough.set(agentName, sequence);
                if (activeAgentName !== agentName) return;
            } else {
                playbackGeneration++;
                playback = Promise.resolve();
            }
            activeAudio?.pause();
            activeAudio = null;
            activeAgentName = null;
            resolveActiveAudio?.();
            resolveActiveAudio = null;
        });

        return {
            isEnabled: () => enabled,
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
            toggle: () => setEnabled(!enabled),
        };
    };
})();
