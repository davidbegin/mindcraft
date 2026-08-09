// Every word a Survivor bot is told to act on, split by the two jobs it has.
//
// A castaway is in exactly one of two modes, and they want opposite things:
//
//   CHALLENGE MODE — a Minecraft contest is running. The only goal is winning
//   that specific contest, so the directive is the contest's own rules plus what
//   winning is worth, and nothing else. No jury framing, no memory of who said
//   what at the last council, no alliance toolbox. Social context here is worse
//   than useless: it pulls a bot into scheming while a race it could win runs out.
//
//   SOCIAL MODE — every other phase. Here the game IS the talking, so the
//   directive carries the jury lens, the bot's own memory of the season, and the
//   private-talk toolbox.
//
// buildSurvivorDirective() picks the mode from the phase so callers cannot
// accidentally mix the two.

import { JURY_LENS } from './survivor_memory.js';

const PRIVATE_TALK_TOOLBOX = [
    'PRIVATE TALK IS OPEN — at camp, at the council mat, and while ballots are',
    'open. Nobody but the people you name hears it, and your room stays open until',
    'you walk out of it. It closes only while an immunity challenge is running.',
    '  !requestPrivateChat("Alice,Bob", "why they should hear you out") — asks them to step aside with you.',
    '  !acceptPrivateChat("request id") or !declinePrivateChat("request id", "reason") — you may refuse anyone.',
    '  !sendPrivateMessage("...") — talks to everyone currently in your private room.',
    '  !leavePrivateGroup() — walks out, which frees you to be pulled aside by someone else.',
    'Prefer small alliance rooms (2–4 people), not only 1:1 chats — a three-person',
    'deal is often stronger than a secret pair once votes are counted.',
    'You do not have to invite anyone. Use the toolbox when it helps; silence is also a move.',
    'Refusing to talk is a real move, and so is being refused. Note who will not meet with you.',
    'Lying in private is legal. Being caught lying is what costs you the jury, so weigh it.',
].join('\n');

// The one rule that separates a challenge from every other phase. It is stated
// as a ban rather than a suggestion because the season-long system prompt tells
// these bots to run mind games, and during a challenge that instruction loses.
function challengeFocus(merged) {
    return [
        'WHILE THE CLOCK IS RUNNING, THIS CHALLENGE IS THE WHOLE GAME:',
        '  - Play it. No alliance talk, no vote counting, no deals, no reading the jury,',
        '    no reminiscing about council. Private chat is closed until this is over.',
        merged
            ? '  - Talk only to win this challenge, and keep every line short: what you are doing\n    now, or what you just found.'
            : '  - Talk only to win this challenge, and keep every line short: what you are doing\n    now, what you just found, or what a tribemate needs to do next.',
        '  - Do not stop to argue, negotiate, bluff, or trash talk. A rival trying to start',
        '    any of that is costing you the challenge; ignore them and keep playing.',
        'The social game comes back the moment the challenge ends. Immunity is worth more',
        'than anything you could have said during it.',
    ].join('\n');
}

function activeIds(state) {
    return state.participantIds.filter(id => state.players[id].active);
}

// How the contest's raw numbers become a tribe result, in the terms that change
// what a bot should actually do: whether one strong finish carries the tribe or
// everyone has to produce.
function tribeScoringLine(contestType) {
    switch (contestType) {
        case 'cake_race':
        case 'death_race':
        case 'dog_race':
        case 'diamond_race':
        case 'netherite_race':
            return 'Your tribe is scored on its FASTEST finisher. Any one of you finishing first saves everybody, so race your own hardest and do not wait on a tribemate.';
        case 'spleef':
            return 'Your tribe is scored on whichever of you lasts LONGEST on the snow. Staying alive is your job; dropping a rival is how you shorten theirs.';
        case 'depth_race':
            return 'Your tribe is scored on the AVERAGE depth of everyone in it. One deep digger cannot carry a shallow tribe, so every tribemate has to keep descending.';
        case 'tower_battle':
            return 'Your tribe is scored on the COMBINED height of your towers. Every block any of you stacks counts, and knocking a rival down subtracts from theirs.';
        default:
            return 'Your tribe\'s result is what counts tonight, not your personal placing.';
    }
}

function challengeHeader(state, playerId) {
    const player = state.players[playerId];
    const remaining = activeIds(state);
    if (state.merged) {
        return [
            `You are ${playerId}. The tribes have merged, so this is INDIVIDUAL immunity and you play only for yourself.`,
            `Competing (${remaining.length}): ${remaining.join(', ')}.`,
        ];
    }
    const tribemates = remaining.filter(id =>
        id !== playerId && state.players[id].tribe === player.tribe
    );
    return [
        `You are ${playerId}. Tribe: ${player.tribe} — you win or lose this with ${tribemates.join(', ') || 'nobody, you are the last of your tribe'}.`,
        `Competing (${remaining.length}): ${remaining.join(', ')}.`,
    ];
}

// Sent while the round's contest is being set up, before there is a preset to
// hand out. It says only that something is coming, so a bot has no reason to go
// back to scheming in the gap.
function challengeStandbyDirective(state, playerId) {
    return [
        `IMMUNITY CHALLENGE — SURVIVOR ROUND ${state.round}. Standing by to start.`,
        challengeHeader(state, playerId).join('\n'),
        'The rules arrive the moment the challenge starts. Until then stay put, stay ready,'
        + '\nand do not start any strategy talk — this round is decided by the challenge first.',
    ].join('\n\n');
}

export function buildChallengeDirective(state, playerId, preset = null) {
    if (!preset) return challengeStandbyDirective(state, playerId);
    const stake = state.merged
        ? 'WORTH: the winner cannot be voted out tonight. Everyone else can, so nobody here has a reason to help you.'
        : 'WORTH: the winning tribe is safe. The losing tribe goes to Tribal Council alone and votes one of its own out.';
    return [
        `IMMUNITY CHALLENGE — SURVIVOR ROUND ${state.round}: ${preset.title}.`,
        challengeHeader(state, playerId).join('\n'),
        `THE CHALLENGE:\n${preset.prompt}`,
        state.merged
            ? stake
            : `${tribeScoringLine(preset.rules?.type)}\n${stake}`,
        challengeFocus(state.merged),
    ].join('\n\n');
}

// The bench, named. Repeated at the mat and before ballots because a jury the
// cast cannot name is a jury the cast does not play for.
function juryRoll(state) {
    const jurors = state.juryIds || [];
    return jurors.length > 0
        ? `The jury so far: ${jurors.join(', ')}. They pick the winner, so every name you write down is a vote you will have to justify to them.`
        : null;
}

function phaseInstructions(state, playerId) {
    const player = state.players[playerId];
    const legalTargets = state.eligibleTargetIds.filter(id => id !== playerId);
    switch (state.phase) {
        case 'strategy':
            if (!state.merged && player.tribe !== state.councilTribe) {
                return [
                    `Your tribe is safe. ${state.councilTribe} goes to Tribal Council.`,
                    'Give one short public confessional about what the result means.',
                    'Your own tribemates are still worth working — the vote that ends your game is later.',
                ];
            }
            return [
                `You are going to Tribal Council. Immunity: ${state.immunityIds.join(', ') || 'nobody'}.`,
                `Vulnerable tonight: ${state.eligibleTargetIds.join(', ')}.`,
                'This is the widest window you get to work people before the vote. Use it.',
                'Speak publicly in short confessionals too, so the audience follows your reasoning.',
            ];
        case 'tribal_council':
            return [
                'YOU ARE AT TRIBAL COUNCIL. Jeff Prompts is hosting and everything said here is PUBLIC.',
                'DO NOT VOTE YET. Voting does not open until Jeff closes council.',
                'When Jeff asks you something, answer with !answerCouncil("your answer").',
                'Every other player hears your answer and will remember it — the jury included.',
                'Answer so that the person you are about to vote out could still respect you afterwards.',
                'Listen hard to what everyone else says. You are expected to change your mind here if',
                'what comes out on the mat changes the picture. That is what council is for.',
                juryRoll(state),
                `Vulnerable tonight: ${legalTargets.join(', ') || 'nobody'}.`,
            ].filter(Boolean);
        case 'reevaluation':
            return [
                'Council is closed. Before anyone votes, reconsider the public record.',
                'What changed on the mat? Who exposed a lie, panicked, or became a better target?',
                'Say where you stand right now with !declareVoteLeaning("Name", "why"). It is not a',
                'ballot and it does not bind you — it is how the host knows the room before votes open.',
                juryRoll(state),
                `Legal targets still: ${legalTargets.join(', ')}.`,
                'DO NOT cast a ballot yet. Voting opens after this re-evaluation beat.',
            ].filter(Boolean);
        case 'voting':
        case 'revote':
            return [
                'Re-evaluation is over. Vote now.',
                'Your ballot reason should cite what happened at council when it mattered.',
                juryRoll(state),
                `Legal targets: ${legalTargets.join(', ')}.`,
                'Cast exactly one secret ballot with !castSurvivorVote("Name", "why"). Do not announce it.',
                'The reason is sealed with your ballot: no other player ever sees it, so write the',
                'real reason you are writing this name down, not the version you told them.',
                'You may keep working people privately while you decide, but the ballot comes first:',
                'a bot still whispering when the host reveals has cast nothing.',
            ].filter(Boolean);
        case 'jury_voting':
            return [
                `Vote for the winner: ${legalTargets.join(', ')}.`,
                'Judge the game that was played, not how much you liked being voted out.',
                'Cast your ballot with !castSurvivorVote("Name", "why they earned your vote").',
            ];
        case 'finalist_tiebreak':
            return [
                `The jury deadlocked. You break the tie between ${legalTargets.join(' and ')}.`,
                'Cast your ballot with !castSurvivorVote("Name", "why").',
            ];
        case 'deadlock':
            return [
                `The vote tied between ${state.tiedIds.join(' and ')} and neither can be voted again.`,
                'Talk this out in public, then use !submitDeadlockDecision("Name").',
                'It must be unanimous or everyone without immunity draws rocks.',
            ];
        case 'jury_questioning':
            return player.jury
                ? [
                    `FINAL TRIBAL COUNCIL. The final ${state.finalistIds.length} are ${state.finalistIds.join(', ')}.`,
                    'You are a juror. Jeff will put questions to you and to them; answer with !answerCouncil("...").',
                    'Make them account for the moves they made, especially the one that took you out.',
                ]
                : [
                    `FINAL TRIBAL COUNCIL. You are in the final ${state.finalistIds.length}.`,
                    `Your jury is ${state.juryIds.join(', ')} — every one of them was voted out.`,
                    'Answer Jeff with !answerCouncil("..."). This is the whole game.',
                    'Claim your moves plainly. Jurors forgive a ruthless player who owns it and',
                    'punish one who pretends they were carried along by fate.',
                ];
        case 'fire_making': {
            const decidesSeason = state.finalistIds.length > 0
                && state.tiedIds.every(id => state.finalistIds.includes(id));
            return [
                state.tiedIds.includes(playerId)
                    ? `You are in the fire-making tiebreak. Prepare to compete.${decidesSeason ? ' The winner is the Sole Survivor.' : ''}`
                    : `Watch the fire-making tiebreak between ${state.tiedIds.join(' and ')}.`,
            ];
        }
        case 'completed':
            return [`${state.winnerIds.join(', ')} is the Sole Survivor.`];
        case 'cancelled':
            return ['The season was cancelled.'];
        default:
            return [];
    }
}

export function buildSocialDirective(state, playerId, briefing = '') {
    const player = state.players[playerId];
    const remaining = activeIds(state);
    const header = [
        `SURVIVOR — ROUND ${state.round}. PHASE: ${state.phase.replaceAll('_', ' ')}.`,
        state.merged
            ? `You are ${playerId}. The tribes have merged; everyone plays for themselves.`
            : `You are ${playerId}. Tribe: ${player.tribe}.`,
        `Still in the game (${remaining.length}): ${remaining.join(', ')}.`,
    ];
    return [
        header.join('\n'),
        JURY_LENS,
        briefing,
        phaseInstructions(state, playerId).join('\n'),
        player.active ? PRIVATE_TALK_TOOLBOX : '',
    ].filter(Boolean).join('\n\n');
}

// The only entry point callers should use: the phase decides the mode, so a
// challenge can never be handed the season's social baggage.
export function buildSurvivorDirective(state, playerId, options = {}) {
    return state.phase === 'challenge'
        ? buildChallengeDirective(state, playerId, options.preset)
        : buildSocialDirective(state, playerId, options.briefing);
}
