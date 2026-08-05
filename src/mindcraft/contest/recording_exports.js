export function recordingEntryMatches(entry, selection) {
    if (selection.session) {
        const session = String(selection.session);
        return entry.sessionId === session
            || String(entry.contestId || '') === session
            || entry.sessionId === `contest-${session}`;
    }
    return entry.endedAt >= selection.since && entry.startedAt <= selection.until;
}

export function filterRecordingManifest(text, selection) {
    const entries = [];
    for (const line of String(text || '').split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (recordingEntryMatches(entry, selection)) {
                entries.push(entry);
            }
        } catch (_) {
            // Ignore interrupted or hand-edited manifest lines.
        }
    }
    return entries;
}

export function serializeRecordingManifest(entries) {
    return entries.length
        ? `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`
        : '';
}
