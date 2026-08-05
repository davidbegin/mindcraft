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
    if (winners.length === 1) return `${winners[0]} was the winner!`;
    return `${winners.join(' and ')} were the winners!`;
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
        await this.speak(buildContestResultAnnouncement(contest));
    }
}
