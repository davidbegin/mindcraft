// Post-season analysis: every Survivor season that has ever run, rebuilt from
// what is on disk.
//
// Two sources feed this. The journal is the append-only record of every event of
// every season, with the timestamps attached; seasons/<id>.json is the final
// state snapshot filed when a season ends. The journal alone is enough to
// reconstruct a season, and the snapshot is used where it is richer (a cast
// list for seasons that ran before the opening events were journaled, final
// placements, the authoritative status).
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { applyRefusalEvent, applyRoomEvent } from './survivor_threads.js';

const PRIVATE_PREFIX = 'private.';
// A receipt that a sealed ballot landed. The reveal carries who it was for, so
// keeping these in the timeline would only pad it with rows that say nothing.
const TIMELINE_NOISE = Object.freeze(['ballot.cast']);

function clone(value) {
    return value === null || value === undefined
        ? value
        : JSON.parse(JSON.stringify(value));
}

// A torn final line (a crash mid-append) is skipped rather than throwing away
// every season that came before it.
export function parseJournal(contents) {
    const entries = [];
    for (const line of String(contents ?? '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const entry = JSON.parse(trimmed);
            if (typeof entry?.type === 'string') entries.push(entry);
        } catch {
            continue;
        }
    }
    return entries;
}

function splitEntries(entries) {
    const buckets = new Map();
    const bucketFor = seasonId => {
        if (!buckets.has(seasonId)) {
            buckets.set(seasonId, { id: seasonId, publicEvents: [], privateEvents: [] });
        }
        return buckets.get(seasonId);
    };
    for (const entry of entries) {
        const data = entry.data || {};
        const seasonId = data.seasonId;
        if (!seasonId) continue;
        const { seasonId: _ignored, ...rest } = data;
        if (entry.type.startsWith(PRIVATE_PREFIX)) {
            bucketFor(seasonId).privateEvents.push({
                ...rest,
                type: rest.type || entry.type.slice(PRIVATE_PREFIX.length),
                at: rest.at ?? entry.at ?? null,
            });
            continue;
        }
        bucketFor(seasonId).publicEvents.push({
            ...rest,
            type: entry.type,
            at: entry.at ?? null,
        });
    }
    return buckets;
}

function emptyRound(round) {
    return {
        round,
        merged: false,
        mergedHere: false,
        challenge: null,
        council: null,
        votes: [],
        tiebreak: null,
        eliminations: [],
        startedAt: null,
        endedAt: null,
    };
}

function roundFor(rounds, number) {
    const key = Number.isInteger(number) ? number : 0;
    let round = rounds.find(item => item.round === key);
    if (!round) {
        round = emptyRound(key);
        rounds.push(round);
    }
    return round;
}

function openVote(round, kind) {
    return [...round.votes].reverse().find(vote =>
        (!kind || vote.kind === kind) && vote.revealedAt === null
    ) || null;
}

function startVote(round, kind, at, fields) {
    const vote = {
        kind,
        startedAt: at,
        revealedAt: null,
        voterIds: [],
        targetIds: [],
        ballots: {},
        reasons: {},
        counts: {},
        autofilledVoterIds: [],
        ...fields,
    };
    round.votes.push(vote);
    return vote;
}

// A reveal whose opening never made it into the journal still has to land
// somewhere: the ballots are the part worth keeping.
function voteToFinish(round, kind, event) {
    return openVote(round, kind) || startVote(round, kind, null, {
        voterIds: Object.keys(event.ballots || {}),
        targetIds: [...new Set(Object.values(event.ballots || {}))],
    });
}

function finishVote(vote, event) {
    if (!vote) return;
    vote.ballots = clone(event.ballots || {});
    vote.reasons = clone(event.reasons || {});
    vote.counts = clone(event.counts || {});
    vote.revealedAt = event.at;
}

function tiebreakFor(round) {
    round.tiebreak ??= {
        tiedIds: [],
        decisionMakerIds: [],
        decisions: {},
        rockDrawerIds: [],
        fireMakingIds: [],
        fireMakingWinnerId: null,
        eliminatedId: null,
        resolvedBy: null,
    };
    return round.tiebreak;
}

// One pass over a season's public events, folded into the shape the analysis
// screen reads: rounds with their challenge, council, votes and boot.
function foldPublicEvents(events) {
    const rounds = [];
    const season = {
        startedAt: events[0]?.at ?? null,
        endedAt: null,
        status: null,
        endReason: null,
        participantIds: [],
        tribes: {},
        mergedAtRound: null,
        finalistIds: [],
        juryIds: [],
        winnerId: null,
        finalVote: null,
    };

    for (const event of events) {
        if (event.type === 'season.started') {
            season.startedAt = event.at;
            if (Array.isArray(event.participantIds)) {
                season.participantIds = [...event.participantIds];
            }
            if (event.tribes) season.tribes = clone(event.tribes);
            continue;
        }
        if (event.type === 'season.completed') {
            season.status = 'completed';
            season.winnerId = event.winnerId ?? null;
            season.endedAt = event.at;
            continue;
        }
        if (event.type === 'season.cancelled') {
            season.status = 'cancelled';
            season.endReason = event.reason ?? null;
            season.endedAt = event.at;
            continue;
        }
        // Everything else belongs to a round. A season that never got past its
        // opening event has no rounds to speak of.
        if (!Number.isInteger(event.round) || event.round < 1) continue;
        const round = roundFor(rounds, event.round);
        round.startedAt ??= event.at;
        round.endedAt = event.at;

        switch (event.type) {
            case 'challenge.started':
                round.challenge = {
                    id: event.id ?? null,
                    mode: event.mode ?? null,
                    startedAt: event.at,
                    completedAt: null,
                    winnerId: null,
                    winningTribe: null,
                    tied: false,
                    standings: [],
                    immunityIds: [],
                    councilTribe: null,
                };
                break;
            case 'challenge.completed':
                round.challenge ??= {
                    id: null,
                    mode: null,
                    startedAt: null,
                    completedAt: null,
                    winnerId: null,
                    winningTribe: null,
                    tied: false,
                    standings: [],
                    immunityIds: [],
                    councilTribe: null,
                };
                Object.assign(round.challenge, {
                    completedAt: event.at,
                    winnerId: event.winnerId ?? null,
                    winningTribe: event.winningTribe ?? null,
                    tied: Boolean(event.tied),
                    standings: clone(event.standings || []),
                    immunityIds: [...(event.immunityIds || [])],
                    councilTribe: event.councilTribe ?? null,
                });
                break;
            case 'council.opened':
                round.council = {
                    id: event.councilId ?? null,
                    kind: event.kind ?? 'tribal',
                    attendeeIds: [...(event.attendeeIds || [])],
                    targetIds: [...(event.targetIds || [])],
                    openedAt: event.at,
                    questions: [],
                };
                break;
            case 'council.question':
                if (round.council) {
                    round.council.questions.push({
                        id: event.id ?? null,
                        prompt: event.prompt ?? '',
                        targetIds: [...(event.targetIds || [])],
                        askedBy: event.askedBy ?? 'host',
                        askedAt: event.at,
                        answers: [],
                    });
                }
                break;
            case 'council.answer': {
                const question = round.council?.questions.find(
                    item => item.id === event.questionId
                );
                question?.answers.push({
                    playerId: event.playerId,
                    answer: event.answer,
                    at: event.at,
                });
                break;
            }
            case 'vote.started':
                startVote(round, 'vote', event.at, {
                    voterIds: [...(event.voters || [])],
                    targetIds: [...(event.targets || [])],
                });
                break;
            case 'revote.started':
                startVote(round, 'revote', event.at, {
                    voterIds: [...(event.voters || [])],
                    targetIds: [...(event.tiedIds || [])],
                });
                tiebreakFor(round).tiedIds = [...(event.tiedIds || [])];
                break;
            case 'jury.vote.started':
                startVote(round, 'jury', event.at, {
                    voterIds: [...(event.jurorIds || [])],
                    targetIds: [...(event.finalistIds || [])],
                });
                break;
            case 'jury.tiebreak.started':
                startVote(round, 'jury-tiebreak', event.at, {
                    voterIds: event.voterId ? [event.voterId] : [],
                    targetIds: [...(event.finalistIds || [])],
                });
                break;
            case 'ballots.autofilled': {
                const vote = openVote(round);
                if (vote) {
                    vote.autofilledVoterIds = (event.ballots || []).map(item => item.voterId);
                }
                break;
            }
            case 'vote.revealed':
                finishVote(
                    voteToFinish(round, event.phase === 'revote' ? 'revote' : 'vote', event),
                    event
                );
                break;
            case 'jury.vote.revealed':
                finishVote(voteToFinish(round, 'jury', event), event);
                season.finalVote = {
                    ballots: clone(event.ballots || {}),
                    reasons: clone(event.reasons || {}),
                    counts: clone(event.counts || {}),
                    at: event.at,
                    decidedBy: 'jury',
                };
                break;
            case 'jury.tiebreak.revealed': {
                const vote = openVote(round, 'jury-tiebreak');
                if (vote) {
                    vote.ballots = { [event.voterId]: event.winnerId };
                    vote.reasons = clone(event.reasons || {});
                    vote.counts = { [event.winnerId]: 1 };
                    vote.revealedAt = event.at;
                }
                if (season.finalVote) season.finalVote.decidedBy = 'finalist-tiebreak';
                break;
            }
            case 'jury.three_way_tie':
                if (season.finalVote) season.finalVote.decidedBy = 'three-way-tie';
                break;
            case 'deadlock.started': {
                const tiebreak = tiebreakFor(round);
                tiebreak.tiedIds = [...(event.tiedIds || [])];
                tiebreak.decisionMakerIds = [...(event.decisionMakerIds || [])];
                break;
            }
            case 'deadlock.decisions-autofilled':
                for (const decision of event.decisions || []) {
                    tiebreakFor(round).decisions[decision.voterId] = decision.targetId;
                }
                break;
            case 'rocks.drawn': {
                const tiebreak = tiebreakFor(round);
                tiebreak.rockDrawerIds = [...(event.drawerIds || [])];
                tiebreak.eliminatedId = event.eliminatedId ?? null;
                tiebreak.resolvedBy = 'rocks';
                break;
            }
            case 'vote.no_voter_tiebreak': {
                const tiebreak = tiebreakFor(round);
                tiebreak.tiedIds = [...(event.tiedIds || [])];
                tiebreak.eliminatedId = event.eliminatedId ?? null;
                tiebreak.resolvedBy = 'no-voter-tiebreak';
                break;
            }
            case 'fire_making.started':
                tiebreakFor(round).fireMakingIds = [...(event.contestantIds || [])];
                break;
            case 'fire_making.completed': {
                const tiebreak = tiebreakFor(round);
                tiebreak.fireMakingWinnerId = event.winnerId ?? null;
                tiebreak.eliminatedId = event.eliminatedId ?? null;
                tiebreak.resolvedBy = 'fire-making';
                break;
            }
            case 'player.eliminated':
                round.eliminations.push({
                    playerId: event.playerId,
                    reason: event.reason ?? null,
                    placement: event.placement ?? null,
                    joinsJury: Boolean(event.joinsJury),
                    at: event.at,
                });
                if (event.joinsJury) season.juryIds.push(event.playerId);
                break;
            case 'tribes.merged':
                // The merge is declared after the round's boot, so this round
                // was still played in tribes; the next one is the first merged
                // one.
                season.mergedAtRound = round.round;
                round.mergedHere = true;
                break;
            case 'finalists.reached':
                season.finalistIds = [...(event.finalistIds || [])];
                break;
            default:
                break;
        }
    }

    rounds.sort((left, right) => left.round - right.round);
    // A round is post-merge if the merge was declared before it, or if its
    // challenge was played for individual immunity — which is the only signal
    // left for a cast that started below the merge threshold and so never had a
    // merge to declare.
    for (const round of rounds) {
        round.merged = (season.mergedAtRound !== null && round.round > season.mergedAtRound)
            || round.challenge?.mode === 'individual';
    }
    return { season, rounds };
}

function buildConversations(privateEvents) {
    const threads = [];
    const refusals = [];
    let requested = 0;
    let accepted = 0;
    for (const event of privateEvents) {
        if (event.type === 'talk.requested') requested += 1;
        if (event.type === 'talk.accepted') accepted += 1;
        applyRefusalEvent(refusals, event);
        applyRoomEvent(threads, event);
    }
    return {
        threads,
        refusals,
        threadCount: threads.length,
        messageCount: threads.reduce((total, thread) => total + thread.messageCount, 0),
        talkRequests: requested,
        talkAccepted: accepted,
        talkRefused: refusals.length,
    };
}

// Private events used to be journaled without the round they happened in, so
// older seasons place their conversations by timestamp against the round
// boundaries instead.
function stampConversationRounds(conversations, rounds) {
    const roundAt = at => {
        if (at == null) return null;
        let found = null;
        for (const round of rounds) {
            if (round.startedAt != null && at >= round.startedAt) found = round.round;
        }
        return found;
    };
    for (const thread of conversations.threads) {
        thread.round ??= roundAt(thread.openedAt);
        for (const message of thread.messages) {
            message.round ??= roundAt(message.at);
        }
    }
}

// Cast list, in preference order: the final snapshot, then the opening event,
// then whoever the events themselves name. The last case only matters for
// seasons that ran before the cast was journaled.
function resolveParticipants(snapshot, season, rounds, conversations) {
    if (snapshot?.participantIds?.length) return [...snapshot.participantIds];
    if (season.participantIds.length) return [...season.participantIds];
    const seen = new Set();
    for (const round of rounds) {
        for (const id of round.challenge?.immunityIds || []) seen.add(id);
        for (const id of round.council?.attendeeIds || []) seen.add(id);
        for (const vote of round.votes) {
            for (const id of vote.voterIds) seen.add(id);
            for (const id of vote.targetIds) seen.add(id);
            for (const [voterId, targetId] of Object.entries(vote.ballots)) {
                seen.add(voterId);
                seen.add(targetId);
            }
        }
        for (const boot of round.eliminations) seen.add(boot.playerId);
    }
    for (const thread of conversations.threads) {
        for (const id of thread.memberIds) seen.add(id);
    }
    return [...seen].sort();
}

function buildPlayers({ participantIds, snapshot, season, rounds, conversations }) {
    const players = participantIds.map(id => ({
        id,
        tribe: snapshot?.players?.[id]?.tribe
            ?? Object.keys(season.tribes).find(name => season.tribes[name]?.includes(id))
            ?? null,
        placement: snapshot?.players?.[id]?.placement ?? null,
        eliminatedRound: snapshot?.players?.[id]?.eliminatedRound ?? null,
        eliminationReason: null,
        jury: Boolean(snapshot?.players?.[id]?.jury) || season.juryIds.includes(id),
        finalist: season.finalistIds.includes(id),
        winner: season.winnerId === id,
        votesAgainst: 0,
        votesCast: 0,
        votesAgainstByRound: {},
        individualImmunityWins: 0,
        tribeChallengeWins: 0,
        councilsAttended: 0,
        councilAnswers: 0,
        juryVotesReceived: 0,
        threadCount: 0,
        spokenCount: 0,
        heardCount: 0,
        partnerIds: [],
        refusedBy: [],
        refused: [],
    }));
    const byId = new Map(players.map(player => [player.id, player]));

    for (const round of rounds) {
        const challenge = round.challenge;
        if (challenge?.winnerId && byId.has(challenge.winnerId)) {
            byId.get(challenge.winnerId).individualImmunityWins += 1;
        }
        if (challenge?.winningTribe) {
            for (const id of challenge.immunityIds) {
                if (byId.has(id)) byId.get(id).tribeChallengeWins += 1;
            }
        }
        for (const id of round.council?.attendeeIds || []) {
            if (byId.has(id)) byId.get(id).councilsAttended += 1;
        }
        for (const question of round.council?.questions || []) {
            for (const answer of question.answers) {
                if (byId.has(answer.playerId)) byId.get(answer.playerId).councilAnswers += 1;
            }
        }
        for (const vote of round.votes) {
            const jury = vote.kind === 'jury' || vote.kind === 'jury-tiebreak';
            for (const [voterId, targetId] of Object.entries(vote.ballots)) {
                if (byId.has(voterId)) byId.get(voterId).votesCast += 1;
                const target = byId.get(targetId);
                if (!target) continue;
                if (jury) {
                    target.juryVotesReceived += 1;
                    continue;
                }
                target.votesAgainst += 1;
                target.votesAgainstByRound[round.round] =
                    (target.votesAgainstByRound[round.round] || 0) + 1;
            }
        }
        for (const boot of round.eliminations) {
            const player = byId.get(boot.playerId);
            if (!player) continue;
            player.eliminatedRound ??= round.round;
            player.placement ??= boot.placement;
            player.eliminationReason = boot.reason;
        }
    }

    for (const thread of conversations.threads) {
        for (const memberId of thread.memberIds) {
            const player = byId.get(memberId);
            if (!player) continue;
            player.threadCount += 1;
            const spoken = thread.messageCountBySender[memberId] || 0;
            player.spokenCount += spoken;
            player.heardCount += thread.messageCount - spoken;
            for (const otherId of thread.memberIds) {
                if (otherId !== memberId && !player.partnerIds.includes(otherId)) {
                    player.partnerIds.push(otherId);
                }
            }
        }
    }
    for (const refusal of conversations.refusals) {
        byId.get(refusal.requesterId)?.refusedBy.push(refusal.inviteeId);
        byId.get(refusal.inviteeId)?.refused.push(refusal.requesterId);
    }

    // Nobody at the final council is eliminated, so their placements come from
    // the jury vote instead: the winner first, then the rest by votes received.
    const champion = byId.get(season.winnerId);
    if (champion) champion.placement ??= 1;
    const juryCounts = season.finalVote?.counts || {};
    season.finalistIds
        .filter(id => id !== season.winnerId)
        .sort((left, right) =>
            (juryCounts[right] || 0) - (juryCounts[left] || 0)
            || left.localeCompare(right))
        .forEach((id, index) => {
            const finalist = byId.get(id);
            if (finalist) finalist.placement ??= index + 2;
        });

    // Finishing order first, then the cast list order for anyone still standing
    // in a season that never finished.
    return players.sort((left, right) =>
        (left.placement ?? Infinity) - (right.placement ?? Infinity)
        || left.id.localeCompare(right.id));
}

function buildBootOrder(rounds, players) {
    const byId = new Map(players.map(player => [player.id, player]));
    return rounds.flatMap(round => round.eliminations.map(boot => ({
        ...boot,
        round: round.round,
        tribe: byId.get(boot.playerId)?.tribe ?? null,
        merged: round.merged,
        votesAgainst: round.votes
            .filter(vote => vote.kind === 'vote' || vote.kind === 'revote')
            .reduce((total, vote) => total + (vote.counts[boot.playerId] || 0), 0),
    })));
}

function resolveStatus(snapshot, season) {
    if (snapshot?.status) return snapshot.status;
    if (season.status) return season.status;
    // No terminal event and no snapshot: the season stopped being written to
    // without ever ending, which is a real thing that happens when a process
    // dies mid-season.
    return 'unfinished';
}

export function buildSeasonRecord({ id, publicEvents = [], privateEvents = [], snapshot = null }) {
    const events = [...publicEvents].sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
    const { season, rounds } = foldPublicEvents(events);
    const conversations = buildConversations(privateEvents);
    stampConversationRounds(conversations, rounds);
    const participantIds = resolveParticipants(snapshot, season, rounds, conversations);
    const players = buildPlayers({ participantIds, snapshot, season, rounds, conversations });
    const status = resolveStatus(snapshot, season);
    const winnerId = season.winnerId ?? snapshot?.winnerIds?.[0] ?? null;
    const startedAt = season.startedAt ?? events[0]?.at ?? null;
    const endedAt = season.endedAt
        ?? (status === 'running' ? null : events.at(-1)?.at ?? null);

    return {
        id,
        status,
        endReason: season.endReason,
        startedAt,
        endedAt,
        durationMs: startedAt && endedAt ? endedAt - startedAt : null,
        castSize: participantIds.length,
        participantIds,
        tribeNames: snapshot?.tribeNames ?? Object.keys(season.tribes),
        tribes: snapshot?.tribes ?? season.tribes,
        mergeAt: snapshot?.mergeAt ?? null,
        mergedAtRound: season.mergedAtRound,
        finalistCount: snapshot?.finalistCount ?? null,
        roundsPlayed: rounds.length,
        lastRound: rounds.at(-1)?.round ?? null,
        winnerId,
        finalistIds: season.finalistIds.length
            ? season.finalistIds
            : [...(snapshot?.finalistIds || [])],
        juryIds: season.juryIds.length ? season.juryIds : [...(snapshot?.juryIds || [])],
        finalVote: season.finalVote ?? snapshot?.finalVote ?? null,
        rounds,
        bootOrder: buildBootOrder(rounds, players),
        players,
        conversations,
        councilCount: rounds.filter(round => round.council).length,
        voteCount: rounds.reduce(
            (total, round) => total + round.votes.filter(vote => vote.revealedAt).length,
            0
        ),
        timeline: events.filter(event => !TIMELINE_NOISE.includes(event.type)),
        hasSnapshot: Boolean(snapshot),
    };
}

// Newest season first, but numbered oldest first: season 1 is the first one that
// ever ran, and that number should not move when a new one starts.
export function buildSeasons({ entries = [], snapshots = [] } = {}) {
    const buckets = splitEntries(entries);
    const snapshotById = new Map();
    for (const snapshot of snapshots) {
        if (snapshot?.id) snapshotById.set(snapshot.id, snapshot);
    }
    for (const id of snapshotById.keys()) {
        if (!buckets.has(id)) buckets.set(id, { id, publicEvents: [], privateEvents: [] });
    }

    const seasons = [...buckets.values()]
        .map(bucket => buildSeasonRecord({ ...bucket, snapshot: snapshotById.get(bucket.id) ?? null }))
        .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
    seasons.forEach((season, index) => {
        season.seasonNumber = index + 1;
    });
    return seasons.reverse();
}

// The list screen never needs a season's transcripts or its round-by-round
// detail, and sending them for every season would mean shipping the whole
// archive on page load.
export function summarizeSeason(season) {
    return {
        id: season.id,
        seasonNumber: season.seasonNumber,
        status: season.status,
        endReason: season.endReason,
        startedAt: season.startedAt,
        endedAt: season.endedAt,
        durationMs: season.durationMs,
        castSize: season.castSize,
        participantIds: season.participantIds,
        tribeNames: season.tribeNames,
        roundsPlayed: season.roundsPlayed,
        councilCount: season.councilCount,
        voteCount: season.voteCount,
        bootCount: season.bootOrder.length,
        winnerId: season.winnerId,
        finalistIds: season.finalistIds,
        messageCount: season.conversations.messageCount,
        threadCount: season.conversations.threadCount,
    };
}

export class SurvivorSeasonArchive {
    constructor(options = {}) {
        if (typeof options.root !== 'string' || options.root.trim() === '') {
            throw new TypeError('root must be a non-empty string');
        }
        this.root = path.resolve(options.root);
        this.journalPath = path.join(this.root, 'journal.jsonl');
        this.statePath = path.join(this.root, 'state.json');
        this.seasonsDir = path.join(this.root, 'seasons');
        this._cache = null;
        this._signature = null;
    }

    async list() {
        const seasons = await this._read();
        return seasons.map(summarizeSeason);
    }

    async get(seasonId) {
        const seasons = await this._read();
        return seasons.find(season => season.id === seasonId) ?? null;
    }

    // Rebuilding means re-reading the whole journal, so it only happens when
    // something on disk actually moved.
    async _read() {
        const signature = await this._diskSignature();
        if (this._cache && signature === this._signature) return this._cache;
        const [entries, snapshots] = await Promise.all([
            this._readJournal(),
            this._readSnapshots(),
        ]);
        this._cache = buildSeasons({ entries, snapshots });
        this._signature = signature;
        return this._cache;
    }

    async _readJournal() {
        try {
            return parseJournal(await readFile(this.journalPath, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    }

    async _readSnapshots() {
        const files = [this.statePath];
        try {
            const names = await readdir(this.seasonsDir);
            for (const name of names) {
                if (name.endsWith('.json')) files.push(path.join(this.seasonsDir, name));
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const snapshots = await Promise.all(files.map(async file => {
            try {
                return JSON.parse(await readFile(file, 'utf8'));
            } catch {
                return null;
            }
        }));
        // state.json is read first, so an archived copy of the same season wins:
        // it is the one that was filed when the season ended.
        return snapshots.filter(Boolean);
    }

    async _diskSignature() {
        const parts = [];
        for (const file of [this.journalPath, this.statePath]) {
            const info = await stat(file).catch(() => null);
            parts.push(info ? `${file}:${info.size}:${info.mtimeMs}` : `${file}:none`);
        }
        const names = await readdir(this.seasonsDir).catch(() => []);
        parts.push(`seasons:${names.sort().join(',')}`);
        return parts.join('|');
    }
}
