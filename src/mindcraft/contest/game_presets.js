export const CONTEST_BOT_CHARACTERS = Object.freeze([
    Object.freeze({
        name: 'billy',
        voice: 'Giggles',
        profileId: 'gpt-5-6-luna-instant',
    }),
]);

export const CONTEST_GAME_PRESETS = Object.freeze({
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
