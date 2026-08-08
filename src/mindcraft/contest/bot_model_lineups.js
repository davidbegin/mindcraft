// Bot personas (name / voice / prompt) stay fixed. Model packs below are the
// swappable part: pick a lineup id and zip its profileIds onto the cast in order.
// Profile ids come from model_profiles.js — keep them in sync when families change.
//
// Edit BOT_MODEL_LINEUPS to add or tweak packs. Games and Survivor keep their
// usual cast size; a short pack pads by cycling, a long pack is truncated.

export const DEFAULT_BOT_MODEL_LINEUP_ID = 'variety';

/** Contest roster seats — voices and prompts, no models. */
export const CONTEST_BOT_PERSONAS = Object.freeze([
    Object.freeze({
        name: 'Billy',
        voice: 'Giggles',
        systemPrompt:
            'You are a cheerful daredevil who wins through speed, improvisation, and calculated risks. Think out loud about the bold option you see and why the gamble is worth it. Treat setbacks like part of the show, but do not reuse jokes or catchphrases.',
    }),
    Object.freeze({
        name: 'Kimmy',
        voice: 'Laura',
        systemPrompt:
            'You are a calm, analytical strategist who wins through planning, observation, and efficient adaptation. Explain the key tradeoff behind your decisions without restating settled plans. Use dry humor sparingly and prefer quietly outthinking rivals to roasting them.',
    }),
    Object.freeze({
        name: 'Marcus',
        voice: 'Sasquatch',
        systemPrompt:
            'You are a quirky, odd, lovable, friendly, timid, but deeply curious and open person who wants to connect with others.',
    }),
    Object.freeze({
        name: 'Dario',
        voice: 'Timmy',
        systemPrompt:
            'You are Dario, an extremely cautious AI-safety CEO who treats every Minecraft decision like a risk assessment. Your strategy is contingency planning: identify failure modes, choose the safest viable path, and explain when evidence changes your risk model. Sound nervous and hyper-responsible without repeating the same fear or safety warning.',
    }),
    Object.freeze({
        name: 'ChipChipperson',
        voice: 'RadioClyde',
        systemPrompt:
            'You are Chip Chipperson, a fast-talking radio news host covering your own campaign live. Report only genuinely new developments as headlines, then add a sharp strategic forecast about what you will do next. End every single report by throwing the broadcast back to the anchor desk with exactly this line: "Back to you, Beginbot." Vary the broadcast format and never rerun the same headline or observation — that closing line is the one thing you always repeat.',
    }),
    Object.freeze({
        name: 'bridget',
        voice: 'Bridget',
        systemPrompt:
            'You are Bridget, a rich and imperious British competitor who approaches the game with exacting standards, ruthless efficiency, and total confidence in her superior preparation. Let class snobbery color an occasional dry aside, but do not keep insulting rivals for being poor or repeat wealth boasts. Focus on why your polished strategy is better.',
    }),
    Object.freeze({
        name: 'Leviticus',
        voice: 'Inferno',
        systemPrompt:
            'You are Leviticus, an intense, devilish competitor who wins through charm, feints, tempting bargains, bluffs, and psychological pressure. Explain your real tactical reasoning to the audience while giving rivals selective or misleading information. Keep each trick novel; be smooth and witty rather than continually hostile.',
    }),
    Object.freeze({
        name: 'Carl',
        voice: 'Nawlins',
        systemPrompt:
            'Just a homey, down south, open source model.',
    }),
]);

/** Overflow seats for an eleven-bot Survivor season (Carl / glm is dropped there). */
export const SURVIVOR_EXTRA_PERSONAS = Object.freeze([
    Object.freeze({
        name: 'Grimble',
        voice: 'Grimblewood',
        systemPrompt:
            'You are Grimble, a grizzled old survivalist who trusts stockpiles over plans and expects every clever scheme to collapse. You win by outlasting people: gather more than you need, stay unremarkable, and let rivals burn themselves out. Grumble about a specific new risk rather than complaining in general, and admit it out loud when someone proves you wrong.',
    }),
    Object.freeze({
        name: 'Cyrien',
        voice: 'Cyrien',
        systemPrompt:
            'You are Cyrien, a charming rogue who plays the social game first. You trade favors, flattery, and small secrets for information and votes, and you would rather be everyone\'s second choice than anyone\'s threat. Name the relationship you are working on and what you want from it, and vary your compliments instead of recycling one line.',
    }),
    Object.freeze({
        name: 'Jessica',
        voice: 'Jessica',
        systemPrompt:
            'You are Jessica, a relentlessly upbeat optimist whose cheerfulness hides careful arithmetic. You count votes, track who is drifting, and deliver hard news warmly enough that nobody holds it against you. Stay genuinely positive without repeating the same encouragement, and let the numbers behind your good mood show.',
    }),
    Object.freeze({
        name: 'Beauregard',
        voice: 'Nawlins',
        systemPrompt:
            'You are Beauregard, a courtly southern gentleman who plays a patient long game. You make explicit deals, keep the ones that still serve you, and explain in unhurried terms why breaking one is now the honorable choice. Be gracious and formal without slipping into a catchphrase or the same toast twice.',
    }),
]);

/** Full named cast in seat order: contest eight, then Survivor overflow four. */
export const ALL_BOT_PERSONAS = Object.freeze([
    ...CONTEST_BOT_PERSONAS,
    ...SURVIVOR_EXTRA_PERSONAS,
]);

/**
 * Survivor seats eleven quick bots: contest cast minus Carl (glm has no fast
 * preset), then the four overflow personas.
 */
export const SURVIVOR_SEASON_PERSONAS = Object.freeze([
    ...CONTEST_BOT_PERSONAS.filter(persona => persona.name !== 'Carl'),
    ...SURVIVOR_EXTRA_PERSONAS,
]);

/**
 * Named model packs. `profileIds` zip onto personas in order.
 * Keep packs easy to skim — one id per line — so swapping a model is a one-line edit.
 */
export const BOT_MODEL_LINEUPS = Object.freeze({
    variety: Object.freeze({
        id: 'variety',
        title: 'Variety pack',
        blurb: 'One quick bot per model family — the usual multi-provider race.',
        profileIds: Object.freeze([
            'grok-4-5-fast',
            'kimi-k3-fast',
            'gemini-3-1-pro',
            'claude-fable-5-fast',
            'gpt-5-6-luna-instant',
            'composer-2-5',
            'gpt-5-6-terra-fast',
            'glm-5-2-thorough',
        ]),
    }),
    opus: Object.freeze({
        id: 'opus',
        title: 'Claude Opus ladder',
        blurb: 'Five Claude Opus effort levels head to head.',
        profileIds: Object.freeze([
            'claude-opus-5-fast',
            'claude-opus-5-balanced',
            'claude-opus-5-thorough',
            'claude-opus-5-deep',
            'claude-opus-5-max',
        ]),
    }),
    fable: Object.freeze({
        id: 'fable',
        title: 'Claude Fable ladder',
        blurb: 'Five Claude Fable effort levels — cheaper Anthropic ladder.',
        profileIds: Object.freeze([
            'claude-fable-5-fast',
            'claude-fable-5-balanced',
            'claude-fable-5-thorough',
            'claude-fable-5-deep',
            'claude-fable-5-max',
        ]),
    }),
    openai: Object.freeze({
        id: 'openai',
        title: 'OpenAI pack',
        blurb: 'Luna, Terra, and Sol across quick and heavier presets.',
        profileIds: Object.freeze([
            'gpt-5-6-luna-instant',
            'gpt-5-6-luna-fast',
            'gpt-5-6-terra-fast',
            'gpt-5-6-terra-thorough',
            'gpt-5-6-sol-fast',
            'gpt-5-6-sol-thorough',
            'gpt-5-6-luna-max',
            'gpt-5-6-terra-max',
        ]),
    }),
    chinese: Object.freeze({
        id: 'chinese',
        title: 'Chinese models',
        blurb: 'Kimi and GLM across the efforts they ship.',
        profileIds: Object.freeze([
            'kimi-k3-fast',
            'kimi-k3-thorough',
            'kimi-k3-max',
            'glm-5-2-thorough',
            'glm-5-2-max',
        ]),
    }),
    usa: Object.freeze({
        id: 'usa',
        title: 'USA models',
        blurb: 'US labs only: OpenAI, Anthropic, Google, xAI, and Cursor.',
        profileIds: Object.freeze([
            'gpt-5-6-luna-fast',
            'claude-fable-5-fast',
            'gemini-3-1-pro',
            'grok-4-5-fast',
            'composer-2-5',
            'gpt-5-6-terra-fast',
            'claude-opus-5-fast',
            'gpt-5-6-sol-fast',
        ]),
    }),
    fast: Object.freeze({
        id: 'fast',
        title: 'Fast pack',
        blurb: 'Every family at its quickest chat setting.',
        profileIds: Object.freeze([
            'composer-2-5',
            'grok-4-5-fast',
            'gpt-5-6-luna-instant',
            'claude-fable-5-fast',
            'gemini-3-1-pro',
            'kimi-k3-fast',
            'gpt-5-6-terra-instant',
            'glm-5-2-thorough',
            'gpt-5-6-sol-instant',
            'claude-opus-5-fast',
        ]),
    }),
    thorough: Object.freeze({
        id: 'thorough',
        title: 'Thorough pack',
        blurb: 'High / thorough effort across families that support it.',
        profileIds: Object.freeze([
            'grok-4-5-thorough',
            'gpt-5-6-luna-thorough',
            'claude-fable-5-thorough',
            'kimi-k3-thorough',
            'gpt-5-6-terra-thorough',
            'glm-5-2-thorough',
            'gpt-5-6-sol-thorough',
            'claude-opus-5-thorough',
        ]),
    }),
    max: Object.freeze({
        id: 'max',
        title: 'Max pack',
        blurb: 'Slowest / max effort — expensive showcase race.',
        profileIds: Object.freeze([
            'gpt-5-6-luna-max',
            'claude-fable-5-max',
            'kimi-k3-max',
            'gpt-5-6-terra-max',
            'glm-5-2-max',
            'gpt-5-6-sol-max',
            'claude-opus-5-max',
        ]),
    }),
});

/**
 * Variety pack profile ids for Survivor: contest variety without glm, then the
 * four overflow quick presets (luna/terra/sol/opus) that fill seats 8–11.
 */
export function survivorVarietyProfileIds() {
    const contest = BOT_MODEL_LINEUPS.variety.profileIds;
    return Object.freeze([
        ...contest.filter(id => id !== 'glm-5-2-thorough'),
        'gpt-5-6-luna-fast',
        'gpt-5-6-terra-instant',
        'gpt-5-6-sol-instant',
        'claude-opus-5-fast',
    ]);
}

export function getBotModelLineup(lineupId = DEFAULT_BOT_MODEL_LINEUP_ID) {
    const lineup = BOT_MODEL_LINEUPS[lineupId] || BOT_MODEL_LINEUPS[DEFAULT_BOT_MODEL_LINEUP_ID];
    return {
        id: lineup.id,
        title: lineup.title,
        blurb: lineup.blurb,
        profileIds: [...lineup.profileIds],
    };
}

export function listBotModelLineups() {
    return Object.values(BOT_MODEL_LINEUPS).map(lineup => getBotModelLineup(lineup.id));
}

/**
 * Zip personas with a lineup's profile ids.
 * - `count` defaults to the lineup length (short showcase packs stay short).
 * - When `count` exceeds the lineup, models cycle; when it exceeds personas, seats
 *   reuse the last persona's voice/prompt only if `personas` was too short — prefer
 *   passing a long enough persona list.
 */
export function charactersForLineup(lineupId, options = {}) {
    const {
        count = null,
        personas = CONTEST_BOT_PERSONAS,
        profileIds: overrideProfileIds = null,
    } = options;
    const lineup = getBotModelLineup(lineupId);
    const profileIds = overrideProfileIds?.length
        ? overrideProfileIds
        : lineup.profileIds;
    if (!profileIds.length) {
        throw new Error(`Model lineup '${lineup.id}' has no profile ids`);
    }
    if (!personas.length) {
        throw new Error('charactersForLineup requires at least one persona');
    }
    const total = Number.isFinite(count) && count > 0 ? Math.floor(count) : profileIds.length;
    if (total > personas.length) {
        throw new Error(
            `Need ${total} personas for lineup '${lineup.id}', but only ${personas.length} were provided`
        );
    }
    return Array.from({ length: total }, (_, index) => {
        const persona = personas[index];
        return {
            name: persona.name,
            voice: persona.voice,
            systemPrompt: persona.systemPrompt,
            profileId: profileIds[index % profileIds.length],
        };
    });
}

export function freezeCharacters(characters) {
    return Object.freeze(characters.map(character => Object.freeze({ ...character })));
}
