import { requestSurvivorCommand } from '../mindserver_proxy.js';

async function request(type, payload = {}) {
    const result = await requestSurvivorCommand(type, payload);
    if (!result?.success) return `Survivor command failed: ${result?.error || 'unknown error'}`;
    return result.message || JSON.stringify(result.data ?? {});
}

export const survivorActionList = [
    {
        name: '!survivorStatus',
        description: 'Get your private Survivor phase, tribe, immunity, room, and legal vote targets.',
        perform: function () {
            return request('status');
        },
    },
    {
        name: '!invitePrivateGroup',
        description: 'Create a private Survivor strategy room and invite bots. Names are comma-separated. Private messages are never shown to other players.',
        params: {
            player_names_csv: {
                type: 'string',
                description: 'Comma-separated bot names to invite, such as "Alice,Billy".',
            },
            opening_pitch: {
                type: 'string',
                description: 'A private opening strategy pitch included with the invitation.',
            },
        },
        perform: function (_agent, playerNamesCsv, openingPitch) {
            return request('room-create', {
                inviteeIds: playerNamesCsv.split(',').map(name => name.trim()).filter(Boolean),
                pitch: openingPitch,
            });
        },
    },
    {
        name: '!joinPrivateGroup',
        description: 'Accept an invitation to a private Survivor strategy room.',
        params: {
            room_id: { type: 'string', description: 'The room id from the invitation.' },
        },
        perform: function (_agent, roomId) {
            return request('room-join', { roomId });
        },
    },
    {
        name: '!leavePrivateGroup',
        description: 'Leave your current private Survivor strategy room.',
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
        name: '!castSurvivorVote',
        description: 'Cast your one secret ballot for the current Tribal Council, revote, or final jury vote.',
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
