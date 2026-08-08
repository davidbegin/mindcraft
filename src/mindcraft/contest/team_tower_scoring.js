import { measureTowers } from './tower_scoring.js';

function teamContributions(tower, teamByParticipant, teamNames) {
    const contributions = Object.fromEntries(teamNames.map(name => [name, 0]));
    for (const [participantId, count] of Object.entries(tower.contributions || {})) {
        const teamName = teamByParticipant[participantId];
        if (teamName in contributions) contributions[teamName] += count;
    }
    return contributions;
}

export function measureTeamTowerBattle({
    reports = [],
    floorY,
    participantIds = [],
    teamNames = [],
    teamByParticipant = {},
    deaths = {},
    deathPenaltyBlocks = 5,
    mergeDistance,
}) {
    if (!Array.isArray(teamNames) || teamNames.length !== 2) {
        throw new Error('Team tower scoring requires exactly two teams');
    }
    const towers = measureTowers({ reports, floorY, mergeDistance }).map(tower => {
        const contributions = teamContributions(tower, teamByParticipant, teamNames);
        const teamOwner = [...teamNames].sort((left, right) =>
            contributions[right] - contributions[left]
            || teamNames.indexOf(left) - teamNames.indexOf(right)
        )[0];
        return { ...tower, teamOwner, teamContributions: contributions };
    });
    const reportById = new Map(reports.map(report => [report.participantId, report]));
    const teamResults = teamNames.map(teamName => {
        const members = participantIds.filter(id => teamByParticipant[id] === teamName);
        const owned = towers.filter(tower =>
            tower.teamOwner === teamName && tower.teamContributions[teamName] > 0
        );
        const blocksStanding = towers.reduce(
            (total, tower) => total + tower.teamContributions[teamName],
            0
        );
        let tallest = owned[0] ?? null;
        let measuredFrom = tallest ? 'placed-blocks' : 'no-tower';
        if (!tallest && blocksStanding === 0) {
            const standingY = Math.max(
                floorY,
                ...members.map(id => reportById.get(id)?.standingOn?.y)
                    .filter(Number.isFinite)
            );
            if (standingY > floorY) {
                tallest = { height: standingY - floorY, topY: standingY };
                measuredFrom = 'standing-pillar';
            }
        }
        const towerHeight = tallest?.height ?? 0;
        const deathCount = members.reduce((total, id) => total + (deaths[id] ?? 0), 0);
        const deathPenalty = deathCount * deathPenaltyBlocks;
        return {
            teamName,
            score: towerHeight - deathPenalty,
            towerHeight,
            towerTopY: tallest?.topY ?? floorY,
            deaths: deathCount,
            deathPenalty,
            blocksStanding,
            measuredFrom,
            members,
        };
    }).sort((left, right) =>
        right.score - left.score || teamNames.indexOf(left.teamName) - teamNames.indexOf(right.teamName)
    );
    const resultByTeam = new Map(teamResults.map(result => [result.teamName, result]));
    const participantResults = participantIds.map(participantId => {
        const teamName = teamByParticipant[participantId];
        const team = resultByTeam.get(teamName);
        const personalBlocks = towers.reduce(
            (total, tower) => total + (tower.contributions[participantId] ?? 0),
            0
        );
        return {
            participantId,
            score: team?.score ?? 0,
            disqualified: !team,
            details: {
                teamName,
                teamMembers: team?.members ?? [],
                towerHeight: team?.towerHeight ?? 0,
                towerTopY: team?.towerTopY ?? floorY,
                deaths: team?.deaths ?? 0,
                deathPenalty: team?.deathPenalty ?? 0,
                deathPenaltyBlocks,
                blocksStanding: team?.blocksStanding ?? 0,
                personalBlocksStanding: personalBlocks,
                measuredFrom: team?.measuredFrom ?? 'no-team',
            },
        };
    });
    return { participantResults, teamResults, towers };
}

export function scoreTeamTowerBattle(options) {
    return measureTeamTowerBattle(options).participantResults;
}
