import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildSeriesIntermissionAnnouncement,
    buildSeriesResultAnnouncement,
    createSeries,
    formatSeriesLabel,
    formatSeriesScore,
    normalizeBestOf,
    recordMatchResult,
    winsNeeded,
} from '../src/mindcraft/contest/series.js';

test('normalizeBestOf only allows 1, 3, 5, 7', () => {
    assert.equal(normalizeBestOf(3), 3);
    assert.equal(normalizeBestOf('5'), 5);
    assert.equal(normalizeBestOf(7), 7);
    assert.equal(normalizeBestOf(1), 1);
    assert.equal(normalizeBestOf(4), 1);
    assert.equal(normalizeBestOf(null), 1);
    assert.equal(normalizeBestOf(undefined), 1);
});

test('winsNeeded is first to majority', () => {
    assert.equal(winsNeeded(1), 1);
    assert.equal(winsNeeded(3), 2);
    assert.equal(winsNeeded(5), 3);
    assert.equal(winsNeeded(7), 4);
});

test('recordMatchResult awards a point to a sole winner and decides Bo3 at two wins', () => {
    let series = createSeries({ bestOf: 3, participantIds: ['Billy', 'Kimmy'] });
    assert.equal(series.winsNeeded, 2);
    assert.equal(series.matchIndex, 1);

    ({ series } = recordMatchResult(series, {
        contestId: 'm1',
        winnerIds: ['Billy'],
        completedAt: 100,
    }));
    assert.equal(series.scores.Billy, 1);
    assert.equal(series.scores.Kimmy, 0);
    assert.equal(series.matchIndex, 2);
    assert.equal(series.seriesWinnerIds, null);
    assert.equal(series.matches.length, 1);

    const second = recordMatchResult(series, {
        contestId: 'm2',
        winnerIds: ['Billy'],
        completedAt: 200,
    });
    assert.equal(second.decided, true);
    assert.deepEqual(second.series.seriesWinnerIds, ['Billy']);
    assert.equal(second.series.scores.Billy, 2);
    assert.equal(second.series.matchIndex, 2);
});

test('multi-winner matches are draws and award no series point', () => {
    let series = createSeries({ bestOf: 3, participantIds: ['Alice', 'Bob'] });
    const result = recordMatchResult(series, {
        contestId: 'draw-1',
        winnerIds: ['Alice', 'Bob'],
    });
    assert.equal(result.decided, false);
    assert.equal(result.series.scores.Alice, 0);
    assert.equal(result.series.scores.Bob, 0);
    assert.deepEqual(result.series.matches[0].awardedWinnerIds, []);
    assert.equal(result.series.matchIndex, 2);
});

test('formatSeriesScore puts the leader first for two players', () => {
    const series = createSeries({ bestOf: 5, participantIds: ['Billy', 'Kimmy'] });
    series.scores.Kimmy = 2;
    series.scores.Billy = 1;
    assert.equal(formatSeriesScore(series), 'Kimmy 2–1 Billy');
    assert.match(formatSeriesLabel(series), /Match 1 · Bo5 · Kimmy 2–1 Billy/);
});

test('series announcements name the match winner and standings', () => {
    let series = createSeries({ bestOf: 3, participantIds: ['Billy', 'Kimmy'] });
    ({ series } = recordMatchResult(series, {
        contestId: 'm1',
        winnerIds: ['Billy'],
    }));
    assert.match(
        buildSeriesIntermissionAnnouncement(series, ['Billy']),
        /Billy takes match 1.*Series Billy 1–0 Kimmy.*Starting match 2/
    );
    ({ series } = recordMatchResult(series, {
        contestId: 'm2',
        winnerIds: ['Billy'],
    }));
    assert.match(buildSeriesResultAnnouncement(series), /Billy wins the best of 3/);
});
