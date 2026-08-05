export const DOG_TAMING_ADVANCEMENT = 'minecraft:husbandry/tame_an_animal';

function assertPlayerName(name) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
        throw new Error(`Invalid Minecraft player name: ${name}`);
    }
}

export function buildDogRaceResetCommand(playerName) {
    assertPlayerName(playerName);
    return `advancement revoke ${playerName} only ${DOG_TAMING_ADVANCEMENT}`;
}

export function buildDogRaceProbeCommand(playerName) {
    assertPlayerName(playerName);
    return 'execute if entity '
        + `@a[name=${playerName},advancements={${DOG_TAMING_ADVANCEMENT}=true},limit=1] `
        + `run experience query ${playerName} levels`;
}

export function dogTamingAdvancementEarned(response) {
    const text = String(response || '').trim();
    if (!text || /test failed|no (?:entity|player) was found/i.test(text)) return false;
    return /experience level/i.test(text);
}

export async function findDogRaceWinner(contest, runCommand) {
    if (contest?.status !== 'running' || contest.rules?.type !== 'dog_race') {
        return null;
    }
    if (typeof runCommand !== 'function') {
        throw new TypeError('runCommand must be a function');
    }

    const checks = await Promise.all(contest.participantIds.map(async participantId => {
        try {
            const response = await runCommand(buildDogRaceProbeCommand(participantId));
            return dogTamingAdvancementEarned(response);
        } catch (error) {
            if (/no (?:entity|player) was found/i.test(error.message)) return false;
            throw error;
        }
    }));
    const winnerIndex = checks.findIndex(Boolean);
    return winnerIndex === -1 ? null : contest.participantIds[winnerIndex];
}
