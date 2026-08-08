import { requestSurvivorCommand } from '../mindserver_proxy.js';

async function request(type, payload = {}) {
    const result = await requestSurvivorCommand(type, payload);
    if (!result?.success) return `Survivor command failed: ${result?.error || 'unknown error'}`;
    return result.message || JSON.stringify(result.data ?? {});
}

function splitNames(csv) {
    return String(csv ?? '').split(',').map(name => name.trim()).filter(Boolean);
}

export const survivorActionList = [
    {
        name: '!survivorStatus',
        description: 'Get your private Survivor phase, tribe, immunity, pending chat requests, unanswered council questions, and legal vote targets.',
        perform: function () {
            return request('status');
        },
    },
    {
        name: '!requestPrivateChat',
        description: 'Ask specific players to step aside for a private conversation. They can accept or refuse. Nothing is shared until they accept.',
        params: {
            player_names_csv: {
                type: 'string',
                description: 'Comma-separated bot names to pull aside, such as "Alice,Billy".',
            },
            opening_pitch: {
                type: 'string',
                description: 'What you want to talk about. They see this before deciding whether to meet you.',
            },
        },
        perform: function (_agent, playerNamesCsv, openingPitch) {
            return request('talk-request', {
                inviteeIds: splitNames(playerNamesCsv),
                pitch: openingPitch,
            });
        },
    },
    {
        name: '!acceptPrivateChat',
        description: 'Agree to a private conversation someone asked you for. You join their private room.',
        params: {
            request_id: { type: 'string', description: 'The request id from the invitation.' },
        },
        perform: function (_agent, requestId) {
            return request('talk-respond', { requestId, accepted: true });
        },
    },
    {
        name: '!declinePrivateChat',
        description: 'Refuse a private conversation. They are told you turned them down, which is a real strategic move.',
        params: {
            request_id: { type: 'string', description: 'The request id from the invitation.' },
            reason: {
                type: 'string',
                description: 'What you want them to hear about why, or an empty string to refuse silently.',
            },
        },
        perform: function (_agent, requestId, reason) {
            return request('talk-respond', { requestId, accepted: false, reason });
        },
    },
    {
        name: '!leavePrivateGroup',
        description: 'Walk out of your current private Survivor conversation.',
        perform: function () {
            return request('room-leave');
        },
    },
    {
        name: '!sendPrivateMessage',
        description: 'Send a secret message to every member of your current private Survivor room.',
        params: {
            message: { type: 'string', description: 'The private message to send.' },
        },
        perform: function (_agent, message) {
            return request('room-send', { message });
        },
    },
    {
        name: '!answerCouncil',
        description: 'Answer the host out loud at Tribal Council. Every player and every juror hears this and remembers it.',
        params: {
            answer: { type: 'string', description: 'Your public answer to the question you were asked.' },
        },
        perform: function (_agent, answer) {
            return request('council-answer', { answer });
        },
    },
    {
        name: '!castSurvivorVote',
        description: 'Cast your one secret ballot for the current Tribal Council, revote, or final jury vote. Only legal after council closes.',
        params: {
            player_name: { type: 'string', description: 'An eligible target from !survivorStatus.' },
        },
        perform: function (_agent, playerName) {
            return request('cast-vote', { targetId: playerName });
        },
    },
    {
        name: '!submitDeadlockDecision',
        description: 'During an open deadlock discussion, choose which tied player should be eliminated.',
        params: {
            player_name: { type: 'string', description: 'One of the tied players.' },
        },
        perform: function (_agent, playerName) {
            return request('deadlock-decision', { targetId: playerName });
        },
    },
];
