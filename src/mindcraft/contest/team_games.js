/** Shared helpers for two-team contest presets. */

export const TEAM_CONTEST_TYPES = Object.freeze([
    'cake_race',
    'team_tower_battle',
]);

export function isTeamContestType(type) {
    return TEAM_CONTEST_TYPES.includes(type);
}

export function isTeamEliminationContest() {
    return false;
}

export function isBaseSiegeContest(type) {
    return type === 'team_base_siege';
}

export function isTeamTowerContest(type) {
    return type === 'team_tower_battle';
}

export function isTeamItemRaceContest(type) {
    return type === 'cake_race';
}

export function contestHasTeamSession(contest) {
    const teamNames = contest?.metadata?.gameSession?.teamNames;
    return Array.isArray(teamNames) && teamNames.length === 2;
}

/**
 * Score a first-finish item race (e.g. First Cake) as a team contest: the first
 * teammate to craft the win item carries the whole side.
 */
export function scoreTeamFirstFinish(contest) {
    const gameSession = contest?.metadata?.gameSession || {};
    const teamByParticipant = gameSession.teamByParticipant || {};
    let winningTeam = null;
    let finisherId = null;
    let elapsedMs = null;
    let item = contest?.rules?.winItem ?? null;

    for (const participantId of contest.participantIds || []) {
        const submission = contest.submissions?.[participantId];
        if (!submission) continue;
        winningTeam = teamByParticipant[participantId] || null;
        finisherId = participantId;
        elapsedMs = Number.isFinite(submission.payload?.elapsedMs)
            ? submission.payload.elapsedMs
            : null;
        if (submission.payload?.item) item = submission.payload.item;
        break;
    }

    return (contest.participantIds || []).map(participantId => {
        const teamName = teamByParticipant[participantId] || null;
        const won = Boolean(winningTeam && teamName === winningTeam);
        return {
            participantId,
            score: winningTeam ? (won ? 1 : 0) : 0,
            disqualified: !winningTeam,
            details: {
                teamName,
                finisherId: won ? finisherId : null,
                elapsedMs: won ? elapsedMs : null,
                item: won ? item : null,
            },
        };
    });
}
