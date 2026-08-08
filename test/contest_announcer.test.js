import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ContestAnnouncer,
    buildContestResultAnnouncement,
    buildContestStartAnnouncement,
    buildPlanningAnnouncement,
    describeCompetitor,
} from '../src/mindcraft/contest/contest_announcer.js';

test('builds game start and winner announcements', () => {
    assert.equal(
        buildContestStartAnnouncement({ title: 'Tallest Tower' }),
        'Tallest Tower starting. Three. Two. One. Go!'
    );
    assert.match(
        buildContestStartAnnouncement({
            title: 'Spleef',
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
        }),
        /Spleef\. Match 2 · Bo5 · Billy 1–0 Kimmy\. Three\. Two\. One\. Go!/
    );
    assert.equal(
        buildContestResultAnnouncement({ winnerIds: ['billy'] }),
        'And the winner is... billy! billy wins!'
    );
    assert.equal(
        buildContestResultAnnouncement({ winnerIds: ['billy', 'jane'] }),
        'And the winners are... billy and jane! billy and jane win!'
    );
    assert.equal(
        buildContestResultAnnouncement({ winnerIds: [] }),
        'Game over. There was no winner.'
    );
    assert.equal(
        buildContestResultAnnouncement({
            rules: { type: 'team_tower_battle' },
            winnerIds: ['alice', 'amy'],
            results: [
                { participantId: 'alice', rank: 1, details: { teamName: 'Ember' } },
                { participantId: 'amy', rank: 1, details: { teamName: 'Ember' } },
            ],
        }),
        'And the winning team is... Ember! Ember wins!'
    );
    assert.equal(
        buildContestResultAnnouncement({
            rules: { type: 'cake_race' },
            winnerIds: ['Billy', 'Kimmy', 'Marcus'],
            results: [
                { participantId: 'Billy', rank: 1, details: { teamName: 'Ember' } },
                { participantId: 'Kimmy', rank: 1, details: { teamName: 'Ember' } },
                { participantId: 'Marcus', rank: 1, details: { teamName: 'Ember' } },
                { participantId: 'Dario', rank: 2, details: { teamName: 'Tide' } },
            ],
        }),
        'And the winning team is... Ember! Ember wins!'
    );
    assert.equal(
        buildContestResultAnnouncement({
            rules: { type: 'cake_race' },
            winnerIds: ['Billy'],
            results: [{ participantId: 'Billy', rank: 1 }],
        }),
        'And the winner is... Billy! Billy wins!'
    );
});

test('names the model each winner is running when metadata is present', () => {
    const gameSession = {
        participants: [
            { name: 'billy', model: 'gpt-4o' },
            { name: 'jane', model: { api: 'anthropic', model: 'claude-sonnet-4' } },
        ],
    };
    assert.equal(
        buildContestResultAnnouncement({ winnerIds: ['billy'], metadata: { gameSession } }),
        'And the winner is... billy, playing gpt-4o! billy wins!'
    );
    assert.equal(
        buildContestResultAnnouncement({ winnerIds: ['billy', 'jane'], metadata: { gameSession } }),
        'And the winners are... billy, playing gpt-4o and jane, playing claude-sonnet-4! '
        + 'billy and jane win!'
    );
    // A winner without a stored model still degrades to just the name.
    assert.equal(
        buildContestResultAnnouncement({ winnerIds: ['ghost'], metadata: { gameSession } }),
        'And the winner is... ghost! ghost wins!'
    );
});

test('names the winning team roster and their models', () => {
    assert.equal(
        buildContestResultAnnouncement({
            rules: { type: 'team_tower_battle' },
            winnerIds: ['alice', 'amy'],
            results: [
                { participantId: 'alice', rank: 1, details: { teamName: 'Ember' } },
                { participantId: 'amy', rank: 1, details: { teamName: 'Ember' } },
            ],
            metadata: {
                gameSession: {
                    participants: [
                        { name: 'alice', model: 'gpt-4o' },
                        { name: 'amy', model: 'claude-sonnet-4' },
                    ],
                },
            },
        }),
        'And the winning team is... Ember! Ember wins! '
        + "That's alice, playing gpt-4o and amy, playing claude-sonnet-4."
    );
});

test('describeCompetitor falls back to the bare name without a model', () => {
    assert.equal(describeCompetitor('billy', 'gpt-4o'), 'billy, playing gpt-4o');
    assert.equal(describeCompetitor('billy', null), 'billy');
    assert.equal(describeCompetitor('billy', { api: 'openai', model: 'gpt-4o' }), 'billy, playing gpt-4o');
});

test('opens the planning phase without holding the clock itself', async () => {
    assert.equal(
        buildPlanningAnnouncement({ title: 'Team Tower Battle' }, 45_000),
        'Team Tower Battle. Teams, you have 45 seconds to plan. '
        + 'Captain, call one shared tower base. Assigned attacker, confirm you will destroy the enemy tower. '
        + 'Builders stay home to raise and defend that one structure. Balance offense and defense. No building until the countdown.'
    );
    assert.equal(
        buildPlanningAnnouncement({ title: 'First Cake', rules: { type: 'cake_race' } }, 60_000),
        'First Cake. Teams, you have 60 seconds to plan. '
        + 'Split the ingredients — milk, wheat, sugar cane, and eggs — across your teammates and pick one crafter. '
        + 'First team to bake a cake wins. No gathering until the countdown.'
    );

    const calls = [];
    const announcer = new ContestAnnouncer({
        speak: text => {
            calls.push(['speak', text]);
            return Promise.resolve();
        },
        sleep: ms => {
            calls.push(['sleep', ms]);
            return Promise.resolve();
        },
    });

    await announcer.announcePlanning({ title: 'Team Tower Battle' }, { planningMs: 60_000 });

    assert.deepEqual(calls, [
        [
            'speak',
            'Team Tower Battle. Teams, you have 60 seconds to plan. '
            + 'Captain, call one shared tower base. Assigned attacker, confirm you will destroy the enemy tower. '
            + 'Builders stay home to raise and defend that one structure. Balance offense and defense. No building until the countdown.',
        ],
    ]);
});

test('waits after the spoken countdown before starting play', async () => {
    const calls = [];
    const progress = [];
    const announcer = new ContestAnnouncer({
        startDelayMs: 5000,
        speak: (text, options) => {
            calls.push(['speak', text, options]);
            return Promise.resolve();
        },
        sleep: ms => {
            calls.push(['sleep', ms]);
            return Promise.resolve();
        },
    });

    await announcer.announceStart(
        { title: 'First Dog' },
        { onProgress: detail => progress.push(detail) }
    );
    await announcer.announceResult({ winnerIds: ['billy'] });

    const sleeps = calls.filter(([type]) => type === 'sleep').map(([, ms]) => ms);
    assert.equal(sleeps.reduce((total, ms) => total + ms, 0), 5000);
    assert.deepEqual(
        calls.filter(([type]) => type === 'speak'),
        [
            ['speak', 'First Dog starting. Three. Two. One. Go!', undefined],
            [
                'speak',
                'And the winner is... billy! billy wins!',
                { delivery: 'booming' },
            ],
        ]
    );
    // The wait is broadcast a second at a time so the dashboard can show the
    // pause counting down instead of looking stuck.
    assert.deepEqual(progress, [
        'Speaking the start announcement',
        'Starting in 5…',
        'Starting in 4…',
        'Starting in 3…',
        'Starting in 2…',
        'Starting in 1…',
    ]);
});
