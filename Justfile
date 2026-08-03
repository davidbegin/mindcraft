# Mindcraft demo command center.
# Run `just` to list recipes.

set shell := ["bash", "-cu"]

default:
    @just --list

# Start Minecraft + Andy, streaming bot logs (Ctrl-C stops the bot)
up:
    @./scripts/demo.sh up

# Same as `up`, but leaves the bot running in the background
up-bg:
    @./scripts/demo.sh up-bg

# Stop bot + Minecraft server
down:
    @./scripts/demo.sh down

# Restart everything (bot in the background)
restart:
    @./scripts/demo.sh restart

# Start only the Minecraft server (Docker)
mc-up:
    @./scripts/demo.sh mc-up

# Stop only the Minecraft server (world is preserved)
mc-down:
    @./scripts/demo.sh mc-down

# Delete the world and start a fresh Minecraft server
mc-reset:
    @./scripts/demo.sh mc-reset

# Start only the Mindcraft bot in the foreground (expects Minecraft already up)
bot-up:
    @./scripts/demo.sh bot-up

# Start only the Mindcraft bot in the background
bot-bg:
    @./scripts/demo.sh bot-bg

# Stop only the Mindcraft bot
bot-down:
    @./scripts/demo.sh bot-down

# Show what's running
status:
    @./scripts/demo.sh status

# How to join from the Minecraft Java launcher
join:
    @./scripts/demo.sh join

# Tail demo / bot logs
logs:
    @tail -f /tmp/mindcraft-demo.log

# Open the Mindcraft web UI
ui:
    @open http://localhost:8080
