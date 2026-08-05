import {
    createMindServer,
    numStateListeners,
    registerAgent,
    unregisterAgent,
} from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import open from 'open';

let mindserver;
let connected = false;
// Keyed by agent instance id, not by name, so a name can be reused freely.
const agent_processes = new Map();
let agent_count = 0;
let mindserver_port = 8080;

export async function init(host_public=false, port=8080, auto_open_ui=true) {
    if (connected) {
        console.error('Already initiliazed!');
        return;
    }
    mindserver = createMindServer(host_public, port);
    mindserver_port = port;
    connected = true;
    if (auto_open_ui) {
        setTimeout(() => {
            // check if browser listener is already open
            if (numStateListeners() === 0) {
                open('http://localhost:'+port+'/colony');
            }
        }, 3000);
    }
}

export async function createAgent(settings) {
    if (!settings.profile.name) {
        console.error('Agent name is required in profile');
        return {
            success: false,
            error: 'Agent name is required in profile'
        };
    }
    settings = JSON.parse(JSON.stringify(settings));
    let agent_name = settings.profile.name;
    const agentIndex = agent_count++;
    const viewer_port = 3000 + agentIndex;
    let load_memory = settings.load_memory || false;
    let init_message = settings.init_message || null;
    let agentId = null;

    try {
        const registration = await registerAgent(settings, viewer_port);
        agentId = registration.agentId;
        try {
            const server = await getServer(settings.host, settings.port, settings.minecraft_version);
            settings.host = server.host;
            settings.port = server.port;
            settings.minecraft_version = server.version;
        } catch (error) {
            console.warn(`Error getting server:`, error);
            if (settings.minecraft_version === "auto") {
                settings.minecraft_version = null;
            }
            console.warn(`Attempting to connect anyway...`);
        }

        const agentProcess = new AgentProcess(agentId, agent_name, mindserver_port);
        agent_processes.set(agentId, agentProcess);
        if (registration.colonyAgent?.desired === false) {
            return { success: true, agentId, error: null };
        }
        agentProcess.start(load_memory, init_message, agentIndex);
    } catch (error) {
        console.error(`Error creating agent ${agent_name}:`, error);
        destroyAgent(agentId);
        await unregisterAgent(agentId);
        return {
            success: false,
            agentId,
            error: error.message
        };
    }
    return {
        success: true,
        agentId,
        error: null
    };
}

export function getAgentProcess(agentId) {
    return agent_processes.get(agentId);
}

export function startAgent(agentId) {
    const agentProcess = agent_processes.get(agentId);
    if (agentProcess) {
        agentProcess.forceRestart();
    }
    else {
        console.error(`Cannot start agent ${agentId}; not found`);
    }
}

export function stopAgent(agentId) {
    agent_processes.get(agentId)?.stop();
}

export function destroyAgent(agentId) {
    const agentProcess = agent_processes.get(agentId);
    if (agentProcess) {
        agentProcess.stop();
        agent_processes.delete(agentId);
    }
}

export function shutdown() {
    console.log('Shutting down');
    for (const agentProcess of agent_processes.values()) {
        agentProcess.stop();
    }
    setTimeout(() => {
        process.exit(0);
    }, 2000);
}
