import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ContestAnnouncer,
    buildContestResultAnnouncement,
    buildContestStartAnnouncement,
    buildPlanningAnnouncement,
} from '../src/mindcraft/contest/contest_announcer.js';

test('builds game start and winner announcements', () => {
    assert.equal(
        buildContestStartAnnouncement({ title: 'Tallest Tower' }),
        'Tallest Tower starting. Three. Two. One. Go!'
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

test('opens the planning phase without holding the clock itself', async () => {
    assert.equal(
        buildPlanningAnnouncement({ title: 'Team Tower Battle' }, 45_000),
        'Team Tower Battle. Teams, you have 45 seconds to plan. '
        + 'Captain, call one shared tower base. Assigned attacker, confirm you will destroy the enemy tower. '
        + 'All builders use only the captain\'s structure. No building until the countdown.'
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
            + 'All builders use only the captain\'s structure. No building until the countdown.',
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
