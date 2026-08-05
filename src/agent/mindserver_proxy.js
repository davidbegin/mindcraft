import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState, getWallState } from './library/full_state.js';

// agent's individual connection to the mindserver
// always connect to localhost

class MindServerProxy {
    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }
        
        this.socket = null;
        this.connected = false;
        this.agents = [];
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.connected) return;
        
        this.name = name;
        this.socket = io(`http://localhost:${port}`);

        await new Promise((resolve, reject) => {
            this.socket.on('connect', resolve);
            this.socket.on('connect_error', (err) => {
                console.error('Connection failed:', err);
                reject(err);
            });
        });

        this.connected = true;
        console.log(name, 'connected to MindServer');

        this.socket.on('disconnect', () => {
            console.log('Disconnected from MindServer');
            this.connected = false;
            if (this.agent) {
                this.agent.cleanKill('Disconnected from MindServer. Killing agent process.');
            }
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });
		
        this.socket.on('send-message', (data) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        this.socket.on('colony-directive', async (directive, callback) => {
            try {
                if (!this.agent || !directive?.prompt) {
                    callback?.({ success: false, error: 'Agent is not ready for a colony directive' });
                    return;
                }
                this.agent.colony_paused = Boolean(directive.paused);
                // Repeated identical directives used to spam history, dragging it to the
                // summarization threshold (each summarization is a billed model call).
                if (directive.prompt !== this.last_directive_prompt) {
                    this.last_directive_prompt = directive.prompt;
                    this.agent.history.add('system', `COLONY DIRECTIVE\n${directive.prompt}`);
                }
                if (directive.paused) {
                    await this.agent.self_prompter.pause();
                    callback?.({ success: true, status: 'paused' });
                    return;
                }
                if (convoManager.inConversation()) {
                    this.agent.self_prompter.setPromptPaused(directive.prompt);
                    callback?.({ success: true, status: 'queued_during_conversation' });
                    return;
                }
                const result = this.agent.self_prompter.start(directive.prompt);
                const alreadyActive = typeof result === 'string' && /already active/i.test(result);
                callback?.({
                    success: true,
                    status: alreadyActive ? 'goal_refreshed' : 'started',
                    detail: result,
                });
            } catch (error) {
                console.error('Error applying colony directive:', error);
                callback?.({ success: false, error: error.message });
            }
        });

        this.socket.on('game-directive', async (directive, callback) => {
            try {
                if (!this.agent || !directive?.prompt) {
                    callback?.({ success: false, error: 'Agent is not ready for a game directive' });
                    return;
                }
                this.agent.history.add('system', `GAME DIRECTIVE\n${directive.prompt}`);
                if (convoManager.inConversation()) {
                    this.agent.self_prompter.setPromptPaused(directive.prompt);
                    callback?.({ success: true, status: 'queued_during_conversation' });
                    return;
                }
                const result = this.agent.self_prompter.start(directive.prompt);
                callback?.({ success: true, status: 'started', detail: result });
            } catch (error) {
                console.error('Error applying game directive:', error);
                callback?.({ success: false, error: error.message });
            }
        });

        this.socket.on('contest-recording-audio', (payload) => {
            this.agent?.addContestRecordingAudio(payload);
        });

        this.socket.on('model-probe', async (callback) => {
            try {
                if (!this.agent?.prompter) {
                    callback?.({ ok: false, error: 'Agent is not ready to probe the model' });
                    return;
                }
                callback?.({ ok: await this.agent.prompter.checkModelHealth() });
            } catch (error) {
                callback?.({ ok: false, error: error.message });
            }
        });

        this.socket.on('start-recording', async (options, callback) => {
            try {
                if (!this.agent?.pov_recorder) {
                    callback?.({ success: false, error: 'Agent has not spawned yet' });
                    return;
                }
                const status = await this.agent.pov_recorder.start(options || {});
                callback?.({ success: !status.error, error: status.error, ...status, autoRecord: this.agent.isAutoRecording() });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        this.socket.on('stop-recording', async (callback) => {
            try {
                if (!this.agent?.pov_recorder) {
                    callback?.({ success: false, error: 'Agent has not spawned yet' });
                    return;
                }
                const status = await this.agent.pov_recorder.stop();
                callback?.({ success: true, ...status, autoRecord: this.agent.isAutoRecording() });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        this.socket.on('game-tower-report', (callback) => {
            try {
                if (!this.agent?.bot?.entity) {
                    callback?.({ success: false, error: 'Agent has not spawned yet' });
                    return;
                }
                callback?.({ success: true, report: this.agent.gameTowerReport() });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        this.socket.on('start-contest-recording', async (options, callback) => {
            try {
                const result = await this.agent.startContestRecording(options || {});
                callback?.({ success: true, ...result });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        this.socket.on('stop-contest-recording', async (callback) => {
            try {
                const result = await this.agent.stopContestRecording();
                callback?.({ success: true, ...result });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        this.socket.on('set-auto-recording', async (enabled, callback) => {
            try {
                if (!this.agent?.pov_recorder) {
                    callback?.({ success: false, error: 'Agent has not spawned yet' });
                    return;
                }
                const status = await this.agent.setAutoRecording(Boolean(enabled));
                callback?.({ success: true, ...status });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        this.socket.on('get-full-state', (callback) => {
            try {
                const state = getFullState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        this.socket.on('get-wall-state', (callback) => {
            try {
                const state = getWallState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting wall state:', error);
                callback(null);
            }
        });

        // Request settings and wait for response
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', name);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        this.socket.emit('login-agent', this.agent.name);
    }

    colonyReady() {
        this.socket.emit('colony-ready');
    }

    // Push POV recording state changes so the UI reflects auto-stops (bot death, ffmpeg failure)
    sendRecordingUpdate(status) {
        if (this.socket?.connected) {
            this.socket.emit('recording-update', this.name, status);
        }
    }

    shutdown() {
        this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }
}

// Create and export a singleton instance
export const serverProxy = new MindServerProxy();

// for chatting with other bots
export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}

// for sending general output to server for display
export function sendOutputToServer(agentName, message) {
    serverProxy.getSocket().emit('bot-output', agentName, message);
}

export function requestContestSpeech(text) {
    const socket = serverProxy.getSocket();
    if (!socket?.connected) {
        return Promise.reject(new Error('MindServer is not connected'));
    }
    return new Promise((resolve, reject) => {
        socket.timeout(30000).emit('contest-speech', { text }, (error, result) => {
            if (error) {
                reject(new Error('Contest speech request timed out'));
                return;
            }
            if (!result?.success) {
                reject(new Error(result?.error || 'Contest speech request failed'));
                return;
            }
            resolve(result.audio);
        });
    });
}

export function reportContestWinItem(itemName) {
    const socket = serverProxy.getSocket();
    if (!socket?.connected) {
        return Promise.reject(new Error('MindServer is not connected'));
    }
    return new Promise((resolve, reject) => {
        socket.timeout(10000).emit('contest-win-item', { itemName }, (error, result) => {
            if (error) {
                reject(new Error('Contest win-item report timed out'));
                return;
            }
            if (!result?.success) {
                reject(new Error(result?.error || 'Contest win-item report failed'));
                return;
            }
            resolve(result.data);
        });
    });
}

export function requestColonyCommand(type, payload = {}) {
    const socket = serverProxy.getSocket();
    if (!socket?.connected) {
        return Promise.resolve({ success: false, error: 'MindServer is not connected' });
    }
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve({ success: false, error: `Colony command '${type}' timed out` });
        }, 10000);
        socket.emit('colony-command', { type, payload }, (result) => {
            clearTimeout(timeout);
            resolve(result);
        });
    });
}
