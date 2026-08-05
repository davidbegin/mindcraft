const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 55916, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup
    
    "base_profile": "survival", // survival, assistant, creative, or god_mode
    "profiles": [
        "./andy.json",
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/cursor.json", // uses your Cursor plan through the Cursor SDK
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": true, // load memory from previous session
    "init_message": "Epic megabase mission: build a lavishly decorated base with private rooms for every agent plus themed public rooms (chess room, treasure vault, trophy hall, creative room), and the best armor/weapons/gear. Stay personally well-rounded: always keep and upgrade a sword, shield, armor, food, and tools—even as a miner/farmer/builder. Collaborate briefly with other agents, then dig, craft, place, light, and decorate. !colonyStatus, claim open megabase tasks, keep progressing.", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": true,
    // allows all bots to speak through text-to-speech.
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // default is "elevenlabs": each bot gets its own consistent ElevenLabs voice,
    // configurable per-bot in voices.json (requires ELEVENLABS_API_KEY in .env).
    // if set to "system" it will use basic system text-to-speech.
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "speak_proximity": false, // proximity chat: only play a bot's voice aloud when a human player is near it in-game, with volume fading over distance. Set false to always hear every bot at full volume.
    "speak_proximity_range": 32, // max distance in blocks at which a bot's voice is audible when speak_proximity is on

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": true, // show bot's view in browser at localhost:3000, 3001... (feeds the Live Wall page; rendering happens in the viewing browser, not the agent)
    "record_bot_view": false, // auto-record bot's first-person POV to mp4 in bots/<name>/recordings on spawn. Recording can also be toggled per-agent in the web UI. Requires ffmpeg.
    "record_actions": true, // auto-record clips only while the bot is executing an action AND actually moving/interacting; stops after ~8s of stillness and labels the mp4 with the action. Ignored if record_bot_view is on. Requires ffmpeg.

    "allow_insecure_coding": true, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": 10, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 30, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    "max_commands": 3, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file

    "colony": {
        "enabled": true,
        "world_id": "mindcraft-colony-epic-megabase-v1",
        "state_dir": "./colony",
        "min_agents": 3,
        "heartbeat_interval_ms": 10000,
        "idle_directive_ms": 60000,
        "conversation_timeout_ms": 90000,
        "task_lease_ms": 300000,
        "spawn_cooldown_ms": 30000,
        "model_probe_base_ms": 60000,
        "model_probe_max_ms": 900000
    },

}

export default settings;
