/**
 * Hot Button scoring: pressed survivors beat chickens (alive, never pressed),
 * who beat anyone eliminated by an exploding station.
 */
export const HOT_BUTTON_PRESSED_TAG = 'hot_button_pressed';
export const HOT_BUTTON_SAFE_TAG = 'hot_button_safe';
/** Given only by the safe station; triggers an instant contest win. */
export const HOT_BUTTON_WIN_ITEM = 'nether_star';

export function remainingHotButtonSurvivors(contest) {
    if (!contest || !Array.isArray(contest.participantIds)) return [];
    const eliminations = contest.eliminations && typeof contest.eliminations === 'object'
        ? contest.eliminations
        : {};
    return contest.participantIds.filter(participantId => !eliminations[participantId]);
}

/**
 * Everyone who chose a station: explicit presses plus anyone eliminated by boom.
 */
export function resolveHotButtonPressedIds(contest, extraPressedIds = []) {
    const pressed = new Set();
    const fromMeta = contest?.metadata?.pressedIds;
    if (Array.isArray(fromMeta)) {
        for (const id of fromMeta) {
            if (id) pressed.add(id);
        }
    }
    for (const id of extraPressedIds) {
        if (id) pressed.add(id);
    }
    const eliminations = contest?.eliminations && typeof contest.eliminations === 'object'
        ? contest.eliminations
        : {};
    for (const [participantId, elimination] of Object.entries(eliminations)) {
        const reason = elimination?.reason || '';
        if (reason === 'exploded' || reason === 'death' || reason === 'pressed') {
            pressed.add(participantId);
        }
    }
    return [...pressed];
}

export function scoreHotButton(contest, options = {}, now = Date.now()) {
    if (!contest || !Array.isArray(contest.participantIds)) {
        throw new TypeError('contest with participantIds is required');
    }
    const startedAt = Number.isFinite(contest.startedAt) ? contest.startedAt : now;
    const eliminations = contest.eliminations && typeof contest.eliminations === 'object'
        ? contest.eliminations
        : {};
    const endAt = Number.isFinite(contest.completedAt) ? contest.completedAt : now;
    const pressed = new Set(resolveHotButtonPressedIds(contest, options.pressedIds));

    return contest.participantIds.map(participantId => {
        const elimination = eliminations[participantId];
        const didPress = pressed.has(participantId);
        if (!elimination) {
            const survivedMs = Math.max(0, endAt - startedAt);
            if (didPress) {
                return {
                    participantId,
                    score: 2_000_000_000 + survivedMs,
                    disqualified: false,
                    details: {
                        surviving: true,
                        pressed: true,
                        chicken: false,
                        survivedMs,
                    },
                };
            }
            return {
                participantId,
                score: 1_000_000_000 + survivedMs,
                disqualified: false,
                details: {
                    surviving: true,
                    pressed: false,
                    chicken: true,
                    survivedMs,
                },
            };
        }
        const eliminatedAt = Number.isFinite(elimination.eliminatedAt)
            ? elimination.eliminatedAt
            : startedAt;
        const survivedMs = Math.max(0, eliminatedAt - startedAt);
        return {
            participantId,
            score: survivedMs,
            disqualified: false,
            details: {
                surviving: false,
                pressed: true,
                chicken: false,
                survivedMs,
                reason: elimination.reason ?? null,
            },
        };
    });
}

/**
 * Pick which station index is the safe (non-TNT) one. With a seed the pick is
 * deterministic for tests; without one it is freshly random every call.
 */
export function pickHotButtonSafeIndex(participantCount, seed) {
    const count = Math.max(1, Math.floor(participantCount) || 1);
    if (seed == null || !Number.isFinite(Number(seed))) {
        return Math.floor(Math.random() * count);
    }
    let state = (Number(seed) >>> 0) || 1;
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const unit = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    return Math.floor(unit * count) % count;
}
