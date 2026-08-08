import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { CommandGuard } from './commands/command_guard.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { PovRecorder } from './vision/pov_recorder.js';
import { ActionRecorder } from './vision/action_recorder.js';
import { PovSnapshotter } from './vision/pov_snapshotter.js';
import { addContestAudioToRecorders } from './contest_audio.js';
import {
    serverProxy,
    sendOutputToServer,
    requestColonyCommand,
    requestContestSpeech,
    requestSurvivorCommand,
    reportContestDeath,
    reportContestEliminated,
    reportContestWinItem,
    reportVoiceProblem,
} from './mindserver_proxy.js';
import { setOutageHandler } from '../models/quota_guard.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { generateSpeech, playSpeech, isSystemSpeakModel, silenceBot, allowBot } from './speak.js';
import { setVoiceHealthHandler } from './tts_health.js';
import {
    getAudibleChatText,
    getHumanCommandAcknowledgement,
    getSpokenChatText,
    isGameOperationalMessage,
} from './speech_policy.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { Vec3 } from 'vec3';

const MAX_TRACKED_PLACEMENTS = 20000;
const MAX_PILLAR_PROBE = 256;

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.colony_paused = false;
        this.eliminated = false;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this.contest_recorders = [];
        this.contest_recording_session = null;
        // Bumped by every start and stop so a start that is still bringing its
        // renderers up can tell it has been superseded.
        this.contest_recording_token = 0;

        // Initialize components
        this.actions = new ActionManager(this);
        this.command_guard = new CommandGuard();
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        this._thinking = false;
        this._thinking_label = null;
        convoManager.initAgent(this);
        setOutageHandler(outage => this._handleModelOutage(outage));
        setVoiceHealthHandler(health => reportVoiceProblem({
            ...(health.outage || health.lastFailure || { kind: 'ok' }),
            recovered: health.ok,
            botName: this.name,
        }));
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
            if (save_data?.place_memory) {
                this.memory_bank.loadJson(save_data.place_memory);
            }
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            this._skin_attempts = 0;
            this._applyProfileSkin();
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                this.pov_recorder = new PovRecorder(this.bot, this.name, () => serverProxy.sendRecordingUpdate(this.recordingStatus()));
                if (settings.record_bot_view) {
                    // Continuous recording from spawn; supersedes action-based clips.
                    this.pov_recorder.start().catch(err => console.error('Failed to auto-start POV recording:', err));
                }
                else if (settings.record_actions) {
                    await this.setAutoRecording(true);
                }
                // Push initial state so the UI's rec/auto buttons are right before any clip exists.
                serverProxy.sendRecordingUpdate(this.recordingStatus());
                this.pov_snapshotter = new PovSnapshotter(this.bot, this.name, this.pov_recorder);
                this.pov_snapshotter.start();
                if (settings.game_session) {
                    this._trackGameBlockPlacements();
                    this._watchContestWinItem();
                    this._watchSpleefFall();
                }
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
                // Mark in-game only after a successful spawn. Login alone is too early —
                // contest arena prep issues /clear and /tp, which fail if the player
                // never finishes spawning (or crashes mid-setup).
                serverProxy.login();
              
                await this._setupEventHandlers(save_data, init_message);
                this.startEvents();
                if (!settings.game_session) {
                    serverProxy.colonyReady();
                }
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    /**
     * Applies the profile skin via Fabric Tailor (https://modrinth.com/mod/fabrictailor).
     * `skin.file` is a path on the MC server (set with `/skin set upload`), while
     * `skin.path` is a public URL (set with `/skin set URL`). Application is staggered
     * per bot and retried, because Fabric Tailor signs skins through the rate-limited
     * MineSkin API and many bots log in at once.
     */
    _applyProfileSkin() {
        const skin = this.prompter.profile.skin;
        if (!skin || (!skin.file && !skin.path)) {
            this.bot.chat('/skin clear');
            return;
        }
        const variant = skin.model === 'slim' ? 'slim' : 'classic';
        const cmd = skin.file
            ? `/skin set upload ${variant} ${skin.file}`
            : `/skin set URL ${variant} ${skin.path}`;
        let hash = 0;
        for (const c of this.name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
        const delay = this._skin_attempts === 0 ? 3000 + (hash % 10) * 7000 : 75000;
        this._skin_attempts++;
        const attempt = this._skin_attempts;
        setTimeout(() => {
            if (!this.bot?.entity) return; // disconnected in the meantime
            const onMessage = (message) => {
                const text = String(message);
                if (/skin was set successfully/i.test(text)) {
                    this.bot.removeListener('messagestr', onMessage);
                    log(this.name, `Skin applied (attempt ${attempt}).`);
                } else if (/problem (with fetching|occurred when trying to upload) the skin/i.test(text)
                        || /must wait \d+ seconds to change it again/i.test(text)) {
                    this.bot.removeListener('messagestr', onMessage);
                    if (attempt < 4) {
                        log(this.name, `Skin application failed (attempt ${attempt}); retrying.`);
                        this._applyProfileSkin();
                    } else {
                        log(this.name, `Skin application failed after ${attempt} attempts; giving up.`);
                    }
                }
            };
            this.bot.on('messagestr', onMessage);
            setTimeout(() => this.bot?.removeListener('messagestr', onMessage), 70000);
            this.bot.chat(cmd);
        }, delay);
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            // Bots ignore each other's public chat (they coordinate through the
            // mindserver instead, and echoing would loop). Humans get answered
            // by every bot, even when many agents are online.
            if (convoManager.isOtherAgent(username)) return;
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt && !settings.colony?.enabled) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender && !settings.colony?.enabled) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message && !settings.colony?.enabled) {
            await this.handleMessage('system', init_message, 2);
        }
        else if (!settings.colony?.enabled && !settings.game_session) {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        try { this.bot.stopDigging(); } catch (_) {}
        try { this.bot.collectBlock?.cancelTask?.(); } catch (_) {}
        try { this.bot.pathfinder?.stop?.(); } catch (_) {}
        try { this.bot.pvp?.stop?.(); } catch (_) {}
        try { this.bot.clearControlStates?.(); } catch (_) {}
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    /**
     * This bot is out of the game: dead in a contest it cannot re-enter, or
     * voted out. TTS and the model both run ahead of play, so a bot that is
     * merely paused keeps talking and acting for a while from an empty seat.
     * Drop the speech it already generated, stop the work it already started,
     * and refuse new work until the show hands it the floor again.
     */
    markEliminated(reason = 'eliminated') {
        if (this.eliminated) return;
        this.eliminated = true;
        silenceBot(this.name);
        convoManager.endAllConversations();
        this.self_prompter.stop(false).catch(error => {
            console.warn(`Could not stop self-prompting for ${this.name}:`, error.message);
        });
        this.actions.cancelResume();
        this.requestInterrupt();
        if (this.actions.executing) {
            this.actions.forceClear(reason);
        }
        console.log(`[${this.name}] out of the game (${reason}): speech flushed, play stopped.`);
        this.history.add(
            'system',
            `You are out of the game (${reason}). You have stopped playing and stopped talking.`
        ).catch(error => console.warn(`Could not record elimination for ${this.name}:`, error.message));
    }

    /**
     * The show is addressing this bot again — a new game, or a juror being
     * called on at final tribal council. Without this, an eliminated bot could
     * never cast its jury vote or react to a winner.
     */
    reinstate() {
        allowBot(this.name);
        if (!this.eliminated) return;
        this.eliminated = false;
        console.log(`[${this.name}] back in play; voice restored.`);
    }

    async handleMessage(source, message, max_responses=null) {
        // Out of the game means out of the loop: no model calls, no commands,
        // no chat. Only reinstate() puts this bot back in.
        if (this.eliminated) return false;
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        if (!self_prompt && !from_other_bot) {
            // Busy colony bots otherwise treat human chat as an interruption and
            // answer with a bare command (or !stfu), which produces no spoken
            // voice line. Humans should always get a conversational reply.
            await this.history.add('system', `${source} is a human player talking to you in chat. Always include a short friendly conversational reply addressed to them in your response, in addition to any command. Never respond with only a command, an empty message, or !stfu.`);
        }
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over

        // Human messages take priority: hold the self-prompt loop while we
        // respond, otherwise its concurrent promptConvo calls race ours and
        // the reply to the player gets discarded mid-generation.
        const from_human = !self_prompt && !from_other_bot;
        if (from_human) this._human_responses_pending = (this._human_responses_pending || 0) + 1;
        try {
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            this._setThinking(true, 'Thinking…');
            let res;
            try {
                res = await this.prompter.promptConvo(history);
            } finally {
                this._setThinking(false);
            }

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);

                // Prompt instructions are not enough to guarantee that every
                // model includes conversational text before a command. Human
                // players must still hear an acknowledgement through TTS.
                const acknowledgement = from_human
                    ? getHumanCommandAcknowledgement(res, source)
                    : null;
                if (acknowledgement) {
                    await this.routeResponse(source, acknowledgement);
                }
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }
        } finally {
            if (from_human) this._human_responses_pending--;
        }

        return used_command;
    }

    async reactToGameResult(prompt) {
        await this.history.add('system', `FINAL GAME RESULT\n${prompt}`);
        this.history.save();
        this._setThinking(true, 'Reacting to the winner…');
        let response;
        try {
            response = await this.prompter.promptConvo(this.history.getHistory());
        } finally {
            this._setThinking(false);
        }
        response = String(response || '').trim();
        if (!response) return false;
        const commandName = containsCommand(response);
        if (commandName) {
            response = response.slice(0, response.indexOf(commandName)).trim();
        }
        if (!response) return false;
        await this.history.add(this.name, response);
        this.history.save();
        await this.openChat(response);
        return true;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up || this.eliminated) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }
        // Only messages directed at a real recipient (a human player or another
        // bot) are read aloud; self-prompt work narration stays text-only.
        const addressed = !!to_player && to_player !== 'system' && to_player !== this.name;
        const commandName = containsCommand(message);
        if (this.privateSurvivorResponse) {
            const privateText = commandName
                ? message.slice(0, message.indexOf(commandName)).trim()
                : message.trim();
            if (privateText) {
                await requestSurvivorCommand('room-send', { message: privateText });
            }
            return;
        }
        if (commandName) {
            if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
                const conversationMessage = commandName === '!endConversation'
                    ? message
                    : `I'm acting on our conversation now with ${commandName} and will keep progressing.`;
                convoManager.sendToBot(to_player, conversationMessage, false, false);
            }
            this.openChat(message, { addressed });
            return;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message, { addressed });
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message, { addressed = false } = {}) {
        if (this.eliminated) return;
        let command_name = containsCommand(message);
        const to_translate = getSpokenChatText(message);
        const translate_up_to = command_name ? message.indexOf(command_name) : -1;
        const remaining = translate_up_to === -1 ? '' : message.substring(translate_up_to);
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            this._speakChat(to_translate, addressed);
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    /**
     * Voice the chat line with this bot's TTS voice. Only messages addressed
     * to a real recipient (a human player or another bot) are played aloud on
     * the host (scaled by proximity when enabled); unaddressed narration is
     * still mixed into the POV recording if a clip is currently rolling. TTS
     * is only generated when at least one of those will actually use it.
     */
    _speakChat(text, addressed = false) {
        if (!text || !text.trim()) return;
        if (settings.game_session && isGameOperationalMessage(text)) {
            console.log(`[${this.name}] voice: silent (game operational status): "${text.trim().slice(0, 60)}"`);
            return;
        }
        text = getAudibleChatText(text);
        const model = this.prompter.profile.speak_model;
        const shouldSpeak = addressed || settings.game_session?.speakAll;
        const volume = (settings.speak && shouldSpeak) ? this._getSpeechVolume() : null;
        const audible = volume !== null;
        const recording = !!this.pov_recorder?.recording;
        const silentReason = !shouldSpeak ? 'not addressed to a player or bot' : 'no human player in range';
        console.log(`[${this.name}] voice: ${audible ? `speaking at volume ${volume}` : `silent (${silentReason})`}${recording ? ', recording' : ''}: "${text.trim().slice(0, 60)}"`);
        if (!audible && !recording) return;

        if (audible && settings.game_session?.serverBroadcastVoice) {
            requestContestSpeech(text).catch(err => {
                console.error(`[${this.name}] Server contest TTS failed:`, err.message);
                // Keep the line audible if the centralized browser/host route
                // is temporarily unavailable. Game profiles are forced to
                // ElevenLabs, so this remains the same configured bot voice.
                const fallbackAudio = generateSpeech(text, model, this.name);
                if (recording) {
                    fallbackAudio.then(audio => {
                        this.addContestRecordingAudio({
                            sessionId: this.contest_recording_session,
                            audio,
                            atMs: Date.now(),
                        });
                    }).catch(() => {});
                }
                playSpeech({
                    text,
                    model,
                    botName: this.name,
                    volume,
                    audioPromise: fallbackAudio,
                });
            });
            return;
        }

        if (isSystemSpeakModel(model)) {
            // System TTS has no audio data to record; playback only.
            if (audible) playSpeech({ text, model, botName: this.name, volume });
            return;
        }

        const audioPromise = generateSpeech(text, model, this.name);
        if (recording) {
            audioPromise.then(audio => {
                if (audio && this.pov_recorder?.recording) {
                    this.pov_recorder.addAudio(audio);
                }
            }).catch(() => {});
        }
        if (audible) {
            playSpeech({ text, model, botName: this.name, volume, audioPromise });
        } else {
            audioPromise.catch(err => console.error(`[${this.name}] TTS generation failed:`, err.message));
        }
    }

    addContestRecordingAudio(payload) {
        return addContestAudioToRecorders(
            [this.pov_recorder, ...this.contest_recorders],
            this.contest_recording_session,
            payload
        );
    }

    /**
     * Proximity chat: playback volume (0-100) based on the distance from this
     * bot to the nearest human player, or null when no human is close enough
     * to hear. Player entities only resolve within render distance, so bots
     * far from every human are silent. Disable with speak_proximity=false to
     * always hear every bot at full volume.
     */
    _getSpeechVolume() {
        if (settings.speak_proximity === false) return 100;
        const range = Math.max(4, Number(settings.speak_proximity_range) || 32);
        const myPos = this.bot.entity?.position;
        if (!myPos) return null;
        let nearest = Infinity;
        for (const [username, player] of Object.entries(this.bot.players)) {
            if (username === this.name || convoManager.isOtherAgent(username)) continue;
            const pos = player?.entity?.position;
            if (!pos) continue;
            const dist = pos.distanceTo(myPos);
            if (dist < nearest) nearest = dist;
        }
        if (nearest > range) return null;
        // Full volume within the closest quarter of the range, fading to 15 at the edge.
        const fade = Math.min(1, Math.max(0, (nearest - range * 0.25) / (range * 0.75)));
        return Math.round(100 - fade * 85);
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            // Death used to await stop(), which could cleanKill after 10s and
            // restart the whole agent mid-respawn. Interrupt + force-clear instead.
            this.actions.cancelResume();
            this.requestInterrupt();
            if (this.actions.executing) {
                this.actions.forceClear('death');
            }
            this._reportContestDeath();
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.x.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        this._updateDeathWatchdog();
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    /**
     * Some deaths never trigger an auto-respawn, leaving the bot issuing
     * commands as a corpse indefinitely. Force a respawn if the bot has been
     * dead for more than a few seconds, and keep retrying while it stays dead.
     */
    _updateDeathWatchdog() {
        const health = this.bot?.health;
        if (typeof health !== 'number' || health > 0) {
            this._deadSince = null;
            return;
        }
        const now = Date.now();
        this._deadSince ??= now;
        const DEAD_GRACE_MS = 5000;
        const RESPAWN_RETRY_MS = 10000;
        if (now - this._deadSince < DEAD_GRACE_MS) return;
        if (now - (this._lastForcedRespawn ?? 0) < RESPAWN_RETRY_MS) return;
        this._lastForcedRespawn = now;
        console.warn(`${this.name} has been dead for ${Math.round((now - this._deadSince) / 1000)}s without respawning; forcing respawn.`);
        try {
            this.bot.respawn();
        } catch (error) {
            console.error(`${this.name} forced respawn failed:`, error);
        }
    }

    isIdle() {
        return !this.actions.executing;
    }

    isThinking() {
        return this._thinking === true;
    }

    /**
     * High-level attention for UI/colony nudges. Physical idleness alone is misleading
     * while an LLM request is in flight or the self-prompt loop is already driving work.
     */
    getAttention() {
        if (this.actions.executing) {
            return {
                phase: 'acting',
                label: this.actions.currentActionLabel || 'Acting',
                available: false,
            };
        }
        if (this.isThinking()) {
            return {
                phase: 'thinking',
                label: this._thinking_label || 'Thinking…',
                available: false,
            };
        }
        if (this.self_prompter?.isActive?.() && this.self_prompter?.isLoopActive?.()) {
            return {
                phase: 'planning',
                label: 'Planning next move…',
                available: false,
            };
        }
        if (this.self_prompter?.isActive?.()) {
            return {
                phase: 'queued',
                label: 'Self-prompt armed',
                available: false,
            };
        }
        if (this.self_prompter?.isPaused?.()) {
            return {
                phase: 'paused',
                label: 'Self-prompt paused',
                available: false,
            };
        }
        return {
            phase: 'idle',
            label: 'Idle',
            available: true,
        };
    }

    _setThinking(active, label = 'Thinking…') {
        this._thinking = Boolean(active);
        this._thinking_label = active ? label : null;
    }

    /**
     * A quota or credential failure will not recover on its own, so stop self-prompting
     * immediately and ask the coordinator to pause the whole colony rather than letting
     * every agent keep retrying against a provider that is refusing requests.
     */
    async _handleModelOutage(outage) {
        console.warn(`Model outage detected (${outage.kind}/${outage.code}): ${outage.message}`);
        try {
            await this.self_prompter.pause();
        } catch (error) {
            console.error('Failed to pause self prompting during a model outage:', error);
        }
        if (!settings.colony?.enabled) return;
        const result = await requestColonyCommand('model-outage', {
            kind: outage.kind,
            code: outage.code,
            message: outage.message,
        });
        if (!result?.success) {
            console.error(`Could not report the model outage to the colony: ${result?.error}`);
        }
    }

    // Recording status enriched with whether action-based auto-recording is armed,
    // so the UI's Rec and Auto buttons stay in sync from one payload.
    recordingStatus() {
        if (!this.pov_recorder) return null;
        return { ...this.pov_recorder.getStatus(), autoRecord: this.isAutoRecording() };
    }

    async startContestRecording(options) {
        if (!this.pov_recorder) {
            throw new Error('Agent has not spawned yet');
        }
        if (this.contest_recording_session === options.sessionId) {
            return {
                sessionId: options.sessionId,
                recordings: [
                    this.pov_recorder.getStatus(),
                    ...this.contest_recorders.map(recorder => recorder.getStatus()),
                ],
            };
        }
        if (this.contest_recording_session) {
            await this.stopContestRecording();
        }

        this._contestRecordingRestore = {
            autoRecord: this.isAutoRecording(),
            continuous: Boolean(settings.record_bot_view),
        };
        if (this.action_recorder?.armed) {
            await this.action_recorder.disarm();
        }
        if (this.pov_recorder.recording) {
            await this.pov_recorder.stop();
        }

        const common = {
            sessionId: options.sessionId,
            contestId: options.contestId,
            syncEpochMs: options.syncEpochMs,
            sourceBot: this.name,
            label: `contest-${options.contestId}`,
        };
        this.contest_recording_session = options.sessionId;
        const startToken = ++this.contest_recording_token;
        this.contest_recorders = (options.externalCameras || []).map(camera =>
            new PovRecorder(this.bot, camera.id)
        );
        const started = [this.pov_recorder, ...this.contest_recorders];

        const statuses = await Promise.all([
            this.pov_recorder.start({
                ...common,
                camera: 'follow',
                recordingRole: 'participant-pov',
            }),
            ...this.contest_recorders.map((recorder, index) => {
                const camera = options.externalCameras[index];
                const cameraMode = camera.camera || 'fixed';
                return recorder.start({
                    ...common,
                    camera: cameraMode,
                    recordingRole: camera.recordingRole
                        || (cameraMode === 'fixed' ? 'arena-overview' : 'participant-wide'),
                    fps: camera.fps ?? 15,
                    width: camera.width ?? 960,
                    height: camera.height ?? 540,
                    viewDistance: camera.viewDistance ?? 8,
                    cameraPosition: camera.position,
                    cameraTarget: camera.target,
                    followDistance: camera.followDistance,
                    followHeight: camera.followHeight,
                });
            }),
        ]);
        // A stop can land while these renderers are still coming up, which is the
        // normal outcome when the server stopped waiting on us. That stop cleared
        // contest_recorders, so nothing else can reach the cameras we just opened:
        // shut them down here or they run untracked for the rest of the match.
        if (this.contest_recording_token !== startToken) {
            // The shared POV recorder may already have been handed back to
            // continuous recording by that stop, so only reclaim it if it is
            // still holding our session.
            const orphaned = started.filter(recorder => recorder !== this.pov_recorder
                || recorder.sessionId === options.sessionId);
            await Promise.allSettled(orphaned.map(recorder => recorder.stop()));
            return { sessionId: options.sessionId, recordings: [], superseded: true };
        }
        const failed = statuses.find(status => status.error);
        if (failed) {
            await this.stopContestRecording();
            throw new Error(failed.error);
        }
        serverProxy.sendRecordingUpdate(this.recordingStatus());
        return { sessionId: options.sessionId, recordings: statuses };
    }

    async stopContestRecording() {
        if (!this.contest_recording_session) {
            return { sessionId: null, recordings: [] };
        }
        this.contest_recording_token++;
        const sessionId = this.contest_recording_session;
        const recorders = [this.pov_recorder, ...this.contest_recorders];
        const statuses = await Promise.all(recorders.map(recorder => recorder.stop()));
        this.contest_recorders = [];
        this.contest_recording_session = null;

        const restore = this._contestRecordingRestore;
        this._contestRecordingRestore = null;
        if (restore?.continuous) {
            await this.pov_recorder.start();
        } else if (restore?.autoRecord) {
            await this.setAutoRecording(true);
        }
        serverProxy.sendRecordingUpdate(this.recordingStatus());
        return { sessionId, recordings: statuses };
    }

    /**
     * Game contests are scored from the world at the deadline instead of from
     * bot submissions, so remember every block this bot places while a game
     * session is running.
     */
    _trackGameBlockPlacements() {
        this.game_block_placements = new Map();
        // Cheat-mode placements go out as /setblock chat, so skills report those
        // through this hook instead of mineflayer's blockPlaced event.
        this.bot.recordPlacedBlock = (x, y, z) => {
            if (this.game_block_placements.size >= MAX_TRACKED_PLACEMENTS) return;
            const block = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
            if (!Number.isFinite(block.x) || !Number.isFinite(block.y) || !Number.isFinite(block.z)) {
                return;
            }
            this.game_block_placements.set(`${block.x},${block.y},${block.z}`, block);
        };
        this.bot.on('blockPlaced', (oldBlock, newBlock) => {
            const position = newBlock?.position;
            if (!position) return;
            this.bot.recordPlacedBlock(position.x, position.y, position.z);
        });
    }

    _watchContestWinItem() {
        const checkInventory = () => {
            const winItem = settings.game_session?.winItem;
            if (winItem !== this._contestWinItem) {
                this._contestWinItem = winItem;
                this._contestWinReported = false;
            }
            if (!winItem || this._contestWinReported || !this.bot?.inventory) return;
            const hasWinItem = this.bot.inventory.items().some(item => item.name === winItem);
            if (!hasWinItem) return;
            this._contestWinReported = true;
            const position = this.bot.entity?.position;
            reportContestWinItem(winItem, position ? {
                x: position.x,
                y: position.y,
                z: position.z,
            } : null).catch(error => {
                if (/not accepting|deadline|already finished/i.test(error.message)) return;
                console.error(`[${this.name}] Could not report contest win item:`, error.message);
                this._contestWinReported = false;
                setTimeout(checkInventory, 1000);
            });
        };
        this.bot.inventory.on('updateSlot', checkInventory);
        this._contestWinItemInterval = setInterval(checkInventory, 1000);
        this._contestWinItemInterval.unref?.();
        checkInventory();
    }

    _reportContestDeath() {
        if (
            settings.game_session?.contestType === 'spleef'
            || settings.game_session?.contestType === 'team_base_siege'
        ) {
            this._reportContestEliminated('death');
            return;
        }
        if (settings.game_session?.contestType === 'team_tower_battle') {
            const position = this.bot?.entity?.position;
            reportContestDeath({
                event: 'death',
                position: position
                    ? { x: position.x, y: position.y, z: position.z }
                    : null,
            }).catch(error => {
                if (/not accepting|deadline|already finished/i.test(error.message)) return;
                console.error(`[${this.name}] Could not report team tower death:`, error.message);
            });
            return;
        }
        if (
            settings.game_session?.contestType !== 'death_race'
            || this._contestDeathReported
        ) {
            return;
        }
        this._contestDeathReported = true;
        reportContestDeath().catch(error => {
            if (/not accepting|deadline|already finished/i.test(error.message)) return;
            console.error(`[${this.name}] Could not report contest death:`, error.message);
            this._contestDeathReported = false;
        });
    }

    _watchSpleefFall() {
        const checkFall = () => {
            if (settings.game_session?.contestType !== 'spleef') return;
            if (this._contestEliminatedReported) return;
            const floorY = settings.game_session?.floorY;
            if (!Number.isFinite(floorY)) return;
            const position = this.bot?.entity?.position;
            if (!Number.isFinite(position?.y)) return;
            if (position.y < floorY) {
                this._reportContestEliminated('fell');
            }
        };
        this._spleefFallInterval = setInterval(checkFall, 250);
        this._spleefFallInterval.unref?.();
        checkFall();
    }

    _reportContestEliminated(reason = 'fell') {
        const contestType = settings.game_session?.contestType;
        if (
            (contestType !== 'spleef' && contestType !== 'team_base_siege')
            || this._contestEliminatedReported
        ) {
            return;
        }
        this._contestEliminatedReported = true;
        // Elimination is final in these games, so do not wait on the server to
        // agree before going quiet — the round trip is long enough for a couple
        // more lines to reach the speakers.
        this.markEliminated(reason);
        const position = this.bot?.entity?.position;
        reportContestEliminated({
            reason,
            position: position ? {
                x: position.x,
                y: position.y,
                z: position.z,
            } : null,
        }).catch(error => {
            if (/not accepting|deadline|already finished|already eliminated/i.test(error.message)) {
                return;
            }
            console.error(`[${this.name}] Could not report contest elimination:`, error.message);
            this._contestEliminatedReported = false;
        });
    }

    _isSolidAt(x, y, z) {
        const block = this.bot.blockAt(new Vec3(x, y, z));
        return Boolean(block) && block.boundingBox === 'block';
    }

    /**
     * What this bot actually built and left standing, plus the pillar it ends
     * the game on, so the contest judge can measure tower height and credit
     * each tower to whoever placed most of its blocks.
     */
    gameTowerReport() {
        const placements = [...(this.game_block_placements?.values() ?? [])];
        const blocks = placements.filter(block => this._isSolidAt(block.x, block.y, block.z));
        return {
            participantId: this.name,
            blocks,
            placementsTracked: placements.length,
            standingOn: this._solidBlockUnderBot(),
        };
    }

    _solidBlockUnderBot() {
        const position = this.bot.entity?.position;
        if (!position) return null;
        const x = Math.floor(position.x);
        const z = Math.floor(position.z);
        const feetY = Math.floor(position.y);
        for (let y = feetY - 1; y >= feetY - MAX_PILLAR_PROBE; y -= 1) {
            if (this._isSolidAt(x, y, z)) return { x, y, z };
        }
        return null;
    }

    isAutoRecording() {
        return !!this.action_recorder?.armed;
    }

    async setAutoRecording(enabled) {
        if (enabled) {
            if (!this.action_recorder)
                this.action_recorder = new ActionRecorder(this, this.pov_recorder);
            this.action_recorder.arm();
        } else if (this.action_recorder) {
            await this.action_recorder.disarm();
        }
        const status = this.recordingStatus();
        serverProxy.sendRecordingUpdate(status);
        return status;
    }

    cleanKill(msg='Killing agent process...', code=1) {
        if (this._cleanKilling) {
            return;
        }
        this._cleanKilling = true;
        // Fire-and-forget: even if the process exits first, ffmpeg sees EOF on
        // its input pipe and finalizes a playable MP4 on its own.
        try { this.action_recorder?.stop(); } catch (_) { /* recorder may not exist yet */ }
        try { this.pov_snapshotter?.stop(); } catch (_) { /* recorder may not exist yet */ }
        try { this.pov_recorder?.stop(); } catch (_) { /* recorder may not exist yet */ }
        for (const recorder of this.contest_recorders || []) {
            try { recorder.stop(); } catch (_) { /* recorder may not exist yet */ }
        }
        this.history.add('system', msg);
        // code === 1 restarts the agent process; other codes leave for good.
        // Say something reassuring so players don't worry when bots vanish for updates.
        const farewell = code === 1
            ? "Be right back soon!"
            : "Heading out for a bit — we'll be back soon!";
        try {
            if (this.bot && !this._disconnectHandled) {
                this.bot.chat(farewell);
            }
        } catch (err) {
            console.warn('Could not send farewell chat:', err.message);
        }
        this.history.save();
        // Give the chat packet a moment to flush before the process dies.
        setTimeout(() => process.exit(code), 500);
    }
    async checkTaskDone() {
        // messages can arrive from other agents before init assigns this.task
        if (this.task?.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}