import { distanceBetween, formatPosition } from '../../utils/spatial.js';

export function knownBotPositionLines(agent, inGameAgentNames = [], now = Date.now()) {
    const bot = agent.bot;
    const snapshot = agent.spatialState ?? bot.spatialState;
    const entries = (snapshot?.agents || [])
        .filter(entry => entry.name !== agent.name)
        .map(entry => ({
            ...entry,
            distance: entry.dimension === bot.game?.dimension
                ? distanceBetween(bot.entity.position, entry.position)
                : null,
        }))
        .sort((a, b) => {
            if (a.distance != null && b.distance != null) return a.distance - b.distance;
            if (a.distance != null) return -1;
            if (b.distance != null) return 1;
            return a.name.localeCompare(b.name);
        });
    const lines = entries.map(entry => {
        const ageMs = Math.max(0, now - Number(entry.observedAt ?? snapshot.generatedAt));
        const age = ageMs < 1_500 ? 'live' : `${(ageMs / 1000).toFixed(1)}s old`;
        const location = `${entry.name} at ${formatPosition(entry.position)}`;
        if (entry.dimension !== bot.game?.dimension) {
            return `${location} in ${entry.dimension || 'an unknown dimension'} (${age})`;
        }
        return `${location} (${entry.distance.toFixed(1)} blocks away; ${age})`;
    });
    const reported = new Set(entries.map(entry => entry.name));
    for (const name of inGameAgentNames) {
        if (name !== agent.name && !reported.has(name)) {
            lines.push(`${name}: position temporarily unavailable`);
        }
    }
    return lines;
}
