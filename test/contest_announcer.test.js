import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ContestAnnouncer,
    buildContestResultAnnouncement,
    buildContestStartAnnouncement,
} from '../src/mindcraft/contest/contest_announcer.js';

test('builds game start and winner announcements', () => {
    assert.equal(
        buildContestStartAnnouncement({ title: 'Tallest Tower' }),
        'Tallest Tower starting. Three. Two. One. Go!'
    );
    assert.equal(
        buildContestResultAnnouncement({ winnerIds: ['billy'] }),
        'billy was the winner!'
    );
    assert.equal(
        buildContestResultAnnouncement({ winnerIds: ['billy', 'jane'] }),
        'billy and jane were the winners!'
    );
    assert.equal(
        buildContestResultAnnouncement({ winnerIds: [] }),
        'Game over. There was no winner.'
    );
});

test('waits after the spoken countdown before starting play', async () => {
    const calls = [];
    const announcer = new ContestAnnouncer({
        startDelayMs: 5000,
        speak: text => {
            calls.push(['speak', text]);
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
        ['speak', 'First Dog starting. Three. Two. One. Go!'],
        ['sleep', 5000],
        ['speak', 'billy was the winner!'],
    ]);
});
