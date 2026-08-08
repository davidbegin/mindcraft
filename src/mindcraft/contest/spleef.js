/**
 * Rank Spleef by survival: still-standing players beat anyone who fell, and
 * later eliminations beat earlier ones.
 */
export function scoreSpleef(contest, now = Date.now()) {
    if (!contest || !Array.isArray(contest.participantIds)) {
        throw new TypeError('contest with participantIds is required');
    }
    const startedAt = Number.isFinite(contest.startedAt) ? contest.startedAt : now;
    const eliminations = contest.eliminations && typeof contest.eliminations === 'object'
        ? contest.eliminations
        : {};
    const endAt = Number.isFinite(contest.completedAt) ? contest.completedAt : now;

    return contest.participantIds.map(participantId => {
        const elimination = eliminations[participantId];
        if (!elimination) {
            const survivedMs = Math.max(0, endAt - startedAt);
            return {
                participantId,
                score: 1_000_000_000 + survivedMs,
                disqualified: false,
                details: {
                    surviving: true,
                    survivedMs,
                },
            };
        }
        const eliminatedAt = Number.isFinite(elimination.eliminatedAt)
            ? elimination.eliminatedAt
            : startedAt;
        const survivedMs = Math.max(0, eliminatedAt - startedAt);
        return {
            participantId,
            score: survivedMs,
            disqualified: false,
            details: {
                surviving: false,
                survivedMs,
                reason: elimination.reason ?? null,
            },
        };
    });
}

export function remainingSpleefSurvivors(contest) {
    if (!contest || !Array.isArray(contest.participantIds)) return [];
    const eliminations = contest.eliminations && typeof contest.eliminations === 'object'
        ? contest.eliminations
        : {};
    return contest.participantIds.filter(participantId => !eliminations[participantId]);
}
