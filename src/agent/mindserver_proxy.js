import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import settings, { setSettings } from './settings.js';
import { clearSpeechQueue } from './speak.js';
import { getFullState, getWallState } from './library/full_state.js';
import * as skills from './library/skills.js';
import { findAgentSpatialEntry } from '../utils/spatial.js';

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
        this.spatialState = { generatedAt: 0, agents: [] };
        this.worldKnowledge = null;
        MindServerProxy.instance = this;
    }

    async connect(name, port, id = null) {
        if (this.connected) return;

        this.name = name;
        // The mindserver tracks this process by instance id; the name is only
        // how the bot appears in game and can be reused by later bots.
        this.id = id || name;
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

        this.socket.on('spatial-state', (snapshot) => {
            if (!Number.isFinite(snapshot?.generatedAt) || !Array.isArray(snapshot?.agents)) {
                return;
            }
            this.spatialState = snapshot;
            if (this.agent) {
                this.agent.spatialState = snapshot;
                if (this.agent.bot) this.agent.bot.spatialState = snapshot;
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

        // The bot died or was voted out. Everything it has queued — speech,
        // goals, the action it is midway through — goes now.
        this.socket.on('game-eliminated', (payload, callback) => {
            if (!this.agent) {
                callback?.({ success: false, error: 'Agent is not ready' });
                return;
            }
            this.agent.markEliminated(payload?.reason || 'eliminated');
            callback?.({ success: true });
        });

        this.socket.on('game-directive', async (directive, callback) => {
            try {
                if (!this.agent || !directive?.prompt) {
                    callback?.({ success: false, error: 'Agent is not ready for a game directive' });
                    return;
                }
                if (directive.worldKnowledge) {
                    this.worldKnowledge = directive.worldKnowledge;
                    this.agent.worldKnowledge = directive.worldKnowledge;
                }
                // A goal or a cue to react means the show wants this bot audible
                // again, which is how a juror gets to speak and vote after being
                // voted out. A bare pause is the opposite and leaves it silent.
                if (directive.react === true || directive.pause !== true) {
                    this.agent.reinstate();
                }
                if (directive.gameStarted === true) {
                    this.agent.gameStarted = true;
                }
                if (directive.react === true) {
                    await this.agent.self_prompter.pause();
                    this.agent.requestInterrupt();
                    const spoken = await this.agent.reactToGameResult(directive.prompt);
                    callback?.({ success: true, status: spoken ? 'reacted' : 'no_reaction' });
                    return;
                }
                await this.agent.history.add('system', `GAME DIRECTIVE\n${directive.prompt}`);
                if (directive.pause === true) {
                    await this.agent.self_prompter.pause();
                    this.agent.requestInterrupt();
                    callback?.({ success: true, status: 'paused' });
                    return;
                }
                if (directive.endConversations === true && convoManager.inConversation()) {
                    convoManager.forceEndCurrentConversation();
                    convoManager.endAllConversations();
                }
                if (directive.automaticAction === 'play-spleef') {
                    await this.agent.self_prompter.pause();
                    const floorY = Number.isFinite(directive.floorY) ? directive.floorY : 100;
                    this.agent.actions.runAction(
                        'game:play-spleef',
                        () => skills.playSpleef(this.agent.bot, floorY),
                        { timeout: 6 }
                    ).catch(error => {
                        console.error('Automatic Spleef action failed:', error);
                    });
                    callback?.({ success: true, status: 'automatic_action_started' });
                    return;
                }
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

        // Somebody wants to pull this bot aside. Saying no is a legitimate answer,
        // so the prompt offers both doors and never nudges toward accepting.
        // Somebody wants to pull this bot aside. Saying no is a legitimate answer,
        // so the prompt offers both doors and never nudges toward accepting.
        this.socket.on('survivor-talk-request', (invite, callback) => {
            if (!this.agent || !invite?.requestId) {
                callback?.({ success: false, error: 'Agent is not ready for a chat request' });
                return;
            }
            const others = (invite.inviteeIds || []).filter(id => id !== this.name);
            // Ack on receipt, not on completion: thinking about the offer takes a
            // model call, and the server only needs to know it landed.
            callback?.({ success: true });
            this.agent.handleMessage(
                'system',
                `PRIVATE CHAT REQUEST from ${invite.requesterId}.`
                + (others.length > 0 ? ` They also asked ${others.join(', ')}.` : '')
                + (invite.pitch ? ` They say: "${invite.pitch}"` : '')
                + `\nAccept with !acceptPrivateChat("${invite.requestId}") or refuse with `
                + `!declinePrivateChat("${invite.requestId}", "your reason"). `
                + 'Refusing is a real move: it tells them where they stand and keeps you out '
                + 'of their plan. Decide based on whether talking helps your game. '
                + 'Answer promptly — the offer expires. Never mention this in public chat.'
            ).catch(error => console.error('Survivor chat request failed:', error));
        });

        this.socket.on('survivor-talk-resolved', (outcome, callback) => {
            if (!this.agent || !outcome?.requestId) {
                callback?.({ success: false, error: 'Agent is not ready' });
                return;
            }
            const accepted = outcome.accepterIds || [];
            const declined = outcome.declinerIds || [];
            const reasons = Object.entries(outcome.reasons || {})
                .map(([id, reason]) => `${id}: "${reason}"`)
                .join('; ');
            const lines = [outcome.withId
                ? `You are now in a private room with ${outcome.withId}.`
                : `Your private chat request resolved: ${accepted.length > 0
                    ? `${accepted.join(', ')} agreed to talk.`
                    : 'nobody agreed to talk.'}`];
            if (declined.length > 0 && !outcome.withId) {
                lines.push(`Turned you down: ${declined.join(', ')}.${reasons ? ` (${reasons})` : ''}`);
                lines.push('Being frozen out is information. Assume they are working together.');
            }
            if (accepted.length > 0) {
                lines.push('Use !sendPrivateMessage("...") to talk. Nothing here is public.');
            }
            callback?.({ success: true });
            this.agent.privateSurvivorResponse = outcome.roomId ? { roomId: outcome.roomId } : null;
            this.agent.handleMessage('system', lines.join('\n'))
                .catch(error => console.error('Survivor chat outcome failed:', error))
                .finally(() => { this.agent.privateSurvivorResponse = null; });
        });

        // The host asked this bot something in front of everyone.
        this.socket.on('survivor-council-question', (question, callback) => {
            if (!this.agent || !question?.prompt) {
                callback?.({ success: false, error: 'Agent is not ready for a council question' });
                return;
            }
            const also = (question.targetIds || []).filter(id => id !== this.name);
            callback?.({ success: true });
            this.agent.handleMessage(
                'system',
                `TRIBAL COUNCIL — the host asks you, in public: "${question.prompt}"`
                + (also.length > 0 ? `\nHe asked ${also.join(', ')} the same thing.` : '')
                + '\nAnswer now with !answerCouncil("your answer"). Every player hears it, '
                + 'including the jurors who will choose the winner, and they will hold you to it. '
                + 'Do not cast a vote yet; voting opens only after council closes.'
            ).catch(error => console.error('Survivor council question failed:', error));
        });

        // Another bot answered in public. This is how the public record actually
        // reaches everyone's memory instead of living only on the server.
        this.socket.on('survivor-council-answer', async (entry, callback) => {
            try {
                if (!this.agent || !entry?.answer) {
                    callback?.({ success: false, error: 'Agent is not ready' });
                    return;
                }
                await this.agent.history.add(
                    'system',
                    `AT TRIBAL COUNCIL, asked "${entry.prompt}", ${entry.playerId} answered: `
                    + `"${entry.answer}"\nRemember this. You may change who you vote for because of it.`
                );
                callback?.({ success: true });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        this.socket.on('survivor-room-message', async (entry) => {
            if (!this.agent || !entry?.message) return;
            const members = Array.isArray(entry.memberIds) ? entry.memberIds.join(', ') : 'unknown';
            this.agent.privateSurvivorResponse = { roomId: entry.roomId };
            try {
                await this.agent.handleMessage(
                    entry.senderId || 'private-room',
                    `(PRIVATE GROUP ${entry.roomId}; MEMBERS: ${members}; FROM ${entry.senderId}) `
                    + `${entry.message}\nReply privately; never repeat this in public chat.`
                );
            } finally {
                this.agent.privateSurvivorResponse = null;
            }
        });

        this.socket.on('survivor-room-closed', (event) => {
            if (!this.agent || !event?.roomId) return;
            this.agent.history.add(
                'system',
                `Private Survivor room ${event.roomId} closed: ${event.reason || 'closed'}.`
            );
        });

        this.socket.on('survivor-challenge-config', config => {
            this.worldKnowledge = config?.worldKnowledge ?? null;
            if (this.agent) this.agent.worldKnowledge = this.worldKnowledge;
            settings.game_session = {
                ...(settings.game_session || {}),
                contestType: config?.contestType ?? null,
                winItem: config?.winItem ?? null,
                floorY: Number.isFinite(config?.floorY) ? config.floorY : null,
                survivorChallengeId: config?.challengeId ?? null,
            };
            if (this.agent) {
                this.agent._contestDeathReported = false;
                this.agent._contestWinReported = false;
                this.agent._contestEliminatedReported = false;
                // The next challenge has not started yet; its goal directive says
                // when it has.
                this.agent.gameStarted = false;
                // A new challenge is a clean slate: losing the last one must not
                // leave a bot mute for the rest of the season.
                this.agent.reinstate();
            }
        });

        this.socket.on('contest-clear-speech', () => {
            clearSpeechQueue();
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

            this.socket.emit('get-settings', this.id, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', this.id);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
        if (agent) {
            agent.spatialState = this.spatialState;
            agent.worldKnowledge = this.worldKnowledge;
            if (agent.bot) agent.bot.spatialState = this.spatialState;
        }
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    getSpatialState() {
        return this.spatialState;
    }

    getAgentPosition(name, options = {}) {
        return findAgentSpatialEntry(this.spatialState, name, options);
    }

    getWorldKnowledge() {
        return this.worldKnowledge;
    }

    login() {
        this.socket.emit('login-agent', this.id);
    }

    colonyReady() {
        this.socket.emit('colony-ready');
    }

    // Push POV recording state changes so the UI reflects auto-stops (bot death, ffmpeg failure)
    sendRecordingUpdate(status) {
        if (this.socket?.connected) {
            this.socket.emit('recording-update', this.id, status);
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

export function requestSurvivorCommand(type, payload = {}) {
    const socket = serverProxy.getSocket();
    if (!socket?.connected) {
        return Promise.resolve({ success: false, error: 'MindServer is not connected' });
    }
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            resolve({ success: false, error: `Survivor command '${type}' timed out` });
        }, 10000);
        socket.emit('survivor-command', { type, payload }, result => {
            clearTimeout(timeout);
            resolve(result || { success: false, error: 'No Survivor command response' });
        });
    });
}

// for sending general output to server for display. The optional position is a
// travel breadcrumb: the contest archive stamps each spoken line with where the
// bot was standing when it said it.
export function sendOutputToServer(agentName, message, position = null) {
    const point = position
        && Number.isFinite(position.x)
        && Number.isFinite(position.y)
        && Number.isFinite(position.z)
        ? { x: position.x, y: position.y, z: position.z }
        : null;
    serverProxy.getSocket().emit('bot-output', agentName, message, point);
}

/**
 * Agents generate their own TTS, so a voice failure here would never reach the
 * control room without being relayed. Best effort: a bot that cannot talk to
 * the server has bigger problems than a missing banner.
 */
export function reportVoiceProblem(report) {
    const socket = serverProxy.getSocket();
    if (!socket?.connected) return;
    socket.emit('voice-problem', report);
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

export function reportContestWinItem(itemName, position = null) {
    const socket = serverProxy.getSocket();
    if (!socket?.connected) {
        return Promise.reject(new Error('MindServer is not connected'));
    }
    return new Promise((resolve, reject) => {
        socket.timeout(10000).emit(
            'contest-win-item',
            { itemName, position },
            (error, result) => {
                if (error) {
                    reject(new Error('Contest win-item report timed out'));
                    return;
                }
                if (!result?.success) {
                    reject(new Error(result?.error || 'Contest win-item report failed'));
                    return;
                }
                resolve(result.data);
            }
        );
    });
}

export function reportContestDeath(payload = {}) {
    const socket = serverProxy.getSocket();
    if (!socket?.connected) {
        return Promise.reject(new Error('MindServer is not connected'));
    }
    return new Promise((resolve, reject) => {
        socket.timeout(10000).emit('contest-death', payload, (error, result) => {
            if (error) {
                reject(new Error('Contest death report timed out'));
                return;
            }
            if (!result?.success) {
                reject(new Error(result?.error || 'Contest death report failed'));
                return;
            }
            resolve(result.data);
        });
    });
}

export function reportContestEliminated(payload = {}) {
    const socket = serverProxy.getSocket();
    if (!socket?.connected) {
        return Promise.reject(new Error('MindServer is not connected'));
    }
    return new Promise((resolve, reject) => {
        socket.timeout(10000).emit('contest-eliminated', payload, (error, result) => {
            if (error) {
                reject(new Error('Contest elimination report timed out'));
                return;
            }
            if (!result?.success) {
                reject(new Error(result?.error || 'Contest elimination report failed'));
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
