// Content for the /architecture page. Kept as data (not markup) so the renderer
// in architecture.js can wire diagram nodes to the NODES registry by id.

export const NODES = {
    mainJs: {
        title: 'main.js',
        kind: 'entry point',
        summary: 'Process entry. Parses CLI flags, applies environment overrides onto settings.js, starts MindServer, then creates one agent per configured profile.',
        files: ['main.js', 'settings.js'],
        notes: [
            'CLI: --profiles, --task_path, --task_id.',
            'Env overrides: MINECRAFT_PORT, MINDSERVER_PORT, PROFILES, INSECURE_CODING, BLOCKED_ACTIONS, MAX_MESSAGES, NUM_EXAMPLES, LOG_ALL, SETTINGS_JSON.',
        ],
    },
    mindServer: {
        title: 'MindServer',
        kind: 'hub process',
        summary: 'Express + Socket.IO server bound to localhost on settings.mindserver_port (default 8080). Serves the operator UI, owns every coordinator, and is the only thing both the browser and the bot processes talk to.',
        files: ['src/mindcraft/mindserver.js', 'src/mindcraft/mindcraft.js'],
        listens: ['get-settings', 'connect-agent-process', 'login-agent', 'create-agent', 'stop-agent', 'set-agent-settings', 'bot-output'],
        emits: ['agents-status', 'state-update', 'colony-update', 'contest-update', 'survivor-update'],
        notes: ['Binds to localhost only; public hosting is explicitly not supported.'],
    },
    operatorUI: {
        title: 'Operator UI',
        kind: 'browser',
        summary: 'The static pages served from src/mindcraft/public. Every page opens a Socket.IO connection to the same port and subscribes to the coordinator it cares about.',
        files: [
            'src/mindcraft/public/index.html',
            'src/mindcraft/public/survivor.html',
            'src/mindcraft/public/games_archive.html',
            'src/mindcraft/public/seasons.html',
            'src/mindcraft/public/conversations.html',
        ],
        notes: ['Routes: /colony, /games, /games/archive, /survivor, /conversations, /seasons, /architecture.'],
    },
    colonyCoordinator: {
        title: 'ColonyCoordinator',
        kind: 'coordinator',
        summary: 'Owns the persistent colony: phase progression, the task board, leases, and agent roles. Pure state machine — it never talks to sockets itself; the supervisor loop in mindserver.js drives it.',
        files: ['src/mindcraft/colony/colony_coordinator.js', 'src/agent/commands/colony.js'],
        listens: ['colony-ready', 'colony-command', 'colony-control'],
        emits: ['colony-update', 'colony-directive'],
        notes: ['State under ./colony (state.json, plan.md, journal.jsonl, notes/, blueprints/, code/).'],
    },
    contestCoordinator: {
        title: 'ContestCoordinator',
        kind: 'coordinator',
        summary: 'Holds the active contest, accepts submissions and elimination reports, and finalizes a match by calling the injected judge. Ticked once per second by ContestLoop.',
        files: ['src/mindcraft/contest/contest_coordinator.js', 'src/mindcraft/contest/contest_loop.js'],
        listens: ['contest-win-item', 'contest-death', 'contest-eliminated', 'contest-button-pressed', 'contest-submit'],
        emits: ['contest-update'],
        notes: ['State under ./contests (state.json + append-only journal.jsonl).'],
    },
    gameSessionManager: {
        title: 'GameSessionManager',
        kind: 'orchestrator',
        summary: 'Runs the launch pipeline for a standalone game: frees bot names, spawns temporary bot processes, waits for them to join, rebuilds the arena, announces, and sends goals.',
        files: ['src/mindcraft/contest/game_session_manager.js'],
        listens: ['contest-start-game'],
        emits: ['game-directive', 'launch-log', 'contest-update'],
        notes: ['Not used by Survivor challenges — those call ContestCoordinator directly.'],
    },
    survivorSession: {
        title: 'SurvivorSessionManager',
        kind: 'orchestrator',
        summary: 'Drives a Survivor season: phase deadlines, immunity challenges, private chat brokering, tribal council questions, and voting. Ticks on the same 1s contest loop.',
        files: [
            'src/mindcraft/survivor/survivor_session_manager.js',
            'src/mindcraft/survivor/survivor_game.js',
            'src/mindcraft/survivor/survivor_coordinator.js',
        ],
        listens: ['survivor-start', 'survivor-control', 'survivor-command'],
        emits: ['survivor-update', 'survivor-talk-request', 'survivor-council-question', 'survivor-challenge-config'],
        notes: ['State under ./contests/survivor (state.json, session.json, journal.jsonl, seasons/).'],
    },
    agentProcess: {
        title: 'AgentProcess',
        kind: 'process supervisor',
        summary: 'Parent-side handle for one bot. Spawns a child Node process and restarts it on abnormal exit, unless the child lived less than 10 seconds or was stopped with SIGINT.',
        files: ['src/process/agent_process.js'],
        notes: [
            'Spawn: process.execPath src/process/init_agent.js <name> -n <name> -i <id> -c <count> [-l] [-m msg] -p <port>.',
            'Exit code greater than 1 tears down the whole main process (used by task runs).',
        ],
    },
    agentRuntime: {
        title: 'Agent',
        kind: 'bot runtime',
        summary: 'The bot brain inside the child process. Owns history, the prompter, the command executor, the reactive mode tick, and the self-prompt loop.',
        files: ['src/agent/agent.js', 'src/process/init_agent.js', 'src/agent/history.js'],
        listens: ['game-directive', 'colony-directive', 'survivor-talk-request', 'restart-agent', 'send-message'],
        emits: ['bot-output', 'login-agent', 'colony-ready', 'contest-win-item', 'survivor-command'],
        notes: ['Agent.update runs every 300 ms and drives both modes and the self-prompter.'],
    },
    mindserverProxy: {
        title: 'mindserver_proxy',
        kind: 'agent-side IPC',
        summary: 'The bot process side of the socket. Fetches settings on connect, registers every server-to-agent listener, and exposes the report helpers the agent calls during a match.',
        files: ['src/agent/mindserver_proxy.js'],
        emits: ['get-settings', 'connect-agent-process', 'login-agent', 'bot-output', 'colony-command', 'survivor-command'],
        notes: ['Settings fetch times out after 5000 ms.'],
    },
    selfPrompter: {
        title: 'SelfPrompter',
        kind: 'agent loop',
        summary: 'Keeps a bot working toward a goal without a human in the loop. Repeatedly feeds a system message back into handleMessage until interrupted.',
        files: ['src/agent/self_prompter.js'],
        notes: [
            'Cooldown 20000 ms between successful command turns.',
            'Three consecutive turns without a command stop the loop (or back off 40 s when colony mode is enabled).',
        ],
    },
    modes: {
        title: 'Reactive modes',
        kind: 'agent loop',
        summary: 'Interrupt-driven survival behaviors checked on every 300 ms tick. The first active mode that matches wins and can interrupt the self-prompt loop.',
        files: ['src/agent/modes.js'],
        notes: ['Priority order: self_preservation, unstuck, cowardice, self_defense, hunting, item_collecting, torch_placing, elbow_room, idle_staring, cheat.'],
    },
    actionManager: {
        title: 'ActionManager',
        kind: 'agent loop',
        summary: 'Runs one long-lived skill at a time (pathfinding, mining, building) so the 300 ms tick is never blocked, and can cancel it when a mode or directive interrupts.',
        files: ['src/agent/action_manager.js', 'src/agent/library/skills.js'],
    },
    commands: {
        title: 'Command system',
        kind: 'agent',
        summary: 'Parses !command(args) out of model output and dispatches it. Queries return strings; actions change the world and are the only kind that can be blocked.',
        files: ['src/agent/commands/index.js', 'src/agent/commands/actions.js', 'src/agent/commands/queries.js'],
        notes: ['Registry = queries + colony queries + actions + colony actions + survivor actions.'],
    },
    prompter: {
        title: 'Prompter',
        kind: 'llm',
        summary: 'Merges the profile chain, picks a provider, fills the conversing template with live world state, and calls the model. Also owns coding, vision, and memory prompts.',
        files: ['src/models/prompter.js', 'src/models/_model_map.js'],
        notes: ['Profile chain: profiles/defaults/_default.json, then settings.base_profile, then the individual profile.'],
    },
    quotaGuard: {
        title: 'quota_guard',
        kind: 'llm',
        summary: 'Classifies provider errors into fatal (auth, quota) versus retryable, and raises a model outage so the bot pauses self-prompting instead of spinning on a dead key.',
        files: ['src/models/quota_guard.js'],
        notes: ['Outage handler fires at most once per 30 s.'],
    },
    llmProviders: {
        title: 'LLM providers',
        kind: 'third party',
        summary: 'Twenty-one provider adapters loaded dynamically from src/models. The profile string "provider/model" selects one; unprefixed names fall back to heuristics.',
        files: ['src/models/_model_map.js', 'src/models/gpt.js', 'src/models/claude.js', 'src/models/gemini.js'],
        notes: ['Keys resolve from keys.json, then code/.env, then .env, then process.env.'],
    },
    mineflayer: {
        title: 'Mineflayer bot',
        kind: 'third party',
        summary: 'The Minecraft protocol client. Every skill and mode ultimately drives this object; the pathfinder, pvp, collectblock, armor-manager and auto-eat plugins hang off it.',
        files: ['src/utils/mcdata.js', 'src/agent/library/skills.js'],
        notes: ['createBot uses settings host, port, auth and version; version is omitted when set to auto.'],
    },
    minecraftServer: {
        title: 'Minecraft server',
        kind: 'third party',
        summary: 'A Java edition server, typically the mindcraft-mc Docker container. Reached two ways: the bots connect over the game protocol, and MindServer issues operator commands over RCON.',
        notes: ['Defaults: host 127.0.0.1, port 55916, auth offline. Port -1 triggers a LAN scan.'],
    },
    rcon: {
        title: 'RCON bridge',
        kind: 'third party',
        summary: 'Server-side world control. Every arena rebuild, teleport, gamemode change and scoreboard probe shells out through the Minecraft container.',
        files: ['src/mindcraft/minecraft_server.js', 'src/mindcraft/contest/arena_manager.js'],
        notes: [
            'Command shape: docker exec <MC_CONTAINER> rcon-cli <command>.',
            'Container name from env MC_CONTAINER, default mindcraft-mc. 15 s timeout per command.',
        ],
    },
    arenaManager: {
        title: 'ContestArenaManager',
        kind: 'orchestrator',
        summary: 'Rebuilds the contest arena from scratch before every match: clears the volume, lays the floor, rigs simultaneous teleports, and audits placement and inventory.',
        files: ['src/mindcraft/contest/arena_manager.js'],
        notes: ['Arena centered at x 100000, z 100000, floor y 100, half-size 32. Spectators at y 140.'],
    },
    voiceOutput: {
        title: 'Voice output',
        kind: 'media',
        summary: 'Turns bot speech into audio. Bots either speak locally through their own TTS path or ask MindServer to synthesize and broadcast, which is how the announcer and recordings stay in sync.',
        files: ['src/mindcraft/voice_output.js', 'src/agent/speak.js', 'src/agent/tts_voices.js'],
        listens: ['contest-speech', 'voice-mute', 'start-voice-monitor'],
        emits: ['bot-voice', 'bot-voice-clear', 'voice-health'],
        notes: ['ElevenLabs by default (ELEVENLABS_API_KEY); OpenAI and Gemini TTS also supported, plus a system voice fallback.'],
    },
    elevenLabs: {
        title: 'ElevenLabs',
        kind: 'third party',
        summary: 'Default text-to-speech provider for bot voices and the contest announcer. Per-bot voice assignments live in voices.json.',
        files: ['src/models/elevenlabs.js', 'src/agent/tts_voices.js'],
        notes: ['ELEVENLABS_API_KEY; voice registry path overridable with MINDCRAFT_VOICES_PATH.'],
    },
    recording: {
        title: 'Recording and highlights',
        kind: 'media',
        summary: 'Per-bot POV capture plus post-match highlight reels. Both shell out to ffmpeg; playback of synthesized speech uses ffplay.',
        files: [
            'src/agent/vision/pov_recorder.js',
            'src/mindcraft/contest/contest_recording.js',
            'src/mindcraft/contest/highlight_reel.js',
        ],
        notes: ['Requires ffmpeg on PATH. Output under bots/<name>/recordings.'],
    },
    browserViewer: {
        title: 'Browser viewer',
        kind: 'media',
        summary: 'Prismarine viewer instance per bot, used by the live wall and by the recorder as a camera source.',
        files: ['src/agent/vision/browser_viewer.js'],
        notes: ['Port 3000 + agent index, bound to 127.0.0.1.'],
    },
    contestArchive: {
        title: 'ContestArchive',
        kind: 'observability',
        summary: 'Rebuilds finished games for the Games Log page by replaying the append-only contest journal against the current state file.',
        files: ['src/mindcraft/contest/contest_archive.js', 'src/mindcraft/public/games_archive.js'],
        listens: ['contest-archive-list', 'contest-archive-game'],
    },
    survivorArchive: {
        title: 'Season archive',
        kind: 'observability',
        summary: 'Completed and cancelled seasons written out as standalone JSON so the Archive and Conversations pages can replay them, including private room transcripts.',
        files: ['src/mindcraft/survivor/survivor_archive.js', 'src/mindcraft/public/seasons.js'],
        listens: ['survivor-seasons', 'survivor-season', 'survivor-transcripts'],
    },
    launchTelemetry: {
        title: 'Launch telemetry',
        kind: 'observability',
        summary: 'Streams every launch pipeline step to the UI and writes a failure report when a game fails to start, so a bad launch can be diagnosed after the fact.',
        files: ['src/mindcraft/diagnostics/launch_telemetry.js'],
        emits: ['launch-log'],
        listens: ['launch-log-history', 'diagnostics-report'],
        notes: ['Failure reports under ./launch-failures, overridable with MINDCRAFT_LAUNCH_FAILURE_DIR.'],
    },
    privateRooms: {
        title: 'Private rooms',
        kind: 'survivor',
        summary: 'Off-channel group chats between bots. A bot requests one, invitees accept or decline, and the survivors talk in a room nobody else can read — which is where alliances actually form.',
        files: ['src/mindcraft/survivor/private_rooms.js', 'src/mindcraft/survivor/conversation_requests.js'],
        notes: [
            'Max 4 invitees, 30 s request TTL, 45 s cooldown after a decline.',
            'Blocked during the challenge phase; all rooms close when a challenge starts.',
        ],
    },
    survivorGame: {
        title: 'survivor_game',
        kind: 'state machine',
        summary: 'Pure reducer for the season. Every transition is a named method that returns new state plus journal events; the session manager is the only thing that calls it.',
        files: ['src/mindcraft/survivor/survivor_game.js'],
        notes: ['Phases: challenge, strategy, tribal_council, voting, revote, deadlock, fire_making, jury_questioning, jury_voting, finalist_tiebreak, completed, cancelled.'],
    },
};

export const SECTIONS = [
    {
        id: 'overview',
        title: 'System topology',
        eyebrow: 'start here',
        blocks: [
            {
                type: 'prose',
                html: `<p>Mindcraft runs as a <strong>process tree with one hub</strong>. <code>main.js</code> starts MindServer, an Express and Socket.IO server bound to <code>localhost:8080</code>, and then spawns one child Node process per bot. Nothing else is long-lived.</p>
<p>The important thing to internalize: <strong>Colony, Contest games and Survivor are not separate services</strong>. They are coordinator objects living inside the MindServer process. They never touch Minecraft or an LLM directly. They change their own state and push socket messages at bots, and the bots decide what that means in the world.</p>
<p>That gives you exactly three kinds of traffic to reason about: browser to MindServer, MindServer to bot process, and bot process out to the world (Minecraft and the model APIs). The one exception is RCON, where MindServer reaches into the Minecraft container directly to rebuild arenas and move players.</p>`,
            },
            {
                type: 'diagram',
                id: 'topology',
                height: 620,
                title: 'Everything, at once',
                caption: 'Solid arrows are calls or spawns; the double arrow between the agent and MindServer is the persistent Socket.IO connection carrying every directive and report.',
                mermaid: `flowchart TB
    subgraph browser [Browser]
        operatorUI["Operator UI"]
    end

    subgraph hub [MindServer process]
        mindServer["MindServer :8080"]
        colonyCoordinator["ColonyCoordinator"]
        contestCoordinator["ContestCoordinator"]
        gameSessionManager["GameSessionManager"]
        survivorSession["SurvivorSessionManager"]
        arenaManager["ContestArenaManager"]
        voiceOutput["Voice output"]
    end

    subgraph child [Bot process, one per agent]
        agentRuntime["Agent"]
        mindserverProxy["mindserver_proxy"]
        prompter["Prompter"]
        mineflayer["Mineflayer bot"]
    end

    subgraph outside [Third parties]
        minecraftServer["Minecraft server"]
        rcon["RCON bridge"]
        llmProviders["LLM providers"]
        elevenLabs["ElevenLabs"]
    end

    mainJs["main.js"] --> mindServer
    mainJs --> agentProcess["AgentProcess"]
    agentProcess --> agentRuntime

    operatorUI <-->|"socket.io"| mindServer
    mindServer --> colonyCoordinator
    mindServer --> contestCoordinator
    mindServer --> survivorSession
    gameSessionManager --> contestCoordinator
    survivorSession --> contestCoordinator
    gameSessionManager --> arenaManager
    arenaManager --> rcon
    mindServer --> voiceOutput
    voiceOutput --> elevenLabs

    agentRuntime <--> mindserverProxy
    mindserverProxy <-->|"socket.io"| mindServer
    agentRuntime --> prompter
    prompter --> llmProviders
    agentRuntime --> mineflayer
    mineflayer -->|"game protocol"| minecraftServer
    rcon -->|"docker exec rcon-cli"| minecraftServer`,
            },
            {
                type: 'facts',
                title: 'Ports and endpoints',
                items: [
                    ['MindServer', 'localhost:8080 (settings.mindserver_port), localhost-only bind'],
                    ['Minecraft', '127.0.0.1:55916 by default; port -1 triggers a LAN scan'],
                    ['Browser viewer', '127.0.0.1:(3000 + agent index), one per bot'],
                    ['Agent identity', '<profile name>#<sequence>, e.g. andy#1'],
                ],
            },
        ],
    },
    {
        id: 'boot',
        title: 'Boot and process model',
        eyebrow: 'lifecycle',
        blocks: [
            {
                type: 'prose',
                html: `<p>A bot is in the world only after a five-hop handshake: the parent registers it, spawns a child, the child pulls its settings back down over the socket, logs into Minecraft, and then announces itself. Each hop can fail independently, which is why a bot that "doesn't start" is usually stuck at a specific one of them.</p>
<p>Note that the child process gets its configuration <em>from the socket</em>, not from disk. <code>settings.js</code> is read once in the parent; the child asks for a copy with <code>get-settings</code> keyed by its instance id. That is what makes per-game overrides possible without touching any file.</p>`,
            },
            {
                type: 'diagram',
                id: 'boot',
                title: 'From node main.js to a bot standing in the world',
                caption: 'The dashed return is the settings copy: the child cannot proceed until MindServer answers, and gives up after 5 seconds.',
                mermaid: `sequenceDiagram
    participant CLI as node main.js
    participant MS as MindServer
    participant AP as AgentProcess
    participant Child as init_agent.js
    participant MC as Minecraft

    CLI->>MS: init(port 8080)
    CLI->>MS: registerAgent(profile)
    MS-->>CLI: agentId = name#seq
    CLI->>AP: new AgentProcess(agentId, port)
    AP->>Child: spawn(process.execPath, init_agent.js)
    Child->>MS: get-settings(agentId)
    MS-->>Child: settings copy
    Child->>MS: connect-agent-process(agentId)
    Child->>MC: initBot / mineflayer login
    MC-->>Child: spawn event
    Child->>MS: login-agent(agentId)
    Child->>MS: colony-ready (unless game_session)`,
            },
            {
                type: 'steps',
                title: 'What each hop actually does',
                items: [
                    { name: 'Settings resolve', detail: 'CLI flags override settings.profiles, then environment variables are applied. SETTINGS_JSON is merged wholesale, which is how Docker and CI inject config.' },
                    { name: 'registerAgent', detail: 'Allocates the instance id as `${profile.name}#${++agent_id_seq}` and a viewer port of 3000 + index. The Minecraft username stays the bare profile name.' },
                    { name: 'spawn', detail: 'Uses process.execPath so the child runs the same Node binary. Arguments carry the name, instance id, count id, memory flag, optional init message, and the MindServer port.' },
                    { name: 'get-settings', detail: 'The child populates its own settings singleton from the response. Times out after 5000 ms.' },
                    { name: 'Login and spawn', detail: 'Mineflayer connects; if the spawn event does not arrive within settings.spawn_timeout seconds (default 30), the child exits 1.' },
                    { name: 'colony-ready', detail: 'Sent only when settings.game_session is unset. This is the switch that keeps temporary contest bots out of the colony roster.' },
                ],
            },
            {
                type: 'prose',
                html: `<h3>Restart semantics</h3>
<p>The parent watches the child's exit and decides whether to bring it back. The rules are worth knowing because they explain both crash loops and bots that silently stay down:</p>`,
            },
            {
                type: 'table',
                head: ['Exit condition', 'Parent behavior'],
                rows: [
                    ['Code 0, or signal SIGINT', 'No restart. This is the intentional-stop path used by the Stop button.'],
                    ['Code greater than 1', 'The whole main process exits with that code. Used to end task runs.'],
                    ['Nonzero, lived under 10 s', 'No restart. Prevents a broken profile from spinning forever.'],
                    ['Nonzero, lived over 10 s', 'Restarts with load_memory true and an "Agent process restarted." init message.'],
                ],
            },
        ],
    },
    {
        id: 'agent',
        title: 'Agent runtime loop',
        eyebrow: 'the bot brain',
        blocks: [
            {
                type: 'prose',
                html: `<p>Inside a bot process there are <strong>three loops running at different speeds</strong>, and most confusing bot behavior comes from one interrupting another.</p>
<p>The fast loop is <code>Agent.update</code> at 300 ms: it runs reactive modes and nudges the self-prompter. The slow loop is the LLM conversation, driven by <code>handleMessage</code>, where each turn is a model call. Underneath both, the action manager runs one long skill at a time so pathfinding never blocks the tick.</p>
<p>A directive from Colony or a game does not directly control the bot. It becomes a goal string handed to the self-prompter, which then generates conversation turns until something interrupts it. Everything the bot does in the world comes out of a model response containing a <code>!command</code>.</p>`,
            },
            {
                type: 'diagram',
                id: 'agentLoop',
                title: 'One conversation turn',
                caption: 'The loop repeats up to settings.max_commands times per message. A response without a command ends the turn immediately.',
                mermaid: `sequenceDiagram
    participant Src as Chat, directive or self-prompt
    participant Agent as Agent.handleMessage
    participant Hist as History
    participant Prompt as Prompter
    participant LLM as LLM provider
    participant Cmd as executeCommand
    participant World as Mineflayer

    Src->>Agent: message
    Agent->>Hist: add(source, message)
    loop up to max_commands
        Agent->>Prompt: promptConvo(history)
        Prompt->>LLM: sendRequest
        LLM-->>Prompt: response text
        Prompt-->>Agent: response
        alt contains a command
            Agent->>Cmd: executeCommand(response)
            Cmd->>World: skill or query
            World-->>Cmd: result
            Cmd-->>Agent: result string
            Agent->>Hist: add(system, result)
        else plain conversation
            Agent->>Hist: add(self, response)
            Agent->>Src: routeResponse
        end
    end`,
            },
            {
                type: 'table',
                title: 'The three loops',
                head: ['Loop', 'Cadence', 'What it does', 'How it interrupts'],
                rows: [
                    ['Reactive modes', '300 ms', 'Survival reflexes: drowning, fire, low health, stuck, combat, item pickup, torch placing.', 'First matching active mode wins and can stop the self-prompt loop.'],
                    ['Self-prompter', '20 s cooldown per turn', 'Keeps working a goal with no human present. Feeds a system message back into handleMessage.', 'Stops after 3 consecutive turns with no command; a user action command also stops it.'],
                    ['Action manager', 'One at a time', 'Executes long-running skills so the tick stays responsive.', 'Cancelled by modes or a new directive.'],
                ],
            },
            {
                type: 'prose',
                html: `<h3>Commands</h3>
<p>Model output is scanned for <code>!name(args)</code>. The registry is assembled at import time from queries, colony queries, actions, colony actions and survivor actions. The split matters: <strong>queries</strong> only return strings, <strong>actions</strong> change the world, and only actions can be blocked through <code>settings.blocked_actions</code>. Four commands can never be blocked: <code>!stop</code>, <code>!stats</code>, <code>!inventory</code> and <code>!goal</code>.</p>
<p>Chat from a human is the one path that skips the model: if the message is itself a valid command it is executed directly, with <code>!newAction</code> as the exception since it needs the LLM to write code.</p>`,
            },
        ],
    },
    {
        id: 'llm',
        title: 'LLM stack',
        eyebrow: 'model plumbing',
        blocks: [
            {
                type: 'prose',
                html: `<p>A profile is not one model. Up to five are resolved independently — chat, code, vision, memory and embedding — so a bot can think on a large model while embedding locally.</p>
<p>Profiles merge in a chain, each layer overriding the last: <code>profiles/defaults/_default.json</code>, then the base profile named by <code>settings.base_profile</code> (survival, assistant, creative or god_mode), then the individual profile file. That is why changing a bot often means editing the base profile rather than the bot's own JSON.</p>`,
            },
            {
                type: 'diagram',
                id: 'llmStack',
                title: 'Profile to provider',
                caption: 'selectAPI resolves the provider from an explicit prefix, then a key match, then name heuristics such as claude to anthropic.',
                mermaid: `flowchart LR
    defaults["profiles/defaults/_default.json"] --> merge["Merged profile"]
    base["base_profile"] --> merge
    own["profiles bot json"] --> merge
    merge --> select["selectAPI"]
    select --> map["_model_map apiMap"]
    map --> chat["chat_model"]
    map --> code["code_model"]
    map --> vision["vision_model"]
    map --> memory["memory_model"]
    chat --> prompter["Prompter"]
    prompter --> llmProviders["LLM providers"]
    llmProviders -->|"error"| quotaGuard["quota_guard"]
    quotaGuard -->|"outage"| selfPrompter["SelfPrompter pause"]`,
            },
            {
                type: 'prose',
                html: `<p><code>promptConvo</code> waits out the profile cooldown, fills the <code>conversing</code> template with live state (<code>$STATS</code>, <code>$INVENTORY</code>, <code>$COMMAND_DOCS</code>, <code>$EXAMPLES</code>, <code>$MEMORY</code>, <code>$SELF_PROMPT</code>), appends the speech-style and game-session addenda, and calls the model with up to two attempts.</p>
<p>When a call fails, <code>quota_guard</code> decides whether it is worth retrying. Auth and quota failures are fatal: they raise a model outage, the bot pauses self-prompting and reports up to the colony rather than burning turns on a dead key.</p>`,
            },
            {
                type: 'table',
                title: 'Providers and their keys',
                head: ['Provider prefix', 'Key'],
                rows: [
                    ['openai', 'OPENAI_API_KEY (optional OPENAI_ORG_ID)'],
                    ['anthropic', 'ANTHROPIC_API_KEY'],
                    ['google', 'GEMINI_API_KEY'],
                    ['xai', 'XAI_API_KEY'],
                    ['deepseek', 'DEEPSEEK_API_KEY'],
                    ['mistral', 'MISTRAL_API_KEY'],
                    ['qwen', 'QWEN_API_KEY'],
                    ['groq', 'GROQCLOUD_API_KEY'],
                    ['cerebras', 'CEREBRAS_API_KEY'],
                    ['openrouter', 'OPENROUTER_API_KEY'],
                    ['replicate', 'REPLICATE_API_KEY'],
                    ['huggingface', 'HUGGINGFACE_API_KEY'],
                    ['hyperbolic', 'HYPERBOLIC_API_KEY'],
                    ['novita', 'NOVITA_API_KEY'],
                    ['mercury', 'MERCURY_API_KEY'],
                    ['glhf', 'GHLF_API_KEY'],
                    ['azure', 'AZURE_OPENAI_API_KEY, falling back to OPENAI_API_KEY'],
                    ['cursor', 'CURSOR_API_KEY'],
                    ['ollama, vllm, lmstudio', 'No key. Local URL, ollama defaults to http://127.0.0.1:11434'],
                ],
            },
        ],
    },
    {
        id: 'colony',
        title: 'Colony',
        eyebrow: 'persistent world',
        blocks: [
            {
                type: 'prose',
                html: `<p>Colony is the always-on mode: a shared world where bots claim work off a task board and progress through phases. It is enabled by default (<code>settings.colony.enabled</code>).</p>
<p>The coordinator itself is a pure state machine. The thing that makes it move is <strong>a supervisor loop in mindserver.js running every 10 seconds</strong>. Bots are never pushed work directly; an idle bot gets a directive, the directive becomes a self-prompt goal, and the bot then claims a task through a normal command.</p>`,
            },
            {
                type: 'diagram',
                id: 'colonyLoop',
                title: 'Supervisor heartbeat',
                caption: 'Runs every colony.heartbeat_interval_ms (default 10 s). When the colony is paused it stops after emitting an update.',
                mermaid: `flowchart TB
    tick["Heartbeat, every 10 s"] --> expire["expireLeases"]
    expire --> offline["Mark disconnected agents offline"]
    offline --> outage{"Model outage?"}
    outage -->|"yes"| probe["runModelOutageProbe"]
    outage -->|"no"| paused
    probe --> paused{"Paused?"}
    paused -->|"yes"| emit["emitColonyUpdate and stop"]
    paused -->|"no"| restore["restoreDesiredAgents"]
    restore --> wall["Poll get-wall-state per bot"]
    wall --> beat["heartbeat: idle or busy"]
    beat --> idle{"Idle past idle_directive_ms?"}
    idle -->|"yes"| directive["colony-directive"]
    idle -->|"no"| emit2["emitColonyUpdate"]
    directive --> selfPrompter["SelfPrompter goal"]
    selfPrompter --> claim["Bot runs !claimColonyTask"]
    claim --> colonyCoordinator["ColonyCoordinator"]
    colonyCoordinator --> emit2`,
            },
            {
                type: 'table',
                title: 'Phases, in order',
                head: ['Phase id', 'Objective'],
                rows: [
                    ['epic-megabase', 'The headline mission: private rooms per agent, themed public rooms, full gear. This is the default starting phase.'],
                    ['bootstrap', 'Tools, shared coordinates, and immediate safety before the first night.'],
                    ['shelter', 'A defended shared base with beds, storage, lighting and organized supplies.'],
                    ['food-security', 'Renewable food, wood and animal systems that sustain eight agents.'],
                    ['iron-age', 'Iron gear, buckets, shields, furnaces and mining infrastructure.'],
                    ['enchantment', 'Diamonds, obsidian, enchanting, experience and durable upgrades.'],
                    ['nether', 'Safe Nether logistics, blaze rods, nether wart and brewing.'],
                    ['stronghold', 'Eyes of ender, locate the stronghold, prepare an expedition cache.'],
                    ['endgame', 'Defeat the Ender Dragon, secure End access, recover elytra and shulker shells.'],
                    ['postgame-civilization', 'Continuous expansion: automation, transport, trade, defenses, monuments.'],
                ],
            },
            {
                type: 'prose',
                html: `<h3>Task leases</h3>
<p>Work is leased, not assigned. Claiming a task sets <code>claimedBy</code> and a <code>leaseExpiresAt</code> five minutes out (<code>colony.task_lease_ms</code>). Reporting progress extends the lease; a heartbeat deliberately does not. When a lease expires the task drops back to <code>proposed</code> so a stuck bot cannot sit on the critical path forever.</p>
<p>When every required task in a phase is complete the colony advances automatically. At the last phase it increments the civilization epoch instead and keeps going.</p>`,
            },
            {
                type: 'table',
                title: 'Bot commands',
                head: ['Command', 'Effect'],
                rows: [
                    ['!colonyStatus', 'Read the board: phase, objective, open tasks.'],
                    ['!colonyTask', 'Details for the task this bot holds.'],
                    ['!claimColonyTask', 'Take the highest-priority proposed task, preferring a role match.'],
                    ['!completeColonyTask / !failColonyTask', 'Release the lease with an outcome.'],
                    ['!proposeColonyTask', 'Add a task to the board.'],
                    ['!recordColonyProgress', 'Journal a progress note and extend the lease.'],
                    ['!publishColonyArtifact', 'Write into notes/, blueprints/ or code/. Max 64 KiB, .md .txt .json .js only.'],
                    ['!requestColonyAgent', 'Ask for another bot. Always rejected: the roster is UI-managed.'],
                ],
            },
        ],
    },
    {
        id: 'contest',
        title: 'Contest games',
        eyebrow: 'competitive matches',
        blocks: [
            {
                type: 'prose',
                html: `<p>A contest game is a self-contained match with its own throwaway bots. Starting one from the Games page runs a <strong>nine-step launch pipeline</strong>, and each step reports to the UI as it completes — which is why a failed launch tells you exactly where it died.</p>
<p>The bots spawned here are temporary. They are created with <code>game_session</code> set, which disables colony participation and means they never register on the colony roster.</p>`,
            },
            {
                type: 'diagram',
                id: 'contestLaunch',
                title: 'Launch pipeline',
                caption: 'Three steps are conditional: recording only when enabled, and the two team phases only for team games with a nonzero duration.',
                mermaid: `flowchart TB
    ui["contest-start-game"] --> reclaim["reclaim_names"]
    reclaim --> create["create_agent"]
    create --> wait["wait_ready"]
    wait --> arena["prepare_arena"]
    arena --> rec["start_recording, if enabled"]
    rec --> plan["team_planning, team games"]
    plan --> build["team_build, base siege"]
    build --> announce["announce"]
    announce --> goals["send_goals"]
    goals --> start["startContest, clock runs"]
    arena --> arenaManager["ContestArenaManager"]
    arenaManager --> rcon["RCON bridge"]
    goals --> agentRuntime["Agent"]`,
            },
            {
                type: 'steps',
                title: 'Steps in order',
                items: [
                    { name: 'reclaim_names', detail: 'Stops any prior bot processes holding the requested Minecraft names.' },
                    { name: 'create_agent', detail: 'Creates the contest, then spawns one temporary bot process per participant.' },
                    { name: 'wait_ready', detail: 'Polls until every bot is actually in the world, or times out.' },
                    { name: 'prepare_arena', detail: 'Rebuilds the arena over RCON, teleports everyone simultaneously, audits placement and inventory.' },
                    { name: 'start_recording', detail: 'Conditional. Starts multi-angle capture.' },
                    { name: 'team_planning', detail: 'Conditional. Sends planning directives and waits out the planning window.' },
                    { name: 'team_build', detail: 'Conditional, Base Siege only. The fortification phase before combat opens.' },
                    { name: 'announce', detail: 'Spoken intro through the announcer voice.' },
                    { name: 'send_goals', detail: 'Sends each bot its game-directive. Immediately after, startContest begins the clock.' },
                ],
            },
            {
                type: 'table',
                title: 'Game presets',
                head: ['Game id', 'Scoring type', 'Premise'],
                rows: [
                    ['cake_race', 'cake_race', 'Two teams gather ingredients; first to craft a cake wins.'],
                    ['death_race', 'death_race', 'Inverted objective: first bot to die by leaving the arena wins.'],
                    ['dog_race', 'dog_race', 'Find bones in the wild and tame a wolf first.'],
                    ['diamond_race', 'diamond_race', 'Fresh quarry, first diamond in inventory.'],
                    ['netherite_race', 'netherite_race', 'Full progression to netherite.'],
                    ['tower_battle', 'tower_battle', 'Build the tallest tower with PVP enabled; measured at the deadline.'],
                    ['team_tower_battle', 'team_tower_battle', 'One shared tower per team, minus a death penalty.'],
                    ['team_base_siege', 'team_base_siege', 'Build phase, then free-for-all; last alive on the platform.'],
                    ['spleef', 'spleef', 'Dig the floor out from under rivals; last one standing.'],
                    ['hot_button', 'hot_button', 'One safe button per match; press it to win instantly.'],
                    ['deepest_2_5', 'depth_race', 'Dig for depth against a 2:30 clock; lowest Y wins.'],
                    ['deepest_5', 'depth_race', 'The same race with a 5:00 clock.'],
                ],
            },
            {
                type: 'prose',
                html: `<h3>How a match ends</h3>
<p>ContestLoop ticks the coordinator once per second. Most matches do not run to the deadline — they end early because a bot reported something. The bot side of that is a handful of report helpers on the proxy, each mapping to one socket event:</p>`,
            },
            {
                type: 'table',
                head: ['Bot reports', 'Socket event', 'Coordinator does'],
                rows: [
                    ['Win item appears in inventory', 'contest-win-item', 'declareWinner, finalize immediately'],
                    ['Bot died', 'contest-death', 'recordDeath for team tower, or declareWinner for death race'],
                    ['Fell off, out of bounds, exploded', 'contest-eliminated', 'eliminate; finalizes when one bot is left standing'],
                    ['Pressed a hot button', 'contest-button-pressed', 'markPressed; a safe press wins outright'],
                ],
            },
            {
                type: 'prose',
                html: `<p>If nobody wins early, the deadline fires and the coordinator moves to <code>judging</code>, dispatching on the preset's scoring type: an RCON depth probe for depth races, a tower measurement request sent to each bot for tower games, spleef and siege standings from the elimination record, and submission metrics as the default. Results are ranked, the contest is marked <code>completed</code>, and the whole thing is appended to the journal.</p>`,
            },
            {
                type: 'facts',
                title: 'Arena geometry',
                items: [
                    ['Center', 'x 100000, z 100000 — deliberately far from the colony world'],
                    ['Floor', 'y 100, bots spawn at y 101'],
                    ['Playable area', 'half-size 32, so a 65 by 65 footprint'],
                    ['Spectators', 'y 140'],
                    ['Rebuild path', 'docker exec $MC_CONTAINER rcon-cli, default container mindcraft-mc'],
                ],
            },
        ],
    },
    {
        id: 'survivor',
        title: 'Survivor season',
        eyebrow: 'social meta-game',
        blocks: [
            {
                type: 'prose',
                html: `<p>Survivor wraps the contest games in a social game. Contests decide immunity; everything interesting happens between them, in private rooms where bots negotiate who to vote out.</p>
<p>One structural detail worth knowing: <strong>Survivor challenges do not use GameSessionManager</strong>. The session manager talks to ContestCoordinator directly and prepares the arena itself, because the cast already exists and does not need spawning. Starting a season is blocked while a standalone game session is active.</p>`,
            },
            {
                type: 'diagram',
                id: 'survivorPhases',
                title: 'Season state machine',
                caption: 'Each phase has a deadline; when it expires the session manager auto-advances, filling in missing ballots first.',
                mermaid: `stateDiagram-v2
    [*] --> challenge
    challenge --> strategy: completeChallenge
    strategy --> tribal_council: openCouncil
    tribal_council --> voting: beginVoting
    voting --> revote: tie
    voting --> challenge: boot, next round
    revote --> deadlock: tie again
    revote --> challenge: boot
    deadlock --> fire_making: no rock draw
    deadlock --> challenge: rocks drawn
    fire_making --> challenge: boot
    challenge --> jury_questioning: finalists reached
    jury_questioning --> jury_voting: beginJuryVote
    jury_voting --> finalist_tiebreak: jury tie
    jury_voting --> completed: winner
    finalist_tiebreak --> completed
    challenge --> cancelled: cancel`,
            },
            {
                type: 'table',
                title: 'Scenarios',
                head: ['Scenario id', 'Cast', 'Merge at', 'Finalists'],
                rows: [
                    ['classic', '11', '10', '3'],
                    ['four_player', '4', '4', '2'],
                    ['six_player', '6', '4', '2'],
                ],
            },
            {
                type: 'prose',
                html: `<h3>Private rooms</h3>
<p>This is the part with no equivalent anywhere else in the system. A bot runs <code>!requestPrivateChat</code>, the registry opens a pending request and pushes <code>survivor-talk-request</code> to each invitee. Invitees accept or decline; once everyone has answered or the 30 second TTL expires, accepters are dropped into a room and messages flow through <code>survivor-room-message</code> to members only.</p>
<p>Requests are capped at 4 invitees, a decline puts the pair on a 45 second cooldown, and private talk is blocked entirely during a challenge — all rooms close when one starts. Everything is journaled under a <code>private.</code> prefix, which is what the Conversations page replays.</p>`,
            },
            {
                type: 'diagram',
                id: 'survivorChallenge',
                title: 'How a challenge borrows the contest engine',
                caption: 'The contest loop drives both: the same tick that advances the contest also syncs its result back into the season.',
                mermaid: `flowchart LR
    survivorSession["SurvivorSessionManager"] -->|"createContest"| contestCoordinator["ContestCoordinator"]
    survivorSession -->|"prepareArena"| arenaManager["ContestArenaManager"]
    survivorSession -->|"startChallenge"| survivorGame["survivor_game state"]
    survivorSession -->|"survivor-challenge-config"| agentRuntime["Agent"]
    contestCoordinator -->|"completed"| sync["syncContestView"]
    sync -->|"completeChallenge"| survivorGame
    survivorGame --> immunity["Immunity assigned"]
    immunity --> strategy["Strategy phase opens"]`,
            },
            {
                type: 'table',
                title: 'Bot commands',
                head: ['Command', 'Purpose'],
                rows: [
                    ['!survivorStatus', 'Current phase, tribe, who is left.'],
                    ['!requestPrivateChat', 'Open a private room request, up to 4 invitees.'],
                    ['!acceptPrivateChat / !declinePrivateChat', 'Answer a pending request.'],
                    ['!sendPrivateMessage / !leavePrivateGroup', 'Talk in, or exit, a room.'],
                    ['!answerCouncil', 'Answer the host publicly at tribal council.'],
                    ['!castSurvivorVote', 'Cast a ballot with a reason.'],
                    ['!submitDeadlockDecision', 'Break a deadlock after a repeat tie.'],
                ],
            },
        ],
    },
    {
        id: 'media',
        title: 'Voice, video and archives',
        eyebrow: 'observability',
        blocks: [
            {
                type: 'prose',
                html: `<p>Bots talk out loud and matches are recorded, so a fair amount of the system exists just to produce watchable output.</p>
<p>Speech has two paths. A bot can synthesize locally, or it can emit <code>contest-speech</code> and let MindServer synthesize and broadcast — which is what keeps the announcer, the browser monitors and the recordings in sync. Voice assignments live in <code>voices.json</code> and are edited from the UI.</p>
<p>Video is per-bot: each agent runs a Prismarine viewer on port 3000 plus its index, and the POV recorder captures from it with ffmpeg. Highlight reels are stitched after a match.</p>`,
            },
            {
                type: 'table',
                title: 'Where to look at what happened',
                head: ['Page', 'Backed by', 'Source of truth'],
                rows: [
                    ['/games/archive', 'contest-archive-list, contest-archive-game', 'Replay of ./contests/journal.jsonl against state.json'],
                    ['/seasons', 'survivor-seasons, survivor-season', './contests/survivor/seasons/<id>.json'],
                    ['/conversations', 'survivor-transcripts', 'private.* events in the survivor journal'],
                    ['/live.html', 'get-wall-state polling', 'Live browser viewers, rendered in-page'],
                    ['Launch diagnostics', 'launch-log, diagnostics-report', 'In-memory stream plus ./launch-failures'],
                ],
            },
            {
                type: 'prose',
                html: `<p>Both journals are append-only JSON lines and the state files are written atomically through a rename. That is the recovery story: if MindServer dies mid-match, state.json is never half-written, and the archive can be rebuilt from the journal regardless.</p>`,
            },
        ],
    },
    {
        id: 'services',
        title: 'Third-party services',
        eyebrow: 'external dependencies',
        blocks: [
            {
                type: 'prose',
                html: `<p>Everything outside the two Node processes, and what breaks when it is missing.</p>`,
            },
            {
                type: 'table',
                head: ['Service', 'Used for', 'Configured by', 'If it is down'],
                rows: [
                    ['Minecraft Java server', 'The world itself', 'settings.host, settings.port, settings.auth', 'Bots cannot spawn; child exits after spawn_timeout'],
                    ['Docker + rcon-cli', 'Arena rebuilds, teleports, spectator control', 'MC_CONTAINER, default mindcraft-mc', 'Contest games cannot prepare an arena; colony is unaffected'],
                    ['LLM provider APIs', 'Every bot decision', 'keys.json, .env, or process env', 'quota_guard raises an outage and pauses self-prompting'],
                    ['ElevenLabs', 'Bot voices and the announcer', 'ELEVENLABS_API_KEY, voices.json', 'Falls back to other TTS or silence; voice-health reports it'],
                    ['ffmpeg / ffplay', 'POV recording, highlight reels, audio playback', 'Must be on PATH', 'Recording steps fail; matches still run'],
                    ['Google Translate', 'Optional in-game translation', 'settings.language, default en disables it', 'Messages pass through untranslated'],
                ],
            },
            {
                type: 'prose',
                html: `<p>Keys resolve in a fixed order: <code>keys.json</code>, then <code>code/.env</code>, then <code>.env</code>, with the root winning, and <code>process.env</code> checked at lookup time. Nothing reads a key at boot and caches it globally, so rotating a key generally means restarting the affected bot rather than the whole server.</p>`,
            },
        ],
    },
    {
        id: 'config',
        title: 'Runtime configuration',
        eyebrow: 'what changes without a restart',
        blocks: [
            {
                type: 'prose',
                html: `<p>There are more ways to change a running bot than there are config files, because most of them go over the socket rather than to disk.</p>`,
            },
            {
                type: 'table',
                head: ['Mechanism', 'Changes', 'Restart needed'],
                rows: [
                    ['set-agent-settings from the UI', 'Any field in settings_spec.json', 'Yes, the server emits restart-agent for you'],
                    ['create-agent', 'Spawns a new bot with a full settings object', 'N/A, new process'],
                    ['game-directive', 'Goal, pause, react, gameStarted, automaticAction', 'No, applied live'],
                    ['colony-directive', 'The self-prompt goal string', 'No'],
                    ['survivor-challenge-config', 'settings.game_session fields mid-season', 'No'],
                    ['SETTINGS_JSON env', 'Merged into settings at boot', 'Boot only'],
                    ['profiles/*.json and keys.json', 'Personality, models, credentials', 'Yes, read on agent create or restart'],
                ],
            },
            {
                type: 'prose',
                html: `<p>The subtle one is that agent settings are a <strong>mutable singleton inside the child process</strong>, populated from the socket at connect. A directive that writes into <code>settings.game_session</code> is changing the same object the prompter reads on the next turn. There is no reload step and no file involved.</p>`,
            },
        ],
    },
    {
        id: 'persistence',
        title: 'Persistence map',
        eyebrow: 'where state lives',
        blocks: [
            {
                type: 'prose',
                html: `<p>All state is plain files under the project root. Every subsystem uses the same pattern: a <code>state.json</code> written atomically for current truth, and a <code>journal.jsonl</code> appended for history.</p>`,
            },
            {
                type: 'code',
                title: 'On-disk layout',
                text: `settings.js                 global defaults
keys.json                   provider credentials
voices.json                 per-bot TTS voices
profiles/*.json             personalities and model choices

colony/
  state.json                phase, tasks, leases, roles
  plan.md                   human-readable render of the board
  journal.jsonl             every mutation
  notes/ blueprints/ code/  bot-published artifacts

contests/
  state.json                active contest snapshot
  journal.jsonl             submissions, eliminations, chat, lifecycle
  survivor/
    state.json              current season
    session.json            session overlay: deck, deadlines, agents
    journal.jsonl           public plus private.* events
    seasons/<id>.json       archived seasons

bots/<name>/
  history.json              conversation history
  memory.json               remembered places
  recordings/               POV clips
  action-code/              generated code from !newAction`,
            },
            {
                type: 'facts',
                title: 'Defaults worth remembering',
                items: [
                    ['Colony heartbeat', '10000 ms'],
                    ['Colony task lease', '300000 ms, extended by progress reports only'],
                    ['Contest tick', '1000 ms, also drives the Survivor tick'],
                    ['Self-prompt cooldown', '20000 ms'],
                    ['Agent tick', '300 ms'],
                    ['Private chat request TTL', '30000 ms'],
                ],
            },
        ],
    },
    {
        id: 'tasks',
        title: 'MineCollab task runner',
        eyebrow: 'research path',
        blocks: [
            {
                type: 'prose',
                html: `<p>Separate from everything above, the upstream benchmark runner still works and does not involve the UI at all. It runs from the CLI, injects a task into settings, and the agent creates a <code>Task</code> that sets inventory, defines a goal, validates completion and exits.</p>`,
            },
            {
                type: 'code',
                title: 'Running a task',
                text: 'node main.js --task_path tasks/basic/single_agent.json --task_id gather_oak_logs',
            },
            {
                type: 'prose',
                html: `<p>Task families are crafting and techtree, cooking (including the collaborative Hell's Kitchen variant) and construction from blueprints. Because task completion exits the process with a code above 1, the parent tears the whole run down — that is intentional, and it is why task runs and colony mode do not mix.</p>`,
            },
        ],
    },
];
