import { 
    getPosition,
    getBiomeName,
    getNearbyPlayerNames,
    getInventoryCounts,
    getNearbyEntityTypes,
    getBlockAtPosition,
    getFirstBlockAboveHead
} from "./world.js";
import convoManager from '../conversation.js';
import { getLastModelFailure, getOutage } from '../../models/quota_guard.js';

export function getFullState(agent) {
    const bot = agent.bot;

    const pos = getPosition(bot);
    const position = {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2))
    };

    let weather = 'Clear';
    if (bot.thunderState > 0) weather = 'Thunderstorm';
    else if (bot.rainState > 0) weather = 'Rain';

    let timeLabel = 'Night';
    if (bot.time.timeOfDay < 6000) timeLabel = 'Morning';
    else if (bot.time.timeOfDay < 12000) timeLabel = 'Afternoon';

    const below = getBlockAtPosition(bot, 0, -1, 0).name;
    const legs = getBlockAtPosition(bot, 0, 0, 0).name;
    const head = getBlockAtPosition(bot, 0, 1, 0).name;

    let players = getNearbyPlayerNames(bot);
    let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
    players = players.filter(p => !bots.includes(p));

    const helmet = bot.inventory.slots[5];
    const chestplate = bot.inventory.slots[6];
    const leggings = bot.inventory.slots[7];
    const boots = bot.inventory.slots[8];

    const healthMax = typeof bot.health === 'number'
        ? Math.round(bot.maxHealth ?? 20)
        : 20;
    const hungerMax = 20;
    const yaw = typeof bot.entity?.yaw === 'number'
        ? Number(bot.entity.yaw.toFixed(3))
        : 0;

    const skin = agent.prompter?.profile?.skin
        ? {
            model: agent.prompter.profile.skin.model || null,
            path: agent.prompter.profile.skin.path || null,
            file: agent.prompter.profile.skin.file || null,
            label: agent.prompter.profile.skin.label || null,
            color: agent.prompter.profile.skin.color || null
        }
        : null;

    const selfPromptActive = agent.self_prompter?.isActive?.() === true;
    const selfPromptPaused = agent.self_prompter?.isPaused?.() === true;
    const selfPromptLoop = agent.self_prompter?.isLoopActive?.() === true;
    const selfPromptText = agent.self_prompter?.prompt || '';
    const attention = typeof agent.getAttention === 'function'
        ? agent.getAttention()
        : {
            phase: agent.isIdle() ? 'idle' : 'acting',
            label: agent.isIdle() ? 'Idle' : agent.actions.currentActionLabel,
            available: agent.isIdle(),
        };

    const state = {
        name: agent.name,
        gameplay: {
            position,
            dimension: bot.game.dimension,
            gamemode: bot.game.gameMode,
            health: Math.round(bot.health),
            healthMax,
            hunger: Math.round(bot.food),
            hungerMax,
            biome: getBiomeName(bot),
            weather,
            timeOfDay: bot.time.timeOfDay,
            timeLabel,
            yaw
        },
        action: {
            current: attention.label,
            isIdle: attention.phase === 'idle',
            phase: attention.phase,
            thinking: attention.phase === 'thinking',
            available: attention.available === true,
        },
        selfPrompt: {
            active: selfPromptActive,
            paused: selfPromptPaused,
            loopActive: selfPromptLoop,
            prompt: selfPromptText
        },
        skin,
        surroundings: {
            below,
            legs,
            head,
            firstBlockAboveHead: getFirstBlockAboveHead(bot, null, 32)
        },
        inventory: {
            counts: getInventoryCounts(bot),
            stacksUsed: bot.inventory.items().length,
            totalSlots: bot.inventory.slots.length,
            equipment: {
                helmet: helmet ? helmet.name : null,
                chestplate: chestplate ? chestplate.name : null,
                leggings: leggings ? leggings.name : null,
                boots: boots ? boots.name : null,
                mainHand: bot.heldItem ? bot.heldItem.name : null
            }
        },
        nearby: {
            humanPlayers: players,
            botPlayers: bots,
            entityTypes: getNearbyEntityTypes(bot).filter(t => t !== 'player' && t !== 'item'),
        },
        modes: {
            summary: bot.modes.getMiniDocs()
        },
        model: {
            outage: getOutage(),
            lastError: getLastModelFailure(),
        },
    };

    return state;
}