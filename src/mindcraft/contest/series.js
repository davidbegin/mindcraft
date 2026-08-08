/** Allowed best-of lengths for Spleef match series. */
export const ALLOWED_BEST_OF = Object.freeze([1, 3, 5, 7]);

export function normalizeBestOf(value) {
    const n = Number(value);
    return ALLOWED_BEST_OF.includes(n) ? n : 1;
}

export function winsNeeded(bestOf) {
    return Math.ceil(normalizeBestOf(bestOf) / 2);
}

export function createSeries({ bestOf = 1, participantIds = [] } = {}) {
    const normalized = normalizeBestOf(bestOf);
    const scores = Object.fromEntries(
        (participantIds || [])
            .map(id => String(id || '').trim())
            .filter(Boolean)
            .map(id => [id, 0])
    );
    return {
        bestOf: normalized,
        winsNeeded: winsNeeded(normalized),
        matchIndex: 1,
        scores,
        matches: [],
        seriesWinnerIds: null,
    };
}

function cloneSeries(series) {
    return JSON.parse(JSON.stringify(series));
}

/**
 * Apply one completed match to the series scoreboard.
 * Exactly one winner awards a point; multi-winner ties and empty winners are draws.
 */
export function recordMatchResult(series, {
    contestId,
    winnerIds = [],
    completedAt = Date.now(),
} = {}) {
    if (!series || typeof series !== 'object') {
        throw new TypeError('series is required');
    }
    const next = cloneSeries(series);
    const winners = [...new Set(
        (Array.isArray(winnerIds) ? winnerIds : [])
            .map(id => String(id || '').trim())
            .filter(Boolean)
    )];
    const awardedWinnerIds = winners.length === 1 ? winners : [];
    for (const id of awardedWinnerIds) {
        if (!(id in next.scores)) next.scores[id] = 0;
        next.scores[id] += 1;
    }
    next.matches.push({
        contestId: contestId ?? null,
        winnerIds: winners,
        awardedWinnerIds,
        completedAt: Number.isFinite(completedAt) ? completedAt : Date.now(),
    });

    const leaders = Object.entries(next.scores)
        .filter(([, wins]) => wins >= next.winsNeeded)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const decided = leaders.length > 0;
    if (decided) {
        const topScore = leaders[0][1];
        next.seriesWinnerIds = leaders
            .filter(([, wins]) => wins === topScore)
            .map(([id]) => id);
    } else {
        next.seriesWinnerIds = null;
        next.matchIndex = (Number(next.matchIndex) || 1) + 1;
    }
    return { series: next, decided };
}

/** Compact score line for HUD / status: "Billy 1–0 Kimmy" or "Billy 2, Kimmy 1, Marcus 0". */
export function formatSeriesScore(series) {
    if (!series?.scores || typeof series.scores !== 'object') return '';
    const entries = Object.entries(series.scores)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    if (entries.length === 0) return '';
    if (entries.length === 2) {
        const [[leftName, leftWins], [rightName, rightWins]] = entries;
        // Keep roster order stable for 1v1 when tied: alphabetical by name for the dash form
        // looks odd if the trailing player is ahead — prefer higher score on the left.
        return `${leftName} ${leftWins}–${rightWins} ${rightName}`;
    }
    return entries.map(([name, wins]) => `${name} ${wins}`).join(', ');
}

export function formatSeriesLabel(series) {
    if (!series || !(series.bestOf > 1)) return '';
    const score = formatSeriesScore(series);
    const match = `Match ${series.matchIndex || 1}`;
    const best = `Bo${series.bestOf}`;
    return score ? `${match} · ${best} · ${score}` : `${match} · ${best}`;
}

/** Spoken line between matches when the series is still open. */
export function buildSeriesIntermissionAnnouncement(series, matchWinnerIds = []) {
    const winners = (Array.isArray(matchWinnerIds) ? matchWinnerIds : []).filter(Boolean);
    const matchNumber = Math.max(1, (Number(series?.matches?.length) || 1));
    const nextMatch = Number(series?.matchIndex) || matchNumber + 1;
    const score = formatSeriesScore(series);
    let opener;
    if (winners.length === 1) {
        opener = `${winners[0]} takes match ${matchNumber}.`;
    } else if (winners.length > 1) {
        opener = `Match ${matchNumber} ends in a draw. No series point awarded.`;
    } else {
        opener = `Match ${matchNumber} ends with no winner.`;
    }
    const standings = score ? ` Series ${score}.` : '';
    return `${opener}${standings} Starting match ${nextMatch}.`;
}

/** Spoken line when the series is decided (after the final match result). */
export function buildSeriesResultAnnouncement(series) {
    const winners = Array.isArray(series?.seriesWinnerIds)
        ? series.seriesWinnerIds.filter(Boolean)
        : [];
    const score = formatSeriesScore(series);
    const scoreBit = score ? ` Final series ${score}.` : '';
    if (winners.length === 1) {
        return `${winners[0]} wins the best of ${series.bestOf}!${scoreBit}`;
    }
    if (winners.length > 1) {
        return `The series ends in a tie between ${winners.join(' and ')}.${scoreBit}`;
    }
    return `Series over.${scoreBit}`.trim();
}
