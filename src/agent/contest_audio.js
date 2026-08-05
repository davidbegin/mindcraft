/**
 * Attach one contest utterance to every local recorder for the same session.
 * A participant normally has one POV recorder; the observer also owns the
 * fixed overview-camera recorders.
 */
export function addContestAudioToRecorders(recorders, activeSessionId, payload) {
    if (!activeSessionId || payload?.sessionId !== activeSessionId || !payload.audio) {
        return 0;
    }

    const atMs = Number.isFinite(payload.atMs) ? payload.atMs : Date.now();
    let added = 0;
    for (const recorder of recorders) {
        if (!recorder?.recording || recorder.sessionId !== activeSessionId) continue;
        recorder.addAudio(payload.audio, atMs);
        added += 1;
    }
    return added;
}
