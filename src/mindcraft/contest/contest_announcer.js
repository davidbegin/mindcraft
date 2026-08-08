import {
    buildSeriesIntermissionAnnouncement,
    buildSeriesResultAnnouncement,
    formatSeriesLabel,
} from './series.js';

export const CONTEST_NARRATOR_CHARACTER = Object.freeze({
    name: 'narrator',
    voice: 'Narrator',
});

export function buildContestStartAnnouncement(contest) {
    const title = String(contest?.title || 'Game').trim();
    const series = contest?.metadata?.series;
    if (series?.bestOf > 1) {
        const label = formatSeriesLabel(series);
        return `${title}. ${label}. Three. Two. One. Go!`;
    }
    return `${title} starting. Three. Two. One. Go!`;
}

export function buildPlanningAnnouncement(contest, planningMs) {
    const title = String(contest?.title || 'Game').trim();
    const seconds = Math.max(1, Math.round(Number(planningMs) / 1000));
    if (contest?.rules?.type === 'team_base_siege') {
        return `${title}. Teams, you have ${seconds} seconds to plan. `
            + 'Captain, call one quick base. Agree who builds and who hunts. '
            + 'Balance offense and defense. Hiding forever loses — the arena will shrink if both teams survive. No building until the build phase.';
    }
    if (contest?.rules?.type === 'cake_race') {
        return `${title}. Teams, you have ${seconds} seconds to plan. `
            + 'Split the ingredients — milk, wheat, sugar cane, and eggs — across your teammates and pick one crafter. '
            + 'First team to bake a cake wins. No gathering until the countdown.';
    }
    return `${title}. Teams, you have ${seconds} seconds to plan. `
        + 'Captain, call one shared tower base. Assigned attacker, confirm you will destroy the enemy tower. '
        + 'Builders stay home to raise and defend that one structure. Balance offense and defense. No building until the countdown.';
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

// A profile's model is stored either as a bare slug or as a settings object,
// so both shapes collapse to the readable name the audience should hear.
function formatModelName(model) {
    if (!model) return null;
    if (typeof model === 'string') return model.trim() || null;
    if (typeof model === 'object') {
        const label = model.model || model.api;
        return label ? String(label).trim() || null : null;
    }
    return null;
}

// The game session manager stamps each competitor's model onto the contest
// metadata, so the winner announcement can name the LLM, not just the handle.
function buildParticipantModelMap(contest) {
    const participants = contest?.metadata?.gameSession?.participants;
    const map = new Map();
    if (Array.isArray(participants)) {
        for (const participant of participants) {
            const name = String(participant?.name || '').trim();
            const model = formatModelName(participant?.model);
            if (name && model) map.set(name, model);
        }
    }
    return map;
}

// "billy, playing gpt-4o" when the model is known, otherwise just the name, so
// callers without model metadata degrade to the plain handle.
export function describeCompetitor(name, model) {
    const label = formatModelName(model);
    return label ? `${name}, playing ${label}` : String(name);
}

function joinCompetitors(names, models) {
    return joinNames(names.map(name => describeCompetitor(name, models.get(name))));
}

export function buildContestResultAnnouncement(contest) {
    const models = buildParticipantModelMap(contest);
    const winningTeams = [...new Set(
        (contest.results || [])
            .filter(result => result.rank === 1)
            .map(result => result.details?.teamName)
            .filter(Boolean)
    )];
    if (
        ['team_tower_battle', 'team_base_siege', 'cake_race'].includes(contest?.rules?.type)
        && winningTeams.length > 0
    ) {
        if (winningTeams.length === 1) {
            const teamWinnerIds = [...new Set(
                (contest.results || [])
                    .filter(result => result.rank === 1 && result.participantId)
                    .map(result => result.participantId)
            )];
            const roster = teamWinnerIds.some(name => models.has(name))
                ? ` That's ${joinCompetitors(teamWinnerIds, models)}.`
                : '';
            return `And the winning team is... ${winningTeams[0]}! ${winningTeams[0]} wins!${roster}`;
        }
        return `The game ends in a tie between ${winningTeams.join(' and ')}!`;
    }
    const winners = Array.isArray(contest?.winnerIds) ? contest.winnerIds.filter(Boolean) : [];
    if (winners.length === 0) return 'Game over. There was no winner.';
    if (winners.length === 1) {
        return `And the winner is... ${describeCompetitor(winners[0], models.get(winners[0]))}! `
            + `${winners[0]} wins!`;
    }
    const names = winners.join(' and ');
    return `And the winners are... ${joinCompetitors(winners, models)}! ${names} win!`;
}

function joinNames(names) {
    if (names.length <= 1) return names[0] || '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// The host reads the question out loud before the bots answer it. Naming one or
// two targets keeps it conversational; a question put to the whole tribe reads
// better without a roll call in front of it.
export function buildCouncilQuestionAnnouncement(question) {
    const prompt = String(question?.prompt || '').trim();
    if (!prompt) return null;
    const targets = (question?.targetIds || []).map(id => String(id || '').trim()).filter(Boolean);
    return targets.length > 0 && targets.length <= 2
        ? `${joinNames(targets)}. ${prompt}`
        : prompt;
}

// Spoken when the season moves into a phase the audience needs narrated.
// Returns null for phases that announce themselves some other way (challenges
// run through the contest announcer, eliminations through onEliminated).
export function buildSurvivorPhaseAnnouncement(state) {
    const tied = joinNames(state?.tiedIds || []);
    switch (state?.phase) {
        case 'strategy':
            return state.merged
                ? 'Everyone is vulnerable tonight. Get to work before Tribal Council.'
                : `${state.councilTribe}, I will see you at Tribal Council tonight.`;
        case 'tribal_council':
            return 'Tribal Council is now in session. '
                + 'Nobody votes until I close council.';
        case 'voting':
            return 'Council is closed. It is time to vote.';
        case 'revote':
            return `We have a tie between ${tied}. `
                + `Everyone else votes again, and you may only vote for ${tied}.`;
        case 'deadlock':
            return `Still deadlocked between ${tied}. `
                + 'Talk it out. It has to be unanimous, or everyone without immunity draws rocks.';
        case 'fire_making':
            return `${tied} will make fire.`;
        case 'jury_questioning':
            return `Final Tribal Council. The final ${state.finalistIds.length} are `
                + `${joinNames(state.finalistIds)}. Jury, it is time to question them.`;
        case 'jury_voting':
            return 'Jurors, it is time to vote for the Sole Survivor.';
        case 'finalist_tiebreak':
            return 'The jury is deadlocked. The remaining vote breaks the tie.';
        default:
            return null;
    }
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

    // The pause after the callout is deliberate — it gives the spoken line time
    // to land before the bots move — but it looked identical to a hang, so the
    // wait is counted down out loud to whoever is watching the dashboard.
    async announceStart(contest, options = {}) {
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
        onProgress?.('Speaking the start announcement');
        await this.speak(buildContestStartAnnouncement(contest));
        let remaining = Math.max(0, this.startDelayMs);
        while (remaining > 0) {
            onProgress?.(`Starting in ${Math.ceil(remaining / 1000)}…`);
            const slice = Math.min(1000, remaining);
            await this.sleep(slice);
            remaining -= slice;
        }
    }

    async announceResult(contest) {
        await this.speak(buildContestResultAnnouncement(contest), { delivery: 'booming' });
    }

    async announceSeriesIntermission(series, contest = null) {
        const winnerIds = contest?.winnerIds || series?.matches?.at(-1)?.winnerIds || [];
        await this.speak(buildSeriesIntermissionAnnouncement(series, winnerIds));
    }

    async announceSeriesResult(series) {
        await this.speak(buildSeriesResultAnnouncement(series), { delivery: 'booming' });
    }
}
