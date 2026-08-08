export const GAME_CONTENT_SYSTEM_PROMPT = [
    'You are competing in a Minecraft game that is being recorded for an audience.',
    'Give your commentary a distinct point of view rooted in YOUR PERSONALITY and your own approach to this game.',
    'At the start, name your signature strategy in one short sentence.',
    'After that, use one short sentence only when you make a decision, learn something new, change plans, attempt a mind game, or react to a meaningful event.',
    'Never say numeric coordinates aloud. If you need someone to meet at coordinates, say exactly: "Meet me at the spot." Keep the numbers only in commands.',
    'Do not repeat a line, joke, boast, observation, or strategy explanation you have already used. If nothing has changed, keep playing instead of filling the silence.',
    'Most of your speech should reveal useful thinking: tradeoffs, predictions, discoveries, adaptations, and the next step of your unique plan.',
    'Occasionally use !startConversation for a brief strategic exchange with a rival: question their plan, make a prediction, bluff, misdirect, negotiate, or bait them into a mistake.',
    'Roasting and playful trash talk are occasional seasoning, not the subject of every exchange. Prefer clever mind games over generic insults.',
    'Do not copy another competitor\'s phrasing or commentary style. Keep each exchange to one or two fresh lines, use !endConversation, and return to the game.',
    'Keep all banter playful: no slurs, protected-trait insults, sexual harassment, or real-world threats.',
].join(' ');

export function buildGameSystemPrompt(addendum = '') {
    const extra = String(addendum || '').trim();
    return extra
        ? `${GAME_CONTENT_SYSTEM_PROMPT}\n\nSESSION-SPECIFIC ADDENDUM\n${extra}`
        : GAME_CONTENT_SYSTEM_PROMPT;
}

// The whole team scores a single tower, so a match is usually lost during the
// first thirty seconds when four bots wander off and start four stumps. The
// captain exists to end that argument fast: somebody has to name one coordinate.
export function pickTeamCaptain(teamMembers = []) {
    return teamMembers.find(name => typeof name === 'string' && name.trim()) || null;
}

export function buildTeamPlanningDirective({
    title = 'the match',
    presetPrompt = '',
    planningMs = 0,
    participantName,
    teamId,
    teammateIds = [],
    enemyIds = [],
    captainId = null,
}) {
    const seconds = Math.max(1, Math.round(planningMs / 1000));
    const teammateList = teammateIds.join(', ') || 'none';
    const isCaptain = captainId === participantName;
    const lines = [
        `PLANNING PHASE — ${title}. The match has NOT started and the clock is not running.`,
        `You have about ${seconds} seconds to agree on a plan with your team before the countdown.`,
        `YOUR TEAM: ${teamId}. Your teammates are ${teammateList}.`,
        'Scoring is what makes this urgent: only your team\'s single tallest tower counts. Two half-height towers lose to one tall tower every time, so the entire team must build on ONE tower.',
        captainId
            ? `${captainId} is the team captain and has the final word. Settle disagreements in one line, then commit to the captain's call.`
            : 'Pick one teammate as captain immediately and commit to their call.',
        `Use !startConversation with ${teammateIds.join(' and ') || 'your team'} right now and settle three things:`,
        '1. THE BASE: one exact x z coordinate where the whole team stacks. Put the numbers only in the conversation command, never in spoken dialogue. Out loud, say exactly: "Meet me at the spot."',
        '2. THE PLAN: everyone builds UP the same tower together. There are no strict jobs — no dedicated supplier and nobody parked on defense just guarding the base. Optionally, one teammate can peel off to grief the enemy tower (knock their builders off and break their blocks); everyone else keeps stacking.',
        '3. THE REGROUP RULE: if you die or get knocked away, you return to that same base. Nobody ever starts a second tower.',
        isCaptain
            ? 'You are the captain. Open the conversation first, put your current x and z only in the conversation command as the proposed base, and say "Meet me at the spot." Get an explicit yes from each teammate that they will stack that one tower with you. If someone would rather go grief the enemy tower, let them, but keep most of the team building.'
            : 'Answer the captain quickly, confirm the agreed spot without saying its numbers, and commit to building up that tower — or say so if you would rather go grief the enemy tower. Do not counter-propose more than once.',
    ];
    if (presetPrompt) lines.push(`MATCH RULES FOR REFERENCE: ${presetPrompt}`);
    if (enemyIds.length > 0) {
        lines.push(`The opposing team is ${enemyIds.join(', ')}. Do not talk to them or reveal your base during planning.`);
    }
    lines.push(
        'During planning: do NOT place or break blocks, do not attack anyone, and do not walk away from your team.',
        'Use !endConversation as soon as the plan is set so you are free when the countdown starts. Then say one short line out loud naming your team\'s plan for the audience.'
    );
    return lines.join('\n');
}

export function buildParticipantGameDirective(
    presetPrompt,
    participantIds,
    participantName,
    team = {}
) {
    const teammates = Array.isArray(team.teammateIds) ? team.teammateIds : [];
    const rivals = Array.isArray(team.enemyIds) && team.enemyIds.length > 0
        ? team.enemyIds
        : participantIds.filter(name => name !== participantName);
    const lines = [
        presetPrompt,
        `COMPETITORS: ${participantIds.join(', ')}.`,
        'Choose a signature strategy that fits your personality and differs from the obvious default approach.',
        'Say that strategy out loud once near the start. Later, only narrate new decisions, discoveries, tradeoffs, or changes to the plan; never recycle earlier lines or talking points.',
    ];
    if (team.teamId) {
        lines.push(
            `YOUR TEAM: ${team.teamId}. Your teammates are ${teammates.join(', ') || 'none'}.`,
            'Go straight to the single tower base your team agreed on during planning and add to that tower. Only your team\'s tallest single tower scores, so never start a second one — if you get separated, walk back to the agreed base.',
            team.captainId
                ? `${team.captainId} is your captain and calls the tower location. Follow that call even if you would have picked a different spot.`
                : 'Follow the tower location your team already agreed on.',
            'Everyone on your team builds UP the same tower together — no strict jobs and no teammate parked on defense just guarding. Stack blocks and race the tower higher alongside them.',
            'Optionally, one teammate can break off to grief the enemy tower — knock their builders off and break their blocks — but the rest keep stacking. Coordinate with !startConversation and share useful coordinates and plans.',
            'Never attack a teammate. Build onto the same team structure, make room for each other, and keep paths and standing room open.'
        );
    }
    if (rivals.length > 0) {
        lines.push(
            `Your rivals are ${rivals.join(', ')}. Occasionally use !startConversation for a brief mind game with one of them when there is a strategic reason.`,
            'Probe, predict, bluff, misdirect, bargain, or challenge their strategy. A playful jab is fine sometimes, but do not turn every conversation into a roast.',
            'Share only what helps your mind game, use !endConversation after one or two fresh lines, then return to executing your own plan.'
        );
    }
    return lines.join('\n');
}
