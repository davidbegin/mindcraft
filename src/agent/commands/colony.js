import { requestColonyCommand } from '../mindserver_proxy.js';

function formatResult(result) {
    if (!result?.success) {
        return `Colony command failed: ${result?.error || 'unknown error'}`;
    }
    return result.message || JSON.stringify(result.data);
}

async function request(type, payload = {}) {
    return formatResult(await requestColonyCommand(type, payload));
}

export const colonyQueryList = [
    {
        name: '!colonyStatus',
        description: 'Read the shared colony phase, plan, agents, and available work.',
        perform: async function () {
            return request('status');
        },
    },
    {
        name: '!colonyTask',
        description: 'Read your current colony assignment and its acceptance criteria.',
        perform: async function () {
            return request('task');
        },
    },
];

export const colonyActionList = [
    {
        name: '!claimColonyTask',
        description: 'Claim the highest-priority available task suited to your role.',
        perform: async function () {
            return request('claim-task');
        },
    },
    {
        name: '!completeColonyTask',
        description: 'Complete your current colony task and record concrete results.',
        params: {
            summary: { type: 'string', description: 'What was completed, where, and what changed.' },
        },
        perform: async function (_agent, summary) {
            return request('complete-task', { summary });
        },
    },
    {
        name: '!failColonyTask',
        description: 'Release your current task after recording the blocker so another bot can adapt.',
        params: {
            reason: { type: 'string', description: 'The blocker, failed approach, and useful observations.' },
        },
        perform: async function (_agent, reason) {
            return request('fail-task', { reason });
        },
    },
    {
        name: '!proposeColonyTask',
        description: 'Add a useful task to the shared plan for the colony.',
        params: {
            title: { type: 'string', description: 'Short task title.' },
            details: { type: 'string', description: 'Concrete objective and completion criteria.' },
        },
        perform: async function (_agent, title, details) {
            return request('propose-task', { title, details });
        },
    },
    {
        name: '!recordColonyProgress',
        description: 'Write an important discovery, resource update, coordinate, or decision to shared memory.',
        params: {
            summary: { type: 'string', description: 'Durable information useful to the other bots.' },
        },
        perform: async function (_agent, summary) {
            return request('record-progress', { summary });
        },
    },
    {
        name: '!publishColonyArtifact',
        description: 'Publish a shared note, blueprint, or code artifact beneath the colony workspace.',
        params: {
            path: { type: 'string', description: 'Relative path under notes/, blueprints/, or code/.' },
            content: { type: 'string', description: 'Text content to persist for collaborators.' },
        },
        perform: async function (_agent, path, content) {
            return request('publish-artifact', { path, content });
        },
    },
    {
        name: '!requestColonyAgent',
        description: 'Ask whether another specialist is needed. The live roster is managed from the Mindcraft UI, so this will not spawn a replacement after an agent is removed.',
        params: {
            role: { type: 'string', description: 'Needed specialty such as miner, builder, explorer, or combat.' },
            reason: { type: 'string', description: 'Why spawning this specialist advances the shared plan.' },
        },
        perform: async function (_agent, role, reason) {
            return request('request-agent', { role, reason });
        },
    },
];
