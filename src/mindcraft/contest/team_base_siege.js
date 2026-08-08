/**
 * Base Siege: two teams plan, rush a quick base, then fight to last team standing.
 * If both sides are still alive when the clock ends, the arena shrinks and combat
 * continues — hiding forever is not a winning strategy.
 */

export function remainingTeamSiegeSurvivors(contest) {
    if (!contest || !Array.isArray(contest.participantIds)) return [];
    const eliminations = contest.eliminations && typeof contest.eliminations === 'object'
        ? contest.eliminations
        : {};
    return contest.participantIds.filter(participantId => !eliminations[participantId]);
}

export function survivingTeamsForSiege(contest) {
    const gameSession = contest?.metadata?.gameSession || {};
    const teamNames = Array.isArray(gameSession.teamNames) ? gameSession.teamNames : [];
    const teamByParticipant = gameSession.teamByParticipant || {};
    const survivors = remainingTeamSiegeSurvivors(contest);
    return teamNames.filter(teamName =>
        survivors.some(id => teamByParticipant[id] === teamName)
    );
}

export function bothSiegeTeamsAlive(contest) {
    return survivingTeamsForSiege(contest).length >= 2;
}

export function nextSiegeHalfSize(currentHalfSize, shrinkStep = 8, minHalfSize = 8) {
    const current = Number.isFinite(currentHalfSize) ? currentHalfSize : 32;
    const step = Number.isFinite(shrinkStep) && shrinkStep > 0 ? shrinkStep : 8;
    const minimum = Number.isFinite(minHalfSize) && minHalfSize > 0 ? minHalfSize : 8;
    return Math.max(minimum, current - step);
}

export function canDeferSiegeDeadline(contest, options = {}) {
    if (contest?.rules?.type !== 'team_base_siege') return false;
    if (!bothSiegeTeamsAlive(contest)) return false;
    const pressureRound = Number(contest.metadata?.gameSession?.pressureRound) || 0;
    const maxPressureRounds = Number.isFinite(options.maxPressureRounds)
        ? options.maxPressureRounds
        : (Number.isFinite(contest.rules?.maxPressureRounds)
            ? contest.rules.maxPressureRounds
            : 3);
    return pressureRound < maxPressureRounds;
}

/**
 * Rank like Spleef, but attach team identity so the winning side shares one result.
 * Surviving teammates beat eliminated ones; later deaths beat earlier ones.
 */
export function scoreTeamBaseSiege(contest, now = Date.now()) {
    if (!contest || !Array.isArray(contest.participantIds)) {
        throw new TypeError('contest with participantIds is required');
    }
    const gameSession = contest.metadata?.gameSession || {};
    const teamByParticipant = gameSession.teamByParticipant || {};
    const startedAt = Number.isFinite(contest.startedAt) ? contest.startedAt : now;
    const eliminations = contest.eliminations && typeof contest.eliminations === 'object'
        ? contest.eliminations
        : {};
    const endAt = Number.isFinite(contest.completedAt) ? contest.completedAt : now;

    const participantResults = contest.participantIds.map(participantId => {
        const teamName = teamByParticipant[participantId] || null;
        const elimination = eliminations[participantId];
        if (!elimination) {
            const survivedMs = Math.max(0, endAt - startedAt);
            return {
                participantId,
                score: 1_000_000_000 + survivedMs,
                disqualified: false,
                details: {
                    teamName,
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
                teamName,
                surviving: false,
                survivedMs,
                reason: elimination.reason ?? null,
            },
        };
    });

    // Team score is the best member score so last-team-standing and survivor-count
    // ties at the final pressure deadline both resolve cleanly.
    const teamNames = Array.isArray(gameSession.teamNames) ? gameSession.teamNames : [];
    const teamScores = new Map(teamNames.map(name => [name, 0]));
    for (const result of participantResults) {
        const teamName = result.details.teamName;
        if (!teamName || !teamScores.has(teamName)) continue;
        teamScores.set(teamName, Math.max(teamScores.get(teamName), result.score));
    }
    for (const result of participantResults) {
        const teamName = result.details.teamName;
        if (teamName && teamScores.has(teamName)) {
            result.score = teamScores.get(teamName);
            result.details.teamScore = teamScores.get(teamName);
            result.details.survivors = participantResults.filter(
                row => row.details.teamName === teamName && row.details.surviving
            ).length;
        }
    }
    return participantResults;
}
