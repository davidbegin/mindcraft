#!/usr/bin/env bash
# Shared helpers for the Justfile recipes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"

MC_HOST="127.0.0.1"
MC_PORT="55916"
UI_URL="http://localhost:8080"
COMPOSE_FILE="docker-compose.mc.yml"

mc_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx mindcraft-mc
}

bot_running() {
  pgrep -f "node main.js" >/dev/null 2>&1
}

wait_mc() {
  echo "Waiting for Minecraft to finish loading..."
  for _ in $(seq 1 90); do
    if docker logs mindcraft-mc 2>&1 | grep -q 'Done ('; then
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
      docker compose -f "$COMPOSE_FILE" up -d
      wait_mc
    fi
    ;;
  mc-down)
    docker compose -f "$COMPOSE_FILE" down || true
    echo "Minecraft stopped."
    ;;
  bot-up)
    ./scripts/sync-keys.sh
    if bot_running; then
      echo "Mindcraft already running."
      exit 0
    fi
    echo "Starting Mindcraft bot..."
    nohup ./start-demo.sh > /tmp/mindcraft-demo.log 2>&1 &
    echo $! > /tmp/mindcraft-demo.pid
    for _ in $(seq 1 45); do
      if curl -sf -o /dev/null "$UI_URL"; then
        echo "UI ready: $UI_URL"
        exit 0
      fi
      sleep 1
    done
    echo "Bot starting — check: just logs"
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
    "$0" bot-up
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
    "$0" up
    ;;
  *)
    echo "Unknown helper command: $cmd" >&2
    exit 1
    ;;
esac
