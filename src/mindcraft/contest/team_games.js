/** Shared helpers for two-team contest presets. */

export const TEAM_CONTEST_TYPES = Object.freeze([
    'team_tower_battle',
    'team_base_siege',
]);

export function isTeamContestType(type) {
    return TEAM_CONTEST_TYPES.includes(type);
}

export function isTeamEliminationContest(type) {
    return type === 'team_base_siege';
}

export function isTeamTowerContest(type) {
    return type === 'team_tower_battle';
}
