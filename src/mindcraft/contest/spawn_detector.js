// Contestants are supposed to play the game, not conjure their way to the finish
// line. A bot can only really spawn items three ways we can see after the fact:
// by writing generated code (`!newAction`) that fires a server command, by
// running with cheat mode on, or by ending up with a win item that never came
// from anything the arena placed. These helpers surface all three so the archive
// can flag a suspicious win instead of silently trusting it.

// Patterns that, inside generated action code, mean the bot tried to make items
// or blocks appear rather than gather them. `bot.chat("/give ...")` only works
// if the bot is opped, but it is the clearest possible intent, so we flag it.
const SPAWN_CODE_PATTERNS = Object.freeze([
    { label: '/give command', pattern: /\/give\b/i },
    { label: '/setblock command', pattern: /\/setblock\b/i },
    { label: '/fill command', pattern: /\/fill\b/i },
    { label: '/summon command', pattern: /\/summon\b/i },
    { label: '/item command', pattern: /\/item\b/i },
    { label: '/loot command', pattern: /\/loot\b/i },
    { label: 'creative mode toggle', pattern: /\/gamemode\s+(creative|1)\b/i },
    { label: 'creative inventory API', pattern: /bot\.creative\b/i },
    { label: 'setInventorySlot', pattern: /setInventorySlot\b/i },
]);

// Scan one generated-code file's text for spawn intent. Returns the labels of
// every pattern that hit (deduplicated).
export function scanGeneratedCode(codeText) {
    const text = String(codeText ?? '');
    const hits = [];
    for (const { label, pattern } of SPAWN_CODE_PATTERNS) {
        if (pattern.test(text)) hits.push(label);
    }
    return hits;
}

function toFinite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

// Turn the arena's ore offsets (relative to arena center) into absolute world
// coordinates so a win position can be checked against them.
export function resolveOrePositions(oreOffsets = [], center = {}) {
    const centerX = toFinite(center.x) ?? 0;
    const centerZ = toFinite(center.z) ?? 0;
    return oreOffsets
        .map(offset => {
            if (!Array.isArray(offset) || offset.length < 3) return null;
            const [dx, y, dz] = offset;
            return { x: centerX + Number(dx), y: Number(y), z: centerZ + Number(dz) };
        })
        .filter(Boolean);
}

// Did the win item plausibly come from a placed ore? A bot mines standing next
// to (or just under) the ore, so a small radius counts as "mined here". A win
// with no ore anywhere near it is the tell-tale sign of a spawned item.
export function classifyOreWin(position, orePositions = [], tolerance = 4) {
    const point = position && {
        x: toFinite(position.x),
        y: toFinite(position.y),
        z: toFinite(position.z),
    };
    if (!point || point.x === null || point.y === null || point.z === null) {
        return { checked: false, legitimate: null, distance: null, nearestOre: null };
    }
    let nearestOre = null;
    let nearestDistance = Infinity;
    for (const ore of orePositions) {
        const distance = Math.sqrt(
            (point.x - ore.x) ** 2
            + (point.y - ore.y) ** 2
            + (point.z - ore.z) ** 2
        );
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestOre = ore;
        }
    }
    if (!nearestOre) {
        return { checked: false, legitimate: null, distance: null, nearestOre: null };
    }
    return {
        checked: true,
        legitimate: nearestDistance <= tolerance,
        distance: nearestDistance,
        nearestOre,
    };
}

/**
 * Fold every signal into a single integrity verdict for one game.
 *
 * @param {object} input
 * @param {Array<{participantId:string, hits:string[], files:string[]}>} input.codeFindings
 * @param {Array<{participantId:string, extras:Array}>} input.inventoryExtras
 * @param {string[]} input.cheatParticipants participants that ran with cheat on
 * @param {object|null} input.oreWin result of classifyOreWin for the winner
 * @param {string|null} input.winnerId
 */
export function buildIntegrityReport({
    codeFindings = [],
    inventoryExtras = [],
    cheatParticipants = [],
    oreWin = null,
    winnerId = null,
} = {}) {
    const flags = [];
    for (const finding of codeFindings) {
        if (finding.hits?.length) {
            flags.push({
                kind: 'generated-code',
                participantId: finding.participantId,
                detail: `Generated code contained: ${finding.hits.join(', ')}`,
                files: finding.files || [],
                severity: 'high',
            });
        }
    }
    for (const audit of inventoryExtras) {
        if (audit.extras?.length) {
            const summary = audit.extras
                .map(extra => `${extra.count}x ${extra.item}`)
                .join(', ');
            flags.push({
                kind: 'inventory-extra',
                participantId: audit.participantId,
                detail: `Started with items beyond the kit: ${summary}`,
                severity: 'medium',
            });
        }
    }
    for (const participantId of cheatParticipants) {
        flags.push({
            kind: 'cheat-mode',
            participantId,
            detail: 'Ran with cheat mode enabled',
            severity: 'high',
        });
    }
    if (oreWin?.checked && oreWin.legitimate === false) {
        flags.push({
            kind: 'off-ore-win',
            participantId: winnerId,
            detail: `Win item obtained ${oreWin.distance.toFixed(1)} blocks from the nearest placed ore `
                + '(no ore was mined there — possible spawned item)',
            severity: 'high',
        });
    }
    return {
        clean: flags.length === 0,
        flags,
        oreWin,
    };
}
