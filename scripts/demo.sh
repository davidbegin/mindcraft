#!/usr/bin/env bash
# Shared helpers for the Justfile recipes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"

MC_HOST="127.0.0.1"
MC_PORT="55916"
MC_VERSION="1.21.6"
MC_CONTAINER="mindcraft-mc"
UI_URL="http://localhost:8080"

mc_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "$MC_CONTAINER" 2>/dev/null || echo false)" == "true" ]]
}

mc_exists() {
  docker inspect "$MC_CONTAINER" >/dev/null 2>&1
}

mc_create() {
  docker run -d --name "$MC_CONTAINER" \
    -p "${MC_PORT}:25565" \
    -e EULA=TRUE \
    -e ONLINE_MODE=FALSE \
    -e MODE=creative \
    -e DIFFICULTY=peaceful \
    -e VERSION="$MC_VERSION" \
    -e MEMORY=2G \
    -e SPAWN_PROTECTION=0 \
    -e VIEW_DISTANCE=8 \
    -e MOTD="Mindcraft Demo" \
    itzg/minecraft-server:latest >/dev/null
}

bot_running() {
  pgrep -f "node main.js" >/dev/null 2>&1
}

# Puts the player and Andy in a lit, walkable spot so the demo looks good.
prep_world() {
  docker exec "$MC_CONTAINER" rcon-cli time set day >/dev/null 2>&1 || true
  docker exec "$MC_CONTAINER" rcon-cli weather clear >/dev/null 2>&1 || true
  docker exec "$MC_CONTAINER" rcon-cli defaultgamemode creative >/dev/null 2>&1 || true
}

wait_mc() {
  echo "Waiting for Minecraft to finish loading..."
  for _ in $(seq 1 90); do
    if docker exec "$MC_CONTAINER" rcon-cli list >/dev/null 2>&1; then
      echo "Minecraft ready."
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for Minecraft" >&2
  return 1
}

cmd="${1:-}"
shift || true

case "$cmd" in
  mc-up)
    if mc_running; then
      echo "Minecraft already running on ${MC_HOST}:${MC_PORT}"
    else
      echo "Starting Minecraft ${MC_HOST}:${MC_PORT}..."
      if mc_exists; then
        docker start "$MC_CONTAINER" >/dev/null
      else
        mc_create
      fi
      wait_mc
      prep_world
    fi
    ;;
  mc-down)
    # Stop, don't remove: keeps the world between sessions.
    docker stop "$MC_CONTAINER" >/dev/null 2>&1 || true
    echo "Minecraft stopped (world preserved)."
    ;;
  mc-reset)
    echo "Deleting the Minecraft world and starting fresh..."
    docker rm -f "$MC_CONTAINER" >/dev/null 2>&1 || true
    mc_create
    wait_mc
    ;;
  bot-up)
    ./scripts/sync-keys.sh
    if bot_running; then
      echo "Mindcraft already running. Stop it first with: just bot-down"
      exit 0
    fi
    exec ./start-demo.sh
    ;;
  bot-bg)
    ./scripts/sync-keys.sh
    if bot_running; then
      echo "Mindcraft already running."
      exit 0
    fi
    echo "Starting Mindcraft bot in the background..."
    # Detach into its own session so the bot outlives the launching shell.
    python3 -c 'import os, sys
os.setsid()
log = open("/tmp/mindcraft-demo.log", "w")
os.dup2(log.fileno(), 1)
os.dup2(log.fileno(), 2)
os.execv("/bin/bash", ["bash", "./start-demo.sh"])' &
    for _ in $(seq 1 45); do
      if curl -sf -o /dev/null "$UI_URL"; then
        echo "UI ready: $UI_URL"
        exit 0
      fi
      sleep 1
    done
    echo "Bot still starting — check: just logs"
    ;;
  bot-down)
    pkill -f "node main.js" 2>/dev/null || true
    rm -f /tmp/mindcraft-demo.pid
    echo "Mindcraft bot stopped."
    ;;
  status)
    echo "=== Mindcraft demo status ==="
    if mc_running; then
      echo "Minecraft: UP  (${MC_HOST}:${MC_PORT}, version 1.21.6)"
      docker exec mindcraft-mc rcon-cli list 2>/dev/null || true
    else
      echo "Minecraft: DOWN"
    fi
    if bot_running; then
      echo "Mindcraft: UP  (UI ${UI_URL})"
    else
      echo "Mindcraft: DOWN"
    fi
    if curl -sf -o /dev/null "$UI_URL"; then
      echo "UI:        reachable"
    else
      echo "UI:        not reachable"
    fi
    ;;
  join)
    cat <<EOF

=== Join from Minecraft Java ===
1. Open the Minecraft Launcher
2. Installations → New Installation → version 1.21.6 → Create
3. Play that 1.21.6 installation
4. Multiplayer → Direct Connection
5. Server Address:  ${MC_HOST}:${MC_PORT}
6. Join — you should see Andy in the world
7. Chat in-game to talk to Andy (or use ${UI_URL})

EOF
    ;;
  up)
    "$0" mc-up
    "$0" join
    echo "Bot logs below. Press Ctrl-C to stop the bot (Minecraft keeps running)."
    echo ""
    "$0" bot-up
    ;;
  up-bg)
    "$0" mc-up
    "$0" bot-bg
    "$0" status
    "$0" join
    ;;
  down)
    "$0" bot-down
    "$0" mc-down
    echo "Demo shut down."
    ;;
  restart)
    "$0" down
    "$0" up-bg
    ;;
  *)
    echo "Unknown helper command: $cmd" >&2
    exit 1
    ;;
esac
