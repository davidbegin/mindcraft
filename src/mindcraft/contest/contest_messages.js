/** Resolve which contest journal should receive a spoken line. */

const JOURNALABLE_STATUSES = new Set(['draft', 'running', 'judging']);

/**
 * Prefer the active (clock-running) contest; fall back to the game session's
 * contest while it is still draft (planning / provisioning / announcing).
 * Returns null once the match is completed or cancelled.
 */
export function resolveContestMessageTarget({
    agentName,
    activeContestId = null,
    contests = {},
    gameSession = null,
} = {}) {
    if (!agentName) return null;

    const candidates = [];
    if (activeContestId) candidates.push(activeContestId);
    const sessionContestId = gameSession?.contestId || null;
    if (sessionContestId && sessionContestId !== activeContestId) {
        candidates.push(sessionContestId);
    }

    for (const contestId of candidates) {
        const contest = contests[contestId];
        if (!contest || !JOURNALABLE_STATUSES.has(contest.status)) continue;
        const participants = contest.participantIds || [];
        const sessionParticipants = gameSession?.participantIds || [];
        const inContest = participants.includes(agentName);
        const inSession = sessionContestId === contestId
            && sessionParticipants.includes(agentName);
        if (!inContest && !inSession) continue;
        return {
            contestId,
            participantId: agentName,
            status: contest.status,
        };
    }
    return null;
}

export function isJournalableContestStatus(status) {
    return JOURNALABLE_STATUSES.has(status);
}
