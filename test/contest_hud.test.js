import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ContestHud,
    formatContestBossbar,
    formatContestScore,
    formatContestTime,
} from '../src/mindcraft/contest/contest_hud.js';

function runningContest(overrides = {}) {
    return {
        id: 'game-1',
        title: 'Tallest Tower',
        durationMs: 60_000,
        deadlineAt: 70_000,
        status: 'running',
        participantIds: ['alice', 'bob'],
        rules: { type: 'tower_battle' },
        results: [],
        winnerIds: [],
        ...overrides,
    };
}

test('formats first-cake bossbar from team pantry progress', () => {
    const contest = runningContest({
        title: 'First Cake',
        rules: { type: 'cake_race', winItem: 'cake' },
    });
    assert.equal(
        formatContestScore(contest, {
            score: 6,
            details: {
                teamName: 'Ember',
                gathered: 6,
                needed: 9,
                hasCake: false,
                ingredients: [
                    { item: 'milk_bucket', label: 'Milk', have: 2, need: 3 },
                    { item: 'sugar', label: 'Sugar', have: 1, need: 2 },
                    { item: 'egg', label: 'Egg', have: 1, need: 1 },
                    { item: 'wheat', label: 'Wheat', have: 2, need: 3 },
                ],
            },
        }),
        '6/9 (M2/3 S1/2 E1/1 W2/3)'
    );
    assert.equal(
        formatContestBossbar(
            contest,
            {
                participantId: 'Ember',
                score: 6,
                details: {
                    summary: 'Ember 6/9 (M2/3 S1/2 E1/1 W2/3) · Tide 2/9 (M1/3 S0/2 E1/1 W0/3)',
                },
            },
            10_000
        ),
        'First Cake · 1:00 · Ember 6/9 (M2/3 S1/2 E1/1 W2/3) · Tide 2/9 (M1/3 S0/2 E1/1 W0/3)'
    );
});

test('Spleef series standings appear on the bossbar title', () => {
    const contest = runningContest({
        title: 'Spleef',
        rules: { type: 'spleef', scoring: 'last-standing', floorY: 100 },
        metadata: {
            series: {
                bestOf: 5,
                winsNeeded: 3,
                matchIndex: 2,
                scores: { Billy: 1, Kimmy: 0 },
                matches: [],
                seriesWinnerIds: null,
            },
        },
    });
    assert.match(
        formatContestBossbar(contest, null, 10_000),
        /Spleef · Match 2 · Bo5 · Billy 1–0 Kimmy · 1:00/
    );
});

test('formats the countdown and game-specific scores', () => {
    const contest = runningContest();
    assert.equal(formatContestTime(60_001), '1:01');
    assert.equal(formatContestTime(-1), '0:00');
    assert.equal(formatContestScore(contest, { score: 23 }), '23 blocks');
    assert.equal(
        formatContestBossbar(contest, { participantId: 'alice', score: 23 }, 10_000),
        'Tallest Tower · 1:00 · Leader: alice (23 blocks)'
    );
    assert.equal(
        formatContestScore(
            runningContest({ rules: { type: 'depth_race' } }),
            { score: 40.5 }
        ),
        '40.5 blocks deep'
    );
    assert.equal(
        formatContestScore(
            runningContest({ rules: { type: 'team_tower_battle' } }),
            {
                score: 17,
                details: { towerHeight: 27, deathPenalty: 10 },
            }
        ),
        '27 - 10 = 17 blocks'
    );
});

test('announces a game and maintains a bossbar with timer and leader', async () => {
    let now = 10_000;
    const commands = [];
    const contest = runningContest();
    const hud = new ContestHud({
        clock: () => now,
        leaderRefreshMs: 10_000,
        getLeader: async () => ({ participantId: 'alice', score: 23 }),
        runCommand: async command => commands.push(command),
    });

    await hud.sync({ activeContest: contest, contests: [contest] });
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(commands.includes('bossbar add mindcraft:contest {"text":"Tallest Tower","color":"gold","bold":true}'));
    assert.ok(commands.some(command => command.includes('title @a title {"text":"GAME ON!"')));
    assert.ok(commands.some(command => command.includes('Tallest Tower · 1:00 · No leader yet')));

    now = 11_000;
    await hud.sync({ activeContest: contest, contests: [contest] });

    assert.ok(commands.includes('bossbar set mindcraft:contest value 59'));
    assert.ok(commands.some(command => command.includes('Leader: alice (23 blocks)')));
});

test('makes the final ten seconds visually and audibly urgent', async () => {
    const commands = [];
    const contest = runningContest({ deadlineAt: 19_000 });
    const hud = new ContestHud({
        clock: () => 10_000,
        runCommand: async command => commands.push(command),
    });

    await hud.sync({ activeContest: contest, contests: [contest] });

    assert.ok(commands.some(command =>
        command.includes('title @a actionbar {"text":"9 SECONDS!"')
    ));
    assert.ok(commands.some(command => command.startsWith('playsound block.note_block.hat')));
});

test('announces ranked winners and removes the bossbar', async () => {
    const commands = [];
    const contest = runningContest();
    const hud = new ContestHud({
        clock: () => 10_000,
        runCommand: async command => commands.push(command),
    });
    await hud.sync({ activeContest: contest, contests: [contest] });
    commands.length = 0;

    const completed = {
        ...contest,
        status: 'completed',
        winnerIds: ['bob'],
        results: [
            { participantId: 'bob', score: 31, rank: 1 },
            { participantId: 'alice', score: 23, rank: 2 },
        ],
    };
    await hud.sync({ activeContest: null, contests: [completed] });

    assert.equal(commands[0], 'bossbar remove mindcraft:contest');
    assert.ok(commands.some(command => command.includes('title @a title {"text":"WINNER!"')));
    assert.ok(commands.some(command => command.includes('bob · 31 blocks')));
    assert.ok(commands.some(command => command.includes('1. bob — 31 blocks')));
});

test('celebrates the first competitor to craft a cake', async () => {
    const commands = [];
    const contest = runningContest({
        title: 'First Cake',
        rules: { type: 'cake_race', winItem: 'cake' },
    });
    const hud = new ContestHud({
        clock: () => 10_000,
        runCommand: command => Promise.resolve(commands.push(command)),
    });
    await hud.sync({ activeContest: contest, contests: [contest] });
    commands.length = 0;

    const completed = {
        ...contest,
        status: 'completed',
        winnerIds: ['alice'],
        submissions: {
            alice: {
                payload: {
                    position: { x: 100012.5, y: 74, z: 99991.5 },
                },
            },
        },
        results: [
            { participantId: 'alice', score: -18_000, rank: 1 },
            { participantId: 'bob', score: 0, rank: null, disqualified: true },
        ],
    };
    assert.equal(formatContestScore(completed, completed.results[0]), 'cake crafted');
    await hud.sync({ activeContest: null, contests: [completed] });

    assert.ok(commands.some(command =>
        command.includes('title @a title {"text":"CAKE CRAFTED!","color":"light_purple"')
    ));
    assert.ok(commands.some(command =>
        command.includes('"alice WINS! · X 100012.5 · Y 74 · Z 99991.5"')
    ));
    assert.ok(commands.some(command => command.includes('1. alice — cake crafted')));
});

test('celebrates an automatic diamond-race winner', async () => {
    const commands = [];
    const contest = runningContest({
        title: 'First Diamond',
        rules: { type: 'diamond_race', winItem: 'diamond' },
    });
    const hud = new ContestHud({
        clock: () => 10_000,
        runCommand: async command => commands.push(command),
    });
    await hud.sync({ activeContest: contest, contests: [contest] });
    commands.length = 0;

    const completed = {
        ...contest,
        status: 'completed',
        winnerIds: ['alice'],
        submissions: {
            alice: {
                payload: {
                    position: { x: 100012.5, y: 74, z: 99991.5 },
                },
            },
        },
        results: [
            { participantId: 'alice', score: -12_000, rank: 1 },
            { participantId: 'bob', score: 0, rank: null, disqualified: true },
        ],
    };
    await hud.sync({ activeContest: null, contests: [completed] });

    assert.ok(commands.some(command =>
        command.includes('title @a title {"text":"DIAMOND FOUND!","color":"aqua"')
    ));
    assert.ok(commands.some(command =>
        command.includes('"alice WINS! · X 100012.5 · Y 74 · Z 99991.5"')
    ));
    assert.ok(commands.some(command =>
        command.startsWith('playsound entity.firework_rocket.large_blast')
    ));
    assert.ok(commands.some(command =>
        command.startsWith('playsound entity.player.levelup')
    ));
});

test('celebrates an automatic netherite-race winner', async () => {
    const commands = [];
    const contest = runningContest({
        title: 'First Netherite',
        rules: { type: 'netherite_race', winItem: 'netherite_ingot' },
    });
    const hud = new ContestHud({
        clock: () => 10_000,
        runCommand: async command => commands.push(command),
    });
    await hud.sync({ activeContest: contest, contests: [contest] });
    commands.length = 0;

    const completed = {
        ...contest,
        status: 'completed',
        winnerIds: ['bob'],
        results: [
            { participantId: 'bob', score: -20_000, rank: 1 },
            { participantId: 'alice', score: 0, rank: null, disqualified: true },
        ],
    };
    assert.equal(formatContestScore(completed, completed.results[0]), 'netherite forged');
    await hud.sync({ activeContest: null, contests: [completed] });

    assert.ok(commands.some(command =>
        command.includes('title @a title {"text":"NETHERITE FORGED!","color":"dark_purple"')
    ));
    assert.ok(commands.some(command => command.includes('"bob WINS!"')));
    assert.ok(commands.some(command => command.includes('1. bob — netherite forged')));
});

test('celebrates an automatic dog-race winner', async () => {
    const commands = [];
    const contest = runningContest({
        title: 'First Dog',
        rules: { type: 'dog_race', winEntity: 'wolf' },
    });
    const hud = new ContestHud({
        clock: () => 10_000,
        runCommand: async command => commands.push(command),
    });
    await hud.sync({ activeContest: contest, contests: [contest] });
    commands.length = 0;

    const completed = {
        ...contest,
        status: 'completed',
        winnerIds: ['alice'],
        results: [
            { participantId: 'alice', score: -15_000, rank: 1 },
            { participantId: 'bob', score: 0, rank: null, disqualified: true },
        ],
    };
    assert.equal(formatContestScore(completed, completed.results[0]), 'dog tamed');
    await hud.sync({ activeContest: null, contests: [completed] });

    assert.ok(commands.some(command =>
        command.includes('title @a title {"text":"DOG TAMED!","color":"gold"')
    ));
    assert.ok(commands.some(command => command.includes('"alice WINS!"')));
    assert.ok(commands.some(command => command.includes('1. alice — dog tamed')));
});

test('celebrates a Hot Button safe-button winner', async () => {
    const commands = [];
    const contest = runningContest({
        title: 'Hot Button',
        rules: { type: 'hot_button', scoring: 'last-standing', winItem: 'nether_star' },
    });
    const hud = new ContestHud({
        clock: () => 10_000,
        runCommand: async command => commands.push(command),
    });
    await hud.sync({ activeContest: contest, contests: [contest] });
    commands.length = 0;

    const completed = {
        ...contest,
        status: 'completed',
        winnerIds: ['alice'],
        results: [
            {
                participantId: 'alice',
                score: 2_000_005_000,
                rank: 1,
                details: { surviving: true, pressed: true, chicken: false },
            },
            {
                participantId: 'bob',
                score: 1_000,
                rank: 2,
                details: { surviving: false, pressed: true, survivedMs: 4_000 },
            },
        ],
    };
    await hud.sync({ activeContest: null, contests: [completed] });

    assert.ok(commands.some(command =>
        command.includes('title @a title {"text":"SAFE BUTTON!","color":"gold"')
    ));
    assert.ok(commands.some(command => command.includes('"alice WINS!"')));
    assert.ok(commands.some(command =>
        command.startsWith('playsound entity.firework_rocket.large_blast')
    ));
});

test('celebrates the first competitor to die', async () => {
    const commands = [];
    const contest = runningContest({
        title: 'First to Die',
        rules: { type: 'death_race', scoring: 'first-death-wins' },
    });
    const hud = new ContestHud({
        clock: () => 10_000,
        runCommand: async command => commands.push(command),
    });
    await hud.sync({ activeContest: contest, contests: [contest] });
    commands.length = 0;

    const completed = {
        ...contest,
        status: 'completed',
        winnerIds: ['bob'],
        results: [
            { participantId: 'bob', score: -9_000, rank: 1 },
            { participantId: 'alice', score: 0, rank: null, disqualified: true },
        ],
    };
    assert.equal(formatContestScore(completed, completed.results[0]), 'died first');
    await hud.sync({ activeContest: null, contests: [completed] });

    assert.ok(commands.some(command =>
        command.includes('title @a title {"text":"FIRST DEATH!","color":"red"')
    ));
    assert.ok(commands.some(command => command.includes('"bob WINS!"')));
    assert.ok(commands.some(command => command.includes('1. bob — died first')));
});

test('cleans up the HUD and explains cancellation', async () => {
    const commands = [];
    const contest = runningContest();
    const hud = new ContestHud({
        clock: () => 10_000,
        runCommand: async command => commands.push(command),
    });
    await hud.sync({ activeContest: contest, contests: [contest] });
    commands.length = 0;

    const cancelled = {
        ...contest,
        status: 'cancelled',
        cancellationReason: 'Stopped by host',
    };
    await hud.sync({ activeContest: null, contests: [cancelled] });

    assert.ok(commands.includes('bossbar remove mindcraft:contest'));
    assert.ok(commands.some(command => command.includes('GAME CANCELLED')));
    assert.ok(commands.some(command => command.includes('Stopped by host')));
});
