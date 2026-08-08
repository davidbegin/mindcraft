// What a castaway knows, written the way they would remember it.
//
// Survivor is not won by surviving; it is won by the jury of people you voted
// out. So every bot needs two records in front of it at all times: what was said
// in public (which the jury heard too, and holds against you) and what was said
// to it in private (which only it and its allies heard). This module rebuilds
// both from the event log so nothing has to be duplicated onto the bots
// themselves, and so a bot can never accidentally read a room it was not in.

const DEFAULT_COUNCIL_ROUNDS = 3;
const DEFAULT_PRIVATE_LINES = 30;

function playerName(id) {
    return String(id ?? 'someone');
}

function truncate(text, limit) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// Councils are rebuilt from the log rather than read off state.council, because
// state.council only holds the one in session and the useful grudges are older.
export function collectCouncilRecord(game) {
    const councils = [];
    const byId = new Map();
    for (const event of game?.events || []) {
        if (event.type === 'council.opened') {
            const council = {
                councilId: event.councilId,
                kind: event.kind,
                round: event.round,
                attendeeIds: event.attendeeIds || [],
                questions: [],
            };
            councils.push(council);
            byId.set(event.councilId, council);
            continue;
        }
        if (event.type === 'council.question') {
            byId.get(event.councilId)?.questions.push({
                id: event.id,
                prompt: event.prompt,
                targetIds: event.targetIds || [],
                answers: [],
            });
            continue;
        }
        if (event.type === 'council.answer') {
            const question = byId.get(event.councilId)
                ?.questions.find(item => item.id === event.questionId);
            question?.answers.push({ playerId: event.playerId, answer: event.answer });
        }
    }
    return councils;
}

// Reveals are public: everyone watches Jeff read the ballots, so every bot may
// use every past vote.
export function collectVoteRecord(game) {
    return (game?.events || [])
        .filter(event => event.type === 'vote.revealed' || event.type === 'jury.vote.revealed')
        .map(event => ({
            round: event.round,
            kind: event.type === 'jury.vote.revealed' ? 'jury' : (event.phase || 'vote'),
            ballots: event.ballots || {},
        }));
}

export function buildCouncilTranscript(game, options = {}) {
    const rounds = options.rounds ?? DEFAULT_COUNCIL_ROUNDS;
    const councils = collectCouncilRecord(game);
    const recent = rounds > 0 ? councils.slice(-rounds) : councils;
    const lines = [];
    for (const council of recent) {
        const answered = council.questions.filter(question => question.answers.length > 0);
        if (answered.length === 0) continue;
        lines.push(council.kind === 'final'
            ? 'FINAL TRIBAL COUNCIL:'
            : `TRIBAL COUNCIL, ROUND ${council.round}:`);
        for (const question of answered) {
            lines.push(`  Jeff asked: ${truncate(question.prompt, 220)}`);
            for (const entry of question.answers) {
                lines.push(`    ${playerName(entry.playerId)} said: "${truncate(entry.answer, 320)}"`);
            }
        }
    }
    return lines.join('\n');
}

function votesAgainst(game, playerId) {
    const against = [];
    for (const record of collectVoteRecord(game)) {
        if (record.kind === 'jury') continue;
        const voters = Object.entries(record.ballots)
            .filter(([, targetId]) => targetId === playerId)
            .map(([voterId]) => voterId);
        if (voters.length > 0) against.push({ round: record.round, voters });
    }
    return against;
}

function votesCastBy(game, playerId) {
    const cast = [];
    for (const record of collectVoteRecord(game)) {
        if (record.kind === 'jury') continue;
        const target = record.ballots[playerId];
        if (target) cast.push({ round: record.round, target });
    }
    return cast;
}

// Private history is filtered to rooms this player was actually inside. This is
// the one hard rule in here: a bot must never be briefed on a conversation it
// was not part of.
function privateHistoryFor(privateLog, playerId, limit) {
    const lines = [];
    for (const event of privateLog || []) {
        switch (event.type) {
            case 'room.message':
                if (!(event.memberIds || []).includes(playerId)) break;
                if (event.senderId === playerId) {
                    lines.push(`  you told [${(event.memberIds || []).filter(id => id !== playerId).join(', ')}]: "${truncate(event.message, 240)}"`);
                } else {
                    lines.push(`  ${playerName(event.senderId)} told you privately: "${truncate(event.message, 240)}"`);
                }
                break;
            case 'talk.declined':
                if (event.requesterId === playerId) {
                    lines.push(`  ${playerName(event.inviteeId)} refused to talk to you${event.reason ? ` ("${truncate(event.reason, 120)}")` : ''}.`);
                } else if (event.inviteeId === playerId) {
                    lines.push(`  you refused to talk to ${playerName(event.requesterId)}.`);
                }
                break;
            case 'talk.accepted':
                if (event.requesterId === playerId) {
                    lines.push(`  ${playerName(event.inviteeId)} agreed to talk with you.`);
                }
                break;
            default:
                break;
        }
    }
    return lines.slice(-limit);
}

export const JURY_LENS = [
    'HOW YOU WIN: you do not win by outlasting people, you win because the people',
    'you voted out choose you. Every player you eliminate after the merge becomes a',
    'juror, and the jury alone picks the Sole Survivor. So every vote you cast is',
    'also a job interview with the person you just cut. Cut them in a way they can',
    'respect: own your move, explain it to their face, never insult them, never let',
    'them find out you lied about them behind their back if you can avoid it.',
    'Cowardice and cruelty both lose jury votes. Being honest about a brutal move',
    'wins them.',
].join('\n');

export function buildPlayerBriefing(game, playerId, options = {}) {
    if (!game?.players?.[playerId]) return '';
    const player = game.players[playerId];
    const privateLines = privateHistoryFor(
        options.privateLog,
        playerId,
        options.privateLineLimit ?? DEFAULT_PRIVATE_LINES
    );
    const transcript = buildCouncilTranscript(game, { rounds: options.councilRounds });
    const against = votesAgainst(game, playerId);
    const cast = votesCastBy(game, playerId);
    const sections = [];

    const jurors = game.juryIds || [];
    if (jurors.length > 0) {
        const cutByYou = cast
            .filter(entry => jurors.includes(entry.target))
            .map(entry => entry.target);
        sections.push(
            `THE JURY (${jurors.length}): ${jurors.join(', ')}. These players decide the winner.`
            + (cutByYou.length > 0
                ? ` You voted for ${cutByYou.join(', ')} — they know it, so you owe them a straight answer.`
                : ' None of them were voted out on your ballot, which you can use.')
        );
    }

    if (transcript) {
        sections.push(
            'THE PUBLIC RECORD — everyone heard this, including the jury:',
            transcript
        );
    }

    if (against.length > 0) {
        sections.push(`VOTES AGAINST YOU: ${against
            .map(entry => `round ${entry.round} — ${entry.voters.join(', ')}`)
            .join('; ')}.`);
    }
    if (cast.length > 0) {
        sections.push(`YOUR PAST VOTES: ${cast
            .map(entry => `round ${entry.round} — ${entry.target}`)
            .join('; ')}.`);
    }

    if (privateLines.length > 0) {
        sections.push(
            'YOUR PRIVATE HISTORY — only you and the people named heard this:',
            privateLines.join('\n')
        );
    }

    if (player.jury) {
        sections.push(
            'You are on the jury. You no longer play; you judge. Decide who actually'
            + ' controlled this game and who merely survived it.'
        );
    }

    return sections.join('\n');
}
