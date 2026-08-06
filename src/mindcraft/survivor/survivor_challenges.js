const FIRST_FINISH_TYPES = new Set([
    'cake_race',
    'death_race',
    'dog_race',
    'diamond_race',
    'netherite_race',
]);

export const SURVIVOR_CHALLENGE_TYPES = Object.freeze([
    'cake_race',
    'death_race',
    'dog_race',
    'diamond_race',
    'netherite_race',
    'tower_battle',
    'depth_race',
]);

function assertResults(results) {
    if (!Array.isArray(results) || results.length === 0) {
        throw new Error('Challenge results are required');
    }
    for (const result of results) {
        if (typeof result?.participantId !== 'string' || result.participantId === '') {
            throw new Error('Every challenge result requires a participantId');
        }
    }
}

function numeric(result, keys, fallback) {
    for (const key of keys) {
        if (Number.isFinite(result?.[key])) return result[key];
    }
    return fallback;
}

function individualScore(preset, result) {
    const type = preset?.rules?.type;
    if (FIRST_FINISH_TYPES.has(type)) {
        return -numeric(result, ['elapsedMs', 'finishedAt'], Number.POSITIVE_INFINITY);
    }
    if (type === 'depth_race') {
        return -numeric(result, ['y', 'depthY'], Number.POSITIVE_INFINITY);
    }
    if (type === 'tower_battle') {
        return numeric(result, ['height', 'score'], Number.NEGATIVE_INFINITY);
    }
    throw new Error(`Unsupported Survivor challenge type: ${type}`);
}

export function resolveIndividualChallenge(preset, results) {
    assertResults(results);
    const ranked = results.map(result => ({
        ...result,
        score: individualScore(preset, result),
    })).sort((left, right) =>
        right.score - left.score
        || left.participantId.localeCompare(right.participantId)
    );
    if (!Number.isFinite(ranked[0].score)) {
        throw new Error('No participant completed a measurable challenge result');
    }
    return {
        winnerId: ranked[0].participantId,
        standings: ranked,
    };
}

export function resolveTeamChallenge(preset, results, tribeByParticipant) {
    assertResults(results);
    if (!tribeByParticipant || typeof tribeByParticipant !== 'object') {
        throw new TypeError('tribeByParticipant is required');
    }
    const type = preset?.rules?.type;
    const tribeResults = new Map();
    for (const result of results) {
        const tribe = tribeByParticipant[result.participantId];
        if (!tribe) throw new Error(`No tribe assigned for ${result.participantId}`);
        if (!tribeResults.has(tribe)) tribeResults.set(tribe, []);
        tribeResults.get(tribe).push(result);
    }
    if (tribeResults.size !== 2) throw new Error('Team challenge requires exactly two tribes');

    const standings = [...tribeResults].map(([tribe, members]) => {
        if (FIRST_FINISH_TYPES.has(type)) {
            return {
                tribe,
                score: Math.max(...members.map(result => individualScore(preset, result))),
                detail: 'Fastest tribe member',
            };
        }
        if (type === 'depth_race') {
            const measured = members
                .map(result => numeric(result, ['y', 'depthY'], null))
                .filter(Number.isFinite);
            return {
                tribe,
                score: measured.length > 0
                    ? -(measured.reduce((sum, value) => sum + value, 0) / measured.length)
                    : Number.NEGATIVE_INFINITY,
                detail: 'Lowest average Y',
            };
        }
        if (type === 'tower_battle') {
            return {
                tribe,
                score: members.reduce(
                    (sum, result) => sum + numeric(result, ['height', 'score'], 0),
                    0
                ),
                detail: 'Combined tower height',
            };
        }
        throw new Error(`Unsupported Survivor challenge type: ${type}`);
    }).sort((left, right) =>
        right.score - left.score || left.tribe.localeCompare(right.tribe)
    );
    if (!Number.isFinite(standings[0].score)) {
        throw new Error('No tribe completed a measurable challenge result');
    }
    return {
        winningTribe: standings[0].tribe,
        tied: standings.length > 1 && standings[0].score === standings[1].score,
        standings,
    };
}

export function buildChallengeDeck(gameIds, options = {}) {
    if (!Array.isArray(gameIds) || gameIds.length === 0) {
        throw new Error('At least one challenge game is required');
    }
    const random = options.random || Math.random;
    const rounds = options.rounds ?? gameIds.length;
    if (!Number.isInteger(rounds) || rounds <= 0) {
        throw new RangeError('rounds must be a positive integer');
    }
    const deck = [];
    let pool = [];
    while (deck.length < rounds) {
        if (pool.length === 0) pool = [...gameIds];
        const index = Math.floor(random() * pool.length);
        const [next] = pool.splice(Math.min(index, pool.length - 1), 1);
        deck.push(next);
    }
    return deck;
}
