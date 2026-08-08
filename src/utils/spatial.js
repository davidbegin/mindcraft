const DEFAULT_MAX_AGE_MS = 5_000;

export function finitePosition(position) {
    if (
        !position
        || !Number.isFinite(Number(position.x))
        || !Number.isFinite(Number(position.y))
        || !Number.isFinite(Number(position.z))
    ) {
        return null;
    }
    return {
        x: Number(position.x),
        y: Number(position.y),
        z: Number(position.z),
    };
}

export function distanceBetween(first, second) {
    const a = finitePosition(first);
    const b = finitePosition(second);
    if (!a || !b) return null;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function buildAgentSpatialSnapshot(entries, generatedAt = Date.now()) {
    const agents = [];
    for (const entry of entries || []) {
        const position = finitePosition(entry?.gameplay?.position ?? entry?.position);
        const name = String(entry?.name || '').trim();
        if (!name || !position) continue;
        agents.push({
            name,
            position,
            dimension: entry?.gameplay?.dimension ?? entry?.dimension ?? null,
            yaw: Number.isFinite(entry?.gameplay?.yaw)
                ? entry.gameplay.yaw
                : (Number.isFinite(entry?.yaw) ? entry.yaw : null),
            observedAt: generatedAt,
        });
    }
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return { generatedAt, agents };
}

export function findAgentSpatialEntry(snapshot, name, options = {}) {
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const entry = snapshot?.agents?.find(agent => agent.name === name);
    if (!entry || !finitePosition(entry.position)) return null;
    const observedAt = Number(entry.observedAt ?? snapshot.generatedAt);
    if (!Number.isFinite(observedAt) || now - observedAt > maxAgeMs) return null;
    if (
        options.dimension != null
        && entry.dimension != null
        && entry.dimension !== options.dimension
    ) {
        return null;
    }
    return entry;
}

export function formatPosition(position, decimals = 1) {
    const value = finitePosition(position);
    if (!value) return 'unknown position';
    return `x: ${value.x.toFixed(decimals)}, y: ${value.y.toFixed(decimals)}, z: ${value.z.toFixed(decimals)}`;
}
