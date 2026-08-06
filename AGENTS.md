# AGENTS.md

## Cursor Cloud specific instructions

### What this project is
Mindcraft runs LLM-powered Minecraft bots via [Mineflayer](https://prismarinejs.github.io/mineflayer/).
It is a Node.js ESM app (`"type": "module"`). `node main.js` starts a **MindServer** web UI on
port `8080` and spawns one agent process per profile in `settings.js`. Each agent connects to a
Minecraft Java server, talks to an LLM, and acts in-game. See `README.md` and `minecollab.md` for
product details; standard commands live in `package.json` and `settings.js`.

### Environment / dependencies
- Node `v22` works here even though `README.md` recommends v18/v20. The startup update script runs
  `npm install`, which also runs `patch-package` (via `postinstall`).
- Native modules (`canvas`, `gl`, `node-canvas-webgl`, `prismarine-viewer`) are compiled with
  node-gyp against system libs (cairo, pango, mesa/GL, xvfb, etc.). Those system libs are already
  present in the environment; `npm install` alone refreshes JS deps.
- Known non-blocking caveat: the `patches/mineflayer+4.33.0.patch` fails to apply because the
  `^4.33.0` range now resolves to 4.37.x. `patch-package` only warns and `npm install` still
  exits 0. That patch only tweaks dig-time / item-use rotation / block-place timeout — it does not
  affect connect/spawn/chat. Do not treat this warning as a broken install. The other 5 patches apply.

### Lint / tests
- Lint: `npx eslint .` runs but currently reports many **pre-existing** errors (the eslint config
  only declares browser globals, so Node's `process` is flagged as `no-undef`, plus missing
  semicolons). There is no `lint` npm script. These are not regressions from setup.
- There is no JavaScript test suite or framework. The Python scripts under `tasks/` (see
  `requirements.txt`) are for benchmark evaluation, not for running the app.

### Running the app (needs a Minecraft server + an LLM)
- LLM keys go in `keys.json` (copy `keys.example.json`) or matching env vars. With no keys, use a
  local Ollama model (keyless).
- On a headless VM you MUST disable `auto_open_ui` (it tries to launch a browser). Pass it via
  `SETTINGS_JSON`, e.g. `SETTINGS_JSON='{"auto_open_ui": false}' node main.js`.
- `render_bot_view`/`allow_vision` render through headless GL (needs `xvfb`) and are off by default.

### Keyless local dev/test path (used to verify this environment)
These are pre-provisioned in the environment (not started automatically — start them yourself):
1. Ollama (systemd is not running in the VM, so start it manually): `ollama serve` (listens on
   `127.0.0.1:11434`). Models pulled: `llama3.2:1b` (chat) and `embeddinggemma` (embeddings).
2. A vanilla Minecraft **1.21.6** server lives in `mc-server/` configured offline-mode on port
   `55916`. Start it with: `cd mc-server && java -Xmx2048M -jar server.jar nogui`. `mc-server/`
   also holds `ollama_andy.json`, a profile pointing the bot at the local Ollama model.
3. Run the bot against both:
   ```
   SETTINGS_JSON='{"auto_open_ui": false, "profiles": ["./mc-server/ollama_andy.json"], "host": "127.0.0.1", "port": 55916}' node main.js
   ```
   Then open the MindServer UI at http://localhost:8080 (agent "andy"), or send chat via the UI's
   per-agent message box. The bot's replies appear in the UI and in the Minecraft server chat
   (`mc-server/logs/latest.log`).

If `mc-server/` or the Ollama models are missing on a fresh VM, re-provision them: download the
1.21.6 vanilla `server.jar`, set `online-mode=false`/`server-port=55916` in `server.properties`,
accept the EULA, and `ollama pull llama3.2:1b embeddinggemma`.
