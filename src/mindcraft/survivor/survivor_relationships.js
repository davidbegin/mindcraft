// Nothing on the server tracks who trusts whom, but the season leaves fingerprints:
// who shared a private room, who wrote in it, who wrote each other's name down, and
// who the jury rewarded. This turns those traces into an undirected graph the
// operator dashboard can draw.

const WEIGHTS = Object.freeze({
    sharedRoom: 2,
    sharedVoteTarget: 2,
    juryVote: 2,
    message: 0.1,
    messageCap: 3,
    voteAgainst: 3,
});

const COUNCIL_VOTE_PHASES = new Set(['voting', 'revote']);

function pairKey(left, right) {
    return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

export function buildSurvivorRelationships(game, roomHistory = []) {
    if (!game || typeof game !== 'object') return { nodes: [], edges: [] };
    const participantIds = game.participantIds || [];
    const known = new Set(participantIds);
    const players = game.players || {};

    const nodes = participantIds.map(id => {
        const player = players[id] || {};
        return {
            id,
            tribe: player.tribe ?? null,
            active: Boolean(player.active),
            jury: Boolean(player.jury),
        };
    });

    const edges = new Map();
    const edgeFor = (left, right) => {
        const key = pairKey(left, right);
        if (!edges.has(key)) {
            const [a, b] = left < right ? [left, right] : [right, left];
            edges.set(key, {
                a,
                b,
                roomsShared: 0,
                messagesExchanged: 0,
                sharedVoteTargets: 0,
                votesFromAToB: 0,
                votesFromBToA: 0,
                juryVotesFor: 0,
                bond: 0,
                friction: 0,
                score: 0,
            });
        }
        return edges.get(key);
    };
    const addDirectedVote = (voterId, targetId) => {
        const edge = edgeFor(voterId, targetId);
        if (edge.a === voterId) edge.votesFromAToB += 1;
        else edge.votesFromBToA += 1;
    };

    for (const room of roomHistory || []) {
        const memberIds = [...new Set(room?.memberIds || [])].filter(id => known.has(id));
        const bySender = room?.messageCountBySender || {};
        for (let i = 0; i < memberIds.length; i += 1) {
            for (let j = i + 1; j < memberIds.length; j += 1) {
                const edge = edgeFor(memberIds[i], memberIds[j]);
                edge.roomsShared += 1;
                edge.messagesExchanged += (bySender[memberIds[i]] || 0)
                    + (bySender[memberIds[j]] || 0);
            }
        }
    }

    for (const event of game.events || []) {
        if (event?.type === 'vote.revealed' && COUNCIL_VOTE_PHASES.has(event.phase)) {
            const ballots = Object.entries(event.ballots || {})
                .filter(([voterId, targetId]) => known.has(voterId) && known.has(targetId));
            for (const [voterId, targetId] of ballots) addDirectedVote(voterId, targetId);
            for (let i = 0; i < ballots.length; i += 1) {
                for (let j = i + 1; j < ballots.length; j += 1) {
                    if (ballots[i][1] !== ballots[j][1]) continue;
                    edgeFor(ballots[i][0], ballots[j][0]).sharedVoteTargets += 1;
                }
            }
            continue;
        }
        if (event?.type === 'jury.vote.revealed') {
            for (const [jurorId, finalistId] of Object.entries(event.ballots || {})) {
                if (!known.has(jurorId) || !known.has(finalistId)) continue;
                edgeFor(jurorId, finalistId).juryVotesFor += 1;
            }
        }
    }

    const scored = [...edges.values()].map(edge => {
        const bond = edge.roomsShared * WEIGHTS.sharedRoom
            + edge.sharedVoteTargets * WEIGHTS.sharedVoteTarget
            + edge.juryVotesFor * WEIGHTS.juryVote
            + Math.min(edge.messagesExchanged * WEIGHTS.message, WEIGHTS.messageCap);
        const friction = (edge.votesFromAToB + edge.votesFromBToA) * WEIGHTS.voteAgainst;
        return {
            ...edge,
            bond: round2(bond),
            friction: round2(friction),
            score: round2(bond - friction),
        };
    });
    scored.sort((left, right) =>
        Math.abs(right.score) - Math.abs(left.score)
        || left.a.localeCompare(right.a)
        || left.b.localeCompare(right.b)
    );
    return { nodes, edges: scored };
}
