// The season keeps no running scoreboard: every fact a standings table needs is
// already in the append-only event log, so we replay it instead of duplicating
// bookkeeping inside SurvivorGame.

const COUNCIL_VOTE_PHASES = new Set(['voting', 'revote']);

function playerStatus(game, player) {
    const id = player.id;
    if ((game.winnerIds || []).includes(id)) return 'winner';
    const finalists = game.finalistIds || [];
    if (game.status === 'completed' && finalists.includes(id)) return 'runner_up';
    if (player.active) return finalists.includes(id) ? 'finalist' : 'active';
    if (player.jury) return 'jury';
    if ((game.preMergeBootIds || []).includes(id)) return 'pre_merge_boot';
    return 'eliminated';
}

// Actives sit above the boot order while a season runs; once it completes,
// placement alone tells the whole story.
function sortKey(row) {
    if (row.placement != null) return [1, row.placement];
    return [0, 0];
}

export function buildSurvivorStandings(game) {
    if (!game || typeof game !== 'object') return [];
    const participantIds = game.participantIds || [];
    const players = game.players || {};
    const rows = new Map();
    for (const id of participantIds) {
        const player = players[id] || { id, active: false, jury: false };
        rows.set(id, {
            id,
            tribe: player.tribe ?? null,
            status: playerStatus(game, { ...player, id }),
            active: Boolean(player.active),
            jury: Boolean(player.jury),
            placement: player.placement ?? null,
            eliminatedRound: player.eliminatedRound ?? null,
            hasImmunity: (game.immunityIds || []).includes(id),
            individualImmunityWins: 0,
            tribeImmunityWins: 0,
            immunityWins: 0,
            votesReceived: 0,
            votesCast: 0,
            juryVotesReceived: 0,
            councilsAttended: 0,
            eliminationReason: null,
        });
    }

    for (const event of game.events || []) {
        switch (event?.type) {
            case 'challenge.completed': {
                if (event.winnerId && rows.has(event.winnerId)) {
                    rows.get(event.winnerId).individualImmunityWins += 1;
                }
                if (event.winningTribe) {
                    for (const id of event.immunityIds || []) {
                        if (rows.has(id)) rows.get(id).tribeImmunityWins += 1;
                    }
                }
                break;
            }
            case 'vote.revealed': {
                if (!COUNCIL_VOTE_PHASES.has(event.phase)) break;
                const ballots = event.ballots || {};
                const attendees = new Set();
                for (const [voterId, targetId] of Object.entries(ballots)) {
                    if (rows.has(voterId)) {
                        rows.get(voterId).votesCast += 1;
                        attendees.add(voterId);
                    }
                    if (rows.has(targetId)) {
                        rows.get(targetId).votesReceived += 1;
                        attendees.add(targetId);
                    }
                }
                // A revote is the same council, so only the opening vote counts
                // toward how many tribal councils a player has faced.
                if (event.phase === 'voting') {
                    for (const id of attendees) rows.get(id).councilsAttended += 1;
                }
                break;
            }
            case 'jury.vote.revealed': {
                for (const targetId of Object.values(event.ballots || {})) {
                    if (rows.has(targetId)) rows.get(targetId).juryVotesReceived += 1;
                }
                break;
            }
            case 'player.eliminated': {
                if (rows.has(event.playerId)) {
                    rows.get(event.playerId).eliminationReason = event.reason ?? null;
                }
                break;
            }
            default:
                break;
        }
    }

    const standings = [...rows.values()];
    for (const row of standings) {
        row.immunityWins = row.individualImmunityWins + row.tribeImmunityWins;
    }
    standings.sort((left, right) => {
        const [leftGroup, leftPlacement] = sortKey(left);
        const [rightGroup, rightPlacement] = sortKey(right);
        if (leftGroup !== rightGroup) return leftGroup - rightGroup;
        if (leftPlacement !== rightPlacement) return leftPlacement - rightPlacement;
        if (left.immunityWins !== right.immunityWins) {
            return right.immunityWins - left.immunityWins;
        }
        if (left.votesReceived !== right.votesReceived) {
            return left.votesReceived - right.votesReceived;
        }
        return left.id.localeCompare(right.id);
    });
    return standings;
}
