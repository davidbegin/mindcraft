// Does a bot actually read its briefing, or does it vote on vibes?
//
// Every non-challenge directive carries a briefing built from four sources: the
// jury roster, the public council record, the vote history, and the player's own
// private history. Adding more prompt rules is pointless until we know which of
// those four a bot is reading, so this module turns each source into the
// concrete facts it contributed and then checks a bot's own words against them.
//
// The test is deliberately conservative. A reason "echoes" a source only when it
// reproduces something specific that came from that source: a name the source
// defines, or two or more distinctive words from one fact. Vocabulary alone
// ("council", "jury") is recorded separately as a cue, because a bot told to
// "cite council" can say the word without having read a single answer. Only
// echoes count as evidence that the briefing was read.

import { collectCouncilRecord, collectVoteRecord } from './survivor_memory.js';

const STOPWORDS = new Set([
    'about', 'after', 'again', 'against', 'because', 'been', 'before', 'being',
    'between', 'both', 'came', 'come', 'could', 'does', 'doing', 'done', 'down',
    'during', 'each', 'even', 'ever', 'every', 'from', 'gets', 'going', 'gone',
    'good', 'have', 'here', 'himself', 'into', 'just', 'keep', 'kept', 'know',
    'last', 'like', 'll', 'made', 'make', 'many', 'more', 'most', 'much', 'must',
    'need', 'next', 'once', 'only', 'other', 'over', 'own', 'really', 'right',
    'same', 'should', 'since', 'some', 'still', 'such', 'take', 'than', 'that',
    'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'think', 'this',
    'those', 'through', 'time', 'together', 'too', 'under', 'until', 'very',
    'want', 'was', 'well', 'were', 'what', 'when', 'where', 'which', 'while',
    'who', 'whom', 'will', 'with', 'would', 'your', 'yours',
]);

// Vocabulary a bot can produce straight from the phase prompt, so on its own it
// proves nothing about whether the briefing was read.
const SOURCE_CUES = {
    jury: /\b(jury|juror|jurors|bench|final\s+vote)\b/i,
    council: /\b(council|tribal|mat|jeff|on\s+the\s+mat)\b/i,
    votes: /\b(voted|votes|vote|ballot|ballots|round\s*\d+)\b/i,
    private: /\b(private|privately|secret|deal|alliance|promised|whisper)\b/i,
};

export const BRIEFING_SOURCES = Object.freeze(['jury', 'council', 'votes', 'private']);

function words(text) {
    return String(text ?? '').toLowerCase().match(/[a-z0-9']+/g) || [];
}

function distinctiveTerms(text) {
    return [...new Set(
        words(text).filter(word => word.length >= 4 && !STOPWORDS.has(word))
    )];
}

function mentionsName(reasonWords, name) {
    const target = String(name ?? '').toLowerCase();
    return target !== '' && reasonWords.includes(target);
}

// A fact is one thing the briefing told this player, tagged with what it would
// look like if the player repeated it back.
function fact(source, id, summary, { names = [], terms = [] } = {}) {
    return {
        source,
        id,
        summary,
        // Names this fact introduces. Repeating one is evidence only when the
        // source is what defines the name's relevance (a juror, a past voter).
        names: names.filter(Boolean).map(name => String(name).toLowerCase()),
        terms,
    };
}

/**
 * Every concrete fact this player's briefing supplied, grouped by source.
 * Mirrors buildPlayerBriefing() so "present in the briefing" and "measured here"
 * cannot drift apart.
 */
export function collectBriefingFacts(game, playerId, options = {}) {
    const facts = [];
    if (!game?.players?.[playerId]) return facts;

    const jurors = game.juryIds || [];
    if (jurors.length > 0) {
        facts.push(fact('jury', 'jury:roster', `jury is ${jurors.join(', ')}`, {
            names: jurors,
        }));
    }

    const councilRounds = options.councilRounds ?? 6;
    const councils = collectCouncilRecord(game);
    const recentCouncils = councilRounds > 0 ? councils.slice(-councilRounds) : councils;
    for (const council of recentCouncils) {
        for (const question of council.questions) {
            for (const answer of question.answers) {
                facts.push(fact(
                    'council',
                    `council:${council.councilId}:${question.id}:${answer.playerId}`,
                    `${answer.playerId} answered "${answer.answer}"`,
                    { names: [answer.playerId], terms: distinctiveTerms(answer.answer) }
                ));
            }
        }
    }

    for (const record of collectVoteRecord(game)) {
        if (record.kind === 'jury') continue;
        const againstMe = Object.entries(record.ballots)
            .filter(([, targetId]) => targetId === playerId)
            .map(([voterId]) => voterId);
        if (againstMe.length > 0) {
            facts.push(fact(
                'votes',
                `votes:against:${record.round}`,
                `round ${record.round}: ${againstMe.join(', ')} wrote your name`,
                { names: againstMe }
            ));
        }
        const myTarget = record.ballots[playerId];
        if (myTarget) {
            facts.push(fact(
                'votes',
                `votes:cast:${record.round}`,
                `round ${record.round}: you voted ${myTarget}`,
                { names: [myTarget] }
            ));
        }
    }

    // Private history is already filtered to rooms this player sat in; re-derive
    // it the same way so a bot is never credited for a room it was not in.
    const privateLimit = options.privateLineLimit ?? 30;
    const heard = [];
    for (const event of options.privateLog || []) {
        if (event.type === 'room.message') {
            if (!(event.memberIds || []).includes(playerId)) continue;
            heard.push(fact(
                'private',
                `private:message:${event.id ?? heard.length}`,
                `${event.senderId} said "${event.message}" in private`,
                { names: [event.senderId], terms: distinctiveTerms(event.message) }
            ));
            continue;
        }
        if (event.type === 'talk.declined') {
            if (event.requesterId === playerId) {
                heard.push(fact(
                    'private',
                    `private:refused:${event.inviteeId}`,
                    `${event.inviteeId} refused to talk to you`,
                    {
                        names: [event.inviteeId],
                        terms: distinctiveTerms(`refused ${event.reason ?? ''}`),
                    }
                ));
            } else if (event.inviteeId === playerId) {
                heard.push(fact(
                    'private',
                    `private:refusedBy:${event.requesterId}`,
                    `you refused ${event.requesterId}`,
                    { names: [event.requesterId] }
                ));
            }
        }
    }
    facts.push(...heard.slice(-privateLimit));

    return facts;
}

function emptyReport() {
    const sources = {};
    for (const source of BRIEFING_SOURCES) {
        sources[source] = { available: false, echoed: false, cued: false, matched: [] };
    }
    return sources;
}

/**
 * Compare one bot's stated reason against the facts its briefing supplied.
 *
 * `echoed` is the real signal: the reason reproduced specific content from that
 * source. `cued` only means the reason used the source's vocabulary, which the
 * phase prompt alone can supply. `available` says the source had anything to
 * offer, so an unread source can be told apart from an empty one.
 */
export function attributeReason(reason, facts = []) {
    const sources = emptyReport();
    const reasonText = String(reason ?? '');
    const reasonWords = words(reasonText);
    const reasonTerms = new Set(distinctiveTerms(reasonText));

    for (const source of BRIEFING_SOURCES) {
        sources[source].cued = SOURCE_CUES[source].test(reasonText);
    }

    for (const item of facts) {
        const entry = sources[item.source];
        if (!entry) continue;
        entry.available = true;
        // Names carry proof only where the source is what makes the name matter:
        // who is on the jury, who wrote your name down. Anyone can say "Bot3".
        const nameIsEvidence = item.source === 'jury' || item.source === 'votes';
        const namedHit = nameIsEvidence && item.names.some(name => mentionsName(reasonWords, name));
        const termHits = item.terms.filter(term => reasonTerms.has(term));
        if (namedHit || termHits.length >= 2) {
            entry.echoed = true;
            entry.matched.push({
                id: item.id,
                summary: item.summary,
                via: namedHit ? 'name' : 'wording',
                terms: termHits.slice(0, 6),
            });
        }
    }

    return {
        sources,
        // The headline for the drill: which briefing inputs this bot demonstrably read.
        echoedSources: BRIEFING_SOURCES.filter(source => sources[source].echoed),
        ignoredSources: BRIEFING_SOURCES.filter(source =>
            sources[source].available && !sources[source].echoed
        ),
    };
}

/**
 * Roll per-player attributions into the one table the operator actually reads:
 * for each briefing source, how many bots had it and how many proved they used it.
 */
export function summarizeBriefingUse(reports = {}) {
    const summary = {};
    for (const source of BRIEFING_SOURCES) {
        summary[source] = { available: 0, echoed: 0, cuedOnly: 0 };
    }
    const entries = Object.values(reports);
    for (const report of entries) {
        for (const source of BRIEFING_SOURCES) {
            const entry = report?.sources?.[source];
            if (!entry?.available) continue;
            summary[source].available += 1;
            if (entry.echoed) summary[source].echoed += 1;
            else if (entry.cued) summary[source].cuedOnly += 1;
        }
    }
    return { players: entries.length, bySource: summary };
}
