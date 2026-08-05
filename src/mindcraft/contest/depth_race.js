function assertPlayerName(name) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
        throw new Error(`Invalid Minecraft player name: ${name}`);
    }
}

export function buildDepthProbeCommand(playerName) {
    assertPlayerName(playerName);
    return `data get entity ${playerName} Pos`;
}

export function parsePlayerY(response) {
    const number = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;
    const match = String(response || '').match(
        new RegExp(`\\[\\s*${number}[dDfF]?\\s*,\\s*(${number})[dDfF]?\\s*,`)
    );
    return match ? Number(match[1]) : null;
}

export function scoreDepthRace({
    participantIds,
    runCommand,
    startY,
}) {
    if (!Array.isArray(participantIds)) {
        throw new TypeError('participantIds must be an array');
    }
    if (typeof runCommand !== 'function') {
        throw new TypeError('runCommand must be a function');
    }
    if (!Number.isFinite(startY)) {
        throw new TypeError('startY must be finite');
    }

    return Promise.all(participantIds.map(async participantId => {
        try {
            const response = await runCommand(buildDepthProbeCommand(participantId));
            const y = parsePlayerY(response);
            if (!Number.isFinite(y)) {
                return {
                    participantId,
                    score: 0,
                    disqualified: true,
                    details: 'Player position was unavailable when time expired',
                };
            }
            const depth = Math.max(0, startY - y);
            return {
                participantId,
                score: depth,
                disqualified: false,
                details: { y, depth, startY },
            };
        } catch (error) {
            return {
                participantId,
                score: 0,
                disqualified: true,
                details: `Could not measure player position: ${error.message}`,
            };
        }
    }));
}
