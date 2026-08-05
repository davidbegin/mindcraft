// Shared bot voice playback for the dashboard and the audience wall.
//
// A line must only ever be heard once, so the MindServer sends each clip to a
// single output device. A tab claims that role only after it can genuinely
// produce sound; while no tab holds the claim the server plays through host
// speakers instead, which keeps a game audible with no browser open. The server
// half of this protocol lives in mindserver.js (voice_output_claims).

(function () {
    const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'];

    function createAudioContext() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        return Ctx ? new Ctx() : null;
    }

    /**
     * Wires a page's socket up to voice playback.
     * `onStatus` receives 'owner' | 'muted' | 'blocked' so a page can show
     * whether it is the tab producing sound.
     */
    window.initBotVoice = function initBotVoice(socket, { onStatus } = {}) {
        const audioCtx = createAudioContext();
        let claimed = false;
        let isOwner = false;
        let playback = Promise.resolve();

        const setStatus = (status) => {
            try { onStatus?.(status); } catch (_) { /* page callback is advisory */ }
        };

        function claim() {
            if (claimed) return;
            claimed = true;
            socket.emit('claim-voice-output');
        }

        // Autoplay policies block sound until the user interacts with the page,
        // and a suspended AudioContext is the signal for that. Waiting to claim
        // means the server keeps using host speakers until we can be heard.
        function claimWhenAudible() {
            if (!audioCtx || audioCtx.state === 'running') {
                claim();
                return;
            }
            setStatus('blocked');
            const onGesture = () => {
                audioCtx.resume().then(() => {
                    if (audioCtx.state === 'running') {
                        GESTURE_EVENTS.forEach(e => document.removeEventListener(e, onGesture));
                        claim();
                    }
                }).catch(() => {});
            };
            GESTURE_EVENTS.forEach(e => document.addEventListener(e, onGesture));
        }

        socket.on('connect', () => {
            claimed = false;
            isOwner = false;
            claimWhenAudible();
        });
        if (socket.connected) claimWhenAudible();

        socket.on('voice-output-owner', (payload) => {
            isOwner = !!payload?.owner;
            setStatus(isOwner ? 'owner' : 'muted');
        });

        socket.on('bot-voice', (payload) => {
            if (!payload?.audio) return;
            playback = playback.catch(() => {}).then(() => new Promise(resolve => {
                const audio = new Audio(`data:audio/mpeg;base64,${payload.audio}`);
                audio.onended = resolve;
                audio.onerror = () => {
                    socket.emit('voice-output-failed', { id: payload.id });
                    resolve();
                };
                audio.play().catch(error => {
                    console.warn(`Could not play ${payload.agentName || 'bot'} voice:`, error.message);
                    socket.emit('voice-output-failed', { id: payload.id });
                    resolve();
                });
            }));
        });

        return {
            isOwner: () => isOwner,
            release: () => {
                claimed = false;
                socket.emit('release-voice-output');
            },
        };
    };
})();
