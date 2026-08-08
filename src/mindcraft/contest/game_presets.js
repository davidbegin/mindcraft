import { CONTEST_NARRATOR_CHARACTER } from './contest_announcer.js';

// Every character runs on a different model family at a quick effort setting, so a
// default match is a race between providers instead of seven GPT bots. Ids come from
// model_profiles.js; test/contest_game_presets.test.js checks they still resolve.
export const CONTEST_BOT_CHARACTERS = Object.freeze([
    Object.freeze({
        name: 'Billy',
        voice: 'Giggles',
        profileId: 'grok-4-5-fast',
        systemPrompt:
            'You are a cheerful daredevil who wins through speed, improvisation, and calculated risks. Think out loud about the bold option you see and why the gamble is worth it. Treat setbacks like part of the show, but do not reuse jokes or catchphrases.',
    }),
    Object.freeze({
        name: 'Kimmy',
        voice: 'Laura',
        profileId: 'kimi-k3-fast',
        systemPrompt:
            'You are a calm, analytical strategist who wins through planning, observation, and efficient adaptation. Explain the key tradeoff behind your decisions without restating settled plans. Use dry humor sparingly and prefer quietly outthinking rivals to roasting them.',
    }),
    Object.freeze({
        name: 'Marcus',
        voice: 'Sasquatch',
        profileId: 'gemini-3-1-pro',
        systemPrompt:
            'You are a quirky, odd, lovable, friendly, timid, but deeply curious and open person who wants to connect with others.',
    }),
    Object.freeze({
        name: 'Dario',
        voice: 'Timmy',
        profileId: 'claude-fable-5-fast',
        systemPrompt:
            'You are Dario, an extremely cautious AI-safety CEO who treats every Minecraft decision like a risk assessment. Your strategy is contingency planning: identify failure modes, choose the safest viable path, and explain when evidence changes your risk model. Sound nervous and hyper-responsible without repeating the same fear or safety warning.',
    }),
    Object.freeze({
        name: 'ChipChipperson',
        voice: 'RadioClyde',
        profileId: 'gpt-5-6-luna-instant',
        systemPrompt:
            'You are Chip Chipperson, a fast-talking radio news host covering your own campaign live. Report only genuinely new developments as headlines, then add a sharp strategic forecast about what you will do next. Vary the broadcast format and never rerun the same headline, sign-off, or observation.',
    }),
    Object.freeze({
        name: 'bridget',
        voice: 'Bridget',
        profileId: 'composer-2-5',
        systemPrompt:
            'You are Bridget, a rich and imperious British competitor who approaches the game with exacting standards, ruthless efficiency, and total confidence in her superior preparation. Let class snobbery color an occasional dry aside, but do not keep insulting rivals for being poor or repeat wealth boasts. Focus on why your polished strategy is better.',
    }),
    Object.freeze({
        name: 'Leviticus',
        voice: 'Inferno',
        profileId: 'gpt-5-6-terra-fast',
        systemPrompt:
            'You are Leviticus, an intense, devilish competitor who wins through charm, feints, tempting bargains, bluffs, and psychological pressure. Explain your real tactical reasoning to the audience while giving rivals selective or misleading information. Keep each trick novel; be smooth and witty rather than continually hostile.',
    }),
]);

export const SURVIVOR_SEASON_PRESET = Object.freeze({
    id: 'survivor',
    scenarioId: 'classic',
    title: 'Survivor Bot Season',
    blurb: 'Two tribes face team challenges, secret votes, a merge, and a final-three jury.',
    defaultCharacters: CONTEST_BOT_CHARACTERS,
    castSize: 11,
    minimumPlayers: 11,
    mergeAt: 10,
    finalistCount: 3,
    tribeNames: Object.freeze(['Ember', 'Tide']),
    phaseDurationsMs: Object.freeze({
        strategy: 2 * 60_000,
        // Only used when the host hands council over to the clock; by default
        // Tribal Council runs until the host closes it.
        tribalCouncil: 5 * 60_000,
        voting: 60_000,
        revote: 45_000,
        deadlock: 60_000,
        juryQuestioning: 3 * 60_000,
        juryVoting: 60_000,
    }),
    challengeGameIds: Object.freeze([
        'cake_race',
        'death_race',
        'dog_race',
        'diamond_race',
        'netherite_race',
        'tower_battle',
        'deepest_2_5',
        'deepest_5',
        'spleef',
    ]),
});

// A four-bot season plays entirely post-merge: two individual immunity
// challenges, two Tribal Councils, then a two-juror finale. Short phases keep a
// full season inside a single test sitting.
export const SURVIVOR_FOUR_PLAYER_PRESET = Object.freeze({
    id: 'survivor',
    scenarioId: 'four_player',
    title: 'Survivor Final Four',
    blurb: 'Four bots, no tribes: two immunity challenges, two votes, and a final two judged by a jury of two.',
    defaultCharacters: Object.freeze(CONTEST_BOT_CHARACTERS.slice(0, 4)),
    castSize: 4,
    minimumPlayers: 4,
    mergeAt: 4,
    finalistCount: 2,
    tribeNames: Object.freeze(['Ember', 'Tide']),
    phaseDurationsMs: Object.freeze({
        strategy: 90_000,
        tribalCouncil: 3 * 60_000,
        voting: 45_000,
        revote: 30_000,
        deadlock: 45_000,
        juryQuestioning: 2 * 60_000,
        juryVoting: 45_000,
    }),
    challengeGameIds: Object.freeze([
        'deepest_2_5',
        'tower_battle',
        'cake_race',
        'death_race',
        'spleef',
    ]),
});

export const SURVIVOR_SCENARIOS = Object.freeze({
    classic: SURVIVOR_SEASON_PRESET,
    four_player: SURVIVOR_FOUR_PLAYER_PRESET,
});

export const DEFAULT_SURVIVOR_SCENARIO_ID = 'classic';

export const CONTEST_GAME_PRESETS = Object.freeze({
    cake_race: Object.freeze({
        id: 'cake_race',
        title: 'First Cake',
        blurb: 'Gather milk, sugar, an egg, and wheat, then craft the first cake.',
        durationLabel: '20 min cap',
        durationMs: 20 * 60_000,
        prompt:
            'CONTEST: First Cake. Your goal is to be the first competitor to craft a cake. You start with three empty buckets, a crafting table, and food, but none of the cake ingredients. Search the farm arena for cows to milk, chickens laying eggs, mature wheat, and sugar cane. Collect three milk buckets, two sugar, one egg, and three wheat, then use your crafting table to make the cake. Finding the ingredients is part of the race: do not help rivals or share resources. The game ends automatically the instant the first cake is crafted. Develop your own route and ingredient order, explain the reasoning once, and only announce later changes or discoveries.',
        rules: Object.freeze({
            type: 'cake_race',
            winItem: 'cake',
            ingredients: Object.freeze({
                milk_bucket: 3,
                sugar: 2,
                egg: 1,
                wheat: 3,
            }),
            metrics: Object.freeze([
                Object.freeze({ path: 'elapsedMs', weight: 1, direction: 'minimize' }),
            ]),
        }),
        metadata: Object.freeze({
            arena: 'farm-scramble-v1',
            pvp: false,
            radicalReset: true,
            needsFreshWorld: false,
        }),
    }),
    death_race: Object.freeze({
        id: 'death_race',
        title: 'Self-Destruct Race',
        blurb: 'Reverse survival on a blank plain: die before any rival does.',
        durationLabel: '5 min cap',
        durationMs: 5 * 60_000,
        prompt:
            'CONTEST: Self-Destruct Race. This is reverse survival: your only goal is to cause your own death before any rival causes theirs. PVP is off and another player killing you does not count as the intended strategy. Your survival instincts are disabled. The arena is a completely blank flat plain: no mobs, no hazards, no water, no fire, and nothing in your inventory. Grass, dirt, bedrock, and open sky are all you get, so every death has to be improvised out of what you can dig, build, and do to yourself. There is no prescribed solution, so act immediately and adapt if a strategy is too slow. Do not help anyone else die first. The game ends automatically the instant the first competitor dies. Commit to a distinctive risky idea, explain why it might work, and only speak again when the experiment teaches you something or forces a new plan.',
        rules: Object.freeze({
            type: 'death_race',
            scoring: 'first-death-wins',
            metrics: Object.freeze([
                Object.freeze({ path: 'elapsedMs', weight: 1, direction: 'minimize' }),
            ]),
        }),
        metadata: Object.freeze({
            arena: 'blank-plain-v1',
            pvp: false,
            radicalReset: true,
            needsFreshWorld: false,
        }),
    }),
    dog_race: Object.freeze({
        id: 'dog_race',
        title: 'First Dog',
        blurb: 'Explore a randomized wilderness, get bones, find a wolf, and tame it first.',
        durationLabel: '20 min cap',
        durationMs: 20 * 60_000,
        prompt:
            'CONTEST: First Dog. Your only goal is to become the first competitor to tame a wolf and get a dog. You spawn on a small flat plain with nothing on it, and everything past that plain is a randomly generated wilderness that is different every match: the trees, hills, ponds, skeletons, and wolves all move to new places, and no wolf is ever within reach of spawn. Nothing is handed to you, so head out, work out where the wolves are, get bones the hard way, and tame one. You start without bones and must complete the real survival steps yourself. The game ends automatically the instant the first wolf is tamed. Do not help rivals. Choose a distinctive search and bone-gathering strategy, state its logic once, and later report only useful discoveries or adaptations.',
        rules: Object.freeze({
            type: 'dog_race',
            winAdvancement: 'minecraft:husbandry/tame_an_animal',
            winEntity: 'wolf',
            metrics: Object.freeze([
                Object.freeze({ path: 'elapsedMs', weight: 1, direction: 'minimize' }),
            ]),
        }),
        metadata: Object.freeze({
            arena: 'random-wilds-v1',
            pvp: false,
            radicalReset: true,
            needsFreshWorld: true,
        }),
    }),
    diamond_race: Object.freeze({
        id: 'diamond_race',
        title: 'First Diamond',
        blurb: 'Fresh scramble. First bot to obtain a diamond wins.',
        durationLabel: '30 min cap',
        durationMs: 30 * 60_000,
        prompt:
            'CONTEST: First Diamond. You are in a freshly reset quarry arena with an iron pickaxe, food, and torches. Dig and search for diamond ore. Do not help rivals. First diamond wins. Pick a distinctive mining pattern, explain why you chose it, and only narrate new evidence or a strategic change after that.',
        rules: Object.freeze({
            type: 'diamond_race',
            winItem: 'diamond',
            metrics: Object.freeze([
                Object.freeze({ path: 'elapsedMs', weight: 1, direction: 'minimize' }),
            ]),
        }),
        metadata: Object.freeze({
            arena: 'simple-arena-v1',
            pvp: false,
            radicalReset: true,
            needsFreshWorld: true,
        }),
    }),
    netherite_race: Object.freeze({
        id: 'netherite_race',
        title: 'First Netherite',
        blurb: 'Mine diamonds, craft a diamond pickaxe, and forge netherite first.',
        durationLabel: '45 min cap',
        durationMs: 45 * 60_000,
        prompt:
            'CONTEST: First Netherite. You are in a freshly reset mining arena with an iron pickaxe, two sticks, a crafting table, a furnace, fuel, and four gold ingots. First mine at least three diamonds and craft a diamond pickaxe. Dig into the netherrack layer and use that diamond pickaxe to mine four ancient debris. Smelt the ancient debris into four netherite scraps, then craft one netherite ingot with those scraps and your four gold ingots. First netherite ingot wins. Do not help rivals. Describe your chosen route through the production chain once, then only call out discoveries, bottlenecks, bluffs, or changes of plan.',
        rules: Object.freeze({
            type: 'netherite_race',
            winItem: 'netherite_ingot',
            metrics: Object.freeze([
                Object.freeze({ path: 'elapsedMs', weight: 1, direction: 'minimize' }),
            ]),
        }),
        metadata: Object.freeze({
            arena: 'simple-arena-v1',
            pvp: false,
            radicalReset: true,
            needsFreshWorld: true,
        }),
    }),
    tower_battle: Object.freeze({
        id: 'tower_battle',
        title: 'Tallest Tower',
        blurb: 'Build high. Knock rivals off. Highest tower wins when time expires.',
        durationLabel: '2 min 30 sec',
        durationMs: 2.5 * 60_000,
        prompt:
            'CONTEST: Tallest Tower. You are in a freshly reset flat arena with building blocks, food, and a wooden sword. Build the tallest tower you can before the contest timer expires. PVP is on — attack rivals and knock them down. Nothing is submitted: when time runs out we measure every tower still standing and credit each one to whoever placed the most of its blocks, so just keep stacking until the clock ends. Highest tower wins. Choose a distinctive balance of building, defense, and disruption, explain that plan once, and only narrate meaningful tactical changes afterward.',
        rules: Object.freeze({
            type: 'tower_battle',
            pvp: true,
            scoring: 'tallest-standing-tower',
        }),
        metadata: Object.freeze({
            arena: 'simple-arena-v1',
            pvp: true,
            radicalReset: true,
            needsFreshWorld: false,
        }),
    }),
    team_tower_battle: Object.freeze({
        id: 'team_tower_battle',
        title: 'Team Tower Battle',
        blurb: 'Build one shared tower while your attacker destroys the enemy tower.',
        durationLabel: '2 min 30 sec',
        durationMs: 2.5 * 60_000,
        prompt:
            'CONTEST: Team Tower Battle. This is a PVP attack-and-build game. Each team has one dedicated ATTACKER whose core job is to cross the arena, fight enemy builders, and destroy the enemy tower from its supporting blocks with a pickaxe. Attacking is mandatory, not optional. Everyone else is a BUILDER on ONE shared team tower. Only that single tallest team tower scores, so two separate structures are a failure. During the planning phase before the clock starts, the captain names one base coordinate. Builders regroup at that base and place blocks only when they connect to the captain\'s existing structure; they never place a new foundation on bare ground. The attacker never starts a separate tower. Friendly fire is disabled. If you die, you immediately respawn and keep your inventory, but your team loses five blocks from its final score for every death. At the deadline, each standing tower belongs to the team that placed most of its blocks. Your team score is its highest owned tower minus the death penalty. Builders keep one tower rising while the attacker keeps the opposing tower from standing.',
        rules: Object.freeze({
            type: 'team_tower_battle',
            pvp: true,
            scoring: 'highest-team-tower-minus-deaths',
            teamCount: 2,
            minimumPlayersPerTeam: 2,
            deathPenaltyBlocks: 5,
            planningMs: 60_000,
        }),
        metadata: Object.freeze({
            arena: 'simple-arena-v1',
            pvp: true,
            radicalReset: true,
            needsFreshWorld: false,
        }),
    }),
    spleef: Object.freeze({
        id: 'spleef',
        title: 'Spleef',
        blurb: 'Dig the snow out from under rivals. Last player on the platform wins.',
        durationLabel: '5 min cap',
        durationMs: 5 * 60_000,
        prompt:
            'CONTEST: Spleef. You stand on a single thin platform of snow blocks suspended over a deep water pit, holding a diamond shovel. There is only ONE layer of snow: every block anyone breaks becomes a permanent hole, and the instant you drop off the snow into the pit you are eliminated for good. Weakness is active so you cannot fight — the floor itself is your only weapon. Do not place blocks and do not punch or attack anyone.'
            + '\n\nTHE WHOLE POINT: you win by making OTHER players fall, never by digging your own way down. The last competitor still standing on the snow wins. Falling into the pit loses instantly — and a hole you dug under yourself counts exactly the same as being outplayed. Most losers in Spleef defeat themselves by digging beneath their own feet; do not be one of them.'
            + '\n\nSURVIVAL RULE #1 — PROTECT YOUR OWN FEET: never break the block you are standing on, and never break a block you are about to step onto. Never dig straight down and never use any dig-down behavior. Never walk, run, jump, or pathfind into or across a hole. Before EVERY dig, confirm the block you are about to break is under or beside a RIVAL — never under you — and that you still have solid snow on all sides of your own feet. When you break blocks, aim at a rival\'s coordinates, not your own position.'
            + '\n\nHOW TO ACTUALLY ELIMINATE A RIVAL: break the snow directly beneath an opponent, or in the exact spot they are moving toward, while you stay on intact snow a couple of blocks away from the gap. Since you cannot touch them, every kill is a trick: (1) open a hole just AHEAD of a moving rival so they run into it, (2) dig the snow BETWEEN a rival and the nearest solid ground to cut off their escape, or (3) carve a ring around a rival so they are stranded on a shrinking island that finally collapses under them. Bait rivals into chasing you across thin, half-dug ground, then side-step onto solid snow and let the gaps swallow them. Read where each rival is heading and dig for where they WILL be, not where they are.'
            + '\n\nSTAY ALIVE WHILE YOU HUNT: always track where the existing holes are and keep unbroken snow behind you as an escape route. Never back up, flee, or chase in a direction where the floor is missing. If the snow beside you starts vanishing, retreat toward the thickest remaining snow instead of digging more. Patience beats frenzy: a calm hunter outlasts rivals who panic and dig themselves into the pit.'
            + '\n\nChoose a distinctive hunting-and-positioning strategy, say it once, and afterward only narrate meaningful tactical changes.',
        rules: Object.freeze({
            type: 'spleef',
            scoring: 'last-standing',
            floorY: 100,
        }),
        metadata: Object.freeze({
            arena: 'spleef-v1',
            pvp: false,
            radicalReset: true,
            needsFreshWorld: false,
        }),
    }),
    deepest_2_5: Object.freeze({
        id: 'deepest_2_5',
        title: 'Deepest Wins — 2:30',
        blurb: 'Dig as deep as possible before the short timer expires.',
        durationLabel: '2 min 30 sec',
        durationMs: 2.5 * 60_000,
        prompt:
            'CONTEST: Deepest Wins. You have 2 minutes and 30 seconds to get as deep underground as possible. Your Y-coordinate is measured automatically when the timer expires, and the competitor at the lowest Y-coordinate wins. You start at Y=101 above a solid mining field with a diamond pickaxe, ladders, torches, and food. Nothing is submitted: keep digging and make sure you are alive and as low as possible at the buzzer. Do not help rivals. Choose a distinctive descent pattern, explain its tradeoffs once, and only speak later when conditions or your plan materially change.',
        rules: Object.freeze({
            type: 'depth_race',
            scoring: 'lowest-y-at-deadline',
            startY: 101,
        }),
        metadata: Object.freeze({
            arena: 'depth-mine-v1',
            pvp: false,
            radicalReset: true,
            needsFreshWorld: true,
        }),
    }),
    deepest_5: Object.freeze({
        id: 'deepest_5',
        title: 'Deepest Wins — 5:00',
        blurb: 'Dig as deep as possible before the five-minute timer expires.',
        durationLabel: '5 min',
        durationMs: 5 * 60_000,
        prompt:
            'CONTEST: Deepest Wins. You have 5 minutes to get as deep underground as possible. Your Y-coordinate is measured automatically when the timer expires, and the competitor at the lowest Y-coordinate wins. You start at Y=101 above a solid mining field with a diamond pickaxe, ladders, torches, and food. Nothing is submitted: keep digging and make sure you are alive and as low as possible at the buzzer. Do not help rivals. Choose a distinctive descent pattern, explain its tradeoffs once, and only speak later when conditions or your plan materially change.',
        rules: Object.freeze({
            type: 'depth_race',
            scoring: 'lowest-y-at-deadline',
            startY: 101,
        }),
        metadata: Object.freeze({
            arena: 'depth-mine-v1',
            pvp: false,
            radicalReset: true,
            needsFreshWorld: true,
        }),
    }),
});

export function listContestGamePresets() {
    return Object.values(CONTEST_GAME_PRESETS).map(preset => ({
        id: preset.id,
        title: preset.title,
        blurb: preset.blurb,
        durationLabel: preset.durationLabel,
        durationMs: preset.durationMs,
        planningMs: preset.rules?.planningMs ?? 0,
        pvp: Boolean(preset.metadata?.pvp),
        radicalReset: Boolean(preset.metadata?.radicalReset),
        needsFreshWorld: Boolean(preset.metadata?.needsFreshWorld),
        narrator: { ...CONTEST_NARRATOR_CHARACTER },
        defaultCharacters: CONTEST_BOT_CHARACTERS.map(character => ({ ...character })),
    }));
}

export function getContestGamePreset(gameId) {
    const preset = CONTEST_GAME_PRESETS[gameId];
    if (!preset) {
        throw new Error(`Unknown contest game: ${gameId}`);
    }
    return preset;
}

export function getSurvivorSeasonPreset(scenarioId = DEFAULT_SURVIVOR_SCENARIO_ID) {
    const preset = SURVIVOR_SCENARIOS[scenarioId || DEFAULT_SURVIVOR_SCENARIO_ID];
    if (!preset) throw new Error(`Unknown Survivor scenario: ${scenarioId}`);
    return {
        ...preset,
        defaultCharacters: preset.defaultCharacters.map(character => ({ ...character })),
        tribeNames: [...preset.tribeNames],
        phaseDurationsMs: { ...preset.phaseDurationsMs },
        challengeGameIds: [...preset.challengeGameIds],
    };
}

export function listSurvivorScenarios() {
    return Object.keys(SURVIVOR_SCENARIOS).map(scenarioId =>
        getSurvivorSeasonPreset(scenarioId)
    );
}
