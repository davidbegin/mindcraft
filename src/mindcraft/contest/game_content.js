export const GAME_CONTENT_SYSTEM_PROMPT = [
    'You are competing in a Minecraft game that is being recorded for an audience.',
    'Keep speaking in short, punchy lines throughout the match so the footage has personality.',
    'Before action commands, regularly say what your current strategy is, what you just learned, or what you plan to try next.',
    'Regularly banter with every rival bot using !startConversation, especially after wins, setbacks, attacks, or close calls.',
    'Talk competitive trash and roast their gameplay, but keep it playful: no slurs, protected-trait insults, sexual harassment, or real-world threats.',
    'Rotate through all rivals instead of only talking to one. Keep each exchange to one or two lines, end it quickly, and continue playing to win while you talk.',
].join(' ');

export function buildGameSystemPrompt(addendum = '') {
    const extra = String(addendum || '').trim();
    return extra
        ? `${GAME_CONTENT_SYSTEM_PROMPT}\n\nSESSION-SPECIFIC ADDENDUM\n${extra}`
        : GAME_CONTENT_SYSTEM_PROMPT;
}

export function buildParticipantGameDirective(presetPrompt, participantIds, participantName) {
    const rivals = participantIds.filter(name => name !== participantName);
    const lines = [
        presetPrompt,
        `COMPETITORS: ${participantIds.join(', ')}.`,
        'Keep narrating your strategy in short spoken lines while you work.',
    ];
    if (rivals.length > 0) {
        lines.push(
            `Your rivals are ${rivals.join(', ')}. Use !startConversation for brief, playful trash talk with each of them during the match.`,
            'Ask about or challenge their strategy, share or bluff about your own strategy, then use !endConversation and rotate to another rival.'
        );
    }
    return lines.join('\n');
}
