export const CONTEST_NARRATOR_CHARACTER = Object.freeze({
    name: 'narrator',
    voice: 'Narrator',
});

export function buildContestStartAnnouncement(contest) {
    const title = String(contest?.title || 'Game').trim();
    return `${title} starting. Three. Two. One. Go!`;
}

export function buildContestResultAnnouncement(contest) {
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
        case 'final_three.reached':
            return `The final three are ${event.finalistIds.join(', ')}. Jury, prepare your questions.`;
        case 'season.completed':
            return `${event.winnerId} is the Sole Survivor!`;
        case 'fire_making.started':
            return `The vote is deadlocked. ${event.contestantIds.join(' and ')} will make fire.`;
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

    async announceStart(contest) {
        await this.speak(buildContestStartAnnouncement(contest));
        await this.sleep(this.startDelayMs);
    }

    async announceResult(contest) {
        await this.speak(buildContestResultAnnouncement(contest), { delivery: 'booming' });
    }
}
