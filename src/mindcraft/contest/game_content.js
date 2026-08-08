export const GAME_CONTENT_SYSTEM_PROMPT = [
    'You are competing in a Minecraft game that is being recorded for an audience.',
    'Give your commentary a distinct point of view rooted in YOUR PERSONALITY and your own approach to this game.',
    'At the start, name your signature strategy in one short sentence.',
    'After that, use one short sentence only when you make a decision, learn something new, change plans, attempt a mind game, or react to a meaningful event.',
    'Never say numeric coordinates aloud. If you need someone to meet at coordinates, name the place vaguely in your own words and use different wording every time, such as "meet me at the usual place" or "head to that hidden clearing". Never reuse a location phrase you have already said. Keep the numbers only in commands.',
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

export function pickTeamAttacker(teamMembers = [], captainId = null) {
    return teamMembers.find(name =>
        typeof name === 'string' && name.trim() && name !== captainId
    ) || null;
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
    attackerId = null,
    contestType = 'team_tower_battle',
}) {
    if (contestType === 'team_base_siege') {
        return buildBaseSiegePlanningDirective({
            title,
            presetPrompt,
            planningMs,
            participantName,
            teamId,
            teammateIds,
            enemyIds,
            captainId,
        });
    }
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
        attackerId
            ? `${attackerId} is the ATTACKER. This is a required PVP role: when the match starts, they go directly to the enemy tower, attack its builders, and break its supporting blocks. They do not switch to building unless the enemy tower is already destroyed.`
            : 'Assign one teammate as the ATTACKER. Attacking the enemy tower is required, not optional.',
        `Use !startConversation with ${teammateIds.join(' and ') || 'your team'} right now and settle three things:`,
        '1. THE BASE: one exact x z coordinate where the whole team stacks. Put the numbers only in the conversation command, never in spoken dialogue. Out loud, refer to that base vaguely in your own words and phrase it differently every time you mention it.',
        `2. THE ROLES: ${attackerId || 'the assigned attacker'} attacks and dismantles the enemy tower for the whole match. Every other teammate is a BUILDER and works only on your one shared tower. Nobody starts a personal structure and nobody just guards.`,
        '3. THE REGROUP RULE: if you die or get knocked away, you return to that same base. Nobody ever starts a second tower.',
        isCaptain
            ? 'You are the captain and lead builder. Open the conversation first, put your current x and z only in the conversation command as the base, and call that base out loud with a vague phrase of your own, worded differently each time. Get an explicit yes from every builder that they will place only onto your structure, and an explicit confirmation from the attacker that they will assault the enemy tower.'
            : participantName === attackerId
                ? 'YOU ARE THE ATTACKER. Quickly confirm the agreed spot without saying its numbers, then confirm your attack role. At the countdown, ignore building materials and immediately cross the arena to destroy the enemy tower and fight its builders.'
                : 'Confirm the captain\'s base and your BUILDER role. At the countdown, go to the captain and place blocks only when they touch the shared team tower. Never place a new foundation on bare ground.',
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

export function buildBaseSiegePlanningDirective({
    title = 'Base Siege',
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
        `PLANNING PHASE — ${title}. The fight clock is NOT running yet.`,
        `You have about ${seconds} seconds to agree on a plan. A short BUILD phase comes next, then open combat.`,
        `YOUR TEAM: ${teamId}. Your teammates are ${teammateList}.`,
        'Win condition: last team with anyone alive. Death eliminates you permanently. Hiding forever fails — if both teams survive the fight timer, the arena shrinks and combat continues.',
        captainId
            ? `${captainId} is the team captain and has the final word. Settle disagreements in one line, then commit.`
            : 'Pick one teammate as captain immediately and commit to their call.',
        `Use !startConversation with ${teammateIds.join(' and ') || 'your team'} right now and settle:`,
        '1. THE BASE: one exact x z coordinate for a quick fort. Put numbers only in the conversation command, never in spoken dialogue.',
        '2. THE ROLES: who builds walls/cover in the build phase, and who rushes out to hunt when combat starts.',
        '3. THE ATTACK PLAN: do not agree to turtle forever. Name how you will find and kill the other team.',
        isCaptain
            ? 'You are the captain. Open first, put your current x and z only in the conversation command as the base, and get a yes from every teammate.'
            : 'Confirm the captain\'s base and your role. Be ready to build fast when the build phase starts.',
    ];
    if (presetPrompt) lines.push(`MATCH RULES FOR REFERENCE: ${presetPrompt}`);
    if (enemyIds.length > 0) {
        lines.push(`The opposing team is ${enemyIds.join(', ')}. Do not talk to them or reveal your base during planning.`);
    }
    lines.push(
        'During planning: do NOT place or break blocks, do not attack anyone, and stay near your team.',
        'Use !endConversation as soon as the plan is set. Then say one short line naming your team\'s plan for the audience.'
    );
    return lines.join('\n');
}

export function buildBaseSiegeBuildDirective({
    title = 'Base Siege',
    buildPhaseMs = 0,
    participantName,
    teamId,
    teammateIds = [],
    enemyIds = [],
    captainId = null,
}) {
    const seconds = Math.max(1, Math.round(buildPhaseMs / 1000));
    const lines = [
        `BUILD PHASE — ${title}. You have about ${seconds} seconds to build the quickest useful base.`,
        `YOUR TEAM: ${teamId}. Teammates: ${teammateIds.join(', ') || 'none'}.`,
        captainId
            ? `Build at ${captainId}'s agreed base. Walls, cover, and a high ground or doorway beat empty ground.`
            : 'Build at the base your team agreed on during planning.',
        'Do NOT attack enemies yet. Do not wander across the arena. Place blocks fast, then be ready to fight.',
        'When combat starts, hunting the other team matters more than perfect walls. A tiny fort plus aggression beats a mansion of cowards.',
    ];
    if (enemyIds.length > 0) {
        lines.push(`Enemies (${enemyIds.join(', ')}) are building too. Stay on your side until the fight starts.`);
    }
    lines.push(`${participantName}, place blocks now. Say one short line about what you are building, then keep stacking.`);
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
    const isAttacker = team.attackerId === participantName;
    const isBaseSiege = team.contestType === 'team_base_siege';
    const isCakeRace = team.contestType === 'cake_race';
    const isSpleef = team.contestType === 'spleef';
    const lines = [
        presetPrompt,
        `COMPETITORS: ${participantIds.join(', ')}.`,
        'Choose a signature strategy that fits your personality and differs from the obvious default approach.',
        'Say that strategy out loud once near the start. Later, only narrate new decisions, discoveries, tradeoffs, or changes to the plan; never recycle earlier lines or talking points.',
    ];
    if (isSpleef) {
        lines.push(
            `ACTIVE RIVALS: ${rivals.join(', ') || 'none'}.`,
            'The server starts !playSpleef(100) for you automatically. Keep that action running until you fall or win.'
        );
    } else if (team.teamId && isCakeRace) {
        lines.push(
            `YOUR TEAM: ${team.teamId}. Your teammates are ${teammates.join(', ') || 'none'}.`,
            `Enemy team: ${rivals.join(', ') || 'the other side'}.`,
            'Split the cake ingredients across teammates (milk, sugar cane, eggs, wheat), share what you gather, and craft as soon as your team has three milk buckets, two sugar, one egg, and three wheat.',
            'Any teammate crafting the cake wins for the whole team. Prefer !startConversation for short handoffs with teammates; do not give ingredients or help to the enemy.',
        );
    } else if (team.teamId && isBaseSiege) {
        lines.push(
            `YOUR TEAM: ${team.teamId}. Your teammates are ${teammates.join(', ') || 'none'}.`,
            team.captainId
                ? `${team.captainId} called the base. Use that fort as cover, then leave it to hunt.`
                : 'Use the base your team agreed on as cover, then hunt.',
            'COMBAT IS ON. Death eliminates you permanently. Kill every enemy. Friendly fire is off.',
            `Hunt ${rivals.join(', ') || 'the other team'} with !attackPlayer. Do not turtle forever — if the timer ends with both teams alive, the arena shrinks and you fight again in a tighter space.`,
            'Coordinate with !startConversation only for a short tactical update, then resume fighting.'
        );
    } else if (team.teamId) {
        lines.push(
            `YOUR TEAM: ${team.teamId}. Your teammates are ${teammates.join(', ') || 'none'}.`,
            'Go straight to the single tower base your team agreed on during planning and add to that tower. Only your team\'s tallest single tower scores, so never start a second one — if you get separated, walk back to the agreed base.',
            team.captainId
                ? `${team.captainId} is your captain and calls the tower location. Follow that call even if you would have picked a different spot.`
                : 'Follow the tower location your team already agreed on.',
            team.attackerId
                ? `${team.attackerId} is your team's dedicated ATTACKER; everyone else is a BUILDER. These roles are mandatory for the whole match.`
                : 'One teammate must attack the enemy tower while everyone else builds the shared tower.',
            isAttacker
                ? `YOU ARE THE ATTACKER. Go directly to the enemy team (${rivals.join(', ')}) now. Use !attackPlayer on an enemy builder, then use !clearArea with the coordinates of the enemy tower's lowest reachable supporting blocks. Keep attacking and dismantling; do not build a separate tower and do not return to routine building while an enemy tower stands.`
                : 'YOU ARE A BUILDER. Go to the captain\'s base and build UP only on the one structure the captain starts. Your first and every later block must touch that shared tower; never place a new foundation on bare ground. If you cannot find it, regroup with the captain before placing anything.',
            'Coordinate with !startConversation only for a short tactical update, then immediately resume your assigned job.',
            isAttacker
                ? 'Never attack a teammate. Ignore friendly structures and keep pressure on the opposing tower.'
                : 'Never attack a teammate. Build onto the same team structure, make room for each other, and keep paths and standing room open.'
        );
    }
    if (rivals.length > 0 && !isSpleef && !isCakeRace) {
        lines.push(
            `Your rivals are ${rivals.join(', ')}. Occasionally use !startConversation for a brief mind game with one of them when there is a strategic reason.`,
            'Probe, predict, bluff, misdirect, bargain, or challenge their strategy. A playful jab is fine sometimes, but do not turn every conversation into a roast.',
            'Share only what helps your mind game, use !endConversation after one or two fresh lines, then return to executing your own plan.'
        );
    }
    return lines.join('\n');
}
