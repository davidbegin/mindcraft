import { CONTEST_NARRATOR_CHARACTER } from './contest_announcer.js';
import {
    CONTEST_BOT_PERSONAS,
    DEFAULT_BOT_MODEL_LINEUP_ID,
    SURVIVOR_EXTRA_PERSONAS,
    SURVIVOR_SEASON_PERSONAS,
    charactersForLineup,
    freezeCharacters,
    survivorVarietyProfileIds,
} from './bot_model_lineups.js';

export {
    ALL_BOT_PERSONAS,
    BOT_MODEL_LINEUPS,
    CONTEST_BOT_PERSONAS,
    DEFAULT_BOT_MODEL_LINEUP_ID,
    SURVIVOR_EXTRA_PERSONAS,
    SURVIVOR_SEASON_PERSONAS,
    charactersForLineup,
    getBotModelLineup,
    listBotModelLineups,
    survivorVarietyProfileIds,
} from './bot_model_lineups.js';

// Default cast = fixed personas + the variety model pack. Swap packs at game
// setup via listBotModelLineups(); edit packs in bot_model_lineups.js.
// Every variety seat is a different family at a quick effort (Carl runs Muse
// Spark via OpenRouter). test/contest_game_presets.test.js checks ids.
export const CONTEST_BOT_CHARACTERS = freezeCharacters(
    charactersForLineup(DEFAULT_BOT_MODEL_LINEUP_ID, {
        personas: CONTEST_BOT_PERSONAS,
        count: CONTEST_BOT_PERSONAS.length,
    })
);

// A Survivor season seats eleven, but only nine model families offer a quick
// effort setting. Rather than seat a bot on a slow reasoning profile, the overflow
// cast reuses luna and terra at their other quick preset, then falls through to
// the two families nothing else uses. A smaller season takes the front of this
// list, so the priciest family sits last and a ten-bot cast skips claude-opus.
export const SURVIVOR_EXTRA_CHARACTERS = freezeCharacters(
    charactersForLineup(DEFAULT_BOT_MODEL_LINEUP_ID, {
        personas: SURVIVOR_EXTRA_PERSONAS,
        count: SURVIVOR_EXTRA_PERSONAS.length,
        profileIds: survivorVarietyProfileIds().slice(7),
    })
);

// The canonical eleven-bot season cast: contest personas minus Carl/Muse, plus
// overflow four. Muse stays contest-only so Survivor seasons stay on Cursor billing.
export const SURVIVOR_SEASON_CAST = freezeCharacters(
    charactersForLineup(DEFAULT_BOT_MODEL_LINEUP_ID, {
        personas: SURVIVOR_SEASON_PERSONAS,
        count: SURVIVOR_SEASON_PERSONAS.length,
        profileIds: survivorVarietyProfileIds(),
    })
);
export const SURVIVOR_SEASON_PRESET = Object.freeze({
    id: 'survivor',
    scenarioId: 'classic',
    title: 'Survivor Bot Season',
    blurb: 'Two tribes face team challenges, secret votes, a merge, and a final-three jury.',
    defaultCharacters: SURVIVOR_SEASON_CAST,
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
        'hot_button',
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
        'hot_button',
    ]),
});

// A compact full-format season: two tribes of three lose one player apiece
// before merging at four, then two individual votes produce a final two. Every
// boot serves on the jury so the finale is decided by the other four players.
export const SURVIVOR_SIX_PLAYER_PRESET = Object.freeze({
    id: 'survivor',
    scenarioId: 'six_player',
    title: 'Survivor Six-Player Test',
    blurb: 'Two tribes of three merge at four, play down to a final two, and face all four eliminated players on the jury.',
    defaultCharacters: Object.freeze(CONTEST_BOT_CHARACTERS.slice(0, 6)),
    castSize: 6,
    minimumPlayers: 6,
    maximumPlayers: 6,
    mergeAt: 4,
    finalistCount: 2,
    juryEligibility: 'all_eliminated',
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
        'cake_race',
        'team_base_siege',
        'spleef',
        'diamond_race',
        'death_race',
    ]),
});

export const SURVIVOR_SCENARIOS = Object.freeze({
    classic: SURVIVOR_SEASON_PRESET,
    four_player: SURVIVOR_FOUR_PLAYER_PRESET,
    six_player: SURVIVOR_SIX_PLAYER_PRESET,
});

export const DEFAULT_SURVIVOR_SCENARIO_ID = 'classic';

export const CONTEST_GAME_PRESETS = Object.freeze({
    cake_race: Object.freeze({
        id: 'cake_race',
        title: 'First Cake',
        blurb: 'Two teams race to gather cake ingredients and craft first.',
        durationLabel: '20 min cap',
        durationMs: 20 * 60_000,
        // Classic six-bot test cast: Billy, Kimmy, Marcus, Dario, Chip, Bridget.
        defaultCharacters: Object.freeze(CONTEST_BOT_CHARACTERS.slice(0, 6)),
        defaultParticipantCount: 6,
        prompt:
            'CONTEST: First Cake. This is a two-team race. Your goal is for YOUR TEAM to craft a cake before the other team does — any teammate crafting the cake wins for everyone on your side. You start with three empty buckets, a crafting table, and food, but none of the cake ingredients. Search the farm arena for cows to milk, chickens laying eggs, mature wheat, and sugar cane. Collect three milk buckets, two sugar, one egg, and three wheat, then use a crafting table to make the cake. Coordinate with teammates: split ingredient routes, share what you find, and craft as soon as your team has a full set. Do not help the enemy team or hand them resources. The game ends automatically the instant the first cake is crafted. State your team plan once, then only announce later changes, handoffs, or discoveries.',
        rules: Object.freeze({
            type: 'cake_race',
            winItem: 'cake',
            teamCount: 2,
            minimumPlayersPerTeam: 3,
            planningMs: 60_000,
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
        blurb: 'Race to die first: sprint off the arena edge before anyone else.',
        durationLabel: '5 min cap',
        durationMs: 5 * 60_000,
        prompt:
            'CONTEST: Self-Destruct Race. First competitor to die wins. PVP is off — a rival killing you is not the plan. Your survival instincts are disabled. Inventory starts empty and you are NOT allowed to spawn, summon, give, fill, or otherwise cheat items, blocks, or mobs into existence. The opening is the same flat plain as other contests. Assess it and take the fastest death the arena already offers: sprint to the outer rim and run off the edge into the lethal drop. Just run. Do not dig, build, craft, or invent slow schemes while a quicker path is right there. Do not help anyone else die first. The match ends the instant the first competitor dies. Say your chosen death route once in one short sentence, then execute in silence unless the attempt fails and you must switch.',
        rules: Object.freeze({
            type: 'death_race',
            scoring: 'first-death-wins',
            metrics: Object.freeze([
                Object.freeze({ path: 'elapsedMs', weight: 1, direction: 'minimize' }),
            ]),
        }),
        metadata: Object.freeze({
            arena: 'death-edge-v1',
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
            'CONTEST: Tallest Tower. You are in a freshly reset flat arena with building blocks, food, and a wooden sword. Build the tallest tower you can before the contest timer expires. PVP is on, but winning takes a balance of offense and defense: keep YOUR tower rising and protected while you disrupt rivals. Do not abandon your own stack for an all-offense sword chase — a short undefended tower loses even if you knock people around. Nothing is submitted: when time runs out we measure every tower still standing and credit each one to whoever placed the most of its blocks, so keep stacking until the clock ends. Highest tower wins. Explain your offense-defense plan once, and only narrate meaningful tactical changes afterward.',
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
            'CONTEST: Team Tower Battle. This is a PVP attack-and-build game that rewards a balance of offense and defense — not an all-team rush. Each team has one dedicated ATTACKER who crosses the arena to fight enemy builders and destroy the enemy tower from its supporting blocks with a pickaxe. Everyone else is a BUILDER-DEFENDER on ONE shared team tower: they raise that tower and fight off enemies who come to tear it down, then repair and keep stacking. Do not send the whole team on offense; an undefended stump loses to a guarded tower every time. Only that single tallest team tower scores, so two separate structures are a failure. During the planning phase before the clock starts, the captain names one base coordinate. Builders regroup at that base and place blocks only when they connect to the captain\'s existing structure; they never place a new foundation on bare ground. The attacker never starts a separate tower. Friendly fire is disabled. If you die, you immediately respawn and keep your inventory, but your team loses five blocks from its final score for every death. At the deadline, each standing tower belongs to the team that placed most of its blocks. Your team score is its highest owned tower minus the death penalty.',
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
    team_base_siege: Object.freeze({
        id: 'team_base_siege',
        title: 'Base Siege',
        blurb: 'Plan, slap up a quick base, then fight. Hide too long and the arena shrinks.',
        durationLabel: '3 min fight',
        durationMs: 3 * 60_000,
        prompt:
            'CONTEST: Base Siege. This is a two-team PVP survival game. After a short planning phase and a short build phase, the fight clock starts. Death eliminates you for good — no respawns that count. The last team with anyone still alive wins. Friendly fire is disabled, so only attack enemies. Balance offense and defense: a small base is useful cover and a place to regroup, but camping forever is punished — if both teams are still alive when the fight timer ends, the arena walls slam inward and combat continues in a tighter space. Hide again and it shrinks again. Do not all charge out empty-handed with no cover, and do not turtle forever; use the fort, then push to finish the other team before the walls close.',
        rules: Object.freeze({
            type: 'team_base_siege',
            pvp: true,
            scoring: 'last-team-standing',
            teamCount: 2,
            minimumPlayersPerTeam: 2,
            planningMs: 30_000,
            buildPhaseMs: 30_000,
            maxPressureRounds: 3,
            shrinkStep: 8,
            minHalfSize: 8,
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
            + '\n\nTHE WHOLE POINT: compete aggressively by making OTHER players fall. Target every rival and remove as much of their usable ground as you can. The last competitor still standing on the snow wins. Falling into the pit loses instantly — and a hole you dug under yourself counts exactly the same as being outplayed.'
            + '\n\nSURVIVAL RULE #1 — PROTECT YOUR OWN FEET: never break the block you are standing on, the eight blocks touching it, or a block you are about to step onto. Digging under yourself is instant self-elimination, so it is never a move, never a shortcut, and never worth a trade. Never dig straight down and never use any dig-down behavior. Never walk, run, jump, or pathfind into or across a hole. Before EVERY dig, confirm the block you are about to break is under or beside a RIVAL — never under you — and that you still have solid snow on all sides of your own feet. When you break blocks, aim at a rival\'s coordinates, not your own position.'
            + '\n\nHOW TO ACTUALLY ELIMINATE A RIVAL: break the snow directly beneath an opponent, then open a hole ahead of a moving rival. Lead moving targets, cut off their escape routes, and carve around stationary targets to isolate them. Keep switching to a reachable rival instead of digging random empty terrain. Read where each rival is heading and dig for where they WILL be, not only where they are.'
            + '\n\nSTAY ALIVE WHILE YOU HUNT: always track where the existing holes are and keep unbroken snow behind you as an escape route. Never back up, flee, or chase in a direction where the floor is missing. If the snow beside you starts vanishing, retreat toward the thickest remaining snow instead of digging more. Patience beats frenzy: a calm hunter outlasts rivals who panic and dig themselves into the pit.'
            + '\n\nThe server automatically starts !playSpleef(100) at the opening bell. That dedicated action continuously hunts rivals for the entire match and refuses to break your own footing, so do not interrupt it with conversations, waiting, generic movement, clearArea, digDown, or one-off block commands.',
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
    hot_button: Object.freeze({
        id: 'hot_button',
        title: 'Hot Button',
        blurb: 'One button per player. All but one explode. Find the safe one and you win instantly.',
        durationLabel: '3 min cap',
        durationMs: 3 * 60_000,
        prompt:
            'CONTEST: Hot Button. There is exactly one stone button station per competitor arranged in a ring. Every station looks the same: a button wired to a pressure plate and TNT. Exactly ONE station is safe, and which one is safe is freshly randomized every match. Every other button blows you up — and anyone standing nearby — and eliminates you for good. Each button is one-shot — once someone presses it, it is gone, so never share a station.'
            + '\n\nTHE WHOLE POINT: walk up, pick an unused button, and press it. The competitor who finds and presses the SAFE button wins the match instantly. If you refuse to press before the timer ends, you lose as a chicken.'
            + '\n\nDo not dig, build, fight, place blocks, or mess with redstone. PVP is off. Weakness is active. Say your chosen station strategy once in one short sentence, then press. The server starts !playHotButton automatically at the opening bell; keep that action running until you explode, win, or the buzzer sounds.',
        rules: Object.freeze({
            type: 'hot_button',
            scoring: 'last-standing',
            winItem: 'nether_star',
        }),
        metadata: Object.freeze({
            arena: 'hot-button-v1',
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
    return Object.values(CONTEST_GAME_PRESETS).map(preset => {
        const teamCount = preset.rules?.teamCount ?? 0;
        const minimumPlayersPerTeam = preset.rules?.minimumPlayersPerTeam ?? 0;
        const characters = preset.defaultCharacters || CONTEST_BOT_CHARACTERS;
        // Prefer an explicit cast size (First Cake's classic six); otherwise seat
        // every default character so a team game still opens as a model variety pack.
        const defaultParticipantCount = preset.defaultParticipantCount ?? characters.length;
        return {
            id: preset.id,
            title: preset.title,
            blurb: preset.blurb,
            durationLabel: preset.durationLabel,
            durationMs: preset.durationMs,
            planningMs: preset.rules?.planningMs ?? 0,
            buildPhaseMs: preset.rules?.buildPhaseMs ?? 0,
            teamCount,
            minimumPlayersPerTeam,
            defaultParticipantCount,
            pvp: Boolean(preset.metadata?.pvp),
            radicalReset: Boolean(preset.metadata?.radicalReset),
            needsFreshWorld: Boolean(preset.metadata?.needsFreshWorld),
            narrator: { ...CONTEST_NARRATOR_CHARACTER },
            defaultCharacters: characters.map(character => ({ ...character })),
        };
    });
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
