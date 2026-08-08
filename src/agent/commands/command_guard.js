/**
 * Guards command execution against wasteful loops and self-defeating moves:
 * - Blocks commands issued while the bot is dead (a corpse can't act).
 * - Blocks verbatim retries of a command+args pair that has already failed
 *   twice recently, and injects an escalation hint so the LLM changes
 *   strategy instead of burning turns on the same failure.
 * - Blocks the commands that lose a Spleef match outright, since a prompt
 *   telling a bot not to dig under itself is not an enforcement mechanism.
 */

const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_IDENTICAL_FAILURES = 2;

export const ALLOWED_WHILE_DEAD = new Set(['!stop', '!restart', '!stfu', '!clearChat', '!stats']);

const MOVEMENT_HINT = 'Do NOT repeat this exact movement. Escalate instead: check whether your tools can break the blocking terrain (craft a pickaxe if you saw "Cannot break ... with current tools"), dig through the obstruction with !clearArea, bridge or pillar past it with !placeRow, or choose a different destination.';
const CHEST_HINT = 'This chest is likely broken or unreachable. Do NOT retry it. Place a new chest nearby (craft one if needed, then !placeHere("chest")), use that instead, and record the broken chest location with !recordColonyProgress so others avoid it.';
const GIVE_HINT = 'Direct handoff keeps failing. Do NOT retry it. Put the items in a chest near the recipient instead, then message them the chest coordinates.';
const BED_HINT = 'There is no usable bed here. Do NOT retry. Craft and place a bed first (!craftRecipe("white_bed", 1) then !placeHere("white_bed")), or skip sleeping and continue your task.';

const ESCALATION_HINTS = {
    '!goToCoordinates': MOVEMENT_HINT,
    '!goToPlayer': MOVEMENT_HINT,
    '!goToRememberedPlace': MOVEMENT_HINT,
    '!goToSurface': MOVEMENT_HINT,
    '!searchForBlock': MOVEMENT_HINT,
    '!searchForEntity': 'The target is not nearby. Do NOT repeat the same search. Expand the range once, look in a different area, or work with what you have.',
    '!moveAway': MOVEMENT_HINT,
    '!goToBed': BED_HINT,
    '!putInChest': CHEST_HINT,
    '!takeFromChest': CHEST_HINT,
    '!viewChest': CHEST_HINT,
    '!givePlayer': GIVE_HINT,
};

const GENERIC_HINT = 'Do NOT repeat it verbatim. Change your approach or parameters, or move on to a different step of your task.';

// Spleef is lost the instant a bot drops through the floor it is standing on, so
// the commands that break that floor — or that break the game's other rules —
// are refused outright instead of being left to the prompt to discourage.
const SPLEEF_BANNED_COMMANDS = new Map([
    ['!digDown', 'it digs straight through the floor under your own feet, which eliminates you instantly'],
    ['!clearArea', 'it breaks a whole region of floor, including the block you are standing on'],
    ['!collectBlocks', 'it mines the snow floor out from under yourself'],
    ['!placeHere', 'placing blocks is against the rules of Spleef'],
    ['!placeRow', 'placing blocks is against the rules of Spleef'],
    ['!plantArea', 'placing blocks is against the rules of Spleef'],
    ['!attack', 'you cannot fight in Spleef; the floor is your only weapon'],
    ['!attackPlayer', 'you cannot fight in Spleef; the floor is your only weapon'],
    ['!newAction', 'custom code can dig under your own feet and lose the match'],
]);

/**
 * Refuses a command that would drop the bot through the Spleef floor, and points
 * it back at the one action that digs at rivals while protecting its own footing.
 */
export function spleefCommandRejection(commandName) {
    const reason = SPLEEF_BANNED_COMMANDS.get(commandName);
    if (!reason) return null;
    return `${commandName} is banned during Spleef because ${reason}. `
        + 'Never dig beneath your own feet. Use !playSpleef(100) instead: it chases rivals '
        + 'and removes the ground under them while refusing to break your own footing.';
}

const HOT_BUTTON_BANNED_COMMANDS = new Map([
    ['!digDown', 'digging is against the rules of Hot Button'],
    ['!clearArea', 'breaking blocks is against the rules of Hot Button'],
    ['!collectBlocks', 'mining is against the rules of Hot Button'],
    ['!placeHere', 'placing blocks is against the rules of Hot Button'],
    ['!placeRow', 'placing blocks is against the rules of Hot Button'],
    ['!plantArea', 'placing blocks is against the rules of Hot Button'],
    ['!attack', 'you cannot fight in Hot Button; press a button instead'],
    ['!attackPlayer', 'you cannot fight in Hot Button; press a button instead'],
    ['!newAction', 'custom code can cheat the button stations'],
]);

/**
 * Refuses commands that dig, build, or fight during Hot Button, and points the
 * bot back at the automatic press action.
 */
export function hotButtonCommandRejection(commandName) {
    const reason = HOT_BUTTON_BANNED_COMMANDS.get(commandName);
    if (!reason) return null;
    return `${commandName} is banned during Hot Button because ${reason}. `
        + 'Use !playHotButton instead: it walks to an unused stone button and presses it.';
}

const FAILURE_PATTERNS = /timed out|timeout|failed|could not|cannot |can't |unable to|no path|path not found|don't have|ran out of time|nothing to place on|not found/i;
const SUCCESS_PATTERNS = /you have reached|successfully|planted \d|collected \d|placed|crafted|broke \d|deposited|finished|cleared area|reached the/i;

export function looksLikeFailure(result) {
    if (typeof result !== 'string' || result.length === 0) return false;
    return FAILURE_PATTERNS.test(result) && !SUCCESS_PATTERNS.test(result);
}

export class CommandGuard {
    constructor(clock = () => Date.now()) {
        this.clock = clock;
        this.failures = new Map(); // command+args key -> { count, at }
    }

    _key(commandName, args) {
        return `${commandName}(${JSON.stringify(args ?? [])})`;
    }

    _prune(now) {
        for (const [key, entry] of this.failures) {
            if (now - entry.at > FAILURE_WINDOW_MS) {
                this.failures.delete(key);
            }
        }
    }

    /**
     * Returns a rejection message if this exact command+args has already
     * failed MAX_IDENTICAL_FAILURES times recently, otherwise null.
     */
    check(commandName, args) {
        const now = this.clock();
        this._prune(now);
        const entry = this.failures.get(this._key(commandName, args));
        if (entry && entry.count >= MAX_IDENTICAL_FAILURES) {
            const hint = ESCALATION_HINTS[commandName] ?? GENERIC_HINT;
            return `${commandName} with these exact arguments has already failed ${entry.count} times in a row. ${hint}`;
        }
        return null;
    }

    /** Record the outcome of an executed command so future retries can be limited. */
    record(commandName, args, result) {
        const key = this._key(commandName, args);
        if (looksLikeFailure(result)) {
            const now = this.clock();
            const entry = this.failures.get(key);
            this.failures.set(key, { count: (entry?.count ?? 0) + 1, at: now });
        } else if (typeof result === 'string' && result.length > 0) {
            this.failures.delete(key);
        }
    }
}
