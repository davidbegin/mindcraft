/**
 * Base Siege: free-for-all last person alive.
 * Competitors get a timed build phase (no combat), then fight on the arena
 * platform. Leaving the platform — falling below the floor or stepping outside
 * the arena bounds — eliminates you. Hiding is not a winning strategy: hunt
 * until only one remains.
 */

/**
 * Rank like Spleef: still-standing players beat anyone eliminated, and later
 * eliminations beat earlier ones.
 */
export function scoreTeamBaseSiege(contest, now = Date.now()) {
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

export function remainingTeamSiegeSurvivors(contest) {
    if (!contest || !Array.isArray(contest.participantIds)) return [];
    const eliminations = contest.eliminations && typeof contest.eliminations === 'object'
        ? contest.eliminations
        : {};
    return contest.participantIds.filter(participantId => !eliminations[participantId]);
}

/** @deprecated Pressure rounds were removed; always returns false. */
export function canDeferSiegeDeadline() {
    return false;
}

/** @deprecated Pressure rounds were removed. */
export function bothSiegeTeamsAlive() {
    return false;
}

/** @deprecated Pressure rounds were removed. */
export function survivingTeamsForSiege() {
    return [];
}

/** @deprecated Pressure rounds were removed. */
export function nextSiegeHalfSize(currentHalfSize, shrinkStep = 8, minHalfSize = 8) {
    const current = Number.isFinite(currentHalfSize) ? currentHalfSize : 32;
    const step = Number.isFinite(shrinkStep) && shrinkStep > 0 ? shrinkStep : 8;
    const minimum = Number.isFinite(minHalfSize) && minHalfSize > 0 ? minHalfSize : 8;
    return Math.max(minimum, current - step);
}
