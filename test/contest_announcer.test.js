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

    await announcer.announceStart({ title: 'First Dog' });
    await announcer.announceResult({ winnerIds: ['billy'] });

    assert.deepEqual(calls, [
        ['speak', 'First Dog starting. Three. Two. One. Go!', undefined],
        ['sleep', 5000],
        [
            'speak',
            'And the winner is... billy! billy wins!',
            { delivery: 'booming' },
        ],
    ]);
});
