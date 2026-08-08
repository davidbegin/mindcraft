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
    if (contestType === 'cake_race') {
        return buildCakeRacePlanningDirective({
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
            ? `${attackerId} is the ATTACKER (offense). When the match starts they cross to the enemy tower, fight its builders, and break supporting blocks. Everyone else stays home as BUILDER-DEFENDERS.`
            : 'Assign one teammate as the ATTACKER for offense. Everyone else builds and defends the shared tower.',
        'Win with a balance of offense and defense: one teammate pressures the enemy tower while the rest keep YOUR tower rising and protected. A full-team rush that leaves your base empty is a losing plan.',
        `Use !startConversation with ${teammateIds.join(' and ') || 'your team'} right now and settle three things:`,
        '1. THE BASE: one exact x z coordinate where the whole team stacks. Put the numbers only in the conversation command, never in spoken dialogue. Out loud, refer to that base vaguely in your own words and phrase it differently every time you mention it.',
        `2. THE ROLES: ${attackerId || 'the assigned attacker'} handles offense against the enemy tower. Every other teammate is a BUILDER-DEFENDER — stack the shared tower, fight off raiders who come to demolish it, repair damage, then keep building. Nobody starts a personal structure and nobody parks idle as a pure guard with no blocks.`,
        '3. THE REGROUP RULE: if you die or get knocked away, you return to that same base. Nobody ever starts a second tower.',
        isCaptain
            ? 'You are the captain and lead builder-defender. Open the conversation first, put your current x and z only in the conversation command as the base, and call that base out loud with a vague phrase of your own, worded differently each time. Get an explicit yes from every builder-defender that they will place only onto your structure and defend it, and an explicit confirmation from the attacker that they will assault the enemy tower.'
            : participantName === attackerId
                ? 'YOU ARE THE ATTACKER. Quickly confirm the agreed spot without saying its numbers, then confirm your offense role. At the countdown, cross the arena to destroy the enemy tower and fight its builders — you are the team\'s offense, not another home builder.'
                : 'Confirm the captain\'s base and your BUILDER-DEFENDER role. At the countdown, go to the captain, place blocks only when they touch the shared team tower, and fight enemies who attack that tower. Never place a new foundation on bare ground.',
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
}) {
    const seconds = Math.max(1, Math.round(planningMs / 1000));
    const lines = [
        `WAITING — ${title}. The build timer has NOT started yet.`,
        `Stand still for about ${seconds} seconds. Do not build, craft, dig, attack, or wander.`,
        `${participantName}, wait quietly until the build phase is announced.`,
    ];
    if (presetPrompt) lines.push(`MATCH RULES FOR REFERENCE: ${presetPrompt}`);
    return lines.join('\n');
}

export function buildCakeRacePlanningDirective({
    title = 'First Cake',
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
        'Win condition: the first team to craft a cake wins, and any teammate crafting it wins for everyone — so speed and coordination beat solo hoarding.',
        captainId
            ? `${captainId} is the team captain and has the final word. Settle disagreements in one line, then commit.`
            : 'Pick one teammate as captain immediately and commit to their call.',
        `Use !startConversation with ${teammateIds.join(' and ') || 'your team'} right now and settle:`,
        '1. THE INGREDIENT SPLIT: divide the shopping list — three milk buckets from cows, three wheat, two sugar from sugar cane, and one egg from chickens — so no two teammates chase the same thing.',
        '2. THE CRAFTER: name one teammate who camps a crafting table; everyone else funnels ingredients to that person the moment they have them.',
        '3. THE HANDOFF: agree how you will pass items — meet at the crafter, drop items, and call it out — so the full set lands in one inventory fast.',
        isCaptain
            ? 'You are the captain. Open the conversation first, assign each teammate an ingredient, and get an explicit yes on who crafts.'
            : 'Confirm the captain\'s ingredient assignment for you and who the crafter is, then commit to running your items to them.',
    ];
    if (presetPrompt) lines.push(`MATCH RULES FOR REFERENCE: ${presetPrompt}`);
    if (enemyIds.length > 0) {
        lines.push(`The opposing team is ${enemyIds.join(', ')}. Do not talk to them, hand them ingredients, or reveal your plan during planning.`);
    }
    lines.push(
        'During planning: do NOT gather, milk, harvest, or craft anything — the clock is not running yet — and stay near your team.',
        'Use !endConversation as soon as the plan is set. Then say one short line naming your team\'s cake plan for the audience.'
    );
    return lines.join('\n');
}

export function buildBaseSiegeBuildDirective({
    title = 'Base Siege',
    buildPhaseMs = 0,
    participantName,
    rivalIds = [],
}) {
    const seconds = Math.max(1, Math.round(buildPhaseMs / 1000));
    const lines = [
        `BUILD PHASE — ${title}. The timer is live: you have about ${seconds} seconds.`,
        'Use this time to fortify cover on the main platform and craft better weapons or armor.',
        'Do NOT attack anyone yet. Stay on the main platform — leaving the platform or falling off loses later in combat.',
        'When the timer ends, combat starts and hiding forever is not allowed.',
    ];
    if (rivalIds.length > 0) {
        lines.push(`Rivals (${rivalIds.join(', ')}) are building too. Prepare to fight them when combat begins.`);
    }
    lines.push(`${participantName}, build and craft now. Say one short line about your fort or gear, then keep working.`);
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
    const isHotButton = team.contestType === 'hot_button';
    const isDeathRace = team.contestType === 'death_race';
    const lines = [
        presetPrompt,
        `COMPETITORS: ${participantIds.join(', ')}.`,
        'Choose a signature strategy that fits your personality and differs from the obvious default approach.',
        'Say that strategy out loud once near the start. Later, only narrate new decisions, discoveries, tradeoffs, or changes to the plan; never recycle earlier lines or talking points.',
    ];
    if (isDeathRace) {
        lines.push(
            'Speed wins. Sprint to the outer rim and run off the edge now.',
            'Use !goToCoordinates toward the barrier wall with closeness 0, or !searchForBlock("lava") to drop into the rim. Do not place or spawn anything.'
        );
    }
    if (isSpleef) {
        lines.push(
            `ACTIVE RIVALS: ${rivals.join(', ') || 'none'}.`,
            'The server starts !playSpleef(100) for you automatically. Keep that action running until you fall or win.'
        );
    } else if (isHotButton) {
        lines.push(
            `ACTIVE RIVALS: ${rivals.join(', ') || 'none'}.`,
            'Walk to an unused stone button and press it. All but one station explode — and the blast kills anyone nearby. The safe button wins the match the instant you press it. Refusing to press loses at the buzzer.',
            'The server starts !playHotButton for you automatically. Keep that action running until you explode, win, or time runs out.'
        );
    } else if (team.teamId && isCakeRace) {
        lines.push(
            `YOUR TEAM: ${team.teamId}. Your teammates are ${teammates.join(', ') || 'none'}.`,
            `Enemy team: ${rivals.join(', ') || 'the other side'}.`,
            'Split the cake ingredients across teammates (milk, sugar cane, eggs, wheat), share what you gather, and craft as soon as your team has three milk buckets, two sugar, one egg, and three wheat.',
            'Any teammate crafting the cake wins for the whole team. Prefer !startConversation for short handoffs with teammates; do not give ingredients or help to the enemy.',
        );
    } else if (isBaseSiege) {
        lines.push(
            `ACTIVE RIVALS: ${rivals.join(', ') || 'none'}.`,
            'COMBAT IS ON. Last person alive wins. Death eliminates you permanently.',
            'Stay on the main platform. Falling below the floor or leaving the arena bounds eliminates you immediately.',
            `Hunt ${rivals.join(', ') || 'every rival'} with !attackPlayer. You are not allowed to hide — leave cover to fight and finish them.`
        );
    } else if (team.teamId) {
        lines.push(
            `YOUR TEAM: ${team.teamId}. Your teammates are ${teammates.join(', ') || 'none'}.`,
            'Go straight to the single tower base your team agreed on during planning and add to that tower. Only your team\'s tallest single tower scores, so never start a second one — if you get separated, walk back to the agreed base.',
            team.captainId
                ? `${team.captainId} is your captain and calls the tower location. Follow that call even if you would have picked a different spot.`
                : 'Follow the tower location your team already agreed on.',
            team.attackerId
                ? `${team.attackerId} is your team's dedicated ATTACKER (offense); everyone else is a BUILDER-DEFENDER. Keep that offense-defense split for the whole match — do not all rush the enemy.`
                : 'One teammate must attack the enemy tower while everyone else builds and defends the shared tower.',
            'BALANCE: offense without defense loses your tower; defense without offense lets theirs win. Do both as a team.',
            isAttacker
                ? `YOU ARE THE ATTACKER (offense). Go directly to the enemy team (${rivals.join(', ')}) now. Use !attackPlayer on an enemy builder, then use !clearArea with the coordinates of the enemy tower's lowest reachable supporting blocks. Keep attacking and dismantling; do not build a separate tower and do not settle into routine home building while an enemy tower stands. Only peel back briefly if your team's tower is collapsing with nobody home, then resume the assault.`
                : 'YOU ARE A BUILDER-DEFENDER. Go to the captain\'s base and build UP only on the one structure the captain starts. Your first and every later block must touch that shared tower; never place a new foundation on bare ground. If enemies come to demolish it, use !attackPlayer to fight them off, repair broken blocks, then resume stacking — do not abandon the tower to chase across the arena. If you cannot find the base, regroup with the captain before placing anything.',
            'Coordinate with !startConversation only for a short tactical update, then immediately resume your assigned job.',
            isAttacker
                ? 'Never attack a teammate. Ignore friendly structures and keep pressure on the opposing tower.'
                : 'Never attack a teammate. Build onto the same team structure, defend it when threatened, make room for each other, and keep paths and standing room open.'
        );
    }
    if (rivals.length > 0 && !isSpleef && !isHotButton && !isCakeRace && !isDeathRace) {
        lines.push(
            `Your rivals are ${rivals.join(', ')}. Occasionally use !startConversation for a brief mind game with one of them when there is a strategic reason.`,
            'Probe, predict, bluff, misdirect, bargain, or challenge their strategy. A playful jab is fine sometimes, but do not turn every conversation into a roast.',
            'Share only what helps your mind game, use !endConversation after one or two fresh lines, then return to executing your own plan.'
        );
    }
    return lines.join('\n');
}
