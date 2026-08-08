import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    diffAgainstKit,
    expandKit,
    parseInventory,
} from '../src/mindcraft/contest/inventory_audit.js';
import {
    buildIntegrityReport,
    classifyOreWin,
    resolveOrePositions,
    scanGeneratedCode,
} from '../src/mindcraft/contest/spawn_detector.js';
import {
    ContestArchive,
    buildGameRecord,
    compareGamesByRecency,
    isInProgressGameStatus,
    summarizeGame,
} from '../src/mindcraft/contest/contest_archive.js';
import {
    ARENA,
    DIAMOND_RACE_ORES,
    verifyParticipantInventories,
} from '../src/mindcraft/contest/arena_manager.js';

// —— inventory_audit ————————————————————————————————————————————————

function inventoryReply(name, items) {
    const slots = Object.entries(items).map(([id, count], index) =>
        `{Slot: ${index}b, id: "minecraft:${id}", Count: ${count}b}`);
    return `${name} has the following entity data: [${slots.join(', ')}]`;
}

test('expandKit folds "item count" lines into a map', () => {
    assert.deepEqual(
        expandKit(['iron_pickaxe 1', 'bread 16', 'torch 32']),
        { iron_pickaxe: 1, bread: 16, torch: 32 }
    );
});

test('parseInventory sums counts and strips the minecraft namespace', () => {
    const text = inventoryReply('Billy', { iron_pickaxe: 1, bread: 16, torch: 32 });
    assert.deepEqual(parseInventory(text), { iron_pickaxe: 1, bread: 16, torch: 32 });
});

test('parseInventory reads an empty inventory as nothing', () => {
    assert.deepEqual(parseInventory('Billy has the following entity data: []'), {});
});

test('diffAgainstKit flags surplus and shortfall', () => {
    const actual = { iron_pickaxe: 1, bread: 16, torch: 32, diamond: 1 };
    const diff = diffAgainstKit(actual, ['iron_pickaxe 1', 'bread 16', 'torch 32']);
    assert.equal(diff.matches, false);
    assert.deepEqual(diff.extras, [{ item: 'diamond', count: 1 }]);
    assert.deepEqual(diff.missing, []);

    const short = diffAgainstKit({ iron_pickaxe: 1 }, ['iron_pickaxe 1', 'bread 16']);
    assert.equal(short.matches, false);
    assert.deepEqual(short.missing, [{ item: 'bread', count: 16 }]);
});

test('diffAgainstKit passes an exact kit', () => {
    const diff = diffAgainstKit(
        { iron_pickaxe: 1, bread: 16, torch: 32 },
        ['iron_pickaxe 1', 'bread 16', 'torch 32']
    );
    assert.equal(diff.matches, true);
    assert.deepEqual(diff.extras, []);
    assert.deepEqual(diff.missing, []);
});

// —— verifyParticipantInventories (with a repair pass) ————————————————

test('verifyParticipantInventories re-kits a dirty inventory once and re-checks', async () => {
    const readsByPlayer = new Map();
    const issued = [];
    const runCommand = async command => {
        issued.push(command);
        const match = command.match(/^data get entity (\w+) Inventory$/);
        if (match) {
            const name = match[1];
            const count = (readsByPlayer.get(name) || 0) + 1;
            readsByPlayer.set(name, count);
            // First read: a stowaway diamond. After the repair: the clean kit.
            return count === 1
                ? inventoryReply(name, { iron_pickaxe: 1, bread: 16, torch: 32, diamond: 1 })
                : inventoryReply(name, { iron_pickaxe: 1, bread: 16, torch: 32 });
        }
        return '';
    };

    const audits = await verifyParticipantInventories(runCommand, 'diamond_race', ['Billy']);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].participantId, 'Billy');
    assert.equal(audits[0].repaired, true);
    assert.equal(audits[0].matches, true);
    // The repair cleared and re-gave the kit.
    assert.ok(issued.includes('clear Billy'));
    assert.ok(issued.includes('give Billy iron_pickaxe 1'));
});

// —— spawn_detector ——————————————————————————————————————————————————

test('scanGeneratedCode catches item-spawning intent', () => {
    assert.deepEqual(scanGeneratedCode('await bot.chat("/give @s diamond 64");'), ['/give command']);
    assert.deepEqual(scanGeneratedCode('bot.chat(`/setblock ~ ~ ~ diamond_ore`)'), ['/setblock command']);
    assert.deepEqual(scanGeneratedCode('await skills.collectBlock(bot, "diamond_ore");'), []);
});

test("classifyOreWin calls Billy's y=83 diamond a legitimate mine", () => {
    const ores = resolveOrePositions(DIAMOND_RACE_ORES, { x: ARENA.centerX, z: ARENA.centerZ });
    // The real journalled win position from the game in question.
    const result = classifyOreWin({ x: 99994.49, y: 83, z: 100011.7 }, ores);
    assert.equal(result.checked, true);
    assert.equal(result.legitimate, true);
    assert.ok(result.distance < 2);
});

test('classifyOreWin flags a diamond with no ore anywhere near it', () => {
    const ores = resolveOrePositions(DIAMOND_RACE_ORES, { x: ARENA.centerX, z: ARENA.centerZ });
    const result = classifyOreWin({ x: ARENA.centerX, y: 140, z: ARENA.centerZ }, ores);
    assert.equal(result.checked, true);
    assert.equal(result.legitimate, false);
});

test('buildIntegrityReport gathers every signal', () => {
    const report = buildIntegrityReport({
        codeFindings: [{ participantId: 'Cheater', hits: ['/give command'], files: ['3.js'] }],
        inventoryExtras: [{ participantId: 'Cheater', extras: [{ item: 'diamond', count: 1 }] }],
        cheatParticipants: ['Cheater'],
        oreWin: { checked: true, legitimate: false, distance: 40, nearestOre: { x: 0, y: 0, z: 0 } },
        winnerId: 'Cheater',
    });
    assert.equal(report.clean, false);
    const kinds = report.flags.map(flag => flag.kind).sort();
    assert.deepEqual(kinds, ['cheat-mode', 'generated-code', 'inventory-extra', 'off-ore-win']);
});

test('buildIntegrityReport is clean when nothing is wrong', () => {
    const report = buildIntegrityReport({
        codeFindings: [],
        inventoryExtras: [],
        cheatParticipants: [],
        oreWin: { checked: true, legitimate: true, distance: 1, nearestOre: { x: 0, y: 0, z: 0 } },
        winnerId: 'Billy',
    });
    assert.equal(report.clean, true);
    assert.deepEqual(report.flags, []);
});

// —— buildGameRecord ————————————————————————————————————————————————

function diamondSnapshot(overrides = {}) {
    return {
        id: 'game-1',
        title: 'First Diamond',
        status: 'completed',
        participantIds: ['Billy', 'Rival'],
        startedAt: 1000,
        completedAt: 5000,
        winnerIds: ['Billy'],
        rules: { winItem: 'diamond' },
        submissions: {
            Billy: {
                participantId: 'Billy',
                payload: { item: 'diamond', elapsedMs: 4000, position: { x: 99994, y: 83, z: 100011 } },
            },
        },
        metadata: {
            gameId: 'diamond_race',
            startedFrom: 'game-session-ui',
            gameSession: {
                participants: [
                    { name: 'Billy', model: 'grok-4.5', provider: 'cursor' },
                    { name: 'Rival', model: 'gpt', provider: 'openai' },
                ],
            },
        },
        ...overrides,
    };
}

test('buildGameRecord assembles transcript, winner and a clean verdict for a mined diamond', () => {
    const events = [
        { type: 'contest.started', at: 1000, contestId: 'game-1' },
        { type: 'message.said', at: 1500, contestId: 'game-1', participantId: 'Billy', text: 'Digging a staircase down.', position: { x: 100000, y: 90, z: 100000 } },
        { type: 'message.said', at: 3900, contestId: 'game-1', participantId: 'Billy', text: 'Diamonds!', position: { x: 99994, y: 83, z: 100011 } },
        { type: 'inventory.audit', at: 1100, contestId: 'game-1', participantId: 'Billy', matches: true, extras: [], missing: [], expected: { iron_pickaxe: 1 }, actual: { iron_pickaxe: 1 } },
        { type: 'inventory.audit', at: 1100, contestId: 'game-1', participantId: 'Rival', matches: true, extras: [], missing: [] },
        { type: 'winner.detected', at: 4000, contestId: 'game-1', participantId: 'Billy', payload: { item: 'diamond' } },
    ];
    const game = buildGameRecord({ id: 'game-1', events, snapshot: diamondSnapshot() });

    assert.equal(game.winnerId, 'Billy');
    assert.equal(game.winItem, 'diamond');
    assert.equal(game.messageCount, 2);
    assert.equal(game.messages[0].text, 'Digging a staircase down.');
    assert.equal(game.allInventoriesClean, true);
    assert.equal(game.integrity.clean, true);
    assert.equal(game.integrity.oreWin.legitimate, true);

    const summary = summarizeGame(game);
    assert.equal(summary.integrityClean, true);
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.winItem, 'diamond');
});

test('buildGameRecord flags an off-ore diamond and a dirty inventory', () => {
    const snapshot = diamondSnapshot();
    snapshot.submissions.Billy.payload.position = { x: 100000, y: 140, z: 100000 };
    const events = [
        { type: 'inventory.audit', at: 1100, contestId: 'game-1', participantId: 'Billy', matches: false, extras: [{ item: 'diamond', count: 1 }], missing: [] },
    ];
    const game = buildGameRecord({ id: 'game-1', events, snapshot });
    assert.equal(game.integrity.clean, false);
    const kinds = game.integrity.flags.map(flag => flag.kind).sort();
    assert.ok(kinds.includes('off-ore-win'));
    assert.ok(kinds.includes('inventory-extra'));
    assert.equal(game.allInventoriesClean, false);
});

// —— ContestArchive (disk round-trip) ————————————————————————————————

test('ContestArchive reads games from a journal and state file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'contest-archive-'));
    try {
        const state = {
            version: 1,
            activeContestId: null,
            contests: { 'game-1': diamondSnapshot() },
        };
        const journalLines = [
            { at: 1500, type: 'message.said', data: { contestId: 'game-1', participantId: 'Billy', text: 'Hello', position: null } },
            { at: 1100, type: 'inventory.audit', data: { contestId: 'game-1', participantId: 'Billy', matches: true, extras: [], missing: [] } },
            // A survivor-style contest with no game id is ignored by the games archive.
            { at: 1200, type: 'season.started', data: { seasonId: 'season-1' } },
        ].map(entry => JSON.stringify(entry)).join('\n');
        await writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
        await writeFile(path.join(dir, 'journal.jsonl'), `${journalLines}\n`);

        const archive = new ContestArchive({ root: dir });
        const list = await archive.list();
        assert.equal(list.length, 1);
        assert.equal(list[0].id, 'game-1');
        assert.equal(list[0].messageCount, 1);

        const game = await archive.get('game-1');
        assert.equal(game.messages[0].text, 'Hello');
        assert.equal(game.integrity.clean, true);
        assert.equal(await archive.get('missing'), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('draft games sort above finished ones and summarize as in progress', () => {
    const draft = buildGameRecord({
        id: 'draft-1',
        events: [
            {
                type: 'message.said',
                at: 500,
                contestId: 'draft-1',
                participantId: 'Billy',
                text: 'Split the milk route.',
            },
        ],
        snapshot: {
            id: 'draft-1',
            title: 'First Cake',
            status: 'draft',
            createdAt: 400,
            startedAt: null,
            participantIds: ['Billy', 'Kimmy'],
            metadata: { gameId: 'cake_race', startedFrom: 'game-session-ui' },
            winnerIds: [],
            submissions: {},
            results: [],
        },
    });
    const finished = buildGameRecord({
        id: 'game-1',
        events: [],
        snapshot: diamondSnapshot(),
    });

    assert.equal(isInProgressGameStatus(draft.status), true);
    assert.equal(draft.endedAt, null);
    assert.equal(draft.startedAt, 400);
    assert.equal(draft.messageCount, 1);

    const summary = summarizeGame(draft);
    assert.equal(summary.inProgress, true);
    assert.equal(summary.messageCount, 1);

    const ordered = [finished, draft].sort(compareGamesByRecency);
    assert.equal(ordered[0].id, 'draft-1');
    assert.equal(ordered[1].id, 'game-1');
});
