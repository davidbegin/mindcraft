export const CONTEST_NARRATOR_CHARACTER = Object.freeze({
    name: 'narrator',
    voice: 'Narrator',
});

export function buildContestStartAnnouncement(contest) {
    const title = String(contest?.title || 'Game').trim();
    return `${title} starting. Three. Two. One. Go!`;
}

export function buildPlanningAnnouncement(contest, planningMs) {
    const title = String(contest?.title || 'Game').trim();
    const seconds = Math.max(1, Math.round(Number(planningMs) / 1000));
    if (contest?.rules?.type === 'team_base_siege') {
        return `${title}. Teams, you have ${seconds} seconds to plan. `
            + 'Captain, call one quick base. Agree who builds and who hunts. '
            + 'Hiding forever loses — the arena will shrink if both teams survive. No building until the build phase.';
    }
    return `${title}. Teams, you have ${seconds} seconds to plan. `
        + 'Captain, call one shared tower base. Assigned attacker, confirm you will destroy the enemy tower. '
        + 'All builders use only the captain\'s structure. No building until the countdown.';
}

export function buildBuildPhaseAnnouncement(contest, buildPhaseMs) {
    const title = String(contest?.title || 'Game').trim();
    const seconds = Math.max(1, Math.round(Number(buildPhaseMs) / 1000));
    return `${title}. Build phase: ${seconds} seconds to raise a quick base. No attacking yet. Go!`;
}

export function buildPressureRoundAnnouncement(halfSize, pressureRound) {
    const size = Math.max(1, Math.round(Number(halfSize) * 2 + 1));
    const round = Math.max(1, Math.round(Number(pressureRound) || 1));
    return `Both teams are still alive. Pressure round ${round}. `
        + `The arena shrinks to ${size} by ${size}. No more hiding — fight!`;
}

export function buildContestResultAnnouncement(contest) {
    if (contest?.rules?.type === 'team_tower_battle' || contest?.rules?.type === 'team_base_siege') {
        const winningTeams = [...new Set(
            (contest.results || [])
                .filter(result => result.rank === 1)
                .map(result => result.details?.teamName)
                .filter(Boolean)
        )];
        if (winningTeams.length === 1) {
            return `And the winning team is... ${winningTeams[0]}! ${winningTeams[0]} wins!`;
        }
        if (winningTeams.length > 1) {
            return `The game ends in a tie between ${winningTeams.join(' and ')}!`;
        }
    }
    const winners = Array.isArray(contest?.winnerIds) ? contest.winnerIds.filter(Boolean) : [];
    if (winners.length === 0) return 'Game over. There was no winner.';
    if (winners.length === 1) {
        return `And the winner is... ${winners[0]}! ${winners[0]} wins!`;
    }
    const names = winners.join(' and ');
    return `And the winners are... ${names}! ${names} win!`;
}

export function buildSurvivorAnnouncement(event, state) {
    switch (event?.type) {
        case 'tribes.merged':
            return `Drop your buffs. The tribes have merged with ${event.playerIds.length} players remaining.`;
        case 'player.eliminated':
            return `${event.playerId}, the tribe has spoken.${event.joinsJury ? ' You are now a member of the jury.' : ''}`;
        case 'finalists.reached':
            return `The final ${event.finalistIds.length} are ${event.finalistIds.join(', ')}. `
                + 'Jury, prepare your questions.';
        case 'season.completed':
            return `${event.winnerId} is the Sole Survivor!`;
        case 'fire_making.started':
            return event.reason === 'jury-deadlock'
                ? `The jury is deadlocked. ${event.contestantIds.join(' and ')} will make fire for the title.`
                : `The vote is deadlocked. ${event.contestantIds.join(' and ')} will make fire.`;
        default:
            return state?.phase === 'voting' ? 'It is time to vote.' : null;
    }
}

export class ContestAnnouncer {
    constructor(options = {}) {
        if (typeof options.speak !== 'function') {
            throw new TypeError('speak must be a function');
        }
        this.speak = options.speak;
        this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.startDelayMs = options.startDelayMs ?? 5000;
    }

    // The manager owns the planning clock, so this only speaks the callout.
    async announcePlanning(contest, options = {}) {
        await this.speak(buildPlanningAnnouncement(contest, options.planningMs));
    }

    async announceBuildPhase(contest, options = {}) {
        await this.speak(buildBuildPhaseAnnouncement(contest, options.buildPhaseMs));
    }

    async announcePressureRound(options = {}) {
        await this.speak(buildPressureRoundAnnouncement(options.halfSize, options.pressureRound));
    }

    async announceStart(contest) {
        await this.speak(buildContestStartAnnouncement(contest));
        await this.sleep(this.startDelayMs);
    }

    async announceResult(contest) {
        await this.speak(buildContestResultAnnouncement(contest), { delivery: 'booming' });
    }
}
