import { CONTEST_NARRATOR_CHARACTER } from './contest_announcer.js';

export const CONTEST_BOT_CHARACTERS = Object.freeze([
    Object.freeze({
        name: 'billy',
        voice: 'Giggles',
        profileId: 'gpt-5-6-luna-instant',
    }),
]);

export const CONTEST_GAME_PRESETS = Object.freeze({
    death_race: Object.freeze({
        id: 'death_race',
        title: 'First to Die',
        blurb: 'Reverse survival: the first competitor to die wins.',
        durationLabel: '5 min cap',
        durationMs: 5 * 60_000,
        prompt:
            'CONTEST: First to Die. This is reverse survival: your only goal is to be the first competitor to die. PVP is on, and the arena has a lava pit. Seek danger immediately, bait rivals into attacking you, use the arena hazards, and do not help anyone else die before you. The game ends automatically the instant the first competitor dies. Keep saying what risky strategy you are trying and trade playful trash talk with every rival.',
        rules: Object.freeze({
            type: 'death_race',
            scoring: 'first-death-wins',
            metrics: Object.freeze([
                Object.freeze({ path: 'elapsedMs', weight: 1, direction: 'minimize' }),
            ]),
        }),
        metadata: Object.freeze({
            arena: 'death-arena-v1',
            pvp: true,
            radicalReset: true,
            needsFreshWorld: false,
        }),
    }),
    dog_race: Object.freeze({
        id: 'dog_race',
        title: 'First Dog',
        blurb: 'Explore the forest, obtain bones, find a wolf, and tame it first.',
        durationLabel: '20 min cap',
        durationMs: 20 * 60_000,
        prompt:
            'CONTEST: First Dog. Your only goal is to become the first competitor to tame a wolf and get a dog. Explore the forest, obtain what you need through normal survival gameplay, find a wolf, and successfully tame it. You start without bones and must complete the real survival steps yourself. The game ends automatically the instant the first wolf is tamed. Do not help rivals. Move fast, keep saying what you are trying, and trade playful trash talk with every rival.',
        rules: Object.freeze({
            type: 'dog_race',
            winAdvancement: 'minecraft:husbandry/tame_an_animal',
            winEntity: 'wolf',
            metrics: Object.freeze([
                Object.freeze({ path: 'elapsedMs', weight: 1, direction: 'minimize' }),
            ]),
        }),
        metadata: Object.freeze({
            arena: 'dog-forest-v1',
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
            'CONTEST: First Diamond. You are in a freshly reset quarry arena with an iron pickaxe, food, and torches. Dig and search for diamond ore. Do not help rivals. First diamond wins. As you dig, keep saying what mining strategy you are using and trade playful trash talk with every rival.',
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
            'CONTEST: First Netherite. You are in a freshly reset mining arena with an iron pickaxe, two sticks, a crafting table, a furnace, fuel, and four gold ingots. First mine at least three diamonds and craft a diamond pickaxe. Dig into the netherrack layer and use that diamond pickaxe to mine four ancient debris. Smelt the ancient debris into four netherite scraps, then craft one netherite ingot with those scraps and your four gold ingots. First netherite ingot wins. Do not help rivals. Keep saying what step of your strategy you are working on and trade playful trash talk with every rival.',
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
            'CONTEST: Tallest Tower. You are in a freshly reset flat arena with building blocks, food, and a wooden sword. Build the tallest tower you can before the contest timer expires. PVP is on — attack rivals and knock them down. Nothing is submitted: when time runs out we measure every tower still standing and credit each one to whoever placed the most of its blocks, so just keep stacking until the clock ends. Highest tower wins.',
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
    deepest_2_5: Object.freeze({
        id: 'deepest_2_5',
        title: 'Deepest Wins — 2:30',
        blurb: 'Dig as deep as possible before the short timer expires.',
        durationLabel: '2 min 30 sec',
        durationMs: 2.5 * 60_000,
        prompt:
            'CONTEST: Deepest Wins. You have 2 minutes and 30 seconds to get as deep underground as possible. Your Y-coordinate is measured automatically when the timer expires, and the competitor at the lowest Y-coordinate wins. You start at Y=101 above a solid mining field with a diamond pickaxe, ladders, torches, and food. Nothing is submitted: keep digging and make sure you are alive and as low as possible at the buzzer. Do not help rivals. Keep saying what digging strategy you are using and trade playful trash talk with every rival.',
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
            'CONTEST: Deepest Wins. You have 5 minutes to get as deep underground as possible. Your Y-coordinate is measured automatically when the timer expires, and the competitor at the lowest Y-coordinate wins. You start at Y=101 above a solid mining field with a diamond pickaxe, ladders, torches, and food. Nothing is submitted: keep digging and make sure you are alive and as low as possible at the buzzer. Do not help rivals. Keep saying what digging strategy you are using and trade playful trash talk with every rival.',
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
