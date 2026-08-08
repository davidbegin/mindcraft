import { runMinecraftCommand } from '../minecraft_server.js';

const BOSSBAR_ID = 'mindcraft:contest';
const ALL_PLAYERS = '@a';
const ITEM_RACE_PRESENTATIONS = Object.freeze({
    cake_race: Object.freeze({
        score: 'cake crafted',
        winnerLabel: 'CAKE CRAFTED!',
        titleColor: 'light_purple',
    }),
    death_race: Object.freeze({
        score: 'died first',
        winnerLabel: 'FIRST DEATH!',
        titleColor: 'red',
    }),
    dog_race: Object.freeze({
        score: 'dog tamed',
        winnerLabel: 'DOG TAMED!',
        titleColor: 'gold',
    }),
    diamond_race: Object.freeze({
        score: 'diamond found',
        winnerLabel: 'DIAMOND FOUND!',
        titleColor: 'aqua',
    }),
    netherite_race: Object.freeze({
        score: 'netherite forged',
        winnerLabel: 'NETHERITE FORGED!',
        titleColor: 'dark_purple',
    }),
    spleef: Object.freeze({
        score: 'last standing',
        winnerLabel: 'LAST STANDING!',
        titleColor: 'aqua',
    }),
});

function textComponent(text, options = {}) {
    return JSON.stringify({ text, ...options });
}

export function formatContestTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

export function formatContestScore(contest, result) {
    if (!result || !Number.isFinite(result.score)) return '';
    if (contest.rules?.type === 'tower_battle') {
        return `${result.score} blocks`;
    }
    if (contest.rules?.type === 'team_tower_battle') {
        const height = result.details?.towerHeight ?? result.towerHeight ?? 0;
        const penalty = result.details?.deathPenalty ?? result.deathPenalty ?? 0;
        return `${height} - ${penalty} = ${result.score} blocks`;
    }
    if (contest.rules?.type === 'depth_race') {
        const depth = Number.isInteger(result.score)
            ? result.score
            : result.score.toFixed(1);
        return `${depth} blocks deep`;
    }
    if (contest.rules?.type === 'spleef') {
        if (result.details?.surviving) return 'last standing';
        const survivedMs = result.details?.survivedMs;
        if (Number.isFinite(survivedMs)) {
            return `fell at ${formatContestTime(survivedMs)}`;
        }
        return 'eliminated';
    }
    if (contest.rules?.type === 'cake_race' && result.details?.teamName) {
        if (Number.isFinite(result.details?.elapsedMs)) {
            return formatContestTime(result.details.elapsedMs);
        }
        return result.score > 0 ? 'cake crafted' : 'outpaced';
    }
    if (contest.rules?.type === 'team_base_siege') {
        if (result.details?.surviving) {
            const survivors = result.details?.survivors;
            return Number.isFinite(survivors) ? `${survivors} alive` : 'surviving';
        }
        const survivedMs = result.details?.survivedMs;
        if (Number.isFinite(survivedMs)) {
            return `out at ${formatContestTime(survivedMs)}`;
        }
        return 'eliminated';
    }
    const itemRace = ITEM_RACE_PRESENTATIONS[contest.rules?.type];
    if (itemRace) return itemRace.score;
    return `${result.score} points`;
}

export function formatContestBossbar(contest, leader, now = Date.now()) {
    const remaining = formatContestTime((contest.deadlineAt ?? now) - now);
    const leaderText = leader?.participantId
        ? ` · Leader: ${leader.participantId}${
            formatContestScore(contest, leader)
                ? ` (${formatContestScore(contest, leader)})`
                : ''
        }`
        : ' · No leader yet';
    return `${contest.title} · ${remaining}${leaderText}`;
}

export function formatSurvivorBossbar(state, deadlineAt = null, now = Date.now()) {
    if (!state) return 'Survivor · Waiting';
    const active = state.participantIds.filter(id => state.players[id].active).length;
    const timer = Number.isFinite(deadlineAt)
        ? ` · ${formatContestTime(deadlineAt - now)}`
        : '';
    const immunity = state.immunityIds?.length
        ? ` · Immune: ${state.immunityIds.join(', ')}`
        : '';
    return `Survivor · Round ${state.round} · ${state.phase.replaceAll('_', ' ')} · ${active} left${timer}${immunity}`;
}

function rankedResults(contest) {
    const results = [...(contest.results || [])]
        .filter(result => result.rank !== null)
        .sort((left, right) =>
            (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
            || left.participantId.localeCompare(right.participantId)
        );
    const teamMode = contest.rules?.type === 'team_tower_battle'
        || contest.rules?.type === 'team_base_siege'
        || (
            contest.rules?.type === 'cake_race'
            && results.some(result => result.details?.teamName)
        );
    if (!teamMode) return results;
    const byTeam = new Map();
    for (const result of results) {
        const teamName = result.details?.teamName;
        if (teamName && !byTeam.has(teamName)) {
            byTeam.set(teamName, { ...result, participantId: teamName });
        }
    }
    if (byTeam.size === 0) return results;
    const teams = [...byTeam.values()].sort((left, right) =>
        right.score - left.score || left.participantId.localeCompare(right.participantId)
    );
    let priorScore = null;
    let priorRank = 0;
    return teams.map((result, index) => {
        const rank = result.score === priorScore ? priorRank : index + 1;
        priorScore = result.score;
        priorRank = rank;
        return { ...result, rank };
    });
}

function formatWinnerCoordinates(contest) {
    const winnerId = contest?.winnerIds?.[0];
    const position = contest?.submissions?.[winnerId]?.payload?.position;
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return '';
    const coordinate = value => Number.isInteger(value) ? value : value.toFixed(1);
    return `X ${coordinate(position.x)} · Y ${coordinate(position.y)} · Z ${coordinate(position.z)}`;
}

export class ContestHud {
    constructor(options = {}) {
        this.runCommand = options.runCommand || runMinecraftCommand;
        this.getLeader = options.getLeader || (async () => null);
        this.clock = options.clock || (() => Date.now());
        this.leaderRefreshMs = options.leaderRefreshMs ?? 10_000;
        this.contestId = null;
        this.leader = null;
        this.leaderContestId = null;
        this.nextLeaderRefreshAt = 0;
        this.leaderPromise = null;
        this.lastUrgentSecond = null;
        this.operation = Promise.resolve();
    }

    sync(view) {
        const operation = this.operation.then(
            () => this._sync(view),
            () => this._sync(view)
        );
        this.operation = operation.catch(() => {});
        return operation;
    }

    async _sync(view) {
        const active = view?.activeContest;
        if (active?.status === 'running') {
            if (this.contestId !== active.id) {
                if (this.contestId) await this._removeBossbar();
                await this._announceStart(active);
                this.contestId = active.id;
                this.leader = null;
                this.leaderContestId = active.id;
                this.nextLeaderRefreshAt = 0;
                this.lastUrgentSecond = null;
            }
            await this._announceTick(active);
            return;
        }

        if (!this.contestId) return;
        const finished = (view?.contests || []).find(contest => contest.id === this.contestId);
        if (finished?.status === 'completed') {
            await this._announceCompleted(finished);
        } else if (finished?.status === 'cancelled') {
            await this._announceCancelled(finished);
        } else {
            await this._removeBossbar();
        }
        this.contestId = null;
        this.leader = null;
        this.leaderContestId = null;
        this.lastUrgentSecond = null;
    }

    async _announceStart(contest) {
        const maxSeconds = Math.max(1, Math.ceil(contest.durationMs / 1000));
        const competitors = ['team_tower_battle', 'team_base_siege', 'cake_race'].includes(contest.rules?.type)
            && contest.metadata?.gameSession?.teamNames?.length === 2
            ? contest.metadata.gameSession.teamNames.join(' vs ')
            : contest.participantIds.join(' vs ');
        await this._commands([
            `bossbar remove ${BOSSBAR_ID}`,
            `bossbar add ${BOSSBAR_ID} ${textComponent(contest.title, { color: 'gold', bold: true })}`,
            `bossbar set ${BOSSBAR_ID} players ${ALL_PLAYERS}`,
            `bossbar set ${BOSSBAR_ID} max ${maxSeconds}`,
            `bossbar set ${BOSSBAR_ID} value ${maxSeconds}`,
            `bossbar set ${BOSSBAR_ID} color yellow`,
            `bossbar set ${BOSSBAR_ID} style progress`,
            `title ${ALL_PLAYERS} times 10 80 20`,
            `title ${ALL_PLAYERS} title ${textComponent('GAME ON!', { color: 'gold', bold: true })}`,
            `title ${ALL_PLAYERS} subtitle ${textComponent(
                `${contest.title} · ${formatContestTime(contest.durationMs)}`,
                { color: 'yellow' }
            )}`,
            `playsound entity.ender_dragon.growl master ${ALL_PLAYERS} ~ ~ ~ 0.6 1.3 1`,
            `tellraw ${ALL_PLAYERS} ${textComponent(
                `[${contest.title}] ${competitors} — ${formatContestTime(contest.durationMs)} starts now!`,
                { color: 'gold', bold: true }
            )}`,
        ]);
    }

    async _announceTick(contest) {
        const now = this.clock();
        const remainingMs = Math.max(0, (contest.deadlineAt ?? now) - now);
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
        const visibleLeader = this.leaderContestId === contest.id ? this.leader : null;
        await this._commands([
            `bossbar set ${BOSSBAR_ID} value ${remainingSeconds}`,
            `bossbar set ${BOSSBAR_ID} name ${textComponent(
                formatContestBossbar(contest, visibleLeader, now),
                { color: remainingSeconds <= 10 ? 'red' : 'yellow', bold: true }
            )}`,
        ]);

        if (
            remainingSeconds > 0
            && remainingSeconds <= 10
            && remainingSeconds !== this.lastUrgentSecond
        ) {
            this.lastUrgentSecond = remainingSeconds;
            await this._commands([
                `title ${ALL_PLAYERS} actionbar ${textComponent(
                    `${remainingSeconds} SECOND${remainingSeconds === 1 ? '' : 'S'}!`,
                    { color: 'red', bold: true }
                )}`,
                `playsound block.note_block.hat master ${ALL_PLAYERS} ~ ~ ~ 0.8 ${
                    remainingSeconds <= 3 ? 1.8 : 1.2
                } 1`,
            ]);
        }

        if (now >= this.nextLeaderRefreshAt && !this.leaderPromise) {
            this.nextLeaderRefreshAt = now + this.leaderRefreshMs;
            this.leaderPromise = this.getLeader(contest)
                .then(leader => {
                    if (this.contestId === contest.id) {
                        this.leader = leader;
                        this.leaderContestId = contest.id;
                    }
                })
                .catch(error => {
                    console.warn(`Could not refresh contest leader: ${error.message}`);
                })
                .finally(() => {
                    this.leaderPromise = null;
                });
        }
    }

    async _announceCompleted(contest) {
        const teamMode = ['team_tower_battle', 'team_base_siege', 'cake_race'].includes(contest.rules?.type)
            && rankedResults(contest).some(result => result.details?.teamName);
        const winners = teamMode
            ? rankedResults(contest).filter(result => result.rank === 1)
                .map(result => result.participantId)
            : contest.winnerIds || [];
        const winnerResults = rankedResults(contest).filter(result => result.rank === 1);
        const itemRace = ITEM_RACE_PRESENTATIONS[contest.rules?.type];
        const winnerLabel = itemRace
            ? itemRace.winnerLabel
            : winners.length > 1 ? 'TIE!' : 'WINNER!';
        const names = winners.length > 0 ? winners.join(' & ') : 'No winner';
        const score = winnerResults[0] ? formatContestScore(contest, winnerResults[0]) : '';
        const coordinates = formatWinnerCoordinates(contest);
        const subtitle = itemRace && winners.length > 0
            ? `${names} WINS!${coordinates ? ` · ${coordinates}` : ''}`
            : score ? `${names} · ${score}` : names;
        const titleColor = itemRace?.titleColor || 'green';
        const resultLines = rankedResults(contest).map(result => {
            const resultScore = formatContestScore(contest, result);
            return `${result.rank}. ${result.participantId}${resultScore ? ` — ${resultScore}` : ''}`;
        });

        await this._commands([
            `bossbar remove ${BOSSBAR_ID}`,
            `title ${ALL_PLAYERS} times 10 120 30`,
            `title ${ALL_PLAYERS} title ${textComponent(winnerLabel, { color: titleColor, bold: true })}`,
            `title ${ALL_PLAYERS} subtitle ${textComponent(subtitle, { color: 'gold', bold: true })}`,
            `playsound ui.toast.challenge_complete master ${ALL_PLAYERS} ~ ~ ~ 1 1 1`,
            ...(itemRace ? [
                `playsound entity.firework_rocket.large_blast master ${ALL_PLAYERS} ~ ~ ~ 1 1 1`,
                `playsound entity.player.levelup master ${ALL_PLAYERS} ~ ~ ~ 1 1.4 1`,
            ] : []),
            `tellraw ${ALL_PLAYERS} ${textComponent(
                `[${contest.title}] ${winnerLabel} ${subtitle}`,
                { color: titleColor, bold: true }
            )}`,
            ...resultLines.map(line =>
                `tellraw ${ALL_PLAYERS} ${textComponent(line, { color: 'yellow' })}`
            ),
        ]);
    }

    async _announceCancelled(contest) {
        await this._commands([
            `bossbar remove ${BOSSBAR_ID}`,
            `title ${ALL_PLAYERS} title ${textComponent('GAME CANCELLED', { color: 'red', bold: true })}`,
            `title ${ALL_PLAYERS} subtitle ${textComponent(
                contest.cancellationReason || contest.title,
                { color: 'gray' }
            )}`,
            `tellraw ${ALL_PLAYERS} ${textComponent(
                `[${contest.title}] Game cancelled: ${contest.cancellationReason || 'Cancelled'}`,
                { color: 'red' }
            )}`,
        ]);
    }

    async _removeBossbar() {
        await this._commands([`bossbar remove ${BOSSBAR_ID}`]);
    }

    async _commands(commands) {
        for (const command of commands) {
            try {
                await this.runCommand(command);
            } catch (error) {
                console.warn(`Could not update contest HUD: ${error.message}`);
            }
        }
    }
}
