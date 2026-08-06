const PHASES = Object.freeze([
    'challenge',
    'strategy',
    'voting',
    'revote',
    'deadlock',
    'fire_making',
    'jury_questioning',
    'jury_voting',
    'finalist_tiebreak',
    'completed',
    'cancelled',
]);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertName(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string`);
    }
}

function uniqueNames(values, label) {
    if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
    const names = values.map((value, index) => {
        assertName(value, `${label}[${index}]`);
        return value.trim();
    });
    if (new Set(names).size !== names.length) {
        throw new Error(`${label} must contain unique names`);
    }
    return names;
}

function tally(ballots) {
    const counts = {};
    for (const targetId of Object.values(ballots)) {
        counts[targetId] = (counts[targetId] || 0) + 1;
    }
    const high = Math.max(0, ...Object.values(counts));
    return {
        counts,
        leaders: Object.keys(counts).filter(id => counts[id] === high).sort(),
        high,
    };
}

function seededIndex(random, size) {
    if (size <= 0) throw new Error('Cannot choose from an empty list');
    return Math.min(size - 1, Math.floor(random() * size));
}

export function createSurvivorState(options = {}) {
    const participantIds = uniqueNames(options.participantIds, 'participantIds');
    const mergeAt = options.mergeAt ?? 10;
    if (!Number.isInteger(mergeAt) || mergeAt < 4) {
        throw new RangeError('mergeAt must be an integer of at least 4');
    }
    if (participantIds.length <= mergeAt) {
        throw new Error(`Survivor requires more than ${mergeAt} participants`);
    }
    const tribeNames = uniqueNames(options.tribeNames || ['Ember', 'Tide'], 'tribeNames');
    if (tribeNames.length !== 2) throw new Error('Survivor requires exactly two tribes');

    const tribes = Object.fromEntries(tribeNames.map(name => [name, []]));
    participantIds.forEach((id, index) => tribes[tribeNames[index % 2]].push(id));
    const players = Object.fromEntries(participantIds.map(id => [
        id,
        {
            id,
            tribe: tribeNames[participantIds.indexOf(id) % 2],
            active: true,
            jury: false,
            placement: null,
            eliminatedRound: null,
        },
    ]));

    return {
        version: 1,
        id: options.id || 'survivor',
        status: 'running',
        phase: 'challenge',
        round: 1,
        mergeAt,
        merged: false,
        tribeNames,
        tribes,
        participantIds,
        players,
        challenge: null,
        councilTribe: null,
        immunityIds: [],
        eligibleVoterIds: [],
        councilVoterIds: [],
        eligibleTargetIds: [],
        ballots: {},
        tiedIds: [],
        deadlockDecisions: {},
        preMergeBootIds: [],
        juryIds: [],
        finalistIds: [],
        bootOrder: [],
        winnerIds: [],
        finalVote: null,
        events: [{
            type: 'season.started',
            round: 1,
            participantIds,
            tribes: clone(tribes),
        }],
    };
}

export class SurvivorGame {
    constructor(options = {}) {
        this.random = options.random || Math.random;
        if (typeof this.random !== 'function') throw new TypeError('random must be a function');
        this.state = options.state
            ? clone(options.state)
            : createSurvivorState(options);
        this.state.councilVoterIds ||= [...(this.state.eligibleVoterIds || [])];
        this._assertState();
    }

    snapshot() {
        return clone(this.state);
    }

    activePlayerIds() {
        return this.state.participantIds.filter(id => this.state.players[id].active);
    }

    startChallenge(challenge = {}) {
        this._requirePhase('challenge');
        assertName(challenge.id, 'challenge.id');
        this.state.challenge = {
            id: challenge.id,
            mode: this.state.merged ? 'individual' : 'tribe',
            startedAt: challenge.startedAt ?? null,
            result: null,
        };
        this._event('challenge.started', this.state.challenge);
        return this.snapshot();
    }

    completeChallenge(result = {}) {
        this._requirePhase('challenge');
        if (!this.state.challenge) throw new Error('No challenge is active');
        const activeIds = this.activePlayerIds();
        if (this.state.merged) {
            assertName(result.winnerId, 'result.winnerId');
            if (!activeIds.includes(result.winnerId)) throw new Error('Challenge winner is not active');
            this.state.immunityIds = [result.winnerId];
            this.state.councilTribe = null;
        } else {
            assertName(result.winningTribe, 'result.winningTribe');
            if (!this.state.tribeNames.includes(result.winningTribe)) {
                throw new Error('Unknown winning tribe');
            }
            this.state.councilTribe = this.state.tribeNames.find(
                name => name !== result.winningTribe
            );
            this.state.immunityIds = activeIds.filter(
                id => this.state.players[id].tribe === result.winningTribe
            );
        }
        this.state.challenge.result = clone(result);
        this.state.phase = 'strategy';
        this._event('challenge.completed', {
            ...result,
            councilTribe: this.state.councilTribe,
            immunityIds: this.state.immunityIds,
        });
        if (!this.state.merged) {
            const councilMembers = activeIds.filter(
                id => this.state.players[id].tribe === this.state.councilTribe
            );
            if (councilMembers.length === 0) {
                throw new Error(`Losing tribe ${this.state.councilTribe} has no active players`);
            }
            if (councilMembers.length === 1) {
                return this._eliminate(councilMembers[0], 'tribe-forfeit');
            }
        }
        return this.snapshot();
    }

    beginVoting() {
        this._requirePhase('strategy');
        const activeIds = this.activePlayerIds();
        const voters = this.state.merged
            ? activeIds
            : activeIds.filter(id => this.state.players[id].tribe === this.state.councilTribe);
        const targets = voters.filter(id => !this.state.immunityIds.includes(id));
        if (voters.length < 2 || targets.length === 0) {
            throw new Error('Tribal Council has no legal vote');
        }
        this.state.phase = 'voting';
        this.state.eligibleVoterIds = voters;
        this.state.councilVoterIds = [...voters];
        this.state.eligibleTargetIds = targets;
        this.state.ballots = {};
        this.state.tiedIds = [];
        this.state.deadlockDecisions = {};
        this._event('vote.started', { voters, targets });
        return this.snapshot();
    }

    castVote(voterId, targetId) {
        if (!['voting', 'revote', 'jury_voting', 'finalist_tiebreak'].includes(this.state.phase)) {
            throw new Error(`Votes are not accepted during ${this.state.phase}`);
        }
        this._validateBallot(voterId, targetId);
        if (this.state.ballots[voterId]) throw new Error(`${voterId} already voted`);
        this.state.ballots[voterId] = targetId;
        this._event('ballot.cast', { voterId, phase: this.state.phase });
        return {
            accepted: true,
            received: Object.keys(this.state.ballots).length,
            expected: this.state.eligibleVoterIds.length,
        };
    }

    fillMissingBallots() {
        if (!['voting', 'revote', 'jury_voting', 'finalist_tiebreak'].includes(this.state.phase)) {
            throw new Error(`Ballots cannot be filled during ${this.state.phase}`);
        }
        const filled = [];
        for (const voterId of this.state.eligibleVoterIds) {
            if (this.state.ballots[voterId]) continue;
            const legalTargets = this.state.eligibleTargetIds.filter(id => id !== voterId);
            const targetId = legalTargets[seededIndex(this.random, legalTargets.length)];
            this.state.ballots[voterId] = targetId;
            filled.push({ voterId, targetId });
        }
        if (filled.length > 0) this._event('ballots.autofilled', { ballots: filled });
        return filled;
    }

    revealVotes() {
        this._requireAllBallots();
        if (this.state.phase === 'jury_voting') return this._resolveJuryVote();
        if (this.state.phase === 'finalist_tiebreak') return this._resolveFinalistTiebreak();
        if (!['voting', 'revote'].includes(this.state.phase)) {
            throw new Error(`Votes cannot be revealed during ${this.state.phase}`);
        }

        const result = tally(this.state.ballots);
        this._event('vote.revealed', {
            phase: this.state.phase,
            ballots: clone(this.state.ballots),
            counts: result.counts,
        });
        if (result.leaders.length === 1) {
            return this._eliminate(result.leaders[0], 'vote');
        }
        if (this.state.phase === 'voting') {
            const tiedIds = result.leaders;
            this.state.phase = 'revote';
            this.state.tiedIds = tiedIds;
            this.state.eligibleVoterIds = this.state.eligibleVoterIds.filter(
                id => !tiedIds.includes(id)
            );
            this.state.eligibleTargetIds = tiedIds;
            this.state.ballots = {};
            this._event('revote.started', {
                tiedIds,
                voters: this.state.eligibleVoterIds,
            });
            if (this.state.eligibleVoterIds.length === 0) {
                return this._beginDeadlock(tiedIds);
            }
            return this.snapshot();
        }
        return this._beginDeadlock(result.leaders);
    }

    submitDeadlockDecision(voterId, targetId) {
        this._requirePhase('deadlock');
        if (!this.state.eligibleVoterIds.includes(voterId)) {
            throw new Error(`${voterId} cannot decide the deadlock`);
        }
        if (!this.state.tiedIds.includes(targetId)) {
            throw new Error(`${targetId} is not tied`);
        }
        this.state.deadlockDecisions[voterId] = targetId;
        this._event('deadlock.decision', { voterId });
        return this.snapshot();
    }

    fillMissingDeadlockDecisions() {
        this._requirePhase('deadlock');
        const filled = [];
        for (const voterId of this.state.eligibleVoterIds) {
            if (this.state.deadlockDecisions[voterId]) continue;
            const targetId = this.state.tiedIds[
                seededIndex(this.random, this.state.tiedIds.length)
            ];
            this.state.deadlockDecisions[voterId] = targetId;
            filled.push({ voterId, targetId });
        }
        if (filled.length > 0) {
            this._event('deadlock.decisions-autofilled', { decisions: filled });
        }
        return filled;
    }

    resolveDeadlock() {
        this._requirePhase('deadlock');
        const voters = this.state.eligibleVoterIds;
        if (voters.some(id => !this.state.deadlockDecisions[id])) {
            throw new Error('Not every eligible player submitted a deadlock decision');
        }
        const decisions = new Set(Object.values(this.state.deadlockDecisions));
        if (decisions.size === 1) {
            return this._eliminate([...decisions][0], 'unanimous-deadlock');
        }

        const rockDrawers = this.state.councilVoterIds.filter(id =>
            !this.state.tiedIds.includes(id)
            && !this.state.immunityIds.includes(id)
            && this.state.players[id]?.active
        );
        if (rockDrawers.length === 0 || this.activePlayerIds().length === 4) {
            this.state.phase = 'fire_making';
            this._event('fire_making.started', { contestantIds: this.state.tiedIds });
            return this.snapshot();
        }
        const eliminatedId = rockDrawers[seededIndex(this.random, rockDrawers.length)];
        this._event('rocks.drawn', {
            drawerIds: rockDrawers,
            eliminatedId,
            immuneTiedIds: this.state.tiedIds,
        });
        return this._eliminate(eliminatedId, 'rocks');
    }

    resolveFireMaking(winnerId = null) {
        this._requirePhase('fire_making');
        const contestants = this.state.tiedIds;
        if (contestants.length !== 2) {
            throw new Error('Fire-making requires exactly two contestants');
        }
        const resolvedWinner = winnerId || contestants[seededIndex(this.random, contestants.length)];
        if (!contestants.includes(resolvedWinner)) throw new Error('Fire-making winner is not tied');
        const eliminatedId = contestants.find(id => id !== resolvedWinner);
        this._event('fire_making.completed', { winnerId: resolvedWinner, eliminatedId });
        return this._eliminate(eliminatedId, 'fire-making');
    }

    beginJuryVote() {
        this._requirePhase('jury_questioning');
        if (this.state.juryIds.length === 0) throw new Error('The final three has no jury');
        this.state.phase = 'jury_voting';
        this.state.eligibleVoterIds = [...this.state.juryIds];
        this.state.eligibleTargetIds = [...this.state.finalistIds];
        this.state.ballots = {};
        this._event('jury.vote.started', {
            jurorIds: this.state.juryIds,
            finalistIds: this.state.finalistIds,
        });
        return this.snapshot();
    }

    cancel(reason = 'Cancelled by operator') {
        if (this.state.status !== 'running') throw new Error('Season is not running');
        this.state.status = 'cancelled';
        this.state.phase = 'cancelled';
        this._event('season.cancelled', { reason });
        return this.snapshot();
    }

    _beginDeadlock(tiedIds) {
        this.state.phase = 'deadlock';
        this.state.tiedIds = tiedIds;
        this.state.eligibleVoterIds = this.state.councilVoterIds.filter(
            id => !tiedIds.includes(id)
        );
        this.state.eligibleTargetIds = tiedIds;
        this.state.ballots = {};
        this.state.deadlockDecisions = {};
        this._event('deadlock.started', {
            tiedIds,
            decisionMakerIds: this.state.eligibleVoterIds,
        });
        if (this.state.eligibleVoterIds.length === 0) {
            if (this.activePlayerIds().length === 4 && tiedIds.length === 2) {
                this.state.phase = 'fire_making';
                this._event('fire_making.started', { contestantIds: tiedIds });
            } else {
                const eliminatedId = tiedIds[seededIndex(this.random, tiedIds.length)];
                this._event('vote.no_voter_tiebreak', { tiedIds, eliminatedId });
                return this._eliminate(eliminatedId, 'no-voter-tiebreak');
            }
        }
        return this.snapshot();
    }

    _eliminate(playerId, reason) {
        const player = this.state.players[playerId];
        if (!player?.active) throw new Error(`${playerId} is not active`);
        const remainingBefore = this.activePlayerIds().length;
        player.active = false;
        player.eliminatedRound = this.state.round;
        player.placement = remainingBefore;
        this.state.bootOrder.push(playerId);
        if (this.state.merged) {
            player.jury = true;
            this.state.juryIds.push(playerId);
        } else {
            this.state.preMergeBootIds.push(playerId);
        }
        this._event('player.eliminated', {
            playerId,
            reason,
            placement: player.placement,
            joinsJury: player.jury,
        });

        const remaining = this.activePlayerIds();
        if (remaining.length === 3) {
            this.state.finalistIds = remaining;
            this.state.phase = 'jury_questioning';
            this.state.challenge = null;
            this.state.immunityIds = [];
            this.state.eligibleVoterIds = [];
            this.state.councilVoterIds = [];
            this.state.eligibleTargetIds = [];
            this.state.ballots = {};
            this._event('final_three.reached', { finalistIds: remaining });
            return this.snapshot();
        }
        if (!this.state.merged && remaining.length === this.state.mergeAt) {
            this.state.merged = true;
            this.state.councilTribe = null;
            this._event('tribes.merged', { playerIds: remaining });
        }
        this.state.round += 1;
        this.state.phase = 'challenge';
        this.state.challenge = null;
        this.state.councilTribe = null;
        this.state.immunityIds = [];
        this.state.eligibleVoterIds = [];
        this.state.councilVoterIds = [];
        this.state.eligibleTargetIds = [];
        this.state.ballots = {};
        this.state.tiedIds = [];
        this.state.deadlockDecisions = {};
        return this.snapshot();
    }

    _resolveJuryVote() {
        const result = tally(this.state.ballots);
        this.state.finalVote = {
            ballots: clone(this.state.ballots),
            counts: result.counts,
        };
        this._event('jury.vote.revealed', this.state.finalVote);
        if (result.leaders.length === 1) return this._complete(result.leaders[0]);
        if (result.leaders.length === 2) {
            const decidingFinalist = this.state.finalistIds.find(
                id => !result.leaders.includes(id)
            );
            this.state.phase = 'finalist_tiebreak';
            this.state.tiedIds = result.leaders;
            this.state.eligibleVoterIds = [decidingFinalist];
            this.state.eligibleTargetIds = result.leaders;
            this.state.ballots = {};
            this._event('jury.tiebreak.started', {
                voterId: decidingFinalist,
                finalistIds: result.leaders,
            });
            return this.snapshot();
        }
        const winnerId = result.leaders[seededIndex(this.random, result.leaders.length)];
        this._event('jury.three_way_tie', { finalistIds: result.leaders, winnerId });
        return this._complete(winnerId);
    }

    _resolveFinalistTiebreak() {
        const winnerId = Object.values(this.state.ballots)[0];
        this._event('jury.tiebreak.revealed', {
            voterId: this.state.eligibleVoterIds[0],
            winnerId,
        });
        return this._complete(winnerId);
    }

    _complete(winnerId) {
        this.state.status = 'completed';
        this.state.phase = 'completed';
        this.state.winnerIds = [winnerId];
        this.state.players[winnerId].placement = 1;
        this._event('season.completed', { winnerId });
        return this.snapshot();
    }

    _validateBallot(voterId, targetId) {
        if (!this.state.eligibleVoterIds.includes(voterId)) {
            throw new Error(`${voterId} is not eligible to vote`);
        }
        if (!this.state.eligibleTargetIds.includes(targetId)) {
            throw new Error(`${targetId} is not an eligible target`);
        }
        if (voterId === targetId) throw new Error('A player cannot vote for themselves');
    }

    _requireAllBallots() {
        const missing = this.state.eligibleVoterIds.filter(id => !this.state.ballots[id]);
        if (missing.length > 0) throw new Error(`Missing ballots from: ${missing.join(', ')}`);
    }

    _requirePhase(...phases) {
        if (!phases.includes(this.state.phase)) {
            throw new Error(`Expected phase ${phases.join(' or ')}, got ${this.state.phase}`);
        }
    }

    _event(type, data = {}) {
        this.state.events.push({
            type,
            round: this.state.round,
            ...clone(data),
        });
    }

    _assertState() {
        if (!this.state || this.state.version !== 1) throw new Error('Invalid Survivor state');
        if (!PHASES.includes(this.state.phase)) {
            throw new Error(`Invalid Survivor phase: ${this.state.phase}`);
        }
    }
}
